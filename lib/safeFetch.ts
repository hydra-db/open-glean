/**
 * Post-resolution SSRF guard for server-side fetches of user-supplied URLs.
 *
 * `assertSafeLlmUrl` in ./safeUrl checks the URL string. That is enough for a
 * base URL that an operator configures. It is not enough for a URL from an
 * anonymous caller whose response body the server returns. A public hostname
 * with an A record that points at 169.254.169.254 passes every string check.
 *
 * This module resolves the hostname and rejects any private resolved address.
 * It reuses the IP classification from ./safeUrl instead of copying it.
 *
 * `assertPublicHost` returns the validated addresses so the caller can pin the
 * socket to a checked IP. Without pinning, fetch() resolves the host a second
 * time, which a short-TTL rebinding record can flip between validation and the
 * fetch. Pass the returned address to `pinnedLookup` on the request agent.
 */
import { isPrivateAddress } from "./safeUrl";

/** Stop reading a response after this many bytes. */
export const MAX_BYTES = 2_000_000;

export type Resolver = (host: string) => Promise<string[]>;

const BLOCKED_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** Default resolver. The lazy import keeps the module testable in isolation. */
async function defaultResolver(host: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * Validate a hostname and return its public addresses.
 *
 * @returns the validated addresses (the IP itself for a literal), so the caller
 *          can pin the fetch to one of them and avoid a re-resolution.
 * @throws when the host is internal by name, is a private IP literal, or
 *         resolves to any private address.
 */
export async function assertPublicHost(
  hostname: string,
  resolver: Resolver = defaultResolver,
): Promise<string[]> {
  // Strip a trailing dot: "localhost." resolves the same as "localhost" but
  // matches no name rule.
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");

  if (
    BLOCKED_NAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("That URL points at a private or internal address.");
  }

  // An IP literal needs no DNS: classify it directly, and it is its own
  // validated address.
  if (isPrivateAddress(host)) {
    throw new Error("That URL points at a private or internal address.");
  }
  if (isIpLiteral(host)) {
    return [host];
  }

  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new Error("That host could not be resolved.");
  }
  if (addresses.length === 0) {
    throw new Error("That host could not be resolved.");
  }

  // If ANY record is private, reject. A rebinding host often returns one
  // public and one private address, and lets the client pick.
  for (const address of addresses) {
    if (isPrivateAddress(address.toLowerCase())) {
      throw new Error("That URL points at a private or internal address.");
    }
  }
  return addresses;
}

/** True for a bare IPv4/IPv6 literal (no DNS needed). */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

export interface PinnedResponse {
  status: number;
  body: string;
}

/**
 * Fetch a URL with the connection pinned to `ip`, the address already validated
 * by `assertPublicHost`.
 *
 * Node's global fetch re-resolves the hostname, which reopens the rebinding
 * window. This uses node:http(s) with a `lookup` that always returns `ip`, so
 * the socket connects to the checked address. The Host header and TLS SNI keep
 * the original hostname, so virtual hosting and certificate checks stay correct.
 * Redirects are never followed (the caller inspects the 3xx status). The body is
 * capped at `MAX_BYTES`.
 */
export async function fetchPinned(
  url: URL,
  ip: string,
  opts: { timeoutMs: number; headers?: Record<string, string> },
): Promise<PinnedResponse> {
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? await import("node:https") : await import("node:http");
  const family = ip.includes(":") ? 6 : 4;

  return new Promise<PinnedResponse>((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: { ...opts.headers, host: url.host },
        servername: isHttps ? url.hostname : undefined,
        // Always connect to the validated IP, whatever the host resolves to now.
        lookup: (_hostname, _options, cb) =>
          cb(null, ip as never, family as never),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Do not read redirect bodies; the caller only needs the status.
        if (status >= 300 && status < 400) {
          res.destroy();
          resolve({ status, body: "" });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
        };
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          const room = MAX_BYTES - total;
          if (chunk.length <= room) {
            chunks.push(chunk);
            total += chunk.length;
            return;
          }
          // Over the cap: keep the bytes up to the limit, resolve with them, and
          // stop reading. Resolving before destroy() means the abort's error or
          // close event finds the promise already settled.
          if (room > 0) chunks.push(chunk.subarray(0, room));
          total = MAX_BYTES;
          done();
          res.destroy();
        });
        res.on("end", done);
        // Do not reject once bytes are collected: an abort after the cap still
        // yields a usable capped body. Only reject a stream that gave nothing.
        res.on("error", (err) => {
          if (!settled) reject(err);
        });
      },
    );
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Read a response body, stopping at `MAX_BYTES`.
 *
 * `await res.text()` buffers the whole body first, so a multi-gigabyte response
 * reaches memory before any cap applies. This function stops reading at the
 * limit instead.
 */
export async function readCapped(res: Response, maxBytes = MAX_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return chunks.join("");
}
