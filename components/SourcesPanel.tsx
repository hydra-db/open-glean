"use client";

/**
 * SourcesPanel — web-app-style citations:
 *
 *  - Inline: a row of source cards (app logo, source name, reference-number
 *    badge matching the inline [1][2] citations in the answer).
 *  - "View all" opens the right-side vertical drawer (like the original
 *    web-app's VerticalSourceDrawer).
 *  - Clicking a source opens a preview modal with the full content (via
 *    /context/inspect — the chunk's source id derives from chunk id:
 *    source_id + "_chunk_" + index) and an "Open original" link when the
 *    backend returns a presigned URL.
 *  - Web-search citations render as cards too (globe + hostname + [W#]).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildCitationIndex } from "@/lib/citations";
import { readableBody } from "@/lib/readableBody";
import { cn, truncate } from "@/lib/utils";
import { Icon, Spinner } from "@/components/Icon";
import { ProviderLogo } from "@/components/ProviderLogo";
import { Modal } from "@/components/ui";
import { copyText } from "@/lib/utils";
import { useHydra } from "@/lib/api";
import type { SearchChunk, WebCitation } from "@/lib/types";

const INLINE_LIMIT = 4;

interface SourceGroup {
  key: string;
  ref: number;
  title: string;
  provider?: string;
  sourceId?: string;
  url?: string;
  uploaded?: string;
  type?: string;
  chunks: SearchChunk[];
  score?: number;
  /** Collection this source came from — required to inspect it. */
  collection?: string;
}

interface PreviewState {
  busy: boolean;
  title: string;
  provider?: string;
  /** The cited passages — what the answer's [n] actually points at. */
  excerpt: string;
  /** Full document body from /context/inspect, when it has one. */
  full?: string;
  /** Set only when there is genuinely nothing to show. */
  loadError?: boolean;
  originalUrl?: string;
}

/** Join a source's retrieved passages into the text the answer was grounded in. */
function chunkText(chunks: SearchChunk[]): string {
  return chunks
    .map((c) => (c.chunk_content ?? c.content ?? c.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n\u2026\n\n");
}

/** Human name for a connector id: "ms_teams" -> "MS Teams". */
function titleCaseId(p: string): string {
  return p
    .split(/[_-]/)
    .map((w) => (w === "ms" ? "MS" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Label for a source card's badge.
 *
 * Prefer the connector name (Slack, GitHub). With no connector, name the kind
 * of source (Memory, File, Webpage) instead of the generic "Context", so the
 * user can tell a saved memory from an uploaded file at a glance.
 */
function sourceLabel(provider?: string, type?: string): string {
  if (provider) return titleCaseId(provider);
  const kind = (type ?? "").toLowerCase();
  if (kind.includes("memory")) return "Memory";
  if (kind.includes("web") || kind.includes("url")) return "Webpage";
  if (kind.includes("file") || kind.includes("document") || kind.includes("pdf"))
    return "File";
  if (kind) return titleCaseId(kind);
  return "Context";
}

function hostname(u?: string): string {
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Open a citation URL in a new tab, but only http(s).
 *
 * Web citation URLs come from the model and from indexed content that other
 * people write. A javascript: or data: URL passed to window.open runs in the
 * current origin. Allow only http and https.
 */
function openExternal(u?: string): void {
  if (!u) return;
  try {
    const { protocol } = new URL(u);
    if (protocol !== "http:" && protocol !== "https:") return;
  } catch {
    return;
  }
  window.open(u, "_blank", "noopener");
}

export default function SourcesPanel({
  chunks = [],
  webCitations = [],
  defaultOpen = false,
  className = "",
  focusRef = null,
  onFocusHandled,
}: {
  chunks?: SearchChunk[];
  webCitations?: WebCitation[];
  defaultOpen?: boolean;
  className?: string;
  /**
   * Citation number to reveal, set when the user clicks a `[n]` marker in the
   * answer. Only the first four cards render inline, so a click on a higher
   * number has to open the drawer or the card is unreachable.
   */
  focusRef?: number | null;
  /** Called once the focus request has been acted on, so it can be cleared. */
  onFocusHandled?: () => void;
}) {
  const hydra = useHydra();
  const [drawerOpen, setDrawerOpen] = useState(defaultOpen);
  // The source cards are collapsed under the header by default, and shown when
  // the user clicks it. A clicked citation also expands them so the card exists.
  const [expanded, setExpanded] = useState(defaultOpen);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  /** Passage vs full-document view inside the preview modal. */
  const [showFull, setShowFull] = useState(false);
  // The passage is what the citation points at, so it is the default view;
  // `full` is only reachable when inspect returned something extra.
  const previewBody = preview
    ? (showFull && preview.full ? preview.full : preview.excerpt) ||
      preview.full ||
      ""
    : "";

  // One numbering for the whole answer, shared with the prompt (lib/citations).
  // The panel used to group and number here while lib/qa.ts numbered flat
  // chunks, so the model cited numbers the user had no card for.
  const index = useMemo(
    () => buildCitationIndex(chunks, webCitations),
    [chunks, webCitations],
  );
  const groups = useMemo<SourceGroup[]>(
    () =>
      index.entries
        .filter((e) => !e.web)
        .map((e) => ({
          key: e.key,
          ref: e.ref,
          title: e.title,
          provider: e.provider,
          sourceId: e.sourceId,
          url: e.url,
          uploaded: e.chunks[0]?.source_upload_time,
          type: e.chunks[0]?.source_type,
          collection: e.collection,
          chunks: e.chunks,
          score: e.score,
        })),
    [index],
  );

  const webRefs = useMemo(
    () =>
      index.entries
        .filter((e) => e.web)
        .map((e) => ({
          ...(webCitations.find((w) => w.url === e.url) ?? ({} as WebCitation)),
          url: e.url ?? "",
          title: e.title,
          ref: e.ref,
          web: true as const,
        })),
    [index, webCitations],
  );

  const total = groups.length + webRefs.length;

  const showDrawer = drawerOpen;

  // Reveal a card when the answer's `[n]` marker is clicked.
  //
  // Cards past the inline limit only exist inside the drawer, so open the
  // drawer through its own state. Deriving showDrawer from focusRef would close
  // the drawer the moment focusRef clears, tearing out the card mid-scroll.
  useEffect(() => {
    if (focusRef == null) return;
    // Reveal the cards so the target exists, then scroll and flash it.
    setExpanded(true);
    if (focusRef > INLINE_LIMIT) setDrawerOpen(true);
    // Let the cards paint before scrolling to the card.
    const timer = window.setTimeout(() => {
      // The same ref can exist twice (inline row + drawer). Cards past the
      // inline limit exist only in the drawer, so pick the last visible match
      // rather than the first, which would be a non-existent inline card.
      const matches = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-source-ref="${focusRef}"]`),
      ).filter((el) => el.offsetParent !== null);
      const card = matches[matches.length - 1] ?? null;
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      // Blink the card so a click on [n] lands somewhere the eye can follow.
      // Re-adding the class needs a reflow, or a second click on the same card
      // does nothing. Skipped under reduced motion, where the animation is off
      // and animationend would never fire to remove the listener.
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (card instanceof HTMLElement && !reduceMotion) {
        card.classList.remove("cite-flash");
        void card.offsetWidth;
        card.classList.add("cite-flash");
        card.addEventListener(
          "animationend",
          () => card.classList.remove("cite-flash"),
          { once: true },
        );
      }
      onFocusHandled?.();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [focusRef, onFocusHandled]);

  const openPreview = useCallback(
    async (g: SourceGroup) => {
      if (g.url) {
        openExternal(g.url);
        return;
      }
      // The retrieved chunks are the passages the answer actually cited, and
      // we already hold them — show them immediately instead of a spinner,
      // then try to enrich with the full document.
      const excerpt = chunkText(g.chunks);
      setShowFull(false);
      setPreview({
        busy: Boolean(g.sourceId),
        title: g.title,
        provider: g.provider,
        excerpt,
      });
      if (!g.sourceId) return;

      try {
        // /context/inspect is scope-checked: a multi-collection query returns
        // hits from several collections, so the source's own collection has to
        // be sent or the lookup 404s with FILE_NOT_FOUND.
        const data = (await hydra.inspect(g.sourceId, {
          ...(g.collection ? { collection: g.collection } : {}),
        })) as unknown as Record<string, unknown>;
        const inner =
          data?.data && typeof data.data === "object"
            ? (data.data as Record<string, unknown>)
            : data;
        const content = String(inner.content ?? data.content ?? "").trim();
        const originalUrl =
          (inner.presigned_url as string) ??
          (inner.url as string) ??
          (data.presigned_url as string) ??
          undefined;
        const full = readableBody(content);
        setPreview({
          busy: false,
          title: g.title,
          provider: g.provider,
          excerpt,
          // Only offer "full source" when it adds something beyond the passage.
          full: full && full !== excerpt ? full : undefined,
          originalUrl,
        });
      } catch {
        // Inspect is an enrichment, not the source of truth for this modal.
        setPreview({
          busy: false,
          title: g.title,
          provider: g.provider,
          excerpt,
          loadError: !excerpt,
        });
      }
    },
    [hydra],
  );

  if (total === 0) return null;

  const renderCard = (g: SourceGroup) => (
    <button
      key={g.key}
      type="button"
      // Scroll target for a `[n]` click in the answer.
      data-source-ref={g.ref}
      onClick={() => void openPreview(g)}
      title={g.title}
      className="flex w-[210px] shrink-0 flex-col justify-between gap-2 rounded-md border border-solid border-stroke-1 bg-surface-4 px-3 py-2.5 text-left transition-colors hover:bg-surface-7"
    >
      <span className="line-clamp-2 w-full text-xs text-text-1">
        {truncate(g.title, 90)}
      </span>
      <span className="flex w-full items-center gap-1.5 text-[11px] text-text-2">
        <ProviderLogo id={g.provider} size={14} />
        <span className="min-w-0 truncate">
          {sourceLabel(g.provider, g.type) || hostname(g.url) || "Source"}
        </span>
        <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-solid border-stroke-1 bg-surface-3 text-[10px] font-semibold text-text-1">
          {g.ref}
        </span>
      </span>
    </button>
  );

  const renderWebCard = (w: (typeof webRefs)[number]) => (
    <button
      key={w.ref}
      type="button"
      data-source-ref={w.ref}
      onClick={() => openExternal(w.url)}
      title={w.title ?? w.url}
      className="flex w-[210px] shrink-0 flex-col justify-between gap-2 rounded-md border border-solid border-stroke-1 bg-surface-4 px-3 py-2.5 text-left transition-colors hover:bg-surface-7"
    >
      <span className="line-clamp-2 w-full text-xs text-text-1">
        {truncate(w.title ?? w.url, 90)}
      </span>
      <span className="flex w-full items-center gap-1.5 text-[11px] text-text-2">
        <Icon name="globe" size={13} className="shrink-0 text-brand-1" />
        <span className="min-w-0 truncate">{hostname(w.url)}</span>
        <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-solid border-stroke-1 bg-surface-3 text-[10px] font-semibold text-text-1">
          {w.ref}
        </span>
      </span>
    </button>
  );

  const inlineGroups = groups.slice(0, INLINE_LIMIT);
  const inlineWeb = webRefs.slice(0, Math.max(0, INLINE_LIMIT - inlineGroups.length));
  const hiddenCount = total - inlineGroups.length - inlineWeb.length;

  return (
    <div className={cn("w-full", className)}>
      {/* Header — click to show or hide the source cards. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="group/src mb-1.5 flex w-full items-center gap-1.5 rounded-md text-left transition-colors hover:text-brand-1"
      >
        <Icon name="layers" size={14} className="text-brand-1" />
        <span className="text-xs font-medium text-text-1 group-hover/src:text-brand-1">
          {total} source{total === 1 ? "" : "s"}
        </span>
        <Icon
          name="chevDown"
          size={14}
          className={cn(
            "ml-auto text-text-2 transition-transform duration-200",
            expanded ? "rotate-180" : "rotate-0",
          )}
        />
      </button>

      {/* Inline cards, shown only when expanded. */}
      {expanded ? (
        <div className="flex gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible">
          {inlineGroups.map(renderCard)}
          {inlineWeb.map(renderWebCard)}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex w-[130px] shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-solid border-stroke-1 bg-surface-4 px-3 py-2.5 text-center transition-colors hover:bg-surface-7"
            >
              <Icon name="chev" size={14} className="text-text-2" />
              <span className="text-[11px] text-text-2">{hiddenCount} more</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Right-side vertical drawer (web-app VerticalSourceDrawer pattern) */}
      {showDrawer ? (
        <div className="fixed inset-0 z-[95]">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="animate-slideInRight absolute right-0 top-0 flex h-full w-full max-w-[340px] flex-col border-l border-solid border-stroke-1 bg-surface-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-solid border-stroke-1 px-4 py-3.5">
              <p className="flex items-center gap-1.5 text-sm font-medium text-text-1">
                <Icon name="layers" size={15} className="text-brand-1" />
                {/* These are retrieved sources — documents, connector records
                    and web results — not the memory bucket specifically. */}
                {total} {total === 1 ? "source" : "sources"}
              </p>
              <button
                onClick={() => setDrawerOpen(false)}
                className="rounded-md p-1.5 text-fg-4 transition-colors hover:bg-surface-7 hover:text-text-1"
                aria-label="Close"
              >
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {groups.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => {
                    setDrawerOpen(false);
                    void openPreview(g);
                  }}
                  className="flex min-h-[72px] w-full flex-col justify-center gap-1.5 rounded-md border border-solid border-stroke-1 bg-surface-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-7"
                >
                  <span className="line-clamp-2 text-xs text-text-1">
                    {truncate(g.title, 120)}
                  </span>
                  <span className="flex w-full items-center gap-1.5 text-[11px] text-text-2">
                    <ProviderLogo id={g.provider} size={14} />
                    <span className="min-w-0 truncate">
                      {sourceLabel(g.provider, g.type) || hostname(g.url) || "Source"}
                    </span>
                    <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-solid border-stroke-1 bg-surface-4 text-[10px] font-semibold text-text-1">
                      {g.ref}
                    </span>
                  </span>
                </button>
              ))}
              {webRefs.map((w) => (
                <button
                  key={w.ref}
                  type="button"
                  onClick={() => {
                    setDrawerOpen(false);
                    openExternal(w.url);
                  }}
                  className="flex min-h-[72px] w-full flex-col justify-center gap-1.5 rounded-md border border-solid border-stroke-1 bg-surface-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-7"
                >
                  <span className="line-clamp-2 text-xs text-text-1">
                    {truncate(w.title ?? w.url, 120)}
                  </span>
                  <span className="flex w-full items-center gap-1.5 text-[11px] text-text-2">
                    <Icon name="globe" size={13} className="shrink-0 text-brand-1" />
                    <span className="min-w-0 truncate">{hostname(w.url)}</span>
                    <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-solid border-stroke-1 bg-surface-4 text-[10px] font-semibold text-text-1">
                      {w.ref}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* Source preview modal (inspect → content + open original) */}
      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.title ?? ""}
        width={560}
        footer={
          <>
            {previewBody ? (
              <button className="btn-ghost" onClick={() => void copyText(previewBody)}>
                <Icon name="copy" size={13} /> Copy
              </button>
            ) : null}
            {preview?.originalUrl ? (
              <a
                className="btn-primary"
                href={preview.originalUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="external" size={13} /> Open original
              </a>
            ) : null}
          </>
        }
      >
        {preview ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-2">
              {preview.provider ? (
                <>
                  <ProviderLogo id={preview.provider} size={15} />
                  <span>{sourceLabel(preview.provider)}</span>
                  <span>·</span>
                </>
              ) : null}
              <span className="font-mono">
                {showFull ? "full source" : "cited passage"}
              </span>
              {preview.busy ? (
                <span className="ml-auto flex items-center gap-1.5">
                  <Spinner size={11} /> Loading full source…
                </span>
              ) : preview.full ? (
                <button
                  type="button"
                  onClick={() => setShowFull((v) => !v)}
                  className="ml-auto text-[11px] font-medium text-accent transition-colors hover:text-accent-2"
                >
                  {showFull ? "Show cited passage" : "Show full source"}
                </button>
              ) : null}
            </div>
            {/* break-words: connector bodies contain very long unbroken tokens
                (ids, URLs, JSON) that otherwise force horizontal scrolling. */}
            <p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-solid border-stroke-1 bg-surface-3 p-3 text-[13px] leading-relaxed text-text-2">
              {previewBody ||
                (preview.loadError
                  ? "This source could not be loaded, and the retrieval returned no passage text."
                  : "No content available.")}
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}