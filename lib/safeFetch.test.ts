/**
 * SSRF guard for /api/fetch-url.
 *
 * That route fetches a user-supplied URL server-side and returns the body to
 * the caller, which makes it the most dangerous fetch in the app: it is a read
 * primitive for anything the server can reach. Before this, the only check was
 * the scheme, so
 *
 *   POST /api/fetch-url {"url":"http://169.254.169.254/latest/meta-data/..."}
 *
 * returned EC2 instance credentials to an unauthenticated caller.
 *
 * Hostname matching alone is not enough here. A public name that resolves to a
 * private address (DNS rebinding, or just an A record pointing at 10.x) passes
 * every string check. So this guard resolves the host and rejects on the
 * resolved IPs, reusing the same isPrivateAddress logic the LLM path uses.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertPublicHost, fetchPinned, MAX_BYTES } from "./safeFetch";

/** Fake resolver so the tests never touch real DNS. */
function resolverFor(map: Record<string, string[]>) {
  return async (host: string) => {
    const hit = map[host];
    if (!hit) throw new Error(`no such host: ${host}`);
    return hit;
  };
}

describe("assertPublicHost", () => {
  it("allows a public address and returns the validated addresses", async () => {
    await expect(
      assertPublicHost("example.com", resolverFor({ "example.com": ["93.184.216.34"] })),
    ).resolves.toEqual(["93.184.216.34"]);
  });

  it("returns an IP literal as its own validated address", async () => {
    await expect(assertPublicHost("93.184.216.34")).resolves.toEqual(["93.184.216.34"]);
  });

  it("rejects a public name that resolves to loopback (DNS rebinding)", async () => {
    await expect(
      assertPublicHost("evil.example.com", resolverFor({ "evil.example.com": ["127.0.0.1"] })),
    ).rejects.toThrow(/private|internal/i);
  });

  it("rejects a public name that resolves to cloud metadata", async () => {
    await expect(
      assertPublicHost("evil.example.com", resolverFor({ "evil.example.com": ["169.254.169.254"] })),
    ).rejects.toThrow(/private|internal/i);
  });

  it("rejects when ANY resolved address is private", async () => {
    // A rebinding host often returns one public and one private record.
    await expect(
      assertPublicHost(
        "mixed.example.com",
        resolverFor({ "mixed.example.com": ["93.184.216.34", "10.0.0.5"] }),
      ),
    ).rejects.toThrow(/private|internal/i);
  });

  it("rejects RFC1918 ranges", async () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1"]) {
      await expect(
        assertPublicHost("h.example.com", resolverFor({ "h.example.com": [ip] })),
      ).rejects.toThrow(/private|internal/i);
    }
  });

  it("rejects IPv6 loopback and unique-local", async () => {
    for (const ip of ["::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      await expect(
        assertPublicHost("h.example.com", resolverFor({ "h.example.com": [ip] })),
      ).rejects.toThrow(/private|internal/i);
    }
  });

  it("rejects a literal private IP without consulting DNS", async () => {
    const resolver = vi.fn();
    await expect(assertPublicHost("127.0.0.1", resolver)).rejects.toThrow(/private|internal/i);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects an internal-looking hostname before resolving", async () => {
    const resolver = vi.fn();
    for (const host of ["localhost", "db.internal", "printer.local"]) {
      await expect(assertPublicHost(host, resolver)).rejects.toThrow(/private|internal/i);
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects a host that does not resolve at all", async () => {
    await expect(assertPublicHost("nope.example.com", resolverFor({}))).rejects.toThrow();
  });

  it("caps the download size", () => {
    // Guards against the old behaviour: the cap truncated the extracted text
    // AFTER buffering the whole response, so a huge body was still read into
    // memory in full.
    expect(MAX_BYTES).toBeGreaterThan(0);
    expect(MAX_BYTES).toBeLessThanOrEqual(5_000_000);
  });
});

describe("fetchPinned — response cap", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big") {
        // More than the cap, sent as one large body.
        res.writeHead(200);
        res.end(Buffer.alloc(MAX_BYTES + 100_000, 0x61)); // 'a'
        return;
      }
      res.writeHead(200);
      res.end("small");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("returns a capped body instead of hanging when the response exceeds the cap", async () => {
    const url = new URL(`http://127.0.0.1:${port}/big`);
    const res = await fetchPinned(url, "127.0.0.1", { timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(MAX_BYTES);
  });

  it("returns the full body when it is under the cap", async () => {
    const url = new URL(`http://127.0.0.1:${port}/small`);
    const res = await fetchPinned(url, "127.0.0.1", { timeoutMs: 5000 });
    expect(res.body).toBe("small");
  });
});

describe("assertPublicHost — trailing dot", () => {
  it("rejects an internal name written as a fully qualified domain", async () => {
    const never = async () => {
      throw new Error("resolver must not be reached");
    };
    for (const host of ["localhost.", "db.internal.", "printer.local."]) {
      await expect(assertPublicHost(host, never)).rejects.toThrow(/private|internal/i);
    }
  });
});
