"use client";

/**
 * Ask / Search, the home page.
 *
 * A centred greeting, the search composer, and suggested prompts, on a flat
 * obsidian canvas.
 */
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useChatStore } from "@/lib/store/chat";
import { suggestTitle } from "@/lib/qa";
import AskSearchBar, { type AskSubmitOpts } from "@/components/AskSearchBar";

export default function AskPage() {
  const router = useRouter();
  const { createConversation } = useChatStore();

  const onSubmit = useCallback(
    (query: string, opts: AskSubmitOpts) => {
      const q = query.trim();
      if (!q) return;
      const conv = createConversation(suggestTitle(q));
      const params = new URLSearchParams({ q });
      if (opts.webSearch) params.set("web", "1");
      if (opts.mode !== "fast") params.set("mode", opts.mode);
      if (opts.metadataFilters && Object.keys(opts.metadataFilters).length > 0) {
        params.set("filters", JSON.stringify(opts.metadataFilters));
      }
      router.push(`/chat/${conv.id}?${params.toString()}`);
    },
    [createConversation, router],
  );

  return (
    <div className="obsidian relative flex h-full w-full flex-col items-center justify-center overflow-y-auto px-4 py-8">
      <div className="relative w-full max-w-[680px]">
        <AskSearchBar onSubmit={onSubmit} />
      </div>
    </div>
  );
}
