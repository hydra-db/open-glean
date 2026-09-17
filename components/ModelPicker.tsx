"use client";

/**
 * OpenRouter model picker: fetches the real model directory via our proxy,
 * lets the user search, star favourites and pick. Favourites persist locally.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Icon, Spinner } from "@/components/Icon";
import { useAppConfig } from "@/lib/store/config";

const FAV_KEY = "open-glean.favModels";

function loadFavorites(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw =
      window.localStorage.getItem(FAV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export interface OrModel {
  id: string;
  name?: string;
  context_length?: number | null;
  pricing?: Record<string, unknown>;
}

function shortenContext(n?: number | null): string {
  if (!n) return "";
  const k = Math.round(n / 1000);
  return k >= 1000 ? `${(k / 1000).toFixed(1)}M` : `${k}k`;
}

export function ModelPicker({
  value,
  onChange,
  onRequestTest,
}: {
  value: string;
  onChange: (model: string) => void;
  onRequestTest?: () => void;
}) {
  const { config } = useAppConfig();
  const apiKey = config.llm?.apiKey ?? "";
  const baseUrl = config.llm?.baseUrl ?? "";

  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<OrModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (models) return;
    setLoading(true);
    setError("");
    try {
      // Key and base URL go in headers, not the query string, so they are not
      // written to server logs, proxy logs, or browser history.
      const headers: Record<string, string> = {};
      if (baseUrl) headers["x-llm-base"] = baseUrl;
      if (apiKey) headers["x-llm-key"] = apiKey;
      const res = await fetch("/api/openrouter/models", {
        cache: "no-store",
        headers,
      });
      const body = (await res.json()) as {
        data?: OrModel[];
        error?: string;
      };
      if (!res.ok || !Array.isArray(body.data)) {
        setError(body.error ?? "Could not load models.");
        setLoading(false);
        return;
      }
      setModels(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load models.");
    } finally {
      setLoading(false);
    }
  }, [models, apiKey, baseUrl]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggleFav = (id: string) => {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id];
      try {
        window.localStorage.setItem(FAV_KEY, JSON.stringify(next));
      } catch {
        // best-effort persistence
      }
      return next;
    });
  };

  const filtered = useMemo(() => {
    const empty = { favs: [] as OrModel[], rest: [] as OrModel[] };
    if (!models) return empty;
    const term = q.trim().toLowerCase();
    if (!term) {
      const favs = favorites
        .map((id) => models.find((m) => m.id === id))
        .filter((m): m is OrModel => Boolean(m));
      const rest = models.filter((m) => !favorites.includes(m.id));
      return { favs, rest };
    }
    const matches = models.filter(
      (m) => m.id.toLowerCase().includes(term) || (m.name ?? "").toLowerCase().includes(term),
    );
    return {
      favs: matches.filter((m) => favorites.includes(m.id)),
      rest: matches.filter((m) => !favorites.includes(m.id)),
    };
  }, [models, q, favorites]);

  const selectedName = useMemo(
    () => models?.find((m) => m.id === value)?.name,
    [models, value],
  );

  // Arrow-key roving focus over the option buttons. The rows are real buttons,
  // so Enter and Space already pick a model; this only moves focus between them.
  const onListKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const options = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
    );
    if (options.length === 0) return;
    e.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % options.length;
    else next = current <= 0 ? options.length - 1 : current - 1;
    options[next]?.focus();
  }, []);

  return (
    <div className="relative" ref={ref}>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="input flex items-center justify-between gap-2 text-left font-mono text-[12px]"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="truncate">{value || "Select a model…"}</span>
          <span className="flex shrink-0 items-center gap-1">
            {loading ? <Spinner size={11} /> : null}
            <Icon name="chevDown" size={13} className="text-fg-4" />
          </span>
        </button>
        {onRequestTest ? (
          <button
            type="button"
            className="btn-soft shrink-0 px-2.5"
            onClick={onRequestTest}
            title="Test the selected model"
          >
            <Icon name="bolt" size={13} />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="animate-fadeIn absolute left-0 right-0 top-full z-[90] mt-1 rounded-md border border-line bg-bg-elev shadow-2xl">
          <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
            <Icon name="search" size={13} className="text-fg-4" />
            <input
              autoFocus
              className="flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-4"
              aria-label="Search models"
              placeholder="Search OpenRouter models…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {value && !q.trim() ? (
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-[11px] text-accent hover:underline"
              >
                Use “{value}”
              </button>
            ) : null}
          </div>

          {loading && !models ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-[12px] text-fg-4">
              <Spinner size={13} /> Fetching models…
            </div>
          ) : error ? (
            <div className="px-3 py-6 text-[12px] text-warn">
              {error}
              <button className="ml-1.5 text-accent hover:underline" onClick={() => { setModels(null); void load(); }}>
                Retry
              </button>
            </div>
          ) : (
            <div
              role="listbox"
              aria-label="Models"
              className="max-h-[300px] overflow-y-auto py-1"
              onKeyDown={onListKeyDown}
            >
              {filtered.favs.length > 0 ? (
                <>
                  <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-5">
                    ★ Favourites
                  </p>
                  {filtered.favs.map((m) => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      active={value === m.id}
                      fav
                      onPick={() => {
                        onChange(m.id);
                        setOpen(false);
                      }}
                      onToggleFav={() => toggleFav(m.id)}
                    />
                  ))}
                  <div className="my-1 border-t border-line" />
                </>
              ) : null}
              {filtered.favs.length > 0 ? (
                <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-fg-5">
                  All models
                </p>
              ) : null}
              {filtered.rest.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  active={value === m.id}
                  onPick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  onToggleFav={() => toggleFav(m.id)}
                />
              ))}
              {filtered.rest.length === 0 && filtered.favs.length === 0 ? (
                <p className="px-3 py-5 text-[12px] text-fg-4">No models match “{q}”.</p>
              ) : null}
            </div>
          )}

          {models && models.length > 0 ? (
            <div className="border-t border-line px-3 py-1.5 text-[10.5px] text-fg-5">
              {models.length} models · {value ? `selected: ${selectedName ?? value}` : "pick one"}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ModelRow({
  model,
  active,
  fav,
  onPick,
  onToggleFav,
}: {
  model: OrModel;
  active: boolean;
  fav?: boolean;
  onPick: () => void;
  onToggleFav: () => void;
}) {
  // The row itself is the option: one focusable button that picks the model, so
  // there is no interactive element nested inside the option. The favourite
  // star is a sibling positioned over the row, not a child of the option.
  return (
    <div
      className={cn(
        "group relative flex w-full items-center transition-colors",
        active ? "bg-accent-dim" : "hover:bg-bg-3",
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={onPick}
        className="min-w-0 flex-1 py-1.5 pl-9 pr-3 text-left"
      >
        <p className={cn("truncate text-[12.5px] font-medium", active ? "text-accent" : "text-fg")}>
          {model.name || model.id}
        </p>
        <p className="truncate font-mono text-[10.5px] text-fg-5">
          {model.id}
          {model.context_length ? ` · ${shortenContext(model.context_length)} ctx` : ""}
        </p>
      </button>
      <button
        type="button"
        onClick={onToggleFav}
        aria-label={fav ? `Remove ${model.name || model.id} from favourites` : `Add ${model.name || model.id} to favourites`}
        aria-pressed={fav}
        className="absolute left-3 top-1/2 -translate-y-1/2 shrink-0 text-fg-5 transition-colors hover:text-highlight"
      >
        <Icon name="star" size={13} className={fav ? "text-highlight" : ""} />
      </button>
    </div>
  );
}