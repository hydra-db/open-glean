/**
 * Deep Research — shared types for the query-DAG pipeline.
 *
 * A research run is a small DAG of sub-questions. Nodes with no unmet
 * dependencies form a *level* and are executed against Hydra in parallel;
 * each level's findings are fed forward as context for the next. The client
 * never orchestrates any of this — it consumes the packet stream below.
 */

/** One sub-question in the plan. */
export interface ResearchNode {
  /** Stable id the planner assigns, e.g. "q1". Referenced by `dependsOn`. */
  id: string;
  /** The sub-question, phrased as a standalone retrieval query. */
  question: string;
  /** Why this question matters — shown in the UI under the question. */
  rationale?: string;
  /** Ids this node needs answered first. Empty => level 0. */
  dependsOn: string[];
}

export interface ResearchPlan {
  /** The user's original question, restated by the planner. */
  objective: string;
  nodes: ResearchNode[];
}

/** A node plus its resolved execution level. */
export interface LeveledNode extends ResearchNode {
  level: number;
}

/** Per-node outcome after retrieval + synthesis. */
export interface NodeFinding {
  id: string;
  question: string;
  /** Short synthesised answer to just this sub-question. */
  finding: string;
  /** Global citation numbers this finding drew on. */
  citations: number[];
  chunkCount: number;
}

// ── Packet protocol (NDJSON over the response body) ────────────────
//
// Newline-delimited JSON rather than SSE: the payloads are large and
// structured, and NDJSON survives a plain `fetch` + ReadableStream reader
// without the EventSource reconnect semantics we do not want here.

export type ResearchPacket =
  | { type: "plan"; plan: ResearchPlan; levels: number }
  | { type: "level_start"; level: number; nodeIds: string[] }
  | { type: "node_start"; id: string }
  | { type: "node_retrieved"; id: string; chunkCount: number; newSources: number }
  | { type: "node_finding"; id: string; finding: string; citations: number[] }
  | { type: "node_error"; id: string; message: string }
  | { type: "level_done"; level: number }
  /** Deduped, globally numbered sources — emitted once before the answer. */
  | { type: "sources"; sources: ResearchSource[] }
  | { type: "answer_delta"; text: string }
  | { type: "done"; stats: ResearchStats }
  | { type: "error"; message: string };

/** A deduplicated source with its stable global citation number. */
export interface ResearchSource {
  /** 1-based citation number, stable for the whole run. */
  n: number;
  sourceId?: string;
  title?: string;
  url?: string;
  sourceType?: string;
  appProvider?: string;
  collection?: string;
  /** Best relevancy score seen across every query that retrieved it. */
  score?: number;
  /** Which node ids surfaced this source. */
  foundBy: string[];
  /** Concatenated chunk text, capped — this is what the answer is grounded in. */
  excerpt: string;
}

export interface ResearchStats {
  nodes: number;
  levels: number;
  /** Chunks retrieved before dedup. */
  chunksRetrieved: number;
  /** Distinct sources after dedup. */
  sourcesUsed: number;
  elapsedMs: number;
}

/** Client-side view of a node as the run progresses. */
export type NodeStatus = "pending" | "running" | "done" | "error";

export interface ResearchNodeState extends LeveledNode {
  status: NodeStatus;
  chunkCount?: number;
  newSources?: number;
  finding?: string;
  citations?: number[];
  error?: string;
}

/** Everything the timeline UI needs to render a run. */
export interface ResearchRunState {
  objective?: string;
  nodes: ResearchNodeState[];
  levels: number;
  currentLevel: number;
  sources: ResearchSource[];
  stats?: ResearchStats;
  /**
   * `stopped` is deliberately distinct from `done`: a cancelled run has a
   * truncated answer, and presenting that as a completed result misrepresents
   * it. Callers must branch on this rather than assuming the run succeeded
   * just because the promise resolved.
   */
  phase: "planning" | "researching" | "answering" | "done" | "stopped" | "error";
  error?: string;
  startedAt: number;
}
