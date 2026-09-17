/**
 * Deep Research — the orchestrator.
 *
 * Pipeline:
 *   1. plan     — the model writes a DAG of sub-questions
 *   2. layer    — Kahn's algorithm turns the DAG into parallel execution waves
 *   3. execute  — each wave fans out to Hydra concurrently; per-node findings
 *                 are synthesised and fed forward as context to the next wave
 *   4. dedup    — sources are merged across every node into one globally
 *                 numbered citation list
 *   5. answer   — the final answer streams, grounded in the deduped sources
 *
 * Progress is reported as NDJSON `ResearchPacket`s so the UI can render the
 * timeline live. Orchestration lives on the server: the fan-out is a tight
 * concurrent loop that would be far slower and chattier driven from a browser.
 */
import { NextRequest } from "next/server";
import { HydraDB } from "@/lib/hydra";
import { getSession } from "@/lib/session";
import { complete, resolveLlmCreds, streamDeltas, type LlmCreds } from "@/lib/llmServer";
import { assertSafeLlmUrl } from "@/lib/safeUrl";
import { CapacityError, researchGuard } from "@/lib/spendGuard";
import {
  groupByLevel,
  layerPlan,
  parsePlan,
  planPrompt,
  trivialPlan,
} from "@/lib/research/planner";
import type {
  LeveledNode,
  NodeFinding,
  ResearchPacket,
  ResearchSource,
} from "@/lib/research/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Retrieval breadth per sub-question. Kept modest — the DAG supplies breadth. */
const PER_NODE_RESULTS = 6;
/** Chunk text kept per deduped source when grounding the final answer. */
const EXCERPT_CHARS = 1200;
/** Total context ceiling for the final synthesis prompt. */
const MAX_ANSWER_CONTEXT = 24_000;
const FINDING_CHARS = 700;

function bad(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  let body: {
    query?: string;
    database?: string;
    collection?: string;
    collections?: string[];
    kind?: "all" | "knowledge" | "memory";
    llm?: { apiKey?: string; baseUrl?: string; model?: string };
  };
  try {
    body = await req.json();
  } catch {
    return bad("Invalid JSON body", 400);
  }

  const query = body.query?.trim();
  if (!query) return bad("Missing query", 400);

  let creds;
  try {
    creds = await resolveLlmCreds(body.llm);
  } catch (err) {
    // A rejected base URL (SSRF guard) — surface it as a 400, not a 500.
    return bad(err instanceof Error ? err.message : "Invalid LLM base URL.", 400);
  }
  if (!creds) {
    return bad(
      "Deep Research needs an LLM provider — add one in Settings. It plans the sub-questions and writes the answer.",
      400,
    );
  }

  // Hydra credentials: per-request header first (same contract as the
  // /api/hydra proxy), then session cookie, then deployment-level env. The
  // browser's useResearch posts no key today, but accepting the header keeps
  // this route consistent — and testable — without changing its behavior.
  const auth = req.headers.get("authorization") ?? "";
  const headerKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  let hydraKey = headerKey;
  // A caller-supplied base URL is honoured only when the caller also brings
  // its own key. Seeding it from the header first (as this did) meant a
  // request with no Authorization could pair an attacker's host with the
  // stored or deployment key. Same defect as the hydra proxy.
  let hydraBaseUrl: string | undefined = headerKey
    ? req.headers.get("x-hydra-base-url")?.trim() || undefined
    : undefined;
  try {
    const session = await getSession();
    if (!hydraKey) hydraKey = session.hydraKey?.trim() ?? "";
    if (!hydraBaseUrl) hydraBaseUrl = session.hydraBaseUrl;
  } catch {
    // fall through to env
  }
  if (!hydraKey) hydraKey = process.env.HYDRA_API_KEY?.trim() ?? "";
  if (!hydraBaseUrl) hydraBaseUrl = process.env.HYDRA_BASE_URL;
  if (!hydraKey) return bad("No Hydra API key configured.", 401);
  if (hydraBaseUrl) {
    try {
      assertSafeLlmUrl(hydraBaseUrl);
    } catch (err) {
      return bad(err instanceof Error ? err.message : "Invalid Hydra base URL.", 400);
    }
  }

  const database = body.database?.trim();
  if (!database) return bad("No database selected.", 400);

  const hydra = new HydraDB({
    token: hydraKey,
    database,
    baseUrl: hydraBaseUrl,
    // Sub-question fan-out multiplies latency; give each call room.
    timeoutSeconds: 40,
  });

  // Bound the number of concurrent runs. One request can cost ~18 LLM calls
  // plus 8 graph-enabled queries against the deployment's own keys, and this
  // route needs no credentials of the caller's own.
  let release: () => void;
  try {
    release = researchGuard.acquire();
  } catch (err) {
    if (err instanceof CapacityError) return bad(err.message, 429);
    throw err;
  }

  const controller = new AbortController();
  req.signal.addEventListener("abort", () => controller.abort());

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let closed = false;
      const send = (packet: ResearchPacket) => {
        if (closed) return;
        try {
          ctrl.enqueue(encoder.encode(`${JSON.stringify(packet)}\n`));
        } catch {
          // The consumer went away. Stop writing rather than throwing out of
          // runResearch into the catch below, which would then call send()
          // again and throw a second time as an unhandled rejection.
          closed = true;
        }
      };

      try {
        await runResearch({
          query,
          hydra,
          creds,
          kind: body.kind ?? "all",
          collection: body.collection,
          collections: body.collections,
          signal: controller.signal,
          send,
          startedAt,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Deep Research failed unexpectedly.";
        // A mid-run failure still reports as a packet so the UI can show it in
        // place rather than the fetch simply dying.
        send({ type: "error", message });
      } finally {
        closed = true;
        release();
        try {
          ctrl.close();
        } catch {
          // Already closed by a cancelled consumer.
        }
      }
    },
    cancel() {
      // The consumer disconnected before start() finished. Abort the work so
      // it stops spending, and free the slot.
      controller.abort();
      release();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

// ── Pipeline ──────────────────────────────────────────────────────

interface RunOpts {
  query: string;
  hydra: HydraDB;
  creds: LlmCreds;
  kind: "all" | "knowledge" | "memory";
  collection?: string;
  collections?: string[];
  signal: AbortSignal;
  send: (p: ResearchPacket) => void;
  startedAt: number;
}

async function runResearch(opts: RunOpts): Promise<void> {
  const { query, creds, signal, send } = opts;

  // 1. Plan ────────────────────────────────────────────────────────
  let plan = trivialPlan(query);
  try {
    const raw = await complete(
      creds,
      [{ role: "user", content: planPrompt(query) }],
      { temperature: 0.1, maxTokens: 900, signal },
    );
    const parsed = parsePlan(raw);
    if (parsed) plan = { objective: parsed.objective || query, nodes: parsed.nodes };
  } catch {
    // Planning is best-effort: a failure degrades to a single-node run rather
    // than aborting, which still produces a useful answer.
  }

  const leveled = layerPlan(plan.nodes);
  const waves = groupByLevel(leveled);
  send({ type: "plan", plan: { ...plan, nodes: leveled }, levels: waves.length });

  // 2-3. Execute waves ─────────────────────────────────────────────
  const sources = new SourceRegistry();
  const findings: NodeFinding[] = [];
  let chunksRetrieved = 0;

  for (let level = 0; level < waves.length; level++) {
    if (signal.aborted) return;
    const wave = waves[level];
    send({ type: "level_start", level, nodeIds: wave.map((n) => n.id) });

    // Every node in a wave is independent by construction — run them together.
    const results = await Promise.allSettled(
      wave.map((node) =>
        runNode({ node, priorFindings: findings, sources, opts }),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const node = wave[i];
      const r = results[i];
      if (r.status === "fulfilled") {
        chunksRetrieved += r.value.chunkCount;
        findings.push(r.value.finding);
      } else {
        const message =
          r.reason instanceof Error ? r.reason.message : "Sub-question failed.";
        // One failed branch must not sink the run — the rest still answer.
        send({ type: "node_error", id: node.id, message });
      }
    }
    send({ type: "level_done", level });
  }

  if (signal.aborted) return;

  // 4. Deduped, globally numbered sources ──────────────────────────
  const ordered = sources.ordered();
  send({ type: "sources", sources: ordered });

  // 5. Final answer ────────────────────────────────────────────────
  const messages = buildAnswerMessages(query, plan.objective, findings, ordered);
  await streamDeltas(
    creds,
    messages,
    (text) => send({ type: "answer_delta", text }),
    { temperature: 0.3, maxTokens: 1600, signal },
  );

  send({
    type: "done",
    stats: {
      nodes: leveled.length,
      levels: waves.length,
      chunksRetrieved,
      sourcesUsed: ordered.length,
      elapsedMs: Date.now() - opts.startedAt,
    },
  });
}

/** Retrieve for one sub-question, then synthesise a short finding. */
async function runNode({
  node,
  priorFindings,
  sources,
  opts,
}: {
  node: LeveledNode;
  priorFindings: NodeFinding[];
  sources: SourceRegistry;
  opts: RunOpts;
}): Promise<{ finding: NodeFinding; chunkCount: number }> {
  const { hydra, creds, send, signal } = opts;
  // The wave dispatches every node at once, so the caller's abort check only
  // runs between waves. Without this, disconnecting mid-wave still paid for up
  // to 8 nodes of LLM and retrieval work.
  if (signal.aborted) throw new Error("Run aborted.");
  send({ type: "node_start", id: node.id });

  // A dependent node was planned knowing only that an answer would exist, so
  // hand it what its dependencies actually found before it queries.
  const deps = priorFindings.filter((f) => node.dependsOn.includes(f.id));
  const question =
    deps.length > 0
      ? await refineQuestion(creds, node.question, deps, signal)
      : node.question;

  const scope =
    opts.collections && opts.collections.length > 0
      ? { collections: opts.collections }
      : opts.collection
        ? { collection: opts.collection }
        : {};

  const raw = await hydra.query(
    {
      query: question,
      kind: opts.kind,
      maxResults: PER_NODE_RESULTS,
      mode: "thinking",
      graphContext: true,
      // Most Open Glean corpora are connector-synced (Slack, tickets, wiki), where
      // the app-aware lane materially improves recall on entity-ish queries.
      queryApps: true,
      ...scope,
    },
    { signal },
  );

  const chunks = normalizeChunks(raw);
  const citations = sources.absorb(chunks, node.id);
  send({
    type: "node_retrieved",
    id: node.id,
    chunkCount: chunks.length,
    newSources: citations.added,
  });

  const finding = await synthesiseFinding(
    creds,
    question,
    sources,
    citations.numbers,
    signal,
  );
  send({ type: "node_finding", id: node.id, finding, citations: citations.numbers });

  return {
    finding: {
      id: node.id,
      question,
      finding,
      citations: citations.numbers,
      chunkCount: chunks.length,
    },
    chunkCount: chunks.length,
  };
}

/** Rewrite a dependent sub-question using what its dependencies discovered. */
async function refineQuestion(
  creds: LlmCreds,
  question: string,
  deps: NodeFinding[],
  signal: AbortSignal,
): Promise<string> {
  const context = deps
    .map((d) => `Q: ${d.question}\nA: ${d.finding.slice(0, FINDING_CHARS)}`)
    .join("\n\n");
  try {
    const rewritten = await complete(
      creds,
      [
        {
          role: "user",
          content: [
            "Rewrite the follow-up search query so it is fully self-contained,",
            "substituting any specifics discovered below. Keep it short and literal.",
            "Reply with ONLY the rewritten query.",
            "",
            `Already found:\n${context}`,
            "",
            `Follow-up query: ${question}`,
          ].join("\n"),
        },
      ],
      { temperature: 0, maxTokens: 120, signal },
    );
    const cleaned = rewritten.trim().replace(/^["']|["']$/g, "");
    return cleaned || question;
  } catch {
    return question;
  }
}

/** Answer a single sub-question from just the sources it retrieved. */
async function synthesiseFinding(
  creds: LlmCreds,
  question: string,
  sources: SourceRegistry,
  numbers: number[],
  signal: AbortSignal,
): Promise<string> {
  if (numbers.length === 0) {
    return "No relevant context was found for this sub-question.";
  }
  const context = sources.contextFor(numbers, 6000);
  try {
    return await complete(
      creds,
      [
        {
          role: "user",
          content: [
            "Answer the question in 2-4 sentences using ONLY the numbered context.",
            "Cite inline as [n] using the numbers exactly as given.",
            "If the context does not answer it, say so plainly in one sentence.",
            "",
            `Question: ${question}`,
            "",
            `Context:\n${context}`,
          ].join("\n"),
        },
      ],
      { temperature: 0.1, maxTokens: 350, signal },
    );
  } catch {
    return "This sub-question could not be summarised.";
  }
}

function buildAnswerMessages(
  query: string,
  objective: string,
  findings: NodeFinding[],
  sources: ResearchSource[],
): { role: "system" | "user"; content: string }[] {
  const findingBlock = findings
    .map((f) => `### ${f.question}\n${f.finding}`)
    .join("\n\n");
  const sourceBlock = sources
    .map((s) => `[${s.n}] ${s.title || "Untitled source"}\n${s.excerpt}`)
    .join("\n\n")
    .slice(0, MAX_ANSWER_CONTEXT);

  return [
    {
      role: "system",
      content: [
        "You are Open Glean's Deep Research mode. You have already run a multi-step",
        "investigation over the user's private knowledge base.",
        "",
        "Write the final answer from the intermediate findings and the numbered",
        "sources below. Requirements:",
        "- Cite inline as [n]; the numbers are global and already correct.",
        "- Lead with the direct answer, then supporting detail.",
        "- Use short paragraphs and light markdown; add headings only if the answer",
        "  genuinely has multiple parts.",
        "- State plainly where the sources were thin or conflicting. Do not invent.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Question: ${query}`,
        objective && objective !== query ? `Objective: ${objective}` : "",
        "",
        "=== INTERMEDIATE FINDINGS ===",
        findingBlock || "(none)",
        "",
        "=== SOURCES ===",
        sourceBlock || "(none)",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

// ── Source dedup + global citation numbering ──────────────────────

interface RawChunk {
  sourceId?: string;
  title?: string;
  url?: string;
  sourceType?: string;
  appProvider?: string;
  collection?: string;
  score?: number;
  content: string;
}

/**
 * Merges chunks from every sub-question into one citation list.
 *
 * The same document is routinely retrieved by several sub-questions, so
 * numbering is assigned on first sight and reused thereafter — that is what
 * keeps `[4]` meaning the same thing in a node finding and in the final
 * answer, and what stops the source panel filling with duplicates.
 */
class SourceRegistry {
  private byKey = new Map<string, ResearchSource>();

  absorb(chunks: RawChunk[], nodeId: string): { numbers: number[]; added: number } {
    const numbers: number[] = [];
    let added = 0;
    for (const chunk of chunks) {
      const key =
        chunk.sourceId ||
        chunk.url ||
        (chunk.title ? `t:${chunk.title}` : "") ||
        `c:${chunk.content.slice(0, 80)}`;
      let entry = this.byKey.get(key);
      if (!entry) {
        entry = {
          n: this.byKey.size + 1,
          sourceId: chunk.sourceId,
          title: chunk.title,
          url: chunk.url,
          sourceType: chunk.sourceType,
          appProvider: chunk.appProvider,
          collection: chunk.collection,
          score: chunk.score,
          foundBy: [],
          excerpt: "",
        };
        this.byKey.set(key, entry);
        added++;
      }
      if (!entry.foundBy.includes(nodeId)) entry.foundBy.push(nodeId);
      if (chunk.score != null && (entry.score == null || chunk.score > entry.score)) {
        entry.score = chunk.score;
      }
      if (entry.excerpt.length < EXCERPT_CHARS && chunk.content) {
        const room = EXCERPT_CHARS - entry.excerpt.length;
        entry.excerpt += (entry.excerpt ? "\n…\n" : "") + chunk.content.slice(0, room);
      }
      if (!numbers.includes(entry.n)) numbers.push(entry.n);
    }
    return { numbers, added };
  }

  contextFor(numbers: number[], cap: number): string {
    const wanted = new Set(numbers);
    const parts: string[] = [];
    let used = 0;
    for (const s of this.ordered()) {
      if (!wanted.has(s.n)) continue;
      const block = `[${s.n}] ${s.title || "Untitled source"}\n${s.excerpt}`;
      if (used + block.length > cap) break;
      parts.push(block);
      used += block.length;
    }
    return parts.join("\n\n");
  }

  ordered(): ResearchSource[] {
    return [...this.byKey.values()].sort((a, b) => a.n - b.n);
  }
}

/**
 * Flatten a /query envelope into chunks.
 *
 * The SDK returns camelCase, raw HTTP snake_case, and the payload has been
 * seen both enveloped and bare — tolerate all of it rather than trusting one
 * shape, matching how lib/qa.ts normalises the same responses.
 */
function normalizeChunks(raw: unknown): RawChunk[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;
  const list = Array.isArray(data.chunks)
    ? (data.chunks as unknown[])
    : Array.isArray(data.sources)
      ? (data.sources as unknown[])
      : [];

  const out: RawChunk[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const str = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = c[k];
        if (typeof v === "string" && v.trim()) return v;
      }
      return undefined;
    };
    const content = str("chunk_content", "chunkContent", "content", "text") ?? "";
    const chunkUuid = str("chunk_uuid", "chunkUuid", "chunk_id");
    const sourceId =
      str("source_id", "sourceId") ??
      (chunkUuid ? chunkUuid.split("_chunk_")[0] : undefined);
    const title = str("source_title", "sourceTitle", "title");
    if (!content && !title && !sourceId) continue;
    const scoreRaw = c.relevancy_score ?? c.relevancyScore ?? c.score;
    const meta = (c.additionalMetadata ?? c.additional_metadata) as
      | Record<string, unknown>
      | undefined;
    const provider =
      (typeof meta?.app_provider === "string" ? meta.app_provider : undefined) ??
      str("app_provider", "appProvider");
    out.push({
      sourceId,
      title,
      url: str("source_url", "sourceUrl", "url"),
      sourceType: str("source_type", "sourceType"),
      appProvider: provider,
      collection: str("collection", "sub_tenant_id"),
      score: typeof scoreRaw === "number" ? scoreRaw : undefined,
      content,
    });
  }
  return out;
}
