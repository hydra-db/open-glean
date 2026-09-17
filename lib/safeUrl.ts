/**
 * SSRF guard for outbound base URLs.
 *
 * The check is a pure function over a string, and it lives outside any
 * `server-only` module so every caller can import it. The Hydra proxy, the
 * OpenRouter model lookup and the LLM path all need the same check.
 *
 * Keep one implementation. This logic attracts bypasses, and a second copy must
 * be fixed every time the first one is.
 */
/** True when the operator opted in to private/loopback LLM endpoints. */
function allowsPrivateUrl(): boolean {
  return process.env.OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL === "true";
}

/**
 * Reject a base URL that is unsafe to send a key to.
 *
 * Two independent rules apply, because they protect against different things:
 *
 *  1. TRANSPORT. The URL must use `https:`. The key travels in an Authorization
 *     header, so plaintext `http:` gives it to anyone on the network path.
 *
 *  2. HOST. The routes fetch this URL server-side and can relay the response.
 *     The host must not be loopback, private, link-local or an internal name.
 *     Otherwise the server becomes an SSRF relay into its own network.
 *
 * The `OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL` opt-in relaxes only rule 1 combined with
 * rule 2 on a private address. A local model (Ollama, LM Studio) serves plain
 * http on loopback with no certificate, and that traffic never leaves the
 * machine. Parse the URL before the opt-in check, or the flag also disables the
 * scheme check. Plaintext to a public host stays forbidden under the flag.
 *
 * This check is not DNS-rebinding-proof. A public hostname that resolves to a
 * private address still passes. lib/safeFetch.ts adds post-resolution checking
 * for the paths that return the response body to the caller.
 */
export function assertSafeLlmUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid LLM base URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported LLM base URL scheme: ${url.protocol}`);
  }

  // Strip a trailing dot. A fully qualified name such as "vault.internal."
  // resolves normally but matches neither the blocked-name set nor the suffix
  // checks below, so it bypassed every name rule.
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  const blockedNames = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
  const isPrivate =
    blockedNames.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateAddress(host);

  if (isPrivate) {
    if (!allowsPrivateUrl()) {
      throw new Error(
        "LLM base URL points at a private or internal address. Set OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL=true to allow it (e.g. for a local model).",
      );
    }
    // Opted in: a local model over plain http is the expected case.
    return;
  }

  // Public host: the key must not cross the network in cleartext.
  if (url.protocol !== "https:") {
    throw new Error(
      "LLM base URL must use https. A plaintext http endpoint would expose the API key in transit.",
    );
  }
}

/**
 * True for loopback, link-local, and RFC-1918 / ULA IP literals.
 *
 * `host` is a URL hostname with any surrounding `[]` removed. Only an IPv6
 * literal contains a colon, because DNS names do not. If the host looks like
 * IPv6 but does not parse, this function fails closed and calls it private.
 */
export function isPrivateAddress(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4) return isPrivateIpv4(v4);

  if (host.includes(":")) {
    const groups = parseIpv6(host);
    if (!groups) return true; // unparseable IPv6 literal counts as unsafe
    return isPrivateIpv6(groups);
  }

  return false;
}

/** Parse a dotted-quad into four octets, or null if it is not one. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number) as [number, number, number, number];
  if (parts.some((n) => n > 255)) return null; // out of range, not a valid v4
  return parts;
}

function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 10 || a === 127 || a === 0) return true; // private, loopback, this-host
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if malformed.
 *
 * This parser handles `::` compression and a trailing embedded IPv4, such as
 * `::ffff:127.0.0.1`, `::127.0.0.1` or `64:ff9b::10.0.0.1`. Every textual form
 * of an embedded v4 (mapped, compatible, NAT64, dotted or hex) collapses to the
 * same eight numbers, so `isPrivateIpv6` checks it once. Per-form regex matching
 * misses forms such as `::7f00:1` and `::ffff:0:7f00:1`.
 */
function parseIpv6(input: string): number[] | null {
  let str = input;

  // Rewrite a trailing dotted IPv4 as two hex groups, so the rest of the parser
  // deals only with hex groups. `::ffff:127.0.0.1` becomes `::ffff:7f00:1`.
  const dotted = str.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    str = str.slice(0, dotted.index) + `${hi}:${lo}`;
  }

  if (str.split("::").length > 2) return null; // `::` may appear at most once

  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  let groups: number[];
  if (str.includes("::")) {
    const [left, right] = str.split("::");
    const l = toGroups(left);
    const r = toGroups(right);
    if (l === null || r === null) return null;
    const missing = 8 - (l.length + r.length);
    if (missing < 0) return null;
    groups = [...l, ...new Array(missing).fill(0), ...r];
  } else {
    const g = toGroups(str);
    if (g === null) return null;
    groups = g;
  }

  return groups.length === 8 ? groups : null;
}

function isPrivateIpv6(g: number[]): boolean {
  const isZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);

  // These prefixes embed an IPv4: mapped (::ffff:0:0/96), compatible (::/96,
  // including :: and ::1), translated (::ffff:0:0:0/96) and NAT64
  // (64:ff9b::/96). For them, classify the low 32 bits as v4. Only these
  // prefixes embed a v4. A public IPv6 whose low bits resemble a private v4
  // must NOT be rewritten.
  const embedsV4 =
    (isZero(0, 5) && (g[5] === 0xffff || g[5] === 0)) || // mapped / compatible
    (isZero(0, 4) && g[4] === 0xffff && g[5] === 0) || // translated
    (g[0] === 0x64 && g[1] === 0xff9b && isZero(2, 6)); // NAT64
  if (embedsV4) {
    const v4: [number, number, number, number] = [
      (g[6] >> 8) & 0xff,
      g[6] & 0xff,
      (g[7] >> 8) & 0xff,
      g[7] & 0xff,
    ];
    return isPrivateIpv4(v4);
  }

  if (isZero(0, 7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  return false;
}
