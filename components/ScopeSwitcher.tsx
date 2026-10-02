"use client";

/**
 * ScopeSwitcher — Database and Collection selector topbar pill.
 *
 * Ported directly from Hydra DB Dashboard 2.0 (`ScopeSwitcher.tsx`).
 * Allows instant switching across databases and collections anywhere in the app.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, Spinner } from "@/components/Icon";
import { useAppConfig } from "@/lib/store/config";
import { useHydra } from "@/lib/api";
import { Modal } from "@/components/ui";

interface DbOption {
  tenant_id: string;
  organisation?: string;
}

export function ScopeSwitcher({ className = "" }: { className?: string }) {
  const { config, setConfig } = useAppConfig();
  const hydra = useHydra();

  const [open, setOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [qDb, setQDb] = useState("");
  const [qCol, setQCol] = useState("");

  const [databases, setDatabases] = useState<DbOption[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [loadingCols, setLoadingCols] = useState(false);

  const ref = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedDb = config.database ?? "";
  const selectedCol = config.collection ?? "";
  const selectedCols = config.collections ?? [];

  // Load databases when popover opens or on mount
  const loadDatabases = useCallback(async () => {
    setLoadingDbs(true);
    try {
      const res = await hydra.listDatabases();
      setDatabases(res.tenants ?? []);
      if (!selectedDb && res.tenants && res.tenants.length > 0) {
        setConfig({ database: res.tenants[0]!.tenant_id });
      }
    } catch {
      // ignore
    } finally {
      setLoadingDbs(false);
    }
  }, [hydra, selectedDb, setConfig]);

  /**
   * Load collections for a database, ignoring stale responses.
   *
   * Without the generation guard, clicking database A then B while A is slow
   * let A's late response overwrite B's list. The UI then showed B selected
   * with A's collections, and picking one wrote a collection that does not
   * exist in the active database — silent wrong-scope retrieval, no error.
   */
  const colRequest = useRef(0);
  const loadCollections = useCallback(
    async (db: string) => {
      const generation = ++colRequest.current;
      if (!db) {
        setCollections([]);
        return;
      }
      setLoadingCols(true);
      try {
        const res = await hydra.listCollections(db);
        if (generation !== colRequest.current) return; // superseded
        setCollections(res.sub_tenant_ids ?? []);
      } catch {
        if (generation === colRequest.current) setCollections([]);
      } finally {
        if (generation === colRequest.current) setLoadingCols(false);
      }
    },
    [hydra],
  );

  // Select a default database on mount, once, when none is set yet.
  //
  // On an env-key deployment the connect screen is skipped, so nothing ever set
  // config.database. Without this the top-bar pill read "Select database" and
  // Context/Mindmap looked empty, even though search already fell back to the
  // first tenant. Auto-select it so the label matches what search actually uses.
  const didMountLoad = useRef(false);
  useEffect(() => {
    if (didMountLoad.current || selectedDb) return;
    didMountLoad.current = true;
    void loadDatabases();
  }, [selectedDb, loadDatabases]);

  // Load on open.
  //
  // `selectedDb` used to be a dependency, and loadDatabases closes over it, so
  // every database pick re-ran this: a redundant full database refetch, a
  // duplicate collections request (handlePickDb already issues one), and the
  // focus steal below firing again mid-interaction.
  const openRef = useRef(open);
  useEffect(() => {
    const justOpened = open && !openRef.current;
    openRef.current = open;
    if (!justOpened) return;
    void loadDatabases();
    if (selectedDb) void loadCollections(selectedDb);
    const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
    // Intentionally keyed on `open` alone: this fires on the open transition,
    // and selectedDb/loadDatabases are read rather than tracked.
  }, [open]);

  // Outside click / ESC to close
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filteredDbs = useMemo(() => {
    const term = qDb.trim().toLowerCase();
    if (!term) return databases;
    return databases.filter(
      (d) =>
        d.tenant_id.toLowerCase().includes(term) ||
        (d.organisation && d.organisation.toLowerCase().includes(term)),
    );
  }, [databases, qDb]);

  const filteredCols = useMemo(() => {
    const term = qCol.trim().toLowerCase();
    if (!term) return collections;
    return collections.filter((c) => c.toLowerCase().includes(term));
  }, [collections, qCol]);

  /** Multi-select (Ask-AI style): toggling a collection adds/removes it
   *  from config.collections; "All collections" clears the selection.
   *  Toggling also clears the legacy single `collection`, which would
   *  otherwise shadow the multi-select in the search precedence. */
  const handleToggleCol = (colId: string) => {
    const next = selectedCols.includes(colId)
      ? selectedCols.filter((c) => c !== colId)
      : [...selectedCols, colId];
    setConfig({
      collection: undefined,
      collections: next.length > 0 ? next : undefined,
    });
  };

  const handlePickDb = (dbId: string) => {
    setConfig({ database: dbId, collection: undefined, collections: undefined });
    void loadCollections(dbId);
  };

  return (
    <div className={`relative inline-flex items-center gap-1.5 ${className}`} ref={ref}>
      {/* Topbar Pill */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-2 rounded-full border border-solid border-stroke-1 bg-surface-2 px-3 text-[11.5px] text-text-1 transition-colors hover:border-stroke-3 hover:bg-surface-3"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="font-medium text-text-1">
          {selectedDb || (loadingDbs ? "Loading…" : "Select database")}
        </span>
        <span className="text-text-2 opacity-50">/</span>
        <span className="text-text-2">
          {selectedCols.length > 0
            ? selectedCols.length === 1
              ? selectedCols[0]
              : `${selectedCols.length} collections`
            : selectedCol || "All collections"}
        </span>
        <Icon name="chevDown" size={12} className="text-text-2" />
      </button>

      {/* Info Icon Button */}
      <button
        type="button"
        onClick={() => setShowHelp(true)}
        className="flex h-8 w-8 items-center justify-center rounded-full text-text-2 transition-colors hover:bg-surface-7 hover:text-text-1"
        title="What are databases & collections?"
      >
        <Icon name="info" size={14} />
      </button>

      {/* Popover Dual Pane */}
      {open && (
        <div
          // Mobile: pin to the viewport (fixed, left inset) so the popover can
          // never run off-screen regardless of where the pill sits. Larger
          // screens anchor it under the pill as usual.
          className="animate-fadeIn fixed left-3 right-3 top-[3.25rem] z-[100] flex flex-col overflow-hidden rounded-xl border border-solid border-stroke-1 bg-surface-4 shadow-2xl sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-2 sm:w-[480px]"
          role="dialog"
          aria-label="Select scope"
        >
          <div className="grid grid-cols-1 border-b border-solid border-stroke-1 sm:grid-cols-2">
            {/* Database Pane */}
            <div className="flex flex-col border-b border-solid border-stroke-1 p-3 sm:border-b-0 sm:border-r">
              <div className="mb-2 flex items-center justify-between text-xs font-semibold text-text-1">
                <span>Database</span>
                {loadingDbs && <Spinner size={11} />}
              </div>
              <div className="relative mb-2">
                <Icon name="search" size={13} className="absolute left-2.5 top-2.5 text-text-2" />
                <input
                  ref={searchInputRef}
                  className="input !h-8 !pl-8 text-xs"
                  aria-label="Search databases"
              placeholder="Search databases…"
                  value={qDb}
                  onChange={(e) => setQDb(e.target.value)}
                />
              </div>
              <div className="max-h-[220px] space-y-1 overflow-y-auto pr-0.5">
                {filteredDbs.map((d) => {
                  const active = d.tenant_id === selectedDb;
                  return (
                    <button
                      key={d.tenant_id}
                      type="button"
                      onClick={() => handlePickDb(d.tenant_id)}
                      className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                        active
                          ? "bg-accent-dim font-medium text-text-1"
                          : "text-text-2 hover:bg-surface-2 hover:text-text-1"
                      }`}
                    >
                      <span className="truncate font-mono">{d.tenant_id}</span>
                      {active && <Icon name="check" size={12} className="shrink-0 text-text-1" />}
                    </button>
                  );
                })}
                {filteredDbs.length === 0 && !loadingDbs && (
                  <p className="py-4 text-center text-xs text-text-2">No databases found.</p>
                )}
              </div>
            </div>

            {/* Collection Pane */}
            <div className="flex flex-col p-3">
              <div className="mb-2 flex items-center justify-between text-xs font-semibold text-text-1">
                <span>Collections</span>
                {selectedDb && <span className="font-mono text-[11px] text-text-2 truncate max-w-[100px]">{selectedDb}</span>}
              </div>
              <div className="relative mb-2">
                <Icon name="search" size={13} className="absolute left-2.5 top-2.5 text-text-2" />
                <input
                  className="input !h-8 !pl-8 text-xs"
                  aria-label="Search collections"
              placeholder="Search collections…"
                  value={qCol}
                  onChange={(e) => setQCol(e.target.value)}
                  disabled={!selectedDb}
                />
              </div>
              <div className="max-h-[220px] space-y-1 overflow-y-auto pr-0.5">
                {selectedDb && (
                  <button
                    type="button"
                    onClick={() => setConfig({ collection: undefined, collections: undefined })}
                    className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                      selectedCols.length === 0
                        ? "bg-accent-dim font-medium text-text-1"
                        : "text-text-2 hover:bg-surface-2 hover:text-text-1"
                    }`}
                  >
                    <span>All collections</span>
                    {selectedCols.length === 0 && (
                      <Icon name="check" size={12} className="shrink-0 text-text-1" />
                    )}
                  </button>
                )}
                {filteredCols.map((c) => {
                  const active = selectedCols.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => handleToggleCol(c)}
                      aria-pressed={active}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                        active
                          ? "bg-accent-dim text-text-1"
                          : "text-text-2 hover:bg-surface-2 hover:text-text-1"
                      }`}
                    >
                      <span
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border border-solid transition-colors ${
                          active
                            ? "border-text-1 bg-text-1 text-surface-1"
                            : "border-stroke-1 bg-transparent"
                        }`}
                      >
                        {active && <Icon name="check" size={9} />}
                      </span>
                      <span className="truncate font-mono">{c}</span>
                    </button>
                  );
                })}
                {selectedDb && filteredCols.length === 0 && !loadingCols && (
                  <p className="py-4 text-center text-xs text-text-2">No collections in this db.</p>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setShowHelp(true);
            }}
            className="flex items-center gap-1.5 bg-surface-5 px-3 py-2 text-[11.5px] text-text-2 transition-colors hover:text-text-1"
          >
            <Icon name="info" size={13} />
            <span>What are databases and collections?</span>
          </button>
        </div>
      )}

      {/* Help Modal */}
      <Modal
        open={showHelp}
        onClose={() => setShowHelp(false)}
        title="Databases & Collections"
        width={460}
      >
        <div className="space-y-3 text-sm leading-relaxed text-text-2">
          <p>
            <strong className="text-text-1">Database:</strong> The root namespace (tenant) for
            your workspace data in Hydra DB. All your connector sources and memories live under a database.
          </p>
          <p>
            <strong className="text-text-1">Collection:</strong> A sub-tenant partition inside a database.
            For example, Slack messages might go to <code className="font-mono text-xs text-text-1">slack</code>,
            Jira comments to <code className="font-mono text-xs text-text-1">jira</code>, and documents to <code className="font-mono text-xs text-text-1">docs</code>.
          </p>
          <p className="text-xs text-text-2 pt-2 border-t border-solid border-stroke-1">
            Switching scopes narrows your queries and context lists to that specific dataset.
          </p>
        </div>
      </Modal>
    </div>
  );
}
