"use client";

/**
 * Connect Hydra — API key setup AND the connected-state manager.
 *
 * Two modes:
 *  - editing: paste key (optionally base URL) → verify → pick database →
 *    pick collection → Save.
 *  - connected: status card with masked key + active scope, and actions to
 *    change the key, switch database/collection (live, no re-verify), or
 *    disconnect.
 */
import { useCallback, useId, useMemo, useState } from "react";
import { useAppConfig } from "@/lib/store/config";
import { useToast } from "@/lib/toast";
import { HydraApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsFooter, SettingsRow, btn } from "@/components/ui";
import { PixelTree } from "@/components/PixelTree";
import { Icon, Spinner } from "@/components/Icon";

interface DbOption {
  tenant_id: string;
  organisation?: string;
}

/** Normalize whatever listDatabases returns into DbOption[]. */
function normalizeDatabases(body: unknown): DbOption[] {
  const b = body as Record<string, unknown>;
  const root =
    b?.data && typeof b.data === "object" ? (b.data as Record<string, unknown>) : (b ?? {});
  const list =
    (Array.isArray(root.tenants) ? root.tenants : null) ??
    (Array.isArray(root.tenantIds) ? root.tenantIds : null) ??
    (Array.isArray(root.databases) ? root.databases : null) ??
    (Array.isArray(root.tenant_ids) ? root.tenant_ids : null) ??
    [];
  return (list as unknown[])
    .map((x): DbOption | null => {
      if (typeof x === "string") return { tenant_id: x };
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const id = String(o.tenant_id ?? o.tenantId ?? o.name ?? "");
        if (!id) return null;
        return {
          tenant_id: id,
          organisation: o.organisation ? String(o.organisation) : undefined,
        };
      }
      return null;
    })
    .filter((x): x is DbOption => x !== null);
}

/** Normalize whatever listCollections returns into string[]. */
function normalizeCollections(body: unknown): string[] {
  const b = body as Record<string, unknown>;
  const root =
    b?.data && typeof b.data === "object" ? (b.data as Record<string, unknown>) : (b ?? {});
  const list =
    (Array.isArray(root.sub_tenant_ids) ? root.sub_tenant_ids : null) ??
    (Array.isArray(root.subTenantIds) ? root.subTenantIds : null) ??
    (Array.isArray(root.collections) ? root.collections : null) ??
    [];
  return (list as unknown[]).filter((s): s is string => typeof s === "string");
}

function maskKey(key: string): string {
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 8)}${"•".repeat(6)}${key.slice(-4)}`;
}

export function ConnectForm({
  compact = false,
  onConnected,
}: {
  compact?: boolean;
  onConnected?: () => void;
}) {
  const { config, setConfig } = useAppConfig();
  const toast = useToast();
  const connected = Boolean(config.apiKey?.trim() || config.keyConfigured);

  // null = connected view; true = editing (new key) · "scope" = scope picker
  const [mode, setMode] = useState<null | "edit" | "scope">(connected ? null : "edit");

  const [key, setKey] = useState(config.apiKey ?? "");
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? "");
  const [database, setDatabase] = useState(config.database ?? "");
  const [collection, setCollection] = useState(config.collection ?? "");
  const [databases, setDatabases] = useState<DbOption[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [loadingCols, setLoadingCols] = useState(false);
  const [error, setError] = useState("");
  const [scopeLoading, setScopeLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const keyId = useId();
  const urlId = useId();

  const keyTrimmed = key.trim();
  const dbOptions = useMemo(
    () =>
      databases.map((d) => ({
        ...d,
        label:
          d.organisation && d.organisation !== d.tenant_id
            ? `${d.organisation} · ${d.tenant_id}`
            : d.tenant_id,
      })),
    [databases],
  );

  const fetchDatabases = useCallback(async (): Promise<DbOption[]> => {
    const res = await fetch("/api/hydra/databases", { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (body as { error?: string }).error ??
        (body as { detail?: string }).detail ??
        `Request failed (${res.status}).`;
      throw new HydraApiError(msg, res.status);
    }
    return normalizeDatabases(body);
  }, []);

  const fetchCollections = useCallback(async (db: string): Promise<string[]> => {
    const res = await fetch(
      `/api/hydra/databases/collections?database=${encodeURIComponent(db)}`,
      { cache: "no-store" },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return normalizeCollections(body);
  }, []);

  const loadCols = useCallback(
    async (db: string) => {
      setLoadingCols(true);
      try {
        setCollections(await fetchCollections(db));
      } finally {
        setLoadingCols(false);
      }
    },
    [fetchCollections],
  );

  /** Verify the key server-side; the key is stored ONLY in the encrypted
   *  httpOnly session cookie — it never persists in browser state. */
  const verify = useCallback(async () => {
    if (!keyTrimmed) {
      toast.push({ kind: "error", title: "API key required" });
      return;
    }
    setVerifying(true);
    setError("");
    try {
      const res = await fetch("/api/auth/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hydraKey: keyTrimmed, baseUrl: baseUrl.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        databases?: string[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Verification failed (${res.status}).`);
      }
      const tenants = (body.databases ?? []).map((id) => ({ tenant_id: id }));
      setDatabases(tenants);
      if (tenants.length === 0) {
        setError("Connected, but no databases found for this key yet.");
      } else if (tenants.length === 1 && !database) {
        setDatabase(tenants[0]!.tenant_id);
        void loadCols(tenants[0]!.tenant_id);
      }
    } catch (err) {
      // Clear the results of any EARLIER successful verify. Without this, a
      // good key followed by a bad one left the first key's database list on
      // screen with its "Use <db>" button live — clicking it marked the app
      // connected with a key the server had just rejected, and the session
      // still held the old key, so the app half-worked.
      setDatabases([]);
      setCollections([]);
      setError(
        err instanceof Error ? err.message : "Could not reach Hydra. Check the key and base URL.",
      );
    } finally {
      setVerifying(false);
    }
  }, [keyTrimmed, baseUrl, database, toast, loadCols]);

  /** Connected-mode scope switcher: reuse the stored key. */
  const openScopePicker = useCallback(async () => {
    setMode("scope");
    setScopeLoading(true);
    setError("");
    setDatabase(config.database ?? "");
    setCollection(config.collection ?? "");
    try {
      const tenants = await fetchDatabases();
      setDatabases(tenants);
      if (config.database) {
        setCollections(await fetchCollections(config.database));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your databases.");
    } finally {
      setScopeLoading(false);
    }
  }, [config.database, fetchDatabases, fetchCollections]);

  const save = () => {
    if (!keyTrimmed && mode === "edit" && !connected) {
      toast.push({ kind: "error", title: "API key required" });
      return;
    }
    setConfig({
      ...(mode === "edit"
        ? {
            keyConfigured: true,
            keyMask: keyTrimmed ? maskKey(keyTrimmed) : config.keyMask,
            baseUrl: baseUrl.trim() || undefined,
          }
        : {}),
      database: database || undefined,
      collection: collection || undefined,
      // A single-collection pick replaces any stored multi-select; leaving
      // it would silently re-scope the next search back to many collections.
      collections: undefined,
    });
    toast.push({
      kind: "success",
      title: mode === "edit" ? "Connected to Hydra DB" : "Scope updated",
      detail: database
        ? `${database}${collection ? ` / ${collection}` : ""}`
        : undefined,
    });
    setMode(null);
    onConnected?.();
  };

  const startEdit = () => {
    setKey("");
    setDatabases([]);
    setCollections([]);
    setError("");
    setMode("edit");
  };

  /**
   * Clear the stored key.
   *
   * Awaits the server, because the local state is not the credential: the key
   * lives in an encrypted httpOnly cookie. Firing and forgetting meant a
   * failed DELETE still showed "Disconnected", and the next page load silently
   * re-adopted the key the user thought they had removed.
   *
   * On a deployment-key install there is nothing to clear — the key comes from
   * the environment and no request can remove it — so say that instead of
   * claiming a disconnect that did not happen.
   */
  const disconnect = async () => {
    if (config.keyFromEnv) {
      toast.push({
        kind: "info",
        title: "This deployment supplies the key",
        detail: "It is set on the server and cannot be disconnected here.",
      });
      return;
    }
    let cleared = false;
    try {
      const res = await fetch("/api/auth/key", { method: "DELETE" });
      cleared = res.ok;
    } catch {
      cleared = false;
    }
    if (!cleared) {
      toast.push({
        kind: "error",
        title: "Could not disconnect",
        detail: "The stored key is still on the server. Try again.",
      });
      return;
    }
    setConfig({
      apiKey: undefined,
      keyConfigured: undefined,
      keyMask: undefined,
      keyFromEnv: undefined,
      baseUrl: undefined,
      database: undefined,
      collection: undefined,
      collections: undefined,
    });
    setKey("");
    setDatabase("");
    setCollection("");
    setDatabases([]);
    setCollections([]);
    setMode("edit");
    toast.push({ kind: "info", title: "Disconnected" });
  };

  // ── Connected view ───────────────────────────────────────────
  // Rows rather than a card: in Settings this sits inside a section card
  // that already draws the border and the dividers.
  if (connected && mode === null) {
    const scope = config.database
      ? `${config.database}${config.collection ? ` / ${config.collection}` : ""}`
      : "No database selected";
    const rows = (
      <>
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <span aria-hidden className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-1 opacity-40 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success-1" />
              </span>
              Connected
            </span>
          }
          description={
            config.keyFromEnv ? (
              "Using this deployment's shared key"
            ) : (
              <span className="font-mono text-[12px]">
                {config.keyMask ?? (config.apiKey ? maskKey(config.apiKey) : "")}
              </span>
            )
          }
        >
          {config.keyFromEnv ? null : (
            <>
              <button className={btn.secondary} onClick={startEdit}>
                <Icon name="key" size={13} />
                Change key
              </button>
              <button className={btn.ghost} onClick={disconnect}>
                Disconnect
              </button>
            </>
          )}
        </SettingsRow>

        <SettingsRow
          label="Database"
          description={<span className="font-mono text-[12px]">{scope}</span>}
        >
          <button className={btn.secondary} onClick={() => void openScopePicker()}>
            <Icon name="refresh" size={13} />
            Switch
          </button>
        </SettingsRow>

        <SettingsFooter
          note={
            <span className="inline-flex items-center gap-1.5">
              <Icon name="lock" size={12} className="shrink-0" />
              {config.keyFromEnv
                ? "This deployment supplies the key from its server environment, so it can't be changed here."
                : "Stored encrypted on the server, never in this browser, and sent only to Hydra."}
            </span>
          }
        />
      </>
    );
    return compact ? (
      rows
    ) : (
      <div className="w-full divide-y divide-solid divide-stroke-1 overflow-hidden rounded-xl border border-solid border-stroke-1 bg-surface-4">
        {rows}
      </div>
    );
  }

  // ── Editing / scope-picker view ──────────────────────────────
  const isScopeMode = mode === "scope";
  const picking = databases.length > 0;
  const chosenLabel = dbOptions.find((d) => d.tenant_id === database)?.label ?? database;
  const full = !compact && mode === "edit" && !connected;
  // The main action. Crisp corners like hydradb.com's buttons rather than the
  // app's pills, solid white when ready, and a quiet outline while it can't be
  // pressed yet, instead of a washed-out grey slab.
  const cta = cn(
    "group/cta flex h-11 w-full items-center justify-center gap-2 rounded-md text-[14px] font-medium transition-colors",
    "bg-text-1 text-surface-1 hover:bg-white",
    "disabled:pointer-events-none disabled:border disabled:border-solid disabled:border-stroke-1 disabled:bg-white/[0.03] disabled:text-fg-4",
  );
  const arrow = (
    <Icon name="arrowRight" size={14} className="transition-transform duration-200 group-hover/cta:translate-x-0.5" />
  );

  // One form, so Enter submits: it verifies the key first, then confirms the
  // chosen database once the list is showing.
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isScopeMode) return;
    if (picking) {
      if (database) save();
    } else if (keyTrimmed && !verifying) {
      void verify();
    }
  };

  return (
    <div className="w-full">
      {full ? (
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/hydra-mark.png" alt="" className="h-9 w-9" />
          <h1 className="mt-5 font-pixel text-[30px] font-normal leading-tight text-text-3">
            Connect your Hydra DB
          </h1>
          <p className="mt-2 max-w-[340px] text-[14px] leading-relaxed text-text-2">
            Ask questions across your notes, files, and connected apps, answered
            from your own context.
          </p>
        </div>
      ) : null}

      <form
        onSubmit={onSubmit}
        className={cn(
          "space-y-5",
          compact
            ? "p-4"
            : "rounded-2xl border border-solid border-stroke-1 bg-surface-4/85 p-5 shadow-2xl shadow-black/60 backdrop-blur-md",
        )}
      >
        {isScopeMode ? (
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-medium text-text-1">Switch database</p>
            <button
              type="button"
              onClick={() => setMode(null)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-fg-4 transition-colors hover:bg-white/[0.06] hover:text-text-1"
              aria-label="Close"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : !picking ? (
          <>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor={keyId} className="text-[12.5px] font-medium text-text-1">
                  API key
                </label>
                <a
                  href="https://app.hydradb.com/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] text-fg-3 transition-colors hover:text-text-1"
                >
                  Get a key
                  <Icon name="external" size={11} />
                </a>
              </div>
              <div className="relative">
                <Icon
                  name="key"
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-4"
                />
                <input
                  id={keyId}
                  className="input h-11 pl-9 pr-10 font-mono text-[13px]"
                  type={showKey ? "text" : "password"}
                  placeholder="sk_live_…"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={full}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-4 transition-colors hover:text-text-1"
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                >
                  <Icon name={showKey ? "eyeOff" : "eye"} size={15} />
                </button>
              </div>
              <p className="mt-1.5 text-[11.5px] text-fg-4">
                Any key with access to the database you want to search.
              </p>
            </div>

            <div>
              <label htmlFor={urlId} className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-text-1">
                Base URL <span className="font-normal text-fg-4">optional</span>
              </label>
              <input
                id={urlId}
                className="input h-11 font-mono text-[12.5px]"
                type="text"
                placeholder="https://api.hydradb.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="mt-1.5 text-[11.5px] text-fg-4">
                Leave empty for api.hydradb.com.
              </p>
            </div>

            <button type="submit" className={cta} disabled={!keyTrimmed || verifying}>
              {verifying ? (
                <>
                  <Spinner size={14} /> Verifying key…
                </>
              ) : (
                <>
                  Connect HydraDB {arrow}
                </>
              )}
            </button>
          </>
        ) : null}

        {isScopeMode ? (
          <button
            type="button"
            className={cn(btn.secondary, "w-full")}
            onClick={() => void openScopePicker()}
            disabled={scopeLoading}
          >
            {scopeLoading ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
            Refresh databases
          </button>
        ) : null}

        {error ? (
          <p className="flex items-start gap-2 rounded-lg border border-solid border-bad/30 bg-bad-fill px-3 py-2.5 text-[12.5px] text-bad">
            <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
            {error}
          </p>
        ) : null}

        {picking ? (
          <div className="space-y-4 animate-fadeIn">
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <p className="text-[12.5px] font-medium text-text-1">Choose a database</p>
                <span className="text-[11.5px] text-fg-4">{dbOptions.length} on this key</span>
              </div>
              <div
                role="radiogroup"
                aria-label="Database"
                className="max-h-[208px] divide-y divide-solid divide-stroke-1 overflow-y-auto rounded-xl border border-solid border-stroke-1"
              >
                {dbOptions.map((db) => {
                  const selected = database === db.tenant_id;
                  return (
                    <button
                      key={db.tenant_id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        setDatabase(db.tenant_id);
                        setCollection("");
                        void loadCols(db.tenant_id);
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors",
                        selected ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-solid",
                          selected ? "border-text-1" : "border-stroke-3",
                        )}
                      >
                        {selected ? <span className="h-2 w-2 rounded-full bg-text-1" /> : null}
                      </span>
                      <Icon name="database" size={14} className="shrink-0 text-fg-3" />
                      <span className={cn("truncate font-mono text-[13px]", selected ? "text-text-3" : "text-text-2")}>
                        {db.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {database && collections.length > 0 ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-[12.5px] font-medium text-text-1">
                  Collection <span className="font-normal text-fg-4">optional</span>
                  {loadingCols ? <Spinner size={10} /> : null}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {["", ...collections].map((c) => {
                    const selected = collection === c;
                    return (
                      <button
                        key={c || "__all"}
                        type="button"
                        onClick={() => setCollection(c)}
                        className={cn(
                          "max-w-full truncate rounded-full border border-solid px-3 py-1 text-[12px] transition-colors",
                          c ? "font-mono" : "",
                          selected
                            ? "border-accent-line bg-accent-tint text-text-3"
                            : "border-stroke-1 text-text-2 hover:border-stroke-3 hover:text-text-1",
                        )}
                      >
                        {c || "All collections"}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <button type="submit" className={cta} disabled={!database}>
              {database ? (
                <>
                  Continue with <span className="truncate font-mono">{chosenLabel}</span>
                  {arrow}
                </>
              ) : (
                "Select a database"
              )}
            </button>
          </div>
        ) : null}

        {!isScopeMode && !compact ? (
          <p className="flex items-center justify-center gap-1.5 text-[11.5px] text-fg-4">
            <Icon name="lock" size={11} className="shrink-0" />
            Encrypted on the server · never stored in your browser
          </p>
        ) : null}
      </form>

      {full ? (
        <p className="mt-5 text-center text-[12.5px] text-fg-3">
          New to HydraDB?{" "}
          <a
            href="https://app.hydradb.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-text-1 underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white/70"
          >
            Create a free account
          </a>
        </p>
      ) : null}

      {connected ? (
        <div className={compact ? "flex justify-end px-4 pb-4" : "mt-3 flex justify-center"}>
          <button type="button" onClick={() => setMode(null)} className={btn.ghost}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ConnectGate() {
  return (
    <div className="relative h-full overflow-y-auto">
      {/* The tree grows behind the lower part of the page and fades out
          before it reaches the form, so it frames the card without sitting
          under the text. */}
      <PixelTree className="pointer-events-none absolute inset-x-0 bottom-0 h-[60%] w-full [mask-image:linear-gradient(to_top,#000_55%,transparent)]" />
      {/* The form must be width-constrained here: it renders full-bleed
          otherwise, so on a wide screen the card stretched edge-to-edge while
          the heading above it stayed in a narrow column. */}
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-[420px] flex-col justify-center px-5 py-10">
        <ConnectForm />
      </div>
    </div>
  );
}