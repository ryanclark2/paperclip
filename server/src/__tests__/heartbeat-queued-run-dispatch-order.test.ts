import { describe, expect, it } from "vitest";
import { ISSUE_STATUSES } from "@paperclipai/shared";
import {
  buildQueuedRunDispatchKey,
  compareQueuedRunDispatchKeys,
  issueRunPriorityRank,
  sortQueuedRunDispatchKeys,
  OPEN_WORK_EXCLUDED_ISSUE_STATUSES,
  QUEUED_RUN_BLOCKING_HEAD_START_MS,
  QUEUED_RUN_READINESS_RANK,
  type QueuedRunDispatchKey,
} from "../services/queued-run-dispatch-order.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Fixed epoch: the ordering must not read a clock, so the fixture supplies one.
const NOW = Date.UTC(2026, 8, 5, 19, 51, 0);

function runKey(input: {
  runId: string;
  /** How long before NOW the run was enqueued. */
  ageMs: number;
  issueId?: string | null;
  status?: string | null;
  priority?: string | null;
  dependencyReady?: boolean;
  blocking?: readonly string[];
}): QueuedRunDispatchKey {
  const issueId = input.issueId === undefined ? `issue-${input.runId}` : input.issueId;
  return buildQueuedRunDispatchKey({
    runId: input.runId,
    createdAtMs: NOW - input.ageMs,
    issueId,
    issueStatus: input.status ?? "in_progress",
    issuePriority: input.priority ?? "high",
    isDependencyReady: input.dependencyReady ?? true,
    issueIdsBlockingOpenWork: new Set(input.blocking ?? []),
  });
}

/** Sorts and returns run ids, so every assertion can be a whole-array toEqual. */
function dispatchOrder(keys: readonly QueuedRunDispatchKey[]): string[] {
  return sortQueuedRunDispatchKeys(keys).map((key) => key.runId);
}

/** Readiness rank for one issue status, holding every other input fixed. */
function readinessRankFor(issueStatus: string | null | undefined): number {
  return buildQueuedRunDispatchKey({
    runId: "probe",
    createdAtMs: NOW,
    issueId: "issue-probe",
    issueStatus,
    issuePriority: "high",
    isDependencyReady: true,
    issueIdsBlockingOpenWork: new Set<string>(),
  }).readinessRank;
}

describe("queued-run dispatch ordering", () => {
  it("gives a fresh run that blocks open work priority over a merely older run", () => {
    // The case that fails under the pre-change ordering: same readiness band,
    // same priority, so the old rule (oldest first) served the seat last.
    const seat = runKey({
      runId: "seat",
      ageMs: 1 * MINUTE,
      issueId: "issue-seat",
      blocking: ["issue-seat"],
    });
    const stale = runKey({ runId: "stale", ageMs: 3 * HOUR });

    expect(dispatchOrder([stale, seat])).toEqual(["seat", "stale"]);
    // Input order must not matter.
    expect(dispatchOrder([seat, stale])).toEqual(["seat", "stale"]);
  });

  it("never inverts a priority band", () => {
    const criticalOld = runKey({
      runId: "critical-old",
      ageMs: 10 * HOUR,
      priority: "critical",
    });
    const highFreshBlocking = runKey({
      runId: "high-fresh-blocking",
      ageMs: 0,
      issueId: "issue-high-fresh-blocking",
      priority: "high",
      blocking: ["issue-high-fresh-blocking"],
    });

    expect(dispatchOrder([highFreshBlocking, criticalOld])).toEqual([
      "critical-old",
      "high-fresh-blocking",
    ]);
  });

  it("bounds the head start instead of compounding it", () => {
    const freshBlocking = runKey({
      runId: "fresh-blocking",
      ageMs: 0,
      issueId: "issue-fresh-blocking",
      blocking: ["issue-fresh-blocking"],
    });
    const waitedPastBound = runKey({
      runId: "waited-past-bound",
      ageMs: QUEUED_RUN_BLOCKING_HEAD_START_MS + MINUTE,
    });
    const waitedExactlyBound = runKey({
      runId: "waited-exactly-bound",
      ageMs: QUEUED_RUN_BLOCKING_HEAD_START_MS,
    });
    const waitedJustUnderBound = runKey({
      runId: "waited-just-under-bound",
      ageMs: QUEUED_RUN_BLOCKING_HEAD_START_MS - MINUTE,
    });

    // Past the bound, and exactly at it, the waiting run still wins: the bound
    // is closed, so a run that has waited the full head start can never be
    // overtaken again.
    expect(dispatchOrder([freshBlocking, waitedPastBound])).toEqual([
      "waited-past-bound",
      "fresh-blocking",
    ]);
    expect(dispatchOrder([freshBlocking, waitedExactlyBound])).toEqual([
      "waited-exactly-bound",
      "fresh-blocking",
    ]);
    // One minute short of the bound, the blocking run does overtake it.
    expect(dispatchOrder([waitedJustUnderBound, freshBlocking])).toEqual([
      "fresh-blocking",
      "waited-just-under-bound",
    ]);
  });

  it("keeps FIFO within each tier", () => {
    const blockingOld = runKey({
      runId: "blocking-old",
      ageMs: 2 * HOUR,
      issueId: "issue-blocking-old",
      blocking: ["issue-blocking-old"],
    });
    const blockingNew = runKey({
      runId: "blocking-new",
      ageMs: 1 * HOUR,
      issueId: "issue-blocking-new",
      blocking: ["issue-blocking-new"],
    });
    const plainOld = runKey({ runId: "plain-old", ageMs: 5 * HOUR });
    const plainNew = runKey({ runId: "plain-new", ageMs: 4 * HOUR });

    expect(
      dispatchOrder([plainNew, blockingNew, plainOld, blockingOld]),
    ).toEqual(["blocking-old", "blocking-new", "plain-old", "plain-new"]);
  });

  it("keeps readiness rank dominant over both the head start and priority", () => {
    const notReadyBlockingCritical = runKey({
      runId: "not-ready-blocking-critical",
      ageMs: 10 * HOUR,
      issueId: "issue-not-ready",
      priority: "critical",
      dependencyReady: false,
      blocking: ["issue-not-ready"],
    });
    const readyPlainLow = runKey({
      runId: "ready-plain-low",
      ageMs: 0,
      status: "todo",
      priority: "low",
    });
    const inProgressPlainLow = runKey({
      runId: "in-progress-plain-low",
      ageMs: 0,
      status: "in_progress",
      priority: "low",
    });

    expect(
      dispatchOrder([
        notReadyBlockingCritical,
        readyPlainLow,
        inProgressPlainLow,
      ]),
    ).toEqual([
      "in-progress-plain-low",
      "ready-plain-low",
      "not-ready-blocking-critical",
    ]);
  });

  it("gives a run with no issue no head start and leaves its readiness rank at 2", () => {
    const noIssue = runKey({
      runId: "no-issue",
      ageMs: 0,
      issueId: null,
      // A non-empty blocking set must still not reach a run with no issue.
      blocking: ["issue-in-progress-plain", "some-other-issue"],
    });
    expect(noIssue.blocksOpenWork).toBe(false);
    expect(noIssue.readinessRank).toBe(QUEUED_RUN_READINESS_RANK.noIssue);

    const inProgressPlain = runKey({ runId: "in-progress-plain", ageMs: 0 });
    const todoPlain = runKey({ runId: "todo-plain", ageMs: 0, status: "todo" });
    const notReady = runKey({
      runId: "not-ready",
      ageMs: 0,
      dependencyReady: false,
    });

    expect(
      dispatchOrder([notReady, noIssue, todoPlain, inProgressPlain]),
    ).toEqual(["in-progress-plain", "todo-plain", "no-issue", "not-ready"]);
  });

  it("only grants the head start to the run whose own issue is in the blocking set", () => {
    // Guards the lookup direction: the set holds blocker issue ids, so a run
    // whose issue merely appears as somebody else's dependent gets nothing.
    const dependent = runKey({
      runId: "dependent",
      ageMs: 0,
      issueId: "issue-dependent",
      blocking: ["issue-blocker"],
    });
    const blocker = runKey({
      runId: "blocker",
      ageMs: 0,
      issueId: "issue-blocker",
      blocking: ["issue-blocker"],
    });

    expect(dependent.blocksOpenWork).toBe(false);
    expect(blocker.blocksOpenWork).toBe(true);
    expect(dispatchOrder([dependent, blocker])).toEqual([
      "blocker",
      "dependent",
    ]);
  });

  it("is a deterministic total order that does not lean on sort stability", () => {
    const sameMsA = runKey({ runId: "aaa", ageMs: 0 });
    const sameMsB = runKey({ runId: "bbb", ageMs: 0 });

    expect(dispatchOrder([sameMsB, sameMsA])).toEqual(["aaa", "bbb"]);
    expect(dispatchOrder([sameMsA, sameMsB])).toEqual(["aaa", "bbb"]);
    expect(compareQueuedRunDispatchKeys(sameMsA, sameMsA)).toBe(0);
  });

  it("keeps in_review and blocked in the ready band, behind in_progress", () => {
    // The two band boundaries. Only `in_progress` earns the top band; every
    // other status a queued run's issue can hold is merely `ready`. Adding a
    // disjunct to that check (`|| issueStatus === "in_review"`) promotes work
    // that has left the author's hands ahead of work actually in flight.
    expect(readinessRankFor("in_review")).toBe(QUEUED_RUN_READINESS_RANK.ready);
    expect(readinessRankFor("blocked")).toBe(QUEUED_RUN_READINESS_RANK.ready);

    // Same rank means the head start still decides between them, and both stay
    // behind an in_progress run of identical age and priority.
    const inProgress = runKey({ runId: "in-progress", ageMs: 0 });
    const inReview = runKey({ runId: "in-review", ageMs: 0, status: "in_review" });
    const blocked = runKey({ runId: "blocked", ageMs: 0, status: "blocked" });
    expect(dispatchOrder([blocked, inReview, inProgress])).toEqual([
      "in-progress",
      "blocked",
      "in-review",
    ]);
  });

  it("pins the whole status-to-readiness map by equality", () => {
    // Equality over the entire declared status enum, not a probe per status a
    // mutant happens to name: a widened condition moves exactly one row here
    // and cannot hide behind a rank-number assertion (ADR-004 Amendment 6).
    expect(
      ISSUE_STATUSES.map((status) => [status, readinessRankFor(status)]),
    ).toEqual([
      ["backlog", QUEUED_RUN_READINESS_RANK.ready],
      ["todo", QUEUED_RUN_READINESS_RANK.ready],
      ["in_progress", QUEUED_RUN_READINESS_RANK.inProgressAndReady],
      ["in_review", QUEUED_RUN_READINESS_RANK.ready],
      ["done", QUEUED_RUN_READINESS_RANK.ready],
      ["blocked", QUEUED_RUN_READINESS_RANK.ready],
      ["cancelled", QUEUED_RUN_READINESS_RANK.ready],
    ]);
    // A status outside the enum, and a missing one, must land in the same band
    // rather than in the top one.
    expect([null, undefined, "not-a-status"].map(readinessRankFor)).toEqual([
      QUEUED_RUN_READINESS_RANK.ready,
      QUEUED_RUN_READINESS_RANK.ready,
      QUEUED_RUN_READINESS_RANK.ready,
    ]);
    // Dependency readiness is checked before status, so an in_progress issue
    // that is not dependency-ready lands in the bottom band, not the top one.
    expect(
      runKey({ runId: "not-ready", ageMs: 0, dependencyReady: false })
        .readinessRank,
    ).toBe(QUEUED_RUN_READINESS_RANK.dependencyNotReady);
  });

  it("pins the head start and the open-work exclusion list exactly", () => {
    // Equality, not membership: a presence assertion is satisfied by a superset
    // and so cannot catch a widened list (ADR-004 Amendment 6).
    expect(QUEUED_RUN_BLOCKING_HEAD_START_MS).toBe(24 * 60 * 60 * 1000);
    expect([...OPEN_WORK_EXCLUDED_ISSUE_STATUSES]).toEqual([
      "backlog",
      "done",
      "cancelled",
    ]);
    expect(QUEUED_RUN_READINESS_RANK).toEqual({
      inProgressAndReady: 0,
      ready: 1,
      noIssue: 2,
      dependencyNotReady: 3,
    });
    expect(
      ["critical", "high", "medium", "low", "someday", null, undefined].map(
        (priority) => issueRunPriorityRank(priority),
      ),
    ).toEqual([0, 1, 2, 3, 4, 4, 4]);
  });
});
