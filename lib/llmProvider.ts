/**
 * Which wire protocol an LLM base URL speaks, and the pure translations the
 * Anthropic path needs.
 *
 * Everything except the Anthropic API speaks OpenAI-style `/chat/completions`.
 * The provider is derived from the base URL rather than stored separately, so
 * it inherits the key-pinning rule in `resolveLlmCreds`: the key, the host and
 * the protocol all come from one origin and cannot be mixed by a caller.
 *
 * No `server-only` import and no SDK import, so tests can exercise it directly.
 */
import type { LlmMessage } from "@/lib/llmServer";

export type LlmProvider = "openai" | "anthropic";

const ANTHROPIC_HOSTS = new Set(["api.anthropic.com"]);

export function llmProvider(baseUrl: string): LlmProvider {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "");
    return ANTHROPIC_HOSTS.has(host) ? "anthropic" : "openai";
  } catch {
    return "openai";
  }
}

/**
 * The SDK appends `/v1/messages` itself. OpenAI-style settings habitually end
 * in `/v1`, so accept `https://api.anthropic.com/v1` as well as the bare host.
 */
export function anthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export interface AnthropicPrompt {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

/**
 * Split OpenAI-style messages into Anthropic's shape.
 *
 * The Messages API takes the system prompt as a top-level field, not as a
 * message. Callers here put system messages first (instructions plus the
 * retrieved Hydra context), so joining every system message into `system`
 * keeps their meaning. Empty turns are dropped: the API rejects empty content.
 */
export function toAnthropicPrompt(messages: LlmMessage[]): AnthropicPrompt {
  const system: string[] = [];
  const out: AnthropicPrompt["messages"] = [];
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : "";
    if (!content.trim()) continue;
    if (m.role === "system") system.push(content);
    else out.push({ role: m.role, content });
  }
  return { ...(system.length ? { system: system.join("\n\n") } : {}), messages: out };
}

/**
 * Models that support the dynamic-filtering web search tool. Every other
 * Claude model gets the basic variant, which all of them accept.
 */
const DYNAMIC_WEB_SEARCH = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];

export function webSearchToolType(
  model: string,
): "web_search_20260209" | "web_search_20250305" {
  return DYNAMIC_WEB_SEARCH.some((p) => model === p || model.startsWith(`${p}-`))
    ? "web_search_20260209"
    : "web_search_20250305";
}
