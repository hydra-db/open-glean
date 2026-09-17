/**
 * Decide which key goes to which host for the model directory lookup.
 *
 * Split out of route.ts so the rule can be tested without a request, a session
 * cookie, or a network call.
 *
 * The rule mirrors `resolveLlmCreds` (lib/llmServer.ts): the key and the host
 * must come from the same origin. A request may choose the host only when it
 * also brings its own key, because the server attaches the key as
 * `Authorization: Bearer` and can relay the response back.
 */
import { assertSafeLlmUrl } from "@/lib/safeUrl";

export const OR_BASE = "https://openrouter.ai/api/v1";

export interface ModelSourceInput {
  /** `key` from the request. The model picker sends the key being typed. */
  callerKey: string | undefined;
  /** `baseUrl` from the request. Honoured only alongside a caller key. */
  callerBaseUrl: string | undefined;
  sessionKey: string | undefined;
  envKey: string | undefined;
}

export interface ModelSource {
  key: string;
  base: string;
}

/**
 * @throws when a caller-supplied host is private, internal, or malformed.
 */
export function resolveModelSource(input: ModelSourceInput): ModelSource {
  const callerKey = input.callerKey?.trim() ?? "";
  const callerBaseUrl = input.callerBaseUrl?.trim() ?? "";

  // The caller brought its own key, so it may also pick the host it goes to —
  // but only a public one: this server performs the fetch and returns the body.
  if (callerKey) {
    if (!callerBaseUrl) return { key: callerKey, base: OR_BASE };
    assertSafeLlmUrl(callerBaseUrl);
    return { key: callerKey, base: callerBaseUrl.replace(/\/+$/, "") };
  }

  // No caller key, so any stored key stays pinned to OpenRouter. A
  // caller-supplied base URL is ignored rather than rejected: the picker sends
  // one whenever the settings field is filled in, and failing the request
  // would break the UI for a parameter we are deliberately not honouring.
  return {
    key: input.sessionKey?.trim() || input.envKey?.trim() || "",
    base: OR_BASE,
  };
}
