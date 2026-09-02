import { describe, expect, it } from "vitest";
import {
  classifyContinuationFailure,
  decideFleetAuthOutage,
  FLEET_GATED_CONTINUATION_ERROR_CODES,
  type ContinuationRetryClassification,
} from "./service.js";

function makeRun(errorCode: string | null | undefined, status = "failed"): any {
  return {
    id: "run-1",
    agentId: "agent-1",
    status,
    error: null,
    errorCode: errorCode ?? null,
    contextSnapshot: {},
    livenessState: null,
  };
}

describe("classifyContinuationFailure", () => {
  // ── fleet_gated ──────────────────────────────────────────────────────────
  describe("fleet_gated codes", () => {
    it("classifies claude_auth_required as fleet_gated", () => {
      const result = classifyContinuationFailure(makeRun("claude_auth_required"));
      expect(result.kind).toBe("fleet_gated");
      expect(result.errorCode).toBe("claude_auth_required");
      // maxAttempts must be 0 so the per-issue attempt counter is never incremented.
      expect(result.maxAttempts).toBe(0);
    });

    it("classifies acpx_auth_required as fleet_gated", () => {
      const result = classifyContinuationFailure(makeRun("acpx_auth_required"));
      expect(result.kind).toBe("fleet_gated");
      expect(result.errorCode).toBe("acpx_auth_required");
      expect(result.maxAttempts).toBe(0);
    });

    // ALM-6012: a pi_local credential/entitlement 403 must NOT park or reassign the issue.
    // The "covers every code in the set" loop below cannot pin this — it is satisfied by any
    // superset, so removing pi_auth_required would leave it green. This names the code.
    it("classifies pi_auth_required as fleet_gated", () => {
      const result = classifyContinuationFailure(makeRun("pi_auth_required"));
      expect(result.kind).toBe("fleet_gated");
      expect(result.errorCode).toBe("pi_auth_required");
      expect(result.maxAttempts).toBe(0);
    });

    it("covers every code in FLEET_GATED_CONTINUATION_ERROR_CODES", () => {
      for (const code of FLEET_GATED_CONTINUATION_ERROR_CODES) {
        const result = classifyContinuationFailure(makeRun(code));
        expect(result.kind, `expected fleet_gated for ${code}`).toBe("fleet_gated");
      }
    });
  });

  // ── non_retryable ────────────────────────────────────────────────────────
  describe("non_retryable codes", () => {
    it.each([
      "agent_not_invokable",
      "agent_not_found",
      "budget_blocked",
      "budget_exhausted",
      "issue_paused",
      "issue_dependencies_blocked",
    ])("classifies %s as non_retryable", (code) => {
      const result = classifyContinuationFailure(makeRun(code));
      expect(result.kind).toBe("non_retryable");
      expect(result.maxAttempts).toBe(0);
    });
  });

  // ── transient_infra ──────────────────────────────────────────────────────
  describe("transient_infra codes", () => {
    it.each([
      "adapter_failed",
      "codex_transient_upstream",
      "claude_transient_upstream",
      "timeout",
    ])("classifies %s as transient_infra with retry budget", (code) => {
      const result = classifyContinuationFailure(makeRun(code));
      expect(result.kind).toBe("transient_infra");
      expect(result.maxAttempts).toBeGreaterThan(1);
      expect(result.baseBackoffMs).toBeGreaterThan(0);
    });
  });

  // ── default ──────────────────────────────────────────────────────────────
  describe("default (unrecognised codes)", () => {
    it("classifies an unknown error code as default with maxAttempts=1", () => {
      const result = classifyContinuationFailure(makeRun("some_unknown_error"));
      expect(result.kind).toBe("default");
      expect(result.maxAttempts).toBe(1);
    });

    it("classifies a null error code as default", () => {
      const result = classifyContinuationFailure(makeRun(null));
      expect(result.kind).toBe("default");
    });

    it("classifies a run with no errorCode field as default", () => {
      const result = classifyContinuationFailure(makeRun(undefined));
      expect(result.kind).toBe("default");
    });
  });

  // ── priority: fleet_gated must NOT fall through to default ───────────────
  describe("priority ordering (negative fixtures)", () => {
    it("does NOT classify claude_auth_required as default", () => {
      const result = classifyContinuationFailure(makeRun("claude_auth_required"));
      expect(result.kind).not.toBe("default");
    });

    it("does NOT classify claude_auth_required as non_retryable", () => {
      const result = classifyContinuationFailure(makeRun("claude_auth_required"));
      expect(result.kind).not.toBe("non_retryable");
    });

    it("does NOT classify claude_auth_required as transient_infra", () => {
      const result = classifyContinuationFailure(makeRun("claude_auth_required"));
      expect(result.kind).not.toBe("transient_infra");
    });

    it("does NOT classify a genuine transient error as fleet_gated", () => {
      const result = classifyContinuationFailure(makeRun("claude_transient_upstream"));
      expect(result.kind).not.toBe("fleet_gated");
    });
  });
});

// ── decideFleetAuthOutage (ADR-004 call-site gate) ───────────────────────────
// These are the negative and positive fixtures that prove the gate which decides
// parking/escalation — not just the classifier that labels the error code.

type RunSummary = { status: string; errorCode: string | null };

describe("decideFleetAuthOutage", () => {
  const CODE = "claude_auth_required";

  it("returns false when no recent runs exist (>2h outage, no fleet signal)", () => {
    expect(decideFleetAuthOutage([], CODE)).toBe(false);
  });

  // NEGATIVE FIXTURE (ADR-004): one healthy sibling run → fleet is not in outage.
  // Post-patch, this path must escalate (not enqueue unboundedly).
  it("returns false when any sibling succeeded — fleet healthy, per-agent credential issue", () => {
    const runs: RunSummary[] = [
      { status: "succeeded", errorCode: null },
      { status: "failed", errorCode: CODE },
    ];
    expect(decideFleetAuthOutage(runs, CODE)).toBe(false);
  });

  it("returns false when runs failed with a different error (not an auth outage)", () => {
    const runs: RunSummary[] = [
      { status: "failed", errorCode: "adapter_failed" },
      { status: "failed", errorCode: "timeout" },
    ];
    expect(decideFleetAuthOutage(runs, CODE)).toBe(false);
  });

  // POSITIVE FIXTURE: all runs failed with the auth error → outage.
  it("returns true when all runs failed and at least one carried the auth error", () => {
    const runs: RunSummary[] = [
      { status: "failed", errorCode: CODE },
      { status: "failed", errorCode: CODE },
    ];
    expect(decideFleetAuthOutage(runs, CODE)).toBe(true);
  });

  it("returns true with mixed auth-error and generic failures (no successes)", () => {
    const runs: RunSummary[] = [
      { status: "failed", errorCode: CODE },
      { status: "timed_out", errorCode: null },
    ];
    expect(decideFleetAuthOutage(runs, CODE)).toBe(true);
  });

  it("is error-code-specific: acpx_auth_required does not satisfy claude_auth_required gate", () => {
    const runs: RunSummary[] = [
      { status: "failed", errorCode: "acpx_auth_required" },
    ];
    expect(decideFleetAuthOutage(runs, CODE)).toBe(false);
  });
});
