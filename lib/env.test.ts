/**
 * Environment validation (Phase 6).
 *
 * Every variable except OPEN_GLEAN_SESSION_SECRET was read ad hoc with a `??`
 * fallback, so a misconfiguration surfaced as a confusing runtime error deep
 * inside a request rather than a clear message at boot. Two of them diverged
 * outright: MONGODB_PROXY_KEY (app) and PROXY_KEY (lambda) are the same
 * secret under two names, and only one is documented.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { checkEnv } from "./env";

const BASE = {
  OPEN_GLEAN_SESSION_SECRET: "a-secret-of-at-least-16-chars",
};

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("OPEN_GLEAN_") || k.startsWith("MONGODB_") || k.startsWith("HYDRA_")) {
      delete process.env[k];
    }
  }
});

describe("checkEnv", () => {
  it("passes on a minimal valid production config", () => {
    const res = checkEnv({ ...BASE, NODE_ENV: "production" });
    expect(res.errors).toEqual([]);
  });

  it("requires a session secret in production", () => {
    const res = checkEnv({ NODE_ENV: "production" });
    expect(res.errors.join(" ")).toMatch(/OPEN_GLEAN_SESSION_SECRET/);
  });

  it("rejects a session secret that is too short to be useful", () => {
    const res = checkEnv({ OPEN_GLEAN_SESSION_SECRET: "short", NODE_ENV: "production" });
    expect(res.errors.join(" ")).toMatch(/16/);
  });

  it("does not require the secret outside production", () => {
    expect(checkEnv({ NODE_ENV: "development" }).errors).toEqual([]);
  });

  it("flags a proxy URL with no proxy key", () => {
    // Silently falls back to a direct connection that cannot reach a private
    // cluster, so persistence fails with a timeout rather than a clear cause.
    const res = checkEnv({
      ...BASE,
      MONGODB_URI: "https://abc.execute-api.us-east-1.amazonaws.com/prod",
    });
    expect(res.warnings.join(" ")).toMatch(/MONGODB_PROXY_KEY/);
  });

  it("flags a non-https Hydra base URL", () => {
    const res = checkEnv({ ...BASE, HYDRA_BASE_URL: "http://api.example.com" });
    expect(res.errors.join(" ")).toMatch(/HYDRA_BASE_URL/);
  });

  it("flags a malformed Hydra base URL", () => {
    const res = checkEnv({ ...BASE, HYDRA_BASE_URL: "not a url" });
    expect(res.errors.join(" ")).toMatch(/HYDRA_BASE_URL/);
  });

  it("warns when an LLM key is set with no model", () => {
    // resolveLlmCreds returns null without a model, so answers silently do not
    // work while search does — a confusing half-broken state.
    const res = checkEnv({ ...BASE, OPENROUTER_API_KEY: "sk-or-v1-x" });
    expect(res.warnings.join(" ")).toMatch(/OPEN_GLEAN_LLM_MODEL/);
  });

  it("warns that the private-URL opt-in relaxes the guard", () => {
    const res = checkEnv({ ...BASE, OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL: "true" });
    expect(res.warnings.join(" ")).toMatch(/ALLOW_PRIVATE_LLM_URL/);
  });

  it("does not warn about an unset optional variable", () => {
    expect(checkEnv(BASE).warnings.join(" ")).not.toMatch(/HYDRA_API_KEY/);
  });
});
