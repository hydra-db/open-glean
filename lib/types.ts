/** Shared browser-side types for Open Glean. */

export type ThemeMode = "dark" | "light" | "system";

export interface LlmConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl?: string;
  /** Legacy BYOK mode: key stored client-side. Prefer the server-side
   *  session (llmConfigured) — apiKey remains for backward compat. */
  apiKey?: string;
  /** Model id, e.g. gpt-4o-mini, deepseek-chat, claude via gateway… */
  model: string;
}

export interface AppConfig {
  /** Legacy BYOK mode: key stored client-side. Prefer the server-side
   *  session (keyConfigured) — this remains only for backward compat. */
  apiKey?: string;
  /** True when the Hydra key lives in the encrypted server-side session. */
  keyConfigured?: boolean;
  /** Masked display form of the session key (e.g. sk_live_…•…AbzQ). */
  keyMask?: string;
  /**
   * True when the key comes from the deployment's HYDRA_API_KEY, not from this
   * session. No mask is available for it (masking a shared secret leaks it),
   * and Disconnect cannot clear it — the UI must say so rather than imply the
   * user owns a key they cannot remove.
   */
  keyFromEnv?: boolean;
  /** True when the LLM key lives in the encrypted server-side session. */
  llmConfigured?: boolean;
  /** Optional backend override (defaults to api.hydradb.com). */
  baseUrl?: string;
  /** Default database (tenant) scope. */
  database?: string;
  /** Default collection (sub-tenant) scope. */
  collection?: string;
  /** Multi-selected collection scope (Ask-AI style). When set, retrieval
   *  queries exactly these collections. */
  collections?: string[];
  /** LLM used to write answers. */
  llm?: LlmConfig;
  /** "Personalise" instructions injected into the system prompt. */
  instructions?: string;
  theme: ThemeMode;
}

export const DEFAULT_CONFIG: AppConfig = { theme: "dark" };

// ── Hydra API response shapes (subset used by the UI) ───────────

export interface HydraSource {
  id?: string;
  source_id?: string;
  title?: string;
  type?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  content_preview?: string;
  app_provider?: string;
  app_kind?: string;
  app_external_id?: string;
  app_parent_id?: string;
  app_thread_id?: string;
  chunk_content?: string;
  [key: string]: unknown;
}

export interface HydraMemory {
  id?: string;
  memory_id?: string;
  memory_content?: string;
  content?: string;
  text?: string;
  type?: string;
  inferred?: boolean;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** A single retrieved chunk from the Hydra /query endpoint. Real backend
 *  field names are chunk_uuid / chunk_content / relevancy_score; the legacy
 *  spellings (chunk_id / content / score) are kept for tolerant parsing. */
export interface SearchChunk {
  chunk_uuid?: string;
  chunk_id?: string;
  chunk_content?: string;
  content?: string;
  text?: string;
  score?: number;
  relevancy_score?: number;
  source_title?: string;
  source_id?: string;
  /** Connector provider (e.g. "jira", "slack") from the chunk metadata. */
  app_provider?: string;
  source_url?: string;
  source_type?: string;
  source_upload_time?: string;
  /**
   * Collection the chunk was retrieved from. Required to inspect the source
   * later: /context/inspect is scope-checked, so a multi-collection query has
   * to remember which collection each hit actually came from.
   */
  collection?: string;
  highlights?: string[];
  [key: string]: unknown;
}

/** Citation returned by the OpenRouter web-search plugin. */
export interface WebCitation {
  url: string;
  title?: string;
}

export interface SearchResult {
  source?: HydraSource;
  chunks?: SearchChunk[];
  score?: number;
  [key: string]: unknown;
}

export interface SearchResponse {
  query?: string;
  results?: SearchResult[];
  sources?: SearchResult[];
  total?: number;
  [key: string]: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * `stopped` is terminal like `done`/`error` but distinct: the user cancelled
   * mid-run, so the content is partial and must not be presented as a complete
   * answer or offered the completed-answer actions.
   */
  status?: "streaming" | "done" | "error" | "stopped";
  /** Normalized Hydra chunks retrieved for this answer. */
  sources?: SearchChunk[];
  /** Web-search citations (OpenRouter web plugin) for this answer. */
  webCitations?: WebCitation[];
  /**
   * `meta.request_id` of the Hydra retrieval behind this answer. POST
   * /feedback only accepts an id taken verbatim from its own query, so it is
   * stored per-message rather than recomputed.
   */
  requestId?: string;
  /** Retrieval rating the user gave this answer, once submitted. */
  feedback?: "positive" | "negative";
  /**
   * Deep Research run behind this answer (plan, per-node findings, stats).
   * Persisted so reopening a conversation replays the timeline rather than
   * losing how the answer was reached.
   */
  research?: import("@/lib/research/types").ResearchRunState;
  error?: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ConnectorInfo {
  connector_id: string;
  provider: string;
  provider_account_scope?: string;
  status?: string;
  sync_status?: string;
  lifecycle?: string;
  next_sync_at?: string;
  last_successful_sync_at?: string;
  last_attempted_sync_at?: string;
  documents_dispatched?: number;
  active_resource_count?: number;
  sync_cycles_completed?: number;
  sync_interval_seconds?: number;
  last_error?: string;
  needs_reauth?: boolean;
  [key: string]: unknown;
}

export interface ConnectorCatalogEntry {
  value?: string;
  provider?: string;
  label?: string;
  name?: string;
  logo?: string;
  availability?: string;
  maturity?: string;
  category?: string;
  sync_engine?: string;
  description?: string;
  [key: string]: unknown;
}

export interface DatabaseInfo {
  tenant_id: string;
  organisation?: string;
  timestamp?: string;
  status?: string;
  [key: string]: unknown;
}

export interface IngestionItem {
  id?: string;
  source_id?: string;
  title?: string;
  status?: string;
  error?: string;
  [key: string]: unknown;
}

export interface Relation {
  source_id?: string;
  target_id?: string;
  relation?: string;
  score?: number;
  source_title?: string;
  target_title?: string;
  [key: string]: unknown;
}

// ── Graph / relations (real /context/relations shape) ──────────

/** An entity node in the knowledge graph. */
export interface GraphEntity {
  name?: string;
  type?: string;
  namespace?: string;
  entity_id?: string;
  [key: string]: unknown;
}

/** One predicate inside a relation group (source → target). */
export interface RelationTriplet {
  canonical_predicate?: string;
  raw_predicate?: string;
  context?: string;
  confidence?: number;
  timestamp?: string;
  [key: string]: unknown;
}

/** A relation group: source + target entities and their predicates. */
export interface RelationGroup {
  source?: GraphEntity;
  target?: GraphEntity;
  relations?: RelationTriplet[];
  chunk_id?: string;
  [key: string]: unknown;
}

/** Pagination metadata returned by list endpoints. */
export interface ListResponseMeta {
  total?: number;
  count?: number;
  page?: number;
  page_size?: number;
  has_more?: boolean;
}