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
import { useCallback, useMemo, useState } from "react";
import { useAppConfig } from "@/lib/store/config";
import { useToast } from "@/lib/toast";
import { HydraApiError } from "@/lib/api";
import { Field } from "@/components/ui";
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
  if (connected && mode === null) {
    return (
      <div className="w-full">
        <div className="card space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="h-2 w-2 shrink-0 rounded-full bg-success-1" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-1">Connected</p>
                {config.keyFromEnv ? (
                  <p className="truncate text-xs text-text-2">
                    Using this deployment&apos;s shared key
                  </p>
                ) : (
                  <p className="truncate font-mono text-xs text-text-2">
                    {config.keyMask ?? (config.apiKey ? maskKey(config.apiKey) : "")}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-solid border-stroke-1 bg-surface-2 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2 text-sm text-text-2">
              <Icon name="database" size={15} className="shrink-0 text-brand-1" />
              <span className="truncate font-mono">
                {config.database ?? "No database selected"}
                {config.collection ? ` / ${config.collection}` : ""}
              </span>
            </div>
            <button
              onClick={() => void openScopePicker()}
              className="btn-ghost h-8 shrink-0 !px-3 text-xs"
            >
              Switch
            </button>
          </div>

          {config.keyFromEnv ? (
            // The key comes from the deployment environment. There is nothing to
            // change or disconnect from the browser, so hide those actions
            // instead of offering buttons that only report they cannot work.
            <p className="text-xs leading-relaxed text-fg-4">
              This deployment supplies the key from its server environment. It
              cannot be changed or disconnected here.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-soft h-9 text-sm" onClick={startEdit}>
                  <Icon name="key" size={14} /> Change API key
                </button>
                <button
                  onClick={disconnect}
                  className="btn-ghost h-9 text-sm hover:!text-error-1"
                >
                  <Icon name="logout" size={14} /> Disconnect
                </button>
              </div>
              <p className="text-xs leading-relaxed text-fg-4">
                Your key is stored in an encrypted session cookie on the server,
                not in this browser, and is sent only to Hydra.
              </p>
            </>
          )}
        </div>

        {mode === "scope" ? null : null}
      </div>
    );
  }

  // ── Editing / scope-picker view ──────────────────────────────
  const isScopeMode = mode === "scope";

  return (
    <div className="w-full">
      {!compact && mode === "edit" && !connected ? (
        <div className="mb-6 flex flex-col items-center text-center">
          <img
            src="/static/images/logos/hydradb-white.png"
            alt="Hydra DB"
            className="h-9 w-auto"
          />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-text-1">
            Connect your Hydra DB
          </h1>
          <p className="mt-1.5 max-w-[360px] text-sm text-text-2">
            Add your API key to ask questions across your notes, files, and
            connected apps.
          </p>
        </div>
      ) : null}

      <div className="card space-y-4 p-4">
        {isScopeMode ? (
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-text-1">Switch database</p>
            <button
              onClick={() => setMode(null)}
              className="text-fg-4 transition-colors hover:text-fg"
              aria-label="Close"
            >
              <Icon name="x" size={15} />
            </button>
          </div>
        ) : (
          <Field
            label="Hydra DB API key"
            hint="Create one at app.hydradb.com/keys. Use any key with access to your database."
          >
            <input
              className="input font-mono text-xs"
              type="password"
              placeholder="sk_live_…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
            />
          </Field>
        )}

        {!isScopeMode ? (
          <Field label="Base URL (optional)" hint="Defaults to https://api.hydradb.com">
            <input
              className="input font-mono text-xs"
              type="text"
              placeholder="https://api.hydradb.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
        ) : null}

        {isScopeMode ? (
          <button className="btn-soft w-full" onClick={() => void openScopePicker()} disabled={scopeLoading}>
            {scopeLoading ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
            Refresh databases
          </button>
        ) : (
          <button className="btn-primary w-full" onClick={() => void verify()} disabled={!keyTrimmed || verifying}>
            {verifying ? <Spinner size={14} /> : <Icon name="bolt" size={14} />}
            {verifying ? "Verifying…" : "Verify & continue"}
          </button>
        )}

        {error ? (
          <p className="flex items-start gap-1.5 rounded-md border border-solid border-error-1/30 bg-bad-fill px-3 py-2 text-xs text-error-1">
            <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
            {error}
          </p>
        ) : null}

        {databases.length > 0 ? (
          <div className="space-y-3 animate-fadeIn">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-text-2">
                Database{dbOptions.length > 1 ? "s" : ""} on this key
              </p>
              <div className="max-h-[180px] space-y-1.5 overflow-y-auto pr-0.5">
                {dbOptions.map((db) => (
                  <button
                    key={db.tenant_id}
                    onClick={() => {
                      setDatabase(db.tenant_id);
                      setCollection("");
                      void loadCols(db.tenant_id);
                    }}
                    className={`flex w-full items-center justify-between rounded-md border border-solid px-3 py-2.5 text-left transition-colors ${
                      database === db.tenant_id
                        ? "border-brand-1 bg-accent-tint text-text-1"
                        : "border-stroke-1 bg-surface-2 text-text-2 hover:border-stroke-2"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <Icon name="database" size={14} className="shrink-0 text-brand-1" />
                      <span className="truncate font-mono text-[13px]">{db.label}</span>
                    </span>
                    {database === db.tenant_id ? (
                      <Icon name="check" size={14} className="shrink-0 text-brand-1" />
                    ) : null}
                  </button>
                ))}
              </div>
            </div>

            {database && collections.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-text-2">
                  Collection (optional)
                  {loadingCols ? <Spinner size={10} className="ml-2 inline" /> : null}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setCollection("")}
                    className={`rounded-md border border-solid px-2.5 py-1.5 text-xs transition-colors ${
                      collection === ""
                        ? "border-brand-1 bg-accent-tint text-text-1"
                        : "border-stroke-1 bg-surface-2 text-text-2 hover:border-stroke-2"
                    }`}
                  >
                    All collections
                  </button>
                  {collections.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCollection(c)}
                      className={`max-w-full truncate rounded-md border border-solid px-2.5 py-1.5 font-mono text-xs transition-colors ${
                        collection === c
                          ? "border-brand-1 bg-accent-tint text-text-1"
                          : "border-stroke-1 bg-surface-2 text-text-2 hover:border-stroke-2"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <button className="btn-primary w-full" onClick={save} disabled={!database}>
              <Icon name="check" size={14} />
              {database
                ? `Use ${dbOptions.find((d) => d.tenant_id === database)?.label ?? database}`
                : "Select a database"}
            </button>
          </div>
        ) : null}
      </div>

      {connected ? (
        <button
          onClick={() => setMode(null)}
          className="mt-3 w-full text-center text-xs text-fg-4 transition-colors hover:text-fg"
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}

export function ConnectGate() {
  return (
    <div className="h-full overflow-y-auto">
      {/* The form must be width-constrained here: it renders full-bleed
          otherwise, so on a wide screen the card stretched edge-to-edge while
          the heading above it stayed in a narrow column. */}
      <div className="mx-auto flex min-h-full w-full max-w-[420px] flex-col justify-center px-5 py-10">
        <ConnectForm />
      </div>
    </div>
  );
}