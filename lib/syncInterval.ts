/**
 * Sync-interval presets and bounds for the connector refresh-cadence control.
 *
 * The bounds here MIRROR the backend's
 * `internal/domain/connectors/syncinterval.go` — they are not the authority.
 * The API rejects an out-of-range value rather than clamping it, deliberately, so
 * that a user who asks for a one-minute cadence finds out instead of believing
 * they got one. This module exists so they find out *before* submitting, and so
 * the reason is visible next to the field rather than arriving as an error.
 *
 * A value that drifts out of sync with the backend therefore degrades to "the
 * API says no", which is annoying but not wrong. `syncInterval.test.ts` pins the
 * numbers so a backend change is a visible test failure rather than a mystery
 * 400 in production.
 */

/** Global bounds. Per-provider entries below can narrow either end. */
export const MIN_SYNC_INTERVAL_SECONDS = 300;
export const MAX_SYNC_INTERVAL_SECONDS = 604800;
export const DEFAULT_SYNC_INTERVAL_SECONDS = 3600;

type ProviderBound = {
  /** Raised floor, and the reason — shown to the user, so it must make sense to one. */
  minSeconds?: number;
  /** Lowered ceiling, likewise. */
  maxSeconds?: number;
  note: string;
};

/**
 * Providers whose range is narrower than the global one. Every entry needs a
 * reason a user can act on: these are limits they cannot override, so "because
 * we said so" turns into a support conversation.
 */
export const PROVIDER_SYNC_BOUNDS: Record<string, ProviderBound> = {
  twitter: {
    minSeconds: 600,
    maxSeconds: 21600,
    note: "X bills per record read; syncs stop at the last message already seen, so the 10-minute floor keeps an idle poll to a single page. The 6-hour limit is for direct messages: X's DM endpoint accepts no date filter, so a longer gap can page past messages it cannot go back for.",
  },
  attio: {
    minSeconds: 900,
    note: "Attio's rate limits are shared across every integration on your workspace, so a tight interval throttles your other tools too. Attio also exposes no updated-at field, so each sync re-reads the full set.",
  },
};

export type SyncIntervalBounds = {
  minSeconds: number;
  maxSeconds: number;
  /** Provider-specific explanation, when there is one to give. */
  note?: string;
};

export function syncIntervalBounds(provider: string): SyncIntervalBounds {
  const bound = PROVIDER_SYNC_BOUNDS[provider];
  return {
    minSeconds: bound?.minSeconds ?? MIN_SYNC_INTERVAL_SECONDS,
    maxSeconds: bound?.maxSeconds ?? MAX_SYNC_INTERVAL_SECONDS,
    note: bound?.note,
  };
}

/** The cadence a connector gets when the user does not choose, clamped into range. */
export function defaultSyncIntervalFor(provider: string): number {
  const { minSeconds, maxSeconds } = syncIntervalBounds(provider);
  return Math.min(Math.max(DEFAULT_SYNC_INTERVAL_SECONDS, minSeconds), maxSeconds);
}

export type SyncIntervalPreset = { label: string; seconds: number };

/**
 * Presets, coarsest-to-finest reading order. Deliberately few: a cadence picker
 * with fifteen options makes the user weigh a decision that barely matters, and
 * the custom field covers the rest.
 */
export const SYNC_INTERVAL_PRESETS: SyncIntervalPreset[] = [
  { label: "Every 5 minutes", seconds: 300 },
  { label: "Every 10 minutes", seconds: 600 },
  { label: "Every 15 minutes", seconds: 900 },
  { label: "Hourly", seconds: 3600 },
  { label: "Every 6 hours", seconds: 21600 },
  { label: "Daily", seconds: 86400 },
  { label: "Weekly", seconds: 604800 },
];

/**
 * The presets a provider can actually use.
 *
 * Filtered rather than disabled-in-place: an option a user can see, click, and be
 * refused by is worse than one that was never offered, and the bounds note
 * already explains why the range is what it is.
 */
export function presetsFor(provider: string): SyncIntervalPreset[] {
  const { minSeconds, maxSeconds } = syncIntervalBounds(provider);
  return SYNC_INTERVAL_PRESETS.filter(
    (p) => p.seconds >= minSeconds && p.seconds <= maxSeconds,
  );
}

/**
 * Validates a chosen interval, returning an error message or null.
 *
 * Mirrors the backend's rejection (not clamping) so the message a user reads here
 * is the same judgement the API would make.
 */
export function validateSyncInterval(
  provider: string,
  seconds: number,
): string | null {
  const { minSeconds, maxSeconds } = syncIntervalBounds(provider);
  if (!Number.isFinite(seconds) || Math.trunc(seconds) !== seconds) {
    return "Enter a whole number of seconds.";
  }
  // Zero means "use the default" to the API, exactly as it does at create time.
  if (seconds === 0) return null;
  if (seconds < minSeconds || seconds > maxSeconds) {
    return `Choose between ${formatInterval(minSeconds)} and ${formatInterval(maxSeconds)}.`;
  }
  return null;
}

/** Human-readable duration for a whole number of seconds ("6 hours", "15 minutes"). */
export function formatInterval(seconds: number): string {
  const units: [number, string][] = [
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  for (const [size, name] of units) {
    // Only name a unit the value divides into cleanly; 5400s is "90 minutes",
    // not "1.5 hours" or a truncated "1 hour".
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} seconds`;
}
