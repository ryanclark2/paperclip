import { describe, expect, it } from "vitest";
import { detectPiAuthRequired, parsePiJsonl, isPiUnknownSessionError } from "./parse.js";

describe("parsePiJsonl", () => {
  it("parses agent lifecycle and messages", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from Pi" }],
        },
      }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.messages).toContain("Hello from Pi");
    expect(parsed.finalMessage).toBe("Hello from Pi");
  });

  it("parses streaming text deltas", () => {
    const stdout = [
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello " },
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "World" },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Hello World",
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.messages).toContain("Hello World");
  });

  it("parses tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/tmp/test.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "file contents",
        isError: false,
      }),
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "Done" },
        toolResults: [
          {
            toolCallId: "tool_1",
            content: "file contents",
            isError: false,
          },
        ],
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].toolName).toBe("read");
    expect(parsed.toolCalls[0].result).toBe("file contents");
    expect(parsed.toolCalls[0].isError).toBe(false);
  });

  it("handles errors in tool execution", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "/missing.txt" },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "File not found",
        isError: true,
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].isError).toBe(true);
    expect(parsed.toolCalls[0].result).toBe("File not found");
  });

  it("extracts usage and cost from turn_end events", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Response with usage",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 20,
            totalTokens: 170,
            cost: {
              input: 0.001,
              output: 0.0015,
              cacheRead: 0.0001,
              cacheWrite: 0,
              total: 0.0026,
            },
          },
        },
        toolResults: [],
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.outputTokens).toBe(50);
    expect(parsed.usage.cachedInputTokens).toBe(20);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0026, 4);
  });

  it("accumulates usage from multiple turns", () => {
    const stdout = [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "First response",
          usage: {
            input: 50,
            output: 25,
            cacheRead: 0,
            cost: { total: 0.001 },
          },
        },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: "Second response",
          usage: {
            input: 30,
            output: 20,
            cacheRead: 10,
            cost: { total: 0.0015 },
          },
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(80);
    expect(parsed.usage.outputTokens).toBe(45);
    expect(parsed.usage.cachedInputTokens).toBe(10);
    expect(parsed.usage.costUsd).toBeCloseTo(0.0025, 4);
  });

  it("handles standalone usage events with Pi format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          input: 200,
          output: 100,
          cacheRead: 50,
          cost: { total: 0.005 },
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(200);
    expect(parsed.usage.outputTokens).toBe(100);
    expect(parsed.usage.cachedInputTokens).toBe(50);
    expect(parsed.usage.costUsd).toBe(0.005);
  });

  it("handles standalone usage events with generic format", () => {
    const stdout = [
      JSON.stringify({
        type: "usage",
        usage: {
          inputTokens: 150,
          outputTokens: 75,
          cachedInputTokens: 25,
          costUsd: 0.003,
        },
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(150);
    expect(parsed.usage.outputTokens).toBe(75);
    expect(parsed.usage.cachedInputTokens).toBe(25);
    expect(parsed.usage.costUsd).toBe(0.003);
  });

  it("surfaces failed auto-retry exhaustion as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual(["Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"]);
  });

  it("does not treat successful auto-retry as an error", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_retry_end",
        success: true,
        attempt: 2,
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });

  it("surfaces standalone error events", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "Connection to model provider lost",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual(["Connection to model provider lost"]);
  });

  it("ignores error events with empty messages", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "",
      }),
    ].join("\n");

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual([]);
  });
});

describe("isPiUnknownSessionError", () => {
  it("detects unknown session errors", () => {
    expect(isPiUnknownSessionError("session not found: s_123", "")).toBe(true);
    expect(isPiUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isPiUnknownSessionError("", "no session available")).toBe(true);
    expect(isPiUnknownSessionError("all good", "")).toBe(false);
    expect(isPiUnknownSessionError("working fine", "no errors")).toBe(false);
  });
});

describe("parsePiJsonl provider-error reporting (ALM-6012)", () => {
  // Verbatim shape from GeminiEng run e6d3b6db-b759-4164-b68d-697b2df30523: the Gemini
  // Code Assist credential lost its entitlement, pi reported the failure on the assistant
  // message, and still exited 0.
  const LICENSE_403 =
    "Cloud Code Assist API error (403): You do not have a valid license of this product. " +
    "Please contact your administrator to request a license. (#3501)";

  const turnEndError = (errorMessage: string | undefined) =>
    JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        ...(errorMessage === undefined ? {} : { errorMessage }),
        stopReason: "error",
      },
    });

  it("reports a turn_end stopReason=error as a parse error", () => {
    const parsed = parsePiJsonl(turnEndError(LICENSE_403));
    expect(parsed.errors).toEqual([LICENSE_403]);
  });

  it("reports an agent_end stopReason=error when no turn_end carried it", () => {
    const stdout = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "wake payload" }] },
        { role: "assistant", content: [], stopReason: "error", errorMessage: LICENSE_403 },
      ],
    });

    const parsed = parsePiJsonl(stdout);
    expect(parsed.errors).toEqual([LICENSE_403]);
  });

  it("does not double-report when turn_end and agent_end carry the same failure", () => {
    const stdout = [
      turnEndError(LICENSE_403),
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: LICENSE_403 }],
      }),
    ].join("\n");

    expect(parsePiJsonl(stdout).errors).toEqual([LICENSE_403]);
  });

  it("still reports an error when stopReason=error carries no errorMessage", () => {
    const parsed = parsePiJsonl(turnEndError(undefined));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatch(/stopReason=error/);
  });

  // Control: a healthy turn must stay clean, or every successful pi run would fail.
  it("reports no error for a normal completed turn", () => {
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
      }),
      JSON.stringify({ type: "agent_end", messages: [] }),
    ].join("\n");

    expect(parsePiJsonl(stdout).errors).toEqual([]);
  });
});

describe("detectPiAuthRequired", () => {
  const LICENSE_403 =
    "Cloud Code Assist API error (403): You do not have a valid license of this product. " +
    "Please contact your administrator to request a license. (#3501)";

  it("flags the Cloud Code Assist entitlement 403", () => {
    expect(detectPiAuthRequired({ errors: [LICENSE_403], stderr: "" }).requiresAuth).toBe(true);
  });

  it("flags a stderr credential failure", () => {
    expect(
      detectPiAuthRequired({ errors: [], stderr: "Error: 401 Unauthorized — please re-authenticate" })
        .requiresAuth,
    ).toBe(true);
  });

  it("does not flag an ordinary tool failure", () => {
    expect(
      detectPiAuthRequired({ errors: ["ENOENT: no such file or directory, open '/tmp/x'"], stderr: "" })
        .requiresAuth,
    ).toBe(false);
  });

  it("does not flag a quota/rate-limit failure as an auth failure", () => {
    expect(
      detectPiAuthRequired({ errors: ["429 Too Many Requests: quota exceeded, retry in 60s"], stderr: "" })
        .requiresAuth,
    ).toBe(false);
  });
});
