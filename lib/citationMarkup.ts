/**
 * Turn `[n]` markers in a rendered answer into clickable citations.
 *
 * SECURITY. This runs inside the pipeline that feeds `dangerouslySetInnerHTML`,
 * on text that `escapeHtml` already processed. Two properties keep it safe, and
 * both are load-bearing:
 *
 *   1. The only value interpolated into the output is a number this function
 *      parses itself. No attacker-controlled text reaches an attribute.
 *   2. It refuses to match inside an existing tag, so it cannot nest an
 *      element inside an anchor or a code span.
 *
 * Markers above `maxRef` stay plain text. If the model cites `[7]` when four
 * sources exist, show inert text rather than a link to nothing.
 */

/** Class applied to a resolved citation marker. */
const CITE_CLS =
  "cursor-pointer rounded-sm px-0.5 font-medium text-text-3 hover:bg-white/10";

/**
 * @param html   answer HTML, already escaped and inline-rendered
 * @param maxRef highest citation number that has a card
 */
export function linkCitations(html: string, maxRef: number): string {
  if (maxRef < 1) return html;

  // Split on tags so replacement only touches text nodes, and track which
  // element we are inside. Text nodes alone are not enough: `[1]` in
  // <code>array[1]</code> is a subscript, not a citation, and a marker inside
  // an anchor's text would nest a button in a link.
  const SKIP_INSIDE = new Set(["code", "pre", "a", "button"]);
  let depth = 0;

  return html
    .split(/(<[^>]*>)/)
    .map((segment, i) => {
      // Odd indices are the tags themselves.
      if (i % 2 === 1) {
        const m = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(segment);
        if (m) {
          const [, closing, tag] = m;
          if (SKIP_INSIDE.has(tag.toLowerCase())) {
            if (closing) depth = Math.max(0, depth - 1);
            else if (!/\/>$/.test(segment)) depth += 1;
          }
        }
        return segment;
      }
      if (depth > 0) return segment;
      return segment.replace(/\[(\d{1,3})\]/g, (whole, digits: string) => {
        const ref = Number(digits);
        if (!Number.isInteger(ref) || ref < 1 || ref > maxRef) return whole;
        // `ref` is a validated integer, so this attribute cannot carry
        // attacker input.
        return `<button type="button" data-cite="${ref}" class="${CITE_CLS}">[${ref}]</button>`;
      });
    })
    .join("");
}
