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
        <div className="relative mb-4">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-4"
          />
          <input
            className="input pl-9"
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by title or message content…"
            aria-label="Filter conversations"
          />
        </div>

        {/* List */}
        {conversations.length === 0 ? (
          <div className="rounded-md border border-line bg-bg-2">
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
          <div className="rounded-md border border-line bg-bg-2">
            <EmptyState
              icon="search"
              title="No matches"
              message={`Nothing matches “${filter.trim()}” in your chat history.`}
            />
          </div>
        ) : (
          <ul className="space-y-2">
            {filtered.map((c) => {
              // Count the same messages the preview considers real, or the row
              // reads "No answer yet · 2 messages": the count included an
              // empty assistant placeholder that the preview rightly ignored.
              const n = c.messages.filter((m) => m.content.trim()).length;
              const lastAssistant = [...c.messages]
                .reverse()
                .find((m) => m.role === "assistant" && m.content);
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
                    className="group flex cursor-pointer items-center gap-3 rounded-md border border-line bg-bg-2 px-4 py-3 transition-colors hover:border-stroke-3 hover:bg-bg-elev"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-accent-dim text-accent">
                      <Icon name="msg" size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium text-fg">
                        {c.title}
                      </p>
                      <p className="mt-0.5 truncate text-[12px] text-fg-4">
                        {lastAssistant
                          ? lastAssistant.content
                          : "No answer yet"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="hidden text-right text-[11px] text-fg-4 sm:block">
                        {n} {n === 1 ? "message" : "messages"}
                        <span className="block text-fg-5">
                          {timeAgo(c.updatedAt)}
                        </span>
                      </span>
                      <span className="text-[11px] text-fg-5 sm:hidden">
                        {timeAgo(c.updatedAt)}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirm(c);
                        }}
                        className="flex h-7 w-7 items-center justify-center rounded-sm text-fg-4 opacity-60 transition-colors hover:bg-bad-fill hover:text-bad group-hover:opacity-100"
                        title="Delete conversation"
                        aria-label={`Delete ${c.title}`}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
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