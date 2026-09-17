/**
 * Key and host pairing for the OpenRouter model directory.
 *
 * The old route read `key` and `baseUrl` independently from the query string.
 * Omit `key`, supply `baseUrl`, and the route fell back to the session cookie
 * and then to OPENROUTER_API_KEY — then sent that stored key to the caller's
 * host as `Authorization: Bearer`.
 *
 * Two things made it worse than the usual SSRF shape:
 *   - it is a GET, and the session cookie is sameSite=lax, so a plain
 *     top-level navigation from a malicious page carried the victim's cookie.
 *     No XSS needed, just a clicked link.
 *   - the allowlist was /openrouter/i tested against the whole URL, so
 *     "https://openrouter.attacker.com" and "https://attacker.com/openrouter"
 *     both passed.
 *
 * The rule now matches resolveLlmCreds (lib/llmServer.ts:31-46): a caller may
 * choose the host only when the caller also brings its own key. A stored key
 * is pinned to the endpoint it was stored with.
 *
 * The model picker still works, because it sends the key the user has just
 * typed, before it has been saved anywhere (components/ModelPicker.tsx:74-77).
 */
import { describe, expect, it } from "vitest";
import { resolveModelSource, OR_BASE } from "./resolve";

describe("resolveModelSource", () => {
  it("uses the caller key with the caller's chosen host", () => {
    expect(
      resolveModelSource({
        callerKey: "sk-caller",
        callerBaseUrl: "https://my-gateway.example.com/v1",
        sessionKey: undefined,
        envKey: undefined,
      }),
    ).toEqual({ key: "sk-caller", base: "https://my-gateway.example.com/v1" });
  });

  // The vulnerability. A caller-chosen host must never receive a stored key.
  it("ignores a caller base URL when falling back to the session key", () => {
    expect(
      resolveModelSource({
        callerKey: undefined,
        callerBaseUrl: "https://attacker.example.com",
        sessionKey: "sk-session",
        envKey: undefined,
      }),
    ).toEqual({ key: "sk-session", base: OR_BASE });
  });

  it("ignores a caller base URL when falling back to the env key", () => {
    expect(
      resolveModelSource({
        callerKey: undefined,
        callerBaseUrl: "https://attacker.example.com",
        sessionKey: undefined,
        envKey: "sk-env",
      }),
    ).toEqual({ key: "sk-env", base: OR_BASE });
  });

  it("does not fall for a host that merely contains the word openrouter", () => {
    for (const host of [
      "https://openrouter.attacker.com",
      "https://attacker.com/openrouter",
      "https://openrouter.ai.attacker.com",
    ]) {
      expect(
        resolveModelSource({
          callerKey: undefined,
          callerBaseUrl: host,
          sessionKey: "sk-session",
          envKey: undefined,
        }),
      ).toEqual({ key: "sk-session", base: OR_BASE });
    }
  });

  it("rejects a private or loopback host even when the caller brings a key", () => {
    for (const host of [
      "http://127.0.0.1/v1",
      "http://169.254.169.254/latest/meta-data",
      "http://localhost:11434/v1",
      "http://[::1]/v1",
    ]) {
      expect(() =>
        resolveModelSource({
          callerKey: "sk-caller",
          callerBaseUrl: host,
          sessionKey: undefined,
          envKey: undefined,
        }),
      ).toThrow();
    }
  });

  it("prefers the session key over the env key", () => {
    expect(
      resolveModelSource({
        callerKey: undefined,
        callerBaseUrl: undefined,
        sessionKey: "sk-session",
        envKey: "sk-env",
      }),
    ).toEqual({ key: "sk-session", base: OR_BASE });
  });

  it("returns no key when none is configured anywhere", () => {
    expect(
      resolveModelSource({
        callerKey: undefined,
        callerBaseUrl: undefined,
        sessionKey: undefined,
        envKey: undefined,
      }),
    ).toEqual({ key: "", base: OR_BASE });
  });

  it("strips trailing slashes from a caller host", () => {
    expect(
      resolveModelSource({
        callerKey: "sk-caller",
        callerBaseUrl: "https://gw.example.com/v1///",
        sessionKey: undefined,
        envKey: undefined,
      }).base,
    ).toBe("https://gw.example.com/v1");
  });
});
