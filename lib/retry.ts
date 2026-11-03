/**
 * fetch with retries and exponential backoff, for LLM provider calls.
 *
 * Providers return 429 when rate-limited and 5xx when overloaded, and both
 * usually clear within a second or two. Without a retry, one of those failed
 * the whole answer, or one step of a Deep Research run.
 *
 * Only failures that are likely temporary are retried: 408, 429, 5xx and
 * network errors. Anything else (400 bad request, 401 bad key, 404 unknown
 * model) is returned as-is, since sending it again would fail the same way.
 *
 * Safe for streaming: the status arrives before the body, so a retry only ever
 * happens before any answer text has been read. Once a good response is
 * returned this helper is done, and a failure mid-stream is never retried.
 *
 * Cancellation wins: if the signal aborts (Stop, tab closed, deadline), a
 * pending wait ends at once and no further request is sent.
 */

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries?: number;
  /** First wait in ms; doubles on each attempt. */
  baseMs?: number;
  /** Longest single wait in ms. */
  maxMs?: number;
  signal?: AbortSignal;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { retries = 2, baseMs = 500, maxMs = 8_000, signal }: RetryOptions = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      // An abort is deliberate: stop rather than retry.
      if (signal?.aborted || attempt >= retries) throw err;
      await sleep(backoffMs(attempt, baseMs, maxMs), signal);
      continue;
    }

    if (!RETRYABLE.has(res.status) || attempt >= retries) return res;

    // This body is never read; release the connection before waiting.
    await res.body?.cancel().catch(() => {});
    await sleep(retryAfterMs(res, maxMs) ?? backoffMs(attempt, baseMs, maxMs), signal);
  }
}

/** base × 2^attempt, capped, with ±20% jitter so clients don't retry in step. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

/** The provider's `Retry-After` (seconds or an HTTP date), capped at maxMs. */
export function retryAfterMs(res: Response, maxMs: number): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  return ms > 0 ? Math.min(ms, maxMs) : undefined;
}

/** setTimeout that rejects early with the abort reason if the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
