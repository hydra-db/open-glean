/**
 * Which message patches reach the server.
 *
 * The old rule asked "is this message in a terminal state?" and used the answer
 * to decide whether to write. Those are different questions, and the gap ate
 * four fields:
 *
 *   requestId     -> chat/[id]/page.tsx patches it alone, so the rating
 *                    buttons vanish on reload (they gate on message.requestId)
 *   webCitations  -> patched alone, so [Web N] cards never survive a reload
 *   feedback      -> patched alone, so a thumbs-up is forgotten
 *   research      -> patched with sources only when sources exist, so a
 *                    research run with no sources yet was dropped
 *
 * `sources` was already special-cased into the old predicate, which is the
 * tell: someone hit this bug once, patched the one field they noticed, and
 * left the shape that caused it.
 *
 * The rule now asks the question that actually matters: does this patch carry
 * anything durable? Streaming content deltas stay excluded, since persisting
 * per token is what the terminal check was really for.
 */
import { describe, expect, it } from "vitest";
import { shouldPersistPatch } from "./persistPatch";

describe("shouldPersistPatch", () => {
  it("persists terminal states", () => {
    expect(shouldPersistPatch({ status: "done" })).toBe(true);
    expect(shouldPersistPatch({ status: "error" })).toBe(true);
    expect(shouldPersistPatch({ status: "stopped" })).toBe(true);
  });

  it("persists sources", () => {
    expect(shouldPersistPatch({ sources: [] })).toBe(true);
  });

  // The four regressions.
  it("persists requestId on its own", () => {
    expect(shouldPersistPatch({ requestId: "req_123" })).toBe(true);
  });

  it("persists webCitations on its own", () => {
    expect(shouldPersistPatch({ webCitations: [] })).toBe(true);
  });

  it("persists feedback on its own", () => {
    expect(shouldPersistPatch({ feedback: "positive" })).toBe(true);
  });

  it("persists research on its own, with no sources", () => {
    expect(
      shouldPersistPatch({ research: { phase: "done" } as never }),
    ).toBe(true);
  });

  it("does NOT persist a streaming content delta", () => {
    // The whole point of the original gate: one write per answer, not one per
    // token.
    expect(shouldPersistPatch({ content: "partial text so far" })).toBe(false);
    expect(shouldPersistPatch({ content: "more", status: "streaming" })).toBe(false);
  });

  it("does NOT persist an empty patch", () => {
    expect(shouldPersistPatch({})).toBe(false);
  });

  it("persists content when it arrives with a terminal status", () => {
    expect(shouldPersistPatch({ content: "final answer", status: "done" })).toBe(true);
  });

  it("persists an explicitly cleared durable field", () => {
    // Clearing feedback (un-rating) must reach the server too, so `in` rather
    // than a truthiness check.
    expect(shouldPersistPatch({ feedback: undefined })).toBe(true);
  });
});
