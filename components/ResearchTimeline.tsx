"use client";

/**
 * Deep Research progress timeline.
 *
 * While running it shows the plan as levels of parallel sub-questions with
 * live status. When the answer starts it collapses to a one-line summary
 * ("Researched for 23s · 8 questions · 28 sources") — but a manual toggle wins
 * permanently, so auto-collapse never fights the user.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Icon, Spinner } from "@/components/Icon";
import type { ResearchNodeState, ResearchRunState } from "@/lib/research/types";

function phaseLabel(state: ResearchRunState): string {
  switch (state.phase) {
    case "planning":
      return "Planning research";
    case "researching": {
      const running = state.nodes.filter((n) => n.status === "running").length;
      if (running > 1) return `Researching ${running} questions in parallel`;
      const active = state.nodes.find((n) => n.status === "running");
      return active ? `Researching: ${active.question}` : "Researching";
    }
    case "answering":
      return "Writing the answer";
    case "error":
      return "Research failed";
    case "stopped":
      return "Research stopped";
    default:
      return "Research complete";
  }
}

function summary(state: ResearchRunState): string {
  const s = state.stats;
  if (state.phase === "stopped") {
    // A cancelled run has partial findings; do not report it as complete.
    const answered = state.nodes.filter((n) => n.status === "done").length;
    return `Stopped after ${answered} of ${state.nodes.length} question${state.nodes.length === 1 ? "" : "s"}`;
  }
  if (!s) return "Research complete";
  const secs = Math.max(1, Math.round(s.elapsedMs / 1000));
  return `Researched for ${secs}s · ${s.nodes} question${s.nodes === 1 ? "" : "s"} · ${s.sourcesUsed} source${s.sourcesUsed === 1 ? "" : "s"}`;
}

export default function ResearchTimeline({
  state,
  className,
}: {
  state: ResearchRunState;
  className?: string;
}) {
  const done =
    state.phase === "done" || state.phase === "error" || state.phase === "stopped";
  const [open, setOpen] = useState(true);
  /** Once the user toggles, stop auto-collapsing on their behalf. */
  const userToggled = useRef(false);

  useEffect(() => {
    if (!userToggled.current && done) setOpen(false);
  }, [done]);

  const levels = Math.max(state.levels, 1);
  const waves = Array.from({ length: levels }, (_, i) =>
    state.nodes.filter((n) => n.level === i),
  ).filter((w) => w.length > 0);

  return (
    <div className={cn("rounded-lg border border-stroke-1 bg-surface-4", className)}>
      <button
        onClick={() => {
          userToggled.current = true;
          setOpen((o) => !o);
        }}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-accent">
          {done ? (
            <Icon
              name={
                state.phase === "error"
                  ? "alert"
                  : state.phase === "stopped"
                    ? "stop"
                    : "sparkles"
              }
              size={14}
            />
          ) : (
            <Spinner size={13} />
          )}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12.5px] font-medium",
            done ? "text-fg-2" : "text-fg",
            !done && "animate-pulse",
          )}
        >
          {done ? summary(state) : phaseLabel(state)}
        </span>
        <Icon
          name="chev"
          size={13}
          className={cn(
            "shrink-0 text-fg-4 transition-transform",
            open ? "rotate-90" : "rotate-0",
          )}
        />
      </button>

      {open ? (
        <div className="border-t border-stroke-1 px-3 py-3">
          {state.objective ? (
            <p className="mb-3 text-[12px] leading-relaxed text-fg-3">
              {state.objective}
            </p>
          ) : null}

          {waves.length === 0 ? (
            <p className="text-[12px] text-fg-4">Planning sub-questions…</p>
          ) : (
            <div className="space-y-3">
              {waves.map((wave, i) => (
                <div key={i}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wide text-fg-4">
                      Level {i + 1}
                    </span>
                    {wave.length > 1 ? (
                      <span className="text-[10.5px] text-fg-5">
                        {wave.length} in parallel
                      </span>
                    ) : null}
                    <span className="h-px flex-1 bg-stroke-1" />
                  </div>
                  <div className="space-y-1.5">
                    {wave.map((node) => (
                      <NodeRow key={node.id} node={node} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {state.error ? (
            <p className="mt-3 flex items-start gap-1.5 rounded-sm border border-bad/30 bg-bad-fill px-2.5 py-1.5 text-[12px] text-bad">
              <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
              {state.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NodeRow({ node }: { node: ResearchNodeState }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(node.finding || node.error);

  return (
    <div className="rounded-md border border-stroke-1/70 bg-surface-2">
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-start gap-2 px-2.5 py-2 text-left",
          expandable ? "cursor-pointer" : "cursor-default",
        )}
        aria-expanded={expandable ? open : undefined}
      >
        <StatusDot status={node.status} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] leading-snug text-fg-2">
            {node.question}
          </span>
          {node.status === "done" && node.chunkCount != null ? (
            <span className="mt-0.5 block text-[11px] text-fg-5">
              {node.chunkCount} chunk{node.chunkCount === 1 ? "" : "s"}
              {node.newSources ? ` · ${node.newSources} new source${node.newSources === 1 ? "" : "s"}` : " · all duplicates"}
            </span>
          ) : null}
        </span>
        {expandable ? (
          <Icon
            name="chev"
            size={12}
            className={cn(
              "mt-0.5 shrink-0 text-fg-5 transition-transform",
              open ? "rotate-90" : "rotate-0",
            )}
          />
        ) : null}
      </button>
      {open && expandable ? (
        <div className="border-t border-stroke-1/70 px-2.5 py-2">
          <p className="text-[12px] leading-relaxed text-fg-3">
            {node.error ?? node.finding}
          </p>
          {node.citations && node.citations.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {node.citations.map((c) => (
                <span key={c} className="chip">
                  {c}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusDot({ status }: { status: ResearchNodeState["status"] }) {
  if (status === "running") {
    return <Spinner size={12} className="mt-0.5 shrink-0 text-accent" />;
  }
  return (
    <span
      className={cn(
        "mt-1 h-2 w-2 shrink-0 rounded-full",
        status === "done" && "bg-good",
        status === "error" && "bg-bad",
        status === "pending" && "bg-stroke-3",
      )}
      aria-hidden="true"
    />
  );
}
