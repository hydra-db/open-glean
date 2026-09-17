/**
 * Turning [n] markers into clickable citations (C1, second half).
 *
 * No linking has ever existed. inlineMarkdown only matched `[text](url)`, so a
 * bare `[5]` survived escaping as literal text and the sources panel it refers
 * to was unreachable from the answer.
 *
 * This runs INSIDE the renderer that the XSS suite covers, so the tests below
 * carry that burden too: the marker transform must not become a way to inject
 * markup. It runs on already-escaped text and emits a fixed element shape with
 * a numeric attribute, which is why nothing here can carry attacker content.
 */
import { describe, expect, it } from "vitest";
import { linkCitations } from "./citationMarkup";

describe("linkCitations", () => {
  it("links a marker that has a matching source", () => {
    const out = linkCitations("see [1] for detail", 3);
    expect(out).toContain('data-cite="1"');
    expect(out).toContain(">[1]<");
  });

  it("links every marker in a run", () => {
    const out = linkCitations("both [1] and [2] agree", 2);
    expect(out).toContain('data-cite="1"');
    expect(out).toContain('data-cite="2"');
  });

  it("leaves an unresolvable marker as plain text", () => {
    // The model citing [7] when 4 sources exist must not render a dead link.
    const out = linkCitations("claim [7] here", 4);
    expect(out).not.toContain("data-cite");
    expect(out).toBe("claim [7] here");
  });

  it("leaves [0] alone", () => {
    expect(linkCitations("nothing [0] here", 3)).not.toContain("data-cite");
  });

  it("does not touch a markdown link that was already rendered", () => {
    // By this point inlineMarkdown has produced an anchor; the [n] rule must
    // not reach inside it and nest an element in its text.
    const rendered = '<a href="https://x.com" class="c">[1]</a>';
    expect(linkCitations(rendered, 3)).toBe(rendered);
  });

  it("does not link inside a code span", () => {
    const rendered = '<code class="c">array[1]</code>';
    expect(linkCitations(rendered, 3)).toBe(rendered);
  });

  it("handles no sources at all", () => {
    expect(linkCitations("text [1]", 0)).toBe("text [1]");
  });

  it("ignores array-like syntax that is not a lone number", () => {
    expect(linkCitations("items[0] and x[i]", 5)).not.toContain("data-cite");
  });

  it("emits no attacker-controlled content", () => {
    // The transform runs on escaped text and the only variable in the output
    // is a number it parsed itself.
    const out = linkCitations("&lt;script&gt; [1]", 2);
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script");
  });

  it("cannot be tricked into emitting a quote that breaks the attribute", () => {
    // `"` is already `&quot;` after escaping, and the number is the only thing
    // interpolated, so there is no path to attribute breakout.
    const out = linkCitations('&quot;onerror=x [1]', 2);
    expect(out).not.toMatch(/<[^>]*\sonerror\s*=/i);
  });
});
