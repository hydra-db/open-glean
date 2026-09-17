"use client";

/**
 * The home composer — clean search interface:
 * - Web toggle · Fast/Deep (thinking) toggle · metadata Filters panel
 * - Auto-growing textarea, suggestion chips
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useAppConfig } from "@/lib/store/config";
import { useHydra } from "@/lib/api";
import { hasLlm } from "@/lib/qa";
import {
  MODE_META,
  MODE_ORDER,
  readStoredMode,
  storeMode,
  type ChatMode,
} from "@/lib/chatMode";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/ui";

const SUGGESTIONS = [
  "What did I work on last week?",
  "Summarize the Q3 planning doc",
  "Who mentioned budgets in Slack?",
];

const GREETINGS = [
  "Ask your second brain",
  "What do you want to know?",
  "Ask away",
  "What are you looking for?",
  "Pick up where you left off",
  "Search everything you know",
  "Your notes, one question away",
  "What can I find for you?",
];

const MAX_ROWS = 5;

const WEB_KEY = "open-glean.webSearch";
/** Pre-rebrand key — migrated once on read. */

function readWebSearch(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(WEB_KEY);
    return v === null ? true : v !== "0";
  } catch {
    return true;
  }
}

function readMode(): ChatMode {
  return readStoredMode();
}

/** Inline warning when no LLM provider is configured. */
export function LlmMissingNotice({ className = "" }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-warn/40 bg-warn-fill px-3.5 py-2.5",
        className,
      )}
    >
      <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-warn" />
      <p className="text-[12.5px] leading-snug text-fg-2">
        Search works now. To get written answers,{" "}
        <Link
          href="/settings"
          className="font-medium text-accent transition-colors hover:text-accent-2 hover:underline"
        >
          add a model in Settings
        </Link>
        .
      </p>
    </div>
  );
}

/** The greeting headline. One line is picked per page load and stays put. */
export function Greeting({ className = "" }: { className?: string }) {
  // Pick the line once, after mount. The headline is invisible until then, so
  // the user never sees line 0 swap to the chosen line. It varies on refresh
  // and never changes while the page sits. The space is reserved either way, so
  // the composer below does not jump when the text appears.
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => {
    setIndex(Math.floor(Math.random() * GREETINGS.length));
  }, []);
  return (
    <h1
      className={cn(
        "text-center font-semibold tracking-tight text-text-1 text-balance",
        "text-[1.625rem] leading-tight sm:text-[2rem] md:text-[2.5rem]",
        "transition-opacity duration-200",
        index === null ? "opacity-0" : "opacity-100",
        className,
      )}
    >
      {/* Non-breaking space holds the line height before the text is chosen. */}
      {index === null ? " " : GREETINGS[index]!}
    </h1>
  );
}

export interface MetaFilterRow {
  key: string;
  value: string;
}

export interface AskSubmitOpts {
  webSearch: boolean;
  mode: ChatMode;
  metadataFilters?: Record<string, unknown>;
}

export default function AskSearchBar({
  initialQuery = "",
  disabled = false,
  onSubmit,
}: {
  initialQuery?: string;
  disabled?: boolean;
  onSubmit: (query: string, opts: AskSubmitOpts) => void;
}) {
  const { config } = useAppConfig();
  const hydra = useHydra();
  const [query, setQuery] = useState(initialQuery);
  // Whether the active scope has any context. Undefined until checked, so the
  // hint does not flash before we know. Only shown when the scope is genuinely
  // empty, to nudge the user to add context for better answers.
  const [contextEmpty, setContextEmpty] = useState<boolean | undefined>(undefined);
  // Read the persisted toggles in the initializer, so the first client render
  // already has the right values. Correcting them in an effect made Web flash
  // orange then fade off, and the mode indicator slide in from the left,
  // because the transition was live when the value changed. The readers guard
  // `typeof window`, so the server render still gets the defaults.
  const [webSearch, setWebSearch] = useState(readWebSearch);
  const [mode, setMode] = useState<ChatMode>(readMode);
  const [filtersModal, setFiltersModal] = useState(false);
  const [filterRows, setFilterRows] = useState<MetaFilterRow[]>([{ key: "", value: "" }]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const llmMissing = !hasLlm(config);

  // `synced` gates the transitions on until after the first paint, so the
  // indicator's first placement is instant and only later changes animate.
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    setSynced(true);
  }, []);

  // Check whether the active scope has any context, so we can nudge the user to
  // add some. Cheap: one memory and one knowledge row is enough to know.
  const scopeDb = config.database;
  useEffect(() => {
    let alive = true;
    setContextEmpty(undefined);
    // Only nudge when both lists succeed and are genuinely empty. A failed
    // request must NOT count as empty, or a transient error would tell a user
    // who has context that they have none.
    Promise.all([
      hydra.listMemories({ pageSize: 1 }),
      hydra.listKnowledge({ pageSize: 1 }),
    ])
      .then(([mem, know]) => {
        if (!alive) return;
        const count = (r: { total?: number; count?: number; sources?: unknown[] }) =>
          r.total ?? r.count ?? r.sources?.length ?? 0;
        setContextEmpty(count(mem) === 0 && count(know) === 0);
      })
      .catch(() => {
        if (alive) setContextEmpty(false);
      });
    return () => {
      alive = false;
    };
  }, [hydra, scopeDb]);

  const activeFilterCount = filterRows.filter((r) => r.key.trim()).length;

  const buildFilters = useCallback((): Record<string, unknown> | undefined => {
    const entries = filterRows
      .filter((r) => r.key.trim())
      .map((r) => [r.key.trim(), r.value.trim()]);
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }, [filterRows]);

  const toggleWeb = useCallback(() => {
    setWebSearch((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(WEB_KEY, next ? "1" : "0");
      } catch {
        // best-effort
      }
      return next;
    });
  }, []);

  const pickMode = useCallback((m: ChatMode) => {
    setMode(m);
    storeMode(m);
  }, []);

  // Arrow-key navigation for the mode radiogroup (WAI-ARIA radio pattern):
  // Left/Up go back, Right/Down go forward, Home/End jump to the ends, and the
  // moved-to radio takes focus and selection.
  const onModeKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const i = MODE_ORDER.indexOf(mode);
      let next = i;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % MODE_ORDER.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
        next = (i - 1 + MODE_ORDER.length) % MODE_ORDER.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = MODE_ORDER.length - 1;
      else return;
      e.preventDefault();
      const m = MODE_ORDER[next]!;
      pickMode(m);
      modeBtnRefs.current[m]?.focus();
    },
    [mode, pickMode],
  );

  // Slide the mode indicator to the selected segment. The segments size to
  // their labels (Fast is short, Research is long), so measure the active
  // button and match it rather than forcing equal widths.
  //
  // `ready` gates the CSS transition: the first measurement places the
  // indicator with no animation, so it appears already under the selected mode
  // instead of sliding in from the left on load. Later changes animate.
  const modeBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [modeInd, setModeInd] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });
  // `indReady` turns the transition on only after the indicator has been placed
  // once, so it does not slide in from the left on load. It flips true one
  // commit after the first measurement, then stays true for later mode changes.
  const [indReady, setIndReady] = useState(false);
  const measureMode = useCallback(() => {
    const el = modeBtnRefs.current[mode];
    if (el) setModeInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [mode]);
  useEffect(() => {
    measureMode();
    // Re-measure after the web font loads and on resize: Inter swaps in after
    // first paint (font-display: swap) and changes the label widths, so a
    // measure taken in the fallback font would leave the indicator misaligned.
    const onResize = () => measureMode();
    window.addEventListener("resize", onResize);
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) measureMode();
    });
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
    };
  }, [measureMode]);
  useEffect(() => {
    if (modeInd.width > 0 && !indReady) setIndReady(true);
  }, [modeInd.width, indReady]);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const target = Math.min(Math.max(el.scrollHeight, 44), 44 + (MAX_ROWS - 1) * 22);
    el.style.height = `${target}px`;
  }, []);

  useEffect(() => {
    autoGrow();
  }, [query, autoGrow]);

  const submit = useCallback(() => {
    const q = query.trim();
    if (!q || disabled) return;
    onSubmit(q, {
      webSearch,
      mode,
      metadataFilters: buildFilters(),
    });
  }, [query, webSearch, mode, buildFilters, disabled, onSubmit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="w-full">
      <Greeting className="mb-5 md:mb-6" />

      <div
        className={cn(
          "relative isolate flex flex-col rounded-xl border border-solid border-stroke-1 bg-surface-2 shadow-2xl shadow-black/40 transition-all",
          "focus-within:border-brand-1 focus-within:ring-4 focus-within:ring-accent-ring",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder="Ask anything from your second brain…"
          aria-label="Ask Open Glean"
          className="no-focus-ring block w-full min-h-[56px] flex-1 resize-none bg-transparent px-4 pb-2 pt-3.5 text-sm text-text-1 outline-none placeholder:text-text-2 md:text-md"
        />

        {/* Footer: toggles + submit */}
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pt-1">
          <button
            type="button"
            onClick={toggleWeb}
            aria-pressed={webSearch}
            className={cn(
              "flex h-[34px] items-center gap-1.5 rounded-full border border-solid px-3 text-xs font-medium",
              synced && "transition-all",
              webSearch
                ? "border-brand-1 bg-accent-tint text-accent-on-tint"
                : "border-stroke-1 bg-surface-3 text-text-2 hover:text-text-1",
            )}
            title={webSearch ? "Web search on. Answers can cite live results." : "Web search off"}
          >
            <Icon name="globe" size={12} />
            Web
          </button>

          {/* Divider so the Web toggle does not read as part of the mode group,
              since both use the same orange active fill. */}
          <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-stroke-1" />

          {/* Segmented control. All three modes are visible, and one orange
              indicator slides to the selected mode. */}
          <div
            role="radiogroup"
            aria-label="Answer depth"
            onKeyDown={onModeKey}
            className="relative flex h-[34px] items-center rounded-full border border-solid border-stroke-1 bg-surface-3"
          >
            {/* The sliding highlight, measured to the active segment. It fills
                the full height, so the selected mode reads at the same weight as
                the Web pill next to it. Hidden until measured. */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-0 rounded-full border border-solid border-brand-1 bg-accent-tint ease-out",
                modeInd.width === 0 ? "opacity-0" : "opacity-100",
                indReady && "transition-all duration-200",
              )}
              style={{ left: modeInd.left, width: modeInd.width }}
            />
            {MODE_ORDER.map((m) => (
              <button
                key={m}
                ref={(el) => {
                  modeBtnRefs.current[m] = el;
                }}
                type="button"
                role="radio"
                aria-checked={mode === m}
                // Roving tabindex: only the selected radio is in the tab order;
                // arrow keys move between them.
                tabIndex={mode === m ? 0 : -1}
                onClick={() => pickMode(m)}
                title={MODE_META[m].title}
                className={cn(
                  "relative z-10 flex h-full items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
                  mode === m ? "text-accent-on-tint" : "text-text-2 hover:text-text-1",
                )}
              >
                <Icon name={MODE_META[m].icon} size={12} />
                {MODE_META[m].label}
              </button>
            ))}
          </div>

          {/* Divider between the mode group and Filters, matching the one after
              the Web toggle. */}
          <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-stroke-1" />

          <button
            type="button"
            onClick={() => setFiltersModal(true)}
            aria-haspopup="dialog"
            className={cn(
              "flex h-[34px] items-center gap-1.5 rounded-full border border-solid px-3 text-xs font-medium transition-all",
              activeFilterCount > 0
                ? "border-brand-1 bg-accent-tint text-accent-on-tint"
                : "border-stroke-1 bg-surface-3 text-text-2 hover:text-text-1",
            )}
            title="Filter by exact-match metadata key / value pairs"
          >
            <Icon name="filter" size={12} />
            Filters
            {activeFilterCount > 0 ? (
              <span className="rounded-full bg-brand-1 px-1.5 text-[10px] font-semibold text-white">
                {activeFilterCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={submit}
            disabled={disabled || !query.trim()}
            className="btn-primary ml-auto"
          >
            <Icon name="arrowRight" size={13} />
            Ask
          </button>
        </div>
      </div>

      {/* Suggested prompts */}
      <div className="mt-3.5 flex flex-wrap items-center justify-center gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setQuery(s);
              textareaRef.current?.focus();
            }}
            className="max-w-full truncate rounded-full border border-solid border-stroke-1 bg-surface-4 px-3 py-1 text-[11.5px] text-text-2 transition-colors hover:border-brand-1 hover:text-text-1"
          >
            {s}
          </button>
        ))}
      </div>

      {llmMissing ? (
        <LlmMissingNotice className="mt-3.5 animate-fadeIn" />
      ) : null}

      {contextEmpty ? (
        <div className="mt-3.5 flex animate-fadeIn items-start gap-2.5 rounded-md border border-solid border-stroke-1 bg-surface-4 px-3.5 py-2.5">
          <Icon name="info" size={15} className="mt-0.5 shrink-0 text-text-2" />
          <p className="text-[12.5px] leading-snug text-fg-2">
            You have not added any context yet. Answers are better with your own
            notes and files.{" "}
            <Link
              href="/context?add=1"
              className="font-medium text-accent transition-colors hover:text-accent-2 hover:underline"
            >
              Add context
            </Link>
            .
          </p>
        </div>
      ) : null}

      {/* Metadata filters modal (dashboard-2.0 key/value rows) */}
      <Modal
        open={filtersModal}
        onClose={() => setFiltersModal(false)}
        title="Metadata filters"
        width={440}
        footer={
          <>
            <button
              className="btn-ghost"
              onClick={() => setFilterRows([{ key: "", value: "" }])}
            >
              Clear all
            </button>
            <button className="btn-primary" onClick={() => setFiltersModal(false)}>
              <Icon name="check" size={13} />
              Apply
            </button>
          </>
        }
      >
        <p className="mb-3 text-xs text-text-2">
          Exact-match key / value pairs scoped to your stored metadata (e.g.{" "}
          <span className="font-mono text-brand-1">provider: jira</span>).
        </p>
        <div className="flex flex-col gap-1.5">
          {filterRows.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                className="input !h-9 flex-1 font-mono !text-xs"
                placeholder="key"
                value={row.key}
                spellCheck={false}
                onChange={(e) =>
                  setFilterRows((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)),
                  )
                }
              />
              <input
                className="input !h-9 flex-1 font-mono !text-xs"
                placeholder="value"
                value={row.value}
                spellCheck={false}
                onChange={(e) =>
                  setFilterRows((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                  )
                }
              />
              <button
                type="button"
                onClick={() =>
                  setFilterRows((rows) =>
                    rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ key: "", value: "" }],
                  )
                }
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-fg-4 transition-colors hover:bg-surface-7 hover:text-error-1"
                title="Remove filter"
                aria-label="Remove filter"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setFilterRows((rows) => [...rows, { key: "", value: "" }])}
          className="mt-2.5 flex items-center gap-1 text-xs text-text-2 transition-colors hover:text-brand-1"
        >
          <Icon name="plus" size={12} /> Add filter
        </button>
      </Modal>
    </div>
  );
}
