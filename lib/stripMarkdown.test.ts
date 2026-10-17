import { describe, expect, it } from "vitest";
import { stripMarkdown } from "@/lib/markdown";

describe("stripMarkdown", () => {
  it("drops headings, emphasis and list markers from a preview", () => {
    expect(
      stripMarkdown("Here's a summary:\n### Common Interpretations\n- **No** information was *found*."),
    ).toBe("Here's a summary: Common Interpretations No information was found.");
  });

  it("keeps link text and removes citation markers", () => {
    expect(stripMarkdown("See [the plan](https://x.dev/plan) [1] and [Web 2].")).toBe(
      "See the plan and .",
    );
  });

  it("removes code fences but keeps inline code text", () => {
    expect(stripMarkdown("Run `npm ci`:\n```bash\nnpm ci\n```\nDone")).toBe("Run npm ci: Done");
  });
});
