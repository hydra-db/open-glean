"use client";

/** Shared UI primitives — Logo, Modal, Dropdown, Avatar, EmptyState, etc. */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn, initials, avatarHue } from "@/lib/utils";
import { Icon } from "@/components/Icon";

// ── Logo ──────────────────────────────────────────────────────────

export function BrandLogo({
  size = 112,
  dark = false,
  className = "",
}: {
  size?: number;
  dark?: boolean;
  className?: string;
}) {
  return (
    <img
      src={dark ? "/static/images/logos/hydradb-black.png" : "/static/images/logos/hydradb-white.png"}
      alt="Hydra DB"
      width={size}
      height={size}
      className={cn("object-contain", className)}
    />
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return <span className={cn("font-sans font-bold tracking-tight", className)}>Open Glean</span>;
}

// ── Avatar ────────────────────────────────────────────────────────

export function Avatar({
  name,
  size = 28,
  className = "",
}: {
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const hue = avatarHue(name ?? "?");
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full font-semibold text-white select-none",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(135deg, hsl(${hue} 55% 45%), hsl(${(hue + 40) % 360} 55% 32%))`,
      }}
    >
      {initials(name)}
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 480,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    // Remember what had focus so it can be restored when the dialog closes.
    const opener = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    // Move focus into the dialog so the keyboard user is not left behind it.
    const first = focusables()[0];
    (first ?? dialogRef.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Trap Tab inside the dialog: wrap from last to first and back.
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      // Restore focus to whatever opened the dialog.
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fadeIn"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="animate-slideUp w-full max-h-[85vh] overflow-y-auto rounded-md border border-line bg-bg-elev shadow-2xl outline-none"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : "Dialog"}
      >
        {title ? (
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 id={titleId} className="text-[14px] font-semibold text-fg">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="text-fg-4 hover:text-fg rounded p-1 -mr-1"
              aria-label="Close"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        ) : null}
        <div className="px-4 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Delete",
  danger = true,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={380}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-fg-2 leading-relaxed">{message}</p>
    </Modal>
  );
}

// ── Dropdown ──────────────────────────────────────────────────────

export function Dropdown({
  trigger,
  children,
  align = "left",
  width = 200,
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-block" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open ? (
        <div
          className={cn(
            "animate-fadeIn absolute z-[80] mt-1.5 rounded-md border border-line bg-bg-elev shadow-xl overflow-hidden",
            align === "right" ? "right-0" : "left-0",
          )}
          style={{ width }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
  close,
}: {
  icon?: string;
  label: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  close: () => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors",
        danger ? "text-bad hover:bg-bad-fill" : "text-fg-2 hover:bg-bg-3 hover:text-fg",
      )}
      onClick={() => {
        close();
        onClick?.();
      }}
    >
      {icon ? <Icon name={icon} size={14} className="shrink-0" /> : null}
      <span className="truncate">{label}</span>
    </button>
  );
}

// ── Field / Switch / EmptyState ───────────────────────────────────

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-fg-2">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-fg-4">{hint}</span> : null}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[20px] w-[36px] rounded-full transition-colors shrink-0",
        checked ? "bg-accent" : "bg-inset",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] left-[2px] h-4 w-4 rounded-full bg-white shadow transition-transform",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}

export function EmptyState({
  icon = "search",
  title,
  message,
  action,
  className = "",
}: {
  icon?: string;
  title: string;
  message?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-16 text-center px-6", className)}>
      {/* Medallion: the icon sits in a soft ring with a faint accent glow, so an
          empty page reads as a designed state, not a missing one. */}
      <div className="relative mb-4">
        <div
          aria-hidden
          className="absolute inset-0 -m-3 rounded-full bg-accent/[0.06] blur-xl"
        />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-xl border border-solid border-stroke-2 bg-surface-4 text-fg-3 shadow-inner shadow-black/20">
          <Icon name={icon} size={22} />
        </div>
      </div>
      <p className="text-[14px] font-semibold text-fg">{title}</p>
      {message ? <p className="mt-1.5 max-w-[340px] text-[13px] leading-relaxed text-fg-3">{message}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: ReactNode;
  icon?: string;
}) {
  return (
    <div className="card flex items-center gap-3 px-4 py-3.5">
      {icon ? (
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent-tint text-accent">
          <Icon name={icon} size={18} />
        </div>
      ) : null}
      <div className="min-w-0">
        <p className="text-[18px] font-bold text-fg leading-none">{value}</p>
        <p className="mt-1 text-[11px] uppercase tracking-wide text-fg-4">{label}</p>
      </div>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded bg-line/60", className)} />
  );
}

// ── Provider logo ─────────────────────────────────────────────────
export { ProviderLogo } from "@/components/ProviderLogo";

// ── Page header ───────────────────────────────────────────────────

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] font-bold tracking-tight text-fg">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-[13px] text-fg-3">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}