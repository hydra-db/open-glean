/**
 * LLM history assembly.
 *
 * The chat page appends two messages before the answer starts: the user's
 * question and an empty assistant placeholder to stream into. History was read
 * from the store AFTER that, so the outgoing prompt looked like:
 *
 *   ... , user:"<question>", assistant:"", user:"<question>"
 *
 * The question twice, with an empty assistant turn wedged between. That also
 * burned 2 of the 8 history slots, leaving 6 of real conversation.
 *
 * Errored and stopped turns were fed back too, so "_I couldn't answer that._"
 * was presented to the model as a genuine previous answer.
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/types";
import { usableHistory } from "./history";

const msg = (p: Partial<ChatMessage>): ChatMessage => ({
  id: p.id ?? "m",
  role: p.role ?? "user",
  content: p.content ?? "",
  createdAt: 0,
  ...p,
});

describe("usableHistory", () => {
  it("drops the in-flight turn", () => {
    const messages = [
      msg({ id: "u1", role: "user", content: "first question" }),
      msg({ id: "a1", role: "assistant", content: "first answer", status: "done" }),
      msg({ id: "u2", role: "user", content: "second question" }),
      msg({ id: "a2", role: "assistant", content: "", status: "streaming" }),
    ];
    expect(usableHistory(messages, "a2")).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("drops an empty assistant message even without an id match", () => {
    const messages = [
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "", status: "streaming" }),
    ];
    expect(usableHistory(messages, "other")).toEqual([{ role: "user", content: "q" }]);
  });

  it("drops errored and stopped assistant turns", () => {
    const messages = [
      msg({ id: "u1", role: "user", content: "q1" }),
      msg({ id: "a1", role: "assistant", content: "_I couldn't answer that._", status: "error" }),
      msg({ id: "u2", role: "user", content: "q2" }),
      msg({ id: "a2", role: "assistant", content: "_Stopped._", status: "stopped" }),
      msg({ id: "u3", role: "user", content: "q3" }),
      msg({ id: "a3", role: "assistant", content: "real answer", status: "done" }),
    ];
    expect(usableHistory(messages, "live")).toEqual([
      { role: "user", content: "q1" },
      { role: "user", content: "q2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "real answer" },
    ]);
  });

  it("keeps a completed assistant turn with no explicit status", () => {
    // Messages restored from the database may predate the status field.
    const messages = [
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "an answer" }),
    ];
    expect(usableHistory(messages, "live")).toHaveLength(2);
  });

  it("caps the history length", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `m${i}`, status: "done" }),
    );
    const out = usableHistory(messages, "live", 8);
    expect(out).toHaveLength(8);
    // Keeps the most recent, not the oldest.
    expect(out[out.length - 1].content).toBe("m39");
  });

  it("returns nothing for an empty conversation", () => {
    expect(usableHistory([], "live")).toEqual([]);
  });

  it("does not send the question twice on the second turn", () => {
    // The regression, stated as the symptom the user reported.
    const question = "what is rbac";
    const messages = [
      msg({ id: "u1", role: "user", content: "earlier" }),
      msg({ id: "a1", role: "assistant", content: "earlier answer", status: "done" }),
      msg({ id: "u2", role: "user", content: question }),
      msg({ id: "a2", role: "assistant", content: "", status: "streaming" }),
    ];
    const out = usableHistory(messages, "a2");
    expect(out.filter((m) => m.content === question)).toHaveLength(0);
    expect(out.some((m) => m.content === "")).toBe(false);
  });
});
