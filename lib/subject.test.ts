/**
 * The anonymous per-browser subject (Phase 1).
 *
 * The subject answers one question: "is this the same browser that created
 * this row?" It is not a user and must never be described as one.
 *
 * It is signed, not encrypted. There is no secret inside it — it is an opaque
 * random id — so confidentiality buys nothing. Integrity is what matters: a
 * forged subject would be a way to claim someone else's chats.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mintSubject, readSubject, SUBJECT_COOKIE } from "./subject";

beforeEach(() => {
  process.env.OPEN_GLEAN_SESSION_SECRET = "test-secret-at-least-16-characters";
});

describe("subject", () => {
  it("round-trips a freshly minted subject", () => {
    const minted = mintSubject();
    expect(readSubject(minted)).toBeTruthy();
  });

  it("mints a different subject every time", () => {
    expect(mintSubject()).not.toBe(mintSubject());
  });

  it("returns a stable id across reads", () => {
    const minted = mintSubject();
    expect(readSubject(minted)).toBe(readSubject(minted));
  });

  it("rejects a tampered payload", () => {
    const minted = mintSubject();
    const [id, sig] = minted.split(".");
    expect(readSubject(`${id}x.${sig}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const minted = mintSubject();
    const [id] = minted.split(".");
    expect(readSubject(`${id}.deadbeef`)).toBeNull();
  });

  it("rejects an unsigned value", () => {
    // Someone hand-setting the cookie to a bare uuid must not be accepted.
    expect(readSubject("11111111-2222-3333-4444-555555555555")).toBeNull();
  });

  it("rejects empty, missing and malformed values", () => {
    expect(readSubject(undefined)).toBeNull();
    expect(readSubject("")).toBeNull();
    expect(readSubject(".")).toBeNull();
    expect(readSubject("a.b.c")).toBeNull();
  });

  it("rejects a subject signed with a different secret", () => {
    const minted = mintSubject();
    process.env.OPEN_GLEAN_SESSION_SECRET = "a-completely-different-secret-value";
    expect(readSubject(minted)).toBeNull();
  });

  it("uses a cookie name distinct from the credential session", () => {
    // They must be separate: clearing credentials on disconnect must not
    // destroy the identity that owns the chats.
    expect(SUBJECT_COOKIE).toBe("open-glean.sub");
    expect(SUBJECT_COOKIE).not.toBe("open-glean.session");
  });
});
