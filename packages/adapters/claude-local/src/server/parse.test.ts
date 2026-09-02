import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
} from "./parse.js";

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});

// ALM-6309: the 2026-09-02 session-limit blackout retried every few seconds for
// 5h20m because neither phrase list contained "session limit", so no reset time
// was ever extracted from the message that printed one.
describe("ALM-6309 session-limit reset extraction", () => {
  const SESSION_LIMIT = "Claude run failed: subtype=success: You've hit your session limit · resets 2:50am (America/Los_Angeles)";
  const BARE_LIMIT = "Claude run failed: subtype=success: You've hit your limit · resets 9:50pm (America/Los_Angeles)";
  const USAGE_LIMIT = "Claude run failed: usage limit reached · resets 7:50am (America/Los_Angeles)";

  it("classifies all three observed quota variants as transient", () => {
    for (const message of [SESSION_LIMIT, BARE_LIMIT, USAGE_LIMIT]) {
      expect(isClaudeTransientUpstreamError({ errorMessage: message })).toBe(true);
    }
  });

  it("extracts the printed reset for 'hit your session limit'", () => {
    const now = new Date("2026-09-02T09:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore({ errorMessage: SESSION_LIMIT }, now);
    // 2:50am America/Los_Angeles (PDT, UTC-7) == 09:50Z, still ahead of `now`.
    expect(extracted?.toISOString()).toBe("2026-09-02T09:50:00.000Z");
  });

  it("extracts the printed reset for 'hit your limit'", () => {
    const now = new Date("2026-09-02T09:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore({ errorMessage: BARE_LIMIT }, now);
    expect(extracted?.toISOString()).toBe("2026-09-03T04:50:00.000Z");
  });

  it("extracts the printed reset for 'usage limit reached'", () => {
    const now = new Date("2026-09-02T09:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore({ errorMessage: USAGE_LIMIT }, now);
    expect(extracted?.toISOString()).toBe("2026-09-02T14:50:00.000Z");
  });

  it("prefers the machine-readable rate_limit_event resetsAt over the printed clock time", () => {
    // Verbatim shape from run 258c9b56-a73c-49bd-aea2-aaefff6e5233 stdout, with the
    // prose deliberately disagreeing so the assertion pins which source is used.
    // resetsAt 1788360600 == 2026-09-02T14:50:00Z; the prose alone would give 06:50Z.
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"50412f56"}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788360600,"rateLimitType":"five_hour","overageStatus":"rejected"}}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You\'ve hit your session limit · resets 11:50pm (America/Los_Angeles)"}',
    ].join("\n");
    const extracted = extractClaudeRetryNotBefore(
      { stdout, errorMessage: "Claude run failed: subtype=success: You've hit your session limit · resets 11:50pm (America/Los_Angeles)" },
      new Date("2026-09-02T14:32:00.000Z"),
    );
    expect(extracted?.toISOString()).toBe("2026-09-02T14:50:00.000Z");
  });

  it("extracts the reset from rate_limit_event alone when no reset prose is present", () => {
    const stdout = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788360600,"rateLimitType":"five_hour"}}',
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You\'ve hit your session limit"}',
    ].join("\n");
    const extracted = extractClaudeRetryNotBefore({ stdout }, new Date("2026-09-02T14:32:00.000Z"));
    expect(extracted?.toISOString()).toBe("2026-09-02T14:50:00.000Z");
  });

  it("ignores a rate_limit_event that was not a rejection", () => {
    const stdout =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788360600,"rateLimitType":"five_hour"}}';
    expect(
      extractClaudeRetryNotBefore({ stdout }, new Date("2026-09-02T14:32:00.000Z")),
    ).toBeNull();
  });
});
