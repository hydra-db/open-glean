"use client";

/**
 * Streaming chat-completion helper that talks to /api/llm/chat.
 *
 * The route streams raw text deltas (already SSE-unwrapped, plain text/plain).
 * When `webSearch` is enabled the route appends a final sentinel line:
 *     \n---OPEN-GLEAN-CITATIONS---\n[{"url":"...","title":"..."},...]
 * Deltas are emitted immediately to `onDelta` so the UI responds with zero lag.
 */
import { CITATIONS_SENTINEL } from "@/lib/constants";
import { DONE_SENTINEL, splitTerminator } from "@/lib/streamProtocol";
import type { WebCitation } from "@/lib/types";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmProvider {
  baseUrl?: string;
  apiKey: string;
  model: string;
}

export interface StreamChatOpts {
  provider?: LlmProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  webSearch?: boolean;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onSources?: (citations: WebCitation[]) => void;
}

export interface StreamChatResult {
  citations: WebCitation[];
}

function parseCitations(text: string): WebCitation[] {
  // The completion marker is written after the citations, so it lands inside
  // this slice. Remove it before parsing, or JSON.parse throws and every web
  // citation is discarded.
  const trimmed = splitTerminator(text).text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is { url: unknown; title?: unknown } =>
          !!c && typeof c === "object" && typeof (c as { url?: unknown }).url === "string",
      )
      .map((c) => ({
        url: c.url as string,
        title: typeof c.title === "string" && c.title.trim() ? c.title : undefined,
      }));
  } catch {
    return [];
  }
}

function dedupe(citations: WebCitation[]): WebCitation[] {
  const seen = new Set<string>();
  const out: WebCitation[] = [];
  for (const c of citations) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

/** Streams deltas via onDelta; resolves with web-search citations (if any). */
export async function streamChat(opts: StreamChatOpts): Promise<StreamChatResult> {
  const apiKey = (opts.apiKey ?? opts.provider?.apiKey ?? "").trim();
  const model = (opts.model ?? opts.provider?.model ?? "").trim();
  if (!model) {
    throw new Error("Missing model configuration. Add an LLM provider + model in Settings.");
  }

  const res = await fetch("/api/llm/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: opts.baseUrl ?? opts.provider?.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
      maxTokens: opts.maxTokens,
      webSearch: opts.webSearch === true,
    }),
    signal: opts.signal,
    cache: "no-store",
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      detail || `LLM request failed (${res.status}). Check your model settings.`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullAccumulator = "";
  let citationText = "";
  let seenSentinel = false;
  /** How much of `fullAccumulator` has already gone out via `onDelta`. */
  let emitted = 0;
  // Longest sentinel the stream may carry (citations or the completion marker):
  // the tail-guard must hold back this many chars so a sentinel split across two
  // chunks is still recognised instead of leaking into the visible answer.
  const tailGuard = Math.max(CITATIONS_SENTINEL.length, DONE_SENTINEL.length);
  /**
   * Find the citations sentinel, which the server always writes on its own
   * line.
   *
   * The line anchor matters. A bare substring search meant an answer that
   * merely mentioned the marker, for example one explaining this protocol, had
   * everything after it swallowed as citation JSON and thrown away.
   */
  const findAnchored = (s: string, marker: string): number => {
    let from = 0;
    for (;;) {
      const at = s.indexOf(marker, from);
      if (at < 0) return -1;
      const atLineStart = at === 0 || s[at - 1] === "\n";
      const after = s[at + marker.length];
      const atLineEnd = after === undefined || after === "\n" || after === "\r";
      if (atLineStart && atLineEnd) return at;
      from = at + 1;
    }
  };
  const findSentinel = (s: string): { index: number; len: number } => {
    return { index: findAnchored(s, CITATIONS_SENTINEL), len: CITATIONS_SENTINEL.length };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (seenSentinel) {
        citationText += text;
        continue;
      }
      fullAccumulator += text;
      const { index: sentinelIndex, len: sentinelLen } = findSentinel(fullAccumulator);
      if (sentinelIndex >= 0) {
        seenSentinel = true;
        // The sentinel can land mid-chunk: flush the answer text ahead of it
        // before switching to citation mode, or the tail of the answer is lost.
        if (sentinelIndex > emitted) {
          opts.onDelta(fullAccumulator.slice(emitted, sentinelIndex));
        }
        citationText = fullAccumulator.slice(sentinelIndex + sentinelLen);
      } else {
        // Hold back a sentinel-sized tail so a sentinel split across two chunks
        // is still recognised instead of being emitted as visible text.
        const safe = fullAccumulator.length - tailGuard;
        if (safe > emitted) {
          opts.onDelta(fullAccumulator.slice(emitted, safe));
          emitted = safe;
        }
      }
    }
    // Stream ended with no citations sentinel — flush what the tail-guard held
    // back, minus the completion marker if it is there.
    if (!seenSentinel && fullAccumulator.length > emitted) {
      const tail = splitTerminator(fullAccumulator.slice(emitted));
      if (tail.text) opts.onDelta(tail.text);
    }
  } finally {
    reader.releaseLock();
  }

  // Did the server signal a clean end? Without the marker the stream was cut
  // short — upstream died, the server crashed, the connection dropped — and
  // the caller must not present the partial text as a finished answer.
  //
  // When citations are present the marker lands in `citationText`, because the
  // citations sentinel switches the reader into citation mode first.
  const completed =
    splitTerminator(fullAccumulator).complete || splitTerminator(citationText).complete;

  const citations = dedupe(parseCitations(citationText));
  if (opts.webSearch && citations.length > 0) {
    opts.onSources?.(citations);
  }
  if (!completed) {
    throw new Error(
      "The answer stopped before it finished. The connection or the model provider dropped mid-response.",
    );
  }
  return { citations };
}
