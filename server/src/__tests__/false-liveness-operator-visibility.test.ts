import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
  recoveryService,
} from "../services/recovery/service.js";
import { attentionService } from "../services/attention.js";
import {
  FALSE_LIVENESS_ERROR_REASON,
  FALSE_LIVENESS_STREAK_THRESHOLD,
} from "../services/run-liveness.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres false-liveness operator-visibility tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A provider that reported nothing, so the model never ran. Same shape the
// detector's own fixtures use.
const DEAD_USAGE = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  rawInputTokens: 0,
  rawOutputTokens: 0,
  rawCachedInputTokens: 0,
};

// One run's own exit message. Belongs to the run, not to the agent, and the
// watchdog fold carries it across to an `idle` row exactly as it carries the
// false-liveness marker — which is why the alert keys on the marker's bytes
// and not on `errorReason IS NOT NULL`.
const ORDINARY_ERROR_REASON = "Process exited with code 1";

/**
 * ALM-9550. `finalizeAgentStatus` holds a tripped agent in `error` so the
 * operator sees it, but it is not the only writer of `agents.status`. The
 * source-resolved watchdog fold writes `idle` straight onto the row and never
 * touches `errorReason`, so the marker survives a status that contradicts it.
 *
 * These fixtures drive the REAL fold (`recovery.scanSilentActiveRuns`) rather
 * than a hand-written UPDATE: a hand-written UPDATE proves the state
 * transition, not that the fold reaches it.
 */
describeEmbeddedPostgres("false-liveness fault stays operator-visible", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("false-liveness-operator-visibility-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(input: {
    companyId: string;
    status: "idle" | "error" | "running";
    errorReason: string | null;
  }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: "Coder",
      role: "engineer",
      status: input.status,
      errorReason: input.errorReason,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  /** A full zero-usage streak, so this agent is still dead when the fold runs. */
  async function seedDeadStreak(companyId: string, agentId: string) {
    const now = Date.now();
    for (let index = 0; index < FALSE_LIVENESS_STREAK_THRESHOLD; index += 1) {
      const startedAt = new Date(now - (60 + index) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        startedAt,
        finishedAt: startedAt,
        usageJson: DEAD_USAGE,
      });
    }
  }

  /**
   * The fold's preconditions: a `running` run silent past the critical
   * threshold, whose source issue reached a terminal status through durable
   * same-run activity. That is the cell the fold finalizes.
   */
  async function seedFoldableSilentRun(input: {
    companyId: string;
    agentId: string;
    prefix: string;
    now: Date;
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const startedAt = new Date(
      input.now.getTime() - (ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 60_000),
    );
    const terminalEvidenceAt = new Date(startedAt.getTime() + 10 * 60 * 1000);

    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Long running implementation",
      status: "done",
      priority: "medium",
      assigneeAgentId: input.agentId,
      issueNumber: 1,
      identifier: `${input.prefix}-1`,
      originKind: "manual",
      completedAt: terminalEvidenceAt,
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      contextSnapshot: { issueId },
      logBytes: 0,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        identifier: `${input.prefix}-1`,
        status: "done",
        _previous: { status: "in_progress" },
      },
      createdAt: terminalEvidenceAt,
    });

    return { issueId, runId };
  }

  async function readAgent(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row ?? null;
  }

  async function agentErrorAlerts(companyId: string) {
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    return feed.items.filter((item) => item.sourceKind === "agent_error_alert");
  }

  it("keeps the alert after the real watchdog fold writes the tripped agent back to idle", async () => {
    const prefix = "FLA";
    const companyId = await seedCompany(prefix);
    const agentId = await seedAgent({
      companyId,
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
    await seedDeadStreak(companyId, agentId);
    const now = new Date("2026-04-22T20:00:00.000Z");
    await seedFoldableSilentRun({ companyId, agentId, prefix, now });

    // The alert exists before the fold. Without this the test could pass on an
    // alert the fold never had a chance to drop.
    expect(await agentErrorAlerts(companyId)).toHaveLength(1);

    const result = await recoveryService(db, { enqueueWakeup: vi.fn() })
      .scanSilentActiveRuns({ now, companyId });
    expect(result).toMatchObject({ created: 0, folded: 1, skipped: 0 });

    // The fold DID move the status. That write is not what this change alters —
    // `error` is an invokable status, so `{idle, marker}` and `{error, marker}`
    // are identically dispatchable and the alert is the whole difference.
    const folded = await readAgent(agentId);
    expect(folded?.status).toBe("idle");
    expect(folded?.errorReason).toBe(FALSE_LIVENESS_ERROR_REASON);

    // The operator surface survives the status write.
    const alerts = await agentErrorAlerts(companyId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subject.id).toBe(agentId);
    expect(alerts[0]?.subject.status).toBe("idle");
    expect(alerts[0]?.detail).toMatchObject({
      kind: "agent_error",
      agentName: "Coder",
    });
    // The row contradicts "in error status", so the copy must not say it.
    expect(alerts[0]?.whyNow).toBe(
      "Agent carries an unresolved adapter credential/config fault and needs operator action or dismissal.",
    );
    expect(alerts[0]?.entryRule).toBe(
      "agents.status = 'error' OR agents.error_reason = the false-liveness marker",
    );
  });

  it("still alerts on an ordinary error status, with the status wording", async () => {
    const companyId = await seedCompany("FLB");
    const agentId = await seedAgent({
      companyId,
      status: "error",
      errorReason: ORDINARY_ERROR_REASON,
    });

    const alerts = await agentErrorAlerts(companyId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subject.id).toBe(agentId);
    expect(alerts[0]?.whyNow).toBe(
      "Agent is in error status and needs operator action or dismissal.",
    );
  });

  it("does not alert on a healthy idle agent", async () => {
    const companyId = await seedCompany("FLC");
    await seedAgent({ companyId, status: "idle", errorReason: null });

    expect(await agentErrorAlerts(companyId)).toHaveLength(0);
  });

  it("does not alert on an idle agent carrying one run's own exit message", async () => {
    // The fold carries an ordinary reason onto an `idle` row the same way it
    // carries the marker. Alerting here would mean every agent that ever had a
    // run exit non-zero sits in the operator's queue forever, so the predicate
    // is an equality on the marker and not a presence test on `errorReason`.
    const companyId = await seedCompany("FLD");
    await seedAgent({ companyId, status: "idle", errorReason: ORDINARY_ERROR_REASON });

    expect(await agentErrorAlerts(companyId)).toHaveLength(0);
  });

  it("does not alert on an idle agent whose reason merely contains the marker", async () => {
    // Guards the equality against being loosened to a substring or prefix
    // match: the marker is an equality key in `finalizeAgentStatus` and in the
    // escalation latch, and this reader must key on it the same way.
    const companyId = await seedCompany("FLE");
    await seedAgent({
      companyId,
      status: "idle",
      errorReason: `${FALSE_LIVENESS_ERROR_REASON} (cleared by operator)`,
    });

    expect(await agentErrorAlerts(companyId)).toHaveLength(0);
  });
});
