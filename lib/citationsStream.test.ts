/**
 * The citations sentinel and the completion marker must work TOGETHER.
 *
 * They were built separately and each worked alone. In production both are
 * present on every web-search answer: the server writes the citations, then
 * the DONE marker. The marker therefore lands inside the citation slice, and
 * JSON.parse threw on it, so every web citation was silently dropped.
 */
import { describe, expect, it } from "vitest";
import { CITATIONS_SENTINEL } from "@/lib/constants";
import { DONE_SENTINEL, splitTerminator } from "@/lib/streamProtocol";

/** Mirrors parseCitations in lib/llm.ts. */
function parseCitations(text: string): { url: string }[] {
  const trimmed = splitTerminator(text).text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is { url: string } =>
      !!c && typeof c === "object" && typeof (c as { url?: unknown }).url === "string");
  } catch { return []; }
}

/** Exactly what app/api/llm/chat/route.ts writes on a web-search answer. */
function serverWire(answer: string, citations: { url: string }[]) {
  return answer
    + `\n${CITATIONS_SENTINEL}\n${JSON.stringify(citations)}\n`
    + `\n${DONE_SENTINEL}\n`;
}

describe("citations + completion marker together", () => {
  it("keeps the citations when the DONE marker follows them", () => {
    const wire = serverWire("An answer.", [{ url: "https://example.com" }]);
    const citationText = wire.slice(wire.indexOf(CITATIONS_SENTINEL) + CITATIONS_SENTINEL.length);
    expect(parseCitations(citationText)).toHaveLength(1);
  });

  it("still reports the stream as complete", () => {
    const wire = serverWire("An answer.", [{ url: "https://example.com" }]);
    const citationText = wire.slice(wire.indexOf(CITATIONS_SENTINEL) + CITATIONS_SENTINEL.length);
    expect(splitTerminator(citationText).complete).toBe(true);
  });

  it("returns nothing when the stream was cut before the citations closed", () => {
    const cut = "An answer.\n" + CITATIONS_SENTINEL + '\n[{"url":"https://exa';
    const citationText = cut.slice(cut.indexOf(CITATIONS_SENTINEL) + CITATIONS_SENTINEL.length);
    expect(parseCitations(citationText)).toEqual([]);
    expect(splitTerminator(citationText).complete).toBe(false);
  });

  it("handles citations with no marker (older server)", () => {
    const wire = "An answer.\n" + CITATIONS_SENTINEL + '\n[{"url":"https://a.com"}]\n';
    const citationText = wire.slice(wire.indexOf(CITATIONS_SENTINEL) + CITATIONS_SENTINEL.length);
    expect(parseCitations(citationText)).toHaveLength(1);
  });

  it("handles an empty citation list", () => {
    const wire = serverWire("An answer.", []);
    const citationText = wire.slice(wire.indexOf(CITATIONS_SENTINEL) + CITATIONS_SENTINEL.length);
    expect(parseCitations(citationText)).toEqual([]);
  });
});
