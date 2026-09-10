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

/** Ordering keys for one queued run, precomputed so the comparator stays pure. */
export interface QueuedRunDispatchKey {
  runId: string;
  readinessRank: number;
  priorityRank: number;
  createdAtMs: number;
  /** The run's issue blocks at least one issue that is still open work. */
  blocksOpenWork: boolean;
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

export function buildQueuedRunDispatchKey(input: {
  runId: string;
  createdAtMs: number;
  issueId: string | null;
  issueStatus: string | null | undefined;
  issuePriority: string | null | undefined;
  isDependencyReady: boolean;
  issueIdsBlockingOpenWork: ReadonlySet<string>;
}): QueuedRunDispatchKey {
  const readinessRank = queuedRunReadinessRank(input);
  return {
    runId: input.runId,
    readinessRank,
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
