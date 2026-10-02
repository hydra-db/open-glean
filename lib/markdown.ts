/**
 * Markdown-lite renderer for assistant answers.
 *
 * The output is injected as HTML, so escaping is the security boundary. Every
 * user- or model-supplied string is passed through escapeHtml before any tag
 * is added, and links accept only http(s). This module is the single source of
 * that logic — the chat page and the XSS regression tests both import it, so a
 * test can never pass against a stale copy of the renderer.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CODE_CLS =
  "rounded-sm border border-line bg-inset px-1 py-0.5 font-mono text-[12px] text-text-1";
const CODE_BLOCK_CLS =
  "my-2 block overflow-x-auto rounded-sm border border-line bg-inset px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-fg-2";
const LINK_CLS =
  "text-text-1 underline decoration-white/30 underline-offset-2 hover:decoration-white/70";

export function inlineMarkdown(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/`([^`\n]+)`/g, `<code class="${CODE_CLS}">$1</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*`])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    `<a href="$2" target="_blank" rel="noreferrer" class="${LINK_CLS}">$1</a>`,
  );
  return out;
}

/** ~80-line markdown-lite renderer: code blocks, inline code, bold/italic,
 *  links, headings, bullets/numbered lists, paragraphs. Input is escaped. */
export function markdownToHtml(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  let inCode = false;
  let codeBuf: string[] = [];

  const flushList = () => {
    if (!list) return;
    const tag = list.type;
    out.push(
      `<${tag} class="my-1.5 list-inside space-y-0.5">` +
        list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join("") +
        `</${tag}>`,
    );
    list = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushList();
      if (inCode) {
        out.push(
          `<pre class="${CODE_BLOCK_CLS}">${escapeHtml(codeBuf.join("\n"))}</pre>`,
        );
        codeBuf = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList();
      const lvl = heading[1]!.length;
      const cls =
        lvl === 1
          ? "mt-3 mb-1.5 text-[16px] font-bold text-fg"
          : lvl === 2
            ? "mt-3 mb-1 text-[15px] font-semibold text-fg"
            : "mt-2 mb-0.5 text-[14px] font-semibold text-fg";
      out.push(`<h${lvl} class="${cls}">${inlineMarkdown(heading[2]!)}</h${lvl}>`);
      continue;
    }

    if (/^\s*---+$/.test(line.trim())) {
      flushList();
      out.push('<hr class="my-3 border-line" />');
      continue;
    }

    if (!line.trim()) {
      flushList();
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul && !list) list = { type: "ul", items: [] };
    else if (ol && !list) list = { type: "ol", items: [] };

    if (ul && list?.type === "ul") {
      list.items.push(ul[1]!);
      continue;
    }
    if (ol && list?.type === "ol") {
      list.items.push(ol[1]!);
      continue;
    }

    flushList();
    out.push(`<p>${inlineMarkdown(line.trim())}</p>`);
  }
  flushList();
  if (inCode) {
    out.push(
      `<pre class="${CODE_BLOCK_CLS}">${escapeHtml(codeBuf.join("\n"))}</pre>`,
    );
  }
  return out.join("");
}
