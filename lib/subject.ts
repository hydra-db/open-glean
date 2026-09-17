/**
 * The anonymous per-browser subject.
 *
 * Open Glean has no login. The subject answers "who is asking": an opaque random
 * id, minted once per browser, stamped on each chat row. It must match on every
 * read, update and delete.
 *
 * The limits below are deliberate, and the user-facing copy must reflect them:
 *   - It is NOT authentication. It identifies a browser, not a person.
 *   - Clearing cookies loses the history. Recovery is impossible by design,
 *     because nothing else ties the rows to the browser.
 *   - Two browsers, or two devices, are two different subjects.
 *
 * The value is signed, not encrypted. It carries no secret, so confidentiality
 * buys nothing, but a forged subject would claim another browser's chats. The
 * signature is HMAC-SHA256 over the OPEN_GLEAN_SESSION_SECRET that the credential
 * session also uses.
 *
 * This module does not import `server-only`. proxy.ts needs it too, and in
 * Next 16 the proxy runs on the Node.js runtime, so both sides share this one
 * implementation.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Its own cookie, separate from `open-glean.session`.
 *
 * Disconnecting a key clears the credential session. If the subject shared that
 * cookie, every disconnect would orphan the browser's chat history permanently.
 */
export const SUBJECT_COOKIE = "open-glean.sub";

function secret(): string {
  const raw = process.env.OPEN_GLEAN_SESSION_SECRET;
  if (raw && raw.length >= 16) return raw;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "OPEN_GLEAN_SESSION_SECRET must be set in production (any random 16+ char string).",
    );
  }
  // Matches lib/session.ts: a fixed dev key, so subjects survive a local
  // restart. The throw above keeps this path out of production.
  return "open-glean-dev-secret";
}

function sign(id: string): string {
  return createHmac("sha256", secret()).update(id).digest("base64url");
}

/** A new signed subject, ready to be written to the cookie. */
export function mintSubject(): string {
  const id = randomUUID();
  return `${id}.${sign(id)}`;
}

/**
 * Verify a cookie value and return the subject id.
 *
 * @returns the id, or null when the value is absent, malformed, or not signed
 *          by this deployment.
 */
export function readSubject(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [id, signature] = parts;
  if (!id || !signature) return null;

  const expected = Buffer.from(sign(id));
  const actual = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? id : null;
}
