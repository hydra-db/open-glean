/**
 * The Deep Research reducer folds a stream of NDJSON packets into the state the
 * timeline renders. It is pure, so a run can be replayed packet by packet
 * without a network or React. These tests pin the state transitions the UI and
 * the persistence layer depend on.
 */
import { describe, expect, it } from "vitest";
import { applyPacket, initialRunState } from "./useResearch";
import type { ResearchPacket, ResearchRunState } from "./types";

const plan: ResearchPacket = {
  type: "plan",
  levels: 2,
  plan: {
    objective: "Explain the Phoenix pipeline",
    nodes: [
      { id: "q1", question: "What are the stages?", dependsOn: [] },
      { id: "q2", question: "How does canary work?", dependsOn: ["q1"] },
    ],
  },
};

/** Replay a list of packets from the initial state. */
function replay(packets: ResearchPacket[]): ResearchRunState {
  return packets.reduce(applyPacket, initialRunState());
}

describe("applyPacket", () => {
  it("starts in the planning phase with no nodes", () => {
    const s = initialRunState();
    expect(s.phase).toBe("planning");
    expect(s.nodes).toHaveLength(0);
  });

  it("plan sets the objective, levels, nodes, and moves to researching", () => {
    const s = applyPacket(initialRunState(), plan);
    expect(s.phase).toBe("researching");
    expect(s.objective).toBe("Explain the Phoenix pipeline");
    expect(s.levels).toBe(2);
    expect(s.nodes.map((n) => n.id)).toEqual(["q1", "q2"]);
    // Every node starts pending.
    expect(s.nodes.every((n) => n.status === "pending")).toBe(true);
  });

  it("does not mutate the previous state (each step returns a new object)", () => {
    const before = applyPacket(initialRunState(), plan);
    const after = applyPacket(before, { type: "node_start", id: "q1" });
    expect(after).not.toBe(before);
    expect(before.nodes[0]!.status).toBe("pending"); // unchanged
    expect(after.nodes[0]!.status).toBe("running");
  });

  it("walks one node through running, retrieved, and done", () => {
    const s = replay([
      plan,
      { type: "node_start", id: "q1" },
      { type: "node_retrieved", id: "q1", chunkCount: 4, newSources: 2 },
      { type: "node_finding", id: "q1", finding: "build, canary, rollout", citations: [1, 2] },
    ]);
    const q1 = s.nodes.find((n) => n.id === "q1")!;
    expect(q1.status).toBe("done");
    expect(q1.chunkCount).toBe(4);
    expect(q1.newSources).toBe(2);
    expect(q1.finding).toBe("build, canary, rollout");
    expect(q1.citations).toEqual([1, 2]);
    // q2 is untouched by q1's packets.
    expect(s.nodes.find((n) => n.id === "q2")!.status).toBe("pending");
  });

  it("marks a node errored without failing the whole run", () => {
    const s = replay([plan, { type: "node_error", id: "q2", message: "timeout" }]);
    const q2 = s.nodes.find((n) => n.id === "q2")!;
    expect(q2.status).toBe("error");
    expect(q2.error).toBe("timeout");
    expect(s.phase).toBe("researching"); // run continues
  });

  it("level_start updates the current level", () => {
    const s = replay([plan, { type: "level_start", level: 1, nodeIds: ["q2"] }]);
    expect(s.currentLevel).toBe(1);
  });

  it("sources moves to answering and stores the deduped sources", () => {
    const s = replay([
      plan,
      {
        type: "sources",
        sources: [{ n: 1, title: "Phoenix memo", foundBy: ["q1"], excerpt: "..." }],
      },
    ]);
    expect(s.phase).toBe("answering");
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]!.n).toBe(1);
  });

  it("done sets the terminal phase and the stats", () => {
    const s = replay([
      plan,
      {
        type: "done",
        stats: { nodes: 2, levels: 2, chunksRetrieved: 8, sourcesUsed: 3, elapsedMs: 1200 },
      },
    ]);
    expect(s.phase).toBe("done");
    expect(s.stats?.sourcesUsed).toBe(3);
  });

  it("error sets the error phase and message", () => {
    const s = replay([plan, { type: "error", message: "planner failed" }]);
    expect(s.phase).toBe("error");
    expect(s.error).toBe("planner failed");
  });

  it("ignores a packet for an unknown node id", () => {
    const s = replay([plan, { type: "node_start", id: "does-not-exist" }]);
    // No node changed; all still pending.
    expect(s.nodes.every((n) => n.status === "pending")).toBe(true);
  });

  it("ignores an unknown packet type without throwing", () => {
    const weird = { type: "totally_unknown" } as unknown as ResearchPacket;
    const before = applyPacket(initialRunState(), plan);
    expect(applyPacket(before, weird)).toBe(before);
  });
});
