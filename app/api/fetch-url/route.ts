/**
 * POST /api/fetch-url
 *
 * Server-side fetch of a user-supplied URL for the "Webpage" ingest tab:
 * downloads the HTML, extracts the <title>, strips scripts/styles/markup and
 * returns plain text that the client then saves as a memory via Hydra DB.
 *
 * Body:     { url: string }
 * Success:  { title?: string, text: string }
 * Failure:  { error: string }   (4xx/5xx, with a human-readable message)
 */
import { NextRequest, NextResponse } from "next/server";
import { assertPublicHost, fetchPinned } from "@/lib/safeFetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 10_000;
const MAX_TEXT = 200_000;

const UA = "Mozilla/5.0 (compatible; OpenGlean/1.0)";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Largest input the tag-stripping regexes will read.
 *
 * A lazy `[\s\S]*?` between a tag pair backtracks quadratically when the
 * closing tag is missing, so an attacker-controlled page of repeated `<script`
 * openers froze this single-threaded server for over a minute. The patterns
 * below no longer backtrack, and this bound keeps the cost linear in a size we
 * choose rather than one the remote page chooses.
 */
const MAX_PARSE_CHARS = 400_000;

function extractTitle(html: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html.slice(0, MAX_PARSE_CHARS));
  if (!m) return "";
  return decodeEntities(m[1].replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Remove a paired tag and everything between it, by scanning.
 *
 * A regex cannot do this safely. Every pattern that spans an opening and a
 * closing tag backtracks, and a page of repeated openers with no closer costs
 * quadratic time. This scan is linear: it finds each opener, finds its closer,
 * and skips the span. Text after an unterminated opener is dropped, which is
 * what a browser does with an unclosed script as well.
 */
export function stripTagPair(html: string, tag: string): string {
  const open = `<${tag}`;
  const closePrefix = `</${tag}`;
  const hay = html.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const start = findOpener(hay, open, i);
    if (start < 0) return out + html.slice(i);
    out += html.slice(i, start);
    const closeStart = hay.indexOf(closePrefix, start);
    if (closeStart < 0) return out; // unterminated: drop the remainder
    // Accept `</tag>` and `</tag >` and `</tag\n>`: skip whitespace to the `>`.
    let j = closeStart + closePrefix.length;
    while (j < hay.length && /\s/.test(hay[j]!)) j++;
    if (hay[j] !== ">") {
      // A closer prefix that is not really a closing tag, e.g. `</scripting`.
      i = closeStart + closePrefix.length;
      continue;
    }
    i = j + 1;
    out += " ";
  }
}

/**
 * Find `<tag` only where the next character ends the tag name.
 *
 * Without the boundary check, `<script` also matched `<scripting>`, so a page
 * with an unrelated tag such as `<scripting>` lost all its text.
 */
function findOpener(hay: string, open: string, from: number): number {
  for (let at = hay.indexOf(open, from); at >= 0; at = hay.indexOf(open, at + 1)) {
    const next = hay[at + open.length];
    if (next === undefined || next === ">" || next === "/" || /\s/.test(next)) {
      return at;
    }
  }
  return -1;
}

function htmlToText(html: string): string {
  let stripped = html.slice(0, MAX_PARSE_CHARS);
  for (const tag of ["script", "style", "noscript"]) {
    stripped = stripTagPair(stripped, tag);
  }
  stripped = stripped
    .replace(/<\/(p|div|section|article|h[1-6]|li|br|tr|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export async function POST(req: NextRequest) {
  let url: string;
  try {
    const body = await req.json();
    url = typeof body?.url === "string" ? body.url.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!url) {
    return NextResponse.json({ error: "Missing url in request body." }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "That doesn't look like a valid URL." }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return NextResponse.json({ error: "Only http(s) URLs are supported." }, { status: 400 });
  }

  // This route returns the fetched body to the caller, so it is a read
  // primitive for anything the server can reach. Resolve the host and reject
  // private addresses before fetching.
  let validated: string[];
  try {
    validated = await assertPublicHost(parsed.hostname);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "That URL is not allowed." },
      { status: 400 },
    );
  }

  try {
    // Pin the connection to the address we validated. A plain fetch resolves the
    // host a second time, which a short-TTL rebinding record can flip to a
    // private IP between the check above and the fetch. Redirects are not
    // followed: the host was checked, but a 3xx to 169.254.169.254 would go to
    // an unchecked destination.
    const res = await fetchPinned(parsed, validated[0]!, {
      timeoutMs: TIMEOUT_MS,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });

    if (res.status >= 300 && res.status < 400) {
      return NextResponse.json(
        { error: "That page redirected, which is not allowed here." },
        { status: 400 },
      );
    }

    if (res.status < 200 || res.status >= 300) {
      return NextResponse.json(
        { error: `The page responded with HTTP ${res.status}.` },
        { status: 502 },
      );
    }

    const html = res.body;
    const text = htmlToText(html).slice(0, MAX_TEXT);
    if (!text) {
      return NextResponse.json(
        { error: "The page didn't return any readable text." },
        { status: 422 },
      );
    }

    return NextResponse.json({ title: extractTitle(html), text });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return NextResponse.json(
      {
        error: timedOut
          ? "The page took too long to respond (10s timeout)."
          : "Failed to fetch that page — it may be blocking automated requests.",
      },
      { status: 502 },
    );
  }
}