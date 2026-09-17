/**
 * Abandoned-conversation cleanup.
 *
 * A conversation is written to the database the moment the user submits, before
 * navigation. If the answer never arrives — tab closed mid-stream, navigation
 * failed, the run bailed — the row stays forever with zero real messages. The
 * history list fills with "No answer yet".
 *
 * The gist proposed persisting nothing before the first terminal state. Traced
 * against the code, that is worse than the bug: the conversation would live
 * only in React memory, so a reload mid-answer finds nothing, and
 * chat/[id]/page.tsx redirects to /ask. The user loses the question they are
 * waiting on. So: keep the eager write, and reap what was abandoned.
 *
 * "Abandoned" has to be conservative. A chat being actively streamed into also
 * has no assistant content yet, and deleting that would be the same data loss
 * by another route — hence the grace period.
 */
import { describe, expect, it } from "vitest";
import type { Conversation } from "@/lib/types";
import { isAbandoned, REAP_AFTER_MS } from "./zombieChats";

const MIN = 60_000;

function conv(p: Partial<Conversation> & { updatedAt: number }): Conversation {
  return {
    id: p.id ?? "c",
    title: p.title ?? "t",
    createdAt: p.createdAt ?? p.updatedAt,
    updatedAt: p.updatedAt,
    messages: p.messages ?? [],
  };
}

const now = 10_000_000;

describe("isAbandoned", () => {
  it("reaps an empty conversation past the grace period", () => {
    expect(isAbandoned(conv({ updatedAt: now - REAP_AFTER_MS - MIN }), now)).toBe(true);
  });

  it("keeps an empty conversation inside the grace period", () => {
    // This is the one that matters: a chat mid-stream has no messages yet.
    expect(isAbandoned(conv({ updatedAt: now - MIN }), now)).toBe(false);
  });

  it("keeps a conversation that has a real answer, however old", () => {
    const c = conv({
      updatedAt: now - REAP_AFTER_MS * 100,
      messages: [
        { id: "u", role: "user", content: "q", createdAt: 0 },
        { id: "a", role: "assistant", content: "an answer", status: "done", createdAt: 0 },
      ],
    });
    expect(isAbandoned(c, now)).toBe(false);
  });

  it("reaps a question that never got an answer", () => {
    // The user message alone is not worth keeping: nothing was answered, and
    // the question is still in the URL the user navigated from.
    const c = conv({
      updatedAt: now - REAP_AFTER_MS - MIN,
      messages: [{ id: "u", role: "user", content: "q", createdAt: 0 }],
    });
    expect(isAbandoned(c, now)).toBe(true);
  });

  it("reaps a stranded empty assistant placeholder", () => {
    const c = conv({
      updatedAt: now - REAP_AFTER_MS - MIN,
      messages: [
        { id: "u", role: "user", content: "q", createdAt: 0 },
        { id: "a", role: "assistant", content: "", status: "streaming", createdAt: 0 },
      ],
    });
    expect(isAbandoned(c, now)).toBe(true);
  });

  it("keeps a failed answer, which is a real outcome the user may want to see", () => {
    const c = conv({
      updatedAt: now - REAP_AFTER_MS - MIN,
      messages: [
        { id: "u", role: "user", content: "q", createdAt: 0 },
        { id: "a", role: "assistant", content: "_I couldn't answer that._", status: "error", createdAt: 0 },
      ],
    });
    expect(isAbandoned(c, now)).toBe(false);
  });

  it("keeps a terminal failure even when its content is empty", () => {
    // A run that reached a terminal status is a real outcome. Relying on the
    // placeholder text being non-empty would make this accidental.
    const c = conv({
      updatedAt: now - REAP_AFTER_MS - MIN,
      messages: [
        { id: "u", role: "user", content: "q", createdAt: 0 },
        { id: "a", role: "assistant", content: "", status: "error", createdAt: 0 },
      ],
    });
    expect(isAbandoned(c, now)).toBe(false);
  });

  it("uses the later of createdAt and updatedAt", () => {
    // Guards against a row whose updatedAt was never bumped being reaped while
    // it is still being written to.
    const c = conv({ createdAt: now, updatedAt: now - REAP_AFTER_MS * 2 });
    expect(isAbandoned(c, now)).toBe(false);
  });
});
