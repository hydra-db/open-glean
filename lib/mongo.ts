/**
 * Chat persistence storage — MongoDB or AWS DocumentDB (staging).
 *
 * ── Plain MongoDB ──────────────────────────────────────────────────
 *   MONGODB_URI=mongodb://…            (or mongodb+srv://…)
 *   MONGODB_DB=open_glean
 *
 * ── AWS DocumentDB with IAM auth (from Vercel) ────────────────────
 *   MONGODB_URI is the bare cluster endpoint: docdb-xxx.cluster-xxx.docdb.<region>.amazonaws.com
 *   MONGODB_DB=open_glean
 *   AWS_REGION=<cluster region>               (e.g. ap-south-1)
 *   AWS_IAM_USER_ARN=<IAM user ARN>           (arn:aws:iam::<acct>:user/<name>)
 *   AWS_ACCESS_KEY_ID=<programmatic key>      (of that IAM user)
 *   AWS_SECRET_ACCESS_KEY=<secret>
 *
 *   The client generates a short-lived RDS auth token with
 *   @aws-sdk/rds-signer and connects with TLS (global CA bundle),
 *   retryWrites=false (DocumentDB doesn't support retryable writes).
 *   Tokens expire every 15 min; the client rotates them automatically.
 *
 * When neither is reachable the API routes respond with
 * { persisted: false } and the client store falls back to localStorage.
 */
import "server-only";
import { readFileSync } from "fs";
import path from "path";
import { MongoClient, type Db, type Collection } from "mongodb";
import { Signer } from "@aws-sdk/rds-signer";
import type { ChatMessage, Conversation } from "@/lib/types";
import { REAP_AFTER_MS } from "@/lib/zombieChats";

/** Database name for chat persistence. Defaults to `open_glean`. */
const DB_NAME = process.env.MONGODB_DB ?? "open_glean";
const COLLECTION = "chats";
const TOKEN_TTL_MS = 10 * 60 * 1000; // rotate with 5 min of headroom

const MONGODB_URI = process.env.MONGODB_URI ?? "";
const PROXY_KEY = process.env.MONGODB_PROXY_KEY ?? "";

/**
 * True when MONGODB_URI is an HTTPS proxy URL (API Gateway + Lambda) —
 * the app calls the REST proxy instead of connecting to the database
 * directly. This is how Vercel reaches a private DocumentDB cluster
 * without exposing any database port to the internet.
 */
function isProxyMode(): boolean {
  return MONGODB_URI.startsWith("https://") && PROXY_KEY !== "";
}

/**
 * True when a persistence backend is configured. When false, the app runs on
 * the browser localStorage fallback and no database is expected, so a health
 * probe must not treat "no database" as a failure.
 */
export const persistenceConfigured = MONGODB_URI !== "";

/** Base URL of the REST proxy (MONGODB_URI is the API Gateway endpoint). */
const PROXY_URL = MONGODB_URI.replace(/\/+$/, "");

/** Auth headers for the proxy. */
function proxyHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-proxy-key": PROXY_KEY,
  };
}

async function proxyFetch(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${PROXY_URL}${path}`, {
      ...init,
      headers: { ...proxyHeaders(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { persisted: false };
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { persisted: false };
  }
}

/** True when MONGODB_URI is a DocumentDB cluster endpoint (IAM auth). */
function isDocumentDB(): boolean {
  return (
    !isProxyMode() &&
    (/\.docdb\.[a-z0-9-]+\.amazonaws\.com/.test(MONGODB_URI) ||
      process.env.AWS_IAM_USER_ARN !== undefined)
  );
}

/**
 * Client cache on globalThis, not module scope.
 *
 * Next.js re-evaluates modules on every hot reload in development, so a
 * module-level `let` created a new MongoClient each time and never closed the
 * old one — the canonical Next + Mongo connection leak. A dev session that
 * edits this file a few dozen times exhausts the pool.
 */
const globalCache = globalThis as typeof globalThis & {
  __openGleanMongo?: {
    client: MongoClient | null;
    promise: Promise<MongoClient> | null;
  };
};
globalCache.__openGleanMongo ??= { client: null, promise: null };

let tokenPromise: Promise<string> | null = null;
let tokenAt = 0;

/** Bare host (no scheme, no credentials) — used by the signer. */
function docdbHost(): string {
  return MONGODB_URI
    .replace(/^mongodb(\+srv)?:\/\//, "")
    .replace(/\/.*$/, "")
    .split("@")
    .pop()!
    .split(":")[0]!;
}

/** Short-lived IAM auth token for DocumentDB (rds-db:connect). */
async function getIamToken(): Promise<string> {
  const now = Date.now();
  if (tokenPromise && now - tokenAt < TOKEN_TTL_MS) return tokenPromise;
  tokenAt = now;
  tokenPromise = new Signer({
    hostname: docdbHost(),
    port: 27017,
    username: process.env.AWS_IAM_USER_ARN!,
    region: process.env.AWS_REGION,
  })
    .getAuthToken()
    .catch((err) => {
      tokenPromise = null;
      throw err;
    });
  return tokenPromise;
}

/** DocumentDB global CA bundle (rds-combined-ca-bundle.pem), shipped in the repo. */
function caBundle(): Buffer {
  return readFileSync(
    path.join(process.cwd(), "certs", "rds-combined-ca-bundle.pem"),
  );
}

async function buildClient(): Promise<MongoClient> {
  if (isDocumentDB()) {
    const token = await getIamToken();
    const host = docdbHost();
    // DocumentDB: IAM user ARN as username, auth token as password, TLS
    // with the global CA bundle, retryable writes disabled.
    return new MongoClient(
      `mongodb://${encodeURIComponent(process.env.AWS_IAM_USER_ARN!)}:${encodeURIComponent(token)}@${host}:27017/?tls=true&tlsInsecure=false&retryWrites=false`,
      {
        tlsCAFile: caBundle() as never,
        serverSelectionTimeoutMS: 2500,
        connectTimeoutMS: 2500,
        // The driver defaults to 100 per instance. On a platform that scales
        // to many instances that is a direct route to exhausting the cluster's
        // connection limit.
        maxPoolSize: 10,
        minPoolSize: 0,
      },
    );
  }
  // Plain MongoDB (local, Atlas, or DocumentDB with native auth).
  return new MongoClient(MONGODB_URI || "mongodb://127.0.0.1:27017", {
    serverSelectionTimeoutMS: 2500,
    connectTimeoutMS: 2500,
    maxPoolSize: 10,
    minPoolSize: 0,
  });
}

async function getClient(): Promise<MongoClient> {
  const cache = globalCache.__openGleanMongo!;
  const cachedClient = cache.client;
  if (cachedClient) {
    // DocumentDB tokens expire: rebuild the client (new token) on rotation.
    if (!isDocumentDB()) return cachedClient;
    if (Date.now() - tokenAt < TOKEN_TTL_MS) return cachedClient;
    await cachedClient.close().catch(() => {});
    cache.client = null;
    cache.promise = null;
  }
  if (!cache.promise) {
    cache.promise = buildClient().then((cl) => {
      cache.client = cl;
      return cl;
    });
  }
  return cache.promise;
}

/**
 * Index creation, once per process.
 *
 * This used to run on EVERY call — two extra round trips per request, forever,
 * to create indexes that already existed. Now it is a memoized promise.
 */
let indexesReady: Promise<void> | null = null;

async function ensureIndexes(col: Collection<Conversation>): Promise<void> {
  indexesReady ??= (async () => {
    // Backs the scoped list query. Without it, listing a subject's chats
    // is a collection scan.
    await col.createIndex({ sub: 1, updatedAt: -1 }).catch(() => {});
    await col.createIndex({ updatedAt: -1 }).catch(() => {});
    // Log a failure here rather than swallowing it. An older deployment may
    // hold a non-unique { id: 1 } index, and MongoDB refuses to change an
    // existing index in place — so this quietly leaves the collection with no
    // uniqueness guarantee at all. The operator has to drop the old index.
    await col.createIndex({ id: 1 }, { unique: true }).catch((err: unknown) => {
      console.error(
        "[mongo] could not create the unique index on { id: 1 }. If an older " +
          "non-unique index exists, drop it and restart:",
        err,
      );
    });
  })();
  return indexesReady;
}

async function chats(): Promise<Collection<Conversation>> {
  const cl = await getClient();
  const db: Db = cl.db(DB_NAME);
  const col = db.collection<Conversation>(COLLECTION);
  await ensureIndexes(col);
  return col;
}

/**
 * Message fields a client may patch.
 *
 * Mirrors ChatMessage. Anything outside this set is dropped rather than
 * written: the keys land in a dotted MongoDB $set path, so an unvalidated key
 * containing "." or "$" could write anywhere in the document.
 */
const MESSAGE_FIELDS = new Set<string>([
  "role",
  "content",
  "status",
  "sources",
  "webCitations",
  "requestId",
  "feedback",
  "research",
  "error",
  "createdAt",
]);

export interface ChatListEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export async function listChats(sub: string, limit = 200): Promise<ChatListEntry[]> {
  if (isProxyMode()) {
    const res = (await proxyFetch(`/chats?sub=${encodeURIComponent(sub)}`)) as {
      persisted?: boolean;
      chats?: ChatListEntry[];
    };
    return res.chats ?? [];
  }
  const col = await chats();
  // The projection computes messageCount, which is not a field on
  // Conversation — hence the cast on the returned documents.
  const docs = (await col
    .find(
      // Was `{}` — every visitor saw every chat (S2, confirmed on production).
      { sub },
      {
        projection: {
          id: 1,
          title: 1,
          createdAt: 1,
          updatedAt: 1,
          // $size, not the array: this used to pull every message body of up
          // to 200 conversations over the wire to compute a count.
          messageCount: { $size: { $ifNull: ["$messages", []] } },
        },
      },
    )
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray()) as unknown as Array<Record<string, unknown>>;
  return docs.map((d) => ({
    id: String(d.id ?? d._id),
    title: (d.title as string) ?? "Untitled",
    createdAt: Number(d.createdAt ?? Date.now()),
    updatedAt: Number(d.updatedAt ?? Date.now()),
    messageCount: Number(d.messageCount ?? 0),
  }));
}

/**
 * Delete this subject's conversations that were started and never answered
 *.
 *
 * The write is eager, on submit, so a reload mid-answer still finds the
 * conversation. The cost is a row left behind when the answer never arrives.
 * This clears those.
 *
 * Runs on list rather than on a timer: there is no scheduler here, the query
 * is bounded by the { sub, updatedAt } index, and the only user who sees the
 * clutter is the one triggering the sweep. A failure is swallowed — a stale
 * row is cosmetic and must never break the history page.
 *
 * Not a TTL index, because the condition is "empty AND old" and a
 * TTL can only express "old". It would delete answered conversations too.
 */
export async function reapAbandoned(sub: string): Promise<number> {
  if (isProxyMode()) return 0; // The proxy has no sweep endpoint; see handler.mjs.
  try {
    const col = await chats();
    const cutoff = Date.now() - REAP_AFTER_MS;
    const res = await col.deleteMany({
      sub,
      updatedAt: { $lt: cutoff },
      createdAt: { $lt: cutoff },
      // No assistant message that either carries text or reached a terminal
      // status. Mirrors isAbandoned; lib/zombieChats.ts holds the rationale.
      messages: {
        $not: {
          $elemMatch: {
            role: "assistant",
            $or: [
              { content: { $regex: "\\S" } },
              { status: { $in: ["error", "stopped"] } },
            ],
          },
        },
      },
    });
    return res.deletedCount ?? 0;
  } catch {
    return 0;
  }
}

export async function getChat(id: string, sub: string): Promise<Conversation | null> {
  if (isProxyMode()) {
    const res = (await proxyFetch(
      `/chats/${encodeURIComponent(id)}?sub=${encodeURIComponent(sub)}`,
    )) as {
      conversation?: Conversation | null;
    };
    return res.conversation ?? null;
  }
  const col = await chats();
  // Scoped in the FILTER, never as a check after reading: a filter cannot be
  // forgotten by a later caller and cannot leak the row before the check runs.
  const doc = await col.findOne({ id, sub });
  if (!doc) return null;
  return {
    id: String(doc.id ?? doc._id),
    title: doc.title ?? "Untitled",
    createdAt: Number(doc.createdAt ?? Date.now()),
    updatedAt: Number(doc.updatedAt ?? Date.now()),
    messages: Array.isArray(doc.messages) ? doc.messages : [],
  };
}

/**
 * @returns false when the write did not land.
 *
 * Returned void before, discarding the proxy's own `persisted` flag, so the
 * route reported `persisted: true` for a create the proxy had rejected. The
 * client then believed the conversation existed server-side and every
 * subsequent append was queued against a row that was never inserted.
 */
export async function createChat(conv: Conversation, sub: string): Promise<boolean> {
  if (isProxyMode()) {
    const res = (await proxyFetch("/chats", {
      method: "POST",
      body: JSON.stringify({ conversation: conv, sub }),
    })) as { persisted?: boolean };
    return res.persisted === true;
  }
  const col = await chats();
  // Build the document field by field rather than spreading the request body.
  // A spread let a caller write arbitrary fields — including `sub` itself,
  // which would have let them plant a row under someone else's subject.
  const res = await col.insertOne({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messages: Array.isArray(conv.messages) ? conv.messages : [],
    sub,
  } as Conversation);
  return res.acknowledged;
}

export async function updateChat(
  id: string,
  sub: string,
  patch: {
    title?: string;
    appendMessage?: ChatMessage;
    setMessage?: { id: string; patch: Partial<ChatMessage> };
    touch?: boolean;
  },
): Promise<boolean> {
  if (isProxyMode()) {
    const res = (await proxyFetch(`/chats/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, sub }),
    })) as { persisted?: boolean };
    return res.persisted ?? false;
  }
  const col = await chats();
  const now = Date.now();
  const setFields: Record<string, unknown> = { updatedAt: now };
  const update: {
    $set: Record<string, unknown>;
    $push?: Record<string, unknown>;
  } = { $set: setFields };
  let arrayFilters: Record<string, unknown>[] | undefined;

  if (patch.title !== undefined) setFields.title = patch.title;
  if (patch.appendMessage) {
    update.$push = { messages: patch.appendMessage };
  }
  if (patch.setMessage) {
    for (const [k, v] of Object.entries(patch.setMessage.patch)) {
      // Allowlist the key. It was interpolated straight into a dotted $set
      // path from an unvalidated request body, so a key containing "." or "$"
      // wrote to an arbitrary sub-path of the document.
      if (!MESSAGE_FIELDS.has(k)) continue;
      setFields[`messages.$[m].${k}`] = v;
    }
    arrayFilters = [{ "m.id": patch.setMessage.id }];
  }

  const res = await col.updateOne(
    { id, sub },
    update,
    arrayFilters ? { arrayFilters } : {},
  );
  return res.matchedCount > 0;
}

/**
 * @returns false when the delete did not land.
 *
 * Same defect as createChat: the proxy result was discarded, so a delete that
 * failed upstream was reported as a success. The row vanished from the client
 * and from localStorage, then reappeared on the next hydration.
 */
export async function deleteChat(id: string, sub: string): Promise<boolean> {
  if (isProxyMode()) {
    const res = (await proxyFetch(
      `/chats/${encodeURIComponent(id)}?sub=${encodeURIComponent(sub)}`,
      {
      method: "DELETE",
    })) as { persisted?: boolean };
    return res.persisted === true;
  }
  const col = await chats();
  const res = await col.deleteOne({ id, sub });
  // deletedCount, not acknowledged: the driver acknowledges a delete that
  // matched nothing. Because this filter is scoped by subject, "not yours"
  // and "already gone" both produce deletedCount 0, and neither is a
  // successful delete of an existing row.
  return res.deletedCount > 0;
}

/**
 * Every conversation belonging to a subject, for export.
 *
 * The subject is anonymous and unrecoverable: clear the cookie and the rows
 * are orphaned forever, deletable by nobody. So the ability to take the data
 * out, and to delete it, has to exist while the user still holds the cookie.
 */
export async function exportChats(sub: string): Promise<Conversation[]> {
  if (isProxyMode()) {
    const res = (await proxyFetch(
      `/chats?sub=${encodeURIComponent(sub)}&full=1`,
    )) as { chats?: Conversation[] };
    return res.chats ?? [];
  }
  const col = await chats();
  const docs = await col
    .find({ sub }, { projection: { _id: 0, sub: 0 } })
    .sort({ updatedAt: -1 })
    .toArray();
  return docs as unknown as Conversation[];
}

/**
 * Delete every conversation belonging to a subject.
 *
 * @returns how many were removed.
 */
export async function deleteAllChats(sub: string): Promise<number> {
  if (isProxyMode()) {
    const res = (await proxyFetch(`/chats?sub=${encodeURIComponent(sub)}`, {
      method: "DELETE",
    })) as { deleted?: number };
    return Number(res.deleted ?? 0);
  }
  const col = await chats();
  const res = await col.deleteMany({ sub });
  return res.deletedCount ?? 0;
}

export async function pingOk(): Promise<boolean> {
  if (isProxyMode()) {
    // Dedicated health path, not /chats: that route now requires a subject and
    // would answer 400, so probing it would report every proxy deployment as
    // unhealthy.
    const res = (await proxyFetch("/health")) as { ok?: boolean };
    return res.ok === true;
  }
  try {
    const cl = await getClient();
    await cl.db("admin").command({ ping: 1 });
    return true;
  } catch {
    // Mutate the cached object; do NOT replace it. getClient() holds a
    // reference to it, so assigning a fresh object here wrote the reset into
    // an orphan and left the broken client in place — health then reported
    // "unreachable" forever, even after the database came back and writes
    // were succeeding again.
    const cache = globalCache.__openGleanMongo!;
    await cache.client?.close().catch(() => {});
    cache.client = null;
    cache.promise = null;
    return false;
  }
}