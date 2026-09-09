import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres scheduled retry route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue scheduled retry routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-scheduled-retry-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string, source: "session" | "local_implicit" = "session"): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source,
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  // An agent JWT whose agentId never resolved. It must not slip through the
  // assignee disjunct by matching a null assigneeAgentId.
  function anonymousAgentActor(companyId: string): Express.Request["actor"] {
    return {
      type: "agent",
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  // A board key that clears assertCompanyAccess (companyIds match, no
  // memberships array to check) but owns no DB membership row, so
  // `runtime:manage` is denied for it. This is the actor that proves the board
  // disjunct carries its own weight rather than riding on runtime:manage.
  function boardKeyActorWithoutMembershipRow(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: `board-key-${randomUUID()}`,
      companyIds: [companyId],
      isInstanceAdmin: false,
      source: "board_key",
    };
  }

  // A restricted agent key: the scope, not the agent's permissions, is what
  // denies `runtime:manage`. CTO-1..CTO-4 below use these to pin that the
  // restriction only bites a *non-assignee* caller — the assignee disjunct
  // returns before `decide()` runs, so an assignee-scoped restricted key never
  // meets its own deny list. See the guard comment in `routes/issues.ts`.
  function taskBridgeAgentActor(
    companyId: string,
    agentId: string,
    parentIssueId: string,
  ): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
      keyId: randomUUID(),
      keyScope: { kind: "task_bridge", parentIssueId },
    } as Express.Request["actor"];
  }

  function skillTestAgentActor(
    companyId: string,
    agentId: string,
    issueId: string,
  ): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
      keyId: randomUUID(),
      keyScope: { kind: "skill_test", issueId },
    } as Express.Request["actor"];
  }

  function lowTrustPermissions(issueId: string) {
    return {
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustBoundary: {
          mode: "low_trust_review",
          issueIds: [issueId],
        },
      },
    };
  }

  async function seedPeerAgent(companyId: string, permissions: Record<string, unknown>) {
    const peerAgentId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: `Peer-${peerAgentId.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions,
    });
    return peerAgentId;
  }

  async function seedIssueWithRetry(input: {
    agentStatus?: "active" | "paused";
    retryStatus?: "scheduled_retry" | "queued" | "running";
    issueStatus?: "in_progress" | "todo" | "done" | "cancelled";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const retryRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-05-06T18:00:00.000Z");
    const scheduledRetryAt = new Date("2026-05-06T19:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input.agentStatus ?? "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "transient upstream error",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "bounded_transient_heartbeat_retry",
      payload: {
        issueId,
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
      },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.retryStatus ?? "scheduled_retry",
      wakeupRequestId,
      retryOfRunId: sourceRunId,
      scheduledRetryAt,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        issueId,
        wakeReason: "bounded_transient_heartbeat_retry",
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
        scheduledRetryAttempt: 2,
        retryReason: "transient_failure",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: retryRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retryable issue",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: retryRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, sourceRunId, retryRunId, scheduledRetryAt };
  }

  it("surfaces the current scheduled retry in the issue read model", async () => {
    const { companyId, issueId, agentId, sourceRunId, retryRunId, scheduledRetryAt } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scheduledRetry).toMatchObject({
      runId: retryRunId,
      status: "scheduled_retry",
      agentId,
      agentName: "CodexCoder",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
    });
    expect(res.body.scheduledRetry.scheduledRetryAt).toBe(scheduledRetryAt.toISOString());
  });

  it.each(["queued", "running"] as const)(
    "surfaces a %s retry with its real live status",
    async (retryStatus) => {
      const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ retryStatus });

      const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.scheduledRetry).toMatchObject({
        runId: retryRunId,
        status: retryStatus,
        scheduledRetryReason: "transient_failure",
      });
    },
  );

  it("includes a blocker's live retry in relation summaries", async () => {
    const { companyId, issueId: blockerId, retryRunId } = await seedIssueWithRetry({ retryStatus: "running" });
    const blockedId = randomUUID();
    await db.insert(issues).values({
      id: blockedId,
      companyId,
      title: "Waiting for recovery",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${blockedId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedBy).toHaveLength(1);
    expect(res.body.blockedBy[0]).toMatchObject({
      id: blockerId,
      scheduledRetry: {
        runId: retryRunId,
        status: "running",
        scheduledRetryReason: "transient_failure",
      },
    });
  });

  it("promotes the existing scheduled retry and treats duplicate clicks as idempotent", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const app = createApp(boardActor(companyId));

    const first = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      outcome: "promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const second = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.retryOfRunId, first.body.scheduledRetry.retryOfRunId), eq(heartbeatRuns.companyId, companyId)));
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]).toMatchObject({ id: retryRunId, status: "queued" });
  });

  it("returns a clear no-op response when there is no scheduled retry", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "NONE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No retry",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "NONE-1",
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "no_scheduled_retry",
      scheduledRetry: null,
    });
  });

  it("reports already-promoted retries without creating another run", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ retryStatus: "queued" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });
  });

  it("uses normal promotion gates and records gate-suppressed retries", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ agentStatus: "paused" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      suppressedErrorCode: "agent_not_invokable",
      scheduledRetry: {
        runId: retryRunId,
        // Still parked, at its ORIGINAL time. Retry-now must not manufacture
        // dueness for a retry the gate would refuse: no route re-arms a
        // cancelled `scheduled_retry`, so cancelling here would destroy state
        // only the board can hand-repair (ALM-7934).
        status: "scheduled_retry",
        errorCode: null,
        scheduledRetryAt: "2026-05-06T19:00:00.000Z",
      },
    });

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run).toEqual({
      status: "scheduled_retry",
      errorCode: null,
      scheduledRetryAt: new Date("2026-05-06T19:00:00.000Z"),
    });

    // Whole array, not `const [activity]`: pinning the first row lets a mutant
    // that writes a second activity row survive.
    const activity = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity).toEqual([
      {
        action: "issue.scheduled_retry_retry_now",
        entityId: issueId,
        runId: retryRunId,
      },
    ]);
  });

  it("does not promote a scheduled retry after on-demand wakes are disabled", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry();
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } })
      .where(eq(agents.id, agentId));

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      suppressedErrorCode: "heartbeat_wake_on_demand_disabled",
      scheduledRetry: {
        runId: retryRunId,
        // Still parked, at its ORIGINAL time. Retry-now must not manufacture
        // dueness for a retry the gate would refuse: no route re-arms a
        // cancelled `scheduled_retry`, so cancelling here would destroy state
        // only the board can hand-repair (ALM-7934).
        status: "scheduled_retry",
        errorCode: null,
        scheduledRetryAt: "2026-05-06T19:00:00.000Z",
      },
    });
  });

  // retry-now authorization is the disjunction
  //   board OR the assignee agent OR company-scope `runtime:manage`
  // Each `it` below is the negative fixture for exactly one disjunct: delete
  // that disjunct from assertCanTriggerScheduledRetryNow and only that test
  // goes red.

  it("promotes for a board actor that is denied runtime:manage", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();

    const res = await request(createApp(boardKeyActorWithoutMembershipRow(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("promoted");
    expect(res.body.scheduledRetry.runId).toBe(retryRunId);
  });

  it("promotes for the assignee agent even when it is denied runtime:manage", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry();
    await db
      .update(agents)
      .set({ permissions: lowTrustPermissions(issueId) })
      .where(eq(agents.id, agentId));

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("promoted");
    expect(res.body.scheduledRetry.runId).toBe(retryRunId);
  });

  it("promotes for a non-assignee agent that holds company-scope runtime:manage", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const peerAgentId = await seedPeerAgent(companyId, {});

    const res = await request(createApp(agentActor(companyId, peerAgentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("promoted");
    expect(res.body.scheduledRetry.runId).toBe(retryRunId);
  });

  it("refuses a non-assignee agent that is denied runtime:manage", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const peerAgentId = await seedPeerAgent(companyId, lowTrustPermissions(issueId));

    const res = await request(createApp(agentActor(companyId, peerAgentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // Equality, not `toContain`: this pins the *action string* the guard asks
    // about. Swapping `runtime:manage` for a weaker action still denies this
    // low-trust fixture, so only the message distinguishes the two guards.
    expect(res.body).toEqual({
      error: "low_trust_review agents cannot use company-wide or privileged runtime:manage APIs by default.",
      details: { reason: "deny_low_trust_boundary" },
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status, scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run.status).toBe("scheduled_retry");
    expect(run.scheduledRetryAt?.toISOString()).toBe("2026-05-06T19:00:00.000Z");

    const activity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity).toEqual([]);
  });

  it("holds an authorized agent caller to the same promotion gates as the board", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry({ agentStatus: "paused" });
    const peerAgentId = await seedPeerAgent(companyId, {});

    const res = await request(createApp(agentActor(companyId, peerAgentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    // Widening the guard must not widen what gets promoted — and must not let
    // an agent destroy the retry it is trying to help. The assignee is paused,
    // which is exactly the population whose retries are parked, so the caller
    // is refused and the retry is left exactly as it was.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("gate_suppressed");

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run).toEqual({
      status: "scheduled_retry",
      errorCode: null,
      scheduledRetryAt: new Date("2026-05-06T19:00:00.000Z"),
    });
    expect(peerAgentId).not.toBe(agentId);

    // The park survives a *second* caller too: a fleet sweep across parked
    // retries must be idempotent, not cumulative.
    const second = await request(createApp(agentActor(companyId, peerAgentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.outcome).toBe("gate_suppressed");
    const [afterSweep] = await db
      .select({ status: heartbeatRuns.status, scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(afterSweep).toEqual({
      status: "scheduled_retry",
      scheduledRetryAt: new Date("2026-05-06T19:00:00.000Z"),
    });
  });

  it("refuses an agent actor with no agent id on an unassigned issue", async () => {
    const { companyId, issueId } = await seedIssueWithRetry();
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));

    const res = await request(createApp(anonymousAgentActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  // CTO-1..CTO-4 (ALM-7900 finding N1). The `runtime:manage` disjunct denies
  // restricted keys, but only for non-assignee callers. Both halves are pinned
  // so the guard's doc comment cannot drift back to overclaiming.

  it("CTO-1: refuses a non-assignee task-bridge key", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const peerAgentId = await seedPeerAgent(companyId, {});

    const res = await request(createApp(taskBridgeAgentActor(companyId, peerAgentId, issueId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({
      error: "Task bridge keys cannot use company-wide, peer-agent, project, runtime, or secret APIs.",
      details: { reason: "deny_scope" },
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run.status).toBe("scheduled_retry");
  });

  it("CTO-2: admits an assignee task-bridge key, because the assignee disjunct returns first", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry();

    const res = await request(createApp(taskBridgeAgentActor(companyId, agentId, issueId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("promoted");

    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run.status).toBe("queued");
  });

  it("CTO-3: refuses a non-assignee skill-test token", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const peerAgentId = await seedPeerAgent(companyId, {});

    const res = await request(createApp(skillTestAgentActor(companyId, peerAgentId, issueId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({
      error: "Skill-test run tokens cannot use company-wide, peer-agent, project, runtime, secret, or task-create APIs.",
      details: { reason: "deny_scope" },
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run.status).toBe("scheduled_retry");
  });

  it("CTO-4: admits an assignee skill-test token, because the assignee disjunct returns first", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry();

    const res = await request(createApp(skillTestAgentActor(companyId, agentId, issueId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("promoted");

    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run.status).toBe("queued");
  });

  it("keeps the uniform 404 for a cross-company agent instead of leaking a 403", async () => {
    const { issueId } = await seedIssueWithRetry();
    const otherCompanyId = randomUUID();

    const res = await request(createApp(agentActor(otherCompanyId, randomUUID())))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("stamps the promoting agent onto the audit trail", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry();
    const peerAgentId = await seedPeerAgent(companyId, {});

    const res = await request(createApp(agentActor(companyId, peerAgentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Whole array, not `const [activity]`: pinning the first row lets a mutant
    // that writes a second activity row survive.
    const activity = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        entityId: activityLog.entityId,
        agentId: activityLog.agentId,
      })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity).toEqual([
      {
        action: "issue.scheduled_retry_retry_now",
        actorType: "agent",
        actorId: peerAgentId,
        entityId: issueId,
        agentId,
      },
    ]);

    const [run] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    const snapshot = run.contextSnapshot as Record<string, unknown>;
    expect(snapshot.retryNowRequestedByActorType).toBe("agent");
    expect(snapshot.retryNowRequestedByActorId).toBe(peerAgentId);
  });

  it("enforces company scoping for retry-now with a uniform 404", async () => {
    const { issueId } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(randomUUID())))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status).toBe(404);
  });

  it("suppresses retry-now when the issue is under a budget hard-stop", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry();
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "budget" })
      .where(eq(agents.id, agentId));

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      suppressedErrorCode: "budget_blocked",
      scheduledRetry: {
        runId: retryRunId,
        // Still parked, at its ORIGINAL time. Retry-now must not manufacture
        // dueness for a retry the gate would refuse: no route re-arms a
        // cancelled `scheduled_retry`, so cancelling here would destroy state
        // only the board can hand-repair (ALM-7934).
        status: "scheduled_retry",
        errorCode: null,
        scheduledRetryAt: "2026-05-06T19:00:00.000Z",
      },
    });
  });

  it("suppresses retry-now when the issue is waiting on another review participant", async () => {
    const { companyId, agentId, issueId, retryRunId } = await seedIssueWithRetry({ issueStatus: "in_progress" });
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "ReviewerAgent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db
      .update(issues)
      .set({
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .where(eq(issues.id, issueId));

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      suppressedErrorCode: "issue_review_participant_changed",
      scheduledRetry: {
        runId: retryRunId,
        // Still parked, at its ORIGINAL time. Retry-now must not manufacture
        // dueness for a retry the gate would refuse: no route re-arms a
        // cancelled `scheduled_retry`, so cancelling here would destroy state
        // only the board can hand-repair (ALM-7934).
        status: "scheduled_retry",
        errorCode: null,
        scheduledRetryAt: "2026-05-06T19:00:00.000Z",
      },
    });
  });

  it("suppresses retry-now when the issue is under an active subtree pause hold", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "manual pause for review",
      releasePolicy: { strategy: "manual" },
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      suppressedErrorCode: "issue_paused",
      scheduledRetry: {
        runId: retryRunId,
        // Still parked, at its ORIGINAL time. Retry-now must not manufacture
        // dueness for a retry the gate would refuse: no route re-arms a
        // cancelled `scheduled_retry`, so cancelling here would destroy state
        // only the board can hand-repair (ALM-7934).
        status: "scheduled_retry",
        errorCode: null,
        scheduledRetryAt: "2026-05-06T19:00:00.000Z",
      },
    });
  });

  it("suppresses retry-now when unresolved blockers remain", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Blocking task",
      status: "todo",
      priority: "medium",
      issueNumber: 2,
      identifier: "BLOCK-2",
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    await db
      .update(issues)
      .set({ status: "blocked" })
      .where(eq(issues.id, issueId));

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      suppressedErrorCode: "issue_dependencies_blocked",
      scheduledRetry: {
        runId: retryRunId,
        // Still parked, at its ORIGINAL time. Retry-now must not manufacture
        // dueness for a retry the gate would refuse: no route re-arms a
        // cancelled `scheduled_retry`, so cancelling here would destroy state
        // only the board can hand-repair (ALM-7934).
        status: "scheduled_retry",
        errorCode: null,
        scheduledRetryAt: "2026-05-06T19:00:00.000Z",
      },
    });
  });

  it("suppresses retry-now when the issue already reached a terminal status", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ issueStatus: "done" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      suppressedErrorCode: "issue_terminal_status",
      scheduledRetry: {
        runId: retryRunId,
        // Still parked, at its ORIGINAL time. Retry-now must not manufacture
        // dueness for a retry the gate would refuse: no route re-arms a
        // cancelled `scheduled_retry`, so cancelling here would destroy state
        // only the board can hand-repair (ALM-7934).
        status: "scheduled_retry",
        errorCode: null,
        scheduledRetryAt: "2026-05-06T19:00:00.000Z",
      },
    });
  });
});
