"use client";

/**
 * App configuration store — persisted in localStorage, exposed via React
 * context. Holds the user's Hydra DB API key (+ scope) and the LLM settings.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_CONFIG, type AppConfig } from "@/lib/types";

const STORAGE_KEY = "open-glean.config.v1";

/** Shape of GET /api/auth/key — what the server will admit about its keys. */
interface AuthStatus {
  configured: boolean;
  fromEnv?: boolean;
  hydraKeyMasked?: string;
  baseUrl?: string;
  llmConfigured?: boolean;
  llmModel?: string;
  llmBaseUrl?: string;
}

interface StoreValue {
  config: AppConfig;
  setConfig: (patch: Partial<AppConfig>) => void;
  resetConfig: () => void;
  hasKey: boolean;
  /**
   * False until GET /api/auth/key has answered. Keys can live server-side
   * (session cookie or HYDRA_API_KEY), so `hasKey` is not trustworthy before
   * that — gating on it early flashes the connect screen at a user who is
   * already authenticated.
   */
  authResolved: boolean;
}

const StoreContext = createContext<StoreValue | null>(null);

function sanitizeScope(cfg: AppConfig): AppConfig {
  // One precedence rule everywhere: a single `collection` shadows the
  // multi-select `collections` (chat, Context search, mindmap all agree).
  // The migration below copies a legacy config verbatim, and that config
  // can hold both keys at once — drop the shadowed one at load so returning
  // users can't see a graph spanning N collections while search stays in one.
  if (
    cfg.collection &&
    cfg.collections &&
    cfg.collections.length > 0
  ) {
    return { ...cfg, collections: undefined };
  }
  return cfg;
}

/**
 * Force each field of a parsed config to the type the app expects.
 *
 * localStorage is user-writable and can be corrupted. JSON.parse succeeds on
 * {"apiKey": {}} or {"apiKey": 123}, and the object then reaches
 * config.apiKey.trim(), which throws during the root layout's render. There is
 * no boundary above the root layout, so that is a permanent white screen with
 * no way back except clearing storage by hand. Coerce every field here.
 */
export function coerceConfig(raw: unknown): Partial<AppConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

  const out: Partial<AppConfig> = {};
  const assign = <K extends keyof AppConfig>(k: K, v: AppConfig[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  assign("apiKey", str(r.apiKey));
  assign("keyConfigured", bool(r.keyConfigured));
  assign("keyMask", str(r.keyMask));
  assign("keyFromEnv", bool(r.keyFromEnv));
  assign("llmConfigured", bool(r.llmConfigured));
  assign("baseUrl", str(r.baseUrl));
  assign("database", str(r.database));
  assign("collection", str(r.collection));
  assign("collections", strArr(r.collections));
  assign("instructions", str(r.instructions));
  // Only the known theme values, so a corrupt {"theme":"blue"} does not become
  // a bogus data-theme attribute.
  const t = str(r.theme);
  assign("theme", t === "dark" || t === "light" || t === "system" ? t : undefined);
  // `llm` is a nested object; keep only its string fields.
  if (r.llm && typeof r.llm === "object") {
    const l = r.llm as Record<string, unknown>;
    out.llm = {
      ...(str(l.apiKey) !== undefined ? { apiKey: str(l.apiKey) } : {}),
      ...(str(l.baseUrl) !== undefined ? { baseUrl: str(l.baseUrl) } : {}),
      ...(str(l.model) !== undefined ? { model: str(l.model)! } : {}),
    } as AppConfig["llm"];
  }
  return out;
}

function loadConfig(): AppConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return sanitizeScope({ ...DEFAULT_CONFIG, ...coerceConfig(JSON.parse(raw)) });
    }
    return DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<AppConfig>(loadConfig);
  const [authResolved, setAuthResolved] = useState(false);

  /**
   * Adopt server-side credentials on first mount.
   *
   * Keys live in an encrypted httpOnly cookie or in the deployment's
   * environment, so the browser cannot see them — it only learns that they
   * exist by asking. Without this, a deployment with HYDRA_API_KEY set (which
   * the proxy happily uses) still shows the connect gate forever, and a
   * returning user with a valid session cookie but cleared localStorage is
   * asked to re-enter a key the server already has.
   */
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/key", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((status: AuthStatus | null) => {
        if (cancelled || !status) return;
        setConfigState((prev) => {
          const patch: Partial<AppConfig> = {};
          if (status.configured && !prev.keyConfigured && !prev.apiKey?.trim()) {
            patch.keyConfigured = true;
            if (status.hydraKeyMasked) patch.keyMask = status.hydraKeyMasked;
            if (status.baseUrl) patch.baseUrl = status.baseUrl;
            // `fromEnv` was returned by the API and read nowhere, which is why
            // Disconnect could claim success on a deployment-key install and
            // then silently "reconnect" on the next load.
            if (status.fromEnv) patch.keyFromEnv = true;
          } else if (!status.configured && prev.keyConfigured && !prev.apiKey?.trim()) {
            // The server no longer has a key, but a prior load cached
            // keyConfigured=true. Clear the stale flag so the UI does not show
            // "connected" for a key that is gone. A user-entered apiKey is left
            // alone; only the server-derived flag is cleared.
            patch.keyConfigured = false;
            patch.keyMask = undefined;
            patch.keyFromEnv = undefined;
          }
          if (status.llmConfigured && !prev.llmConfigured) {
            patch.llmConfigured = true;
          }
          if (status.llmModel && !prev.llm?.model) {
            patch.llm = { ...prev.llm, model: status.llmModel };
          }
          return Object.keys(patch).length > 0 ? { ...prev, ...patch } : prev;
        });
      })
      .catch(() => {
        // Offline or no session — the connect gate handles it.
      })
      .finally(() => {
        // Resolved either way: only now is `hasKey` meaningful.
        if (!cancelled) setAuthResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // storage unavailable — fine, config just won't persist
    }
  }, [config]);

  const setConfig = useCallback((patch: Partial<AppConfig>) => {
    setConfigState((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetConfig = useCallback(() => {
    setConfigState(DEFAULT_CONFIG);
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      config,
      setConfig,
      resetConfig,
      hasKey: Boolean(config.apiKey?.trim() || config.keyConfigured),
      authResolved,
    }),
    [config, setConfig, resetConfig, authResolved],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useAppConfig(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useAppConfig must be used within StoreProvider");
  return ctx;
}

export function resolvedTheme(mode: AppConfig["theme"]): "dark" | "light" {
  if (mode === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return mode;
}