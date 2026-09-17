"use client";

/**
 * Browser-side Hydra API client.
 *
 * Every call goes through the local proxy `/api/hydra/...`, authenticated with
 * the user's own API key (from the config store). The key never touches any
 * server-side storage of ours — the proxy uses it per request and discards it.
 *
 * The returned client is memoized on the relevant config fields so consumers
 * can safely use it in effect dependency arrays without re-render loops.
 */
import { useMemo } from "react";
import { useAppConfig } from "@/lib/store/config";
import type {
  ConnectorInfo,
  DatabaseInfo,
  HydraMemory,
  HydraSource,
  IngestionItem,
  RelationGroup,
  SearchResponse,
} from "@/lib/types";

/**
 * Pull a human-readable message out of an error body.
 *
 * Bodies vary: `{error: "text"}`, `{error: {code, message}}`, `{detail: {...}}`
 * and `{message}` all occur. Anything that is not a usable string is skipped
 * rather than coerced, so an object can never reach the UI as "[object Object]".
 */
function extractMessage(payload: Record<string, unknown>): string | undefined {
  for (const key of ["error", "detail", "message"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).message;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return undefined;
}

export class HydraApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HydraApiError";
    this.status = status;
  }
}

async function request(
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  let url = path.startsWith("/") ? path : `/${path}`;
  if (init.query) {
    const qs = new URLSearchParams(init.query).toString();
    url = qs ? `${url}?${qs}` : url;
  }
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);

  return fetch(`/api/hydra${url}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}

async function parseBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (res.ok) {
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
  let message = res.statusText || "Request failed";
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    // Hydra returns `error` and `detail` as OBJECTS ({ code, message }), not
    // strings. Reading them directly stringified to "[object Object]" and
    // surfaced that to the user as the failure reason.
    message = extractMessage(payload) ?? message;
  } catch {
    // non-JSON error body — keep statusText
  }
  throw new HydraApiError(message, res.status);
}

export interface SearchOpts {
  kind?: "memory" | "knowledge" | "all";
  maxResults?: number;
  mode?: "fast" | "thinking" | "auto";
  graphContext?: boolean;
  metadataFilters?: Record<string, unknown>;
  collection?: string;
  /** Multi-collection scope (used when no single collection is selected). */
  collections?: string[];
  database?: string;
}

export interface HydraClient {
  config: ReturnType<typeof useAppConfig>["config"];
  headers: Record<string, string>;
  raw: (
    path: string,
    init?: RequestInit & { query?: Record<string, string> },
  ) => Promise<Response>;
  get: <T = unknown>(path: string, query?: Record<string, string>) => Promise<T>;
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  del: <T = unknown>(path: string) => Promise<T>;
  uploadForm: <T = unknown>(path: string, form: FormData) => Promise<T>;
  search: (query: string, opts?: SearchOpts) => Promise<SearchResponse>;
  listDatabases: () => Promise<{ tenants: DatabaseInfo[]; count: number }>;
  createDatabase: (database: string) => Promise<{ status: string; tenant_id: string; message: string }>;
  listCollections: (database: string) => Promise<{ sub_tenant_ids: string[]; count: number }>;
  listMemories: (opts?: {
    page?: number;
    pageSize?: number;
    collection?: string;
    database?: string;
  }) => Promise<{
    sources?: HydraMemory[];
    user_memories?: HydraMemory[];
    count?: number;
    total?: number;
    data?: HydraMemory[];
  }>;
  listKnowledge: (opts?: {
    page?: number;
    pageSize?: number;
    collection?: string;
    database?: string;
  }) => Promise<{ sources?: HydraSource[]; count?: number; total?: number; data?: HydraSource[] }>;
  inspect: (id: string, opts?: { mode?: string; collection?: string; database?: string }) => Promise<HydraSource>;
  ingestMemory: (item: {
    text?: string;
    pairs?: { user: string; assistant: string }[];
    title?: string;
    infer?: boolean;
    isMarkdown?: boolean;
    customInstructions?: string;
    upsert?: boolean;
    metadata?: Record<string, unknown>;
    collection?: string;
    database?: string;
  }) => Promise<{ success: number; failed: number; ids?: string[]; errors?: { message?: string }[] }>;
  ingestFile: (
    file: File,
    opts?: { collection?: string; database?: string; upsert?: boolean },
  ) => Promise<{ success: number; failed: number; errors?: { message?: string }[] }>;
  /**
   * Delete context items.
   *
   * `opts` scopes the delete. Without it the globally-selected scope applies,
   * which deleted from the wrong collection whenever the item on screen came
   * from a different one than the scope picker pointed at. Callers that
   * know the item's own collection must pass it.
   */
  deleteByIds: (
    ids: string[],
    kind?: "memory" | "knowledge",
    opts?: { collection?: string; database?: string },
  ) => Promise<{ success: boolean; message: string; deleted_count: number }>;
  ingestionStatus: (
    ids: string[],
  ) => Promise<{ items?: IngestionItem[]; statuses?: Record<string, unknown> }>;
  relations: (opts?: {
    id?: string;
    kind?: "memory" | "knowledge";
    limit?: number;
    cursor?: number;
    collection?: string;
    database?: string;
  }) => Promise<{ relations?: unknown[]; triplets?: unknown[]; total?: number }>;
  connectors: () => Promise<{ connectors: ConnectorInfo[]; count: number }>;
  /**
   * Report retrieval quality for a past query. Fire-and-forget: it never
   * changes a result, so it must never surface an error to the user.
   */
  submitFeedback: (opts: {
    requestId: string;
    rating?: "positive" | "negative" | "neutral";
    feedback?: string;
    collection?: string;
  }) => Promise<void>;
}

/** Use inside a component; throws if no API key configured. */
export function useHydra(): HydraClient {
  const { config, hasKey } = useAppConfig();
  // `collections` is read inside the memo but compared by reference — a
  // toggle that replaces the array with an equal one would rebuild the client
  // every render. Serialize it so identity only changes when content does.
  const configCollections = config.collections;
  const collectionsKey = JSON.stringify(configCollections ?? []);
  const { apiKey, baseUrl, database, collection, llmApiKey, llmModel, instructions } = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    database: config.database,
    collection: config.collection,
    llmApiKey: config.llm?.apiKey,
    llmModel: config.llm?.model,
    instructions: config.instructions,
  };
  if (!hasKey) {
    throw new HydraApiError("No Hydra API key configured yet.", 401);
  }

  return useMemo<HydraClient>(() => {
    // Snapshot the config fields this client reads so the memo body never
    // touches the outer `config` object (keeps the dep list honest/simple).
    const cfg = { apiKey, baseUrl, database, collection, collections: configCollections };
    // Legacy BYOK mode sends the key in the header; the preferred server-side
    // session mode relies on the encrypted httpOnly cookie (sent automatically
    // same-origin) — no key material ever touches the browser.
    const headers: Record<string, string> = {};
    if (cfg.apiKey?.trim()) {
      headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
    }
    if (cfg.baseUrl) headers["x-hydra-base-url"] = cfg.baseUrl;

    /** Scope for list/inspect/relations/delete calls — defaults to the
     *  configured database/collection when the caller doesn't override. */
    const scope = (
      opts?: { collection?: string; database?: string },
    ): { database?: string; collection?: string } => {
      const out: { database?: string; collection?: string } = {};
      const db = opts?.database ?? cfg.database;
      const col = opts?.collection ?? cfg.collection;
      if (db) out.database = db;
      if (col) out.collection = col;
      return out;
    };

    /** Stringified scope for query params. */
    const scopeRecord = (
      s: { database?: string; collection?: string },
    ): Record<string, string> => {
      const out: Record<string, string> = {};
      if (s.database) out.database = s.database;
      if (s.collection) out.collection = s.collection;
      return out;
    };

    const get = async <T = unknown>(
      path: string,
      query?: Record<string, string>,
    ): Promise<T> => parseBody<T>(await request(path, { query }, headers));

    const post = async <T = unknown>(path: string, body?: unknown): Promise<T> =>
      parseBody<T>(
        await request(
          path,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          },
          headers,
        ),
      );

    const del = async <T = unknown>(path: string): Promise<T> =>
      parseBody<T>(await request(path, { method: "DELETE" }, headers));

    const uploadForm = async <T = unknown>(
      path: string,
      form: FormData,
    ): Promise<T> => parseBody<T>(await request(path, { method: "POST", body: form }, headers));

    return {
      config,
      headers,

      raw: (path, init = {}) => request(path, init, headers),
      get,
      post,
      del,
      uploadForm,

      search: (query, opts = {}) => {
        const body: Record<string, unknown> = {
          query,
          maxResults: opts.maxResults ?? 10,
        };
        const db = opts.database ?? cfg.database;
        if (db) body.database = db;
        // Scope precedence (same rule as qa.ts + every view): an explicit
        // single collection shadows the multi-select; otherwise an explicit
        // multi (or the stored multi) wins; otherwise the stored single.
        // An explicitly empty `collections: []` means "all" — fall through
        // instead of sending an empty selector the backend rejects.
        const multi =
          opts.collection
            ? undefined
            : opts.collections && opts.collections.length > 0
              ? opts.collections
              : cfg.collections && cfg.collections.length > 0
                ? cfg.collections
                : undefined;
        const single = opts.collection ?? (!multi ? cfg.collection : undefined);
        if (single) body.collection = single;
        else if (multi) body.collections = multi;
        if (opts.kind) body.type = opts.kind;
        if (opts.mode) body.mode = opts.mode;
        if (opts.graphContext) body.graphContext = true;
        if (opts.metadataFilters) body.metadataFilters = opts.metadataFilters;
        return post<SearchResponse>("/query", body);
      },

      listDatabases: async () => {
        const res = await get<{
          tenants?: unknown;
          tenantIds?: unknown;
          databases?: unknown;
          data?: unknown;
          count?: number;
        }>("/databases");
        const root = (res as { data?: unknown }).data && typeof (res as { data?: unknown }).data === "object"
          ? (res as { data: Record<string, unknown> }).data
          : (res as Record<string, unknown>);
        const list =
          (Array.isArray(root.tenants) ? root.tenants : null) ??
          (Array.isArray(root.tenantIds) ? root.tenantIds : null) ??
          (Array.isArray(root.databases) ? root.databases : null) ??
          [];
        const tenants = (list as unknown[])
          .map((x): DatabaseInfo | null =>
            typeof x === "string"
              ? { tenant_id: x }
              : x && typeof x === "object"
                ? {
                    tenant_id: String(
                      (x as Record<string, unknown>).tenant_id ??
                        (x as Record<string, unknown>).tenantId ??
                        (x as Record<string, unknown>).name ??
                        "",
                    ),
                    organisation: (x as Record<string, unknown>).organisation as string | undefined,
                    status: (x as Record<string, unknown>).status as string | undefined,
                  }
                : null,
          )
          .filter((x): x is DatabaseInfo => x !== null && Boolean(x.tenant_id));
        return { tenants, count: tenants.length };
      },

      createDatabase: (database) =>
        post<{ status: string; tenant_id: string; message: string }>("/databases", {
          database,
        }),

      listCollections: async (database) => {
        const res = await get<{
          sub_tenant_ids?: string[];
          subTenantIds?: string[];
          collections?: string[];
          data?: unknown;
          count?: number;
        }>(`/databases/collections?database=${encodeURIComponent(database)}`);
        const inner =
          res.data && typeof res.data === "object"
            ? (res.data as Record<string, unknown>)
            : (res as Record<string, unknown>);
        const list = (
          (Array.isArray(inner.sub_tenant_ids) ? inner.sub_tenant_ids : null) ??
          (Array.isArray(inner.subTenantIds) ? (inner.subTenantIds as string[]) : null) ??
          (Array.isArray(inner.collections) ? inner.collections : null) ??
          []
        ).filter((s): s is string => typeof s === "string");
        return { sub_tenant_ids: list, count: list.length };
      },

      listMemories: (opts = {}) =>
        post<{
          sources?: HydraMemory[];
          user_memories?: HydraMemory[];
          count?: number;
          total?: number;
          data?: HydraMemory[];
        }>("/context/list", {
          type: "memory",
          page: opts.page ?? 1,
          pageSize: opts.pageSize ?? 50,
          ...scope(opts),
        }),

      listKnowledge: (opts = {}) =>
        post<{
          sources?: HydraSource[];
          count?: number;
          total?: number;
          data?: HydraSource[];
        }>("/context/list", {
          type: "knowledge",
          page: opts.page ?? 1,
          pageSize: opts.pageSize ?? 50,
          ...scope(opts),
        }),

      inspect: (id, opts = {}) => {
        const query: Record<string, string> = { id, ...scopeRecord(scope(opts)) };
        if (opts.mode) query.mode = opts.mode;
        return get<HydraSource>("/context/inspect", query);
      },

      ingestMemory: (item) => {
        const form = new FormData();
        form.append("type", "memory");
        const memory: Record<string, unknown> = {
          infer: item.infer ?? true,
          is_markdown: item.isMarkdown ?? false,
        };
        if (item.text) memory.text = item.text;
        if (item.pairs) memory.user_assistant_pairs = item.pairs;
        if (item.title) memory.title = item.title;
        if (item.infer && item.customInstructions) {
          memory.custom_instructions = item.customInstructions;
        }
        if (item.metadata) memory.metadata = item.metadata;
        form.append("memories", JSON.stringify([memory]));
        if (item.upsert != null) form.append("upsert", String(item.upsert));
        const s = scope(item);
        if (s.collection) form.append("collection", s.collection);
        if (s.database) form.append("database", s.database);
        return uploadForm<{
          success: number;
          failed: number;
          ids?: string[];
          errors?: { message?: string }[];
        }>("/context/ingest", form);
      },

      ingestFile: (file, opts = {}) => {
        const form = new FormData();
        form.append("type", "knowledge");
        form.append("documents", file);
        form.append("filename", file.name);
        if (opts.upsert != null) form.append("upsert", String(opts.upsert));
        const s = scope(opts);
        if (s.collection) form.append("collection", s.collection);
        if (s.database) form.append("database", s.database);
        return uploadForm<{ success: number; failed: number; errors?: { message?: string }[] }>(
          "/context/ingest",
          form,
        );
      },

      deleteByIds: (ids, kind = "memory", opts) =>
        post<{ success: boolean; message: string; deleted_count: number }>("/context", {
          ids,
          type: kind,
          ...scope(opts),
        }),

      ingestionStatus: (ids) =>
        post<{ items?: IngestionItem[]; statuses?: Record<string, unknown> }>(
          "/context/status",
          { ids, ...scope() },
        ),

      relations: (opts = {}) => {
        const query: Record<string, string> = {};
        const s = scope(opts);
        if (s.database) query.database = s.database;
        if (s.collection) query.collection = s.collection;
        if (opts.limit != null) query.limit = String(opts.limit);
        if (opts.id) query.id = opts.id;
        if (opts.kind) query.type = opts.kind;
        if (opts.cursor != null) query.cursor = String(opts.cursor);
        return get<{ relations?: RelationGroup[]; triplets?: RelationGroup[]; total?: number }>(
          "/context/relations",
          query,
        );
      },

      connectors: () =>
        get<{ connectors: ConnectorInfo[]; count: number }>("/connectors"),

      submitFeedback: async (opts) => {
        const s = scope({ collection: opts.collection });
        await post<{ ok: boolean }>("/feedback", {
          requestId: opts.requestId,
          rating: opts.rating,
          feedback: opts.feedback,
          ...(s.database ? { database: s.database } : {}),
          ...(s.collection ? { collection: s.collection } : {}),
        });
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, database, collection, collectionsKey, llmApiKey, llmModel, instructions]);
}