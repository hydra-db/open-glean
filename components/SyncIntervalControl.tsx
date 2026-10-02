"use client";

/**
 * SyncIntervalControl — refresh-cadence picker for a connector, ported from
 * dashboard-2.0. Presets plus a custom seconds field, with the provider's
 * allowed range stated inline (the API rejects out-of-range values rather
 * than clamping, so validation happens before the round-trip).
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  formatInterval,
  presetsFor,
  syncIntervalBounds,
  validateSyncInterval,
} from "@/lib/syncInterval";

export function SyncIntervalControl({
  provider,
  value,
  disabled,
  onSave,
}: {
  provider: string;
  /** Current cadence in seconds. 0/absent means the connector is on the default. */
  value: number;
  disabled?: boolean;
  /** Persists the new interval. Rejecting with an Error shows its message inline. */
  onSave: (seconds: number) => Promise<void>;
}) {
  const presets = presetsFor(provider);
  const { minSeconds, maxSeconds, note } = syncIntervalBounds(provider);

  const matchesPreset = presets.some((p) => p.seconds === value);
  const [custom, setCustom] = useState(
    value > 0 && !matchesPreset ? String(value) : "",
  );
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(seconds: number) {
    const message = validateSyncInterval(provider, seconds);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    setSaved(false);
    setPending(seconds);
    try {
      await onSave(seconds);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the interval.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      <p className="mb-2 text-[11.5px] text-text-2">
        How often should this connector check for new data?
      </p>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.seconds}
            type="button"
            className={cn(
              "rounded-full border border-solid px-2.5 py-1 text-[11.5px] font-medium transition-colors",
              value === preset.seconds
                ? "border-accent-line bg-accent-tint text-text-1"
                : "border-stroke-1 bg-surface-3 text-text-2 hover:text-text-1",
            )}
            disabled={disabled || pending !== null}
            aria-pressed={value === preset.seconds}
            onClick={() => save(preset.seconds)}
          >
            {pending === preset.seconds ? "Saving…" : preset.label}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          className="input !h-8 w-[110px] font-mono !text-xs"
          inputMode="numeric"
          placeholder="Seconds"
          aria-label="Custom interval in seconds"
          value={custom}
          disabled={disabled || pending !== null}
          onChange={(e) => {
            setCustom(e.target.value.replace(/[^0-9]/g, ""));
            setError(null);
            setSaved(false);
          }}
        />
        <button
          type="button"
          className="btn-soft h-8 text-xs"
          disabled={disabled || pending !== null || custom.trim() === ""}
          onClick={() => save(Number(custom))}
        >
          Set custom
        </button>
        <span className="text-[11px] text-fg-4">
          {formatInterval(minSeconds)} – {formatInterval(maxSeconds)}
        </span>
      </div>
      {note ? <p className="mt-1.5 text-[11px] leading-relaxed text-fg-4">{note}</p> : null}
      {error ? (
        <p className="mt-1.5 text-[11px] text-error-1" role="alert">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-success-1">
          Saved — the new cadence applies from the next scheduled sync.
        </p>
      ) : null}
    </div>
  );
}