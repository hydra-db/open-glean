"use client";

/**
 * Client half of Deep Research: consume the NDJSON packet stream from
 * /api/research and fold it into a `ResearchRunState` the timeline renders.
 *
 * The reducer is exported separately from the hook so the folding logic can be
 * exercised without a network or React.
 */
import { useCallback, useRef, useState } from "react";
import type {
  ResearchPacket,
  ResearchRunState,
  ResearchNodeState,
} from "./types";

export function initialRunState(): ResearchRunState {
  return {
    nodes: [],
    levels: 0,
    currentLevel: 0,
    sources: [],
    phase: "planning",
    startedAt: Date.now(),
  };
}

/** Fold one packet into the run state. Pure — returns a new object. */
export function applyPacket(
  state: ResearchRunState,
  packet: ResearchPacket,
): ResearchRunState {
  switch (packet.type) {
    case "plan":
      return {
        ...state,
        objective: packet.plan.objective,
        levels: packet.levels,
        phase: "researching",
        nodes: packet.plan.nodes.map((n) => ({
          ...n,
          level: "level" in n ? (n as ResearchNodeState).level : 0,
          status: "pending" as const,
        })),
      };
    case "level_start":
      return { ...state, currentLevel: packet.level };
    case "node_start":
      return patchNode(state, packet.id, { status: "running" });
    case "node_retrieved":
      return patchNode(state, packet.id, {
        chunkCount: packet.chunkCount,
        newSources: packet.newSources,
      });
    case "node_finding":
      return patchNode(state, packet.id, {
        status: "done",
        finding: packet.finding,
        citations: packet.citations,
      });
    case "node_error":
      return patchNode(state, packet.id, {
        status: "error",
        error: packet.message,
      });
    case "level_done":
      return state;
    case "sources":
      return { ...state, sources: packet.sources, phase: "answering" };
    case "done":
      return { ...state, stats: packet.stats, phase: "done" };
    case "error":
      return { ...state, phase: "error", error: packet.message };
    default:
      return state;
  }
}

function patchNode(
  state: ResearchRunState,
  id: string,
  patch: Partial<ResearchNodeState>,
): ResearchRunState {
  return {
    ...state,
    nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  };
}

export interface RunResearchOpts {
  query: string;
  database?: string;
  collection?: string;
  collections?: string[];
  llm?: { apiKey?: string; baseUrl?: string; model?: string };
  onState: (state: ResearchRunState) => void;
  onDelta: (text: string) => void;
}

export function useResearch() {
  const abortRef = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  /**
   * Run a research pass. Resolves with the final state — a stopped or failed
   * run resolves too, so callers must inspect `phase` rather than treating
   * "the promise settled" as "the run succeeded".
   */
  const run = useCallback(async (opts: RunResearchOpts): Promise<ResearchRunState> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);

    let state = initialRunState();
    opts.onState(state);

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: opts.query,
          database: opts.database,
          collection: opts.collection,
          collections: opts.collections,
          llm: opts.llm,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => null);
        throw new Error(
          (detail as { error?: string } | null)?.error ??
            `Deep Research failed (${res.status}).`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // NDJSON: everything up to the last newline is complete; the tail is a
        // partial record that must wait for the next read.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let packet: ResearchPacket;
          try {
            packet = JSON.parse(line) as ResearchPacket;
          } catch {
            continue;
          }
          if (packet.type === "answer_delta") {
            opts.onDelta(packet.text);
            continue;
          }
          state = applyPacket(state, packet);
          opts.onState(state);
        }
      }
      // The stream is only trustworthy if it ended on a terminal packet. If it
      // closed mid-flight (dropped connection, killed server) the phase is
      // still planning/researching/answering — treat that as a failure rather
      // than letting the caller persist a truncated answer as complete.
      if (
        state.phase !== "done" &&
        state.phase !== "error" &&
        state.phase !== "stopped"
      ) {
        state = {
          ...state,
          phase: "error",
          error: "The research stream ended before it finished.",
        };
        opts.onState(state);
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        state = { ...state, phase: "stopped" };
        opts.onState(state);
        return state;
      }
      state = {
        ...state,
        phase: "error",
        error: err instanceof Error ? err.message : "Deep Research failed.",
      };
      opts.onState(state);
      return state;
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
    return state;
  }, []);

  return { run, stop, running };
}
