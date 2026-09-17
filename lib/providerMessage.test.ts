/**
 * Readable messages from LLM provider errors.
 *
 * Asking for a model that does not exist put this on screen:
 *
 *   LLM provider error (400): {"error":{"message":"totally/not-a-real-model-xyz
 *   is not a valid model ID","code":400},"user_id":"user_3Cqm0nzUh1t7DPnrE.."}
 *
 * Two problems. The user needed one sentence and got an envelope, and the
 * envelope carried the account's user_id, which is not theirs to see.
 *
 * The extraction is duplicated here because the route is a server module the
 * test runner cannot import. The shape is stable and the assertions are the
 * point.
 */
import { describe, expect, it } from "vitest";

function providerMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = parsed.error;
    if (typeof err === "string" && err.trim()) return err.trim();
    if (err && typeof err === "object") {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === "string" && m.trim()) return m.trim();
    }
    const m = parsed.message;
    if (typeof m === "string" && m.trim()) return m.trim();
  } catch {
    // Not JSON.
  }
  return `The model provider rejected the request (${status}).`;
}

/** The exact body that was rendered to the user. */
const REAL =
  '{"error":{"message":"totally/not-a-real-model-xyz is not a valid model ID","code":400},"user_id":"user_3Cqm0nzUh1t7DPnrErKlBewS98a"}';

describe("providerMessage", () => {
  it("extracts the sentence the user needs", () => {
    expect(providerMessage(400, REAL)).toBe(
      "totally/not-a-real-model-xyz is not a valid model ID",
    );
  });

  it("does not leak the account id", () => {
    const out = providerMessage(400, REAL);
    expect(out).not.toContain("user_id");
    expect(out).not.toContain("user_3Cqm");
  });

  it("does not leak envelope structure", () => {
    const out = providerMessage(400, REAL);
    expect(out).not.toContain("{");
    expect(out).not.toContain('"code"');
  });

  it("accepts a top-level string error", () => {
    expect(providerMessage(429, '{"error":"rate limited"}')).toBe("rate limited");
  });

  it("accepts a top-level message", () => {
    expect(providerMessage(500, '{"message":"upstream exploded"}')).toBe(
      "upstream exploded",
    );
  });

  it("falls back when the body is not JSON", () => {
    expect(providerMessage(502, "<html>Bad Gateway</html>")).toBe(
      "The model provider rejected the request (502).",
    );
  });

  it("falls back on an empty body", () => {
    expect(providerMessage(503, "")).toBe(
      "The model provider rejected the request (503).",
    );
  });
});
