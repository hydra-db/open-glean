/**
 * Open Glean DocumentDB proxy Lambda.
 * Deployed inside the staging VPC — API Gateway fronts it with a shared
 * secret header. No database port is ever exposed to the internet.
 */
import { MongoClient } from "mongodb";
import { timingSafeEqual } from "node:crypto";

// Database name for chats. Defaults to `open_glean`.
const DB_NAME = process.env.MONGODB_DB || "open_glean";
const PROXY_KEY = process.env.PROXY_KEY;
const COLLECTION = "chats";

let cached = null;

async function client() {
  if (cached) return cached;

  // Strip any tlsCAFile= from the URI (it points to an EKS path) and pass
  // the bundled CA cert directly instead.
  const uri = process.env.MONGODB_URI.replace(/&?tlsCAFile=[^&]*/g, "");
  cached = new MongoClient(uri, {
    retryWrites: false,
    tls: true,
    // In Lambda, the deployment package is extracted to /var/task/
    tlsCAFile: "/var/task/rds-combined-ca-bundle.pem",
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
  });
  await cached.connect();
  return cached;
}

/** Compare two secrets without leaking their contents through timing. */
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function json(status, body) {
  return {
    statusCode: status,
    // No CORS header: the only caller is the server-side proxyFetch in
    // lib/mongo.ts. A wildcard origin on a chat read/write/delete API invites
    // cross-origin use that has no legitimate purpose here.
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Turn an incoming API Gateway path into a route key.
 *
 * The stage prefix is present on a REST API ("/prod/chats/abc") and absent on
 * an HTTP API using $default, a custom domain, or a Function URL
 * ("/chats/abc"). Stripping the first segment unconditionally broke the
 * stage-less form: "/chats/abc" became "abc", matched no route, and 404'd —
 * so every per-conversation read, rename and delete failed on those
 * deployments.
 *
 * Only strip a leading segment when it is NOT a route we serve.
 */
const ROUTES = new Set(["chats", "health"]);

/** Message fields a client may patch. Mirrors lib/mongo.ts. */
const MESSAGE_FIELDS = new Set([
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

export function normalizePath(rawPath) {
  const trimmed = String(rawPath ?? "").replace(/^\/+/, "");
  if (!trimmed) return "";
  const firstSegment = trimmed.split("/", 1)[0];
  if (ROUTES.has(firstSegment)) return trimmed;
  // Unknown leading segment: treat it as the stage and drop it.
  const rest = trimmed.slice(firstSegment.length).replace(/^\/+/, "");
  return rest || firstSegment;
}

export const handler = async (event) => {
  // Header casing varies by API Gateway type: HTTP APIs lowercase them, REST
  // APIs keep what the client sent. Match case-insensitively rather than
  // guessing two spellings.
  const headers = event.headers ?? {};
  const keyEntry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "x-proxy-key",
  );
  const key = keyEntry?.[1];
  if (!PROXY_KEY || !constantTimeEqual(key, PROXY_KEY)) {
    return json(401, { error: "Unauthorized" });
  }

  const method =
    event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const path = normalizePath(event.rawPath ?? event.path ?? "");

  // Parse the body here, not at the top: a malformed payload must answer 400.
  // An uncaught throw skips the error log at the bottom of this function and
  // leaves the caller with an opaque 502 and no diagnostic.
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "Malformed JSON body" });
  }

  // Health probe. Answered before the subject check, because a health check
  // has no subject and must not require one.
  if (path === "health" || path === "health/") {
    try {
      await (await client()).db(DB_NAME).command({ ping: 1 });
      return json(200, { ok: true });
    } catch (err) {
      console.error("[open-glean-proxy] health:", err);
      return json(503, { ok: false });
    }
  }

  // The subject scopes every operation. It arrives as a query parameter from
  // lib/mongo.ts (the app resolves it from the signed cookie and forwards it),
  // or in the body on POST. This path had none of the scoping the app has, so
  // a proxy deployment would have stayed globally readable while the direct
  // deployment was fixed.
  const url = new URL(event.rawPath ?? event.path ?? "/", "http://proxy.local");
  const qs = event.queryStringParameters ?? Object.fromEntries(url.searchParams);
  const sub = qs.sub ?? body.sub;
  if (!sub) return json(400, { error: "Missing sub" });

  const db = (await client()).db(DB_NAME);
  const col = db.collection(COLLECTION);

  try {
    if (path === "chats" || path === "chats/") {
      // Full export (GET ?full=1) and bulk erase (DELETE on the collection).
      // Without these the app's export and delete-all endpoints would work on
      // a direct deployment and silently fail on a proxy one — the split this
      // codebase keeps falling into.
      if (method === "GET" && (qs.full === "1" || qs.full === "true")) {
        const docs = await col
          .find({ sub }, { projection: { _id: 0, sub: 0 } })
          .sort({ updatedAt: -1 })
          .toArray();
        return json(200, { persisted: true, chats: docs });
      }
      if (method === "DELETE") {
        const res = await col.deleteMany({ sub });
        return json(200, { deleted: res.deletedCount ?? 0 });
      }
      if (method === "GET") {
        const docs = await col
          .find(
            { sub },
            {
              projection: {
                id: 1,
                title: 1,
                createdAt: 1,
                updatedAt: 1,
                // $size rather than the array: this pulled every message body
                // of up to 200 conversations over the wire for a count.
                messageCount: { $size: { $ifNull: ["$messages", []] } },
              },
            },
          )
          .sort({ updatedAt: -1 })
          .limit(200)
          .toArray();
        return json(200, {
          persisted: true,
          chats: docs.map((d) => ({
            id: String(d.id ?? d._id),
            title: d.title ?? "Untitled",
            createdAt: Number(d.createdAt ?? Date.now()),
            updatedAt: Number(d.updatedAt ?? Date.now()),
            messageCount: Number(d.messageCount ?? 0),
          })),
        });
      }
      if (method === "POST") {
        if (!body.conversation?.id) return json(400, { error: "Missing conversation" });
        const c = body.conversation;
        // Field by field, not a spread: a spread let the caller set any field,
        // including `sub`, i.e. plant a row under another subject.
        const ins = await col.insertOne({
          id: c.id,
          title: c.title ?? "New chat",
          createdAt: Number(c.createdAt ?? Date.now()),
          updatedAt: Number(c.updatedAt ?? Date.now()),
          messages: Array.isArray(c.messages) ? c.messages : [],
          sub,
        });
        return json(200, { persisted: ins.acknowledged });
      }
    }

    const idMatch = path.match(/^chats\/([^\/?#]+)/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (method === "GET") {
        const doc = await col.findOne({ id, sub });
        return json(200, {
          persisted: true,
          conversation: doc
            ? {
                id: String(doc.id ?? doc._id),
                title: doc.title ?? "Untitled",
                createdAt: Number(doc.createdAt ?? Date.now()),
                updatedAt: Number(doc.updatedAt ?? Date.now()),
                messages: Array.isArray(doc.messages) ? doc.messages : [],
              }
            : null,
        });
      }
      if (method === "PATCH") {
        const setFields = { updatedAt: Date.now() };
        const update = { $set: setFields };
        let arrayFilters;
        if (body.title !== undefined) setFields.title = body.title;
        if (body.appendMessage) update.$push = { messages: body.appendMessage };
        if (body.setMessage) {
          for (const [k, v] of Object.entries(body.setMessage.patch)) {
            // Allowlist: the key lands in a dotted $set path, so an
            // unvalidated one containing "." or "$" writes anywhere in the doc.
            if (!MESSAGE_FIELDS.has(k)) continue;
            setFields[`messages.$[m].${k}`] = v;
          }
          arrayFilters = [{ "m.id": body.setMessage.id }];
        }
        const res = await col.updateOne(
          { id, sub },
          update,
          arrayFilters ? { arrayFilters } : {},
        );
        return json(200, { persisted: res.matchedCount > 0 });
      }
      if (method === "DELETE") {
        const del = await col.deleteOne({ id, sub });
        // deletedCount, not acknowledged: the driver acknowledges a delete
        // that matched nothing, which here means "not yours".
        return json(200, { persisted: del.deletedCount > 0 });
      }
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    // Log the detail, return a generic message. Driver errors carry cluster
    // hostnames, replica-set topology and index names.
    console.error("[open-glean-proxy]", err);
    return json(500, { error: "Proxy error" });
  }
};
