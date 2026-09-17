/**
 * /api/hydra/[...path] — bridge from the browser to the Hydra DB backend.
 *
 * The browser sends the user's API key in `Authorization: Bearer`; this route
 * builds a fresh `HydraDB` (typed `@hydradb/sdk` client — verified working)
 * and dispatches the call to its typed methods. The SDK owns auth headers,
 * body serialization, retries and envelope parsing.
 *
 * Browser-facing routes map 1:1 to SDK methods:
 *   GET  /databases                    → client.listDatabases()
 *   GET  /databases/collections        → client.collections(db)
 *   GET  /databases/status             → client.readiness(db)
 *   GET  /context/list                 → client.list({ database, collection, type, page, pageSize })
 *   GET  /context/inspect              → client.inspect({ id, database, collection })
 *   GET  /context/relations            → client.relations({ database, collection, limit })
 *   POST /query                        → client.query({ database, collection, query, type, ... })
 *   POST /context/ingest               → client.ingestItems() / ingestFile() (multipart or JSON)
 *   POST /context/status               → client.ingestionStatus({ ids })
 *   POST /context                      → client.delete({ ids, type })
 *   GET  /connectors                   → client.listConnectors()
 *   GET  /connector-catalog            → client.listProviders({})
 *   GET  /connector-catalog/{p}/credential-schema → client.listProviders({ id })
 *
 * Untyped connector operations (discover, create, sync, configure, resource
 * list) use a raw fetch to the backend base URL carrying the SDK's auth token;
 * this is the only place `fetch` is used, and it is correct because those
 * endpoints have no generated SDK methods.
 */
import { NextRequest, NextResponse } from "next/server";
import { HydraDB, type HydraConfig } from "@/lib/hydra";
import { getSession } from "@/lib/session";
import { assertSafeLlmUrl } from "@/lib/safeUrl";
import { pinPath } from "@/lib/hydra/pinPath";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

/** Matches the SDK's default, so typed and raw calls behave the same. */
const RAW_FETCH_TIMEOUT_MS = 15_000;

/**
 * Key resolution (server-side only, in priority order):
 *   1. `Authorization: Bearer …` header (explicit per-request override)
 *   2. the encrypted httpOnly session cookie (set via /api/auth/key)
 *   3. the HYDRA_API_KEY server env var (deployment-level shared key)
 * Base URL resolves the same way (x-hydra-base-url header → session →
 * HYDRA_BASE_URL env).
 */
async function buildClient(
  req: NextRequest,
): Promise<{
  client?: HydraDB;
  error?: NextResponse;
  envDatabase?: string;
}> {
  const auth = req.headers.get("authorization") ?? "";
  const headerKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  let sessionKey: string | undefined;
  let sessionBaseUrl: string | undefined;
  try {
    const session = await getSession();
    sessionKey = session.hydraKey;
    sessionBaseUrl = session.hydraBaseUrl;
  } catch {
    // Session unavailable — fall through to env.
  }

  const envKey = process.env.HYDRA_API_KEY?.trim() || undefined;
  const key = headerKey || sessionKey || envKey;
  if (!key) {
    return {
      error: NextResponse.json(
        { error: "Missing Hydra DB API key. Configure it in Settings." },
        { status: 401 },
      ),
    };
  }

  // The key and the base URL must come from the SAME origin. Resolving them
  // independently let a caller send only `x-hydra-base-url`, inherit the
  // session or deployment key, and have it delivered to a host they chose as
  // `Authorization: Bearer`. This mirrors resolveLlmCreds (lib/llmServer.ts),
  // which already got this right for the LLM path.
  const headerBaseUrl = req.headers.get("x-hydra-base-url")?.trim();
  const baseUrl = headerKey
    ? headerBaseUrl || sessionBaseUrl || process.env.HYDRA_BASE_URL?.trim() || undefined
    : sessionBaseUrl || process.env.HYDRA_BASE_URL?.trim() || undefined;

  // Validate whichever URL won. A URL stored in the session (or set in the
  // deployment env) is no more trustworthy at fetch time than one handed in on
  // the request, so the check lives at this single choke point.
  if (baseUrl) {
    try {
      assertSafeLlmUrl(baseUrl);
    } catch (err) {
      return {
        error: NextResponse.json(
          { error: err instanceof Error ? err.message : "Invalid Hydra base URL." },
          { status: 400 },
        ),
      };
    }
  }

  const cfg: HydraConfig = { token: key };
  if (baseUrl) cfg.baseUrl = baseUrl;
  // /context/relations walks the graph and routinely exceeds the 15s default:
  // allowlist by path BEFORE constructing the client so the timeout applies.
  if (req.nextUrl.pathname.endsWith("/context/relations")) {
    cfg.timeoutSeconds = 45;
  }
  // Deployment-level default tenant: when the caller doesn't send a database
  // (and neither does the session), HYDRA_DEFAULT_DATABASE fills it in so
  // the scope switcher's "All databases" view doesn't silently miss data.
  const envDatabase = process.env.HYDRA_DEFAULT_DATABASE?.trim();
  if (envDatabase) cfg.database = envDatabase;
  return { client: new HydraDB(cfg), envDatabase };
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
}
/**
 * Pull the human sentence out of an SDK error.
 *
 * The SDK stringifies the whole upstream envelope into its message ("Status
 * code: 401\nBody: { ... }"), so passing it through put request ids, api
 * versions and latency figures on screen where the user needed "your API key
 * is not valid". The envelope carries `error.message`; find it, and fall back
 * to the status line rather than the body dump.
 */
function humanMessage(err: unknown): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : "";
  const statusMatch = /Status code:\s*(\d{3})/.exec(raw);
  const status = statusMatch ? Number(statusMatch[1]) : 502;

  const bodyStart = raw.indexOf("{");
  if (bodyStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(bodyStart)) as Record<string, unknown>;
      for (const key of ["error", "detail", "message"]) {
        const v = body[key];
        if (typeof v === "string" && v.trim()) return { message: v.trim(), status };
        if (v && typeof v === "object") {
          const nested = (v as Record<string, unknown>).message;
          if (typeof nested === "string" && nested.trim()) {
            return { message: nested.trim(), status };
          }
        }
      }
    } catch {
      // Not JSON after all — fall through.
    }
  }

  const firstLine = raw.split("\n")[0]?.trim();
  return {
    message: firstLine && !firstLine.includes("{") ? firstLine : "Hydra request failed.",
    status,
  };
}

function fail(err: unknown, path: string) {
  // The full error, envelope and all, stays in the server log.
  console.error(`[hydra-proxy] ${path}:`, err);
  const { message, status } = humanMessage(err);
  // Pass the upstream status through: a 401 rendered as a 502 told the client
  // the server was broken when the key was simply wrong.
  return NextResponse.json({ error: message }, { status });
}

async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const raw = await req.text();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bool(v: unknown): boolean | undefined {
  return v === "true" || v === true ? true : v === "false" || v === false ? false : undefined;
}

/** Raw fetch for untyped connector endpoints (keeps SDK auth). */
async function rawFetch(
  client: HydraDB,
  method: string,
  upstreamPath: string,
  q: URLSearchParams,
  body?: unknown,
): Promise<NextResponse> {
  // Pin the path to the Hydra base origin. Without this a `//host` path would
  // override the authority and send the Bearer key to an attacker-chosen host.
  const url = pinPath(client.baseUrl, upstreamPath);
  if (!url) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }
  for (const [k, v] of q.entries()) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method,
    // The SDK applies its own timeout; these hand-rolled calls bypass it, so
    // without this a hung upstream held the serverless function until the
    // platform killed it.
    signal: AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${client.token}`,
      // The SDK sets this on every call it makes; these hand-rolled requests
      // bypass the SDK, and Hydra requires it on raw HTTP (docs §1).
      "api-version": "2",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return NextResponse.json(payload, { status: res.status });
}

// ── GET ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest, ctx: Ctx) {
  const { path: raw } = await ctx.params;
  const path = `/${(raw ?? []).join("/")}`;
  const q = req.nextUrl.searchParams;
  const { client, error } = await buildClient(req);
  if (error) return error;
  const c = client!;

  try {
    // Databases
    if (path === "/databases") return json(await c.listDatabases());
    if (path === "/databases/collections") {
      const db = q.get("database") ?? c.database ?? "";
      return json(await c.collections(db));
    }
    if (path === "/databases/status") {
      const db = q.get("database") ?? c.database ?? "";
      return json(await c.readiness(db));
    }

    // Context
    if (path === "/context/list") {
      const body: Record<string, unknown> = {};
      const db = q.get("database") ?? c.database;
      if (db) body.database = db;
      if (q.get("collection")) body.collection = q.get("collection");
      const type = q.get("type");
      if (type === "memory" || type === "knowledge") body.type = type;
      if (q.get("page")) body.page = Number(q.get("page")) || 1;
      if (q.get("pageSize")) body.pageSize = Number(q.get("pageSize")) || 50;
      if (q.get("ids")) body.ids = q.get("ids")!.split(",").filter(Boolean);
      return json(await c.list(body as never));
    }
    if (path === "/context/inspect") {
      const id = q.get("id") ?? "";
      if (!id) return json({ error: "Missing id" }, 400);
      return json(
        await c.inspect({
          id,
          database: q.get("database") ?? c.database ?? "",
          ...(q.get("collection") ? { collection: q.get("collection")! } : {}),
        }),
      );
    }
    if (path === "/context/relations") {
      return json(
        await c.relations({
          database: q.get("database") ?? c.database ?? "",
          ...(q.get("collection") ? { collection: q.get("collection")! } : {}),
          ...(q.get("limit") ? { limit: Number(q.get("limit")) } : {}),
          ...(q.get("id") ? { id: q.get("id")! } : {}),
        }),
      );
    }

    // Connectors / catalog
    if (path === "/connectors") return json(await c.listConnectors());
    // NOTE: the SDK's listProviders is generated without auth, but the live
    // API requires it — go through the raw fetch (carries the token).
    if (path === "/connector-catalog") {
      return rawFetch(c, "GET", "/connector-catalog", q);
    }
    const catalogMatch = path.match(/^\/connector-catalog\/([^/]+)\/credential-schema$/);
    if (catalogMatch) {
      return rawFetch(
        c,
        "GET",
        `/connector-catalog/${catalogMatch[1]}/credential-schema`,
        q,
      );
    }

    return rawFetch(c, "GET", path, q);
  } catch (err) {
    return fail(err, path);
  }
}

// ── POST ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest, ctx: Ctx) {
  const { path: raw } = await ctx.params;
  const path = `/${(raw ?? []).join("/")}`;
  const q = req.nextUrl.searchParams;
  const { client, error } = await buildClient(req);
  if (error) return error;
  const c = client!;

  const ct = req.headers.get("content-type") ?? "";
  const isMultipart = ct.includes("multipart/form-data");
  const body = isMultipart ? await req.formData() : await readJson(req);

  try {
    // Search — raw fetch: the SDK's typed query drops the `collections`
    // multi-scope selector (verified against the live API).
    if (path === "/query") {
      const b = body as Record<string, unknown>;
      const query = (b.query as string) ?? "";
      if (!query.trim()) return json({ error: "Missing query" }, 400);
      const payload: Record<string, unknown> = {
        query,
      };
      // Omit empty database values so the client's default tenant applies.
      if (typeof b.database === "string" && b.database.trim()) {
        payload.database = b.database.trim();
      } else if (c.database) {
        payload.database = c.database;
      }
      // This is a raw fetch, so it does NOT get the SDK's camelCase ->
      // snake_case conversion. Every key below must be written in the wire
      // spelling the API expects; camelCase keys are silently ignored, which
      // previously made max_results, graph_context and metadata_filters
      // (i.e. the whole filters UI) no-ops.
      //
      // `collection` and `collections` are mutually exclusive upstream — the
      // multi-collection selector wins when both arrive. The SDK supports a
      // weighted map as well as a list, so accept both here.
      const collectionsRaw = b.collections;
      const collectionsList = Array.isArray(collectionsRaw)
        ? collectionsRaw.filter((c): c is string => typeof c === "string" && c.trim() !== "")
        : [];
      const collectionsMap =
        !Array.isArray(collectionsRaw) &&
        collectionsRaw &&
        typeof collectionsRaw === "object"
          ? Object.fromEntries(
              Object.entries(collectionsRaw as Record<string, unknown>).filter(
                ([k, v]) => k.trim() !== "" && typeof v === "number" && v > 0,
              ),
            )
          : {};
      if (collectionsList.length > 0) {
        payload.collections = collectionsList;
      } else if (Object.keys(collectionsMap).length > 0) {
        payload.collections = collectionsMap;
      } else if (b.collection) {
        payload.collection = b.collection;
      }
      const type = (b.type as string) ?? (b.kind as string) ?? "all";
      if (["all", "knowledge", "memory"].includes(type)) payload.type = type;
      if (b.maxResults != null) payload.max_results = Number(b.maxResults);
      if (b.mode) payload.mode = b.mode;
      if (b.graphContext != null) payload.graph_context = bool(b.graphContext);
      if (b.alpha != null) payload.alpha = b.alpha === "auto" ? "auto" : Number(b.alpha);
      if (b.recencyBias != null) payload.recency_bias = Number(b.recencyBias);
      if (Array.isArray(b.ids)) payload.ids = b.ids;
      if (b.metadataFilters) payload.metadata_filters = b.metadataFilters;
      if (b.queryBy) payload.query_by = b.queryBy;
      if (b.operator) payload.operator = b.operator;
      if (b.numRelatedChunks != null) {
        payload.num_related_chunks = Number(b.numRelatedChunks);
      }
      if (b.queryApps != null) payload.query_apps = bool(b.queryApps);
      if (b.queryForcefulRelations != null) {
        payload.query_forceful_relations = bool(b.queryForcefulRelations);
      }
      if (typeof b.additionalContext === "string" && b.additionalContext.trim()) {
        payload.additional_context = b.additionalContext.trim();
      }
      if (b.temporalNow) payload.temporal_now = b.temporalNow;
      return rawFetch(c, "POST", "/query", q, payload);
    }

    // Retrieval-quality feedback for a past /query.
    if (path === "/feedback") {
      const b = body as Record<string, unknown>;
      const requestId = typeof b.requestId === "string" ? b.requestId.trim() : "";
      if (!requestId) return json({ error: "Missing requestId" }, 400);
      const rating = b.rating;
      await c.submitFeedback({
        requestId,
        feedback: typeof b.feedback === "string" ? b.feedback : undefined,
        rating:
          rating === "positive" || rating === "negative" || rating === "neutral"
            ? rating
            : undefined,
        source: b.source === "agent" ? "agent" : "user",
        database: typeof b.database === "string" ? b.database : undefined,
        collection: typeof b.collection === "string" ? b.collection : undefined,
      });
      return json({ ok: true });
    }

    // Context list (POST with JSON body)
    if (path === "/context/list") {
      const b = body as Record<string, unknown>;
      const listBody: Record<string, unknown> = {};
      const db = (b.database as string) ?? c.database;
      if (db) listBody.database = db;
      if (b.collection) listBody.collection = b.collection;
      if (b.type === "memory" || b.type === "knowledge") listBody.type = b.type;
      if (b.page != null) listBody.page = Number(b.page) || 1;
      if (b.pageSize != null) listBody.pageSize = Number(b.pageSize) || 50;
      if (Array.isArray(b.ids)) listBody.ids = b.ids;
      return json(await c.list(listBody as never));
    }

    // Ingest (multipart)
    if (path === "/context/ingest" && isMultipart) {
      const form = body as FormData;
      const type = (form.get("type") as string) ?? "memory";
      const db = (form.get("database") as string) || c.database;
      const col = (form.get("collection") as string) || undefined;
      const upsert = bool(form.get("upsert"));
      if (type === "knowledge") {
        const file = form.get("documents");
        const filename = (form.get("filename") as string) ?? "document.md";
        if (file instanceof File) {
          return json(
            await c.ingestFile(file, filename, file.type, {
              ...(db ? { database: db as string } : {}),
              ...(col ? { collection: col as string } : {}),
              ...(upsert !== undefined ? { upsert } : {}),
            }),
          );
        }
        return json({ success: 0, failed: 1, errors: [{ message: "No document file in request" }] }, 400);
      }
      // memory
      const memoriesRaw = (form.get("memories") as string) ?? "[]";
      let items: Record<string, unknown>[] = [];
      try {
        items = JSON.parse(memoriesRaw);
      } catch {
        items = [];
      }
      if (!Array.isArray(items)) items = [];
      return json(
        await c.ingestItems(items, {
          ...(db ? { database: db as string } : {}),
          ...(col ? { collection: col as string } : {}),
          ...(upsert !== undefined ? { upsert } : {}),
        }),
      );
    }

    // Ingest (JSON body)
    if (path === "/context/ingest") {
      const b = body as Record<string, unknown>;
      const type = (b.type as string) === "knowledge" ? "knowledge" : "memory";
      const db = (b.database as string) ?? c.database;
      const col = (b.collection as string) || undefined;
      if (type === "memory") {
        const items = Array.isArray(b.memories) ? (b.memories as Record<string, unknown>[]) : [];
        if (!items.length) return json({ success: 0, failed: 1, errors: [{ message: "No memories in request" }] }, 400);
        return json(
          await c.ingestItems(items, {
            ...(db ? { database: db as string } : {}),
            ...(col ? { collection: col as string } : {}),
            ...(bool(b.upsert) !== undefined ? { upsert: bool(b.upsert)! } : {}),
          }),
        );
      }
      // knowledge JSON — pass through raw (backend accepts { type, documents }?)
      return rawFetch(c, "POST", path, q, b);
    }

    // Status / delete
    if (path === "/context/status") {
      const ids = (body as Record<string, unknown>).ids;
      if (!Array.isArray(ids)) return json({ error: "Missing ids" }, 400);
      return json(await c.ingestionStatus({ ids: ids as string[] }));
    }
    if (path === "/context") {
      const b = body as Record<string, unknown>;
      const ids = Array.isArray(b.ids) ? (b.ids as string[]) : [];
      if (!ids.length) return json({ success: false, message: "No ids provided" }, 400);
      const kind = (b.type as string) === "knowledge" ? "knowledge" : "memory";
      const scope: { database?: string; collection?: string } = {};
      const db = (b.database as string) ?? c.database;
      if (db) scope.database = db;
      if (b.collection) scope.collection = b.collection as string;
      return json(await c.delete({ ids, kind, ...scope }));
    }

    // Connectors — typed where available, raw otherwise
    if (path === "/connectors") {
      const b = body as Record<string, unknown>;
      const provider = (b.provider as string) ?? "";
      if (!provider) return json({ error: "Missing provider" }, 400);
      const col = (b.collection as string) || (b.sub_tenant_id as string) || undefined;
      const db = (b.database as string) ?? (b.tenant_id as string) ?? c.database;
      const payload: Record<string, unknown> = {
        provider,
        auth_type: (b.auth_type as string) ?? "api_token",
        credentials: (b.credentials as Record<string, unknown>) ?? {},
      };
      if (col) payload.collection = col;
      if (db) payload.database = db;
      if (b.sync_interval_seconds) payload.syncIntervalSeconds = Number(b.sync_interval_seconds);
      if (b.syncEngine) payload.syncEngine = b.syncEngine;
      if (b.name) payload.name = b.name;
      const res = await c.sdk.connectors.create(payload as never);
      return json(res);
    }
    if (path === "/connector-discovery") {
      const b = body as Record<string, unknown>;
      const payload = {
        provider: (b.provider as string) ?? "",
        auth_type: (b.auth_type as string) ?? "api_token",
        database: (b.database as string) ?? c.database ?? "",
        credentials: (b.credentials as Record<string, unknown>) ?? {},
        ...((b.collection as string) ? { collection: b.collection } : {}),
      };
      const res = await c.sdk.connectors.discover(payload as never);
      return json(res);
    }
    const syncMatch = path.match(/^\/connectors\/([^/]+)\/sync$/);
    if (syncMatch) {
      const res = await c.sdk.connectors.sync({ id: decodeURIComponent(syncMatch[1]!) });
      return json(res);
    }
    const cfgMatch = path.match(/^\/connectors\/([^/]+)\/configure$/);
    if (cfgMatch) {
      const b = body as Record<string, unknown>;
      const res = await c.sdk.connectors.configure({
        id: decodeURIComponent(cfgMatch[1]!),
        ...b,
      } as never);
      return json(res);
    }
    const disMatch = path.match(/^\/connectors\/([^/]+)\/discover$/);
    if (disMatch) {
      const b = body as Record<string, unknown>;
      const res = await c.sdk.connectors.discover({
        id: decodeURIComponent(disMatch[1]!),
        ...b,
      } as never);
      return json(res);
    }

    return rawFetch(c, "POST", path, q, body);
  } catch (err) {
    return fail(err, path);
  }
}

// ── DELETE ──────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { path: raw } = await ctx.params;
  const path = `/${(raw ?? []).join("/")}`;
  const q = req.nextUrl.searchParams;
  const { client, error } = await buildClient(req);
  if (error) return error;
  const c = client!;
  try {
    const connMatch = path.match(/^\/connectors\/([^/]+)$/);
    if (connMatch) {
      const res = await c.sdk.connectors.delete({ id: decodeURIComponent(connMatch[1]!) });
      return json(res);
    }
    return rawFetch(c, "DELETE", path, q);
  } catch (err) {
    return fail(err, path);
  }
}

// ── PATCH ───────────────────────────────────────────────────────────
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { path: raw } = await ctx.params;
  const path = `/${(raw ?? []).join("/")}`;
  const q = req.nextUrl.searchParams;
  const { client, error } = await buildClient(req);
  if (error) return error;
  const c = client!;
  try {
    const body = await readJson(req);
    return rawFetch(c, "PATCH", path, q, body);
  } catch (err) {
    return fail(err, path);
  }
}