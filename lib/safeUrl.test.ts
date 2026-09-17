/**
 * Transport and host rules for outbound base URLs (S6, 5.2).
 *
 * S6: the guard blocked `file:` and `gopher:` but explicitly allowed plaintext
 * `http:`, so an API key could be sent to an unencrypted endpoint in an
 * Authorization header and read by anyone on the network path.
 *
 * `https:` is now required, with one deliberate exception: a private-address
 * URL when the operator has opted in via OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL. A local
 * model on 127.0.0.1 has no certificate and never leaves the machine, so
 * requiring TLS there would just push people to disable the guard entirely.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { assertSafeLlmUrl, isPrivateAddress } from "./safeUrl";

const ALLOW = "OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL";

beforeEach(() => {
  delete process.env[ALLOW];
});
afterEach(() => {
  delete process.env[ALLOW];
});

describe("assertSafeLlmUrl — transport", () => {
  it("accepts https", () => {
    expect(() => assertSafeLlmUrl("https://api.openai.com/v1")).not.toThrow();
  });

  it("rejects plaintext http to a public host", () => {
    expect(() => assertSafeLlmUrl("http://api.example.com/v1")).toThrow(/https/i);
  });

  it("rejects non-http schemes", () => {
    for (const url of ["file:///etc/passwd", "gopher://x", "ftp://x/y"]) {
      expect(() => assertSafeLlmUrl(url)).toThrow();
    }
  });

  it("rejects a malformed URL", () => {
    expect(() => assertSafeLlmUrl("not a url")).toThrow();
  });
});

describe("assertSafeLlmUrl — hosts", () => {
  it("rejects loopback and private ranges", () => {
    for (const url of [
      "https://127.0.0.1/v1",
      "https://10.0.0.1/v1",
      "https://192.168.1.1/v1",
      "https://172.16.0.1/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/v1",
      "https://db.internal/v1",
    ]) {
      expect(() => assertSafeLlmUrl(url)).toThrow(/private|internal/i);
    }
  });

  it("rejects IPv6 loopback and mapped forms", () => {
    for (const url of ["https://[::1]/v1", "https://[::ffff:127.0.0.1]/v1"]) {
      expect(() => assertSafeLlmUrl(url)).toThrow(/private|internal/i);
    }
  });
});

describe("assertSafeLlmUrl — the local-model opt-in", () => {
  it("allows plaintext http on a private address when opted in", () => {
    process.env[ALLOW] = "true";
    // Ollama and LM Studio serve plain http on loopback with no certificate.
    expect(() => assertSafeLlmUrl("http://127.0.0.1:11434/v1")).not.toThrow();
    expect(() => assertSafeLlmUrl("http://localhost:1234/v1")).not.toThrow();
  });

  it("still rejects plaintext http to a PUBLIC host when opted in", () => {
    // The opt-in is for local models. It previously disabled the entire guard,
    // so it also silently permitted shipping a key in cleartext across the
    // internet — which is never what the flag is for.
    process.env[ALLOW] = "true";
    expect(() => assertSafeLlmUrl("http://api.example.com/v1")).toThrow(/https/i);
  });

  it("still rejects non-http schemes when opted in", () => {
    process.env[ALLOW] = "true";
    expect(() => assertSafeLlmUrl("file:///etc/passwd")).toThrow();
  });
});

describe("isPrivateAddress", () => {
  it("classifies the addresses the fetch guard depends on", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });
});

describe("assertSafeLlmUrl — trailing dot", () => {
  it("rejects an internal name written as a fully qualified domain", () => {
    // A trailing dot is valid DNS and resolves the same, but it matched none
    // of the name rules, so it bypassed every internal-host check.
    for (const url of [
      "https://vault.internal./v1",
      "https://metadata.google.internal./",
      "https://printer.local./",
      "https://localhost./v1",
    ]) {
      expect(() => assertSafeLlmUrl(url)).toThrow(/private|internal/i);
    }
  });

  it("still accepts a normal public host with a trailing dot", () => {
    expect(() => assertSafeLlmUrl("https://api.openai.com./v1")).not.toThrow();
  });
});
