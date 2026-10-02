"use client";

/**
 * Mindmap — the knowledge graph of your context, rendered with the
 * dashboard-2.0 SourceGraph (react-force-graph-2d): zoom controls, node
 * search, relation-type filter, label toggles.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHydra, HydraApiError } from "@/lib/api";
import { useToast } from "@/lib/toast";
import {
  SourceGraph,
  type SourceGraphHandle,
  type TripletWithEvidence,
} from "@/components/SourceGraph";
import { EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { Icon, Spinner } from "@/components/Icon";
import { cn, timeAgo } from "@/lib/utils";

function errMsg(err: unknown): string {
  if (err instanceof HydraApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** The SDK serializes camelCase (entityId, canonicalPredicate…) but
 * SourceGraph expects the raw API's snake_case Entity/RelationEvidence —
 * without this remap every entity_id is undefined and the whole graph
 * merges into a single node. */
function normalizeTriplet(raw: Record<string, unknown>): TripletWithEvidence | null {
  const src = raw.source as Record<string, unknown> | undefined;
  const tgt = raw.target as Record<string, unknown> | undefined;
  if (!src || !tgt) return null;
  const ent = (e: Record<string, unknown>) => ({
    name: String(e.name ?? ""),
    type: String(e.type ?? ""),
    namespace: String(e.namespace ?? ""),
    entity_id: String(
      e.entity_id ?? e.entityId ?? "",
    ),
    identifier:
      e.identifier != null ? String(e.identifier) : null,
    provider: (e.provider as string) ?? null,
  });
  const rels = (Array.isArray(raw.relations) ? raw.relations : []) as Record<
    string,
    unknown
  >[];
  return {
    source: ent(src),
    target: ent(tgt),
    relations: rels.map((r) => ({
      canonical_predicate: String(
        r.canonical_predicate ?? r.canonicalPredicate ?? "related",
      ),
      raw_predicate: String(
        r.raw_predicate ?? r.rawPredicate ?? "related",
      ),
      context: String(r.context ?? ""),
      confidence: Number(r.confidence ?? 0),
      temporal_details:
        ((r.temporal_details ?? r.temporalDetails ?? null) as string | null),
      timestamp: String(r.timestamp ?? ""),
      relationship_id: String(
        r.relationship_id ?? r.relationshipId ?? "",
      ),
      chunk_id: (r.chunk_id ?? r.chunkId) as string | null,
      source_entity_id: (r.source_entity_id ?? r.sourceEntityId) as string | null,
      target_entity_id: (r.target_entity_id ?? r.targetEntityId) as string | null,
    })),
    chunk_id: String(raw.chunk_id ?? raw.chunkId ?? ""),
  };
}

export default function MindmapPage() {
  const hydra = useHydra();
  const toast = useToast();
  const hydraRef = useRef(hydra);
  const reqRef = useRef(0);
  const graphRef = useRef<SourceGraphHandle | null>(null);

  useEffect(() => {
    hydraRef.current = hydra;
  });

  const [triplets, setTriplets] = useState<TripletWithEvidence[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<{ id: string; label: string }[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [relFilter, setRelFilter] = useState<string | null>(null);
  const [relOpen, setRelOpen] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [selected, setSelected] = useState<TripletWithEvidence | null>(null);
  // A phone-width canvas cannot render a thousand labelled nodes legibly — it
  // draws as a hairball zoomed past the point of meaning. Start small there.
  const [nodeLimit, setNodeLimit] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < 640 ? 200 : 1000,
  );

  const db = hydra.config.database ?? "";
  const singleCol = hydra.config.collection ?? "";
  // Serialized scalar: the `collections` array identity changes every render,
  // so the load callback depends on this string instead.
  const collectionsKey = JSON.stringify(hydra.config.collections ?? []);

  const load = useCallback(async () => {
    const reqId = ++reqRef.current;
    setError("");
    setLoading(true);
    // Parsed inside the callback: the dep is the serialized `collectionsKey`
    // scalar (array identity changes every render).
    const storedCols = JSON.parse(collectionsKey) as string[];
    try {
      const h = hydraRef.current;
      const groups: TripletWithEvidence[] = [];

      // Scope precedence (same rule as chat + Context search): a single
      // `collection` shadows the multi-select `collections`. The config load
      // already normalizes this; the check here is a belt-and-braces guard so
      // the graph can never span N collections while search stays in one.
      const selected = singleCol
        ? [singleCol]
        : storedCols.length > 0
          ? storedCols
          : [];
      const collections =
        selected.length > 0
          ? selected
          : db
            ? ((await h.listCollections(db)).sub_tenant_ids ?? [])
            : [];
      if (collections.length === 0) {
        setError(
          db
            ? "This database has no collections yet. Connect an app or add context first."
            : "No database selected. Pick one in the top bar.",
        );
        setTriplets([]);
        return;
      }

      const perCollection = Math.max(50, Math.floor(2000 / collections.length));
      // Fan out in batches rather than all at once. A database with 100
      // collections opened 100 simultaneous requests through the proxy, which
      // is enough to exhaust the connection pool and starve the rest of the
      // page.
      const CONCURRENCY = 6;
      const fetchOne = (c: string) =>
        h
          .relations({
            limit: perCollection,
            database: db || undefined,
            collection: c,
          })
          .then((res) => (res.relations ?? res.triplets ?? []) as TripletWithEvidence[])
          .catch(() => [] as TripletWithEvidence[]);

      const results: PromiseSettledResult<TripletWithEvidence[]>[] = [];
      for (let i = 0; i < collections.length; i += CONCURRENCY) {
        const batch = collections.slice(i, i + CONCURRENCY);
        results.push(...(await Promise.allSettled(batch.map(fetchOne))));
      }
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        for (const raw of r.value as unknown as Record<string, unknown>[]) {
          const t = normalizeTriplet(raw);
          if (t) groups.push(t);
        }
      }

      if (reqId !== reqRef.current) return;
      setTriplets(groups);
    } catch (err) {
      if (reqId !== reqRef.current) return;
      const msg = errMsg(err);
      setError(msg);
      toast.push({ kind: "error", title: "Could not load the mindmap", detail: msg });
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  }, [db, collectionsKey, singleCol, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Distinct relation predicates, ranked by frequency (dashboard GraphPage).
  const relationTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of triplets ?? []) {
      for (const r of t.relations ?? []) {
        if (!r.canonical_predicate) continue;
        counts.set(
          r.canonical_predicate,
          (counts.get(r.canonical_predicate) || 0) + 1,
        );
      }
    }
    return Array.from(counts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }, [triplets]);

  const filteredTriplets = useMemo(() => {
    if (!relFilter || !triplets) return triplets;
    return triplets
      .map((t) => {
        const rels = (t.relations ?? []).filter(
          (r) => r.canonical_predicate === relFilter,
        );
        return rels.length ? { ...t, relations: rels } : null;
      })
      .filter((t): t is TripletWithEvidence => t !== null);
  }, [triplets, relFilter]);

  // Node search (dashboard GraphPage pattern).
  const onSearchChange = (v: string) => {
    setQ(v);
    setSearchOpen(true);
    const nodes = graphRef.current?.nodes ?? [];
    setMatches(
      v.trim()
        ? nodes
            .filter((n) => n.label.toLowerCase().includes(v.toLowerCase()))
            .slice(0, 8)
        : [],
    );
  };
  const pick = (id: string) => {
    setQ("");
    setSearchOpen(false);
    setMatches([]);
    graphRef.current?.focusNode(id);
  };

  const totalRelations = triplets?.length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1200px] px-4 py-5 md:px-6 md:py-6 pb-24">
        <PageHeader
          title="Mindmap"
          subtitle="The knowledge graph Hydra builds from your context."
          actions={
            <button className="btn-soft" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
              Regraph
            </button>
          }
        />

        {loading && !triplets ? (
          <Skeleton className="h-[480px] w-full" />
        ) : error && !triplets ? (
          <EmptyState
            icon="alert"
            title="Could not load the mindmap"
            message={error}
            action={
              <button className="btn-primary" onClick={() => void load()}>
                <Icon name="refresh" size={13} /> Try again
              </button>
            }
          />
        ) : (triplets?.length ?? 0) === 0 ? (
          <EmptyState
            icon="graph"
            title="Nothing to map yet"
            message="As you add content, Hydra links it together. Those links show up here."
            action={
              <button className="btn-soft" onClick={() => void load()}>
                <Icon name="refresh" size={13} /> Refresh
              </button>
            }
          />
        ) : (
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="min-w-0 flex-1">
              {/* Toolbar */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative">
                  <div className="flex h-8 items-center gap-1.5 rounded-md border border-solid border-stroke-1 bg-surface-4 px-2.5">
                    <Icon name="search" size={13} className="text-text-2" />
                    <input
                      className="w-[140px] bg-transparent text-xs text-text-1 outline-none placeholder:text-text-2"
                      aria-label="Find a node"
              placeholder="Find a node…"
                      value={q}
                      onChange={(e) => onSearchChange(e.target.value)}
                      onFocus={() => setSearchOpen(true)}
                      onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && matches[0]) pick(matches[0].id);
                        if (e.key === "Escape") setSearchOpen(false);
                      }}
                    />
                  </div>
                  {searchOpen && matches.length > 0 ? (
                    <div className="absolute left-0 top-full z-[80] mt-1 w-[220px] overflow-hidden rounded-md border border-solid border-stroke-1 bg-surface-4 shadow-xl">
                      {matches.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="block w-full truncate px-3 py-2 text-left text-xs text-text-2 transition-colors hover:bg-surface-7 hover:text-text-1"
                          // onMouseDown fires before the input's blur closes
                          // this list, which is why it was used — but it never
                          // fires for Enter or Space, so these were focusable
                          // and inert for keyboard users. onClick covers both;
                          // preventDefault on mousedown keeps the blur from
                          // closing the list before the click lands.
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pick(m.id)}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                {/* Relation filter */}
                {relationTypes.length > 0 ? (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setRelOpen((o) => !o)}
                      className={cn(
                        "flex h-8 items-center gap-1.5 rounded-md border border-solid px-2.5 text-xs transition-colors",
                        relFilter || relOpen
                          ? "border-accent-line text-text-1"
                          : "border-stroke-1 text-text-2 hover:text-text-1",
                      )}
                    >
                      <span className="max-w-[130px] truncate font-mono uppercase">
                        {relFilter ?? "all relations"}
                      </span>
                      <Icon name="chevDown" size={11} />
                    </button>
                    {relOpen ? (
                      <div className="absolute left-0 top-full z-[80] mt-1 w-[240px] rounded-md border border-solid border-stroke-1 bg-surface-4 p-1.5 shadow-xl">
                        <div className="max-h-[240px] overflow-y-auto">
                          <button
                            className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-text-2 transition-colors hover:bg-surface-7"
                            onClick={() => {
                              setRelFilter(null);
                              setRelOpen(false);
                            }}
                          >
                            All relations
                            {!relFilter && <Icon name="check" size={12} className="text-text-1" />}
                          </button>
                          {relationTypes.map((t) => (
                            <button
                              key={t.type}
                              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-surface-7"
                              onClick={() => {
                                setRelFilter(t.type);
                                setRelOpen(false);
                              }}
                            >
                              <span
                                className={cn(
                                  "truncate font-mono uppercase",
                                  relFilter === t.type ? "text-text-1" : "text-text-2",
                                )}
                              >
                                {t.type}
                              </span>
                              <span className="shrink-0 text-fg-4">{t.count}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    graphRef.current?.setShowNodeLabels(!showLabels);
                    setShowLabels((v) => !v);
                  }}
                  aria-pressed={showLabels}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-md border border-solid px-2.5 text-xs transition-colors",
                    showLabels
                      ? "border-accent-line text-text-1"
                      : "border-stroke-1 text-text-2 hover:text-text-1",
                  )}
                >
                  <Icon name={showLabels ? "check" : "plus"} size={11} />
                  Labels
                </button>

                <select
                  className="h-8 rounded-md border border-solid border-stroke-1 bg-surface-4 px-2 text-xs text-text-2 outline-none"
                  value={nodeLimit}
                  onChange={(e) => setNodeLimit(Number(e.target.value))}
                  title="Maximum nodes drawn on the canvas"
                  aria-label="Maximum nodes drawn on the canvas"
                >
                  <option value={200}>200 nodes</option>
                  <option value={500}>500 nodes</option>
                  <option value={1000}>1000 nodes</option>
                  <option value={5000}>5000 nodes</option>
                </select>

                <span className="ml-auto text-xs text-fg-4">
                  {totalRelations} relation{totalRelations === 1 ? "" : "s"}
                </span>
              </div>

              {/* Graph canvas with zoom controls (dashboard QueryPage pattern) */}
              <div className="relative h-[520px] overflow-hidden rounded-xl border border-solid border-stroke-1 bg-surface-1">
                <SourceGraph
                  relations={filteredTriplets ?? []}
                  isExpandedView
                  hideOverlayControls
                  controlRef={graphRef}
                  maxNodes={nodeLimit}
                />
                <div className="absolute bottom-4 right-4 z-20 flex flex-col gap-1 rounded-lg border border-solid border-stroke-1 bg-surface-4/90 p-1 shadow-xl backdrop-blur-sm">
                  <button
                    onClick={() => graphRef.current?.zoomIn()}
                    className="flex h-7 w-7 items-center justify-center rounded text-text-2 transition-colors hover:bg-surface-7 hover:text-text-1"
                    title="Zoom in"
                  >
                    <Icon name="plus" size={14} />
                  </button>
                  <button
                    onClick={() => graphRef.current?.zoomOut()}
                    className="flex h-7 w-7 items-center justify-center rounded text-text-2 transition-colors hover:bg-surface-7 hover:text-text-1"
                    title="Zoom out"
                  >
                    <Icon name="minus" size={14} />
                  </button>
                  <button
                    onClick={() => graphRef.current?.resetView()}
                    className="flex h-7 w-7 items-center justify-center rounded text-text-2 transition-colors hover:bg-surface-7 hover:text-text-1"
                    title="Reset view"
                  >
                    <Icon name="fit" size={13} />
                  </button>
                </div>
              </div>
            </div>

            {/* Selected triplet detail */}
            {selected ? (
              <div className="hidden w-[300px] shrink-0 lg:block">
                <div className="card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-1">
                        {selected.source.name}
                      </p>
                      <p className="mt-0.5 text-[11px] text-fg-4">
                        {selected.source.type}
                        {selected.relations?.[0]?.timestamp
                          ? ` · ${timeAgo(selected.relations[0].timestamp)}`
                          : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => setSelected(null)}
                      className="text-fg-4 transition-colors hover:text-fg"
                      aria-label="Close"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="rounded-md border border-solid border-stroke-1 bg-surface-2 px-2 py-1 text-text-2">
                      {selected.source.name}
                    </span>
                    <span className="rounded-md bg-accent-tint px-2 py-1 font-mono text-[10px] font-semibold uppercase text-text-1">
                      {selected.relations?.[0]?.canonical_predicate ?? "related"}
                    </span>
                    <span className="rounded-md border border-solid border-stroke-1 bg-surface-2 px-2 py-1 text-text-2">
                      {selected.target.name}
                    </span>
                  </div>
                  {selected.relations?.[0]?.context ? (
                    <p className="mt-3 text-xs leading-relaxed text-text-2">
                      {selected.relations[0].context}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}