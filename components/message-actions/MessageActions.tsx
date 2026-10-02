"use client";

/**
 * Actions under a finished answer: rate, copy, reply, a "more" menu, and the
 * time it was written. Tooltips are one shared bubble that glides between
 * buttons rather than one per button.
 *
 * The component owns presentation only. Every action is a callback, and a menu
 * item appears only when its handler is passed, so nothing renders that the
 * page cannot actually do.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { messageActionIcons, type MessageActionIcons } from "./icons";
import styles from "./MessageActions.module.css";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

type CueApi = {
  aim: (anchor: HTMLElement, label: string) => void;
  hide: () => void;
};

const CueContext = createContext<CueApi | null>(null);

function Cue({
  label,
  children,
  quiet = false,
}: {
  label: string;
  children: ReactNode;
  quiet?: boolean;
}) {
  const cue = useContext(CueContext);
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !cue) return;
    const hot = node.matches(":hover") || node.contains(document.activeElement);
    if (!hot) return;
    if (quiet) cue.hide();
    else cue.aim(node, label);
  }, [cue, label, quiet]);

  return (
    <span
      ref={ref}
      className={styles.hit}
      onMouseEnter={(event) => {
        if (quiet) return;
        cue?.aim(event.currentTarget, label);
      }}
      onFocus={(event) => {
        if (quiet) return;
        cue?.aim(event.currentTarget, label);
      }}
    >
      {children}
    </span>
  );
}

function RowCues({ children }: { children: ReactNode }) {
  const tipId = useId();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const gaugeRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const labelRef = useRef("");
  const openRef = useRef(false);
  const describedRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [tipTheme, setTipTheme] = useState<"light" | "dark">("light");

  useEffect(() => setMounted(true), []);

  const write = (bubble: HTMLDivElement, x: number, y: number, width: number) => {
    bubble.style.setProperty("--cue-x", `${x}px`);
    bubble.style.setProperty("--cue-y", `${y}px`);
    bubble.style.setProperty("--cue-w", `${width}px`);
  };

  const measure = (anchor: HTMLElement, next: string) => {
    const bubble = bubbleRef.current;
    const gauge = gaugeRef.current;
    if (!bubble || !gauge) return null;
    gauge.textContent = next;
    const host = (anchor.querySelector("button, time") as HTMLElement | null) ?? anchor;
    const rect = host.getBoundingClientRect();
    const width = Math.ceil(gauge.offsetWidth + 10);
    const height = Math.ceil(gauge.offsetHeight + 8);
    return {
      host,
      x: Math.round(rect.left + rect.width / 2 - width / 2),
      y: Math.round(rect.top - height - 6),
      width,
    };
  };

  const place = useCallback(
    (anchor: HTMLElement, next: string, reveal: boolean) => {
      const bubble = bubbleRef.current;
      const spot = measure(anchor, next);
      if (!bubble || !spot) return;
      const arriving = reveal && !openRef.current;
      if (arriving) {
        bubble.dataset.hold = "true";
        write(bubble, spot.x, spot.y, spot.width);
        void bubble.offsetWidth;
        delete bubble.dataset.hold;
        openRef.current = true;
        setOpen(true);
      } else if (openRef.current) {
        write(bubble, spot.x, spot.y, spot.width);
      }
      if (describedRef.current && describedRef.current !== spot.host) {
        describedRef.current.removeAttribute("aria-describedby");
      }
      spot.host.setAttribute("aria-describedby", tipId);
      describedRef.current = spot.host;
      const from = anchor.closest("[data-theme]")?.getAttribute("data-theme");
      setTipTheme(from === "dark" ? "dark" : "light");
      setLabel((current) => (current === next ? current : next));
    },
    [tipId],
  );

  const aim = useCallback(
    (anchor: HTMLElement, next: string) => {
      anchorRef.current = anchor;
      labelRef.current = next;
      place(anchor, next, true);
    },
    [place],
  );

  const hide = useCallback(() => {
    openRef.current = false;
    anchorRef.current = null;
    describedRef.current?.removeAttribute("aria-describedby");
    describedRef.current = null;
    setOpen(false);
  }, []);

  useIsoLayoutEffect(() => {
    if (!open) return;
    const follow = () => {
      const anchor = anchorRef.current;
      const bubble = bubbleRef.current;
      if (!anchor || !bubble || !openRef.current) return;
      const spot = measure(anchor, labelRef.current);
      if (!spot) return;
      bubble.dataset.hold = "true";
      write(bubble, spot.x, spot.y, spot.width);
      void bubble.offsetWidth;
      delete bubble.dataset.hold;
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);

  const api = useMemo<CueApi>(() => ({ aim, hide }), [aim, hide]);

  return (
    <CueContext.Provider value={api}>
      {children}
      {mounted
        ? createPortal(
            <>
              <span ref={gaugeRef} className={styles.tipGauge} aria-hidden="true" />
              <div
                ref={bubbleRef}
                id={tipId}
                role="tooltip"
                data-theme={tipTheme}
                data-up={open ? "true" : undefined}
                className={styles.tip}
                aria-hidden={open ? undefined : true}
              >
                {label}
              </div>
            </>,
            document.body,
          )
        : null}
    </CueContext.Provider>
  );
}

function CueRoot({
  rootRef,
  children,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const cue = useContext(CueContext);
  return (
    <div
      ref={rootRef}
      className={styles.root}
      onMouseLeave={() => cue?.hide()}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        cue?.hide();
      }}
    >
      {children}
    </div>
  );
}

export type Vote = "up" | "down" | null;

const ROLL_MS = 400;

function elapsedMinutes(date: Date, now: number) {
  return Math.max(0, Math.round((now - date.getTime()) / 60000));
}

function formatAgo(date: Date, now = Date.now()) {
  const minutes = elapsedMinutes(date, now);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function MinuteRoll({ value }: { value: string }) {
  const prevRef = useRef(value);
  const [oldVal, setOldVal] = useState(value);
  const [newVal, setNewVal] = useState(value);
  const [rolling, setRolling] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [dir, setDir] = useState<"up" | "down">("up");

  useEffect(() => {
    if (prevRef.current === value) return;
    const from = prevRef.current;
    prevRef.current = value;
    const fromN = parseInt(from, 10);
    const toN = parseInt(value, 10);
    setDir(Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? "down" : "up");
    setOldVal(from);
    setNewVal(value);
    setRolling(true);
    setShifted(false);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true));
    });
    const done = window.setTimeout(() => {
      setRolling(false);
      setOldVal(value);
      setShifted(false);
    }, ROLL_MS);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(done);
    };
  }, [value]);

  const chars = rolling ? newVal : oldVal;

  return (
    <span className={styles.minRolls}>
      {Array.from({ length: chars.length }, (_, i) => {
        const previous = oldVal[i] ?? "";
        const next = chars[i] ?? "";
        if (!rolling || previous === next) {
          return (
            <span key={`${i}-${next}`} className={styles.minStatic}>
              {next}
            </span>
          );
        }
        const top = dir === "down" ? next : previous;
        const bottom = dir === "down" ? previous : next;
        return (
          <span key={`${i}-${previous}-${next}-${dir}`} className={styles.minRoll}>
            <span
              className={styles.minRollInner}
              data-dir={dir}
              data-shifted={shifted ? "true" : undefined}
            >
              <span>{top}</span>
              <span>{bottom}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

function formatAbsolute(date: Date) {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MessageActions({
  text,
  sentAt,
  initialVote = null,
  showVotes = true,
  reading = false,
  onCopy,
  onVote,
  onReply,
  onAgain,
  onAloud,
  onFork,
  onReport,
  icons,
}: {
  /** The text the copy button puts on the clipboard. */
  text: string;
  sentAt: Date;
  /** A rating already recorded for this message. */
  initialVote?: Vote;
  /** Hide the rating buttons when there is nothing to rate against. */
  showVotes?: boolean;
  /** Whether this message is being read aloud right now. */
  reading?: boolean;
  /** Replaces the built-in clipboard write, e.g. to report success. */
  onCopy?: (text: string) => void;
  onVote?: (vote: Vote) => void;
  onReply?: () => void;
  onAgain?: () => void;
  onAloud?: () => void;
  onFork?: () => void;
  onReport?: () => void;
  icons?: Partial<MessageActionIcons>;
}) {
  const [vote, setVote] = useState<Vote>(initialVote);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [upN, setUpN] = useState(0);
  const [downN, setDownN] = useState(0);
  const [replyN, setReplyN] = useState(0);
  const icon = { ...messageActionIcons, ...icons };
  const Good = icon.good;
  const Bad = icon.bad;
  const Copy = icon.copy;
  const Copied = icon.copied;
  const Reply = icon.reply;
  const More = icon.more;
  const Again = icon.again;
  const Aloud = icon.aloud;
  const Fork = icon.fork;
  const Report = icon.report;
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [now, setNow] = useState(() => Date.now());

  // A rating recorded elsewhere (another tab, or the feedback dialog) wins.
  const [seenVote, setSeenVote] = useState<Vote>(initialVote);
  if (seenVote !== initialVote) {
    setSeenVote(initialVote);
    setVote(initialVote);
  }

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 900);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const choose = (next: Vote) => {
    const value = vote === next ? null : next;
    setVote(value);
    onVote?.(value);
    if (next === "up") setUpN((n) => n + 1);
    if (next === "down") setDownN((n) => n + 1);
  };

  const copy = async () => {
    if (onCopy) {
      onCopy(text);
    } else {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* the drawn check still confirms the click */
      }
    }
    setCopied(true);
  };

  const reply = () => {
    setReplyN((n) => n + 1);
    setMenuOpen(false);
    onReply?.();
  };

  const runMenu = (action?: () => void) => {
    setMenuOpen(false);
    action?.();
  };

  const hasMenu = Boolean(onAgain || onAloud || onFork || onReport);
  const minutes = elapsedMinutes(sentAt, now);

  return (
    <RowCues>
      <CueRoot rootRef={rootRef}>
        {showVotes ? (
          <>
            <Cue label="Good response">
              <button
                type="button"
                className={styles.btn}
                data-on={vote === "up"}
                aria-pressed={vote === "up"}
                aria-label="Good response"
                onClick={() => choose("up")}
              >
                <Good
                  key={upN}
                  className={`${styles.glyph} ${styles.voteUp} ${upN ? styles.bumpUp : ""}`}
                  size={12}
                />
              </button>
            </Cue>

            <Cue label="Bad response">
              <button
                type="button"
                className={styles.btn}
                data-on={vote === "down"}
                aria-pressed={vote === "down"}
                aria-label="Bad response"
                onClick={() => choose("down")}
              >
                <Bad
                  key={downN}
                  className={`${styles.glyph} ${styles.glyphDown} ${styles.voteDown} ${downN ? styles.bumpDown : ""}`}
                  size={12}
                />
              </button>
            </Cue>
          </>
        ) : null}

        <Cue label={copied ? "Copied" : "Copy message"}>
          <button
            type="button"
            className={styles.btn}
            aria-label={copied ? "Copied" : "Copy message"}
            onClick={copy}
          >
            <span className={styles.copySwap} data-on={copied ? "true" : "false"}>
              <Copy className={`${styles.glyph} ${styles.copyMark}`} size={12} />
              <Copied className={`${styles.glyph} ${styles.check}`} size={12} />
            </span>
          </button>
        </Cue>

        {onReply ? (
          <Cue label="Reply">
            <button type="button" className={styles.btn} aria-label="Reply" onClick={reply}>
              <Reply
                key={replyN}
                className={`${styles.glyph} ${styles.reply} ${replyN ? styles.replyPlay : ""}`}
                size={12}
              />
            </button>
          </Cue>
        ) : null}

        {hasMenu ? (
          <span className={styles.slot}>
            <Cue label="More actions" quiet={menuOpen}>
              <button
                type="button"
                className={styles.btn}
                data-on={menuOpen}
                aria-expanded={menuOpen}
                aria-controls={menuId}
                aria-haspopup="menu"
                aria-label="More actions"
                onClick={() => setMenuOpen((open) => !open)}
              >
                <More className={styles.glyph} size={12} />
              </button>
            </Cue>
            {menuOpen ? (
              <div id={menuId} className={styles.menu} role="menu">
                {onAgain ? (
                  <button type="button" className={styles.item} role="menuitem" onClick={() => runMenu(onAgain)}>
                    <Again size={12} />
                    Ask again
                  </button>
                ) : null}
                {onAloud ? (
                  <button type="button" className={styles.item} role="menuitem" onClick={() => runMenu(onAloud)}>
                    <Aloud size={12} />
                    {reading ? "Stop reading" : "Read aloud"}
                  </button>
                ) : null}
                {onFork ? (
                  <button type="button" className={styles.item} role="menuitem" onClick={() => runMenu(onFork)}>
                    <Fork size={12} />
                    Fork chat
                  </button>
                ) : null}
                {onReport ? (
                  <>
                    <div className={styles.rule} role="separator" />
                    <button
                      type="button"
                      className={`${styles.item} ${styles.danger}`}
                      role="menuitem"
                      onClick={() => runMenu(onReport)}
                    >
                      <Report size={12} />
                      Report
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </span>
        ) : null}

        <Cue label={formatAbsolute(sentAt)}>
          <time className={styles.ago} dateTime={sentAt.toISOString()}>
            {minutes >= 1 && minutes < 60 ? (
              <>
                <MinuteRoll value={String(minutes)} />m ago
              </>
            ) : (
              formatAgo(sentAt, now)
            )}
          </time>
        </Cue>
      </CueRoot>
    </RowCues>
  );
}
