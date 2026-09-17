/**
 * Error translation.
 *
 * Two defects, one of them security-relevant:
 *
 *  - Abort was checked AFTER the status branch, so a cancelled request that
 *    also carried a status was reported as a server error rather than the
 *    cancellation the user asked for.
 *  - The fallback message was JSON.stringify of the whole upstream body.
 *    Error responses often echo the request, so a submitted API key could end
 *    up in a message shown to the client.
 */
import { describe, expect, it } from "vitest";
import { responseError, translateError } from "./errors";

describe("responseError", () => {
  it("uses a string detail when the upstream gives one", () => {
    expect(responseError(404, { detail: "Not found" }).message).toBe("Not found");
  });

  it("accepts message and error as alternatives", () => {
    expect(responseError(400, { message: "Bad input" }).message).toBe("Bad input");
    expect(responseError(400, { error: "Bad key" }).message).toBe("Bad key");
  });

  it("never serializes the upstream body into the message", () => {
    // The regression: an error echoing the request must not leak the key.
    const body = { request: { headers: { authorization: "Bearer sk_live_SECRET" } } };
    const message = responseError(401, body).message;
    expect(message).not.toContain("sk_live_SECRET");
    expect(message).not.toContain("authorization");
    expect(message).toContain("401");
  });

  it("handles a null or undefined body", () => {
    expect(responseError(500, null).message).toContain("500");
    expect(responseError(500, undefined).message).toContain("500");
  });
});

describe("translateError", () => {
  it("reports an abort as a timeout even when it carries a status", () => {
    const err = Object.assign(new Error("aborted"), {
      name: "AbortError",
      status: 500,
    });
    expect(translateError("/query", err).code).toBe("HYDRA_TIMEOUT");
  });

  it("recognises ABORT_ERR by code", () => {
    const err = Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    expect(translateError("/query", err).code).toBe("HYDRA_TIMEOUT");
  });

  it("still reports a genuine HTTP failure as one", () => {
    const err = Object.assign(new Error("nope"), { status: 503 });
    expect(translateError("/query", err).code).toBe("HYDRA_HTTP_ERROR");
  });

  it("passes an already-translated error through unchanged", () => {
    const original = responseError(404, { detail: "Missing" });
    expect(translateError("/query", original)).toBe(original);
  });

  it("falls back for an unrecognised error", () => {
    expect(translateError("/query", new Error("boom")).code).toBe("HYDRA_ERROR");
  });
});
