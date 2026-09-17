/**
 * One numbering for citations, used by both the prompt and the panel.
 *
 * The prompt and the panel both render from this index. A change to the
 * grouping rule therefore moves both together, and the number the model cites
 * always matches the card the user sees.
 *
 * Group by source, not by chunk. A citation means "this document said so", and
 * the panel shows one card per document. Hydra returns several chunks per
 * document, so chunk-level numbering would give the model more numbers than the
 * user has cards.
 */
import type { SearchChunk, WebCitation } from "@/lib/types";

export interface CitationEntry {
  /** 1-based number shown to the user and given to the model. */
  ref: number;
  /** Stable grouping key (source id, chunk uuid, or title). */
  key: string;
  title: string;
  /** Every retrieved chunk belonging to this source. */
  chunks: SearchChunk[];
  /** True for a web-search result rather than a Hydra source. */
  web: boolean;
  url?: string;
  provider?: string;
  sourceId?: string;
  collection?: string;
  score?: number;
}

export interface CitationIndex {
  entries: CitationEntry[];
  /** Highest valid reference. A marker above this cannot resolve. */
  maxRef: number;
}

/**
 * A readable title for a source card.
 *
 * Hydra has no filename for a memory, so it returns the content hash as the
 * title. A hash tells the reader nothing. If the title is a hash, fall back to
 * the start of the cited passage.
 */
function displayTitle(c: SearchChunk): string {
  const raw = c.source_title?.trim() ?? "";
  const looksLikeHash = /^[0-9a-f]{16,}$/i.test(raw);
  if (raw && !looksLikeHash) return raw;

  const body = (c.chunk_content ?? c.content ?? "").trim().replace(/\s+/g, " ");
  if (body) return body.length > 60 ? `${body.slice(0, 57)}…` : body;
  return raw || "Untitled source";
}

/** Group key for a chunk. Matches the key SourcesPanel uses. */
function groupKey(c: SearchChunk, fallbackIndex: number): string {
  return c.source_id ?? c.chunk_uuid ?? c.source_title ?? `chunk-${fallbackIndex}`;
}

/**
 * Build the numbering for one answer.
 *
 * Hydra sources come first, in first-appearance order. Web citations follow and
 * continue the same sequence, so every marker lives in one namespace.
 */
export function buildCitationIndex(
  chunks: SearchChunk[],
  citations: WebCitation[] = [],
): CitationIndex {
  const map = new Map<string, CitationEntry>();

  for (const c of chunks) {
    const key = groupKey(c, map.size);
    let entry = map.get(key);
    if (!entry) {
      entry = {
        ref: map.size + 1,
        key,
        title: displayTitle(c),
        chunks: [],
        web: false,
        url: c.source_url,
        provider: c.app_provider,
        sourceId: c.source_id,
        collection: c.collection,
        score: c.relevancy_score ?? c.score,
      };
      map.set(key, entry);
    }
    entry.chunks.push(c);
    const score = c.relevancy_score ?? c.score;
    if (score != null && (entry.score == null || score > entry.score)) {
      entry.score = score;
    }
  }

  const entries = [...map.values()];
  // Dedup web citations by URL. The model can return the same source twice; two
  // entries would mean two ref numbers and two cards for one page.
  const seenWeb = new Set<string>();
  citations.forEach((w) => {
    if (w.url) {
      if (seenWeb.has(w.url)) return;
      seenWeb.add(w.url);
    }
    entries.push({
      ref: entries.length + 1,
      key: w.url ?? `web-${entries.length}`,
      title: w.title?.trim() || w.url || "Web result",
      chunks: [],
      web: true,
      url: w.url,
    });
  });

  return { entries, maxRef: entries.length };
}

/**
 * Render the index as the numbered context block for the prompt.
 *
 * Every chunk of a source appears under that source's single number. The model
 * sees all the retrieved text, but it cannot cite a number that has no card.
 */
export function renderContext(index: CitationIndex): string {
  return index.entries
    .map((e) => {
      if (e.web) {
        return `[${e.ref}] ${e.title}\n${e.url ?? ""}`.trimEnd();
      }
      const body = e.chunks
        .map((c) => (c.chunk_content ?? c.content ?? "").trim())
        .filter(Boolean)
        .join("\n\n");
      return `[${e.ref}] ${e.title}${body ? `\n${body}` : ""}`;
    })
    .join("\n\n");
}
