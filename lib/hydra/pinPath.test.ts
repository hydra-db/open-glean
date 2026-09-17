/**
 * The Hydra proxy sends a Bearer key on every upstream call. A path that
 * overrides the host would send that key to an attacker's server. pinPath must
 * keep every resolved URL on the base origin.
 */
import { describe, expect, it } from "vitest";
import { pinPath } from "./pinPath";

const BASE = "https://api.hydradb.com";

describe("pinPath", () => {
  it("resolves a normal path on the base origin", () => {
    expect(pinPath(BASE, "databases")?.href).toBe("https://api.hydradb.com/databases");
    expect(pinPath(BASE, "/context/list")?.href).toBe(
      "https://api.hydradb.com/context/list",
    );
  });

  it("neutralizes a // authority override by keeping it on the base origin", () => {
    // The exploit: new URL("//example.com/x", base) → example.com. Collapsing
    // the leading slashes turns it into a harmless path on the base host.
    const u = pinPath(BASE, "//example.com/anything");
    expect(u?.origin).toBe("https://api.hydradb.com");
    expect(u?.hostname).toBe("api.hydradb.com");
  });

  it("neutralizes extra leading slashes", () => {
    expect(pinPath(BASE, "///example.com/x")?.hostname).toBe("api.hydradb.com");
    expect(pinPath(BASE, "/////evil.com")?.hostname).toBe("api.hydradb.com");
  });

  it("keeps a plain host-like segment on the base origin", () => {
    expect(pinPath(BASE, "example.com/x")?.href).toBe(
      "https://api.hydradb.com/example.com/x",
    );
  });

  it("does not let an absolute URL escape the base origin", () => {
    expect(pinPath(BASE, "https://evil.com/x")?.hostname).toBe("api.hydradb.com");
    expect(pinPath(BASE, "http://evil.com/x")?.hostname).toBe("api.hydradb.com");
  });

  it("returns null for a bad base URL", () => {
    expect(pinPath("not a url", "databases")).toBeNull();
  });
});
