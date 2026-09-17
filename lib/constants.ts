export const GRAPH_DEBOUNCING_DELAY_MS = 1000;
export const GRAPH_MAX_NODES = 10000;

/**
 * Sentinel that separates the streamed answer from its web-search citations.
 *
 * `/api/llm/chat` appends `\n${CITATIONS_SENTINEL}\n<json>\n` after the last
 * delta; `lib/llm.ts` splits on it. Both sides import this constant — when the
 * two spellings drifted apart, citations silently vanished and the raw JSON
 * leaked into the visible answer, so keep it as the single source of truth.
 */
export const CITATIONS_SENTINEL = "---OPEN-GLEAN-CITATIONS---";

/** Legacy sentinel — still recognised when parsing, never emitted. */

/** Human label for a provider slug (title-cased). */
export function providerLabel(provider: string): string {
  const slug = provider.trim().toLowerCase();
  if (!slug) return "";
  return slug
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Provider slug → ProviderLogo id. */
export function providerLogoId(provider: string): string {
  return provider.trim().toLowerCase();
}
