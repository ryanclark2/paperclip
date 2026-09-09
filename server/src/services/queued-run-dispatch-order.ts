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

export function buildQueuedRunDispatchKey(input: {
  runId: string;
  createdAtMs: number;
  issueId: string | null;
  issueStatus: string | null | undefined;
  issuePriority: string | null | undefined;
  isDependencyReady: boolean;
}): QueuedRunDispatchKey {
  const readinessRank = !input.issueId
    ? QUEUED_RUN_READINESS_RANK.noIssue
    : !input.isDependencyReady
      ? QUEUED_RUN_READINESS_RANK.dependencyNotReady
      : input.issueStatus === "in_progress"
        ? QUEUED_RUN_READINESS_RANK.inProgressAndReady
        : QUEUED_RUN_READINESS_RANK.ready;
  return {
    runId: input.runId,
    readinessRank,
    priorityRank: issueRunPriorityRank(input.issuePriority),
    createdAtMs: input.createdAtMs,
  };
}

/** The enqueue time the ordering uses. */
export function queuedRunDispatchOrderingTimeMs(
  key: QueuedRunDispatchKey,
): number {
  return key.createdAtMs;
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
  // Runs enqueued in the same millisecond still need a deterministic order, so
  // the comparator does not depend on Array#sort stability.
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

export function sortQueuedRunDispatchKeys(
  keys: readonly QueuedRunDispatchKey[],
): QueuedRunDispatchKey[] {
  return [...keys].sort(compareQueuedRunDispatchKeys);
}
