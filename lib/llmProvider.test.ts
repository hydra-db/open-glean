import { describe, expect, it } from "vitest";
import {
  anthropicBaseUrl,
  llmProvider,
  toAnthropicPrompt,
  webSearchToolType,
} from "@/lib/llmProvider";

describe("llmProvider", () => {
  it("routes the Anthropic API host to the native provider", () => {
    expect(llmProvider("https://api.anthropic.com")).toBe("anthropic");
    expect(llmProvider("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(llmProvider("https://API.Anthropic.com./v1/")).toBe("anthropic");
  });

  it("keeps every other host on the OpenAI-compatible path", () => {
    expect(llmProvider("https://openrouter.ai/api/v1")).toBe("openai");
    expect(llmProvider("https://api.openai.com/v1")).toBe("openai");
    // A look-alike host must not be treated as Anthropic.
    expect(llmProvider("https://api.anthropic.com.evil.example")).toBe("openai");
    expect(llmProvider("not a url")).toBe("openai");
  });
});

describe("anthropicBaseUrl", () => {
  it("strips a trailing /v1 because the SDK adds it", () => {
    expect(anthropicBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
    expect(anthropicBaseUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com");
    expect(anthropicBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com");
  });
});

describe("toAnthropicPrompt", () => {
  it("moves system messages to the top-level system prompt", () => {
    expect(
      toAnthropicPrompt([
        { role: "system", content: "Be brief." },
        { role: "system", content: "Context: [1] doc" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Again" },
      ]),
    ).toEqual({
      system: "Be brief.\n\nContext: [1] doc",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Again" },
      ],
    });
  });

  it("drops empty turns, which the API rejects", () => {
    expect(
      toAnthropicPrompt([
        { role: "user", content: "Q" },
        { role: "assistant", content: "  " },
        { role: "system", content: "" },
      ]),
    ).toEqual({ messages: [{ role: "user", content: "Q" }] });
  });
});

describe("webSearchToolType", () => {
  it("uses dynamic filtering on models that support it", () => {
    expect(webSearchToolType("claude-opus-5-5")).toBe("web_search_20260209");
    expect(webSearchToolType("claude-sonnet-5-5")).toBe("web_search_20260209");
    expect(webSearchToolType("claude-opus-4-6")).toBe("web_search_20260209");
  });

  it("falls back to the basic tool everywhere else", () => {
    expect(webSearchToolType("claude-haiku-4-5")).toBe("web_search_20250305");
    expect(webSearchToolType("claude-opus-4-5")).toBe("web_search_20250305");
    expect(webSearchToolType("claude-fable-5-1")).toBe("web_search_20250305");
  });
});
