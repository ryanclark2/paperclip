/**
 * Ordering rules for the queued heartbeat-run dispatcher.
 *
 * Extracted from `startNextQueuedRunForAgent` in heartbeat.ts, where the sort
 * lived as an inline closure over DB rows and so could not be tested without a
 * database. The dispatcher still owns every query; this module owns the
 * ordering and nothing else, and every function here is pure — no DB, no clock,
 * no `contextSnapshot` parsing.
 */

/**
 * A queued run whose issue blocks other open work dispatches as if it had been
 * enqueued this far in the past.
 *
 * This is a constant offset, not a multiplier or a boost, and that is what
 * bounds it: a run can only ever be overtaken by a blocking run enqueued less
 * than this window after it. Once a run has waited
 * QUEUED_RUN_BLOCKING_HEAD_START_MS, its rank within its band is monotonically
 * non-increasing and it dispatches within (its current rank) slots.
 *
 * 24h was chosen against the measured queue: the deepest observed FoundingEng
 * queue spans ~3.7h, so this puts a gate at the front of every observed state
 * while still terminating.
 */
export const QUEUED_RUN_BLOCKING_HEAD_START_MS = 24 * 60 * 60 * 1000;

/**
 * Readiness bands, unchanged from the pre-extraction dispatcher. Note that a
 * run with no issue (2) outranks a run whose issue is not dependency-ready (3),
 * and that any `in_progress` run (0) outranks any merely-ready run (1).
 */
export const QUEUED_RUN_READINESS_RANK = {
  inProgressAndReady: 0,
  ready: 1,
  noIssue: 2,
  dependencyNotReady: 3,
} as const;

/**
 * Wake classes, highest dispatch priority first.
 *
 * Derived from two closed inputs already on the run row — `invocation_source`
 * (4 values in production: automation 60,992, timer 14,520, assignment 8,997,
 * on_demand 42) and whether `scheduled_retry_reason` is set. Deliberately NOT
 * derived from `contextSnapshot.wakeReason`, which is an open set of 22-plus
 * strings that grows whenever a new wake is added; an enumeration over an open
 * set silently misclassifies every value added after it was written.
 */
export const QUEUED_RUN_WAKE_CLASS_RANK = {
  /** Work newly handed to the agent. */
  assignment: 0,
  /** A human or the board asked for this run directly. */
  onDemand: 1,
  /** Every other first-attempt wake: automation, timer, unknown sources. */
  automation: 2,
  /** A run the retry scheduler parked and released later. */
  automationRetry: 3,
} as const;

/**
 * A queued run older than this dispatches as if it were top class, whatever it
 * actually is. Without it, strict class priority lets a steady assignment
 * stream starve the retry ladder forever.
 *
 * 6h, chosen against the measured queue rather than a round number. The
 * deepest observed single-agent queue spans ~3.7h of enqueue time (FoundingEng,
 * 2026-09-05 18:08-21:30Z, 140 runs), so 6h is strictly longer than the worst
 * observed burst: a parked run cannot be leapfrogged indefinitely by a burst
 * that has already ended. At the measured drain rate — maxConcurrentRuns 2 at
 * ~33 min/run, so ~3.6 runs/hour — 6h is ~22 run slots, which is the bound: a
 * promoted run dispatches within ~22 slots of promotion.
 *
 * The trade this buys is explicit. Past the threshold the ordering degrades to
 * the pre-change behaviour (oldest first), because every waiting run is top
 * class. What the tiering buys is the 6h window in which fresh work jumps a
 * released ladder, and the escape is what stops that window from being
 * unbounded.
 */
export const QUEUED_RUN_CLASS_AGE_ESCAPE_MS = 6 * 60 * 60 * 1000;

/** Ordering keys for one queued run, precomputed so the comparator stays pure. */
export interface QueuedRunDispatchKey {
  runId: string;
  readinessRank: number;
  priorityRank: number;
  createdAtMs: number;
  /** The run's issue blocks at least one issue that is still open work. */
  blocksOpenWork: boolean;
  /** Wake class before the age escape, kept so a caller can explain an order. */
  wakeClassRank: number;
  /** Wake class after the age escape; this is what the comparator reads. */
  effectiveWakeClassRank: number;
  /** The run waited past QUEUED_RUN_CLASS_AGE_ESCAPE_MS and was promoted. */
  ageEscaped: boolean;
  /**
   * The run's issue is not dependency-ready. Hoisted out of `readinessRank` so
   * it can be checked ahead of the wake class: a run that cannot make progress
   * must stay last no matter how urgent its class is.
   */
  dependencyNotReady: boolean;
}

export function issueRunPriorityRank(priority: string | null | undefined) {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function queuedRunReadinessRank(input: {
  issueId: string | null;
  issueStatus: string | null | undefined;
  isDependencyReady: boolean;
}) {
  if (!input.issueId) return QUEUED_RUN_READINESS_RANK.noIssue;
  if (!input.isDependencyReady)
    return QUEUED_RUN_READINESS_RANK.dependencyNotReady;
  if (input.issueStatus === "in_progress")
    return QUEUED_RUN_READINESS_RANK.inProgressAndReady;
  return QUEUED_RUN_READINESS_RANK.ready;
}

function queuedRunWakeClassRank(input: {
  invocationSource: string | null | undefined;
  scheduledRetryReason: string | null | undefined;
}): number {
  // Checked first, and deliberately: a retry is a retry whatever source it
  // inherited. The ladder this exists to demote is exactly the set of runs the
  // retry scheduler parked, and being parked is what makes them stale.
  if (input.scheduledRetryReason)
    return QUEUED_RUN_WAKE_CLASS_RANK.automationRetry;
  switch (input.invocationSource) {
    case "assignment":
      return QUEUED_RUN_WAKE_CLASS_RANK.assignment;
    case "on_demand":
      return QUEUED_RUN_WAKE_CLASS_RANK.onDemand;
    // `automation`, `timer`, and any source added later. An unknown source
    // lands in the middle band on purpose: it can neither seize the top of the
    // queue nor be starved at the bottom without someone choosing that here.
    default:
      return QUEUED_RUN_WAKE_CLASS_RANK.automation;
  }
}

export function buildQueuedRunDispatchKey(input: {
  runId: string;
  createdAtMs: number;
  issueId: string | null;
  issueStatus: string | null | undefined;
  issuePriority: string | null | undefined;
  isDependencyReady: boolean;
  issueIdsBlockingOpenWork: ReadonlySet<string>;
  invocationSource: string | null | undefined;
  scheduledRetryReason: string | null | undefined;
  /** Dispatch-time clock, passed in so this module never reads one itself. */
  nowMs: number;
}): QueuedRunDispatchKey {
  const readinessRank = queuedRunReadinessRank(input);
  const wakeClassRank = queuedRunWakeClassRank(input);
  const ageEscaped =
    input.nowMs - input.createdAtMs >= QUEUED_RUN_CLASS_AGE_ESCAPE_MS;
  return {
    runId: input.runId,
    readinessRank,
    wakeClassRank,
    ageEscaped,
    effectiveWakeClassRank: ageEscaped
      ? QUEUED_RUN_WAKE_CLASS_RANK.assignment
      : wakeClassRank,
    dependencyNotReady:
      readinessRank === QUEUED_RUN_READINESS_RANK.dependencyNotReady,
    priorityRank: issueRunPriorityRank(input.issuePriority),
    createdAtMs: input.createdAtMs,
    // A run with no issue can never block anything, so it can never take the
    // head start regardless of what the blocking set contains.
    blocksOpenWork: input.issueId
      ? input.issueIdsBlockingOpenWork.has(input.issueId)
      : false,
  };
}

/** The enqueue time the ordering actually uses, after the head start. */
function queuedRunDispatchOrderingTimeMs(
  key: QueuedRunDispatchKey,
): number {
  return (
    key.createdAtMs -
    (key.blocksOpenWork ? QUEUED_RUN_BLOCKING_HEAD_START_MS : 0)
  );
}

/**
 * Total order over queued runs. Readiness and priority are unchanged from the
 * pre-extraction dispatcher and are checked first, so the head start can never
 * invert a priority band.
 */
export function compareQueuedRunDispatchKeys(
  left: QueuedRunDispatchKey,
  right: QueuedRunDispatchKey,
): number {
  // Ahead of the wake class: dispatching a run whose issue is not
  // dependency-ready burns a slot on work that cannot proceed, and no class is
  // urgent enough to be worth that.
  if (left.dependencyNotReady !== right.dependencyNotReady)
    return left.dependencyNotReady ? 1 : -1;
  if (left.effectiveWakeClassRank !== right.effectiveWakeClassRank)
    return left.effectiveWakeClassRank - right.effectiveWakeClassRank;
  if (left.readinessRank !== right.readinessRank)
    return left.readinessRank - right.readinessRank;
  if (left.priorityRank !== right.priorityRank)
    return left.priorityRank - right.priorityRank;
  const leftOrderingTime = queuedRunDispatchOrderingTimeMs(left);
  const rightOrderingTime = queuedRunDispatchOrderingTimeMs(right);
  if (leftOrderingTime !== rightOrderingTime)
    return leftOrderingTime - rightOrderingTime;
  // Effective times tie only when a blocking run is exactly the head start
  // newer than a non-blocking one. Falling back to the real enqueue time makes
  // the older run win, which is what makes the bound closed: a run that has
  // waited the full head start can no longer be overtaken.
  if (left.createdAtMs !== right.createdAtMs)
    return left.createdAtMs - right.createdAtMs;
  // Runs enqueued in the same millisecond still need a deterministic order, so
  // the comparator does not depend on Array#sort stability.
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

export function sortQueuedRunDispatchKeys(
  keys: readonly QueuedRunDispatchKey[],
): QueuedRunDispatchKey[] {
  return [...keys].sort(compareQueuedRunDispatchKeys);
}
