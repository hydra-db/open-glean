/**
 * Native Anthropic Messages API access, for a base URL of api.anthropic.com.
 *
 * The OpenAI-compatible path in lib/llmServer.ts cannot reach Claude directly:
 * the Messages API uses `x-api-key`, a top-level system prompt, and its own
 * stream events. This module speaks it through the official SDK and exposes the
 * same shapes the rest of the app already consumes (text deltas, URL citations).
 *
 * Request choices that differ from the OpenAI path:
 *  - No `temperature`. Current Claude models reject sampling parameters.
 *  - `max_tokens` is required by the API, so it always gets a default.
 *  - Web search uses Anthropic's server-side web search tool instead of
 *    OpenRouter's plugin.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmCreds, LlmMessage } from "@/lib/llmServer";
import { anthropicBaseUrl, toAnthropicPrompt, webSearchToolType } from "@/lib/llmProvider";

/** Matches the OpenAI path: a long answer legitimately takes a while. */
const LLM_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS_COMPLETE = 16_000;
const DEFAULT_MAX_TOKENS_STREAM = 64_000;
/** Web search can pause a long turn; resume it this many times at most. */
const MAX_CONTINUATIONS = 4;

export interface UrlCitation {
  url: string;
  title?: string;
}

/** The model declined to answer. Not retryable with the same prompt. */
export class LlmRefusalError extends Error {
  constructor() {
    super("The model declined to answer this request.");
    this.name = "LlmRefusalError";
  }
}

/**
 * Same no-redirect rule as the OpenAI path: the base URL was SSRF-validated,
 * but a redirect would send the follow-up request somewhere that was not.
 */
const noRedirectFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, { ...init, redirect: "manual" });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new Error("LLM endpoint attempted a redirect, which is not allowed.");
  }
  return res;
};

function client(creds: LlmCreds): Anthropic {
  return new Anthropic({
    apiKey: creds.apiKey,
    // Never let a deployment-level ANTHROPIC_AUTH_TOKEN ride along with the
    // resolved key; credentials come only from resolveLlmCreds.
    authToken: null,
    baseURL: anthropicBaseUrl(creds.baseUrl),
    timeout: LLM_TIMEOUT_MS,
    fetch: noRedirectFetch,
  });
}

function requestBase(creds: LlmCreds, messages: LlmMessage[], maxTokens: number) {
  const prompt = toAnthropicPrompt(messages);
  if (prompt.messages.length === 0) throw new Error("No messages provided");
  return {
    model: creds.model,
    max_tokens: maxTokens,
    ...(prompt.system ? { system: prompt.system } : {}),
    messages: prompt.messages as Anthropic.MessageParam[],
  };
}

/**
 * A sentence the user can act on, from an SDK error. The API's error body is
 * `{ type: "error", error: { type, message } }`; take only the message.
 */
export function anthropicErrorMessage(err: unknown): { status: number; message: string } {
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    const body = err.error as { error?: { message?: unknown } } | undefined;
    const message =
      typeof body?.error?.message === "string" && body.error.message.trim()
        ? body.error.message.trim()
        : `The model provider rejected the request (${err.status}).`;
    return { status: err.status, message };
  }
  return { status: 502, message: "Failed to reach the LLM provider." };
}

/** One non-streaming completion. Returns the assistant text. */
export async function anthropicComplete(
  creds: LlmCreds,
  messages: LlmMessage[],
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const response = await client(creds).messages.create(
    requestBase(creds, messages, opts.maxTokens ?? DEFAULT_MAX_TOKENS_COMPLETE),
    { signal: opts.signal },
  );
  if (response.stop_reason === "refusal") throw new LlmRefusalError();
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export interface AnthropicStreamHandle {
  /**
   * Consume the stream, calling `onDelta` per text chunk. Resolves with any
   * web search results seen. Rejects with `LlmRefusalError` on a refusal.
   */
  pump(onDelta: (text: string) => void): Promise<{ citations: UrlCitation[] }>;
  abort(): void;
}

/**
 * Open a streaming completion and wait for the provider to accept it.
 *
 * Split from consuming the stream so a route can still answer with a real HTTP
 * status when the provider rejects the request (bad key, unknown model),
 * instead of returning 200 and an empty body.
 */
export async function openAnthropicStream(
  creds: LlmCreds,
  messages: LlmMessage[],
  opts: { maxTokens?: number; signal?: AbortSignal; webSearch?: boolean } = {},
): Promise<AnthropicStreamHandle> {
  const anthropic = client(creds);
  const base = requestBase(creds, messages, opts.maxTokens ?? DEFAULT_MAX_TOKENS_STREAM);
  const params: Anthropic.MessageStreamParams = {
    ...base,
    ...(opts.webSearch
      ? {
          tools: [
            { type: webSearchToolType(creds.model), name: "web_search", max_uses: 5 },
          ] as Anthropic.ToolUnion[],
        }
      : {}),
  };

  let current = anthropic.messages.stream(params, { signal: opts.signal });
  // Throws the SDK's APIError on a non-2xx response.
  await current.withResponse();

  return {
    abort: () => current.abort(),
    async pump(onDelta) {
      const citations: UrlCitation[] = [];
      const history = [...params.messages];
      for (let turn = 0; ; turn++) {
        for await (const event of current) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            onDelta(event.delta.text);
          } else if (
            event.type === "content_block_start" &&
            event.content_block.type === "web_search_tool_result" &&
            Array.isArray(event.content_block.content)
          ) {
            for (const r of event.content_block.content) {
              citations.push({ url: r.url, title: r.title || undefined });
            }
          }
        }
        const final = await current.finalMessage();
        if (final.stop_reason === "refusal") throw new LlmRefusalError();
        // A server-side tool loop can pause a long turn. Send the partial turn
        // back unchanged and the API resumes where it stopped.
        if (final.stop_reason !== "pause_turn" || turn >= MAX_CONTINUATIONS) break;
        history.push({ role: "assistant", content: final.content });
        current = anthropic.messages.stream(
          { ...params, messages: history },
          { signal: opts.signal },
        );
      }
      return { citations };
    },
  };
}
