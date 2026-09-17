/**
 * Composer modes, shared by the home composer and the chat composer.
 *
 * `fast` and `thinking` map onto Hydra's own retrieval modes for a single
 * query. `research` is different in kind: it runs the multi-step query-DAG
 * pipeline in /api/research rather than one retrieval.
 */
export type ChatMode = "fast" | "thinking" | "research";

export const MODE_ORDER: ChatMode[] = ["fast", "thinking", "research"];

export const MODE_STORAGE_KEY = "open-glean.searchMode";

export const MODE_META: Record<
  ChatMode,
  { label: string; icon: string; title: string }
> = {
  fast: {
    label: "Fast",
    icon: "bolt",
    title: "Fast: quick hybrid retrieval",
  },
  thinking: {
    label: "Deep",
    icon: "brain",
    title: "Deep: graph-augmented retrieval (slower)",
  },
  research: {
    label: "Research",
    icon: "sparkles",
    title:
      "Deep Research: plans a DAG of sub-questions, runs them in parallel, then writes a cited answer",
  },
};

export function isChatMode(v: unknown): v is ChatMode {
  return v === "fast" || v === "thinking" || v === "research";
}

/** Next mode in the cycle — the composer pill is a 3-way toggle. */
export function nextMode(mode: ChatMode): ChatMode {
  return MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
}

export function readStoredMode(): ChatMode {
  if (typeof window === "undefined") return "fast";
  try {
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (isChatMode(stored)) return stored;
    return "fast";
  } catch {
    return "fast";
  }
}

export function storeMode(mode: ChatMode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // best-effort
  }
}
