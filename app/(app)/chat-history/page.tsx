"use client";

/**
 * Chat history — every conversation, newest first, with title filter,
 * message counts and delete.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useChatStore } from "@/lib/store/chat";
import { useToast } from "@/lib/toast";
import { timeAgo } from "@/lib/utils";
import { stripMarkdown } from "@/lib/markdown";
import { ConfirmDialog, EmptyState } from "@/components/ui";
import { Icon } from "@/components/Icon";
import type { Conversation } from "@/lib/types";

export default function ChatHistoryPage() {
  const router = useRouter();
  const { conversations, deleteConversation } = useChatStore();
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);

  const query = filter.trim().toLowerCase();

  const filtered = useMemo(() => {
    const list = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!query) return list;
    return list.filter(
      (c) =>
        c.title.toLowerCase().includes(query) ||
        c.messages.some((m) => m.content.toLowerCase().includes(query)),
    );
  }, [conversations, query]);

  // Bucket by last activity so a long history scans like a timeline.
  const groups = useMemo(() => {
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const day = 86_400_000;
    const buckets: { label: string; items: Conversation[] }[] = [
      { label: "Today", items: [] },
      { label: "Yesterday", items: [] },
      { label: "Previous 7 days", items: [] },
      { label: "Older", items: [] },
    ];
    for (const c of filtered) {
      const i =
        c.updatedAt >= startOfToday
          ? 0
          : c.updatedAt >= startOfToday - day
            ? 1
            : c.updatedAt >= startOfToday - 7 * day
              ? 2
              : 3;
      buckets[i]!.items.push(c);
    }
    return buckets.filter((b) => b.items.length > 0);
  }, [filtered]);

  const doDelete = () => {
    if (!confirm) return;
    setBusy(true);
    deleteConversation(confirm.id);
    setBusy(false);
    setConfirm(null);
    toast.push({ kind: "info", title: "Conversation deleted" });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-4 pb-16 pt-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="font-pixel text-[28px] font-normal leading-tight text-text-3">
            Chat history
          </h1>
          <p className="mt-1.5 text-[13px] text-fg-3">
            Past conversations, each with the sources behind the answer.
          </p>
        </div>

        {/* Filter */}
        <div className="relative mb-6">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-4"
          />
          <input
            className="input h-11 rounded-xl pl-10"
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by title or message content…"
            aria-label="Filter conversations"
          />
        </div>

        {/* List */}
        {conversations.length === 0 ? (
          <div className="rounded-xl border border-solid border-stroke-1 bg-surface-4">
            <EmptyState
              icon="history"
              title="No conversations yet"
              message="Ask a question to start. Your answers show up here, with their sources."
              action={
                <Link href="/ask" className="btn-primary">
                  <Icon name="sparkles" size={14} />
                  Ask something
                </Link>
              }
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-solid border-stroke-1 bg-surface-4">
            <EmptyState
              icon="search"
              title="No matches"
              message={`Nothing matches “${filter.trim()}” in your chat history.`}
            />
          </div>
        ) : (
          <div className="space-y-7">
            {groups.map((g) => (
              <section key={g.label}>
                <h2 className="mb-2 px-1 text-[11.5px] font-medium uppercase tracking-wider text-fg-4">
                  {g.label}
                </h2>
                <ul className="divide-y divide-solid divide-stroke-1 overflow-hidden rounded-xl border border-solid border-stroke-1 bg-surface-4">
                  {g.items.map((c) => {
                    // Count the same messages the preview considers real, or the
                    // row reads "No answer yet · 2 messages": the count included
                    // an empty assistant placeholder that the preview ignored.
                    const n = c.messages.filter((m) => m.content.trim()).length;
                    const lastAssistant = [...c.messages]
                      .reverse()
                      .find((m) => m.role === "assistant" && m.content);
                    const preview = lastAssistant ? stripMarkdown(lastAssistant.content) : "";
                    return (
                      <li key={c.id}>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => router.push(`/chat/${c.id}`)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              router.push(`/chat/${c.id}`);
                            }
                          }}
                          className="group flex cursor-pointer items-center gap-4 px-4 py-3.5 transition-colors hover:bg-white/[0.03]"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[14px] font-medium text-text-1">{c.title}</p>
                            <p className={preview ? "mt-0.5 truncate text-[12.5px] text-fg-4" : "mt-0.5 text-[12.5px] italic text-fg-4"}>
                              {preview || "No answer yet"}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="whitespace-nowrap text-[11.5px] tabular-nums text-fg-4">
                              <span className="hidden sm:inline">
                                {n} {n === 1 ? "message" : "messages"} ·{" "}
                              </span>
                              {timeAgo(c.updatedAt)}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirm(c);
                              }}
                              className="flex h-7 w-7 items-center justify-center rounded-full text-fg-4 opacity-0 transition-all hover:bg-bad-fill hover:text-bad focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                              title="Delete conversation"
                              aria-label={`Delete ${c.title}`}
                            >
                              <Icon name="trash" size={13} />
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {conversations.length > 0 ? (
          <p className="mt-5 text-center text-[11px] text-fg-5">
            {filtered.length} of {conversations.length} conversations, stored in
            this browser
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={doDelete}
        busy={busy}
        title="Delete conversation?"
        message={
          confirm
            ? `“${confirm.title}” and its ${confirm.messages.length} message${confirm.messages.length === 1 ? "" : "s"} will be removed. This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
      />
    </div>
  );
}