/**
 * Completion marker for the /api/llm/chat text stream.
 *
 * The endpoint streams raw answer text with no framing. A stream that ends
 * because the upstream died looks the same as one that ends because the answer
 * finished, so the server states completion explicitly.
 *
 * CITATIONS_SENTINEL cannot serve this purpose. The endpoint emits it only when
 * web search is on and citations come back, so its absence is normal.
 *
 * A text marker keeps the wire format as it is. The client is a sentinel
 * scanner with a tail guard and the endpoint already carries one text marker.
 */

/** Emitted as the final bytes of a successful stream. */
export const DONE_SENTINEL = "---OPEN-GLEAN-DONE---";

export interface TerminatorResult {
  /** The answer text, with the marker removed. */
  text: string;
  /** True when the server signalled a clean end. */
  complete: boolean;
}

/**
 * Split a finished stream body into its text and completion state.
 *
 * The marker counts only at the very end. An answer that quotes it mid-text is
 * still an incomplete stream, and so is a stream cut off partway through the
 * marker.
 */
export function splitTerminator(raw: string): TerminatorResult {
  const trimmed = raw.replace(/\s+$/, "");
  if (trimmed.endsWith(DONE_SENTINEL)) {
    return {
      text: trimmed.slice(0, -DONE_SENTINEL.length).replace(/\s+$/, ""),
      complete: true,
    };
  }
  return { text: raw, complete: false };
}
