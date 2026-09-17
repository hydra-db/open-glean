/** The numbering case that used to break: many chunks, few documents. */
import { describe, expect, it } from "vitest";
import { buildCitationIndex, renderContext } from "@/lib/citations";
import { linkCitations } from "@/lib/citationMarkup";
import type { SearchChunk } from "@/lib/types";

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
});
