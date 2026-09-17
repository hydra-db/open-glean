/**
 * Readable rendering of stored source bodies.
 *
 * The Context view dumped raw JSON at users for connector items, because this
 * helper was module-private inside SourcesPanel and the Context page could not
 * import it. Extracting it fixed the bug and gave it its first tests.
 */
import { describe, expect, it } from "vitest";
import { readableBody } from "./readableBody";

describe("readableBody", () => {
  it("returns plain prose unchanged", () => {
    expect(readableBody("just some text")).toBe("just some text");
  });

  it("pulls the prose out of a Slack-shaped envelope", () => {
    const raw = JSON.stringify({
      app_comments: [
        { author: "ada", body: "the deploy is stuck" },
        { author: "grace", body: "restarting the worker" },
      ],
    });
    const out = readableBody(raw);
    expect(out).toContain("ada: the deploy is stuck");
    expect(out).toContain("grace: restarting the worker");
    expect(out).not.toContain("app_comments");
  });

  it("accepts text, message and body as the prose field", () => {
    expect(readableBody(JSON.stringify({ text: "via text" }))).toContain("via text");
    expect(readableBody(JSON.stringify({ message: "via message" }))).toContain("via message");
    expect(readableBody(JSON.stringify({ body: "via body" }))).toContain("via body");
  });

  it("deduplicates repeated bodies", () => {
    const raw = JSON.stringify([{ body: "same" }, { body: "same" }]);
    expect(readableBody(raw)).toBe("same");
  });

  it("falls back to pretty-printed JSON when there is no prose", () => {
    const out = readableBody(JSON.stringify({ id: 1, nested: { n: 2 } }));
    // Pretty-printed, not the single unwrapped line it used to show.
    expect(out).toContain("\n");
    expect(out).toContain('"id": 1');
  });

  it("returns the raw text when it only looks like JSON", () => {
    expect(readableBody("{not actually json")).toBe("{not actually json");
  });

  it("handles an empty string", () => {
    expect(readableBody("")).toBe("");
  });

  it("does not recurse forever on deeply nested input", () => {
    let nested: Record<string, unknown> = { body: "deep" };
    for (let i = 0; i < 50; i++) nested = { child: nested };
    expect(() => readableBody(JSON.stringify(nested))).not.toThrow();
  });
});
