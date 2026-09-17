/**
 * Path routing for the Lambda chat proxy.
 *
 * The proxy sits behind API Gateway. Depending on how the API is configured the
 * incoming path may or may not carry a stage prefix:
 *
 *   REST API with a stage         →  /prod/chats/abc
 *   HTTP API on $default,
 *   a custom domain, or a
 *   Lambda Function URL           →  /chats/abc
 *
 * The original implementation stripped the first segment unconditionally, so
 * the stage-less form lost the part that matters: "/chats/abc" became "abc",
 * which matched no route and fell through to a 404. Every per-conversation
 * load, rename and delete failed on those deployments — silently, because
 * lib/mongo.ts turns a non-ok proxy response into `{ persisted: false }` and
 * the client degrades to localStorage without telling anyone.
 *
 * `normalizePath` is exported from the handler so this can be tested without
 * standing up Mongo or API Gateway.
 */
import { describe, expect, it } from "vitest";
import { normalizePath } from "./handler.mjs";

describe("normalizePath", () => {
  it("keeps a stage-prefixed collection path", () => {
    expect(normalizePath("/prod/chats")).toBe("chats");
  });

  it("keeps a stage-prefixed id path", () => {
    expect(normalizePath("/prod/chats/abc")).toBe("chats/abc");
  });

  // The regression. This returned "abc" before the fix.
  it("keeps a stage-less id path", () => {
    expect(normalizePath("/chats/abc")).toBe("chats/abc");
  });

  it("keeps a stage-less collection path", () => {
    expect(normalizePath("/chats")).toBe("chats");
  });

  it("handles an arbitrary stage name", () => {
    expect(normalizePath("/staging-v2/chats/abc")).toBe("chats/abc");
  });

  it("preserves an encoded id", () => {
    expect(normalizePath("/prod/chats/a%2Fb")).toBe("chats/a%2Fb");
  });

  it("tolerates a trailing slash", () => {
    expect(normalizePath("/prod/chats/")).toBe("chats/");
  });

  it("returns an empty string for an empty path", () => {
    expect(normalizePath("")).toBe("");
  });

  it("returns an empty string for the root path", () => {
    expect(normalizePath("/")).toBe("");
  });

  it("does not invent a chats prefix for an unrelated route", () => {
    expect(normalizePath("/prod/health")).toBe("health");
    expect(normalizePath("/health")).toBe("health");
  });
});
