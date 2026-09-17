"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAppConfig } from "@/lib/store/config";
import { useHydra, HydraApiError } from "@/lib/api";
import { streamChat } from "@/lib/llm";
import { useToast } from "@/lib/toast";
import { ConfirmDialog, EmptyState, Modal, Skeleton } from "@/components/ui";
import { Icon, Spinner } from "@/components/Icon";
import { cn, copyText, timeAgo, truncate } from "@/lib/utils";
import type { HydraMemory, HydraSource, SearchResult } from "@/lib/types";
import { chunksToSources, normalizeSearchResponse } from "@/lib/qa";

function errMsg(err: unknown): string {
  if (err instanceof HydraApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

function hostname(u?: string): string {
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const SYSTEM_PROMPT =
  "You are Open Glean, a personal second-brain assistant grounded in the user's Hydra DB knowledge base. Answer the question using ONLY the numbered context below. If the context is insufficient, say so plainly instead of guessing. Cite sources inline like [1], [2]. Be concise and direct.";

export default function CollectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const searchParams = useSearchParams();
  const { config } = useAppConfig();
  const dbParam = searchParams?.get("db");
  const database = (dbParam && dbParam.trim()) || config.database || "";
  const [tab, setTab] = useState<"ask" | "contents">("ask");

  const isActive = config.collection === slug;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[880px] px-4 py-5 md:px-6 md:py-6 pb-24">
        <Link
          href="/collections"
          className="inline-flex items-center gap-1.5 text-[12px] text-fg-4 transition-colors hover:text-fg-2"
        >
          <Icon name="arrowRight" size={13} className="rotate-180" />
          Collections
        </Link>

        <div className="mt-2 mb-5 flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent">
            <Icon name="folder" size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-mono text-[24px] font-bold tracking-tight text-fg">
              {slug}
            </h1>
            <p className="text-[12px] text-fg-4">
              {database ? (
                <>
                  in <span className="font-mono text-fg-3">{database}</span> · sub-tenant scope
                </>
              ) : (
                "sub-tenant scope"
              )}
            </p>
          </div>
          {isActive ? (
            <span className="chip shrink-0">
              <Icon name="check" size={11} className="-ml-0.5" /> Active collection
            </span>
          ) : null}
        </div>

        {!database ? (
          <div className="flex flex-wrap items-center gap-3 rounded-sm border border-warn/30 bg-warn-fill px-4 py-3">
            <Icon name="alert" size={14} className="shrink-0 text-warn" />
            <p className="min-w-0 flex-1 text-[12px] text-fg-2">
              No database selected. Set a default in Settings, or open this
              collection with a <span className="font-mono">?db=…</span> param.
            </p>
            <Link href="/settings" className="btn-soft h-7 px-2.5 text-[12px]">
              Settings
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-5 flex w-fit items-center gap-1 rounded-sm border border-line bg-bg-2 p-1">
              {(["ask", "contents"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "rounded-xs px-4 py-1.5 text-[13px] font-medium capitalize transition-colors",
                    tab === t ? "bg-accent-dim text-fg" : "text-fg-3 hover:text-fg",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>

            {tab === "ask" ? (
              <AskPane slug={slug} database={database} />
            ) : (
              <ContentsPane slug={slug} database={database} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Ask tab ───────────────────────────────────────────────────────

function AskPane({ slug, database }: { slug: string; database: string }) {
  const { config } = useAppConfig();
  const hydra = useHydra();
  const toast = useToast();
  const abortRef = useRef<AbortController | null>(null);
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [answer, setAnswer] = useState("");

  const hasLlm = Boolean(
    (config.llm?.apiKey?.trim() || config.llmConfigured) && config.llm?.model?.trim(),
  );

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const ask = useCallback(async () => {
    const query = q.trim();
    if (!query || busy) return;
    setQ("");
    setAsked(query);
    setResults([]);
    setAnswer("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await hydra.search(query, {
        kind: "all",
        maxResults: 8,
        collection: slug,
        database,
      });
      // The proxy returns the raw /query envelope ({ data: { chunks } }),
      // not { results } — normalize it the same way every other page does.
      const found = chunksToSources(normalizeSearchResponse(res).chunks);
      setResults(found);
      if (hasLlm) {
        let acc = "";
        await streamChat({
          baseUrl: config.llm?.baseUrl,
          apiKey: config.llm?.apiKey ?? "",
          model: config.llm?.model ?? "",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `Question: ${query}\n\nContext (your only knowledge source):\n\n${buildContext(found) || "(no relevant context found — say so)"}`,
            },
          ],
          temperature: 0.2,
          maxTokens: 900,
          signal: ctrl.signal,
          onDelta: (t) => {
            acc += t;
            setAnswer(acc);
          },
        });
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      toast.push({
        kind: "error",
        title: "Ask failed",
        detail: errMsg(err),
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [q, busy, hydra, slug, database, hasLlm, config.llm, toast]);

  const copyAnswer = useCallback(async () => {
    if (!answer) return;
    const ok = await copyText(answer);
    toast.push(
      ok ? { kind: "success", title: "Answer copied" } : { kind: "error", title: "Could not copy" },
    );
  }, [answer, toast]);

  return (
    <div className="space-y-4">
      <div className="card p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !busy) {
                e.preventDefault();
                void ask();
              }
            }}
            placeholder={`Ask within "${slug}"…`}
            rows={3}
            className="min-h-[72px] flex-1 resize-none rounded-sm border border-line bg-bg-2 px-3 py-2.5 text-[13px] text-fg placeholder:text-fg-4 outline-none transition-[border-color,box-shadow] focus:border-accent-line focus:shadow-[0_0_0_3px_var(--accent-ring)]"
          />
          <button
            className="btn-primary shrink-0"
            onClick={() => void ask()}
            disabled={!q.trim() || busy}
          >
            {busy ? <Spinner size={13} /> : <Icon name="sparkles" size={13} />}
            {busy ? "Working…" : "Ask"}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-fg-4">
          Searches this collection ·{" "}
          {hasLlm
            ? "written answers on"
            : "search results only. Add a model for written answers."}
        </p>
      </div>

      {asked ? (
        <div className="card p-4">
          <div className="flex items-start justify-between gap-3">
            <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-fg">
              <Icon name="search" size={13} className="shrink-0 text-accent" />
              <span className="break-words">{asked}</span>
            </p>
            {answer ? (
              <button
                className="btn-ghost h-7 shrink-0 px-2 text-[12px]"
                onClick={() => void copyAnswer()}
              >
                <Icon name="copy" size={12} /> Copy answer
              </button>
            ) : null}
          </div>

          {busy && !answer ? (
            <div className="mt-3 flex items-center gap-2 text-[13px] text-fg-3">
              <Spinner size={13} className="text-accent" />
              {hasLlm ? "Synthesizing answer…" : "Searching…"}
            </div>
          ) : null}

          {answer ? (
            <div className="mt-3 max-h-[340px] overflow-y-auto whitespace-pre-wrap rounded-sm border border-line bg-bg-2 px-3.5 py-3 text-[13px] leading-relaxed text-fg-2">
              {answer}
              {busy ? <span className="cursor-blink text-accent">▍</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {results.length > 0 ? <ResultsList results={results} /> : null}

      {asked && !busy && results.length === 0 && !answer ? (
        <EmptyState
          icon="search"
          title="No matches in this collection"
          message="Try rewording your question, or add content to this collection first."
        />
      ) : null}

      {asked && results.length > 0 && !hasLlm ? (
        <div className="flex flex-wrap items-center gap-3 rounded-sm border border-warn/30 bg-warn-fill px-4 py-3">
          <Icon name="alert" size={14} className="shrink-0 text-warn" />
          <p className="min-w-0 flex-1 text-[12px] text-fg-2">
            Showing search results only. Add a model in Settings to get written
            answers.
          </p>
          <Link href="/settings" className="btn-soft h-7 px-2.5 text-[12px]">
            Settings
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function buildContext(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const s = r.source;
      const title = s?.title ?? r.chunks?.[0]?.source_title ?? `Source ${i + 1}`;
      const chunks = (r.chunks ?? [])
        .map((c) => c.chunk_content ?? c.content ?? c.text ?? "")
        .filter(Boolean)
        .join("\n")
        .slice(0, 2400);
      const body = chunks || (s?.content_preview as string) || (s?.description as string) || "(no extract)";
      return `[${i + 1}] ${title}\n${body}`;
    })
    .join("\n\n");
}

/** Topped search hits: chunk title/marker, source chip, score bar, expandable. */
function ResultsList({ results }: { results: SearchResult[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());

  const toggle = (i: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="space-y-2">
      <p className="text-[12px] font-medium uppercase tracking-wide text-fg-4">
        Top results · {results.length}
      </p>
      {results.map((r, i) => {
        const s = r.source;
        const chunks = r.chunks ?? [];
        const first = chunks[0];
        const title = s?.title ?? first?.source_title ?? `Source ${i + 1}`;
        const score = r.score ?? first?.score ?? first?.relevancy_score;
        const expanded = open.has(i);
        const isMemory =
          s?.type === "memory" ||
          s?.type === "memo" ||
          first?.source_type === "memory";
        return (
          <div key={s?.id ?? i} className="card overflow-hidden">
            <button
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2"
              onClick={() => toggle(i)}
            >
              <Icon
                name={isMemory ? "brain" : "file"}
                size={14}
                className={cn("shrink-0", isMemory ? "text-accent" : "text-highlight")}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">{title}</span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  {score != null ? (
                    <span className="w-[88px]">
                      <span className="block h-1 overflow-hidden rounded-full bg-line">
                        <span
                          className="block h-full rounded-full bg-accent"
                          style={{ width: `${Math.min(100, Math.round(score * 100))}%` }}
                        />
                      </span>
                    </span>
                  ) : null}
                </span>
              </span>
              {score != null ? (
                <span className="chip shrink-0">{Math.round(score * 100)}%</span>
              ) : null}
              <Icon
                name="chevDown"
                size={13}
                className={cn("shrink-0 text-fg-4 transition-transform", expanded && "rotate-180")}
              />
            </button>
            {expanded ? (
              <div className="space-y-2.5 border-t border-line px-3.5 py-3">
                {chunks.length === 0 ? (
                  <p className="text-[12px] leading-relaxed text-fg-3">
                    {s?.content_preview ?? s?.description ?? "No extract available."}
                  </p>
                ) : (
                  chunks.map((c, j) => {
                    const body =
                      c.chunk_content ?? c.content ?? c.text ?? "";
                    const sc = c.score ?? c.relevancy_score;
                    return (
                      <div key={c.chunk_uuid ?? c.chunk_id ?? j}>
                        {sc != null ? (
                          <p className="mb-0.5 text-[10px] uppercase tracking-wide text-fg-4">
                            chunk · {Math.round(sc * 100)}% match
                          </p>
                        ) : null}
                        <p className="text-[12px] leading-relaxed text-fg-2">{body}</p>
                      </div>
                    );
                  })
                )}
                {s?.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
                  >
                    <Icon name="external" size={11} /> Open {hostname(s.url)}
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Contents tab ──────────────────────────────────────────────────

interface Item {
  id: string;
  kind: "memory" | "knowledge";
  title: string;
  preview: string;
  url?: string;
  created?: string;
  type?: string;
}

function toItems(
  list: unknown[],
  kind: "memory" | "knowledge",
): Item[] {
  const out: Item[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const x = raw as HydraMemory & HydraSource;
    const id = (kind === "memory" ? x.memory_id : x.source_id) ?? x.id;
    if (!id) continue;
    const isMem = kind === "memory";
    const memText = x.memory_content ?? x.content ?? x.text ?? "";
    const srcText = x.content_preview ?? x.chunk_content ?? "";
    const text = isMem ? memText : srcText;
    const title = isMem
      ? truncate(memText, 90) || "Memory"
      : truncate(x.title ?? (text || "Untitled source"), 90);
    out.push({
      id,
      kind,
      title,
      preview: truncate(text, 260),
      url: isMem ? undefined : x.url,
      created: isMem ? x.created_at : x.timestamp,
      type: isMem ? x.type : x.type,
    });
  }
  return out;
}

function ContentsPane({ slug, database }: { slug: string; database: string }) {
  const hydra = useHydra();
  const toast = useToast();
  const hydraRef = useRef(hydra);

  useEffect(() => {
    hydraRef.current = hydra;
  });

  const [memories, setMemories] = useState<Item[]>([]);
  const [knowledge, setKnowledge] = useState<Item[]>([]);
  const [memTotal, setMemTotal] = useState<number | undefined>(undefined);
  const [knoTotal, setKnoTotal] = useState<number | undefined>(undefined);
  const [memPage, setMemPage] = useState(1);
  const [knoPage, setKnoPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<"memory" | "knowledge" | null>(null);
  const [toDelete, setToDelete] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<{ item: Item; data: HydraSource | null; busy: boolean } | null>(
    null,
  );

  const loadPage = useCallback(
    async (kind: "memory" | "knowledge", page: number, append: boolean) => {
      const h = hydraRef.current;
      const res =
        kind === "memory"
          ? await h.listMemories({ collection: slug, database, page, pageSize: 20 })
          : await h.listKnowledge({ collection: slug, database, page, pageSize: 20 });
      const items = toItems(
        [
          ...(res.sources ?? []),
          ...(("user_memories" in res ? (res.user_memories ?? []) : []) as HydraMemory[]),
          ...(res.data ?? []),
        ],
        kind,
      );
      const total = res.total ?? res.count;
      if (kind === "memory") {
        setMemories((s) => (append ? [...s, ...items] : items));
        if (total != null) setMemTotal(total);
        setMemPage(page + 1);
      } else {
        setKnowledge((s) => (append ? [...s, ...items] : items));
        if (total != null) setKnoTotal(total);
        setKnoPage(page + 1);
      }
      return items.length;
    },
    [slug, database],
  );

  useEffect(() => {
    let alive = true;
    Promise.all([loadPage("memory", 1, false), loadPage("knowledge", 1, false)])
      .catch((err) => {
        if (alive) toast.push({ kind: "error", title: "Could not load contents", detail: errMsg(err) });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [loadPage, toast]);

  const loadMore = async (kind: "memory" | "knowledge") => {
    if (loadingMore) return;
    const page = kind === "memory" ? memPage : knoPage;
    setLoadingMore(kind);
    try {
      await loadPage(kind, page, true);
    } catch (err) {
      toast.push({ kind: "error", title: "Could not load more", detail: errMsg(err) });
    } finally {
      setLoadingMore(null);
    }
  };

  const doDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      // Scope the delete to the collection being viewed. Without this it used
      // the globally-selected scope, so viewing collection B while the scope
      // picker pointed at A deleted from A and reported success.
      const res = await hydraRef.current.deleteByIds([toDelete.id], toDelete.kind, {
        collection: slug,
        database,
      });
      toast.push({
        kind: "success",
        title: res.deleted_count ? "Deleted" : "Removed",
        detail: res.message,
      });
      if (toDelete.kind === "memory")
        setMemories((s) => s.filter((i) => i.id !== toDelete.id));
      else setKnowledge((s) => s.filter((i) => i.id !== toDelete.id));
      setToDelete(null);
    } catch (err) {
      toast.push({ kind: "error", title: "Delete failed", detail: errMsg(err) });
    } finally {
      setDeleting(false);
    }
  };

  const openView = async (item: Item) => {
    setView({ item, data: null, busy: true });
    try {
      const data = await hydraRef.current.inspect(item.id, { collection: slug, database });
      setView({ item, data, busy: false });
    } catch (err) {
      toast.push({ kind: "error", title: "Could not load", detail: errMsg(err) });
      setView(null);
    }
  };

  return (
    <div>
      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <>
          {/* Memories */}
          <section className="mb-7">
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold text-fg">
                Memories{" "}
                {memTotal != null ? (
                  <span className="ml-1 font-normal text-fg-4">{memTotal}</span>
                ) : null}
              </h2>
            </div>
            {memories.length === 0 ? (
              <p className="text-[12px] text-fg-4">No memories in this collection yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {memories.map((m) => (
                  <div
                    key={m.id}
                    className="group flex flex-wrap items-start gap-3 rounded-md border border-line bg-bg-2 px-3.5 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] leading-relaxed text-fg-2">{m.title}</p>
                      {m.preview && m.preview !== m.title ? (
                        <p className="mt-1 text-[12px] leading-relaxed text-fg-4 line-clamp-2">
                          {m.preview}
                        </p>
                      ) : null}
                      <p className="mt-1.5 flex items-center gap-2 text-[11px] text-fg-5">
                        {m.type ? <span>{m.type}</span> : null}
                        {m.created ? <span>{timeAgo(m.created)}</span> : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
                      <button
                        onClick={() => setToDelete(m)}
                        className="icon-btn hover:!text-bad"
                        title="Delete"
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                {memPage > 0 && memories.length >= 20 ? (
                  <button
                    className="btn-soft w-full"
                    onClick={() => loadMore("memory")}
                    disabled={loadingMore === "memory"}
                  >
                    {loadingMore === "memory" ? "Loading…" : "Load more memories"}
                  </button>
                ) : null}
              </div>
            )}
          </section>

          {/* Knowledge */}
          <section>
            <div className="mb-2.5 flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold text-fg">
                Knowledge{" "}
                {knoTotal != null ? (
                  <span className="ml-1 font-normal text-fg-4">{knoTotal}</span>
                ) : null}
              </h2>
            </div>
            {knowledge.length === 0 ? (
              <p className="text-[12px] text-fg-4">No knowledge sources in this collection yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {knowledge.map((k) => (
                  <div
                    key={k.id}
                    className="group flex flex-wrap items-start gap-3 rounded-md border border-line bg-bg-2 px-3.5 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {k.type ? (
                          <span className="chip">{k.type}</span>
                        ) : null}
                        <p className="truncate text-[13px] font-medium text-fg">{k.title}</p>
                      </div>
                      {k.preview ? (
                        <p className="mt-1 text-[12px] leading-relaxed text-fg-4 line-clamp-2">
                          {k.preview}
                        </p>
                      ) : null}
                      <p className="mt-1.5 flex items-center gap-2 text-[11px] text-fg-5">
                        {hostname(k.url) ? <span>{hostname(k.url)}</span> : null}
                        {k.created ? <span>{timeAgo(k.created)}</span> : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
                      {k.url ? (
                        <a
                          href={k.url}
                          target="_blank"
                          rel="noreferrer"
                          className="icon-btn"
                          title="Open"
                        >
                          <Icon name="external" size={13} />
                        </a>
                      ) : null}
                      <button onClick={() => openView(k)} className="icon-btn" title="View">
                        <Icon name="eye" size={14} />
                      </button>
                      <button
                        onClick={() => setToDelete(k)}
                        className="icon-btn hover:!text-bad"
                        title="Delete"
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                {knoPage > 0 && knowledge.length >= 20 ? (
                  <button
                    className="btn-soft w-full"
                    onClick={() => loadMore("knowledge")}
                    disabled={loadingMore === "knowledge"}
                  >
                    {loadingMore === "knowledge" ? "Loading…" : "Load more sources"}
                  </button>
                ) : null}
              </div>
            )}
          </section>
        </>
      )}

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={doDelete}
        title={`Delete ${toDelete?.kind ?? "item"}?`}
        message="This permanently removes it from your Hydra database."
        busy={deleting}
      />

      <Modal
        open={Boolean(view)}
        onClose={() => setView(null)}
        title={view?.item.title ?? ""}
        width={560}
      >
        {view?.busy ? (
          <Skeleton className="h-24 w-full" />
        ) : view?.data ? (
          <div className="space-y-3">
            {view.data.url ? (
              <a
                href={view.data.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-[12px] text-accent hover:underline"
              >
                <Icon name="external" size={12} /> {hostname(view.data.url)}
              </a>
            ) : null}
            <p className="whitespace-pre-wrap rounded-sm border border-line bg-bg p-3 text-[13px] leading-relaxed text-fg-2">
              {(view.data.content as string) ??
                view.data.content_preview ??
                view.data.text ??
                view.data.chunk_content ??
                "No content available."}
            </p>
            <p className="font-mono text-[10px] text-fg-5 break-all">{view.item.id}</p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}