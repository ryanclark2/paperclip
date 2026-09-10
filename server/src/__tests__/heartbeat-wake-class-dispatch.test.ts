import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

/**
 * DB-backed cover for the queued-run wake-class rank.
 *
 * The pure suite in ./heartbeat-wake-class-dispatch-order.test.ts exercises the
 * comparator, which receives the class inputs as arguments and so cannot
 * observe where they come from. What is reachable only from a real dispatcher
 * against a real database — and is what this file covers — is that
 * `startNextQueuedRunForAgent` reads `invocation_source` and
 * `scheduled_retry_reason` off the run row, passes a single dispatch clock, and
 * claims the winner the comparator names.
 *
 * Every case seeds exactly two queued runs for a one-slot agent. Neither issue
 * carries a relation, so the head start is unreachable and cannot decide any
 * case here.
 */

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Wake class dispatch test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-class dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("queued-run wake-class rank, end to end", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wake-class-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((runs) => runs.map((run) => run.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Wake class dispatch test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds two queued runs for one single-slot agent and returns which one the
   * real dispatcher claims.
   *
   * The `older` run is always enqueued first. Cases vary only what the ordering
   * is allowed to read: each run's wake class (`invocation_source` +
   * `scheduled_retry_reason`), its issue's status, and how long ago it was
   * enqueued. Priority is `high` on both and neither issue has a blocker or a
   * relation, so readiness and the head start cannot decide any case except
   * where a case sets `olderIssueStatus` deliberately.
   */
  async function claimWinner(input: {
    olderSource: string;
    olderRetryReason: string | null;
    olderAgeMs: number;
    olderIssueStatus?: string;
    newerSource: string;
    newerRetryReason: string | null;
    newerIssueStatus?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const olderIssueId = randomUUID();
    const newerIssueId = randomUUID();
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();
    const olderWakeupId = randomUUID();
    const newerWakeupId = randomUUID();

    // The single claimed run holds the agent's only slot for the whole
    // assertion, so the loser is still observably `queued` when it is read.
    let releaseClaimedRun!: () => void;
    const claimedRunReleased = new Promise<void>((resolve) => {
      releaseClaimedRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await claimedRunReleased;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Claimed run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    // Same priority, and neither carries a blocker of its own, so both are
    // dependency-ready.
    await db.insert(issues).values([
      {
        id: olderIssueId,
        companyId,
        title: "Older contender: enqueued first",
        status: input.olderIssueStatus ?? "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: newerIssueId,
        companyId,
        title: "Newer contender: enqueued second",
        status: input.newerIssueStatus ?? "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(agentWakeupRequests).values([
      {
        id: olderWakeupId,
        companyId,
        agentId,
        source: input.olderSource,
        triggerDetail: "system",
        reason: input.olderRetryReason ? "transient_failure_retry" : "issue_assigned",
        payload: { issueId: olderIssueId },
        status: "queued",
      },
      {
        id: newerWakeupId,
        companyId,
        agentId,
        source: input.newerSource,
        triggerDetail: "system",
        reason: input.newerRetryReason ? "transient_failure_retry" : "issue_assigned",
        payload: { issueId: newerIssueId },
        status: "queued",
      },
    ]);
    const now = Date.now();
    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId,
        agentId,
        invocationSource: input.olderSource,
        scheduledRetryReason: input.olderRetryReason,
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: olderWakeupId,
        contextSnapshot: {
          issueId: olderIssueId,
          wakeReason: input.olderRetryReason ? "transient_failure_retry" : "issue_assigned",
        },
        createdAt: new Date(now - input.olderAgeMs),
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        invocationSource: input.newerSource,
        scheduledRetryReason: input.newerRetryReason,
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: newerWakeupId,
        contextSnapshot: {
          issueId: newerIssueId,
          wakeReason: input.newerRetryReason ? "transient_failure_retry" : "issue_assigned",
        },
        createdAt: new Date(now),
      },
    ]);
    await db.update(agentWakeupRequests).set({ runId: olderRunId }).where(eq(agentWakeupRequests.id, olderWakeupId));
    await db.update(agentWakeupRequests).set({ runId: newerRunId }).where(eq(agentWakeupRequests.id, newerWakeupId));
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: olderIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: olderRunId,
        body: "Older queued run update.",
      },
      {
        companyId,
        issueId: newerIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: newerRunId,
        body: "Newer queued run update.",
      },
    ]);

    async function runStatus(runId: string) {
      return db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]?.status ?? null);
    }

    try {
      await heartbeat.resumeQueuedRuns();
      // `running`, not merely "no longer queued": a cancelled run also leaves
      // the queue, and cancellation must never read as a claim.
      const claimed = await waitForCondition(async () => {
        const statuses = await Promise.all([runStatus(olderRunId), runStatus(newerRunId)]);
        return statuses.some((status) => status === "running");
      });
      expect(claimed).toBe(true);

      const [olderStatus, newerStatus] = await Promise.all([
        runStatus(olderRunId),
        runStatus(newerRunId),
      ]);
      // One slot, so exactly one of the two may have started.
      expect([olderStatus, newerStatus].filter((status) => status === "running")).toHaveLength(1);
      return {
        winner: newerStatus === "running" ? "newer" : "older",
        olderStatus,
        newerStatus,
      };
    } finally {
      releaseClaimedRun();
    }
  }

  const PARKED_RETRY = {
    olderSource: "automation",
    olderRetryReason: "transient_failure",
  } as const;
  const ASSIGNMENT = { newerSource: "assignment", newerRetryReason: null } as const;

  it("claims a 4h-newer assignment wake ahead of a parked retry", async () => {
    // The ticket's acceptance case, and the one that is red before this change:
    // the two runs are identical on every key the pre-change comparator read,
    // so it fell through to createdAt and served the retry first.
    const result = await claimWinner({
      ...PARKED_RETRY,
      olderAgeMs: 4 * HOUR_MS,
      ...ASSIGNMENT,
    });
    expect(result.winner).toBe("newer");
    expect(result.olderStatus).toBe("queued");
  }, 60_000);

  it("claims the assignment wake even though the retry's issue is in_progress", async () => {
    // The measured production shape: a parked retry's issue is `in_progress`
    // (it was checked out when the run died), so it holds the top readiness
    // band, while a freshly assigned issue is still `todo` and holds the band
    // below. This is the case that pins the class key ABOVE readiness — rank it
    // below and this test is the one that goes red.
    const result = await claimWinner({
      ...PARKED_RETRY,
      olderAgeMs: 4 * HOUR_MS,
      olderIssueStatus: "in_progress",
      ...ASSIGNMENT,
      newerIssueStatus: "todo",
    });
    expect(result.winner).toBe("newer");
    expect(result.olderStatus).toBe("queued");
  }, 60_000);

  it("claims the older run first when both runs share a class", async () => {
    // Control: with one class the class key cannot discriminate and the
    // pre-change FIFO order stands. Without this case a mutant that always
    // preferred the newer run would still look correct above.
    const result = await claimWinner({
      olderSource: "assignment",
      olderRetryReason: null,
      olderAgeMs: 4 * HOUR_MS,
      ...ASSIGNMENT,
    });
    expect(result.winner).toBe("older");
    expect(result.newerStatus).toBe("queued");
  }, 60_000);

  it("claims two parked retries oldest first", async () => {
    // The same control on the other side of the tier table: demoting the retry
    // class must not reorder retries among themselves.
    const result = await claimWinner({
      ...PARKED_RETRY,
      olderAgeMs: 4 * HOUR_MS,
      newerSource: "automation",
      newerRetryReason: "transient_failure",
    });
    expect(result.winner).toBe("older");
    expect(result.newerStatus).toBe("queued");
  }, 60_000);

  it("claims a retry parked past the age threshold ahead of a fresh assignment wake", async () => {
    // The starvation escape, end to end. Same two classes as the first case and
    // the opposite outcome, so the only thing that can produce it is the age.
    // A mutant that drops the escape, or reads a clock per run instead of the
    // one dispatch clock, leaves the assignment wake claimed.
    const result = await claimWinner({
      ...PARKED_RETRY,
      olderAgeMs: 6 * HOUR_MS + MINUTE_MS,
      ...ASSIGNMENT,
    });
    expect(result.winner).toBe("older");
    expect(result.newerStatus).toBe("queued");
  }, 60_000);
});
