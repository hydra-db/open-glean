/**
 * Server-side session store for API keys — encrypted httpOnly cookie.
 *
 * Security model:
 *   - The Hydra API key and the LLM provider key NEVER live in the browser
 *     (no localStorage, no JS-readable state, never inlined in the bundle).
 *   - After the user submits a key once, it is verified server-side and stored
 *     in an AES-256-GCM-encrypted httpOnly cookie. The browser can neither
 *     read nor tamper with it.
 *   - Every proxied request resolves the key server-side in this order:
 *       1. `Authorization: Bearer …` header (explicit per-request override)
 *       2. the encrypted session cookie
 *       3. the HYDRA_API_KEY server env var (deployment-level shared key)
 *
 * The encryption secret comes from OPEN_GLEAN_SESSION_SECRET. In production the
 * cookie is only set over HTTPS (secure flag).
 */
import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "open-glean.session";
const CIPHER = "aes-256-gcm";

export interface SessionData {
  hydraKey?: string;
  hydraBaseUrl?: string;
  llmKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
}

function secretKey(): Buffer {
  const raw = process.env.OPEN_GLEAN_SESSION_SECRET;
  if (raw && raw.length >= 16) {
    // Derive a stable 32-byte key from the configured secret.
    return createHash("sha256").update(raw).digest();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "OPEN_GLEAN_SESSION_SECRET must be set in production (any random 16+ char string).",
    );
  }
  // Dev fallback: a per-process ephemeral key. Sessions reset on restart —
  // acceptable locally, never in production.
  return createHash("sha256").update("open-glean-dev-secret").digest();
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${enc.toString("base64url")}.${tag.toString("base64url")}`;
}

function decrypt(payload: string): string | null {
  try {
    const [ivB64, dataB64, tagB64] = payload.split(".");
    if (!ivB64 || !dataB64 || !tagB64) return null;
    const decipher = createDecipheriv(
      CIPHER,
      secretKey(),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

/** Read the current session (returns {} when absent/corrupt). */
export async function getSession(): Promise<SessionData> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return {};
  const json = decrypt(raw);
  if (!json) return {};
  try {
    return JSON.parse(json) as SessionData;
  } catch {
    return {};
  }
}

/** Merge a patch into the session and set the cookie. */
export async function setSession(patch: SessionData): Promise<SessionData> {
  const current = await getSession();
  const next: SessionData = {
    ...current,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ),
    // explicit undefined values in the patch clear the field
    ...(Object.fromEntries(
      Object.entries(patch)
        .filter(([, v]) => v === undefined)
        .map(([k]) => [k, undefined]),
    ) as SessionData),
  };
  const store = await cookies();
  store.set(SESSION_COOKIE, encrypt(JSON.stringify(next)), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 90, // 90 days
  });
  return next;
}

/** Clear the session cookie entirely. */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export function maskKey(key: string): string {
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 8)}${"•".repeat(6)}${key.slice(-4)}`;
}