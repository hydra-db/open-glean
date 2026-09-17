/**
 * Thin wrapper around the generated `@hydradb/sdk` — the single place the
 * server touches the SDK.
 *
 * Ported from the same pattern as the HydraDB MCP server:
 *   - owns the SDK at an exact pin,
 *   - injects scope (database / collection),
 *   - unwraps the HandlerEnvelope by shape,
 *   - translates SDK errors into a stable host error.
 *
 * This module is server-only: it runs inside Next.js route handlers, never in
 * the browser bundle.
 */
import "server-only";
import { HydraDBClient } from "@hydradb/sdk";
import type { HydraDB as SDK } from "@hydradb/sdk";
import { unwrap } from "./envelope";
import { responseError, translateError } from "./errors";
import { pinPath } from "./pinPath";

export const DEFAULT_TIMEOUT_SECONDS = 15;
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_BASE_URL = "https://api.hydradb.com";

export type ContextKind = "memory" | "knowledge";
export type QueryKind = ContextKind | "all";

export interface HydraConfig {
  /** Bearer token (the HydraDB API key). */
  token: string;
  /** Database scope (canonical name for the tenant). */
  database?: string;
  /** Collection scope (canonical name for the sub-tenant). */
  collection?: string;
  /** Optional base URL override; defaults to the SDK's production environment. */
  baseUrl?: string;
  timeoutSeconds?: number;
  maxRetries?: number;
}

const STDERR_LOGGER = {
  debug: (message: string, ...args: unknown[]) =>
    console.error("[hydradb-sdk]", message, ...args),
  info: (message: string, ...args: unknown[]) =>
    console.error("[hydradb-sdk]", message, ...args),
  warn: (message: string, ...args: unknown[]) =>
    console.error("[hydradb-sdk]", message, ...args),
  error: (message: string, ...args: unknown[]) =>
    console.error("[hydradb-sdk]", message, ...args),
};

export interface QueryParams {
  query: string;
  kind?: QueryKind;
  operator?: "or" | "and" | "phrase";
  queryBy?: "hybrid" | "text";
  maxResults?: number;
  mode?: "fast" | "thinking" | "auto";
  graphContext?: boolean;
  alpha?: number;
  recencyBias?: number;
  ids?: string[];
  metadataFilters?: Record<string, unknown>;
  numRelatedChunks?: number;
  collection?: string;
  /**
   * Multi-collection scope: a list for equal weighting, or a map of collection
   * -> positive weight. Mutually exclusive with `collection` upstream, and it
   * wins when both are supplied.
   */
  collections?: string[] | Record<string, number>;
  database?: string;
  /** Adds an app-aware retrieval lane for connector-synced sources. */
  queryApps?: boolean;
  /** Pull author-declared related sources into `additional_context`. */
  queryForcefulRelations?: boolean;
  /** Request-time retrieval hint, e.g. surrounding session state. */
  additionalContext?: string;
}

export interface ConversationTurn {
  user: string;
  assistant: string;
}

export interface IngestParams {
  kind: ContextKind;
  text?: string;
  pairs?: ConversationTurn[];
  title?: string;
  sourceId?: string;
  userName?: string;
  infer?: boolean;
  isMarkdown?: boolean;
  customInstructions?: string;
  upsert?: boolean;
  metadata?: Record<string, unknown>;
  additionalMetadata?: Record<string, unknown>;
  observationDate?: string;
  filename?: string;
  collection?: string;
  database?: string;
}

export interface ListParams {
  kind?: ContextKind;
  /** Bucket to list: "knowledge" | "memory" (the proxy sends this). */
  type?: "knowledge" | "memory";
  ids?: string[];
  page?: number;
  pageSize?: number;
  collection?: string;
  database?: string;
}

export interface InspectParams {
  id: string;
  mode?: string;
  expirySeconds?: number;
  collection?: string;
  database?: string;
}

export interface IngestionStatusParams {
  ids: string | string[];
  collection?: string;
  database?: string;
}

export interface RelationsParams {
  id?: string;
  kind?: ContextKind;
  limit?: number;
  cursor?: number;
  collection?: string;
  database?: string;
}

export interface DeleteParams {
  ids: string[];
  kind: ContextKind;
  collection?: string;
  database?: string;
}

export interface FeedbackParams {
  /** Taken verbatim from the query's `meta.request_id` — never invented. */
  requestId: string;
  /** What was wrong, specifically. Required unless `groundTruth` is given. */
  feedback?: string;
  rating?: "positive" | "negative" | "neutral";
  /** "agent" separates automated reports from human ones. */
  source?: "user" | "agent";
  groundTruth?: { answer?: string; sourceIds?: string[] };
  metadata?: Record<string, string>;
  collection?: string;
  database?: string;
}

function req(opts?: { signal?: AbortSignal }): { abortSignal?: AbortSignal } | undefined {
  return opts?.signal ? { abortSignal: opts.signal } : undefined;
}

export class HydraDB {
  readonly sdk: HydraDBClient;
  readonly database?: string;
  readonly collection?: string;
  readonly baseUrl: string;
  /** Bearer token (API key) — also used by any raw fetch fallback. */
  readonly token: string;

  constructor(config: HydraConfig) {
    this.baseUrl = config.baseUrl?.replace(/\/+$/, "") ?? DEFAULT_BASE_URL;
    this.token = config.token;
    const client = new HydraDBClient({
      token: config.token,
      baseUrl: this.baseUrl,
      timeoutInSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      logging: { logger: STDERR_LOGGER },
    });
    this.sdk = client;
    this.database = config.database;
    this.collection = config.collection;
  }

  private scope(collection?: string, database?: string) {
    const db = database?.trim() || this.database;
    const col = collection?.trim() || this.collection;
    const scope: Record<string, string> = {};
    if (db) scope.database = db;
    if (col) scope.collection = col;
    return scope;
  }

  /**
   * Scope for endpoints that require a database on the wire (ingest,
   * inspect, status, relations). Throws a clear error when the user has not
   * configured a database yet.
   */
  private requiredScope(collection?: string, database?: string) {
    const scope = this.scope(collection, database);
    if (!scope.database) {
      throw new Error(
        "No database configured. Pick a Hydra database in Settings first.",
      );
    }
    return scope as { database: string; collection?: string };
  }

  private async call<T>(path: string, fn: () => Promise<unknown>): Promise<T> {
    try {
      return unwrap<T>(await fn());
    } catch (err) {
      throw translateError(path, err);
    }
  }

  // ── Retrieval ────────────────────────────────────────────────
  query(
    params: QueryParams,
    opts?: { signal?: AbortSignal },
  ): Promise<SDK.SearchV2RetrievalResult> {
    const queryBy = params.queryBy ?? (params.operator != null ? "text" : undefined);
    // `collection` and `collections` are mutually exclusive upstream (400 if
    // both are sent), so drop the single-collection scope when a multi-scope
    // selector is present.
    const multi =
      Array.isArray(params.collections) && params.collections.length > 0
        ? params.collections
        : params.collections && !Array.isArray(params.collections) &&
            Object.keys(params.collections).length > 0
          ? params.collections
          : undefined;
    const scope = this.scope(params.collection, params.database);
    if (multi) delete scope.collection;
    return this.call("/query", () =>
      this.sdk.query(
        {
          ...scope,
          ...(multi ? { collections: multi } : {}),
          query: params.query,
          type: params.kind,
          queryApps: params.queryApps,
          queryForcefulRelations: params.queryForcefulRelations,
          additionalContext: params.additionalContext,
          operator: params.operator,
          queryBy,
          maxResults: params.maxResults,
          mode: params.mode,
          graphContext: params.graphContext,
          alpha: params.alpha,
          recencyBias: params.recencyBias,
          ids: params.ids,
          metadataFilters: params.metadataFilters,
          numRelatedChunks: params.numRelatedChunks,
        },
        req(opts),
      ),
    );
  }

  // ── Ingest ───────────────────────────────────────────────────
  ingest(
    params: IngestParams,
    opts?: { signal?: AbortSignal },
  ): Promise<SDK.IngestionV2SourceUploadResponse> {
    const request: SDK.IngestContextRequest = {
      ...this.requiredScope(params.collection, params.database),
      type: params.kind,
    };
    if (params.upsert != null) request.upsert = String(params.upsert);

    if (params.kind === "memory") {
      const infer = params.infer ?? true;
      const item: Record<string, unknown> = {};
      if (params.pairs != null) item.user_assistant_pairs = params.pairs;
      if (params.text != null) item.text = params.text;
      item.infer = infer;
      item.is_markdown = params.isMarkdown ?? false;
      if (infer && params.customInstructions != null) {
        item.custom_instructions = params.customInstructions;
      }
      if (params.sourceId != null) item.source_id = params.sourceId;
      if (params.title != null) item.title = params.title;
      if (params.userName != null) item.user_name = params.userName;
      if (params.metadata != null) item.metadata = params.metadata;
      if (params.additionalMetadata != null) {
        item.additional_metadata = params.additionalMetadata;
      }
      if (params.observationDate != null) {
        item.observation_date = params.observationDate;
      }
      request.memories = JSON.stringify([item]);
    } else {
      if (params.text != null) {
        request.documents = {
          data: Buffer.from(params.text, "utf-8"),
          filename: params.filename ?? `${params.title ?? "document"}.md`,
          contentType: "text/markdown",
        };
      }
    }

    return this.call("/context/ingest", () =>
      this.sdk.context.ingest(request, req(opts)),
    );
  }

  /** Ingest a raw file (knowledge) via multipart. */
  ingestFile(
    file: File | Buffer,
    filename: string,
    contentType: string,
    params: { collection?: string; database?: string; upsert?: boolean } = {},
    opts?: { signal?: AbortSignal },
  ): Promise<SDK.IngestionV2SourceUploadResponse> {
    const request: SDK.IngestContextRequest = {
      ...this.requiredScope(params.collection, params.database),
      type: "knowledge",
    };
    if (params.upsert != null) request.upsert = String(params.upsert);
    request.documents = {
      data: file as never,
      filename,
      contentType,
    };
    return this.call("/context/ingest", () =>
      this.sdk.context.ingest(request, req(opts)),
    );
  }

  /**
   * Ingest one or more raw memory items from an already-shaped JSON array
   * (the proxy path for browser multipart/JSON memory ingestion).
   */
  async ingestItems(
    items: Record<string, unknown>[],
    params: { collection?: string; database?: string; upsert?: boolean } = {},
    opts?: { signal?: AbortSignal },
  ): Promise<SDK.IngestionV2SourceUploadResponse> {
    const request: SDK.IngestContextRequest = {
      ...this.requiredScope(params.collection, params.database),
      type: "memory",
      memories: JSON.stringify(items),
    };
    if (params.upsert != null) request.upsert = String(params.upsert);
    return this.call("/context/ingest", () =>
      this.sdk.context.ingest(request, req(opts)),
    );
  }

  // ── List / inspect / status / relations / delete ────────────
  list(
    params: ListParams = {},
    opts?: { signal?: AbortSignal },
  ): Promise<SDK.ListV2SourceListResponse> {
    return this.call("/context/list", () =>
      this.sdk.context.list(
        {
          ...this.scope(params.collection, params.database),
          type: params.type ?? params.kind,
          ids: params.ids,
          page: params.page,
          pageSize: params.pageSize,
        },
        req(opts),
      ),
    );
  }

  inspect(
    params: InspectParams,
    opts?: { signal?: AbortSignal },
  ): Promise<SDK.FetchV2SourceFetchResponse> {
    return this.call("/context/inspect", () =>
      this.sdk.context.inspect(
        {
          ...this.requiredScope(params.collection, params.database),
          id: params.id,
          mode: params.mode,
          expirySeconds: params.expirySeconds,
        },
        req(opts),
      ),
    );
  }

  ingestionStatus(
    params: IngestionStatusParams,
    opts?: { signal?: AbortSignal },
  ): Promise<SDK.IngestionV2BatchProcessingStatus> {
    return this.call("/context/status", () =>
      this.sdk.context.status(
        {
          ...this.requiredScope(params.collection, params.database),
          ids: params.ids,
        },
        req(opts),
      ),
    );
  }

  relations(
    params: RelationsParams = {},
    opts?: { signal?: AbortSignal },
  ): Promise<SDK.GraphGraphRelationsResponse> {
    return this.call("/context/relations", () =>
      this.sdk.context.relations(
        {
          ...this.requiredScope(params.collection, params.database),
          id: params.id,
          type: params.kind,
          limit: params.limit,
          cursor: params.cursor,
        },
        req(opts),
      ),
    );
  }

  delete(
    params: DeleteParams,
    opts?: { signal?: AbortSignal },
  ): Promise<SDK.SourcesMemoryDeleteResponse> {
    return this.call("/context", () =>
      this.sdk.context.delete(
        {
          ...this.scope(params.collection, params.database),
          ids: params.ids,
          type: params.kind,
        },
        req(opts),
      ),
    );
  }

  // ── Feedback ────────────────────────────────────────────────
  /**
   * Report retrieval quality for a past query (`POST /feedback`).
   *
   * The SDK has no feedback client as of 2.1.2, so this goes over the raw
   * passthrough. Fire-and-forget by contract: feedback never changes a
   * result, so a failure here must never surface to the user — callers are
   * expected to swallow the rejection.
   */
  async submitFeedback(params: FeedbackParams): Promise<void> {
    const body: Record<string, unknown> = {
      request_id: params.requestId,
      source: params.source ?? "user",
    };
    if (params.feedback?.trim()) body.feedback = params.feedback.trim();
    if (params.rating) body.rating = params.rating;
    if (params.metadata) body.metadata = params.metadata;
    const scope = this.scope(params.collection, params.database);
    // `collection` is only valid alongside a `database` (400 otherwise).
    if (scope.database) {
      body.database = scope.database;
      if (scope.collection) body.collection = scope.collection;
    }
    if (params.groundTruth) {
      const gt: Record<string, unknown> = {};
      if (params.groundTruth.answer?.trim()) gt.answer = params.groundTruth.answer.trim();
      if (params.groundTruth.sourceIds?.length) gt.source_ids = params.groundTruth.sourceIds;
      if (Object.keys(gt).length > 0) body.ground_truth = gt;
    }
    const res = await this.passthrough("/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw responseError(res.status, detail);
    }
  }

  // ── Databases ───────────────────────────────────────────────
  listDatabases(): Promise<SDK.TenantsTenantIdsResponse> {
    return this.call("/databases", () => this.sdk.databases.list());
  }

  createDatabase(
    database: string,
    embeddingsDimension?: number,
  ): Promise<SDK.TenantsTenantCreateAcceptedResponse> {
    return this.call("/databases", () =>
      this.sdk.databases.create({
        database,
        ...(embeddingsDimension != null ? { embeddingsDimension } : {}),
      }),
    );
  }

  deleteDatabase(database: string): Promise<SDK.TenantsTenantDeleteResponse> {
    return this.call("/databases", () => this.sdk.databases.delete({ database }));
  }

  collections(database: string): Promise<SDK.TenantsSubTenantIdsResponse> {
    return this.call("/databases/collections", () =>
      this.sdk.databases.collections({ database }),
    );
  }

  stats(database: string): Promise<SDK.TenantsTenantStatsResponse> {
    return this.call("/databases/stats", () =>
      this.sdk.databases.stats({ database }),
    );
  }

  readiness(database: string): Promise<SDK.TenantsInfraStatusResponseV2> {
    return this.call("/databases/status", () =>
      this.sdk.databases.status({ database }),
    );
  }

  // ── Connectors ──────────────────────────────────────────────
  listConnectors(): Promise<Record<string, unknown>> {
    return this.call("/connectors", () => this.sdk.connectors.list());
  }

  /** Hydra connector catalog (all supported providers). */
  listProviders(id?: string): Promise<Record<string, unknown>> {
    return this.call("/connector-catalog", () =>
      this.sdk.listProviders(id ? { id } : {}),
    );
  }

  /** Raw connector-catalog credential schema for a provider. */
  async credentialSchema(provider: string): Promise<Record<string, unknown>> {
    const res = await this.listProviders(provider);
    const data = (res as { connectors?: unknown }).connectors ?? res;
    if (Array.isArray(data)) {
      const match = data.find(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          ((c as { provider?: string }).provider ?? (c as { id?: string }).id) === provider,
      );
      if (match) return (match as { credential_schema?: Record<string, unknown> }).credential_schema ?? {};
    }
    const schema = (res as { credential_schema?: Record<string, unknown> }).credential_schema;
    return schema ?? {};
  }

  /**
   * Passthrough for endpoints not wrapped above (connector resources,
   * catalog, connector-discovery, …) using the SDK's configured auth.
   *
   * Resolves `path` against the configured base URL as an absolute URL so the
   * SDK's `fetch` never sees a bare relative path (which it cannot parse).
   */
  async passthrough(
    path: string,
    init?: RequestInit & { query?: Record<string, string> },
  ): Promise<Response> {
    try {
      // Pin to the base origin, so a `//host` path can never redirect the
      // credentialed request to another server.
      const url = pinPath(this.baseUrl, path);
      if (!url) {
        throw new Error("Path resolved outside the Hydra base URL.");
      }
      if (init?.query) {
        for (const [k, v] of Object.entries(init.query)) {
          url.searchParams.set(k, v);
        }
      }
      return await this.sdk.fetch(url.toString(), {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
    } catch (err) {
      throw translateError(path, err);
    }
  }
}