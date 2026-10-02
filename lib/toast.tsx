"use client";

/** Minimal toast system — no external deps. */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "default" | "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastCtx {
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastCtx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-3), { ...t, id }]);
      const ttl = t.kind === "error" ? 6000 : 3500;
      window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        Toasts are the app's only channel for "could not save the key", "copy
        failed" and similar. Without a live region a screen reader user got
        none of it — they vanish on a timer, so there is nothing to navigate
        back to either.

        Errors are assertive because they report a failed action the user just
        took; everything else is polite so it does not interrupt a read in
        progress. Two containers rather than one, because the politeness level
        is a property of the region, not of the message.
      */}
      <div
        role="alert"
        aria-live="assertive"
        className="fixed bottom-20 md:bottom-5 right-4 left-4 md:left-auto z-[100] flex flex-col items-end gap-2 pointer-events-none"
      >
        {toasts
          .filter((t) => t.kind === "error")
          .map((t) => (
          <div
            key={t.id}
            className={`animate-slideUp pointer-events-auto w-full md:w-[340px] rounded border px-3.5 py-2.5 shadow-lg backdrop-blur-sm ${
              t.kind === "error"
                ? "bg-[#2a1212]/95 border-bad/30"
                : t.kind === "success"
                  ? "bg-bg-elev/95 border-line"
                  : t.kind === "info"
                    ? "bg-bg-elev/95 border-line"
                    : "bg-bg-elev/95 border-line"
            }`}
          >
            <div className="flex items-start gap-2">
              <div
                className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                  t.kind === "error"
                    ? "bg-bad"
                    : t.kind === "success"
                      ? "bg-good"
                      : "bg-accent"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg leading-snug">
                  {t.title}
                </p>
                {t.detail ? (
                  <p className="mt-0.5 text-[12px] text-fg-3 leading-snug break-words">
                    {t.detail}
                  </p>
                ) : null}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="text-fg-4 hover:text-fg text-[13px] leading-none mt-0.5"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-20 md:bottom-5 right-4 left-4 md:left-auto z-[100] flex flex-col items-end gap-2 pointer-events-none"
      >
        {toasts
          .filter((t) => t.kind !== "error")
          .map((t) => (
            <div
              key={t.id}
              className="animate-slideUp pointer-events-auto w-full rounded border border-line bg-bg-elev/95 px-3.5 py-2.5 shadow-lg backdrop-blur-sm md:w-[340px]"
            >
              <div className="flex items-start gap-2">
                <div
                  className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                    t.kind === "success" ? "bg-good" : "bg-accent"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium leading-snug text-fg">{t.title}</p>
                  {t.detail ? (
                    <p className="mt-0.5 break-words text-[12px] leading-snug text-fg-3">
                      {t.detail}
                    </p>
                  ) : null}
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  className="mt-0.5 text-[13px] leading-none text-fg-4 hover:text-fg"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}