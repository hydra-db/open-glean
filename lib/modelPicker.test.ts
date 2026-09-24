/**
 * Custom model ids in the picker.
 *
 * The picker only offered models from a directory, and that directory was
 * always OpenRouter's. With an OpenAI key and base URL, every listed id was
 * `openai/gpt-4o-mini` style, which OpenAI rejects, and there was no way to
 * type `gpt-4o-mini` instead.
 */
import { describe, expect, it } from "vitest";
import { customModelId } from "./modelPicker";

describe("customModelId", () => {
  it("offers a typed id that the directory does not list", () => {
    expect(customModelId("gpt-4o-mini", [{ id: "openai/gpt-4o-mini" }])).toBe("gpt-4o-mini");
  });

  it("does not duplicate an id the directory already lists", () => {
    expect(customModelId("gpt-4o-mini", [{ id: "gpt-4o-mini" }])).toBeNull();
  });

  it("offers the typed id when the directory failed to load", () => {
    expect(customModelId("llama3.1:8b", null)).toBe("llama3.1:8b");
  });

  it("trims surrounding whitespace", () => {
    expect(customModelId("  gpt-4o  ", [])).toBe("gpt-4o");
  });

  it("offers nothing for an empty or blank search", () => {
    expect(customModelId("", null)).toBeNull();
    expect(customModelId("   ", [])).toBeNull();
  });
});
