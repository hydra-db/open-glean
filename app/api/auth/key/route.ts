/**
 * /api/auth/key — the ONLY place a key enters the system.
 *
 *   POST   { hydraKey?, baseUrl?, llm?: { apiKey, baseUrl?, model? } }
 *          → verifies the Hydra key server-side (SDK listDatabases), stores it
 *            in the encrypted httpOnly session cookie, returns the database
 *            list (so the client can offer scope selection) — the key itself
 *            never appears in any response.
 *   GET    → { configured, hydraKeyMasked, baseUrl } (no secrets).
 *   DELETE → clears the session.
 */
import { NextRequest, NextResponse } from "next/server";
import { HydraDB } from "@/lib/hydra";
import { assertSafeLlmUrl } from "@/lib/llmServer";
import { clearSession, getSession, maskKey, setSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  hydraKey?: string;
  baseUrl?: string;
  llm?: { apiKey?: string; baseUrl?: string; model?: string };
}

function normalizeDatabases(body: unknown): string[] {
  const b = body as Record<string, unknown> | null;
  if (!b) return [];
  const root =
    b.data && typeof b.data === "object" ? (b.data as Record<string, unknown>) : b;
  const list =
    (Array.isArray(root.tenants) ? root.tenants : null) ??
    (Array.isArray(root.tenantIds) ? root.tenantIds : null) ??
    (Array.isArray(root.databases) ? root.databases : null) ??
    (Array.isArray(root.tenant_ids) ? root.tenant_ids : null) ??
    [];
  return (list as unknown[])
    .map((x) =>
      typeof x === "string"
        ? x
        : x && typeof x === "object"
          ? String(
              (x as Record<string, unknown>).tenant_id ??
                (x as Record<string, unknown>).tenantId ??
                (x as Record<string, unknown>).name ??
                "",
            )
          : "",
    )
    .filter(Boolean);
}

export async function POST(req: NextRequest) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hydraKey = body.hydraKey?.trim();
  const baseUrl = body.baseUrl?.trim() || undefined;
  const llm = body.llm;

  // Updating only the LLM config (no Hydra key in the request).
  //
  // Accepts a base-URL-only change. Requiring a key here meant the settings
  // page could not persist a new endpoint without re-pasting the key, so the
  // change went to localStorage, the UI said "saved", and answers kept going
  // to the old host.
  if (!hydraKey && (llm?.apiKey?.trim() || llm?.baseUrl?.trim() || llm?.model?.trim())) {
    const llmBaseUrl = llm.baseUrl?.trim() || undefined;
    // Reject a private/internal base URL before it is ever persisted. The
    // credential resolver validates again at fetch time (so an already-stored
    // cookie can't be replayed), but refusing it here gives a clean 400 and
    // keeps the SSRF guard from depending solely on the read path.
    if (llmBaseUrl) {
      try {
        assertSafeLlmUrl(llmBaseUrl);
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Invalid LLM base URL." },
          { status: 400 },
        );
      }
    }
    await setSession({
      // Only overwrite the key when one was supplied; a URL-only update must
      // leave the stored key alone rather than clearing it.
      ...(llm.apiKey?.trim() ? { llmKey: llm.apiKey.trim() } : {}),
      llmBaseUrl,
      ...(llm.model?.trim() ? { llmModel: llm.model.trim() } : {}),
    });
    return NextResponse.json({ ok: true, updated: "llm" });
  }

  if (!hydraKey) {
    return NextResponse.json({ error: "Missing hydraKey" }, { status: 400 });
  }

  // The LLM branch above validates its base URL. This one did not, so a caller
  // could point verification at any host — including the cloud metadata
  // endpoint — and read the response back through the error message below.
  // Same guard, same function, twenty lines apart.
  if (baseUrl) {
    try {
      assertSafeLlmUrl(baseUrl);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid Hydra base URL." },
        { status: 400 },
      );
    }
  }

  // Verify server-side against the real API before storing anything.
  try {
    const client = new HydraDB({ token: hydraKey, baseUrl });
    const res = (await client.listDatabases()) as unknown;
    const databases = normalizeDatabases(res);
    await setSession({
      hydraKey,
      hydraBaseUrl: baseUrl,
    });
    return NextResponse.json({ ok: true, databases });
  } catch (err) {
    // One generic message for every failure. Passing the upstream error
    // through told an unauthenticated caller the difference between "wrong
    // key", "rate limited" and "timeout", which is exactly the signal that
    // makes this route a free credential-testing oracle — run from the
    // server's IP, so Hydra's abuse detection sees us and not the attacker.
    // The detail stays server-side.
    console.error("[auth/key] verification failed:", err);
    return NextResponse.json(
      { error: "Could not verify that key." },
      { status: 401 },
    );
  }
}

export async function GET() {
  const session = await getSession();
  // A deployment-level HYDRA_API_KEY means no user key is needed at all — the
  // proxy already falls back to it. Report it here too, otherwise the connect
  // gate blocks a correctly-configured deployment forever.
  const envHydraKey = process.env.HYDRA_API_KEY?.trim();
  const envLlmKey = process.env.OPENROUTER_API_KEY?.trim();
  const hydraKey = session.hydraKey || envHydraKey;
  return NextResponse.json({
    configured: Boolean(hydraKey),
    /** True when the key came from the environment, not this session. */
    fromEnv: Boolean(!session.hydraKey && envHydraKey),
    // Only ever mask a key this session supplied. maskKey keeps the first 8
    // and last 4 characters, so masking the deployment key handed 12 real
    // characters of a shared secret to any unauthenticated caller. When the
    // key comes from the environment the UI needs `configured` and `fromEnv`,
    // not key material.
    hydraKeyMasked: session.hydraKey ? maskKey(session.hydraKey) : undefined,
    baseUrl: session.hydraBaseUrl ?? process.env.HYDRA_BASE_URL,
    llmConfigured: Boolean(session.llmKey || envLlmKey),
    llmModel: session.llmModel ?? process.env.OPEN_GLEAN_LLM_MODEL,
    llmBaseUrl:
      session.llmBaseUrl ?? process.env.OPEN_GLEAN_LLM_BASE_URL,
  });
}

export async function DELETE() {
  await clearSession();
  return NextResponse.json({ ok: true });
}