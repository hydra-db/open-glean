"use client";

/**
 * Chat top bar: back, the conversation title (click to rename), a status line,
 * and the conversation actions.
 *
 * The status line doubles as a progress cue: while an answer is being written
 * it says so, so the header reflects what the page is doing even when the
 * streaming answer is scrolled out of view.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/Icon";

const ICON_BTN =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-2 transition-colors hover:bg-white/[0.06] hover:text-text-1 disabled:pointer-events-none disabled:opacity-35";

export function ChatHeader({
  title,
  meta,
  running = false,
  loading = false,
  canCopy = false,
  onBack,
  onRename,
  onCopy,
  onNew,
  onDelete,
}: {
  title: string;
  /** Secondary line, e.g. "6 messages · just now". */
  meta?: string;
  running?: boolean;
  /** Skeleton state while the conversation loads. */
  loading?: boolean;
  canCopy?: boolean;
  onBack: () => void;
  onRename?: (title: string) => void;
  onCopy?: () => void;
  onNew?: () => void;
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startEdit = () => {
    setDraft(title);
    setEditing(true);
  };

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== title) onRename?.(next);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
    }
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-solid border-stroke-1 bg-[#0a0a0b]/85 px-2.5 backdrop-blur-md sm:gap-3 sm:px-4">
      <button type="button" onClick={onBack} className={ICON_BTN} title="Back to Ask" aria-label="Back to Ask">
        <Icon name="arrowRight" size={15} className="rotate-180" />
      </button>

      <div className="min-w-0 flex-1">
        {loading ? (
          <div className="flex flex-col gap-1.5">
            <div className="h-3.5 w-40 animate-pulse rounded bg-white/[0.06]" />
            <div className="h-2.5 w-24 animate-pulse rounded bg-white/[0.04]" />
          </div>
        ) : editing ? (
          <input
            ref={inputRef}
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
            aria-label="Conversation title"
            className="no-focus-ring -ml-1.5 h-7 w-full max-w-[420px] rounded-md border border-solid border-stroke-3 bg-white/[0.04] px-1.5 font-pixel text-[15px] text-text-3 outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onRename ? startEdit : undefined}
            disabled={!onRename}
            className="group/title -ml-1.5 flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-left transition-colors enabled:hover:bg-white/[0.04]"
            title={onRename ? "Rename conversation" : undefined}
          >
            <span className="truncate font-pixel text-[15px] text-text-3">{title}</span>
            {onRename ? (
              <Icon
                name="edit"
                size={12}
                className="shrink-0 text-text-2 opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100"
              />
            ) : null}
          </button>
        )}
        {!loading && !editing ? (
          <p className="flex h-4 items-center gap-1.5 truncate text-[11.5px] text-fg-4" aria-live="polite">
            {running ? (
              <>
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-text-1" />
                Writing answer…
              </>
            ) : (
              meta
            )}
          </p>
        ) : null}
      </div>

      {!loading ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onCopy}
            disabled={!canCopy}
            className={ICON_BTN}
            title="Copy last answer"
            aria-label="Copy last answer"
          >
            <Icon name="copy" size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className={cn(ICON_BTN, "hover:bg-bad-fill hover:text-bad")}
            title="Delete conversation"
            aria-label="Delete conversation"
          >
            <Icon name="trash" size={14} />
          </button>
          <span aria-hidden className="mx-1.5 h-5 w-px bg-stroke-1" />
          <button
            type="button"
            onClick={onNew}
            className="flex h-8 items-center gap-1.5 rounded-full border border-solid border-stroke-1 px-2.5 text-xs font-medium text-text-1 transition-colors hover:border-stroke-3 hover:bg-white/[0.06] sm:px-3"
            title="New chat"
            aria-label="New chat"
          >
            <Icon name="plus" size={13} />
            <span className="hidden sm:inline">New chat</span>
          </button>
        </div>
      ) : null}
    </header>
  );
}
