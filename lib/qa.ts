"use client";

/**
 * Ask/QnA engine: retrieval (Hydra search) + answer synthesis (streamed LLM).
 *
 * `useQa()` wires the two together:
 *   1. retrieve chunks via `hydra.search` (real backend, never mocked)
 *   2. if an LLM provider is configured, stream an answer grounded in the
 *      retrieved context (plus personalisation instructions + chat history)
 *   3. optionally enable the OpenRouter web-search plugin and surface its
 *      citations (`onWebSources`)
 *   4. support aborting an in-flight run (the chat "Stop" button)
 */
import { useCallback, useRef } from "react";
import { useHydra } from "@/lib/api";
import { useAppConfig } from "@/lib/store/config";
import { useChatStore } from "@/lib/store/chat";
import { streamChat, type LlmMessage } from "@/lib/llm";
import { usableHistory } from "@/lib/history";
import { buildCitationIndex, renderContext } from "@/lib/citations";
import type {
  AppConfig,
  SearchChunk,
  SearchResult,
  WebCitation,
} from "@/lib/types";

export type QaMode = "fast" | "thinking";
export type QaKind = "all" | "memory" | "knowledge";

export interface NormalizedSearch {
  /** Flat, normalized chunks (each chunk = one retrieval hit). */
  chunks: SearchChunk[];
  total: number;
  /**
   * `meta.request_id` from the /query envelope.
   *
   * POST /feedback only accepts a request id taken verbatim from the query it
   * refers to, so this has to survive normalization or the feedback loop is
   * impossible to wire up.
   */
  requestId?: string;
}

const MAX_RESULTS = 8;
const HISTORY_LIMIT = 8;
const MAX_CONTEXT_CHARS = 12_000;

// ── Normalization ─────────────────────────────────────────────────
//
// The live /query response is an envelope: { success, data: { chunks,
// sources?, graph_context? } } — but it has been seen with chunks under
// `data.md`, or raw arrays under `data` / `sources` / `results`. Chunk fields
// are camelCase (chunk_uuid, chunk_content, source_title, source_id,
// source_url, source_type, relevancy_score); legacy spellings are tolerated.

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && !isNaN(v) ? v : undefined;
}

function normalizeChunk(raw: unknown): SearchChunk | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;

  // Tolerate { chunk: {...} } / { chunks: [...] } wrappers.
  if (c.chunk && typeof c.chunk === "object" && !Array.isArray(c.chunk)) {
    return normalizeChunk(c.chunk);
  }
  if (Array.isArray(c.chunks) && c.chunks.length > 0) {
    return normalizeChunk(c.chunks[0]);
  }

  const content =
    str(c.chunk_content) ??
    str(c.chunkContent) ??
    str(c.content) ??
    str(c.text);
  const sourceTitle =
    str(c.source_title) ?? str(c.sourceTitle);
  const sourceUrl = str(c.source_url) ?? str(c.sourceUrl);
  const sourceId = str(c.source_id) ?? str(c.sourceId);
  const sourceType = str(c.source_type) ?? str(c.sourceType);
  const uploadTime =
    str(c.source_upload_time) ?? str(c.sourceUploadTime) ?? str(c.upload_time);
  // Only treat objects with at least one chunk-ish field as chunks.
  if (!content && !sourceTitle && !sourceUrl && !sourceId) return null;

  const score =
    num(c.relevancy_score) ??
    num(c.relevancyScore) ??
    num(c.score);
  // Chunk ids derive from the source id (source_id + "_chunk_" + index) —
  // recover the source id when the explicit field is absent.
  const chunkUuid = str(c.chunk_uuid) ?? str(c.chunkUuid) ?? str(c.chunk_id);
  const derivedSourceId =
    sourceId ??
    str(c.id) ??
    (chunkUuid ? chunkUuid.split("_chunk_")[0] : undefined);
  // Connector provenance rides on the chunk's additional metadata — the SDK
  // serializes it camelCase (additionalMetadata), raw HTTP snake_case.
  const meta = (c.additionalMetadata ?? c.additional_metadata) as
    | Record<string, unknown>
    | undefined;
  const appProvider =
    (meta && (str(meta.app_provider) ?? str(meta.appProvider))) ??
    str(c.app_provider) ??
    str(c.appProvider);
  const chunk: SearchChunk = {
    chunk_uuid: chunkUuid ?? str(c.id),
    chunk_content: content,
    source_title: sourceTitle,
    source_id: derivedSourceId,
    app_provider: appProvider,
    source_url: sourceUrl,
    source_type: sourceType,
    source_upload_time: uploadTime,
    // `sub_tenant_id` is the deprecated mirror of `collection` on the wire.
    collection: str(c.collection) ?? str(c.sub_tenant_id) ?? str(c.subTenantId),
    score,
    relevancy_score: score,
  };
  if (Array.isArray(c.highlights)) {
    chunk.highlights = (c.highlights as unknown[]).filter(
      (h): h is string => typeof h === "string",
    );
  }
  return chunk;
}

/** Unwrap the /query envelope and produce a flat, normalized chunk list. */
export function normalizeSearchResponse(raw: unknown): NormalizedSearch {
  if (!raw || typeof raw !== "object") return { chunks: [], total: 0 };
  const root = raw as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : null;
  const md =
    data?.md && typeof data.md === "object" && !Array.isArray(data.md)
      ? (data.md as Record<string, unknown>)
      : null;

  const candidates: (unknown[] | null)[] = [
    Array.isArray(data?.chunks) ? (data.chunks as unknown[]) : null,
    Array.isArray(data?.sources) ? (data.sources as unknown[]) : null,
    Array.isArray(md?.chunks) ? (md.chunks as unknown[]) : null,
    Array.isArray(md?.sources) ? (md.sources as unknown[]) : null,
    Array.isArray(root.chunks) ? (root.chunks as unknown[]) : null,
    Array.isArray(root.sources) ? (root.sources as unknown[]) : null,
    Array.isArray(root.results) ? (root.results as unknown[]) : null,
    Array.isArray(root.data) ? (root.data as unknown[]) : null,
  ];

  const list = candidates.find((c): c is unknown[] => c !== null) ?? [];
  const chunks = list
    .map(normalizeChunk)
    .filter((c): c is SearchChunk => c !== null);

  const total =
    num(root.total) ??
    num(data?.total) ??
    num(md?.total) ??
    chunks.length;

  const meta =
    root.meta && typeof root.meta === "object" && !Array.isArray(root.meta)
      ? (root.meta as Record<string, unknown>)
      : null;
  const requestId = str(meta?.request_id) ?? str(meta?.requestId);

  return { chunks, total, requestId };
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Default chat title from the query.
 *
 * Keep the whole question when it fits in the budget. When it does not, add
 * whole words up to the budget and mark the cut with an ellipsis. Never cut a
 * short question mid-sentence with no ellipsis.
 */
const TITLE_BUDGET = 48;
export function suggestTitle(query: string): string {
  const clean = query.trim().replace(/\s+/g, " ");
  if (!clean) return "New chat";
  if (clean.length <= TITLE_BUDGET) return clean;
  const words = clean.split(" ");
  let title = "";
  for (const w of words) {
    const next = title ? `${title} ${w}` : w;
    if (next.length > TITLE_BUDGET) break;
    title = next;
  }
  // A single word longer than the budget still needs a hard cut.
  if (!title) title = clean.slice(0, TITLE_BUDGET).trimEnd();
  return `${title}…`;
}

/** True when an LLM provider is fully configured (key + model). */
export function hasLlm(config: AppConfig): boolean {
  return Boolean(
    config.llm?.model?.trim() &&
      (config.llm?.apiKey?.trim() || config.llmConfigured),
  );
}

/**
 * Build the numbered context block from chunks (+ optional web citations).
 *
 * Delegates to lib/citations so the prompt and the sources panel number the
 * same way. This used to number flat chunks while the panel numbered deduped
 * sources, so the model cited `[7]` when the user had four cards.
 */
export function chunksToContext(
  chunks: SearchChunk[],
  citations: WebCitation[] = [],
): string {
  return renderContext(buildCitationIndex(chunks, citations));
}

/** Group flat chunks into per-source SearchResult-shaped groups. */
export function chunksToSources(chunks: SearchChunk[]): SearchResult[] {
  const groups = new Map<string, SearchResult>();
  for (const chunk of chunks) {
    const key =
      chunk.source_id || chunk.chunk_uuid || chunk.source_title || `chunk-${groups.size}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        source: {
          id: chunk.source_id,
          title: chunk.source_title,
          type: chunk.source_type,
          url: chunk.source_url,
        },
        chunks: [],
        score: chunk.relevancy_score ?? chunk.score,
      };
      groups.set(key, g);
    }
    g.chunks!.push(chunk);
    const s = chunk.relevancy_score ?? chunk.score;
    if (s != null && (g.score == null || s > g.score)) g.score = s;
  }
  return [...groups.values()];
}

// ── The hook ──────────────────────────────────────────────────────

export interface RunQaOpts {
  query: string;
  conversationId?: string;
  /**
   * Id of the assistant message being streamed into.
   *
   * The caller adds the user question and this placeholder to the store before
   * calling, so without it the in-flight turn is read back as history and the
   * question is sent twice.
   */
  assistantMessageId?: string;
  collection?: string;
  /** Database scope (defaults to the stored scope). */
  database?: string;
  kind?: QaKind;
  /** Enable the OpenRouter web-search plugin for this run. */
  webSearch?: boolean;
  /** Retrieval mode: fast (hybrid) or thinking (graph-augmented, slower). */
  mode?: QaMode;
  /** Exact-match metadata filters for retrieval (key / value pairs). */
  metadataFilters?: Record<string, unknown>;
  /** Multi-collection retrieval scope (overrides the config default). */
  collections?: string[];
  /** Fired as soon as the retrieved chunks land (before streaming starts). */
  onChunks?: (chunks: SearchChunk[]) => void;
  /** Fired when the stream finishes with web-search citations. */
  onWebSources?: (citations: WebCitation[]) => void;
  /** Streamed answer deltas. */
  onDelta?: (text: string) => void;
}

export interface RunQaResult {
  chunks: SearchChunk[];
  /** False when no LLM is configured — the caller should do search-only. */
  canAnswer: boolean;
  /** Resolves when streaming finishes (with citations); aborts reject. */
  streamPromise: Promise<{ citations: WebCitation[] }> | null;
  abort: () => void;
  /** `meta.request_id` of the retrieval — pass to `POST /feedback`. */
  requestId?: string;
}

function buildLlmMessages(
  opts: Pick<RunQaOpts, "query" | "conversationId" | "webSearch">,
  config: AppConfig,
  chunks: SearchChunk[],
  history: { role: "system" | "user" | "assistant"; content: string }[],
): LlmMessage[] {
  const messages: LlmMessage[] = [];
  if (config.instructions?.trim()) {
    messages.push({
      role: "system",
      content: `Personalisation instructions from the user: ${config.instructions.trim()}`,
    });
  }
  const context = chunksToContext(chunks).slice(0, MAX_CONTEXT_CHARS);
  const webSearch = Boolean(opts.webSearch);
  const prompt = webSearch
    ? [
        "You are Open Glean, a personal second-brain assistant.",
        "Answer using the retrieved context below AND the live web results from the web-search tool.",
        "Cite retrieved context inline as [1], [2], … and web results as [Web 1], [Web 2], ….",
        "If the retrieved context is empty, rely on the web-search results.",
        "Use short paragraphs and light markdown.",
        context
          ? `=== RETRIEVED CONTEXT ===\n${context}`
          : "(No Hydra context was retrieved for this query — use the web-search results.)",
      ]
    : [
        "You are Open Glean, a personal second-brain assistant. Answer using ONLY the retrieved context below.",
        "Context entries are numbered — cite them inline with [1], [2], …",
        "If the context cannot answer the question, say so plainly and suggest what to search for instead.",
        "Use short paragraphs and light markdown.",
        context
          ? `=== RETRIEVED CONTEXT ===\n${context}`
          : "(No context was retrieved for this query.)",
      ];
  messages.push({ role: "system", content: prompt.join("\n\n") });
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: opts.query });
  return messages;
}

export function useQa() {
  const hydra = useHydra();
  const { config } = useAppConfig();
  const { getConversation } = useChatStore();
  const aborts = useRef(new Map<string, AbortController>());

  /** Abort the run registered under `key` (usually the conversation id). */
  const stop = useCallback((key: string) => {
    const controller = aborts.current.get(key);
    if (controller) {
      controller.abort();
      aborts.current.delete(key);
    }
  }, []);

  const runQa = useCallback(
    async (opts: RunQaOpts): Promise<RunQaResult> => {
      const controller = new AbortController();
      const key =
        opts.conversationId ||
        `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      aborts.current.set(key, controller);
      const abort = () => {
        controller.abort();
        aborts.current.delete(key);
      };

      // 1. Retrieve + normalize (real Hydra /query). /query accepts a
      //    multi-collection `collections` selector directly — no fan-out
      //    needed. Database always rides along from the stored scope; an
      //    explicit collection/collections override only replaces the scope
      //    it was given for.
      let chunks: SearchChunk[] = [];
      let requestId: string | undefined;
      try {
        // Scope precedence (same rule as the ScopeSwitcher + every view):
        // an explicit single collection shadows the multi-select; without an
        // explicit single, the explicit multi (or the stored multi) applies;
        // without either, the stored single applies; without any scope the
        // server default database decides.
        const multi =
          opts.collection
            ? undefined
            : opts.collections && opts.collections.length > 0
              ? opts.collections
              : hydra.config.collections && hydra.config.collections.length > 0
                ? hydra.config.collections
                : undefined;
        const single =
          opts.collection ?? (!multi ? hydra.config.collection : undefined);
        const raw = await hydra.search(opts.query, {
          kind: opts.kind ?? "all",
          maxResults: MAX_RESULTS,
          mode: opts.mode === "thinking" ? "thinking" : "fast",
          ...(opts.database ? { database: opts.database } : {}),
          ...(single
            ? { collection: single }
            : multi
              ? { collections: multi }
              : {}),
          graphContext: opts.mode === "thinking",
          ...(opts.metadataFilters && Object.keys(opts.metadataFilters).length > 0
            ? { metadataFilters: opts.metadataFilters }
            : {}),
        });
        const normalized = normalizeSearchResponse(raw);
        chunks = normalized.chunks;
        requestId = normalized.requestId;
      } catch (err) {
        aborts.current.delete(key);
        const msg =
          err instanceof Error
            ? err.message
            : "Could not reach Hydra. Check your key and base URL.";
        throw new Error(`Search failed: ${msg}`);
      }
      opts.onChunks?.(chunks);

      // 2. No LLM? Search-only mode (chunks are still returned).
      const llm = config.llm;
      if (!llm || !llm.model?.trim() || (!llm.apiKey?.trim() && !config.llmConfigured)) {
        aborts.current.delete(key);
        return { chunks, canAnswer: false, streamPromise: null, abort, requestId };
      }

      // 3. Build context + conversation history for the prompt.
      const history = opts.conversationId
        ? usableHistory(
            getConversation(opts.conversationId)?.messages ?? [],
            opts.assistantMessageId ?? "",
            HISTORY_LIMIT,
          )
        : [];
      const messages = buildLlmMessages(opts, config, chunks, history);

      // 4. Stream the answer (OpenRouter-native; web plugin when enabled).
      const streamPromise = streamChat({
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
        model: llm.model,
        messages,
        signal: controller.signal,
        webSearch: opts.webSearch === true,
        onDelta: (text) => opts.onDelta?.(text),
        onSources: (citations) => opts.onWebSources?.(citations),
      }).finally(() => {
        aborts.current.delete(key);
      });

      return { chunks, canAnswer: true, streamPromise, abort, requestId };
    },
    [hydra, config, getConversation],
  );

  return { runQa, stop };
}