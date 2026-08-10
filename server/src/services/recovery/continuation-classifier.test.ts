import { describe, expect, it } from "vitest";
import {
  classifyContinuationFailure,
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
