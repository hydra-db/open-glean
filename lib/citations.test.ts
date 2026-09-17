/**
 * Citation numbering.
 *
 * Two independent off-by-N bugs, both from numbering the same answer twice:
 *
 *  - The prompt numbered flat CHUNKS (`[1]`..`[8]`), while the panel numbered
 *    deduped SOURCE GROUPS (`1`..`4`). Hydra routinely returns several chunks
 *    per document, so the model cited `[7]` when seven cards did not exist, and
 *    even the low numbers pointed at the wrong card.
 *  - Web citations had their own namespace in the prompt (`[Web 1]`) but were
 *    numbered continuing the group sequence in the panel (`5`).
 *
 * The fix is to number once. buildCitationIndex produces the numbering, the
 * prompt renders from it, and the panel renders from it — so they cannot drift
 * apart again.
 */
import { describe, expect, it } from "vitest";
import type { SearchChunk, WebCitation } from "@/lib/types";
import { buildCitationIndex, renderContext } from "./citations";

const chunk = (p: Partial<SearchChunk>): SearchChunk =>
  ({ chunk_content: "body", ...p }) as SearchChunk;

describe("buildCitationIndex", () => {
  it("gives one number per source, not per chunk", () => {
    // The core bug: 4 chunks from 2 documents must be 2 citations.
    const index = buildCitationIndex(
      [
        chunk({ source_id: "doc-a", source_title: "A", chunk_content: "a1" }),
        chunk({ source_id: "doc-a", source_title: "A", chunk_content: "a2" }),
        chunk({ source_id: "doc-b", source_title: "B", chunk_content: "b1" }),
        chunk({ source_id: "doc-b", source_title: "B", chunk_content: "b2" }),
      ],
      [],
    );
    expect(index.entries).toHaveLength(2);
    expect(index.entries.map((e) => e.ref)).toEqual([1, 2]);
  });

  it("numbers in first-appearance order", () => {
    const index = buildCitationIndex(
      [
        chunk({ source_id: "b", source_title: "B" }),
        chunk({ source_id: "a", source_title: "A" }),
        chunk({ source_id: "b", source_title: "B" }),
      ],
      [],
    );
    expect(index.entries.map((e) => e.title)).toEqual(["B", "A"]);
  });

  it("continues the same sequence for web citations", () => {
    // Previously the prompt said [Web 1] while the card said 3.
    const index = buildCitationIndex(
      [chunk({ source_id: "a", source_title: "A" }), chunk({ source_id: "b", source_title: "B" })],
      [{ url: "https://x.com", title: "X" } as WebCitation],
    );
    expect(index.entries.map((e) => e.ref)).toEqual([1, 2, 3]);
    expect(index.entries[2].web).toBe(true);
  });

  it("dedups web citations that share a URL", () => {
    const index = buildCitationIndex(
      [],
      [
        { url: "https://x.com", title: "X" } as WebCitation,
        { url: "https://x.com", title: "X again" } as WebCitation,
      ],
    );
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].ref).toBe(1);
  });

  it("gathers every chunk of a source under its one entry", () => {
    const index = buildCitationIndex(
      [
        chunk({ source_id: "a", source_title: "A", chunk_content: "first" }),
        chunk({ source_id: "a", source_title: "A", chunk_content: "second" }),
      ],
      [],
    );
    expect(index.entries[0].chunks).toHaveLength(2);
  });

  it("falls back through chunk_uuid and title when source_id is missing", () => {
    const index = buildCitationIndex(
      [
        chunk({ chunk_uuid: "u1", source_title: "T" }),
        chunk({ chunk_uuid: "u2", source_title: "T2" }),
      ],
      [],
    );
    expect(index.entries).toHaveLength(2);
  });

  it("reports the highest valid reference number", () => {
    const index = buildCitationIndex([chunk({ source_id: "a" }), chunk({ source_id: "b" })], []);
    expect(index.maxRef).toBe(2);
  });

  it("handles no chunks and no citations", () => {
    const index = buildCitationIndex([], []);
    expect(index.entries).toEqual([]);
    expect(index.maxRef).toBe(0);
  });
});

describe("renderContext", () => {
  it("numbers the prompt with the same refs the panel shows", () => {
    const index = buildCitationIndex(
      [
        chunk({ source_id: "a", source_title: "Alpha", chunk_content: "one" }),
        chunk({ source_id: "a", source_title: "Alpha", chunk_content: "two" }),
        chunk({ source_id: "b", source_title: "Beta", chunk_content: "three" }),
      ],
      [],
    );
    const text = renderContext(index);
    expect(text).toContain("[1] Alpha");
    expect(text).toContain("[2] Beta");
    // Four chunks, two sources: [3] must not exist.
    expect(text).not.toContain("[3]");
  });

  it("includes every chunk body under its source number", () => {
    const index = buildCitationIndex(
      [
        chunk({ source_id: "a", source_title: "Alpha", chunk_content: "first body" }),
        chunk({ source_id: "a", source_title: "Alpha", chunk_content: "second body" }),
      ],
      [],
    );
    const text = renderContext(index);
    expect(text).toContain("first body");
    expect(text).toContain("second body");
  });

  it("numbers web citations in the same sequence, with the url", () => {
    const index = buildCitationIndex(
      [chunk({ source_id: "a", source_title: "Alpha" })],
      [{ url: "https://example.com", title: "Example" } as WebCitation],
    );
    const text = renderContext(index);
    expect(text).toContain("[2] Example");
    expect(text).toContain("https://example.com");
    // The old separate namespace must be gone.
    expect(text).not.toContain("[Web 1]");
  });
});

describe("displayTitle (via buildCitationIndex)", () => {
  it("uses a real title when there is one", () => {
    const i = buildCitationIndex(
      [chunk({ source_id: "a", source_title: "Q3 planning doc" })],
      [],
    );
    expect(i.entries[0].title).toBe("Q3 planning doc");
  });

  it("falls back to the passage when the title is a content hash", () => {
    // Hydra returns the content hash as the title for memories, which have no
    // filename. A 32-char hash on a source card tells the reader nothing.
    const i = buildCitationIndex(
      [
        chunk({
          source_id: "a",
          source_title: "9561b8226bc0727bbd11485721ca95cc",
          chunk_content: "The Phoenix pipeline runs build then canary.",
        }),
      ],
      [],
    );
    expect(i.entries[0].title).toBe("The Phoenix pipeline runs build then canary.");
  });

  it("truncates a long passage", () => {
    const i = buildCitationIndex(
      [chunk({ source_id: "a", source_title: "a".repeat(32), chunk_content: "x".repeat(200) })],
      [],
    );
    expect(i.entries[0].title.length).toBeLessThanOrEqual(60);
    expect(i.entries[0].title.endsWith("…")).toBe(true);
  });

  it("does not mistake a short hex word for a hash", () => {
    const i = buildCitationIndex(
      [chunk({ source_id: "a", source_title: "beef" })],
      [],
    );
    expect(i.entries[0].title).toBe("beef");
  });
});
