"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useHydra } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { cn, timeAgo, truncate } from "@/lib/utils";
import {
  ConfirmDialog,
  EmptyState,
  Modal,
  ProviderLogo,
  Skeleton,
} from "@/components/ui";
import { Icon, Spinner } from "@/components/Icon";
import { SyncIntervalControl } from "@/components/SyncIntervalControl";
import { formatInterval } from "@/lib/syncInterval";
import type { ConnectorInfo } from "@/lib/types";

const DASHBOARD_CONNECTORS_URL = "https://app.hydradb.com/connectors";

// ── helpers ───────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

async function parseErrorBody(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return fallback;
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (payload && typeof payload === "object") {
      const err = payload.error;
      if (typeof err === "string" && err.trim()) return err.trim();
      if (err && typeof err === "object") {
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === "string" && msg.trim()) return msg.trim();
      }
      if (typeof payload.detail === "string" && payload.detail.trim()) {
        return payload.detail.trim();
      }
      if (typeof payload.message === "string" && payload.message.trim()) {
        return payload.message.trim();
      }
    }
    return truncate(text, 300) || fallback;
  } catch {
    return truncate(text, 300) || fallback;
  }
}

// Words that should stay fully capitalised, not title-cased ("crm" -> "CRM").
const ACRONYMS = new Set(["crm", "url", "urls", "api", "id", "ids", "ai", "hr", "seo"]);

function titleCase(s?: string): string {
  if (!s) return "";
  return s
    .replace(/[_-]+/g, " ")
    .split(" ")
    .map((w) =>
      ACRONYMS.has(w.toLowerCase())
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ")
    .trim();
}

const LABEL_OVERRIDES: Record<string, string> = {
  twitter: "X (formerly Twitter)",
  ms_graph: "Microsoft Graph",
  bigquery: "BigQuery",
  zohod: "Zoho",
  attio: "Attio",
  workday_raas: "Workday",
  googlemail: "Gmail",
};

function providerLabel(provider?: string): string {
  if (!provider) return "Connector";
  const over = LABEL_OVERRIDES[provider.toLowerCase()];
  if (over) return over;
  return titleCase(provider);
}

interface CatalogEntry {
  provider: string;
  category?: string;
  is_alpha?: boolean;
  is_beta?: boolean;
  rank?: number;
  webhook_support?: boolean;
  moveit_support?: boolean;
}

function extractCatalog(payload: unknown): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  if (!payload || typeof payload !== "object") return out;
  const rec = payload as Record<string, unknown>;
  let raw: unknown = rec.connectors;
  if (!Array.isArray(raw)) raw = rec.catalog;
  if (!Array.isArray(raw)) raw = rec.data;
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const provider = [e.provider, e.value, e.name, e.label]
      .find((v): v is string => typeof v === "string" && Boolean(v.trim()))
      ?.trim()
      .toLowerCase();
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    out.push({
      provider,
      category: typeof e.category === "string" ? e.category : undefined,
      rank: typeof e.rank === "number" ? e.rank : undefined,
      is_alpha: Boolean(e.is_alpha),
      is_beta: Boolean(e.is_beta),
      webhook_support: Boolean(e.webhook_support),
      moveit_support: Boolean(e.moveit_support),
    });
  }
  return out;
}

interface CredentialProperty {
  type?: string;
  format?: string;
  description?: string;
}

interface CredentialSchema {
  properties: Record<string, CredentialProperty>;
  required: string[];
}

function extractSchema(payload: unknown): CredentialSchema | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  const props = rec.properties;
  if (!props || typeof props !== "object") return null;
  const properties: Record<string, CredentialProperty> = {};
  for (const [key, val] of Object.entries(props as Record<string, unknown>)) {
    if (!val || typeof val !== "object") {
      properties[key] = {};
      continue;
    }
    const v = val as Record<string, unknown>;
    properties[key] = {
      type: typeof v.type === "string" ? v.type : "string",
      format: typeof v.format === "string" ? v.format : undefined,
      description: typeof v.description === "string" ? v.description : undefined,
    };
  }
  const required = Array.isArray(rec.required)
    ? rec.required.filter((r): r is string => typeof r === "string")
    : [];
  return { properties, required };
}

interface DiscoveryResource {
  id: string;
  name: string;
  resource_type?: string;
}

function extractResources(payload: unknown): DiscoveryResource[] {
  const out: DiscoveryResource[] = [];
  if (!payload || typeof payload !== "object") return out;
  const rec = payload as Record<string, unknown>;
  let raw: unknown = rec.resources;
  if (!Array.isArray(raw)) {
    const data = rec.data;
    if (data && typeof data === "object") {
      raw = (data as Record<string, unknown>).resources;
    }
  }
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const id = [e.id, e.resource_id, e.key, e.identifier]
      .find((v): v is string => typeof v === "string" && Boolean(v.trim()))
      ?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof e.name === "string" && e.name.trim() ? e.name : id,
      resource_type: typeof e.resource_type === "string" ? e.resource_type : undefined,
    });
  }
  return out;
}

function findConnectorId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const rec = payload as Record<string, unknown>;
  for (const key of ["connector_id", "id"]) {
    if (typeof rec[key] === "string" && rec[key]) return rec[key] as string;
  }
  for (const maybe of ["connector", "data", "result", "record"]) {
    const inner = rec[maybe];
    if (!inner || typeof inner !== "object") continue;
    const found = findConnectorId(inner);
    if (found) return found;
  }
  return undefined;
}

function isNumericType(type?: string): boolean {
  return ["number", "integer"].includes((type ?? "string").toLowerCase());
}

function coerceValue(t: CredentialProperty, raw: string): string | number | boolean {
  if (isNumericType(t.type)) return raw === "" ? "" : Number(raw);
  if ((t.type ?? "").toLowerCase() === "boolean") return raw === "true";
  return raw;
}

function connectorStatus(c: ConnectorInfo): {
  label: string;
  tone: "good" | "warn" | "bad";
} {
  if (c.last_error) return { label: "error", tone: "bad" };
  if (c.sync_status === "syncing") return { label: "syncing", tone: "warn" };
  if (c.lifecycle === "ingesting") return { label: "ingesting", tone: "warn" };
  if (Number(c.resources_pending_first_sync ?? 0) > 0) {
    return { label: "first sync pending", tone: "warn" };
  }
  return { label: "active", tone: "good" };
}

const STATUS_DOT: Record<"good" | "warn" | "bad", string> = {
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
};

type Step = 1 | 2 | 3;

// ── page ──────────────────────────────────────────────────────────

export default function Page() {
  const hydra = useHydra();
  const toast = useToast();
  const hydraRef = useRef(hydra);
  useEffect(() => {
    hydraRef.current = hydra;
  });

  const config = hydra.config;
  const database = config.database?.trim() ?? "";

  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [toDelete, setToDelete] = useState<ConnectorInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [drawer, setDrawer] = useState<ConnectorInfo | null>(null);
  const [savingInterval, setSavingInterval] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [selectedProvider, setSelectedProvider] = useState<CatalogEntry | null>(null);
  const [schema, setSchema] = useState<CredentialSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaTick, setSchemaTick] = useState(0);

  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [showPass, setShowPass] = useState<Record<string, boolean>>({});
  const [credsError, setCredsError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const [pickerQuery, setPickerQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const [resources, setResources] = useState<DiscoveryResource[] | null>(null);
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [lookbackDays, setLookbackDays] = useState(90);
  const [collectionInput, setCollectionInput] = useState("");
  const [creating, setCreating] = useState(false);
  const schemaRef = useRef<string | null>(null);

  const loadConnectors = useCallback(async () => {
    try {
      const data = await hydraRef.current.connectors();
      setConnectors(Array.isArray(data.connectors) ? data.connectors : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const res = await hydraRef.current.raw("/connector-catalog");
      if (!res.ok) {
        throw new Error(await parseErrorBody(res, `Catalog request failed (${res.status})`));
      }
      const payload = await res.json().catch(() => null);
      const entries = extractCatalog(payload);
      if (entries.length === 0) {
        throw new Error("Connector catalog returned no providers — try again in a moment.");
      }
      entries.sort(
        (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
      );
      setCatalog(entries);
    } catch (err) {
      setCatalogError(errMsg(err));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnectors();
    void loadCatalog();
  }, [loadConnectors, loadCatalog]);

  useEffect(() => {
    if (!modalOpen || step !== 2 || !selectedProvider) return;
    if (schemaRef.current === selectedProvider.provider) return;
    let alive = true;
    const run = async () => {
      try {
        const res = await hydraRef.current.raw(
          `/connector-catalog/${encodeURIComponent(selectedProvider.provider)}/credential-schema`,
        );
        if (!res.ok) {
          throw new Error(await parseErrorBody(res, `Schema request failed (${res.status})`));
        }
        const payload = await res.json().catch(() => null);
        const s = extractSchema(payload);
        if (!s) throw new Error("No credential schema returned for this provider.");
        if (alive) {
          schemaRef.current = selectedProvider.provider;
          setSchema(s);
        }
      } catch (err) {
        if (alive) setSchemaError(errMsg(err));
      } finally {
        if (alive) setSchemaLoading(false);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [modalOpen, step, selectedProvider, schemaTick]);

  const openConnect = useCallback((p?: CatalogEntry) => {
    if (p) {
      if (p.provider !== schemaRef.current) {
        schemaRef.current = null;
        setSchema(null);
        setSchemaError(null);
        setSchemaLoading(true);
      }
      setCredentials({});
      setShowPass({});
    }
    setSelectedProvider(p ?? null);
    setStep(p ? 2 : 1);
    setResources(null);
    setSelectedResources([]);
    setCredsError(null);
    setPickerQuery("");
    setCategoryFilter(null);
    setLookbackDays(90);
    setCollectionInput(hydraRef.current.config.collection?.trim() ?? "");
    setModalOpen(true);
  }, []);

  const closeConnect = useCallback(() => {
    setModalOpen(false);
    setStep(1);
    setSelectedProvider(null);
    setCredentials({});
    setShowPass({});
    setResources(null);
    setSelectedResources([]);
    setCredsError(null);
  }, []);

  const pickProvider = (p: CatalogEntry) => {
    const providerChanged = p.provider !== selectedProvider?.provider;
    if (providerChanged) {
      setCredentials({});
      setShowPass({});
    }
    if (providerChanged || schemaRef.current !== p.provider) {
      schemaRef.current = null;
      setSchema(null);
      setSchemaError(null);
      setSchemaLoading(true);
    }
    setSelectedProvider(p);
    setStep(2);
    setCredsError(null);
  };

  const q = query.trim().toLowerCase();

  const connectedProviders = useMemo(
    () => new Set(connectors.map((c) => (c.provider ?? "").toLowerCase())),
    [connectors],
  );

  const filteredConnected = useMemo(() => {
    const list = q
      ? connectors.filter((c) => {
          const label = providerLabel(c.provider).toLowerCase();
          const slug = (c.provider ?? "").toLowerCase();
          return label.includes(q) || slug.includes(q);
        })
      : [...connectors];
    // Alphabetical by provider, then by connector id for stability.
    return list.sort((a, b) =>
      providerLabel(a.provider).localeCompare(providerLabel(b.provider)),
    );
  }, [connectors, q]);

  const filteredCatalog = useMemo(() => {
    const list = q
      ? catalog.filter((c) => {
          const label = providerLabel(c.provider).toLowerCase();
          return (
            label.includes(q) ||
            c.provider.includes(q) ||
            (c.category ?? "").toLowerCase().includes(q)
          );
        })
      : [...catalog];
    // Connected providers float to the top, then catalog rank.
    return list.sort((a, b) => {
      const aConnected = connectedProviders.has((a.provider ?? "").toLowerCase()) ? 0 : 1;
      const bConnected = connectedProviders.has((b.provider ?? "").toLowerCase()) ? 0 : 1;
      if (aConnected !== bConnected) return aConnected - bConnected;
      return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
    });
  }, [catalog, q, connectedProviders]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const c of catalog) if (c.category?.trim()) set.add(titleCase(c.category));
    return [...set].sort();
  }, [catalog]);

  const pickerEntries = useMemo(() => {
    const pq = pickerQuery.trim().toLowerCase();
    return catalog.filter((c) => {
      if (categoryFilter && titleCase(c.category) !== categoryFilter) return false;
      if (!pq) return true;
      const label = providerLabel(c.provider).toLowerCase();
      return label.includes(pq) || c.provider.includes(pq);
    });
  }, [catalog, pickerQuery, categoryFilter]);

  const triggerSync = async (c: ConnectorInfo) => {
    if (syncingIds.has(c.connector_id)) return;
    setSyncingIds((prev) => new Set(prev).add(c.connector_id));
    try {
      const res = await hydraRef.current.raw(
        `/connectors/${encodeURIComponent(c.connector_id)}/sync`,
        { method: "POST" },
      );
      if (!res.ok) {
        throw new Error(await parseErrorBody(res, `Sync request failed (${res.status})`));
      }
      toast.push({
        kind: "success",
        title: "Sync started",
        detail: `${providerLabel(c.provider)} is syncing — status refreshes shortly.`,
      });
      window.setTimeout(() => void loadConnectors(), 2000);
    } catch (err) {
      toast.push({ kind: "error", title: "Sync failed", detail: errMsg(err) });
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(c.connector_id);
        return next;
      });
    }
  };

  /** PATCH the connector's sync cadence (dashboard-2.0 SyncIntervalControl). */
  const saveInterval = async (c: ConnectorInfo, seconds: number) => {
    setSavingInterval(true);
    try {
      const res = await hydraRef.current.raw(`/connectors/${encodeURIComponent(c.connector_id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sync_interval_seconds: seconds }),
      });
      if (!res.ok) {
        throw new Error(await parseErrorBody(res, `Could not save (${res.status})`));
      }
      // Reflect the new cadence locally without a refetch.
      setConnectors((prev) =>
        prev.map((x) =>
          x.connector_id === c.connector_id ? { ...x, sync_interval_seconds: seconds } : x,
        ),
      );
      setDrawer((prev) =>
        prev && prev.connector_id === c.connector_id
          ? { ...prev, sync_interval_seconds: seconds }
          : prev,
      );
    } finally {
      setSavingInterval(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await hydraRef.current.raw(
        `/connectors/${encodeURIComponent(toDelete.connector_id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        throw new Error(await parseErrorBody(res, `Delete request failed (${res.status})`));
      }
      toast.push({
        kind: "success",
        title: "Connector deleted",
        detail: `${providerLabel(toDelete.provider)} disconnected.`,
      });
      setToDelete(null);
      void loadConnectors();
    } catch (err) {
      toast.push({ kind: "error", title: "Delete failed", detail: errMsg(err) });
    } finally {
      setDeleting(false);
    }
  };

  const buildCredentials = useCallback((): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(credentials)) {
      if (v === "") continue;
      const prop = schema?.properties[k];
      out[k] = prop ? coerceValue(prop, v) : v;
    }
    return out;
  }, [credentials, schema]);

  const verifyCredentials = async () => {
    if (!selectedProvider) return;
    if (!database) {
      setCredsError("No database configured — set one in Settings first.");
      return;
    }
    if (schema) {
      const missing = schema.required.filter((k) => !(credentials[k] ?? "").trim());
      if (missing.length > 0) {
        setCredsError(
          `Missing required field${missing.length > 1 ? "s" : ""}: ${missing
            .map(titleCase)
            .join(", ")}`,
        );
        return;
      }
    }
    setVerifying(true);
    setCredsError(null);
    try {
      const res = await hydraRef.current.raw("/connector-discovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider.provider,
          database,
          auth_type: "api_token",
          credentials: buildCredentials(),
        }),
      });
      if (!res.ok) {
        throw new Error(await parseErrorBody(res, `Verification failed (${res.status})`));
      }
      const payload = await res.json().catch(() => null);
      const found = extractResources(payload);
      setResources(found);
      setSelectedResources(found.map((r) => r.id));
      setStep(3);
    } catch (err) {
      setCredsError(errMsg(err));
    } finally {
      setVerifying(false);
    }
  };

  const createConnector = async () => {
    if (!selectedProvider) return;
    if (!database) {
      setCredsError("No database configured — set one in Settings first.");
      return;
    }
    setCreating(true);
    setCredsError(null);
    try {
      const body: Record<string, unknown> = {
        provider: selectedProvider.provider,
        auth_type: "api_token",
        credentials: buildCredentials(),
        database,
      };
      if (collectionInput.trim()) body.collection = collectionInput.trim();
      else if (config.collection?.trim()) body.collection = config.collection.trim();

      const res = await hydraRef.current.raw("/connectors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(await parseErrorBody(res, `Create request failed (${res.status})`));
      }
      const payload = await res.json().catch(() => null);
      const id = findConnectorId(payload);
      if (!id) {
        throw new Error("Connector created but returned no id — refresh the page to see it.");
      }

      try {
        const cfgRes = await hydraRef.current.raw(
          `/connectors/${encodeURIComponent(id)}/configure`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              lookback_days: Math.max(0, Number.isFinite(lookbackDays) ? lookbackDays : 0),
              resources: selectedResources.map((rid) => ({ resource_id: rid })),
            }),
          },
        );
        if (!cfgRes.ok) {
          throw new Error(await parseErrorBody(cfgRes, `Sync setup failed (${cfgRes.status})`));
        }
      } catch (cfgErr) {
        toast.push({
          kind: "error",
          title: "Connected — sync not started",
          detail: errMsg(cfgErr),
        });
        closeConnect();
        void loadConnectors();
        return;
      }

      toast.push({
        kind: "success",
        title: "Connected — started syncing",
        detail: `${providerLabel(selectedProvider.provider)} is now syncing into your database.`,
      });
      closeConnect();
      void loadConnectors();
    } catch (err) {
      setCredsError(errMsg(err));
      toast.push({ kind: "error", title: "Connect failed", detail: errMsg(err) });
    } finally {
      setCreating(false);
    }
  };

  const back = () => setStep((prev) => (Math.max(1, prev - 1) as Step));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-pixel text-[28px] font-normal leading-tight text-text-3">Integrations</h1>
          <p className="mt-1.5 text-[13px] text-fg-3">
            Connect the apps you work in. Hydra syncs them into your database.
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="relative flex-1 sm:w-[240px] sm:flex-none">
            <Icon
              name="search"
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-4"
            />
            <input
              className="input pl-8 text-[12.5px]"
              aria-label="Search connections and apps"
              placeholder="Search connections & apps…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="btn-primary shrink-0" onClick={() => openConnect()}>
            <Icon name="plus" size={14} />
            Connect
          </button>
        </div>
      </div>

      <section className="mb-7">
        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-fg-3">
            Connected
          </h2>
          <span className="rounded-xs border border-line bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-3">
            {loading ? "…" : filteredConnected.length}
          </span>
        </div>

        {loading && connectors.length === 0 ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[150px]" />
            ))}
          </div>
        ) : null}

        {!loading && loadError ? (
          <div className="flex flex-wrap items-center gap-3 rounded-sm border border-bad/30 bg-bad-fill px-3 py-2.5">
            <Icon name="alert" size={13} className="shrink-0 text-bad" />
            <span className="min-w-0 flex-1 text-[12px] text-bad">
              {truncate(loadError, 180)}
            </span>
            <button
              className="btn-soft h-7 px-2.5 text-[11.5px]"
              onClick={() => void loadConnectors()}
            >
              <Icon name="refresh" size={12} />
              Retry
            </button>
          </div>
        ) : null}

        {!loading && !loadError && filteredConnected.length === 0 ? (
          connectors.length === 0 ? (
            <EmptyState
              icon="plug"
              title="No connections yet"
              message="Connect your first app and Hydra starts syncing it into your database."
              className="rounded border border-dashed border-line bg-bg-2/40"
              action={
                <button className="btn-primary" onClick={() => openConnect()}>
                  <Icon name="plus" size={14} />
                  Connect an app
                </button>
              }
            />
          ) : (
            <EmptyState
              icon="search"
              title="No matches"
              message={`Nothing found for "${query}" in your connections.`}
              className="rounded border border-dashed border-line bg-bg-2/40"
            />
          )
        ) : null}

        {!loading && !loadError && filteredConnected.length > 0 ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {filteredConnected.map((c) => {
              const label = providerLabel(c.provider) || "Connector";
              const scope = String(
                c.collection ?? c.database ?? c.sub_tenant_id ?? c.tenant_id ?? "",
              );
              const isSyncingNow = syncingIds.has(c.connector_id);
              const { label: statusLabel, tone } = connectorStatus(c);
              const pulse =
                c.sync_status === "syncing" || c.lifecycle === "ingesting" || isSyncingNow;
              const lastSync =
                typeof c.last_successful_sync_at === "string"
                  ? c.last_successful_sync_at
                  : undefined;
              const docs = Number(c.documents_dispatched ?? 0);
              const pendingFirstSync = Number(c.resources_pending_first_sync ?? 0);
              // "first sync pending · Synced 1d ago" read as a contradiction.
              // Both facts are true — some resources have synced, others have
              // never run — so say that instead of putting the two beside each
              // other and leaving the reader to reconcile them.
              const syncMeta =
                pendingFirstSync > 0
                  ? lastSync
                    ? `${pendingFirstSync} awaiting first sync · last synced ${timeAgo(lastSync)}`
                    : `${pendingFirstSync} awaiting first sync`
                  : lastSync
                    ? `Synced ${timeAgo(lastSync)}`
                    : "";
              const meta = [syncMeta, docs > 0 ? `${docs.toLocaleString()} docs` : ""]
                .filter(Boolean)
                .join(" · ");
              return (
                <div
                  key={c.connector_id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDrawer(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDrawer(c);
                    }
                  }}
                  className="card flex cursor-pointer flex-col p-3.5 transition-colors hover:border-stroke-3"
                >
                  <div className="flex items-center gap-2.5">
                    <ProviderLogo id={c.provider} size={34} />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-fg">{label}</p>
                      {scope ? (
                        <p
                          className="mt-0.5 truncate font-mono text-[10.5px] text-fg-4"
                          title={scope}
                        >
                          {scope}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div
                    className="mt-2.5 flex min-w-0 items-center gap-1.5"
                    title={c.last_error ? `Last error: ${c.last_error}` : undefined}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        STATUS_DOT[tone],
                        pulse && "animate-pulse",
                      )}
                    />
                    <span className="truncate text-[11.5px] text-fg-3">{statusLabel}</span>
                    {c.last_error ? (
                      <Icon name="alert" size={11} className="shrink-0 text-bad" />
                    ) : null}
                  </div>

                  {meta ? (
                    <p className="mt-1 truncate text-[11.5px] text-fg-4">{meta}</p>
                  ) : (
                    <p className="mt-1 text-[11.5px] text-fg-4">Not synced yet</p>
                  )}

                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
                    <button
                      className="inline-flex h-7 items-center gap-1 rounded-sm border border-line bg-bg-2 px-2.5 text-[11.5px] font-medium text-fg-2 transition-colors hover:border-stroke-3 hover:bg-inset hover:text-fg"
                      disabled={isSyncingNow}
                      onClick={(e) => {
                        e.stopPropagation();
                        void triggerSync(c);
                      }}
                    >
                      {isSyncingNow ? <Spinner size={12} /> : <Icon name="refresh" size={12} />}
                      {isSyncingNow ? "Syncing…" : "Sync now"}
                    </button>
                    <button
                      className="inline-flex h-7 items-center gap-1 rounded-sm px-2.5 text-[11.5px] font-medium text-fg-4 transition-colors hover:bg-bad-fill hover:text-bad"
                      onClick={(e) => {
                        e.stopPropagation();
                        setToDelete(c);
                      }}
                    >
                      <Icon name="trash" size={12} />
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section>
        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-fg-3">
            Available apps
          </h2>
          {catalog.length > 0 ? (
            <span className="rounded-xs border border-line bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-3">
              {filteredCatalog.length}
            </span>
          ) : null}
        </div>

        {catalogLoading ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[96px]" />
            ))}
          </div>
        ) : null}

        {!catalogLoading && catalogError ? (
          <div className="flex flex-wrap items-center gap-3 rounded-sm border border-bad/30 bg-bad-fill px-3 py-2.5">
            <Icon name="alert" size={13} className="shrink-0 text-bad" />
            <span className="min-w-0 flex-1 text-[12px] text-bad">
              {truncate(catalogError, 240)}
            </span>
            <button
              className="btn-soft h-7 px-2.5 text-[11.5px]"
              onClick={() => {
                setCatalogLoading(true);
                setCatalogError(null);
                void loadCatalog();
              }}
            >
              <Icon name="refresh" size={12} />
              Retry
            </button>
          </div>
        ) : null}

        {!catalogLoading && !catalogError && filteredCatalog.length === 0 ? (
          <EmptyState
            icon="search"
            title="No apps match"
            message={`Nothing found for "${query}". Try a different name.`}
            className="rounded border border-dashed border-line bg-bg-2/40"
          />
        ) : null}

        {!catalogLoading && !catalogError && filteredCatalog.length > 0 ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {filteredCatalog.map((entry) => (
              <div
                key={entry.provider}
                className="card card-hover flex min-h-[96px] flex-col gap-2 p-3.5"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <ProviderLogo id={entry.provider} size={30} />
                  <p className="min-w-0 truncate text-[13px] font-medium text-fg">
                    {providerLabel(entry.provider)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {entry.category ? (
                    <span className="rounded-xs border border-line bg-bg-2 px-1.5 py-0.5 text-[10.5px] font-medium text-fg-3">
                      {titleCase(entry.category)}
                    </span>
                  ) : null}
                  {entry.is_beta ? (
                    <span className="rounded-xs border border-warn/30 bg-warn-fill px-1.5 py-0.5 text-[10.5px] font-medium text-warn">
                      Beta
                    </span>
                  ) : null}
                  {!entry.is_beta && entry.is_alpha ? (
                    <span className="rounded-xs border border-line px-1.5 py-0.5 text-[10.5px] font-medium text-fg-4">
                      Alpha
                    </span>
                  ) : null}
                </div>
                <button
                  className="btn-soft mt-auto w-full"
                  onClick={() => openConnect(entry)}
                >
                  Connect
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      </div>

      <Modal
        open={modalOpen}
        onClose={closeConnect}
        width={600}
        title={
          step === 1
            ? "Connect an app"
            : selectedProvider
              ? `${providerLabel(selectedProvider.provider)} — ${step === 2 ? "credentials" : "resources"}`
              : "Connect an app"
        }
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <a
              href={DASHBOARD_CONNECTORS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11.5px] text-fg-4 transition-colors hover:text-accent"
            >
              Or set up in the Hydra dashboard →
            </a>
            <div className="flex items-center gap-2">
              {step > 1 ? (
                <button className="btn-ghost h-8" onClick={back}>
                  Back
                </button>
              ) : null}
              {step === 2 ? (
                <button
                  className="btn-primary h-8"
                  disabled={verifying || !database || schemaLoading}
                  onClick={() => void verifyCredentials()}
                >
                  {verifying ? <Spinner size={13} /> : null}
                  {verifying ? "Verifying…" : "Verify & continue"}
                </button>
              ) : null}
              {step === 3 ? (
                <button
                  className="btn-primary h-8"
                  disabled={creating || !database}
                  onClick={() => void createConnector()}
                >
                  {creating ? <Spinner size={13} /> : null}
                  {creating ? "Connecting…" : "Create connector"}
                </button>
              ) : null}
            </div>
          </div>
        }
      >
        {!database ? (
          <div className="mb-3 flex items-start gap-2 rounded-sm border border-warn/30 bg-warn-fill px-3 py-2.5">
            <Icon name="alert" size={13} className="mt-0.5 shrink-0 text-warn" />
            <p className="text-[12px] leading-relaxed text-warn">
              Set your Hydra database in{" "}
              <Link href="/settings" className="font-medium underline underline-offset-2">
                Settings
              </Link>{" "}
              before connecting.
            </p>
          </div>
        ) : null}

        {step === 1 ? (
          <div>
            {catalogError && catalog.length === 0 ? (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-sm border border-bad/30 bg-bad-fill px-3 py-2.5">
                <Icon name="alert" size={13} className="shrink-0 text-bad" />
                <span className="min-w-0 flex-1 break-words text-[12px] text-bad">
                  {truncate(catalogError, 240)}
                </span>
                <button
                  className="btn-soft h-7 px-2.5 text-[11.5px]"
                  onClick={() => {
                    setCatalogLoading(true);
                    setCatalogError(null);
                    void loadCatalog();
                  }}
                >
                  <Icon name="refresh" size={12} />
                  Retry
                </button>
              </div>
            ) : null}
            <div className="relative mb-3">
              <Icon
                name="search"
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-4"
              />
              <input
                className="input pl-8 text-[12.5px]"
                aria-label="Search apps"
              placeholder="Search apps…"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
              />
            </div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              <button
                className={cn(
                  "rounded-xs border px-2 py-1 text-[11px] font-medium transition-colors",
                  categoryFilter === null
                    ? "border-accent-line bg-accent-tint text-accent"
                    : "border-line bg-bg-2 text-fg-3 hover:text-fg",
                )}
                onClick={() => setCategoryFilter(null)}
              >
                All
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  className={cn(
                    "rounded-xs border px-2 py-1 text-[11px] font-medium transition-colors",
                    categoryFilter === cat
                      ? "border-accent-line bg-accent-tint text-accent"
                      : "border-line bg-bg-2 text-fg-3 hover:text-fg",
                  )}
                  onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
            {pickerEntries.length === 0 ? (
              <EmptyState
                icon="search"
                title="No apps match"
                message={
                  pickerQuery
                    ? `Nothing for "${pickerQuery}" — try another name.`
                    : "Nothing in this category yet."
                }
                className="rounded border border-dashed border-line bg-bg-2/40"
              />
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {pickerEntries.map((entry) => (
                  <button
                    key={entry.provider}
                    className="card flex flex-col items-center gap-1.5 p-3 transition-colors hover:border-stroke-3"
                    onClick={() => pickProvider(entry)}
                  >
                    <ProviderLogo id={entry.provider} size={32} />
                    <span className="w-full truncate text-center text-[12px] font-medium text-fg">
                      {providerLabel(entry.provider)}
                    </span>
                    <span className="flex flex-wrap items-center justify-center gap-1">
                      {entry.category ? (
                        <span className="rounded-xs border border-line bg-bg-2 px-1.5 py-0.5 text-[9.5px] font-medium text-fg-3">
                          {titleCase(entry.category)}
                        </span>
                      ) : null}
                      {entry.is_beta ? (
                        <span className="rounded-xs border border-warn/30 bg-warn-fill px-1.5 py-0.5 text-[9.5px] font-medium text-warn">
                          Beta
                        </span>
                      ) : null}
                      {!entry.is_beta && entry.is_alpha ? (
                        <span className="rounded-xs border border-line px-1.5 py-0.5 text-[9.5px] font-medium text-fg-4">
                          Alpha
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {step === 2 && selectedProvider ? (
          <div>
            <div className="mb-3 flex items-center gap-2.5">
              <ProviderLogo id={selectedProvider.provider} size={30} />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-fg">
                  {providerLabel(selectedProvider.provider)}
                </p>
                {selectedProvider.category ? (
                  <p className="text-[11px] text-fg-3">{titleCase(selectedProvider.category)}</p>
                ) : null}
              </div>
            </div>
            <p className="mb-3 text-[11.5px] text-fg-4">
              Credentials go straight to Hydra DB — the discovery endpoint validates them.
              Open Glean never stores them locally.
            </p>

            {schemaLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-[36px]" />
                <Skeleton className="h-[36px]" />
                <Skeleton className="h-[36px] w-2/3" />
              </div>
            ) : schemaError ? (
              <div className="flex flex-wrap items-center gap-3 rounded-sm border border-bad/30 bg-bad-fill px-3 py-2.5">
                <Icon name="alert" size={13} className="shrink-0 text-bad" />
                <span className="min-w-0 flex-1 break-words text-[12px] text-bad">
                  {truncate(schemaError, 240)}
                </span>
                <button
                  className="btn-soft h-7 px-2.5 text-[11.5px]"
                  onClick={() => {
                    schemaRef.current = null;
                    setSchemaLoading(true);
                    setSchemaError(null);
                    setSchemaTick((t) => t + 1);
                  }}
                >
                  <Icon name="refresh" size={12} />
                  Retry
                </button>
              </div>
            ) : schema && Object.keys(schema.properties).length > 0 ? (
              <div className="space-y-3">
                {Object.entries(schema.properties).map(([key, prop]) => {
                  const isRequired = schema.required.includes(key);
                  const isPass = prop.format === "password";
                  const show = Boolean(showPass[key]);
                  const isBool = (prop.type ?? "").toLowerCase() === "boolean";
                  return (
                    <label key={key} className="block">
                      <span className="mb-1.5 block text-[12px] font-medium text-fg-2">
                        {titleCase(key)}
                        {isRequired ? <span className="text-accent"> *</span> : null}
                      </span>
                      {isBool ? (
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-accent"
                          checked={credentials[key] === "true"}
                          onChange={(e) =>
                            setCredentials((prev) => ({ ...prev, [key]: String(e.target.checked) }))
                          }
                        />
                      ) : (
                        <div className="relative">
                          <input
                            className="input pr-9 text-[12.5px]"
                            type={isPass && !show ? "password" : "text"}
                            value={credentials[key] ?? ""}
                            placeholder={isRequired ? "Required" : "Optional"}
                            autoComplete={isPass ? "new-password" : "off"}
                            onChange={(e) =>
                              setCredentials((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                          />
                          {isPass ? (
                            <button
                              type="button"
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-fg-4 transition-colors hover:text-fg"
                              onClick={() =>
                                setShowPass((prev) => ({ ...prev, [key]: !prev[key] }))
                              }
                              aria-label={show ? "Hide credentials" : "Show credentials"}
                            >
                              <Icon name={show ? "eyeOff" : "eye"} size={14} />
                            </button>
                          ) : null}
                        </div>
                      )}
                      {prop.description ? (
                        <span className="mt-1 block text-[11px] leading-relaxed text-fg-4">
                          {prop.description}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            ) : schema ? (
              <p className="text-[12px] text-fg-4">
                This provider needs no credentials — verify and continue.
              </p>
            ) : null}

            {credsError && step === 2 ? (
              <div className="mt-3 flex items-start gap-2 rounded-sm border border-bad/30 bg-bad-fill px-3 py-2.5">
                <Icon name="alert" size={13} className="mt-0.5 shrink-0 text-bad" />
                <p className="min-w-0 flex-1 break-words text-[12px] leading-relaxed text-bad">
                  {credsError}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-3.5">
            <div className="flex items-center gap-2.5">
              <ProviderLogo id={selectedProvider?.provider} size={30} />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-fg">
                  {providerLabel(selectedProvider?.provider)}
                </p>
                <p className="truncate font-mono text-[10.5px] text-fg-4">{database}</p>
              </div>
            </div>

            {resources && resources.length > 0 ? (
              <div>
                <p className="mb-1.5 text-[12px] font-medium text-fg-2">
                  Resources ({resources.length})
                </p>
                <div className="max-h-[220px] overflow-y-auto rounded-sm border border-line bg-bg-2">
                  {resources.map((r) => (
                    <label
                      key={r.id}
                      className="flex cursor-pointer items-center gap-2.5 border-b border-line px-3 py-2 text-[12.5px] last:border-b-0 hover:bg-bg-3"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-accent"
                        checked={selectedResources.includes(r.id)}
                        onChange={(e) =>
                          setSelectedResources((prev) =>
                            e.target.checked
                              ? [...prev, r.id]
                              : prev.filter((x) => x !== r.id),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 truncate text-fg">{r.name}</span>
                      {r.resource_type ? (
                        <span className="shrink-0 rounded-xs border border-line bg-bg-3 px-1.5 py-0.5 font-mono text-[9.5px] text-fg-4">
                          {titleCase(r.resource_type)}
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </div>
            ) : resources ? (
              <p className="rounded-sm border border-line bg-bg-2 px-3 py-2.5 text-[12px] leading-relaxed text-fg-3">
                No selectable resources found for this account — the connector will be created
                without resource filters and sync everything it can.
              </p>
            ) : (
              <div className="flex items-center gap-2 text-[12px] text-fg-3">
                <Spinner size={12} />
                Loading resources…
              </div>
            )}

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-fg-2">
                  Look back (days)
                </span>
                <input
                  className="input text-[12.5px]"
                  type="number"
                  min={0}
                  value={lookbackDays}
                  onChange={(e) => {
                    const v = e.target.valueAsNumber;
                    setLookbackDays(Number.isNaN(v) ? 0 : v);
                  }}
                />
                <span className="mt-1 block text-[11px] text-fg-4">
                  How far back to import history.
                </span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-fg-2">
                  Collection
                </span>
                <input
                  className="input text-[12.5px]"
                  placeholder={config.collection?.trim() ? config.collection : "default collection"}
                  value={collectionInput}
                  onChange={(e) => setCollectionInput(e.target.value)}
                />
                <span className="mt-1 block text-[11px] text-fg-4">
                  Optional sub-tenant scope to sync into.
                </span>
              </label>
            </div>

            {credsError ? (
              <div className="flex items-start gap-2 rounded-sm border border-bad/30 bg-bad-fill px-3 py-2.5">
                <Icon name="alert" size={13} className="mt-0.5 shrink-0 text-bad" />
                <p className="min-w-0 flex-1 break-words text-[12px] leading-relaxed text-bad">
                  {credsError}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* Connector modal (dashboard-2.0 pattern): sync cadence + details */}
      <Modal
        open={Boolean(drawer)}
        onClose={() => setDrawer(null)}
        width={440}
      >
        {drawer ? (
          <div className="flex flex-col">
            <div className="mb-4 flex items-center justify-between border-b border-solid border-stroke-1 pb-3.5">
              <div className="flex items-center gap-2.5">
                <ProviderLogo id={drawer.provider} size={30} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-1">
                    {providerLabel(drawer.provider) || "Connector"}
                  </p>
                  <p className="truncate font-mono text-[10.5px] text-fg-4">
                    {String(drawer.collection ?? drawer.database ?? "")}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setDrawer(null)}
                className="rounded-md p-1.5 text-fg-4 transition-colors hover:bg-surface-7 hover:text-text-1"
                aria-label="Close"
              >
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="flex-1 space-y-5 p-4">
              {/* Status */}
              <section>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-2">
                  Status
                </p>
                {(() => {
                  const { label, tone } = connectorStatus(drawer);
                  const pulse =
                    drawer.sync_status === "syncing" ||
                    drawer.lifecycle === "ingesting" ||
                    syncingIds.has(drawer.connector_id);
                  return (
                    <div className="space-y-1.5 text-xs text-text-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn("h-2 w-2 rounded-full", STATUS_DOT[tone], pulse && "animate-pulse")}
                        />
                        <span className="capitalize">{label}</span>
                      </div>
                      <p>
                        Cadence:{" "}
                        <span className="font-mono text-text-1">
                          {formatInterval(Number(drawer.sync_interval_seconds ?? 3600))}
                        </span>
                      </p>
                      {drawer.last_successful_sync_at ? (
                        <p>Last sync: {timeAgo(drawer.last_successful_sync_at)}</p>
                      ) : (
                        <p>Not synced yet</p>
                      )}
                      {drawer.next_sync_at ? <p>Next sync: {timeAgo(drawer.next_sync_at)}</p> : null}
                      {Number(drawer.documents_dispatched ?? 0) > 0 ? (
                        <p>{Number(drawer.documents_dispatched).toLocaleString()} docs dispatched</p>
                      ) : null}
                      {Number(drawer.active_resource_count ?? 0) > 0 ? (
                        <p>{Number(drawer.active_resource_count)} resources</p>
                      ) : null}
                      {drawer.last_error ? (
                        <p className="rounded-md border border-solid border-bad/30 bg-bad-fill px-2.5 py-2 text-error-1">
                          {drawer.last_error}
                        </p>
                      ) : null}
                    </div>
                  );
                })()}
              </section>

              {/* Sync cadence */}
              <section>
                <SyncIntervalControl
                  provider={drawer.provider}
                  value={Number(drawer.sync_interval_seconds ?? 0)}
                  disabled={savingInterval}
                  onSave={(seconds) => saveInterval(drawer, seconds)}
                />
              </section>

              {/* Actions */}
              <section className="flex flex-col gap-2 border-t border-solid border-stroke-1 pt-4">
                <button
                  className="btn-soft w-full"
                  disabled={syncingIds.has(drawer.connector_id)}
                  onClick={() => void triggerSync(drawer)}
                >
                  <Icon name="refresh" size={13} />
                  {syncingIds.has(drawer.connector_id) ? "Syncing…" : "Sync now"}
                </button>
                <button
                  className="btn-ghost w-full hover:!text-error-1"
                  onClick={() => {
                    setToDelete(drawer);
                    setDrawer(null);
                  }}
                >
                  <Icon name="trash" size={13} />
                  Delete connector
                </button>
              </section>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
        title="Delete connector"
        message={
          toDelete
            ? `Remove ${providerLabel(toDelete.provider) || "this connector"} from your workspace? Sync stops and the connector is deleted in Hydra DB — your data stays.`
            : ""
        }
        confirmLabel="Delete"
      />
    </div>
  );
}