/**
 * Deep Research — plan generation and DAG layering.
 *
 * The planner asks the model for a small dependency graph of sub-questions.
 * `layerPlan` then turns that graph into execution levels: every node in a
 * level is independent of its siblings, so a level can be fanned out to Hydra
 * in parallel. That parallelism is the whole point of planning a DAG rather
 * than a list.
 */
import type { LeveledNode, ResearchNode, ResearchPlan } from "./types";

/** Hard ceilings — a runaway plan burns tokens and wall-clock for no gain. */
export const MAX_NODES = 8;
export const MAX_LEVELS = 4;

export function planPrompt(question: string, maxNodes = MAX_NODES): string {
  return [
    "You are the planning stage of a retrieval pipeline over a private knowledge base",
    "(chat messages, documents, tickets, wiki pages).",
    "",
    `Break the user's question into at most ${maxNodes} sub-questions, each phrased as a`,
    "standalone search query that would retrieve useful passages on its own.",
    "",
    "Express dependencies with `dependsOn`. A sub-question should depend on another ONLY",
    "when it genuinely cannot be written without that answer (e.g. it must name something",
    "the earlier question discovers). Independent sub-questions run in parallel, so prefer",
    "a wide, shallow graph — depth costs latency.",
    "",
    "Rules:",
    "- ids are q1, q2, q3 … and dependsOn may only reference earlier ids.",
    "- No cycles. Most graphs should be 1-2 levels deep.",
    "- If the question is simple, a single node is the correct answer.",
    "- Sub-questions must be self-contained: no pronouns referring to other nodes.",
    "",
    "Respond with ONLY a JSON object, no prose and no code fence:",
    '{"objective":"<restate the question>","nodes":[{"id":"q1","question":"…","rationale":"…","dependsOn":[]}]}',
    "",
    `User question: ${question}`,
  ].join("\n");
}

/**
 * Pull a plan out of a model response.
 *
 * Models wrap JSON in prose or fences even when told not to, so this scans for
 * the outermost balanced object rather than trusting the whole string.
 */
export function parsePlan(raw: string): ResearchPlan | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];

  const nodes: ResearchNode[] = [];
  const seen = new Set<string>();
  for (const n of rawNodes) {
    if (!n || typeof n !== "object") continue;
    const node = n as Record<string, unknown>;
    const question = typeof node.question === "string" ? node.question.trim() : "";
    if (!question) continue;
    const id =
      typeof node.id === "string" && node.id.trim()
        ? node.id.trim()
        : `q${nodes.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id,
      question,
      rationale:
        typeof node.rationale === "string" && node.rationale.trim()
          ? node.rationale.trim()
          : undefined,
      dependsOn: Array.isArray(node.dependsOn)
        ? node.dependsOn.filter((d): d is string => typeof d === "string")
        : [],
    });
    if (nodes.length >= MAX_NODES) break;
  }
  if (nodes.length === 0) return null;

  // Drop edges to ids the planner invented or that we truncated away, so a
  // bad reference degrades to "no dependency" instead of stalling the level.
  const valid = new Set(nodes.map((n) => n.id));
  for (const n of nodes) n.dependsOn = n.dependsOn.filter((d) => valid.has(d) && d !== n.id);

  const objective =
    typeof obj.objective === "string" && obj.objective.trim()
      ? obj.objective.trim()
      : undefined;
  return { objective: objective ?? "", nodes };
}

/** Scan for the first balanced `{...}`, ignoring braces inside strings. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Assign each node an execution level (Kahn's algorithm).
 *
 * A node's level is one past its deepest dependency, so every node in a level
 * is mutually independent and safe to run concurrently. Nodes still unresolved
 * when no progress can be made are part of a cycle — they are flattened onto
 * the next level with their edges dropped rather than deadlocking the run.
 */
export function layerPlan(nodes: ResearchNode[]): LeveledNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const level = new Map<string, number>();
  let remaining = nodes.filter((n) => !level.has(n.id));

  while (remaining.length > 0) {
    const ready = remaining.filter((n) =>
      n.dependsOn.every((d) => !byId.has(d) || level.has(d)),
    );
    if (ready.length === 0) {
      // Cycle (or a dependency on a dropped node): break it deterministically.
      const fallback = Math.max(-1, ...level.values()) + 1;
      for (const n of remaining) level.set(n.id, fallback);
      break;
    }
    for (const n of ready) {
      const deps = n.dependsOn.map((d) => level.get(d) ?? -1);
      level.set(n.id, deps.length === 0 ? 0 : Math.max(...deps) + 1);
    }
    remaining = remaining.filter((n) => !level.has(n.id));
  }

  return nodes
    .map((n) => ({ ...n, level: Math.min(level.get(n.id) ?? 0, MAX_LEVELS - 1) }))
    .sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
}

/** Group leveled nodes into execution waves. */
export function groupByLevel(nodes: LeveledNode[]): LeveledNode[][] {
  const max = nodes.reduce((m, n) => Math.max(m, n.level), 0);
  const out: LeveledNode[][] = [];
  for (let i = 0; i <= max; i++) {
    const wave = nodes.filter((n) => n.level === i);
    if (wave.length > 0) out.push(wave);
  }
  return out;
}

/** Single-node fallback when planning fails or returns nothing usable. */
export function trivialPlan(question: string): ResearchPlan {
  return {
    objective: question,
    nodes: [{ id: "q1", question, dependsOn: [] }],
  };
}
