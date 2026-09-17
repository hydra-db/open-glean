/**
 * Chat titles must not cut a short question mid-sentence with no ellipsis.
 * The old rule took the first five words, so "What are the stages of the
 * Phoenix pipeline?" became "What are the stages of" with no ellipsis.
 */
import { describe, expect, it } from "vitest";
import { suggestTitle } from "./qa";

describe("suggestTitle", () => {
  it("keeps a short question whole", () => {
    expect(suggestTitle("What is Phoenix?")).toBe("What is Phoenix?");
  });

  it("adds an ellipsis when it truncates", () => {
    const out = suggestTitle(
      "What are the stages of the Phoenix pipeline and how do they run?",
    );
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(49); // 48 budget + the ellipsis
    // It must not stop at the old hard five-word cut.
    expect(out).not.toBe("What are the stages of");
  });

  it("cuts a single over-long word", () => {
    const out = suggestTitle("x".repeat(80));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(49);
  });

  it("falls back for an empty query", () => {
    expect(suggestTitle("   ")).toBe("New chat");
  });

  it("collapses runs of whitespace", () => {
    expect(suggestTitle("hello    world")).toBe("hello world");
  });
});
