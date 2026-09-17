/**
 * Harness proof + XSS regression pin for the answer renderer.
 *
 * `markdownToHtml` output goes through `dangerouslySetInnerHTML` on the chat
 * page and renders LLM text, which can quote documents other people wrote into
 * the indexed corpus. So the renderer is a trust boundary.
 *
 * Two properties keep it safe, and both are easy to break by accident:
 *   1. `escapeHtml` runs FIRST, so later replacements only ever see escaped
 *      text and cannot reintroduce a tag.
 *   2. The link rule hardcodes `https?://`, so no other scheme reaches an href.
 *
 * These tests assert the OUTPUT, not the implementation: no tag outside the
 * small allowed set, no non-http href, no event-handler attribute. That way a
 * future rewrite is free to change the internals and still be held to the
 * property that matters.
 *
 * The renderer is imported from lib/markdown, the real module the chat page
 * uses. A test can never pass against a stale copy of the escaping logic.
 */
import { describe, expect, it } from "vitest";
import { inlineMarkdown } from "./markdown";

/** Tags the renderer is allowed to emit. Anything else is an injection. */
const ALLOWED_TAG = /^\/?(?:code|strong|em|a)\b/i;

function unsafeBits(html: string): string[] {
  const problems: string[] = [];
  for (const m of html.matchAll(/<([^>]*)>/g)) {
    if (!ALLOWED_TAG.test(m[1]!)) problems.push(`unexpected tag: ${m[0]}`);
  }
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    if (!/^https?:\/\//i.test(m[1]!)) problems.push(`bad href: ${m[1]}`);
  }
  for (const m of html.matchAll(/<[^>]*\son\w+\s*=[^>]*>/gi)) {
    problems.push(`event handler: ${m[0]}`);
  }
  return problems;
}

describe("inlineMarkdown", () => {
  const attacks: [name: string, input: string][] = [
    ["script tag", "<script>alert(1)</script>"],
    ["javascript: url", "[x](javascript:alert(1))"],
    ["case-variant scheme", "[x](JaVaScRiPt:alert(1))"],
    ["data: url", "[x](data:text/html,<script>alert(1)</script>)"],
    ["vbscript: url", "[x](vbscript:alert(1))"],
    ["attribute breakout", '[x](https://a" onmouseover="alert(1))'],
    ["onerror in code span", "`<img src=x onerror=alert(1)>`"],
    ["svg onload in bold", "**<svg onload=alert(1)>**"],
    ["trailing attribute", '[x](https://a)" onerror="alert(1)'],
    ["img in link text", "[<img src=x onerror=alert(1)>](https://a)"],
    ["replacement pattern $&", "[x](https://a$&)"],
    ["replacement pattern $`", "[x](https://a$`)"],
    ["replacement pattern $'", "[x](https://a$')"],
    ["entity double-encoding", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["tab in url", "[x](https://a\t onload=x)"],
    ["leading space scheme", "[x](  javascript:alert(1))"],
  ];

  it.each(attacks)("neutralises %s", (_name, input) => {
    expect(unsafeBits(inlineMarkdown(input))).toEqual([]);
  });

  it("still renders the markdown it is supposed to", () => {
    const out = inlineMarkdown("**a** [x](https://b) `c` *d*");
    expect(out).toContain("<strong>a</strong>");
    expect(out).toContain('href="https://b"');
    expect(out).toMatch(/<code class="[^"]*">c<\/code>/);
    expect(out).toContain("<em>d</em>");
  });

  it("escapes before transforming, so raw markup never survives", () => {
    expect(inlineMarkdown("<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
});
