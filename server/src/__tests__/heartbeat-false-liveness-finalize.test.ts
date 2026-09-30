import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  FALSE_LIVENESS_ERROR_REASON,
  FALSE_LIVENESS_SCAN_LIMIT,
  FALSE_LIVENESS_STREAK_THRESHOLD,
} from "../services/run-liveness.ts";

/**
 * The false-liveness detector's WRITE, not its predicate (ALM-6138).
 *
 * `false-liveness-detector.test.ts` pins the pure functions. Nothing pinned the
 * caller in `finalizeAgentStatus`, so six mutations of that call site — an
 * unconditional escalation, an unscoped window, a reversed window, a narrowed
 * window, a discarded reason, and deleting the branch outright — all left the
 * suite green (ADR-004 control 1, findings N1 and H2b on ALM-8037). These
 * fixtures run the real thing end to end against Postgres: seed an agent's run
 * history, execute one real succeeded run through `invoke`, then read what
 * landed on the agent row.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres false-liveness finalize tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// A provider that reported nothing. Copied from a real GeminiEng row.
const DEAD_USAGE = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  rawInputTokens: 0,
  rawOutputTokens: 0,
  rawCachedInputTokens: 0,
};

// An ordinary billed run.
const HEALTHY_USAGE = {
  costUsd: 0.3948814,
  inputTokens: 104000,
  outputTokens: 6379,
  rawInputTokens: 104000,
  rawOutputTokens: 6379,
  rawCachedInputTokens: 98000,
};

/** `null` means the run recorded no usage at all: skipped, not counted. */
type SeedUsage = Record<string, unknown> | null;

describeEmbeddedPostgres("false-liveness detector writes agent status", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let previousAgentJwtSecret: string | undefined;

  beforeAll(async () => {
    previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "false-liveness-finalize-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("false-liveness-finalize-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    // A run reaches its terminal status before finalizeRun finishes writing its
    // trailing side effects, so drain before truncating or a late write hits a
    // deleted company row.
    await heartbeat.drainActiveRunExecutions();
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  interface CreateAgentOptions {
    /** Seeds the agent mid-fault. `error` is an INVOKABLE status, so a tripped
     * agent keeps running and keeps reaching this write — that is the only
     * reason recovery is possible at all. */
    status?: "idle" | "error";
    errorReason?: string;
    /** Raised above 1 only when a fixture seeds a concurrent in-flight run:
     * `startNextQueuedRunForAgent` gates on `maxConcurrentRuns - runningCount`,
     * so at the default of 1 the seeded row would starve the run under test. */
    maxConcurrentRuns?: number;
  }

  /** An agent whose runs exit 0 immediately: a clean success, every time. */
  async function createAgent(
    companyId: string,
    name: string,
    options: CreateAgentOptions = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: options.status ?? "idle",
      errorReason: options.errorReason ?? null,
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig:
        options.maxConcurrentRuns === undefined
          ? {}
          : { heartbeat: { maxConcurrentRuns: options.maxConcurrentRuns } },
      permissions: {},
    });
    return agentId;
  }

  /**
   * Another of this agent's runs, still in flight.
   *
   * Only the `running` status is load-bearing: `countRunningRunsForAgent`
   * counts rows, not live processes, and that count is what drives `baseStatus`
   * to `running` in the write under test.
   */
  async function seedInFlightRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "running",
      startedAt: new Date(),
    });
    return runId;
  }

  /**
   * Seed succeeded history, newest first. `startedAt` is what the detector
   * orders on, so index 0 is the most recent run and each later entry is a
   * minute older.
   */
  async function seedHistory(
    companyId: string,
    agentId: string,
    usagesNewestFirst: readonly SeedUsage[],
    options: { newestMinutesAgo?: number } = {},
  ) {
    const newestMinutesAgo = options.newestMinutesAgo ?? 1;
    const now = Date.now();
    for (const [index, usage] of usagesNewestFirst.entries()) {
      const startedAt = new Date(now - (newestMinutesAgo + index) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        startedAt,
        finishedAt: startedAt,
        usageJson: usage,
      });
    }
  }

  /** Run one real heartbeat to completion and return the finalized agent row. */
  async function runOnceAndReadAgent(agentId: string) {
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const deadline = Date.now() + 20_000;
    let run = await heartbeat.getRun(queued!.id);
    while (Date.now() < deadline && run && ["queued", "running"].includes(run.status)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await heartbeat.getRun(queued!.id);
    }
    expect(run?.status).toBe("succeeded");

    // Load-bearing for the window arithmetic below: the run just finalized is
    // itself in the detector's window. A process agent reports no provider
    // usage, so it is SKIPPED — it neither extends nor resets the streak.
    expect(run?.usageJson ?? null).toBeNull();

    // The agent write happens in finalizeAgentStatus, after the run reaches its
    // terminal status. Drain before reading or this races the write under test.
    await heartbeat.drainActiveRunExecutions();

    return readAgent(agentId);
  }

  async function readAgent(agentId: string) {
    return db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
  }

  /**
   * Interrupt one in-flight run the way a graceful shutdown does, and return
   * the finalized agent row.
   *
   * Reaches `finalizeAgentStatus(..., "interrupted", ...)`, which is a real
   * production call site and one of the two non-`succeeded` outcomes that still
   * resolve to a base status of `idle`. Driven from a seeded row rather than a
   * live child process on purpose: `drainRunningRunsForShutdown` selects on the
   * `running` STATUS, and the write under test reads the agent's run history
   * and the outcome — never a pid. Interrupting a real process here would also
   * enqueue a process-loss retry that the dying run's own teardown promotes,
   * which is a second run this fixture has no use for.
   */
  async function interruptOnceAndReadAgent(companyId: string, agentId: string) {
    const runId = await seedInFlightRun(companyId, agentId);

    const drained = await heartbeat.drainRunningRunsForShutdown(
      "SIGTERM",
      new Date(),
      [runId],
    );
    expect(drained.interruptedRunIds).toEqual([runId]);
    expect((await heartbeat.getRun(runId))?.status).toBe("interrupted");

    await heartbeat.drainActiveRunExecutions();

    return readAgent(agentId);
  }

  const dead = (n: number): SeedUsage[] => Array.from({ length: n }, () => ({ ...DEAD_USAGE }));
  const healthy = (n: number): SeedUsage[] =>
    Array.from({ length: n }, () => ({ ...HEALTHY_USAGE }));
  const unrecorded = (n: number): SeedUsage[] => Array.from({ length: n }, () => null);

  it("marks the agent unavailable on a full zero-usage streak", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "DeadAdapter");
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // The reason is asserted by equality, not presence: `class-b-dry-run` §D's
    // bulk undo keys on these exact bytes, and dropping the detector's reason
    // in favour of the caller's `failureReason` (null here) is otherwise
    // invisible.
    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  it("leaves the agent idle when a healthy run breaks the streak", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "RecoveredAdapter");
    await seedHistory(companyId, agentId, [
      ...healthy(1),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD - 1),
    ]);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "idle",
      errorReason: null,
    });
  });

  it("reads the agent's newest runs, not its oldest", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "RecoveredFromOldOutage");
    // A finished outage: a full streak of zero-usage runs, then healthy ones.
    // Reversing the window's sort order reads the old block forever, so a
    // tripped agent could never recover.
    await seedHistory(companyId, agentId, [
      ...healthy(2),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD),
    ]);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "idle",
      errorReason: null,
    });
  });

  it("scopes the streak to one agent, not the whole company", async () => {
    const companyId = await createCompany();
    const healthyAgentId = await createAgent(companyId, "HealthyAgent");
    const deadAgentId = await createAgent(companyId, "DeadSibling");

    // The sibling's zero-usage runs are the NEWEST rows in the company, so an
    // unscoped window would read them as the healthy agent's own streak.
    await seedHistory(companyId, healthyAgentId, healthy(1), { newestMinutesAgo: 30 });
    await seedHistory(companyId, deadAgentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    expect(await runOnceAndReadAgent(healthyAgentId)).toEqual({
      status: "idle",
      errorReason: null,
    });

    // And the sibling is untouched by a run it did not take part in.
    const sibling = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, deadAgentId))
      .then((rows) => rows[0]!);
    expect(sibling.status).toBe("idle");
  });

  it("looks past skipped runs to find the streak", async () => {
    expect(FALSE_LIVENESS_SCAN_LIMIT).toBeGreaterThan(FALSE_LIVENESS_STREAK_THRESHOLD);

    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "GapThenDeath");
    // Enough unrecorded runs that — with the live run, which is also
    // unrecorded — they exactly fill a THRESHOLD-sized window. Reading only
    // THRESHOLD rows would see nothing but skips and never reach the streak
    // behind them, which is why the scan limit is a multiple of the threshold.
    await seedHistory(companyId, agentId, [
      ...unrecorded(FALSE_LIVENESS_STREAK_THRESHOLD - 1),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD),
    ]);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });

  // The two fixtures below pin the escalation condition's two conjuncts
  // SEPARATELY (ALM-8333 / ADR-004 Amendment 6). Every fixture above finalizes
  // a succeeded run on an agent with nothing else in flight, so it enters the
  // one cell where both conjuncts already hold — and either conjunct could be
  // deleted with the suite still green.

  it("leaves a concurrently-running agent alone even on a full streak", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "DeadButBusy", {
      maxConcurrentRuns: 2,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));
    // The agent's OTHER run, still executing. Escalating now would overwrite
    // `running` with `error` and publish a credential fault against an agent
    // that is mid-run; the streak is durable, so the next finalization with
    // nothing in flight catches it instead.
    await seedInFlightRun(companyId, agentId);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "running",
      errorReason: null,
    });
  });

  it("does not escalate when the finalizing run did not succeed", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "DeadButInterrupted");
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // `interrupted` and `cancelled` both resolve to a base status of `idle`, so
    // the base-status conjunct alone does not exclude them. The detector's
    // evidence is a run that CLAIMED to succeed while the provider reported
    // nothing; a run the control plane killed makes no such claim, and reading
    // one as proof of death would escalate on every server restart.
    expect(await interruptOnceAndReadAgent(companyId, agentId)).toEqual({
      status: "idle",
      errorReason: null,
    });
  });

  // And these two pin the recovery write, by varying the agent's PRIOR status
  // rather than the finalizing run (ALM-8333 BLOCKING-2). Every fixture above
  // seeds `idle`, so the transition out of the fault is never exercised.

  it("clears the fault when the adapter starts reporting usage again", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedThenFixed", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
    // Credentials repaired: the newest run billed real tokens, so the streak is
    // broken and this agent is owed its `idle` back.
    await seedHistory(companyId, agentId, [
      ...healthy(1),
      ...dead(FALSE_LIVENESS_STREAK_THRESHOLD - 1),
    ]);

    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "idle",
      errorReason: null,
    });
  });

  it("keeps a tripped agent in the fault while the streak still holds", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, "TrippedAndStillDead", {
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
    await seedHistory(companyId, agentId, dead(FALSE_LIVENESS_STREAK_THRESHOLD));

    // The twin of the fixture above, and the reason it cannot be satisfied by
    // simply never re-escalating an agent that already carries this reason:
    // the status is rewritten on EVERY finalization while the streak holds, so
    // a still-dead agent cannot flap back to idle and be handed more work.
    expect(await runOnceAndReadAgent(agentId)).toEqual({
      status: "error",
      errorReason: FALSE_LIVENESS_ERROR_REASON,
    });
  });
});
