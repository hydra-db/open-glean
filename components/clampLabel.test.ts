/**
 * Graph labels come from indexed content that other people write. The canvas
 * collision math scales with label length, so one very long label wrecks the
 * layout. clampLabel bounds it.
 */
import { describe, expect, it } from "vitest";
import { clampLabel } from "./SourceGraph";

describe("clampLabel", () => {
  it("leaves a normal label unchanged", () => {
    expect(clampLabel("depends on")).toBe("depends on");
  });

  it("caps a pathologically long label", () => {
    const out = clampLabel("x".repeat(50_000));
    expect(out.length).toBe(120);
    expect(out.endsWith("…")).toBe(true);
  });
});
