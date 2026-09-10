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
 * DB-backed cover for the queued-run blocking head start.
 *
 * The pure suite in ./heartbeat-queued-run-dispatch-order.test.ts exercises the
 * comparator, which receives the blocking set as an argument and so cannot
 * observe where that set comes from. Everything between the `issue_relations`
 * rows and the claimed run — the blocking-set query in heartbeat.ts, the
 * direction it walks the relation, its status exclusions, and the call site that
 * hands the set to the comparator — is reachable only by driving the real
 * dispatcher against a real database, which is what this file does.
 *
 * Every case seeds exactly two queued runs that are identical on each axis the
 * comparator checks ahead of the head start, so the head start is the only thing
 * that can decide the winner.
 */

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Blocking head start test run.",
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
    `Skipping embedded Postgres blocking-head-start dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MINUTE_MS = 60 * 1000;

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

describeEmbeddedPostgres("queued-run blocking head start, end to end", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-blocking-head-start-");
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
      summary: "Blocking head start test run.",
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
   * `dependentStatus` is the only thing that varies across cases: `null` writes
   * no relation at all, otherwise the NEWER run's issue gets a `blocks` edge
   * onto a dependent issue in that status. `blocks` is the only relation type
   * the schema admits, so a wrong-type edge is not representable here.
   *
   * The older run is enqueued 10 minutes before the newer one — well inside the
   * 24h head start, so without the head start FIFO hands it the slot.
   */
  async function claimWinner(dependentStatus: string | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const olderIssueId = randomUUID();
    const newerIssueId = randomUUID();
    const dependentIssueId = randomUUID();
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
    // Same status (so same readiness rank), same priority, and neither carries a
    // blocker of its own (so both are dependency-ready).
    await db.insert(issues).values([
      {
        id: olderIssueId,
        companyId,
        title: "Older contender: enqueued first, blocks nothing",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: newerIssueId,
        companyId,
        title: "Newer contender: enqueued second",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        // Unassigned, so it never enqueues a run of its own and never reaches
        // the dispatcher's queued-issue set.
        id: dependentIssueId,
        companyId,
        title: "Dependent of the newer contender",
        status: dependentStatus ?? "todo",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
    ]);
    if (dependentStatus !== null) {
      // "X blocks Y" is stored as issue_id = X (the blocker), related_issue_id
      // = Y (the dependent).
      await db.insert(issueRelations).values({
        companyId,
        issueId: newerIssueId,
        relatedIssueId: dependentIssueId,
        type: "blocks",
      });
    }
    await db.insert(agentWakeupRequests).values([
      {
        id: olderWakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: olderIssueId },
        status: "queued",
      },
      {
        id: newerWakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
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
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: olderWakeupId,
        contextSnapshot: { issueId: olderIssueId, wakeReason: "issue_assigned" },
        createdAt: new Date(now - 10 * MINUTE_MS),
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: newerWakeupId,
        contextSnapshot: { issueId: newerIssueId, wakeReason: "issue_assigned" },
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

  it("claims the newer run first when its issue blocks an open issue", async () => {
    // Kills all three mutants that survived the comparator-only suite:
    //   - inverting the join direction: the set then holds the dependent's id,
    //     or the dependent's row is filtered out, and nobody is granted anything
    //   - `return new Set(issueIds)`: both contenders are granted it, so the
    //     effective times tie and FIFO restores the older run
    //   - an empty set at the call site: the feature is simply absent
    // Each of the three leaves the OLDER run claimed first.
    const result = await claimWinner("todo");
    expect(result.winner).toBe("newer");
    expect(result.olderStatus).toBe("queued");
  }, 60_000);

  it("claims the older run first when neither issue blocks anything", async () => {
    // Control: with no relation row the head start is unreachable and the
    // dispatcher's pre-existing FIFO order stands. Without this case a mutant
    // that granted the head start unconditionally would still look correct.
    const result = await claimWinner(null);
    expect(result.winner).toBe("older");
    expect(result.newerStatus).toBe("queued");
  }, 60_000);

  it("grants no head start when the only dependent is already done", async () => {
    // Addition direction (ADR-004 Amendment 6): dropping the status exclusion
    // from the query widens the open-work set, and only a case whose dependent
    // sits in an excluded status can see that.
    const result = await claimWinner("done");
    expect(result.winner).toBe("older");
    expect(result.newerStatus).toBe("queued");
  }, 60_000);

  it("grants the head start when the dependent is itself blocked", async () => {
    // The other addition direction on the same list: `blocked` is open work, so
    // widening OPEN_WORK_EXCLUDED_ISSUE_STATUSES to cover it must fail here.
    // Resolving this blocker is exactly what would wake that dependent.
    const result = await claimWinner("blocked");
    expect(result.winner).toBe("newer");
    expect(result.olderStatus).toBe("queued");
  }, 60_000);
});
