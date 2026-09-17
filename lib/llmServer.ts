/**
 * Server-side LLM access.
 *
 * `/api/llm/chat` proxies a single browser-initiated completion; Deep Research
 * instead needs to make many completions of its own, server-side, inside one
 * request. Both need the same credential resolution, so it lives here.
 *
 * Resolution order mirrors the Hydra proxy: explicit override, then the
 * encrypted session cookie, then the deployment-level env var.
 */
import "server-only";
import { getSession } from "@/lib/session";
import { assertSafeLlmUrl } from "@/lib/safeUrl";

export const DEFAULT_LLM_BASE = "https://openrouter.ai/api/v1";

/** Generous: a long answer legitimately takes a while to stream. */
const LLM_TIMEOUT_MS = 120_000;

// Re-exported: the guard moved to lib/safeUrl.ts so non-server-only callers
// can use it. Existing importers of this module are unaffected.
export { assertSafeLlmUrl };

export interface LlmCreds {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Resolve the LLM key and its base URL **together**, from a single origin.
 *
 * The key and the URL must never come from different places. Resolving them
 * independently lets a request supply only `baseUrl` and inherit the stored
 * key, which would send `Authorization: Bearer <our key>` to a host the caller
 * chose — handing them the credential. So a request-supplied base URL is
 * honoured only when the request also brings its own key.
 *
 * Whichever origin wins, the resolved base URL is run through
 * `assertSafeLlmUrl` before it is returned — a URL persisted in the session (or
 * even one set in deployment env) is no more trustworthy at fetch time than one
 * handed in on the request, so validation lives at this single choke point that
 * every caller and every branch passes through, not only on the request path.
 *
 * `model` is exempt: it is a plain string in the request body and cannot
 * redirect where the key is sent.
 */
export async function resolveLlmCreds(override?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): Promise<LlmCreds | null> {
  const wantedModel = override?.model?.trim() ?? "";
  const callerKey = override?.apiKey?.trim() ?? "";

  // 1. Caller brought its own key — it may also choose the host it goes to,
  //    but only a non-private one: the server fetches this URL and can relay
  //    the response, so an unguarded host is an SSRF relay.
  if (callerKey) {
    const baseUrl = override?.baseUrl?.trim() || DEFAULT_LLM_BASE;
    const model =
      wantedModel || process.env.OPEN_GLEAN_LLM_MODEL?.trim() || "";
    return model ? { apiKey: callerKey, baseUrl: safeBase(baseUrl), model } : null;
  }

  // 2. Session key — pinned to the base URL stored with it. A `getSession()`
  //    failure (no/undecryptable cookie) falls through to env, but a *stored*
  //    URL that fails validation must surface as an error, not silently fall
  //    back — so `safeBase` is called outside the try/catch below.
  let session: Awaited<ReturnType<typeof getSession>> | null = null;
  try {
    session = await getSession();
  } catch {
    session = null;
  }
  const sessionKey = session?.llmKey?.trim();
  if (sessionKey) {
    const model =
      wantedModel ||
      session?.llmModel?.trim() ||
      process.env.OPEN_GLEAN_LLM_MODEL?.trim() ||
      "";
    if (!model) return null;
    return {
      apiKey: sessionKey,
      baseUrl: safeBase(session?.llmBaseUrl?.trim() || DEFAULT_LLM_BASE),
      model,
    };
  }

  // 3. Deployment key — pinned to the deployment's own base URL.
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!envKey) return null;
  const model =
    wantedModel || process.env.OPEN_GLEAN_LLM_MODEL?.trim() || "";
  if (!model) return null;
  return {
    apiKey: envKey,
    baseUrl: safeBase(
      process.env.OPEN_GLEAN_LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE,
    ),
    model,
  };
}

/** Validate a base URL as SSRF-safe, then strip trailing slashes. */
function safeBase(url: string): string {
  assertSafeLlmUrl(url);
  return normalizeBase(url);
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

async function chatCompletions(
  creds: LlmCreds,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  // A caller signal cancels on user abort; this adds a deadline so a provider
  // that accepts the connection and then stalls cannot hold the function open
  // indefinitely. Whichever fires first wins.
  const deadline = AbortSignal.timeout(LLM_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const res = await fetch(`${creds.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${creds.apiKey}`,
    },
    body: JSON.stringify({ model: creds.model, ...body }),
    signal: combined,
    // Do NOT follow redirects: the base URL was SSRF-validated, but a public
    // endpoint that 3xx-redirects /chat/completions to a private host would
    // otherwise be followed to that unvalidated destination. A completion
    // POST never legitimately redirects, so treat one as an error.
    redirect: "manual",
  });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new Error("LLM endpoint attempted a redirect, which is not allowed.");
  }
  return res;
}

/** One non-streaming completion. Returns the assistant text. */
export async function complete(
  creds: LlmCreds,
  messages: LlmMessage[],
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const res = await chatCompletions(
    creds,
    {
      messages,
      stream: false,
      temperature: opts.temperature ?? 0.2,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    },
    opts.signal,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

/**
 * Stream a completion, invoking `onDelta` per token chunk.
 *
 * Parses SSE framing itself (rather than reusing /api/llm/chat) because the
 * caller is already inside a route handler assembling its own packet stream.
 */
export async function streamDeltas(
  creds: LlmCreds,
  messages: LlmMessage[],
  onDelta: (text: string) => void,
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await chatCompletions(
    creds,
    {
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.3,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    },
    opts.signal,
  );
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM stream failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are newline-delimited; keep the trailing partial line.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) onDelta(text);
        } catch {
          // Ignore keepalives and any frame that is not a completion chunk.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
