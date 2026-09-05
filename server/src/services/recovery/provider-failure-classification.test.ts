import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  withAdapterFailureRecoveryClassification,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("classifies the qualifier-less limit wording and parses the 'resets' clock", () => {
    // Current Claude CLI phrasing, as recorded on the run by the adapter.
    const now = new Date("2026-08-28T22:30:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Claude run failed: subtype=success: You've hit your limit · resets 2:30am (UTC)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-29T02:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("prefers a live persisted stamp whose writer attested a real parse", () => {
    const now = new Date("2026-09-04T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your weekly limit · resets Sep 9 at 9am",
      resultJson: {
        transientRetryNotBefore: "2026-09-09T16:00:00.000Z",
        transientRetryResetTimeParsed: true,
      },
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-09T16:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("lets a fresh clock parse beat a live stamp that carries no parse attestation", () => {
    const now = new Date("2026-09-04T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: {
        // A synthetic default-backoff stamp persisted by an earlier pass.
        providerQuotaRetryNotBefore: "2026-09-04T20:30:00.000Z",
        transientRetryResetTimeParsed: false,
      },
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-04T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("keeps an unproven sticky stamp but never reports it as parsed", () => {
    // Before ALM-7596 B1-r2 this branch returned parsedResetTime: true,
    // laundering the synthetic default-backoff stamp into a vendor promise
    // on every pass while it was live.
    const now = new Date("2026-09-04T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "Provider quota exceeded for this model.",
      resultJson: {
        providerQuotaRetryNotBefore: "2026-09-04T20:30:00.000Z",
        transientRetryResetTimeParsed: false,
      },
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-04T20:30:00.000Z"),
      parsedResetTime: false,
    });
  });

  it("treats a live stamp whose row has no attestation key at all as unproven (legacy rows)", () => {
    // The absent state is the day-one input class: every heartbeat_runs row
    // written before the attestation flag existed carries the scheduler keys
    // with no transientRetryResetTimeParsed key at all. Absent must read
    // exactly like attested-false — keep the stamp for cadence, never claim
    // a parse. Weakening the gate at the persisted-stamp read from
    // `=== true` to `!== false` flips this row to parsedResetTime: true and
    // re-persists both scheduler keys plus a true attestation, re-opening
    // the laundering chain for the whole legacy DB (ALM-7699 B1-r3).
    const now = new Date("2026-09-04T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "Provider quota exceeded for this model.",
      resultJson: {
        retryNotBefore: "2026-09-09T16:00:00.000Z",
        transientRetryNotBefore: "2026-09-09T16:00:00.000Z",
      },
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-09T16:00:00.000Z"),
      parsedResetTime: false,
    });
  });

  it("selects the scheduler stamp over a recovery-lane stamp at a different instant", () => {
    // The persisted-stamp chain is first-non-empty over three keys. Only the
    // last one — providerQuotaRetryNotBefore — is written by the unproven
    // branch alone and re-minted every recovery pass, so a row really can
    // carry a scheduler key and a recovery-lane key at different instants,
    // and which one wins decides whether the monitor honours a vendor
    // promise or the lane's own cadence. Without this fixture, moving the
    // last key to the front was 72/72 green at `b7a9161ca`
    // (ALM-7805 R-D; ADR-004 Amendment 6).
    const now = new Date("2026-09-04T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "Provider quota exceeded for this model.",
      resultJson: {
        retryNotBefore: "2026-09-09T16:00:00.000Z",
        transientRetryNotBefore: "2026-09-09T16:00:00.000Z",
        providerQuotaRetryNotBefore: "2026-09-04T21:00:00.000Z",
        transientRetryResetTimeParsed: true,
      },
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-09T16:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("selects the transient stamp over a recovery-lane stamp at a different instant", () => {
    // Same selector, second slot: pins the recovery-lane key behind
    // transientRetryNotBefore as well, so no single-key promotion passes.
    // The order WITHIN the two scheduler keys is not pinned and is not
    // worth pinning — every producer co-writes them to one instant, so
    // swapping them is an equivalent mutant.
    const now = new Date("2026-09-04T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "Provider quota exceeded for this model.",
      resultJson: {
        transientRetryNotBefore: "2026-09-08T16:00:00.000Z",
        providerQuotaRetryNotBefore: "2026-09-04T21:00:00.000Z",
        transientRetryResetTimeParsed: true,
      },
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-08T16:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("does not accept a truthy non-boolean attestation as a real parse", () => {
    // The attestation read is `=== true`. Relaxing it to Boolean(...) was
    // 72/72 green at `b7a9161ca` because no producer emits a truthy
    // non-boolean —
    // but every non-empty string is truthy, so the relaxed read would
    // attest a stamp carrying the literal "false" just as readily
    // (ALM-7805 R-B).
    const now = new Date("2026-09-04T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "Provider quota exceeded for this model.",
      resultJson: {
        retryNotBefore: "2026-09-09T16:00:00.000Z",
        transientRetryNotBefore: "2026-09-09T16:00:00.000Z",
        transientRetryResetTimeParsed: "true",
      },
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-09T16:00:00.000Z"),
      parsedResetTime: false,
    });
  });

  it("treats a stamp at exactly now as lapsed, not live", () => {
    // The liveness test is strictly `> now`. Relaxing it to `>= now` was
    // 72/72 green at `b7a9161ca` and returns retryAt === now with parsedResetTime
    // true — a zero-delay monitor pass on a wall that has not moved. The
    // heartbeat-side twin of this boundary is already pinned; this is the
    // classifier side (ALM-7805 R-E).
    const now = new Date("2026-09-04T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "Provider quota exceeded for this model.",
      resultJson: {
        retryNotBefore: "2026-09-04T20:00:00.000Z",
        transientRetryNotBefore: "2026-09-04T20:00:00.000Z",
        transientRetryResetTimeParsed: true,
      },
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
});

describe("withAdapterFailureRecoveryClassification", () => {
  // The single point where a classification fans out into persisted keys.
  // Which keys the unproven branch writes is the contract the bounded-retry
  // scheduler's attestation gate depends on, so it is pinned here directly
  // rather than only through the classifier (ALM-7699 B1-r3 split-write pin).
  function failedQuotaRun() {
    return {
      id: "run-under-classification",
      agentId: "agent-under-classification",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "provider_quota",
      contextSnapshot: null,
      livenessState: null,
      startedAt: new Date("2026-09-04T19:00:00.000Z"),
      createdAt: new Date("2026-09-04T19:00:00.000Z"),
      resultJson: null,
    };
  }

  it("fans a proven parse out into both scheduler keys with a true attestation", () => {
    const classified = withAdapterFailureRecoveryClassification(failedQuotaRun(), {
      kind: "provider_quota",
      retryAt: new Date("2026-09-09T16:00:00.000Z"),
      parsedResetTime: true,
    });

    expect(classified.errorCode).toBe("provider_quota");
    expect(classified.resultJson).toEqual({
      errorFamily: "provider_quota",
      retryNotBefore: "2026-09-09T16:00:00.000Z",
      transientRetryNotBefore: "2026-09-09T16:00:00.000Z",
      transientRetryResetTimeParsed: true,
      providerQuotaRetryNotBefore: "2026-09-09T16:00:00.000Z",
      recoveryClassification: "provider_quota",
    });
  });

  it("keeps an unproven classification out of both scheduler keys, each pinned independently", () => {
    const classified = withAdapterFailureRecoveryClassification(failedQuotaRun(), {
      kind: "provider_quota",
      retryAt: new Date("2026-09-04T21:00:00.000Z"),
      parsedResetTime: false,
    });

    // Two separate absence assertions on purpose: re-adding either scheduler
    // key alone to the unproven branch must fail on its own line, so each
    // key's guard is load-bearing rather than redundant with the other's.
    expect(classified.resultJson).not.toHaveProperty("retryNotBefore");
    expect(classified.resultJson).not.toHaveProperty("transientRetryNotBefore");
    expect(classified.errorCode).toBe("provider_quota");
    expect(classified.resultJson).toEqual({
      errorFamily: "provider_quota",
      transientRetryResetTimeParsed: false,
      providerQuotaRetryNotBefore: "2026-09-04T21:00:00.000Z",
      recoveryClassification: "provider_quota",
    });
  });
});
