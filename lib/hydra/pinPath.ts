/**
 * Resolve a caller-supplied path against a trusted base URL, pinned to the base
 * origin.
 *
 * `new URL("//host/x", base)` treats `//host` as a new authority, so a path
 * that starts with `//` (or the percent-encoded `%2F%2F`, which decodes to that
 * before this runs) would override the host. The Hydra proxy sends a Bearer key
 * on every upstream call, so an unpinned path lets a caller redirect that
 * credentialed request to a server they control and exfiltrate the key. Collapse
 * leading slashes and reject anything that resolves off the base origin.
 *
 * Returns the resolved URL, or null when the path escapes the base origin.
 */
export function pinPath(baseUrl: string, path: string): URL | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  const rel = "/" + path.replace(/^\/+/, "");
  let url: URL;
  try {
    url = new URL(rel, base);
  } catch {
    return null;
  }
  return url.origin === base.origin ? url : null;
}
