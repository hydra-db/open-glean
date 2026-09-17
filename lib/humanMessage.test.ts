/**
 * Human error messages from SDK envelopes.
 *
 * Found by looking at the rendered page rather than the code: the Context page
 * showed "Status code: 401 Body: { "success": false, ... "request_id": ...,
 * "api_version": "2.0.1", "latency_ms": 0 ... }" where the user needed "your
 * API key is not valid".
 *
 * The SDK stringifies the whole upstream envelope into Error.message, and the
 * proxy passed that through verbatim. The extraction below is duplicated from
 * app/api/hydra/[...path]/route.ts, which is a server module the test runner
 * cannot import; the shape is stable and the assertions are what matter.
 */
import { describe, expect, it } from "vitest";

function humanMessage(err: unknown): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : "";
  const statusMatch = /Status code:\s*(\d{3})/.exec(raw);
  const status = statusMatch ? Number(statusMatch[1]) : 502;

  const bodyStart = raw.indexOf("{");
  if (bodyStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(bodyStart)) as Record<string, unknown>;
      for (const key of ["error", "detail", "message"]) {
        const v = body[key];
        if (typeof v === "string" && v.trim()) return { message: v.trim(), status };
        if (v && typeof v === "object") {
          const nested = (v as Record<string, unknown>).message;
          if (typeof nested === "string" && nested.trim()) {
            return { message: nested.trim(), status };
          }
        }
      }
    } catch {
      // Not JSON after all.
    }
  }

  const firstLine = raw.split("\n")[0]?.trim();
  return {
    message: firstLine && !firstLine.includes("{") ? firstLine : "Hydra request failed.",
    status,
  };
}

/** The exact string the SDK produced on screen. */
const REAL = `Status code: 401
Body: {
  "success": false,
  "data": null,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "malformed API key"
  },
  "meta": {
    "request_id": "ffd02e4d-2dcb-48cd-ac60-c8f6a8b6c64b",
    "api_version": "2.0.1",
    "latency_ms": 0
  }
}`;

describe("humanMessage", () => {
  it("extracts the sentence a user needs from the real envelope", () => {
    const out = humanMessage(new Error(REAL));
    expect(out.message).toBe("malformed API key");
    expect(out.status).toBe(401);
  });

  it("never leaks envelope noise to the user", () => {
    const { message } = humanMessage(new Error(REAL));
    for (const noise of ["request_id", "api_version", "latency_ms", "success"]) {
      expect(message).not.toContain(noise);
    }
  });

  it("passes the upstream status through instead of flattening to 502", () => {
    // A 401 rendered as a 502 told the user the server was broken when their
    // key was simply wrong.
    expect(humanMessage(new Error("Status code: 404\nBody: {}")).status).toBe(404);
  });

  it("accepts a top-level string error", () => {
    const e = new Error('Status code: 400\nBody: {"error":"bad request"}');
    expect(humanMessage(e).message).toBe("bad request");
  });

  it("falls back to the first line when the body is not JSON", () => {
    expect(humanMessage(new Error("Network unreachable")).message).toBe(
      "Network unreachable",
    );
  });

  it("never returns a brace-laden fallback", () => {
    const { message } = humanMessage(new Error('{"unparseable'));
    expect(message).toBe("Hydra request failed.");
  });

  it("handles a non-Error throw", () => {
    expect(humanMessage("just a string").message).toBe("Hydra request failed.");
  });
});
