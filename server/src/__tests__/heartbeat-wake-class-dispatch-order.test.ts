import { describe, expect, it } from "vitest";
import {
  buildQueuedRunDispatchKey,
  sortQueuedRunDispatchKeys,
  issueRunPriorityRank,
  QUEUED_RUN_CLASS_AGE_ESCAPE_MS,
  QUEUED_RUN_READINESS_RANK,
  QUEUED_RUN_WAKE_CLASS_RANK,
  type QueuedRunDispatchKey,
} from "../services/queued-run-dispatch-order.js";

/**
 * The wake-class rank, in isolation from the dispatcher.
 *
 * Companion to ./heartbeat-queued-run-dispatch-order.test.ts, which pins the
 * head-start/readiness/priority rules and is a regression control for this
 * change: every run in that file shares one class, so its 11 examples pass only
 * if the class key is a no-op when the class does not vary.
 *
 * The end-to-end cover — that the dispatcher reads `invocation_source` and
 * `scheduled_retry_reason` off the row and hands them here — is
 * ./heartbeat-wake-class-dispatch.test.ts.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 8, 5, 21, 30, 0);

function runKey(input: {
  runId: string;
  /** How long before NOW the run was enqueued. */
  ageMs: number;
  source?: string | null;
  retryReason?: string | null;
  issueId?: string | null;
  status?: string | null;
  priority?: string | null;
  dependencyReady?: boolean;
  blocking?: readonly string[];
  nowMs?: number;
}): QueuedRunDispatchKey {
  const issueId =
    input.issueId === undefined ? `issue-${input.runId}` : input.issueId;
  return buildQueuedRunDispatchKey({
    runId: input.runId,
    createdAtMs: NOW - input.ageMs,
    issueId,
    issueStatus: input.status ?? "in_progress",
    issuePriority: input.priority ?? "high",
    isDependencyReady: input.dependencyReady ?? true,
    issueIdsBlockingOpenWork: new Set(input.blocking ?? []),
    invocationSource: input.source === undefined ? "automation" : input.source,
    scheduledRetryReason: input.retryReason ?? null,
    nowMs: input.nowMs ?? NOW,
  });
}

function dispatchOrder(keys: readonly QueuedRunDispatchKey[]): string[] {
  return sortQueuedRunDispatchKeys(keys).map((key) => key.runId);
}

/** A parked provider-quota retry: the shape 6,936 of the last 7 days' runs had. */
function parkedRetry(runId: string, ageMs: number, extra: Record<string, unknown> = {}) {
  return runKey({
    runId,
    ageMs,
    source: "automation",
    retryReason: "transient_failure",
    ...extra,
  });
}

/** A freshly assigned issue's wake. */
function assignmentWake(runId: string, ageMs: number, extra: Record<string, unknown> = {}) {
  return runKey({ runId, ageMs, source: "assignment", retryReason: null, ...extra });
}

describe("wake-class rank", () => {
  it("pins the rank of every (source, retry) pair the column can hold", () => {
    // Equality over the closed domain, not a spot check: `invocation_source`
    // holds exactly four values in production (automation 60,992, timer 14,520,
    // assignment 8,997, on_demand 42), and the second axis is a boolean. An
    // equality table over all of them terminates; a battery of negative
    // assertions would not.
    const rankOf = (source: string | null, retryReason: string | null) =>
      runKey({ runId: "probe", ageMs: 0, source, retryReason }).wakeClassRank;

    expect({
      assignment: rankOf("assignment", null),
      onDemand: rankOf("on_demand", null),
      automation: rankOf("automation", null),
      timer: rankOf("timer", null),
      unknownFutureSource: rankOf("scheduled_sweep", null),
      nullSource: rankOf(null, null),
      assignmentRetry: rankOf("assignment", "transient_failure"),
      onDemandRetry: rankOf("on_demand", "transient_failure"),
      automationRetry: rankOf("automation", "transient_failure"),
      timerRetry: rankOf("timer", "transient_failure"),
    }).toEqual({
      assignment: QUEUED_RUN_WAKE_CLASS_RANK.assignment,
      onDemand: QUEUED_RUN_WAKE_CLASS_RANK.onDemand,
      automation: QUEUED_RUN_WAKE_CLASS_RANK.automation,
      timer: QUEUED_RUN_WAKE_CLASS_RANK.automation,
      // A source added after this was written must land mid-band: it can
      // neither seize the front of the queue nor be starved at the back
      // without someone choosing that in the switch.
      unknownFutureSource: QUEUED_RUN_WAKE_CLASS_RANK.automation,
      nullSource: QUEUED_RUN_WAKE_CLASS_RANK.automation,
      // Retry-ness is checked first, so it holds whatever source it inherited.
      assignmentRetry: QUEUED_RUN_WAKE_CLASS_RANK.automationRetry,
      onDemandRetry: QUEUED_RUN_WAKE_CLASS_RANK.automationRetry,
      automationRetry: QUEUED_RUN_WAKE_CLASS_RANK.automationRetry,
      timerRetry: QUEUED_RUN_WAKE_CLASS_RANK.automationRetry,
    });
    // The tiers are distinct and ordered, so no pairing above is vacuous.
    expect([
      QUEUED_RUN_WAKE_CLASS_RANK.assignment,
      QUEUED_RUN_WAKE_CLASS_RANK.onDemand,
      QUEUED_RUN_WAKE_CLASS_RANK.automation,
      QUEUED_RUN_WAKE_CLASS_RANK.automationRetry,
    ]).toEqual([0, 1, 2, 3]);
  });

  it("dispatches a 4h-newer assignment wake ahead of a parked retry", () => {
    // The ticket's headline case. Under the pre-change ordering these two are
    // identical on every key up to createdAt, so FIFO served the retry first.
    const retry = parkedRetry("retry", 4 * HOUR);
    const assignment = assignmentWake("assignment", 0);

    expect(dispatchOrder([retry, assignment])).toEqual(["assignment", "retry"]);
    expect(dispatchOrder([assignment, retry])).toEqual(["assignment", "retry"]);
  });

  it("outranks the readiness band, which is what the production shape needs", () => {
    // The measured shape, and the reason the class key sits AHEAD of readiness
    // rather than behind it: a parked retry's issue is `in_progress` (it was
    // checked out when its run died — 669 of the last 3 days' 1,202 retry runs),
    // so it holds readiness band 0, while a fresh assignment wake's issue is
    // still `todo` and holds band 1. Rank the class below readiness and not one
    // of those retries moves.
    const retry = parkedRetry("retry", 4 * HOUR, { status: "in_progress" });
    const assignment = assignmentWake("assignment", 0, { status: "todo" });

    expect(retry.readinessRank).toBe(QUEUED_RUN_READINESS_RANK.inProgressAndReady);
    expect(assignment.readinessRank).toBe(QUEUED_RUN_READINESS_RANK.ready);
    expect(dispatchOrder([retry, assignment])).toEqual(["assignment", "retry"]);
  });

  it("keeps a dependency-blocked run last however urgent its class", () => {
    // Guards the hoist. Dispatching a run whose issue cannot proceed burns a
    // slot, so `dependencyNotReady` is checked ahead of the class; drop the
    // hoist and the assignment wake takes the slot it cannot use.
    const blockedAssignment = assignmentWake("a-blocked-assignment", 0, {
      dependencyReady: false,
      priority: "critical",
    });
    const readyRetry = parkedRetry("b-ready-retry", 4 * HOUR);

    expect(blockedAssignment.dependencyNotReady).toBe(true);
    expect(readyRetry.dependencyNotReady).toBe(false);
    expect(dispatchOrder([blockedAssignment, readyRetry])).toEqual([
      "b-ready-retry",
      "a-blocked-assignment",
    ]);
  });

  it("orders two runs of one class oldest first, unchanged", () => {
    const olderRetry = parkedRetry("older", 3 * HOUR);
    const newerRetry = parkedRetry("newer", 1 * HOUR);
    const olderAssignment = assignmentWake("older-assignment", 3 * HOUR);
    const newerAssignment = assignmentWake("newer-assignment", 1 * HOUR);

    expect(dispatchOrder([newerRetry, olderRetry])).toEqual(["older", "newer"]);
    expect(dispatchOrder([newerAssignment, olderAssignment])).toEqual([
      "older-assignment",
      "newer-assignment",
    ]);
  });

  it("promotes a run past the age threshold ahead of a newer top-class run", () => {
    // The starvation escape: without it a steady assignment stream defers the
    // retry ladder forever.
    const staleRetry = parkedRetry("stale-retry", QUEUED_RUN_CLASS_AGE_ESCAPE_MS + MINUTE);
    const freshAssignment = assignmentWake("fresh-assignment", 0);

    expect(staleRetry.ageEscaped).toBe(true);
    expect(staleRetry.wakeClassRank).toBe(QUEUED_RUN_WAKE_CLASS_RANK.automationRetry);
    expect(staleRetry.effectiveWakeClassRank).toBe(QUEUED_RUN_WAKE_CLASS_RANK.assignment);
    expect(dispatchOrder([freshAssignment, staleRetry])).toEqual([
      "stale-retry",
      "fresh-assignment",
    ]);
  });

  it("escapes exactly at the threshold and not one millisecond under", () => {
    // Boundary, both sides. A `>` for `>=` mutant dies on the first assertion;
    // an off-by-one that widens the window dies on the second.
    const atBound = parkedRetry("at-bound", QUEUED_RUN_CLASS_AGE_ESCAPE_MS);
    const justUnder = parkedRetry("just-under", QUEUED_RUN_CLASS_AGE_ESCAPE_MS - 1);
    const freshAssignment = assignmentWake("fresh-assignment", 0);

    expect(atBound.ageEscaped).toBe(true);
    expect(justUnder.ageEscaped).toBe(false);
    expect(dispatchOrder([freshAssignment, atBound])).toEqual([
      "at-bound",
      "fresh-assignment",
    ]);
    expect(dispatchOrder([justUnder, freshAssignment])).toEqual([
      "fresh-assignment",
      "just-under",
    ]);
  });

  it("measures the escape against the passed clock, never a read one", () => {
    // The module documents itself as clock-free. Moving `nowMs` forward past
    // the threshold, with createdAtMs fixed, must be the only thing that flips
    // the escape — so a mutant that substitutes Date.now() fails here, since
    // the fixture's epoch is in the future relative to any real wall clock.
    const beforeThreshold = parkedRetry("run", 0, { nowMs: NOW });
    const afterThreshold = parkedRetry("run", 0, {
      nowMs: NOW + QUEUED_RUN_CLASS_AGE_ESCAPE_MS,
    });

    expect(beforeThreshold.ageEscaped).toBe(false);
    expect(afterThreshold.ageEscaped).toBe(true);
  });
});

describe("wake-class rank: inputs the ordering must not change", () => {
  /**
   * The pre-change comparator, transcribed from
   * queued-run-dispatch-order.ts at 6fc3fede1 — readiness, then priority, then
   * the head-start-adjusted time, then the real time, then the run id.
   *
   * ADR-004 control 1's negative fixture is an equality against this, not an
   * absence of complaints: for any queue whose runs all share one wake class,
   * the new ordering must be the old ordering element for element.
   */
  function referenceOrder(keys: readonly QueuedRunDispatchKey[]): string[] {
    const HEAD_START = 24 * 60 * 60 * 1000;
    const orderingTime = (key: QueuedRunDispatchKey) =>
      key.createdAtMs - (key.blocksOpenWork ? HEAD_START : 0);
    return [...keys]
      .sort((left, right) => {
        if (left.readinessRank !== right.readinessRank)
          return left.readinessRank - right.readinessRank;
        if (left.priorityRank !== right.priorityRank)
          return left.priorityRank - right.priorityRank;
        if (orderingTime(left) !== orderingTime(right))
          return orderingTime(left) - orderingTime(right);
        if (left.createdAtMs !== right.createdAtMs)
          return left.createdAtMs - right.createdAtMs;
        return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
      })
      .map((key) => key.runId);
  }

  /**
   * A queue that varies every axis the comparator reads EXCEPT the wake class:
   * readiness band, priority band, dependency readiness, blocking-set
   * membership, enqueue age, and a run id that alphabetizes against its
   * expected position.
   *
   * The caller supplies the ages, and they are all on one side of the escape
   * threshold. Straddling it is NOT this fixture's job: a queue whose ages
   * straddle the threshold has two effective classes, which is the escape
   * working, and the cases above assert that separately.
   */
  function sameClassQueue(
    source: string | null,
    retryReason: string | null,
    ages: readonly number[],
  ) {
    const statuses = ["in_progress", "todo", null];
    const priorities = ["critical", "high", "low", null];
    const keys: QueuedRunDispatchKey[] = [];
    let n = 0;
    for (const ageMs of ages) {
      for (const status of statuses) {
        for (const priority of priorities) {
          n += 1;
          const dependencyReady = n % 5 !== 0;
          const issueId = n % 7 === 0 ? null : `issue-${n}`;
          keys.push(
            runKey({
              // Descending ids against ascending ages, so a collapsed band
              // cannot leave the array in its expected order by accident.
              runId: `run-${String(1000 - n).padStart(4, "0")}`,
              ageMs,
              source,
              retryReason,
              issueId,
              status,
              priority,
              dependencyReady,
              blocking: n % 3 === 0 && issueId ? [issueId] : [],
            }),
          );
        }
      }
    }
    return keys;
  }

  // Inside the escape window, and entirely past it. Both must be identity: the
  // second is the one that proves the escape promotes uniformly rather than
  // reshuffling a queue it lifts.
  const WITHIN_WINDOW = [0, 30 * MINUTE, 2 * HOUR, 5 * HOUR, QUEUED_RUN_CLASS_AGE_ESCAPE_MS - 1];
  const PAST_THRESHOLD = [
    QUEUED_RUN_CLASS_AGE_ESCAPE_MS,
    12 * HOUR,
    30 * HOUR,
    48 * HOUR,
    72 * HOUR,
  ];

  const CLASSES: Array<[string | null, string | null]> = [
    ["assignment", null],
    ["on_demand", null],
    ["automation", null],
    ["timer", null],
    ["scheduled_sweep", null],
    [null, null],
    ["automation", "transient_failure"],
    ["assignment", "workspace_busy"],
  ];

  it.each(
    CLASSES.flatMap(([source, retryReason]) => [
      [source, retryReason, "within the escape window", WITHIN_WINDOW] as const,
      [source, retryReason, "past the escape threshold", PAST_THRESHOLD] as const,
    ]),
  )(
    "leaves a 60-run queue of one class (%s / %s, %s) in its pre-change order",
    (source, retryReason, _label, ages) => {
      const keys = sameClassQueue(source, retryReason, ages);
      expect(keys).toHaveLength(60);
      // Every run shares a class AND sits on one side of the threshold, so the
      // class key cannot discriminate between any pair in this queue.
      expect(new Set(keys.map((key) => key.effectiveWakeClassRank)).size).toBe(1);
      expect(dispatchOrder(keys)).toEqual(referenceOrder(keys));
    },
  );

  it("leaves a single-run queue alone whatever its class", () => {
    for (const key of [
      assignmentWake("solo", 0),
      parkedRetry("solo", 30 * HOUR),
      runKey({ runId: "solo", ageMs: 2 * HOUR, source: "timer", issueId: null }),
    ]) {
      expect(dispatchOrder([key])).toEqual(["solo"]);
      expect(referenceOrder([key])).toEqual(["solo"]);
    }
  });

  it("leaves the priority rank table untouched", () => {
    // The class key sits above priority, so a mutant could satisfy every
    // ordering case above by collapsing this table instead.
    expect({
      critical: issueRunPriorityRank("critical"),
      high: issueRunPriorityRank("high"),
      medium: issueRunPriorityRank("medium"),
      low: issueRunPriorityRank("low"),
      unknown: issueRunPriorityRank("someday"),
      nullish: issueRunPriorityRank(null),
    }).toEqual({
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      unknown: 4,
      nullish: 4,
    });
  });
});
