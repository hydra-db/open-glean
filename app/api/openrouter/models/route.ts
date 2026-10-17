/**
 * GET /api/openrouter/models
 *
 * Returns the OpenRouter model directory so the settings page can offer a
 * model picker. Proxied so the browser never calls OpenRouter directly.
 * Response shape mirrors OpenRouter's /api/v1/models:
 * { data: [{ id, name, context_length, pricing, ... }, ...] }.
 *
 * The caller's key and base URL come in the x-llm-key and x-llm-base headers,
 * not the query string. A query string is written to server and proxy logs
 * and to browser history. The key is the one the user is typing in Settings,
 * which has not been stored yet — that is why this route accepts one at all.
 *
 * Key/host pairing lives in ./resolve and is tested there. A caller may pick
 * the host only when it also supplies its own key; a stored key stays pinned
 * to OpenRouter.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchWithRetry } from "@/lib/retry";
import { getSession } from "@/lib/session";
import { resolveModelSource } from "./resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let sessionKey: string | undefined;
  try {
    sessionKey = (await getSession()).llmKey;
  } catch {
    // No or undecryptable cookie — fall through to the env key.
  }

  let key: string;
  let base: string;
  try {
    ({ key, base } = resolveModelSource({
      callerKey: req.headers.get("x-llm-key") ?? undefined,
      callerBaseUrl: req.headers.get("x-llm-base") ?? undefined,
      sessionKey,
      envKey: process.env.OPENROUTER_API_KEY,
    }));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid base URL." },
      { status: 400 },
    );
  }

  try {
    // One retry is enough for a model list; the 12s budget covers both tries.
    const res = await fetchWithRetry(
      `${base}/models`,
      {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        cache: "no-store",
        // The base URL was validated, but a public host that 3xx-redirects could
        // otherwise carry the key to an unvalidated destination.
        redirect: "manual",
      },
      { retries: 1, signal: AbortSignal.timeout(12_000) },
    );
    if (res.status >= 300 && res.status < 400) {
      return NextResponse.json(
        { error: "Model endpoint attempted a redirect, which is not allowed." },
        { status: 502 },
      );
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: `OpenRouter model lookup failed (${res.status})` },
        { status: res.status },
      );
    }
    const text = await res.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "OpenRouter sent a non-JSON response." }, { status: 502 });
    }
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach OpenRouter." },
      { status: 502 },
    );
  }
}