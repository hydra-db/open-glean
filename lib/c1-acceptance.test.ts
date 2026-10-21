/** The numbering case that used to break: many chunks, few documents. */
import { describe, expect, it } from "vitest";
import { buildCitationIndex, renderContext } from "@/lib/citations";
import { linkCitations } from "@/lib/citationMarkup";
import { buildLlmMessages } from "@/lib/qa";
import type { AppConfig, SearchChunk, WebCitation } from "@/lib/types";

const c = (id: string, body: string) =>
  ({ source_id: id, source_title: `Doc ${id}`, chunk_content: body }) as SearchChunk;

describe("C1 acceptance", () => {
  it("8 chunks from 4 documents give the model exactly 4 numbers", () => {
    // MAX_RESULTS is 8 chunks, commonly from about 4 documents. The prompt
    // used to say [1] to [8] while the panel showed cards 1 to 4.
    const chunks = ["a","a","b","b","c","c","d","d"].map((id,i)=>c(id,`body${i}`));
    const index = buildCitationIndex(chunks, []);
    expect(index.maxRef).toBe(4);
    const ctx = renderContext(index);
    expect(ctx).toContain("[4]");
    expect(ctx).not.toContain("[5]");
  });

  it("every [n] the model can emit resolves to a card", () => {
    const chunks = ["a","a","b"].map((id,i)=>c(id,`b${i}`));
    const index = buildCitationIndex(chunks, []);
    const answer = linkCitations("per [1] and [2]", index.maxRef);
    expect(answer).toContain('data-cite="1"');
    expect(answer).toContain('data-cite="2"');
  });

  it("an over-cited number stays inert rather than linking to nothing", () => {
    const index = buildCitationIndex([c("a","x")], []);
    expect(linkCitations("claim [5]", index.maxRef)).not.toContain("data-cite");
  });

  it("instructs web-search runs to continue [n] numbering after Hydra sources instead of [Web 1]", () => {
    const chunks = [c("a", "alpha"), c("a", "alpha-2"), c("b", "beta")];
    const msgs = buildLlmMessages(
      { query: "latest status?", webSearch: true },
      {} as AppConfig,
      chunks,
      [],
    );
    const systemPrompt = msgs.find((m) => m.role === "system")?.content ?? "";
    expect(systemPrompt).not.toContain("[Web 1]");
    expect(systemPrompt).toContain("[1]..[2]");
    expect(systemPrompt).toContain("[3]");
  });

  it("resolves both sequential [n] and fallback [Web k] to the same web source card", () => {
    const chunks = [c("a", "alpha"), c("b", "beta")];
    const web: WebCitation[] = [{ url: "https://example.com", title: "Example" }];
    const index = buildCitationIndex(chunks, web);
    expect(index.hydraCount).toBe(2);
    expect(index.maxRef).toBe(3);

    const linkedSequential = linkCitations("from [1] and [3]", index.maxRef, index.hydraCount);
    const linkedWebPrefix = linkCitations("from [1] and [Web 1]", index.maxRef, index.hydraCount);
    expect(linkedSequential).toContain('data-cite="3"');
    expect(linkedSequential).toContain(">[3]</button>");
    expect(linkedWebPrefix).toContain('data-cite="3"');
    expect(linkedWebPrefix).toContain(">[3]</button>");
    expect(linkedWebPrefix).toBe(linkedSequential);
  });
});
