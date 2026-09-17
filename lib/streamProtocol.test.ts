/**
 * Stream completion marker for /api/llm/chat.
 *
 * A mid-stream failure rendered as a finished answer. The server caught the
 * error, logged it, and closed the stream cleanly, so a truncated response was
 * byte-identical to a complete one. The client broke on `done` and the page
 * wrote status "done", which persisted the truncation as a real answer and
 * showed copy and rating buttons on it.
 *
 * Note this is not the same mechanism Deep Research uses. Research speaks
 * NDJSON with typed packets, so it has a terminal packet to look for. This
 * endpoint streams raw answer text, so the marker had to be added to the wire
 * format.
 *
 * The citations sentinel could not be reused: it is only emitted when web
 * search is on AND citations came back, so its absence means nothing.
 */
import { describe, expect, it } from "vitest";
import { DONE_SENTINEL, splitTerminator } from "./streamProtocol";

describe("splitTerminator", () => {
  it("reports a complete stream and strips the marker", () => {
    const res = splitTerminator(`the answer\n${DONE_SENTINEL}\n`);
    expect(res.complete).toBe(true);
    expect(res.text).toBe("the answer");
  });

  it("reports an incomplete stream when the marker is absent", () => {
    const res = splitTerminator("the answer was cut off mid-sen");
    expect(res.complete).toBe(false);
    expect(res.text).toBe("the answer was cut off mid-sen");
  });

  it("treats an empty stream as incomplete", () => {
    expect(splitTerminator("").complete).toBe(false);
  });

  it("keeps answer text that merely mentions the marker shape", () => {
    // The marker is only terminal at the very end, so an answer quoting
    // something similar mid-text must not be treated as the end.
    const body = `here is a string: ${DONE_SENTINEL} inside the answer`;
    const res = splitTerminator(body);
    expect(res.complete).toBe(false);
    expect(res.text).toBe(body);
  });

  it("tolerates trailing whitespace after the marker", () => {
    expect(splitTerminator(`done\n${DONE_SENTINEL}\n\n  `).complete).toBe(true);
  });

  it("does not mistake a partial marker for the real one", () => {
    // A stream cut off *while writing* the marker is still truncated.
    const partial = DONE_SENTINEL.slice(0, -3);
    expect(splitTerminator(`answer\n${partial}`).complete).toBe(false);
  });
});
