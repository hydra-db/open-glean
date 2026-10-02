"use client";

/**
 * MemoryUpload — the "add to your vault" experience.
 *
 * <MemoryUpload open onClose initialTab onDone /> — self-contained modal.
 *
 * Three input modes:
 *   • File    — drag & drop / picker → ingestFile() per file (knowledge)
 *   • Text    — free-form note       → ingestMemory({ text, title, infer })
 *   • Webpage — fetch a URL server-side, then save the extracted text as a
 *               memory (never stored/forwarded beyond /api/fetch-url)
 *
 * After a successful ingest the host is notified via onDone() and again ~3s
 * later, so the list refreshes once indexing has settled.
 */
import { useEffect, useRef, useState } from "react";
import { HydraApiError, useHydra } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { Field, Modal } from "@/components/ui";
import { Icon, Spinner } from "@/components/Icon";
import { cn, pluralize, truncate } from "@/lib/utils";

export type MemoryUploadTab = "file" | "text" | "webpage";

const TABS: { id: MemoryUploadTab; label: string; icon: string }[] = [
  { id: "file", label: "File", icon: "upload" },
  { id: "text", label: "Text", icon: "file" },
  { id: "webpage", label: "Webpage", icon: "globe" },
];

const LAST_TAB_KEY = "open-glean.uploadTab";

/** The tab the user last used in the upload modal, so it reopens where they left. */
export function lastUploadTab(): MemoryUploadTab {
  if (typeof window === "undefined") return "file";
  const v = window.localStorage.getItem(LAST_TAB_KEY);
  return v === "file" || v === "text" || v === "webpage" ? v : "file";
}

function rememberUploadTab(tab: MemoryUploadTab): void {
  try {
    window.localStorage.setItem(LAST_TAB_KEY, tab);
  } catch {
    // best-effort
  }
}

// ── Modal wrapper ─────────────────────────────────────────────────

type UploadResult =
  | { status: "idle" }
  | { status: "busy"; progress: number; total: number }
  | { status: "error"; error: string };

export function MemoryUpload({
  open,
  onClose,
  initialTab = "text",
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: MemoryUploadTab;
  onDone?: () => void;
}) {
  const [tab, setTab] = useState<MemoryUploadTab>(initialTab);
  const [state, setState] = useState<UploadResult>({ status: "idle" });

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setState({ status: "idle" });
    }
  }, [open, initialTab]);

  const handleUploaded = () => {
    onDone?.();
    window.setTimeout(() => onDone?.(), 3000);
  };

  return (
    <Modal open={open} onClose={onClose} title="Add to your vault" width={540}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-1 rounded-sm border border-line bg-bg-2 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={state.status === "busy"}
              onClick={() => {
                setTab(t.id);
                rememberUploadTab(t.id);
                setState({ status: "idle" });
              }}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-sm py-2 text-[12.5px] font-medium transition-colors disabled:opacity-60",
                tab === t.id
                  ? "bg-bg-elev text-fg shadow-sm"
                  : "text-fg-3 hover:bg-bg-3 hover:text-fg",
              )}
            >
              <Icon name={t.icon} size={13} className={tab === t.id ? "text-accent" : ""} />
              {t.label}
            </button>
          ))}
        </div>

        {tab === "file" ? (
          <FileTab state={state} setState={setState} onUploaded={handleUploaded} />
        ) : tab === "text" ? (
          <TextTab state={state} setState={setState} onUploaded={handleUploaded} />
        ) : (
          <WebpageTab state={state} setState={setState} onUploaded={handleUploaded} />
        )}
      </div>
    </Modal>
  );
}

// ── File tab ──────────────────────────────────────────────────────

const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.html";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function FileTab({
  state,
  setState,
  onUploaded,
}: {
  state: UploadResult;
  setState: (s: UploadResult) => void;
  onUploaded?: () => void;
}) {
  const hydra = useHydra();
  const { push } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);

  const busy = state.status === "busy";

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0 || busy) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  };

  const upload = async () => {
    if (files.length === 0 || busy) return;
    setProgress(0);
    setState({ status: "busy", progress: 0, total: files.length });

    const results = await Promise.all(
      files.map(async (file) => {
        try {
          const res = await hydra.ingestFile(file);
          setProgress((p) => p + 1);
          return { file, ok: (res.success ?? 0) > 0, error: res.errors?.[0]?.message };
        } catch (err) {
          setProgress((p) => p + 1);
          return {
            file,
            ok: false,
            error: err instanceof HydraApiError ? err.message : "Request failed",
          };
        }
      }),
    );
    setState({ status: "idle" });

    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);

    if (okCount > 0) {
      push({
        kind: "success",
        title: `Added ${pluralize(okCount, "file")} — indexing…`,
      });
      setFiles([]);
      onUploaded?.();
    }

    // one toast per failed file — each with its real message
    for (const f of failed) {
      push({
        kind: "error",
        title: `Couldn't add ${f.file.name}`,
        detail: truncate(f.error ?? "No error details.", 160),
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose files to upload"
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !busy) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "transition-colors cursor-pointer rounded-sm border-2 border-dashed px-4 py-8 text-center outline-none",
          dragging
            ? "border-accent bg-accent-tint"
            : "border-line bg-bg-2 hover:border-stroke-3",
          busy && "cursor-not-allowed opacity-60",
        )}
      >
        <Icon name="upload" size={22} className={cn("mx-auto", dragging ? "text-accent" : "text-fg-3")} />
        <p className="mt-2 text-[13px] text-fg-2">
          Drag &amp; drop files here, or{" "}
          <span className="font-medium text-accent">browse</span>
        </p>
        <p className="mt-1 text-[11px] text-fg-4">
          PDF, DOCX, TXT, MD, CSV, HTML
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        disabled={busy}
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {files.length > 0 ? (
        <ul className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${f.size}-${i}`}
              className="flex items-center gap-2 rounded-sm border border-line bg-bg-2 px-2.5 py-1.5"
            >
              <Icon name="file" size={14} className="shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-fg-2">
                {f.name}
              </span>
              <span className="shrink-0 text-[11px] text-fg-4">
                {formatBytes(f.size)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                className="shrink-0 rounded p-0.5 text-fg-4 transition-colors hover:text-bad disabled:opacity-50"
                aria-label={`Remove ${f.name}`}
              >
                <Icon name="x" size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        className="btn-primary w-full"
        disabled={files.length === 0 || busy}
        onClick={upload}
      >
        {busy ? (
          <>
            <Spinner size={14} />
            {state.status === "busy"
              ? `Uploading ${Math.min(progress, state.total)}/${state.total}…`
              : "Uploading…"}
          </>
        ) : (
          <>
            <Icon name="upload" size={14} />
            {files.length > 0
              ? `Upload ${pluralize(files.length, "file")}`
              : "Upload"}
          </>
        )}
      </button>
    </div>
  );
}

// ── Text tab ──────────────────────────────────────────────────────

function TextTab({
  state,
  setState,
  onUploaded,
}: {
  state: UploadResult;
  setState: (s: UploadResult) => void;
  onUploaded?: () => void;
}) {
  const hydra = useHydra();
  const { push } = useToast();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  const busy = state.status === "busy";

  const save = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setState({ status: "busy", progress: 0, total: 1 });
    try {
      const res = await hydra.ingestMemory({
        text: trimmed,
        title: title.trim() || undefined,
        infer: true,
        isMarkdown: false,
      });
      if ((res.success ?? 0) > 0) {
        push({
          kind: "success",
          title: `Added ${pluralize(res.success ?? 1, "memory")} — indexing…`,
        });
        setTitle("");
        setText("");
        onUploaded?.();
      } else {
        push({
          kind: "error",
          title: "Couldn't add that memory",
          detail: truncate(res.errors?.[0]?.message ?? "No error details.", 160),
        });
      }
    } catch (err) {
      push({
        kind: "error",
        title: "Couldn't add that memory",
        detail:
          err instanceof HydraApiError ? err.message : "Something went wrong.",
      });
    } finally {
      setState({ status: "idle" });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Field label="Title (optional)">
        <input
          className="input"
          placeholder="e.g. Weekend reading list"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
      </Field>
      <Field label="Memory">
        <textarea
          className="input h-[140px] resize-y py-2"
          placeholder="Anything worth remembering. A fact, an idea, a link you want to find later…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
      </Field>
      <p className="flex items-start gap-1.5 rounded-sm border border-line bg-bg-2 px-2.5 py-2 text-[11.5px] text-fg-4">
        <Icon name="sparkles" size={12} className="mt-px shrink-0 text-accent" />
        <span>
          Inference extracts memories automatically — no manual tagging needed.
        </span>
      </p>
      <button
        type="button"
        className="btn-primary w-full"
        disabled={!text.trim() || busy}
        onClick={save}
      >
        {busy ? (
          <>
            <Spinner size={14} /> Saving…
          </>
        ) : (
          <>
            <Icon name="plus" size={14} /> Add context
          </>
        )}
      </button>
    </div>
  );
}

// ── Webpage tab ───────────────────────────────────────────────────

function WebpageTab({
  state,
  setState,
  onUploaded,
}: {
  state: UploadResult;
  setState: (s: UploadResult) => void;
  onUploaded?: () => void;
}) {
  const hydra = useHydra();
  const { push } = useToast();
  const [url, setUrl] = useState("");

  const busy = state.status === "busy";

  const fetchAndSave = async () => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http(s) URLs are supported.");
      }
    } catch {
      push({
        kind: "error",
        title: "That doesn't look like a valid URL",
        detail: `"${truncate(trimmed, 80)}" isn't a valid http(s) address.`,
      });
      return;
    }

    setState({ status: "busy", progress: 0, total: 1 });
    try {
      const res = await fetch("/api/fetch-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      let payload: { title?: string; text?: string; error?: string };
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      if (!res.ok || !payload.text) {
        throw new HydraApiError(
          payload.error ?? `The page couldn't be fetched (HTTP ${res.status}).`,
          res.status,
        );
      }

      const ingest = await hydra.ingestMemory({
        text: payload.text,
        title: payload.title || undefined,
        infer: true,
        isMarkdown: false,
      });
      if ((ingest.success ?? 0) > 0) {
        push({
          kind: "success",
          title: "Added webpage — indexing…",
          detail: payload.title ? truncate(payload.title, 70) : undefined,
        });
        setUrl("");
        onUploaded?.();
      } else {
        push({
          kind: "error",
          title: "Couldn't save the page",
          detail: truncate(ingest.errors?.[0]?.message ?? "No error details.", 160),
        });
      }
    } catch (err) {
      push({
        kind: "error",
        title: "Couldn't fetch that page",
        detail:
          err instanceof HydraApiError
            ? err.message
            : "Check the URL and try again.",
      });
    } finally {
      setState({ status: "idle" });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Field label="Webpage URL">
        <input
          className="input"
          type="url"
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void fetchAndSave();
            }
          }}
        />
      </Field>
      <p className="flex items-start gap-1.5 rounded-sm border border-line bg-bg-2 px-2.5 py-2 text-[11.5px] text-fg-4">
        <Icon name="info" size={12} className="mt-px shrink-0 text-accent" />
        <span>
          The page is fetched on our server, converted to text, and saved to
          your database — the raw HTML isn&apos;t kept.
        </span>
      </p>
      <button
        type="button"
        className="btn-primary w-full"
        disabled={!url.trim() || busy}
        onClick={fetchAndSave}
      >
        {busy ? (
          <>
            <Spinner size={14} /> Fetching &amp; saving…
          </>
        ) : (
          <>
            <Icon name="globe" size={14} /> Fetch &amp; save
          </>
        )}
      </button>
    </div>
  );
}