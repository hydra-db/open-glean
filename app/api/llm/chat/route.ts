/**
 * POST /api/llm/chat
 *
 * Streaming chat completions against the user-configured OpenRouter-compatible
 * endpoint (OpenRouter, OpenAI, Groq, Together, local Ollama, …) when the
 * "Ask" flow needs answer synthesis over Hydra-retrieved context.
 *
 * Body:
 * {
 *   baseUrl?: string,          // default https://openrouter.ai/api/v1
 *   apiKey: string,
 *   model: string,
 *   messages: { role; content }[],
 *   temperature?: number,
 *   maxTokens?: number,
 *   webSearch?: boolean        // enable the OpenRouter web-search plugin
 * }
 *
 * Responds with a text/plain stream of raw text deltas (SSE-unwrapped).
 *
 * CITATIONS PROTOCOL (documented choice): when `webSearch` is enabled and the
 * provider returned URL citations, the stream ends with
 *
 *     \n---OPEN-GLEAN-CITATIONS---\n[{"url":"...","title":"..."},...]
 *
 * Instead of a structured SSE envelope or response headers, because the
 * browser-side consumer is a plain body reader and appending the sentinel is
 * the least-surprising protocol change for existing callers. The sentinel is
 * near-impossible to emit accidentally (LLM text never contains it verbatim
 * on its own line), and the client only parses it when webSearch was set.
 *
 * Citations are harvested from the final SSE chunk(s):
 *   - `choices[0].message.annotations[]` (type "url_citation", with
 *     `url_citation: { url, title }`) — OpenRouter web plugin
 *   - `choices[0].message.citations[]` ({ url, title }) — some providers
 * Aborts propagate: req.signal → controller.abort() → upstream fetch.
 */
import { NextRequest } from "next/server";
import { CITATIONS_SENTINEL } from "@/lib/constants";
import { DONE_SENTINEL } from "@/lib/streamProtocol";
import { resolveLlmCreds } from "@/lib/llmServer";

/**
 * A sentence the user can act on, from a provider error body.
 *
 * Providers answer with JSON such as { error: { message, code } }. Returning
 * that verbatim put raw envelopes on screen and leaked account identifiers.
 */
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

interface UrlCitation {
  url?: string;
  title?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Collect { url, title } from every OpenRouter citation shape.
 *
 * Citations ride on different carriers depending on how the request was made:
 * a non-streamed completion puts them on `choices[0].message`, but a *stream*
 * delivers them on `choices[0].delta` — which is the only shape this route
 * ever sees, since it always sets `stream: true`. Reading `message` alone
 * silently harvested nothing, so the sentinel never fired and web citations
 * never reached the client. Some providers also hang `citations` off the
 * chunk root, so check all four carriers.
 */
function collectCitations(payload: Record<string, unknown>): UrlCitation[] {
  const out: UrlCitation[] = [];

  const choices = payload.choices;
  const firstChoice =
    Array.isArray(choices) && choices.length > 0 ? asRecord(choices[0]) : undefined;

  const carriers = [
    asRecord(payload.message),
    firstChoice ? asRecord(firstChoice.message) : undefined,
    firstChoice ? asRecord(firstChoice.delta) : undefined,
    payload, // provider-level `citations` on the chunk root
  ].filter((c): c is Record<string, unknown> => c !== undefined);

  const push = (u?: string, t?: string) => {
    if (typeof u === "string" && u.trim()) {
      out.push({ url: u.trim(), title: typeof t === "string" && t.trim() ? t.trim() : undefined });
    }
  };

  for (const carrier of carriers) {
    const annotations = carrier.annotations;
    if (Array.isArray(annotations)) {
      for (const a of annotations) {
        const ann = asRecord(a);
        if (!ann) continue;
        const uc = asRecord(ann.url_citation);
        if (ann.type === "url_citation" && uc) {
          push(uc.url as string | undefined, uc.title as string | undefined);
        } else {
          push(ann.url as string | undefined, ann.title as string | undefined);
        }
      }
    }

    const citations = carrier.citations;
    if (Array.isArray(citations)) {
      for (const c of citations) {
        // Perplexity-style providers emit a bare array of URL strings.
        if (typeof c === "string") {
          push(c);
          continue;
        }
        const cit = asRecord(c);
        if (!cit) continue;
        push(cit.url as string | undefined, cit.title as string | undefined);
      }
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  let body: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    provider?: { baseUrl?: string; apiKey?: string; model?: string };
    messages?: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    webSearch?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  // Key resolution: explicit body value → encrypted session cookie →
  // deployment-level env. Shared with /api/research so a deployment that
  // configures OPENROUTER_API_KEY once works for both, rather than only for
  // whichever route happened to implement the fallback.
  let creds;
  try {
    creds = await resolveLlmCreds({
      apiKey: body.apiKey ?? body.provider?.apiKey,
      baseUrl: body.baseUrl ?? body.provider?.baseUrl,
      model: body.model ?? body.provider?.model,
    });
  } catch (err) {
    // A rejected base URL (SSRF guard) — surface it as a 400, not a 500.
    return new Response(err instanceof Error ? err.message : "Invalid LLM base URL.", {
      status: 400,
    });
  }
  if (!creds) {
    return new Response(
      "Missing model configuration. Add an LLM provider + model in Settings (used to write answers over your Hydra context).",
      { status: 400 },
    );
  }
  const { apiKey, model } = creds;
  const messages = body.messages ?? [];
  if (messages.length === 0) {
    return new Response("No messages provided", { status: 400 });
  }

  const base = creds.baseUrl || DEFAULT_BASE;
  const webSearch = body.webSearch === true;

  const controller = new AbortController();
  // Abort upstream (and thus the response stream) if the client disconnects.
  req.signal.addEventListener("abort", () => controller.abort());

  const encoder = new TextEncoder();

  try {
    const upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: body.temperature ?? 0.4,
        ...(body.maxTokens ? { max_tokens: body.maxTokens } : {}),
        ...(webSearch ? { plugins: [{ id: "web", max_results: 5 }] } : {}),
      }),
      signal: controller.signal,
      // Do not follow redirects: the base URL was SSRF-validated, but a
      // redirect could point the followed request at an unvalidated internal
      // host. A completion POST never legitimately redirects.
      redirect: "manual",
    });

    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
      return new Response("LLM endpoint attempted a redirect, which is not allowed.", {
        status: 502,
      });
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      // The provider's error body is JSON and often carries fields the user
      // has no use for and should not see — OpenRouter includes the account's
      // user_id. Take the message and leave the envelope in the log.
      console.error(`[llm/chat] provider ${upstream.status}:`, detail.slice(0, 500));
      return new Response(providerMessage(upstream.status, detail), {
        status: upstream.status,
      });
    }

    const stream = new ReadableStream({
      async start(controllerSink) {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const citations: UrlCitation[] = [];
        /** Set when the upstream stream errors, so the DONE marker is withheld. */
        let streamFailed = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === "[DONE]") continue;
              let json: Record<string, unknown>;
              try {
                json = JSON.parse(payload) as Record<string, unknown>;
              } catch {
                continue;
              }
              const choices = json.choices;
              const firstChoice =
                Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object"
                  ? (choices[0] as { delta?: { content?: unknown }; message?: { content?: unknown } })
                  : undefined;
              const deltaContent =
                (firstChoice?.delta?.content as string | undefined) ??
                (firstChoice?.message?.content as string | undefined);
              if (typeof deltaContent === "string" && deltaContent) {
                controllerSink.enqueue(encoder.encode(deltaContent));
              }
              citations.push(...collectCitations(json));
            }
          }
        } catch (err) {
          // Record the failure so the DONE marker is NOT emitted below. The
          // stream still closes cleanly (there is no way to change the status
          // after headers are flushed), so the marker is the only thing that
          // distinguishes a finished answer from a truncated one. C6.
          streamFailed = true;
          console.error("[llm/chat] stream error:", err);
        } finally {
          reader.releaseLock();
          if (webSearch && citations.length > 0) {
            const seen = new Set<string>();
            const unique = citations.filter((c) => {
              if (!c.url || seen.has(c.url)) return false;
              seen.add(c.url);
              return true;
            });
            controllerSink.enqueue(
              encoder.encode(`\n${CITATIONS_SENTINEL}\n${JSON.stringify(unique)}\n`),
            );
          }
          // Only a stream that ran to completion gets the marker. Its absence
          // is how the client knows the answer is truncated.
          if (!streamFailed) {
            try {
              controllerSink.enqueue(encoder.encode(`\n${DONE_SENTINEL}\n`));
            } catch {
              // Consumer already gone; nothing to signal to.
            }
          }
          try {
            controllerSink.close();
          } catch {
            // Already closed by a cancelled consumer.
          }
        }
      },
      cancel() {
        controller.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error("[llm/chat]", err);
    return new Response("Failed to reach the LLM provider.", { status: 502 });
  }
}