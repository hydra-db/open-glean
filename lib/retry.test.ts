import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffMs, fetchWithRetry, retryAfterMs } from "@/lib/retry";

const reply = (status: number, headers: Record<string, string> = {}) =>
  new Response("body", { status, headers });

function stubFetch(...replies: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = replies.shift();
    if (!next) throw new Error("fetch called more times than stubbed");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Tiny waits so the suite runs in milliseconds.
const fast = { baseMs: 1, maxMs: 5 };

describe("fetchWithRetry", () => {
  it("retries 503s and returns the eventual success", async () => {
    const fetchMock = stubFetch(reply(503), reply(503), reply(200));
    const res = await fetchWithRetry("https://llm.test", {}, fast);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 400, which would fail the same way again", async () => {
    const fetchMock = stubFetch(reply(400));
    const res = await fetchWithRetry("https://llm.test", {}, fast);
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 401 bad key", async () => {
    const fetchMock = stubFetch(reply(401));
    expect((await fetchWithRetry("https://llm.test", {}, fast)).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the last failure once retries run out", async () => {
    const fetchMock = stubFetch(reply(429), reply(429), reply(429));
    const res = await fetchWithRetry("https://llm.test", {}, fast);
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a network error", async () => {
    stubFetch(new TypeError("fetch failed"), reply(200));
    expect((await fetchWithRetry("https://llm.test", {}, fast)).status).toBe(200);
  });

  it("throws the network error once retries run out", async () => {
    stubFetch(new TypeError("fetch failed"), new TypeError("fetch failed"));
    await expect(
      fetchWithRetry("https://llm.test", {}, { ...fast, retries: 1 }),
    ).rejects.toThrow("fetch failed");
  });

  it("stops at once when aborted during the wait, sending no more requests", async () => {
    const fetchMock = stubFetch(reply(503), reply(200));
    const controller = new AbortController();
    const run = fetchWithRetry("https://llm.test", {}, {
      baseMs: 10_000,
      maxMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    await expect(run).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry after an abort that happens during the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = stubFetch(new DOMException("aborted", "AbortError"), reply(200));
    await expect(
      fetchWithRetry("https://llm.test", {}, { ...fast, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("backoffMs", () => {
  it("doubles each attempt within ±20% jitter, and caps", () => {
    for (let i = 0; i < 50; i++) {
      const first = backoffMs(0, 500, 8000);
      const third = backoffMs(2, 500, 8000);
      expect(first).toBeGreaterThanOrEqual(400);
      expect(first).toBeLessThanOrEqual(600);
      expect(third).toBeGreaterThanOrEqual(1600);
      expect(third).toBeLessThanOrEqual(2400);
      expect(backoffMs(10, 500, 8000)).toBeLessThanOrEqual(9600);
    }
  });
});

describe("retryAfterMs", () => {
  it("reads Retry-After seconds and caps them", () => {
    expect(retryAfterMs(reply(429, { "retry-after": "2" }), 8000)).toBe(2000);
    expect(retryAfterMs(reply(429, { "retry-after": "60" }), 8000)).toBe(8000);
  });

  it("ignores a missing or invalid header", () => {
    expect(retryAfterMs(reply(429), 8000)).toBeUndefined();
    expect(retryAfterMs(reply(429, { "retry-after": "soon" }), 8000)).toBeUndefined();
  });
});
