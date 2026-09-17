/**
 * Make a stored source body readable.
 *
 * Connector sources are often a JSON envelope rather than prose. Slack, for
 * example, keeps the thread under `app_comments[].body`. This function extracts
 * the human-written text when it recognises the shape. If it finds no text, it
 * returns pretty-printed JSON. If the input was never JSON, it returns the text
 * unchanged.
 *
 * This function is shared, not private to SourcesPanel, because the Context
 * view needs the same treatment.
 */
export function readableBody(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const bodies: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || bodies.length > 200) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (!v || typeof v !== "object") return;
    const rec = v as Record<string, unknown>;
    const body = rec.body ?? rec.text ?? rec.message;
    if (typeof body === "string" && body.trim()) {
      const author = typeof rec.author === "string" ? rec.author : undefined;
      bodies.push(author ? `${author}: ${body.trim()}` : body.trim());
    }
    for (const value of Object.values(rec)) walk(value, depth + 1);
  };
  walk(parsed, 0);
  if (bodies.length > 0) return [...new Set(bodies)].join("\n\n");
  return JSON.stringify(parsed, null, 2);
}
