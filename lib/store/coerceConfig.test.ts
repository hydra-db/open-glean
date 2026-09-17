/**
 * localStorage is user-writable. A wrong-typed field ({"apiKey": {}}) parses
 * as valid JSON, then reaches apiKey.trim() during the root layout render and
 * throws. There is no boundary above the root layout, so that is a permanent
 * white screen. coerceConfig drops wrong-typed fields before they get there.
 */
import { describe, expect, it } from "vitest";
import { coerceConfig } from "./config";

describe("coerceConfig", () => {
  it("keeps well-typed string fields", () => {
    expect(coerceConfig({ apiKey: "sk-1", database: "db" })).toEqual({
      apiKey: "sk-1",
      database: "db",
    });
  });

  it("drops an object where a string is expected", () => {
    // The white-screen case: {} has no .trim.
    expect(coerceConfig({ apiKey: {} })).toEqual({});
  });

  it("drops a number where a string is expected", () => {
    expect(coerceConfig({ apiKey: 123 })).toEqual({});
  });

  it("keeps only the string entries of collections", () => {
    expect(coerceConfig({ collections: ["a", 1, {}, "b"] })).toEqual({
      collections: ["a", "b"],
    });
  });

  it("drops collections that is not an array", () => {
    expect(coerceConfig({ collections: "a" })).toEqual({});
  });

  it("keeps boolean flags and drops non-booleans", () => {
    expect(coerceConfig({ keyConfigured: true, keyFromEnv: "yes" })).toEqual({
      keyConfigured: true,
    });
  });

  it("keeps only the string fields of a nested llm object", () => {
    expect(coerceConfig({ llm: { model: "gpt", apiKey: 5, baseUrl: "u" } })).toEqual({
      llm: { model: "gpt", baseUrl: "u" },
    });
  });

  it("returns an empty object for a non-object input", () => {
    expect(coerceConfig(null)).toEqual({});
    expect(coerceConfig("string")).toEqual({});
    expect(coerceConfig(42)).toEqual({});
  });
});
