"use client";

/**
 * /context — everything your workspace knows: memories + knowledge.
 *
 * Two lists, persisted in the URL (?tab=memory|knowledge):
 *   • Memories   — notes added via text/webpage ingest (inference on)
 *   • Knowledge  — files & connector sources (documents)
 *
 * Search: when the box has text, hit the backend `search()` (debounced) and
 * render normalized chunk results with a score bar.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { HydraApiError, useHydra } from "@/lib/api";
import { useToast } from "@/lib/toast";
import {
  ConfirmDialog,
  EmptyState,
  Modal,
  PageHeader,
  ProviderLogo,
  Skeleton,
} from "@/components/ui";
import { Icon, Spinner } from "@/components/Icon";
import { MemoryUpload, lastUploadTab, type MemoryUploadTab } from "@/components/MemoryUpload";
import { cn, copyText, formatDateTime, timeAgo, truncate } from "@/lib/utils";
import { readableBody } from "@/lib/readableBody";
import { normalizeSearchResponse } from "@/lib/qa";
import type {
  HydraMemory,
  HydraSource,
  SearchResponse,
} from "@/lib/types";

type Tab = "memory" | "knowledge";

const PAGE_SIZE = 24;
const SEARCH_LIMIT = 20;

// ── Normalisation helpers (backend nests things defensively) ──────

type Rec = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Type chip label — lowercase by default, raw when the type is odd. */
function typeLabel(t: string): string {
  const raw = (t ?? "").trim();
  if (!raw) return "memory";
  const lower = raw.toLowerCase();
  return /^[a-z0-9_ .-]+$/.test(lower) ? lower : raw;
}

function hostname(u?: string): string {
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

function asArr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * The list endpoints respond with an envelope — { success, message, data } —
 * where `data` is either an object ({ user_memories } / { sources }) or, on
 * older servers, a bare array. Normalize every known nesting.
 */
function unwrapMemories(body: unknown): HydraMemory[] {
  const rec = (body ?? {}) as Rec;
  const data = rec.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Rec;
    const inner = asArr<HydraMemory>(d.user_memories ?? d.sources ?? d.items);
    if (inner.length) return inner;
  }
  return asArr<HydraMemory>(
    rec.user_memories ?? rec.sources ?? rec.memories ?? rec.data ?? rec.items ?? rec.results,
  );
}

function unwrapKnowledge(body: unknown): HydraSource[] {
  const rec = (body ?? {}) as Rec;
  const data = rec.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Rec;
    const inner = asArr<HydraSource>(d.sources ?? d.user_memories ?? d.items);
    if (inner.length) return inner;
  }
  return asArr<HydraSource>(
    rec.sources ?? rec.data ?? rec.items ?? rec.results ?? rec.user_memories,
  );
}

interface MemoryCard {
  id: string;
  text: string;
  type: string;
  inferred: boolean;
  created?: string;
  raw: HydraMemory;
}

interface KnowledgeCard {
  id: string;
  title: string;
  type: string;
  url?: string;
  timestamp?: string;
  preview: string;
  provider?: string;
  /**
   * The collection this item actually came from.
   *
   * Inspect and delete must use this rather than the globally-selected scope,
   * or a multi-collection view inspects a 404 and deletes from the wrong
   * collection.
   */
  collection?: string;
  raw: HydraSource;
}

/** A 24+ hex-char string with no spaces is an id, not readable text. */
function looksLikeId(s: string): boolean {
  return /^[0-9a-f]{24,}$/i.test(s.trim());
}

function memoryText(m: HydraMemory): string {
  // Prefer real content. Fall back to `title` only when it is actual text, not
  // the raw memory id the list API sometimes returns there.
  const body = str(m.text ?? m.content ?? m.memory_content);
  if (body) return body;
  const title = str(m.title);
  return looksLikeId(title) ? "" : title;
}

function toMemoryCards(list: HydraMemory[] | undefined): MemoryCard[] {
  const out: MemoryCard[] = [];
  for (const m of list ?? []) {
    const id = str(m.id ?? m.memory_id ?? m.source_id);
    if (!id) continue;
    // Keep the card even when the body is empty, so a real memory does not
    // vanish. Show a short id so it is still identifiable.
    const text = memoryText(m) || `Memory ${id.slice(0, 8)}`;
    out.push({
      id,
      text,
      type: str(m.type ?? m.kind) || "memory",
      inferred: Boolean(m.inferred ?? m.infer),
      created: str(m.created_at ?? m.timestamp ?? m.updated_at) || undefined,
      raw: m,
    });
  }
  return out;
}

function toKnowledgeCards(list: HydraSource[] | undefined): KnowledgeCard[] {
  const out: KnowledgeCard[] = [];
  for (const s of list ?? []) {
    const id = str(s.id ?? s.source_id);
    if (!id) continue;
    out.push({
      id,
      title: str(s.title ?? s.filename) || "Untitled",
      type: str(s.type ?? s.kind) || "file",
      url: str(s.url) || undefined,
      timestamp: str(s.timestamp ?? s.upload_time) || undefined,
      preview: str(s.content_preview ?? s.description),
      provider: str(s.app_provider) || undefined,
      // `sub_tenant_id` is the wire's deprecated spelling of `collection`.
      collection: str(s.collection ?? s.sub_tenant_id) || undefined,
      raw: s,
    });
  }
  return out;
}

/** Inspect responses can bury the payload under `content`/`data.content`/`text`. */
function sourceText(src: unknown): string {
  const rec = (src ?? {}) as Rec;
  if (typeof rec.content === "string" && rec.content) return rec.content;
  const data = rec.data;
  if (data && typeof data === "object") {
    const d = data as Rec;
    if (typeof d.content === "string" && d.content) return d.content;
    if (typeof d.text === "string" && d.text) return d.text;
  }
  if (typeof rec.text === "string" && rec.text) return rec.text;
  if (typeof rec.chunk_content === "string" && rec.chunk_content) return rec.chunk_content;
  if (Array.isArray(rec.chunks)) {
    const parts = (rec.chunks as unknown[])
      .map((c) => str((c as Rec).chunk_content ?? (c as Rec).content ?? (c as Rec).text))
      .filter(Boolean);
    if (parts.length) return parts.join("\n\n");
  }
  return str(rec.content_preview ?? rec.description);
}

// ── Search chunk results ──────────────────────────────────────────

interface SearchHit {
  key: string;
  title: string;
  snippet: string;
  score?: number;
}

/**
 * Flatten a /query response into display hits.
 *
 * Delegates to the shared normaliser rather than re-deriving the shape here:
 * the proxy returns the raw envelope, so `data` is an OBJECT and treating it
 * as the result array silently produced zero hits for every search.
 */
function toHits(res: SearchResponse): SearchHit[] {
  const { chunks } = normalizeSearchResponse(res);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    const snippet = (c.chunk_content ?? c.content ?? c.text ?? "").trim();
    const title = c.source_title?.trim() || truncate(c.source_url ?? "", 60) || "Untitled";
    if (!snippet && !title) continue;
    const key = `${c.source_id ?? c.chunk_uuid ?? ""}\u0000${snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ key, title, snippet, score: c.relevancy_score ?? c.score });
  }
  return hits;
}

function mergeById<T extends { id: string }>(a: T[], b: T[]): T[] {
  const seen = new Set(a.map((x) => x.id));
  return [...a, ...b.filter((x) => !seen.has(x.id))];
}

// ── Page ──────────────────────────────────────────────────────────

export default function Page() {
  return (
    <Suspense fallback={null}>
      <MemoriesView />
    </Suspense>
  );
}

function MemoriesView() {
  const hydra = useHydra();
  const { push } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [tab, setTab] = useState<Tab>(
    searchParams?.get("tab") === "memory" ? "memory" : "knowledge",
  );

  // ── listing state ──
  const [items, setItems] = useState<MemoryCard[]>([]);
  const [kItems, setKItems] = useState<KnowledgeCard[]>([]);
  const [memPage, setMemPage] = useState(1);
  const [kPage, setKPage] = useState(1);
  const [memHasMore, setMemHasMore] = useState(false);
  const [kHasMore, setKHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");

  // ── search state ──
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  // undefined = no backend search run yet (render the plain list)
  const [hits, setHits] = useState<SearchHit[] | undefined>(undefined);

  // ── modal state ──
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTab, setUploadTab] = useState<MemoryUploadTab>("text");
  const [detail, setDetail] = useState<MemoryCard | null>(null);
  const [viewing, setViewing] = useState<KnowledgeCard | null>(null);
  const [viewContent, setViewContent] = useState("");
  const [viewLoading, setViewLoading] = useState(false);
  const [confirming, setConfirming] = useState<
    { kind: Tab; id: string; title: string; collection?: string } | null
  >(null);
  const [deleting, setDeleting] = useState(false);

  // keep tab state in sync with the address bar
  useEffect(() => {
    const p = searchParams?.get("tab");
    if (p === "memory" || p === "knowledge") setTab(p);
  }, [searchParams]);

  // Arriving via the top-bar "Add context" button opens the upload modal on the
  // tab the user last used. Strip the param so a reload does not reopen it.
  useEffect(() => {
    if (searchParams?.get("add") == null) return;
    setUploadTab(lastUploadTab());
    setUploadOpen(true);
    router.replace("/context");
  }, [searchParams, router]);

  const fetchList = useCallback(
    async (kind: Tab, page: number) => {
      const collection = hydra.config.collection || undefined;
      if (kind === "memory") {
        const res = await hydra.listMemories({ page, pageSize: PAGE_SIZE, collection });
        const list = toMemoryCards(unwrapMemories(res));
        return { kind: "memory" as const, list, hasMore: list.length >= PAGE_SIZE };
      }
      const res = await hydra.listKnowledge({ page, pageSize: PAGE_SIZE, collection });
      const list = toKnowledgeCards(unwrapKnowledge(res));
      return { kind: "knowledge" as const, list, hasMore: list.length >= PAGE_SIZE };
    },
    [hydra],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetchList(tab, 1);
      if (res.kind === "memory") {
        setItems(res.list);
        setMemPage(1);
        setMemHasMore(res.hasMore);
      } else {
        setKItems(res.list);
        setKPage(1);
        setKHasMore(res.hasMore);
      }
    } catch (err) {
      setLoadError(
        err instanceof HydraApiError ? err.message : "Couldn't load your vault.",
      );
    } finally {
      setLoading(false);
    }
  }, [tab, fetchList]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Refresh BOTH lists after an upload.
   *
   * `refresh` closes over the active tab, so uploading a file while viewing
   * Memories left the Knowledge list stale — the item was there, the user just
   * could not see it until they reloaded. An upload can land in either list
   * (a note becomes a memory, a file becomes knowledge), so refresh both.
   */
  const refreshAll = useCallback(async () => {
    setLoadError("");
    const [mem, kno] = await Promise.allSettled([
      fetchList("memory", 1),
      fetchList("knowledge", 1),
    ]);
    if (mem.status === "fulfilled" && mem.value.kind === "memory") {
      setItems(mem.value.list);
      setMemPage(1);
      setMemHasMore(mem.value.hasMore);
    }
    if (kno.status === "fulfilled" && kno.value.kind === "knowledge") {
      setKItems(kno.value.list);
      setKPage(1);
      setKHasMore(kno.value.hasMore);
    }
  }, [fetchList]);

  const changeTab = (t: Tab) => {
    setTab(t);
    router.replace(t === "knowledge" ? "/context?tab=knowledge" : "/context", {
      scroll: false,
    });
  };

  const openUpload = (t: MemoryUploadTab) => {
    setUploadTab(t);
    setUploadOpen(true);
  };

  const loadMore = async () => {
    const next = tab === "memory" ? memPage + 1 : kPage + 1;
    setLoadingMore(true);
    try {
      const res = await fetchList(tab, next);
      if (res.kind === "memory") {
        setItems((prev) => mergeById(prev, res.list));
        setMemPage(next);
        setMemHasMore(res.hasMore);
      } else {
        setKItems((prev) => mergeById(prev, res.list));
        setKPage(next);
        setKHasMore(res.hasMore);
      }
    } catch (err) {
      push({
        kind: "error",
        title: "Couldn't load more",
        detail: err instanceof HydraApiError ? err.message : undefined,
      });
    } finally {
      setLoadingMore(false);
    }
  };

  // ── backend search (debounced) ──
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setHits(undefined);
      setSearchFailed(false);
      setSearching(false);
      return;
    }
    setHits(undefined);
    setSearchFailed(false);
    setSearching(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        // Scope precedence (same rule as chat + mindmap): a single
        // `collection` shadows the multi-select `collections`.
        const single = hydra.config.collection || undefined;
        const multi =
          !single &&
          hydra.config.collections &&
          hydra.config.collections.length > 0
            ? hydra.config.collections
            : undefined;
        const res = await hydra.search(q, {
          kind: tab === "memory" ? "memory" : "knowledge",
          maxResults: SEARCH_LIMIT,
          database: hydra.config.database || undefined,
          // The list endpoints are single-collection, but search is not —
          // honor the multi-select here too.
          ...(single ? { collection: single } : multi ? { collections: multi } : {}),
        });
        setHits(toHits(res));
      } catch {
        setSearchFailed(true);
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, tab, hydra]);

  const showSearch = query.trim().length > 0;

  const activeItems = useMemo<(MemoryCard | KnowledgeCard)[]>(
    () => (tab === "memory" ? items : kItems),
    [tab, items, kItems],
  );

  const hasMore = tab === "memory" ? memHasMore : kHasMore;

  // ── actions ──
  const doCopy = async (label: string, text: string) => {
    const ok = await copyText(text);
    push(
      ok
        ? { kind: "success", title: "Copied", detail: label }
        : { kind: "error", title: "Copy failed" },
    );
  };

  const deleteItem = async (kind: Tab, id: string, collection?: string) => {
    if (deleting) return;
    setDeleting(true);
    try {
      // The item's own collection, not the globally-selected one. Deleting
      // under the wrong scope silently removed nothing, or the wrong thing,
      // and reported success either way.
      await hydra.deleteByIds([id], kind, collection ? { collection } : undefined);
      push({
        kind: "success",
        title: "Deleted",
        detail: confirming?.title ? truncate(confirming.title, 60) : undefined,
      });
      setDetail(null);
      setViewing(null);
      setConfirming(null);
      if (kind === "memory") setItems((p) => p.filter((m) => m.id !== id));
      else setKItems((p) => p.filter((k) => k.id !== id));
      void refresh();
    } catch (err) {
      push({
        kind: "error",
        title: "Couldn't delete",
        detail: err instanceof HydraApiError ? err.message : undefined,
      });
    } finally {
      setDeleting(false);
      setConfirming(null);
    }
  };

  const openView = async (card: KnowledgeCard) => {
    setViewing(card);
    setViewContent("");
    setViewLoading(true);
    try {
      // Inspect in the card's own collection. Using the global scope 404s
      // whenever the item came from a different collection.
      const src = await hydra.inspect(
        card.id,
        card.collection ? { collection: card.collection } : undefined,
      );
      // Connector bodies are JSON envelopes; render the prose inside rather
      // than dumping the raw object at the user.
      const text = readableBody(sourceText(src));
      setViewContent(text || card.preview || "No readable content.");
    } catch (err) {
      // Graceful: keep the modal open, fall back to the preview, still toast.
      setViewContent(card.preview || "No readable content.");
      push({
        kind: "error",
        title: "Couldn't load the full content",
        detail: err instanceof HydraApiError ? err.message : undefined,
      });
    } finally {
      setViewLoading(false);
    }
  };

  // ── render ──
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6">
        <PageHeader
          title="Context"
          subtitle="Your memories, files, and notes, all in one place"
          actions={
            <button className="btn-primary" onClick={() => openUpload(lastUploadTab())}>
              <Icon name="plus" size={14} />
              Add context
            </button>
          }
        />

        {/* Search */}
        <div className="relative mb-4">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-4"
          />
          <input
            className="input pl-9 pr-9"
            aria-label="Search context"
            placeholder={
              tab === "memory" ? "Search memories…" : "Search files & notes…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-4 transition-colors hover:text-fg"
              aria-label="Clear search"
            >
              <Icon name="x" size={14} />
            </button>
          ) : null}
          {searching ? (
            <Spinner
              size={14}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-accent"
            />
          ) : null}
        </div>

        {/* Tabs */}
        <div className="mb-4 flex items-center gap-1 border-b border-line">
          <TabButton
            active={tab === "knowledge"}
            label="Knowledge"
            onClick={() => changeTab("knowledge")}
          />
          <TabButton
            active={tab === "memory"}
            label="Memories"
            onClick={() => changeTab("memory")}
          />
        </div>

        {/* Loading skeletons */}
        {loading ? (
          tab === "memory" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[150px] rounded" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[64px] rounded" />
              ))}
            </div>
          )
        ) : null}

        {/* Load error */}
        {!loading && loadError && !showSearch ? (
          <EmptyState
            icon="alert"
            title="Couldn't load your vault"
            message={loadError}
            action={
              <button className="btn-soft" onClick={() => void refresh()}>
                <Icon name="refresh" size={14} />
                Try again
              </button>
            }
          />
        ) : null}

        {/* Search: running / failed / results */}
        {!loading && showSearch ? (
          <>
            {searching && hits === undefined ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-[64px] rounded" />
                ))}
              </div>
            ) : null}
            {!searching && searchFailed ? (
              <EmptyState
                icon="alert"
                title="Search failed"
                message="The backend couldn't answer that search. Check the connection and try again."
                action={
                  <button
                    className="btn-soft"
                    onClick={() => {
                      setQuery("");
                    }}
                  >
                    <Icon name="x" size={14} />
                    Clear search
                  </button>
                }
              />
            ) : null}
            {!searching && !searchFailed && hits && hits.length === 0 ? (
              <EmptyState
                icon="search"
                title="Nothing matched"
                message={`No ${tab === "memory" ? "memories" : "files"} match “${truncate(query.trim(), 40)}”.`}
              />
            ) : null}
            {!searching && !searchFailed && hits && hits.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {hits.map((h) => (
                  <SearchHitCard key={h.key} hit={h} onCopy={doCopy} />
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {/* Empty (list mode) */}
        {!loading && !loadError && !showSearch && activeItems.length === 0 ? (
          <EmptyState
            icon={tab === "memory" ? "brain" : "file"}
            title={tab === "memory" ? "No memories yet" : "No files or notes yet"}
            message={
              tab === "memory"
                ? "Add a thought, paste a note, or save a webpage. Find it later by asking."
                : "Upload files to start building your knowledge base."
            }
            action={
              <button
                className="btn-primary"
                onClick={() => openUpload(tab === "memory" ? "text" : "file")}
              >
                <Icon name="plus" size={14} />
                {tab === "memory" ? "Add context" : "Upload a file"}
              </button>
            }
          />
        ) : null}

        {/* Memory grid */}
        {!loading && !loadError && !showSearch && tab === "memory" && items.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((it) => (
              <MemoryCardView
                key={it.id}
                card={it}
                onOpen={setDetail}
                onCopy={(label, text) => void doCopy(label, text)}
                onDelete={() =>
                  setConfirming({ kind: "memory", id: it.id, title: it.text })
                }
              />
            ))}
          </div>
        ) : null}

        {/* Knowledge grid — same tiling as memories, so both tabs read alike */}
        {!loading && !loadError && !showSearch && tab === "knowledge" && kItems.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {kItems.map((it) => (
              <KnowledgeCardView
                key={it.id}
                card={it}
                onView={(c) => void openView(c)}
                onCopy={(label, text) => void doCopy(label, text)}
                onDelete={() =>
                  setConfirming({
                    kind: "knowledge",
                    id: it.id,
                    title: it.title,
                    collection: it.collection,
                  })
                }
              />
            ))}
          </div>
        ) : null}

        {/* Load more */}
        {!loading && !showSearch && activeItems.length > 0 && hasMore ? (
          <div className="mt-6 flex justify-center">
            <button
              className="btn-soft"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <>
                  <Spinner size={14} /> Loading…
                </>
              ) : (
                "Load more"
              )}
            </button>
          </div>
        ) : null}
      </div>

      {/* Upload modal */}
      <MemoryUpload
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        initialTab={uploadTab}
        onDone={() => void refreshAll()}
      />

      {/* Memory detail modal */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? cap(typeLabel(detail.type)) : "Memory"}
        width={560}
        footer={
          detail ? (
            <>
              <button
                className="btn-ghost"
                onClick={() => void doCopy("memory text", detail.text)}
              >
                <Icon name="copy" size={14} />
                Copy
              </button>
              <button
                className="btn-danger"
                onClick={() =>
                  setConfirming({ kind: "memory", id: detail.id, title: detail.text })
                }
              >
                <Icon name="trash" size={14} />
                Delete
              </button>
            </>
          ) : undefined
        }
      >
        {detail ? (
          <div className="flex flex-col gap-4">
            <p className="select-text whitespace-pre-wrap rounded-sm border border-line bg-bg-2 p-3 text-[13px] leading-relaxed text-fg-2">
              {detail.text}
            </p>
            <dl className="flex flex-col gap-1.5 text-[12px]">
              <MetaRow label="ID" mono nowrap>
                {detail.id}
              </MetaRow>
              <MetaRow label="Created">
                {detail.created ? formatDateTime(detail.created) : "—"}
              </MetaRow>
              <MetaRow label="Type">{typeLabel(detail.type)}</MetaRow>
              <MetaRow label="Inferred">{detail.inferred ? "Yes" : "No"}</MetaRow>
            </dl>
          </div>
        ) : null}
      </Modal>

      {/* Knowledge view modal */}
      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={viewing?.title || "File"}
        width={640}
        footer={
          viewing ? (
            <>
              {viewing.url ? (
                <a
                  className="btn-ghost"
                  href={viewing.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <Icon name="link" size={14} />
                  Open original
                </a>
              ) : null}
              <button
                className="btn-ghost"
                onClick={() =>
                  void doCopy(
                    viewing.title,
                    `${viewing.title}\n\n${viewContent || viewing.preview}`,
                  )
                }
              >
                <Icon name="copy" size={14} />
                Copy
              </button>
            </>
          ) : undefined
        }
      >
        {viewing ? (
          <div className="flex flex-col gap-4">
            {viewLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-11/12" />
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
            ) : (
              <pre className="select-text max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-sm border border-line bg-bg-2 p-3 font-sans text-[13px] leading-relaxed text-fg-2">
                {viewContent}
              </pre>
            )}
            <dl className="flex flex-col gap-1.5 text-[12px]">
              <MetaRow label="ID" mono nowrap>
                {viewing.id}
              </MetaRow>
              <MetaRow label="Type">{typeLabel(viewing.type)}</MetaRow>
              {viewing.provider ? (
                <MetaRow label="Provider">{cap(viewing.provider)}</MetaRow>
              ) : null}
              {viewing.url ? (
                <MetaRow label="URL">
                  <a
                    className="break-all text-accent hover:underline"
                    href={viewing.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {viewing.url}
                  </a>
                </MetaRow>
              ) : null}
              <MetaRow label="Fetched">
                {viewing.timestamp ? formatDateTime(viewing.timestamp) : "—"}
              </MetaRow>
            </dl>
          </div>
        ) : null}
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!confirming}
        onClose={() => setConfirming(null)}
        onConfirm={() =>
          confirming
            ? void deleteItem(confirming.kind, confirming.id, confirming.collection)
            : undefined
        }
        title={confirming?.kind === "knowledge" ? "Delete file?" : "Delete memory?"}
        message={
          confirming?.kind === "knowledge"
            ? "This file will be removed from your knowledge base. Sources connected through integrations are unaffected."
            : "This memory will be removed from your vault. This can't be undone."
        }
        busy={deleting}
      />
    </div>
  );
}

// ── Views ─────────────────────────────────────────────────────────

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative px-3 py-2 text-[13px] transition-colors",
        active ? "font-medium text-fg" : "text-fg-3 hover:text-fg",
      )}
    >
      {label}
      {active ? (
        <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent" />
      ) : null}
    </button>
  );
}

/**
 * An action button in a card's footer.
 *
 * The card's open handler now lives on a separate content button, not the whole
 * card, so these actions are siblings and cannot trigger it. stopPropagation is
 * kept as a harmless guard.
 */
function CardAction({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11.5px] transition-colors",
        danger
          ? "text-fg-4 hover:bg-bad-fill hover:text-bad"
          : "text-fg-4 hover:bg-bg-3 hover:text-fg",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}

/** Score bar for search results (score 0..1 or already 0..100). */
function ScoreBar({ score }: { score?: number }) {
  const pct =
    score == null || Number.isNaN(score)
      ? 0
      : Math.min(100, Math.max(0, score <= 1 ? score * 100 : score));
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-[3px] w-16 overflow-hidden rounded-full bg-inset">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      {score != null && !Number.isNaN(score) ? (
        <span className="text-[10.5px] tabular-nums text-fg-4">
          {score.toFixed(2)}
        </span>
      ) : null}
    </div>
  );
}

function SearchHitCard({
  hit,
  onCopy,
}: {
  hit: SearchHit;
  onCopy: (label: string, text: string) => void;
}) {
  return (
    <div className="card flex flex-col gap-2.5 p-4">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">
          {hit.title}
        </p>
        <ScoreBar score={hit.score} />
      </div>
      {hit.snippet ? (
        <p className="line-clamp-3 text-[12.5px] leading-relaxed text-fg-3">
          {hit.snippet}
        </p>
      ) : null}
      <div className="mt-auto flex items-center gap-1 border-t border-line pt-2">
        <CardAction
          icon="copy"
          label="Copy"
          onClick={() => onCopy(hit.title, hit.snippet || hit.title)}
        />
      </div>
    </div>
  );
}

function MemoryCardView({
  card,
  onOpen,
  onCopy,
  onDelete,
}: {
  card: MemoryCard;
  onOpen: (c: MemoryCard) => void;
  onCopy: (label: string, text: string) => void;
  onDelete: () => void;
}) {
  // The card is a plain container. Its content is one button that opens the
  // detail, and the Copy/Delete actions are siblings, so no interactive element
  // is nested inside another.
  return (
    <div className="card group flex flex-col gap-2.5 p-4 transition-colors hover:border-accent-line hover:bg-bg-2">
      <button
        type="button"
        onClick={() => onOpen(card)}
        className="flex flex-1 flex-col gap-2.5 text-left outline-none"
      >
        <div className="flex items-center gap-1.5">
          <span className="chip">{typeLabel(card.type)}</span>
          {card.inferred ? (
            <span className="chip">
              <Icon name="sparkles" size={11} />
              Inferred
            </span>
          ) : null}
          {card.created ? (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-fg-4">
              <Icon name="clock" size={11} />
              {timeAgo(card.created)}
            </span>
          ) : null}
        </div>
        <p className="line-clamp-4 text-[13px] leading-relaxed text-fg-2">
          {card.text}
        </p>
      </button>
      <div className="mt-auto flex items-center gap-1 border-t border-line pt-2">
        <CardAction
          icon="copy"
          label="Copy"
          onClick={() => onCopy("memory text", card.text)}
        />
        <CardAction icon="trash" label="Delete" danger onClick={onDelete} />
      </div>
    </div>
  );
}

/**
 * Knowledge tile — the same vertical card shape as MemoryCardView so both
 * tabs read as one grid. The provider logo carries the identity here, because
 * connector-synced titles repeat heavily ("Slack message" over and over) and
 * the preview text is what actually distinguishes one item from another.
 */
function KnowledgeCardView({
  card,
  onView,
  onCopy,
  onDelete,
}: {
  card: KnowledgeCard;
  onView: (c: KnowledgeCard) => void;
  onCopy: (label: string, text: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="card group flex flex-col gap-2.5 p-4 transition-colors hover:border-accent-line hover:bg-bg-2">
      <button
        type="button"
        onClick={() => onView(card)}
        className="flex flex-1 flex-col gap-2.5 text-left outline-none"
      >
        <div className="flex items-center gap-2">
          <ProviderLogo id={card.provider} size={22} className="shrink-0" />
          <span className="chip shrink-0">{typeLabel(card.type)}</span>
          {card.timestamp ? (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-fg-4">
              <Icon name="clock" size={11} />
              {timeAgo(card.timestamp)}
            </span>
          ) : null}
        </div>

        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-fg">{card.title}</p>
          {card.url ? (
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-fg-4">
              <Icon name="globe" size={11} className="shrink-0" />
              <span className="truncate">{hostname(card.url)}</span>
            </span>
          ) : null}
        </div>

        {card.preview ? (
          <p className="line-clamp-4 text-[13px] leading-relaxed text-fg-2">
            {card.preview}
          </p>
        ) : null}
      </button>

      <div className="mt-auto flex items-center gap-1 border-t border-line pt-2">
        <CardAction icon="file" label="View" onClick={() => onView(card)} />
        <CardAction
          icon="copy"
          label="Copy"
          onClick={() => onCopy(card.title, `${card.title}\n\n${card.preview || ""}`.trim())}
        />
        {card.url ? (
          <a
            className="flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11.5px] text-fg-4 transition-colors hover:bg-bg-3 hover:text-fg"
            href={card.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            aria-label="Open source in a new tab"
          >
            <Icon name="external" size={12} />
            Open
          </a>
        ) : null}
        <CardAction icon="trash" label="Delete" danger onClick={onDelete} />
      </div>
    </div>
  );
}

function MetaRow({
  label,
  children,
  mono = false,
  nowrap = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  nowrap?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <dt className="mt-px w-16 shrink-0 text-fg-4">{label}</dt>
      <dd
        className={cn(
          "min-w-0 flex-1 text-fg-2",
          mono && "font-mono text-[11px] leading-relaxed",
          !nowrap && "break-all",
        )}
      >
        {children}
      </dd>
    </div>
  );
}