/**
 * XSS regression for the FULL pipeline after adding citation linking.
 * inlineMarkdown is the real renderer from lib/markdown; linkCitations is the
 * real module. This proves the added stage cannot introduce markup.
 */
import { describe, expect, it } from "vitest";
import { linkCitations } from "@/lib/citationMarkup";
import { inlineMarkdown } from "@/lib/markdown";

/** Full pipeline: render, then link citations. */
const render = (s: string, maxRef = 5) => linkCitations(inlineMarkdown(s), maxRef);

const ALLOWED = /^\/?(?:code|strong|em|a|button)\b/i;
function unsafe(html: string): string[] {
  const p: string[] = [];
  for (const m of html.matchAll(/<([^>]*)>/g)) if (!ALLOWED.test(m[1]!)) p.push(`tag: ${m[0]}`);
  for (const m of html.matchAll(/href="([^"]*)"/g)) if (!/^https?:\/\//i.test(m[1]!)) p.push(`href: ${m[1]}`);
  for (const m of html.matchAll(/<[^>]*\son\w+\s*=[^>]*>/gi)) p.push(`handler: ${m[0]}`);
  // data-cite must only ever be a plain integer
  for (const m of html.matchAll(/data-cite="([^"]*)"/g)) if (!/^\d+$/.test(m[1]!)) p.push(`data-cite: ${m[1]}`);
  return p;
}

const attacks: [string, string][] = [
  ["script tag", "<script>alert(1)</script> [1]"],
  ["javascript url", "[x](javascript:alert(1)) [1]"],
  ["attr breakout via marker", '[1" onerror="alert(1)]'],
  ["fake data-cite", '[1] <button data-cite="x&quot; onerror=alert(1)">'],
  ["marker inside code", "`array[1]` and [2]"],
  ["marker inside link text", "[see [1]](https://x.com)"],
  ["huge ref", "[99999999]"],
  ["negative-looking", "[-1] [0]"],
  ["replacement pattern", "[1] $& $` $'"],
  ["nested brackets", "[[1]] [[[2]]]"],
  ["img onerror near marker", "<img src=x onerror=alert(1)> [1]"],
  ["svg onload in bold", "**<svg onload=alert(1)>** [1]"],
  ["entity double encode", "&lt;script&gt; [1]"],
  ["unicode digits", "[١]"],
];

describe("XSS after citation linking", () => {
  it.each(attacks)("neutralises %s", (_n, input) => {
    expect(unsafe(render(input))).toEqual([]);
  });
  it("still links legitimate citations", () => {
    expect(render("see [1] and [2]")).toContain('data-cite="1"');
  });
  it("still renders normal markdown", () => {
    const out = render("**a** [x](https://b) `c`");
    expect(out).toContain("<strong>a</strong>");
    expect(out).toContain('href="https://b"');
  });
});
