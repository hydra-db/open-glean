"use client";

/**
 * Chat — a single QnA conversation. Streaming answers grounded in Hydra
 * context, per-message sources, stop/abort, error states, autoscroll and
 * lightweight markdown rendering (no external deps).
 */
import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppConfig } from "@/lib/store/config";
import { useChatStore } from "@/lib/store/chat";
import { useToast } from "@/lib/toast";
import { useHydra } from "@/lib/api";
import { cn, copyText, timeAgo } from "@/lib/utils";
import { hasLlm, suggestTitle, useQa } from "@/lib/qa";
import { buildCitationIndex } from "@/lib/citations";
import { linkCitations } from "@/lib/citationMarkup";
import { markdownToHtml } from "@/lib/markdown";
import {
  MODE_META,
  isChatMode,
  nextMode,
  storeMode,
  type ChatMode,
} from "@/lib/chatMode";
import { useResearch } from "@/lib/research/useResearch";
import SourcesPanel from "@/components/SourcesPanel";
import ResearchTimeline from "@/components/ResearchTimeline";
import { LlmMissingNotice } from "@/components/AskSearchBar";
import { ConfirmDialog, Modal } from "@/components/ui";
import { Icon, Spinner } from "@/components/Icon";
import { MessageActions } from "@/components/message-actions/MessageActions";
import { ChatHeader } from "@/components/ChatHeader";
import type { ChatMessage, SearchChunk } from "@/lib/types";
import type { ResearchSource } from "@/lib/research/types";

// ── Page (client) — Next 16 params is a Promise; `use` unwraps it. ──

export default function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-fg-4">
          <Spinner size={18} className="text-text-2" />
        </div>
      }
    >
      <ChatClient id={id} />
    </Suspense>
  );
}

// ── Engine helpers ────────────────────────────────────────────────

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * How many citations an answer has, which is the highest `[n]` that can
 * resolve. Uses the same index as the prompt and the panel.
 */
function citationCount(m: ChatMessage): number {
  return buildCitationIndex(m.sources ?? [], m.webCitations ?? []).maxRef;
}

function lastAssistantContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.content) return m.content;
  }
  return "";
}


/**
 * Render an answer, with `[n]` markers turned into clickable citations.
 *
 * `maxRef` is how many sources the answer actually has. Markers above it stay
 * inert text rather than becoming links to nothing, which is what the model
 * emits when it over-cites.
 *
 * Clicks are handled by delegation on the container rather than by rendering
 * React elements, because the body is inserted as HTML. The markup carries
 * only a validated integer, so there is nothing attacker-controlled to read
 * back out of it.
 */
function Markdown({
  text,
  maxRef = 0,
  onCite,
}: {
  text: string;
  maxRef?: number;
  onCite?: (ref: number) => void;
}) {
  const html = useMemo(
    () => linkCitations(markdownToHtml(text), maxRef),
    [text, maxRef],
  );
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = (e.target as HTMLElement).closest("[data-cite]");
      if (!target) return;
      const ref = Number(target.getAttribute("data-cite"));
      if (Number.isInteger(ref) && ref > 0) onCite?.(ref);
    },
    [onCite],
  );
  return (
    <div
      onClick={handleClick}
      className="text-[13.5px] leading-relaxed text-fg-2 [&_strong]:text-fg [&_li]:pl-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Answer text as plain prose, for reading aloud and for quoting into a reply.
 * Drops citation markers and the markdown syntax a voice or a quote would
 * otherwise carry along.
 */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[(\d+)\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Adapt Deep Research's deduped sources to the chunk shape SourcesPanel reads.
 *
 * Research owns its own global citation numbering, and the panel numbers by
 * array order — so emitting them in `n` order keeps the answer's [n] pointing
 * at the same card. The excerpt carries the passages the finding was drawn
 * from, which is what the preview modal shows.
 */
function researchSourcesToChunks(sources: ResearchSource[]): SearchChunk[] {
  return [...sources]
    .sort((a, b) => a.n - b.n)
    .map((s) => ({
      chunk_uuid: `research-${s.n}`,
      source_id: s.sourceId,
      source_title: s.title,
      source_url: s.url,
      source_type: s.sourceType,
      app_provider: s.appProvider,
      collection: s.collection,
      chunk_content: s.excerpt,
      relevancy_score: s.score,
    }));
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className="typing-dot h-1.5 w-1.5 rounded-full bg-text-1"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
      {/* The dots carry the whole "working on it" message visually, so they
          need a text equivalent. Visually hidden rather than aria-label,
          which is unreliable on a plain div. */}
      <span className="sr-only">Generating an answer…</span>
    </div>
  );
}

// ── Client ────────────────────────────────────────────────────────

const STARTERS = [
  "What did I work on last week?",
  "Summarize my recent notes",
  "Who mentioned budgets in Slack?",
];

function ChatClient({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const q = searchParams?.get("q") ?? "";

  const { config } = useAppConfig();
  const {
    getConversation,
    createConversation,
    addMessage,
    updateMessage,
    updateConversation,
    deleteConversation,
    renameConversation,
    hydrated,
  } = useChatStore();
  const { runQa, stop } = useQa();
  const { run: runResearch, stop: stopResearch } = useResearch();
  const hydra = useHydra();
  const toast = useToast();

  const conv = getConversation(id);
  const messages = conv?.messages ?? [];
  // While the store hydrates from the server, conv may be undefined even
  // though it exists — don't render the empty state yet.
  const waitingForStore = !hydrated && conv === undefined;
  const llmMissing = !hasLlm(config);

  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Open negative-rating prompt: which message, and what the user typed. */
  const [ratingDraft, setRatingDraft] = useState<{
    messageId: string;
    requestId: string;
    text: string;
  } | null>(null);
  // Metadata filters for retrieval, set from the ask page (?filters= JSON).
  const [filters, setFilters] = useState<Record<string, unknown> | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    try {
      const v = searchParams?.get("filters");
      if (!v) return undefined;
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  });
  // Web search preference for Ask mode (from ?web=1 on the ask page, else last choice).
  const [webSearch, setWebSearch] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    if (searchParams?.get("web") === "1") return true;
    try {
      const v = window.localStorage.getItem("open-glean.webSearch");
      return (v ?? "1") !== "0";
    } catch {
      return true;
    }
  });
  // Retrieval mode: fast | thinking | research (from ?mode=, else last choice).
  const [mode, setMode] = useState<ChatMode>(() => {
    if (typeof window === "undefined") return "fast";
    const fromUrl = searchParams?.get("mode");
    if (isChatMode(fromUrl)) return fromUrl;
    try {
      const stored = window.localStorage.getItem("open-glean.searchMode");
      return isChatMode(stored) ? stored : "fast";
    } catch {
      return "fast";
    }
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const abortedRef = useRef(false);
  /** Latest LLM config, read by `send` without making it a dependency. */
  const configLlmRef = useRef(config.llm);
  useEffect(() => {
    configLlmRef.current = config.llm;
  });
  /**
   * Which citation the user clicked, and in which message. Keyed by message id
   * so two answers on screen cannot steal each other's focus request.
   */
  const [citeFocus, setCiteFocus] = useState<{ messageId: string; ref: number } | null>(
    null,
  );
  const runningRef = useRef(false);
  const autoRan = useRef<string | null>(null);

  // Keep the latest runQa (its identity changes every render) + store fns.
  const qaRef = useRef(runQa);
  qaRef.current = runQa;
  const researchRef = useRef(runResearch);
  researchRef.current = runResearch;
  const storeRef = useRef({ addMessage, updateMessage, renameConversation, updateConversation });
  storeRef.current = { addMessage, updateMessage, renameConversation, updateConversation };

  // Missing conversation → back home. Waits for the store to finish its
  // async hydration from MongoDB first — otherwise a direct URL load (or a
  // page refresh) redirects to /ask before the conversation arrives.
  useEffect(() => {
    if (!hydrated) return;
    if (conv === undefined) router.replace("/ask");
  }, [conv, router, hydrated]);

  // Conversation id changed (e.g. same component reused between chats).
  // Guarded with a prev-id ref so Strict-Mode remounts DON'T reset the
  // auto-run guard (that double-send duplicated every ?q= message).
  const prevIdRef = useRef<string>(id);
  useEffect(() => {
    if (prevIdRef.current === id) return;
    prevIdRef.current = id;
    autoRan.current = null;
    setRunning(false);
    runningRef.current = false;
    setInput("");
    setScrolledUp(false);
    nearBottom.current = true;
  }, [id]);

  const send = useCallback(
    async (
      text: string,
      opts?: { metadataFilters?: Record<string, unknown>; web?: boolean; mode?: ChatMode },
    ) => {
      const query = text.trim();
      if (!query || !conv || runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      abortedRef.current = false;

      if (conv.title === "New chat") {
        storeRef.current.renameConversation(conv.id, suggestTitle(query));
      }
      storeRef.current.updateConversation(conv.id, {});

      const userMsg: ChatMessage = {
        id: uid(),
        role: "user",
        content: query,
        createdAt: Date.now(),
      };
      const asstId = uid();
      const buf: string[] = [];
      storeRef.current.addMessage(conv.id, userMsg);
      storeRef.current.addMessage(conv.id, {
        id: asstId,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: Date.now(),
      });

      // Deep Research is a different pipeline, not a retrieval-mode flag:
      // /api/research owns planning, fan-out and dedup, and streams its own
      // progress packets back.
      if ((opts?.mode ?? "fast") === "research") {
        try {
          const final = await researchRef.current({
            query,
            database: config.database,
            collection: config.collection,
            collections: config.collections,
            // Via ref: `send` does not depend on config.llm (adding it would
            // re-create the callback on every settings keystroke), so reading
            // it directly captured whatever the model was when `send` was last
            // memoized. Changing model mid-session then ran research on the
            // old one.
            llm: configLlmRef.current,
            onState: (rs) =>
              storeRef.current.updateMessage(conv.id, asstId, {
                research: rs,
                // Feed the deduped sources into the normal citation panel, so
                // a research answer's [n] are clickable exactly like a Fast
                // answer's. The registry already numbered them globally, and
                // SourcesPanel numbers in array order, so the two agree.
                ...(rs.sources.length > 0
                  ? { sources: researchSourcesToChunks(rs.sources) }
                  : {}),
              }),
            onDelta: (d) => {
              buf.push(d);
              storeRef.current.updateMessage(conv.id, asstId, {
                content: buf.join(""),
              });
            },
          });
          const content = buf.join("").trim();
          // The run resolves even when it was stopped or failed mid-flight, so
          // branch on the reported phase — marking a truncated answer "done"
          // would present it as a complete result.
          if (final.phase === "error") {
            storeRef.current.updateMessage(conv.id, asstId, {
              content: content || "_Deep Research could not complete._",
              status: "error",
              error: final.error ?? "Deep Research failed.",
            });
          } else if (final.phase === "stopped") {
            storeRef.current.updateMessage(conv.id, asstId, {
              content: content || "_Stopped._",
              status: "stopped",
            });
          } else {
            storeRef.current.updateMessage(conv.id, asstId, {
              content: content || "_Deep Research returned no answer._",
              status: "done",
            });
          }
        } catch (err) {
          storeRef.current.updateMessage(conv.id, asstId, {
            content: buf.join("") || "_Deep Research could not complete._",
            status: "error",
            error: err instanceof Error ? err.message : "Deep Research failed.",
          });
        } finally {
          runningRef.current = false;
          setRunning(false);
        }
        return;
      }

      try {
        // Scope precedence (same rule as Context search + mindmap): a single
        // `collection` shadows the multi-select `collections`.
        const singleCol = config.collection || undefined;
        const multiCols =
          !singleCol && config.collections && config.collections.length > 0
            ? config.collections
            : undefined;
        const { chunks, canAnswer, streamPromise, requestId } = await qaRef.current({
          query,
          conversationId: conv.id,
          // Both the question and this placeholder are already in the store,
          // so runQa needs to know where the current turn starts to keep it
          // out of its own prompt history.
          assistantMessageId: asstId,
          database: config.database,
          ...(singleCol ? { collection: singleCol } : multiCols ? { collections: multiCols } : {}),
          kind: "all",
          webSearch: opts?.web ?? false,
          // "research" returned above, so only Hydra's own modes reach here.
          mode: opts?.mode === "thinking" ? "thinking" : "fast",
          metadataFilters:
            opts?.metadataFilters && Object.keys(opts.metadataFilters).length > 0
              ? opts.metadataFilters
              : undefined,
          onChunks: (ch) =>
            storeRef.current.updateMessage(conv.id, asstId, { sources: ch }),
          // Web citations are additive: the answer cites Hydra chunks as [1],
          // [2] and web results as [Web 1], so clearing `sources` here would
          // strip the panel the numbered citations resolve against.
          onWebSources: (citations) =>
            storeRef.current.updateMessage(conv.id, asstId, { webCitations: citations }),
          onDelta: (d) => {
            buf.push(d);
            storeRef.current.updateMessage(conv.id, asstId, {
              content: buf.join(""),
            });
          },
        });

        if (chunks.length === 0) {
          storeRef.current.updateMessage(conv.id, asstId, { sources: chunks });
        }
        if (requestId) {
          storeRef.current.updateMessage(conv.id, asstId, { requestId });
        }

        if (!canAnswer || !streamPromise) {
          storeRef.current.updateMessage(conv.id, asstId, {
            content:
              "_I can retrieve context, but I can't write an answer yet — add an LLM provider in Settings to enable Ask mode._",
            status: "done",
          });
          return;
        }

        await streamPromise;

        let content = buf.join("");
        if (!content.trim()) {
          content = "_No answer was returned. Try rephrasing the question._";
        }
        storeRef.current.updateMessage(conv.id, asstId, {
          content,
          status: "done",
        });
      } catch (err) {
        const content = buf.join("");
        if (abortedRef.current) {
          storeRef.current.updateMessage(conv.id, asstId, {
            content: content || "_Stopped._",
            status: "stopped",
          });
          return;
        }
        const msg =
          err instanceof Error ? err.message : "Something went wrong while answering.";
        storeRef.current.updateMessage(conv.id, asstId, {
          content: content || "_I couldn't answer that._",
          status: "error",
          error: msg,
        });
        toast.push({
          kind: "error",
          title: "Answer failed",
          detail: msg,
        });
      } finally {
        runningRef.current = false;
        setRunning(false);
        inputRef.current?.focus();
      }
    },
    [conv, config.database, config.collection, config.collections, toast],
  );

  // Auto-run the ?q= query once per conversation (from the ask page).
  // runningRef guard makes this idempotent even if the effect double-fires.
  useEffect(() => {
    if (!conv || conv.messages.length > 0) return;
    if (autoRan.current === conv.id) return;
    if (!q.trim()) return;
    if (runningRef.current) return;
    autoRan.current = conv.id;
    void send(q, { metadataFilters: filters, web: webSearch, mode });
  }, [conv, q, send, filters, webSearch, mode]);

  const submit = useCallback(() => {
    if (running) return;
    void send(input, { metadataFilters: filters, web: webSearch, mode });
    setInput("");
  }, [input, running, send, filters, webSearch, mode]);

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const stopRun = useCallback(() => {
    abortedRef.current = true;
    stop(id);
    // A research run streams from its own endpoint, so the QA abort map does
    // not cover it — cancel both rather than guessing which is in flight.
    stopResearch();
  }, [stop, id, stopResearch]);

  const copyLastAnswer = useCallback(async () => {
    const src = lastAssistantContent(messages);
    if (!src) return;
    const ok = await copyText(src);
    toast.push(
      ok
        ? { kind: "success", title: "Answer copied" }
        : { kind: "error", title: "Could not copy" },
    );
  }, [messages, toast]);

  const copyMessage = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      toast.push(
        ok
          ? { kind: "success", title: "Answer copied" }
          : { kind: "error", title: "Could not copy" },
      );
    },
    [toast],
  );

  /**
   * Submit a rating for the retrieval behind an answer.
   *
   * Always sends prose: /feedback rejects a submission carrying neither
   * `feedback` nor `ground_truth` ("records nothing"), so a bare rating would
   * be silently discarded by the API.
   *
   * Optimistic and fire-and-forget — feedback is a signal that never changes
   * the result, so a failed report must not interrupt the user.
   */
  const submitRating = useCallback(
    (
      messageId: string,
      requestId: string,
      rating: "positive" | "negative",
      detail?: string,
    ) => {
      const text =
        detail?.trim() ||
        (rating === "positive"
          ? "User marked these retrieved results as helpful."
          : "User marked these retrieved results as not helpful.");
      updateMessage(id, messageId, { feedback: rating });
      toast.push({
        kind: "success",
        title: rating === "positive" ? "Thanks — noted" : "Thanks — we'll tune retrieval",
      });
      void hydra.submitFeedback({ requestId, rating, feedback: text }).catch(() => {
        /* fire-and-forget by contract — never surface a feedback failure */
      });
    },
    [hydra, id, toast, updateMessage],
  );

  /**
   * A thumbs-up is self-explanatory, but "this was wrong" is only actionable
   * with specifics — so ask for them on the negative path only (optional).
   */
  const rateMessage = useCallback(
    (messageId: string, requestId: string, rating: "positive" | "negative") => {
      if (rating === "negative") {
        setRatingDraft({ messageId, requestId, text: "" });
        return;
      }
      submitRating(messageId, requestId, "positive");
    },
    [submitRating],
  );

  /**
   * Re-ask the question that produced a given answer.
   *
   * The conversation is a flat list rather than a tree, so this appends a
   * fresh turn instead of branching in place — hence "Ask again" rather than
   * "Regenerate", which would imply the previous answer is replaced.
   */
  const askAgain = useCallback(
    (assistantId: string) => {
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      const original = messages[idx];
      for (let i = idx - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          // Re-run the pipeline that produced the original answer, not
          // whatever the composer happens to be set to now. Asking again on a
          // Deep Research answer after switching to Fast used to quietly give
          // a Fast answer, which is not "again".
          //
          // Only the research pipeline is recoverable from a stored message —
          // the mode and web toggles are not persisted per message. So a
          // research answer re-runs as research, and everything else uses the
          // current toggles. Recording the full run options per message would
          // fix the rest and is not worth a schema change here.
          const wasResearch = Boolean(original?.research);
          void send(messages[i].content, {
            web: webSearch,
            mode: wasResearch ? "research" : mode,
            metadataFilters: filters,
          });
          return;
        }
      }
    },
    [messages, send, webSearch, mode, filters],
  );

  const doDelete = useCallback(() => {
    deleteConversation(id);
    toast.push({ kind: "info", title: "Conversation deleted" });
    router.replace("/ask");
  }, [deleteConversation, id, router, toast]);

  // Autoscroll when messages change, only if already near the bottom.
  const lastKey = `${messages.length}:${messages[messages.length - 1]?.content.length ?? 0}`;
  useEffect(() => {
    if (nearBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lastKey, running]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const up = el.scrollHeight - el.scrollTop - el.clientHeight > 140;
    nearBottom.current = !up;
    setScrolledUp(up);
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, []);

  const composerGrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 116)}px`;
  }, []);

  /** Quote the start of an answer into the composer and focus it. */
  const replyTo = useCallback(
    (content: string) => {
      const plain = plainText(content);
      const quote = plain.length > 160 ? `${plain.slice(0, 160).trimEnd()}…` : plain;
      setInput(`> ${quote}\n\n`);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        composerGrow();
      });
    },
    [composerGrow],
  );

  /**
   * Start a new conversation holding everything up to and including this
   * answer, so a different follow-up does not disturb the original thread.
   */
  const forkAt = useCallback(
    (messageId: string) => {
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      const copy = messages.slice(0, idx + 1).map((m) => ({ ...m, id: uid() }));
      const fork = createConversation(`${conv?.title ?? "Chat"} (fork)`, copy);
      router.push(`/chat/${fork.id}`);
    },
    [conv?.title, createConversation, messages, router],
  );

  // Read aloud through the browser's speech engine. One answer at a time;
  // choosing it again, or leaving the page, stops it.
  const [readingId, setReadingId] = useState<string | null>(null);
  const readAloud = useCallback(
    (messageId: string, content: string) => {
      const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
      if (!synth) {
        toast.push({ kind: "error", title: "Read aloud is not supported in this browser" });
        return;
      }
      synth.cancel();
      if (readingId === messageId) {
        setReadingId(null);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(plainText(content));
      utterance.onend = () => setReadingId((cur) => (cur === messageId ? null : cur));
      utterance.onerror = utterance.onend;
      setReadingId(messageId);
      synth.speak(utterance);
    },
    [readingId, toast],
  );
  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const isEmpty = messages.length === 0;

  // Hydrating from MongoDB — show a skeleton instead of an empty chat.
  if (waitingForStore) {
    return (
      <div className="flex h-full flex-col">
        <ChatHeader title="Loading…" loading onBack={() => router.push("/ask")} />
        <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-end gap-4 overflow-y-auto px-4 pb-4">
          <div className="h-20 animate-pulse rounded-md bg-white/[0.04]" />
          <div className="h-14 animate-pulse rounded-md bg-white/[0.03]" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        title={conv?.title ?? "Chat"}
        meta={
          messages.length > 0 && conv
            ? `${messages.length} message${messages.length === 1 ? "" : "s"} · ${timeAgo(conv.updatedAt)}`
            : "New conversation"
        }
        running={running}
        canCopy={Boolean(lastAssistantContent(messages))}
        onBack={() => router.push("/ask")}
        onRename={conv ? (title) => renameConversation(conv.id, title) : undefined}
        onCopy={() => void copyLastAnswer()}
        onNew={() => router.push("/ask")}
        onDelete={() => setConfirmDelete(true)}
      />

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[760px] px-3 py-6 sm:px-6">
          {isEmpty ? (
            <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md border border-stroke-1 bg-white/[0.04] text-text-1">
                <Icon name="sparkles" size={22} />
              </div>
              <h2 className="font-pixel text-[22px] font-normal text-text-3">
                Ask anything from your second brain
              </h2>
              <p className="mt-1 max-w-[360px] text-[13px] text-fg-3">
                Answers are retrieved from your memories, documents and
                connected apps — then written with your LLM of choice.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-1.5">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setInput("");
                      void send(s);
                    }}
                    className="rounded-full border border-stroke-1 px-3 py-1.5 text-[12px] text-fg-3 transition-colors hover:border-stroke-3 hover:text-fg"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-stroke-1 bg-white/[0.06] px-4 py-2.5 text-[13.5px] leading-relaxed text-text-3">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="group flex items-start gap-2.5">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-stroke-1 bg-white/[0.04] text-text-1">
                      <Icon name="spark" size={14} />
                    </div>
                    <div
                      className="min-w-0 flex-1 pt-0.5"
                      // The answer is the product. Without this a screen
                      // reader user asked a question and heard nothing at all:
                      // no progress, no answer, no completion.
                      //
                      // `aria-busy` while streaming is what keeps this usable.
                      // A live region announcing every token would stutter
                      // continuously for the whole answer; marking the region
                      // busy tells assistive tech to wait and read it once it
                      // settles.
                      aria-busy={m.status === "streaming"}
                      aria-live="polite"
                    >
                      {m.research ? (
                        <ResearchTimeline state={m.research} className="mb-2.5" />
                      ) : null}
                      {m.status === "error" ? (
                        <div className="space-y-2">
                          <Markdown
                            text={m.content}
                            maxRef={citationCount(m)}
                            onCite={(ref) => setCiteFocus({ messageId: m.id, ref })}
                          />
                          <p className="flex items-start gap-1.5 rounded-sm border border-bad/30 bg-bad-fill px-2.5 py-1.5 text-[12px] text-bad">
                            <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                            {m.error ?? "Something went wrong."}
                          </p>
                        </div>
                      ) : m.status === "streaming" && !m.content ? (
                        <TypingDots />
                      ) : (
                        <>
                          <Markdown
                            text={m.content}
                            maxRef={citationCount(m)}
                            onCite={(ref) => setCiteFocus({ messageId: m.id, ref })}
                          />
                          {m.status === "streaming" ? (
                            <span
                              className="cursor-blink ml-0.5 inline-block h-[14px] w-[7px] translate-y-[2px] rounded-[2px] bg-text-1"
                              aria-hidden="true"
                            />
                          ) : null}
                          {m.status === "stopped" ? (
                            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-fg-4">
                              <Icon name="stop" size={12} className="shrink-0" />
                              Stopped — this answer is incomplete.
                            </p>
                          ) : null}
                        </>
                      )}
                      {(m.sources && m.sources.length > 0) || (m.webCitations && m.webCitations.length > 0) ? (
                        <SourcesPanel
                          chunks={m.sources ?? []}
                          webCitations={m.webCitations ?? []}
                          className="mt-2.5 animate-fadeIn"
                          focusRef={
                            citeFocus?.messageId === m.id ? citeFocus.ref : null
                          }
                          onFocusHandled={() => setCiteFocus(null)}
                        />
                      ) : null}
                      {/* Completed-answer actions only for a genuinely
                          finished answer — never for a stopped or errored one,
                          whose content is partial. */}
                      {m.status === "done" && m.content ? (
                        <div className="mt-2">
                          <MessageActions
                            text={m.content}
                            sentAt={new Date(m.createdAt)}
                            initialVote={
                              m.feedback === "positive" ? "up" : m.feedback === "negative" ? "down" : null
                            }
                            // Ratings grade the Hydra retrieval behind this
                            // answer, which needs the query's request id.
                            showVotes={Boolean(m.requestId)}
                            reading={readingId === m.id}
                            onCopy={(text) => void copyMessage(text)}
                            onVote={(vote) => {
                              if (!m.requestId || !vote) return;
                              rateMessage(m.id, m.requestId, vote === "up" ? "positive" : "negative");
                            }}
                            onReply={() => replyTo(m.content)}
                            onAgain={running ? undefined : () => askAgain(m.id)}
                            onAloud={() => readAloud(m.id, m.content)}
                            onFork={() => forkAt(m.id)}
                            onReport={
                              m.requestId
                                ? () => rateMessage(m.id, m.requestId!, "negative")
                                : undefined
                            }
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
          <div className="h-2" />
        </div>
      </div>

      {/* Floating scroll-to-bottom */}
      {scrolledUp ? (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-[150px] right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-stroke-1 bg-[#141416] text-text-1 shadow-xl transition-transform hover:scale-105 md:bottom-[100px]"
          aria-label="Scroll to bottom"
        >
          <Icon name="chevDown" size={16} />
        </button>
      ) : null}

      {/* Composer */}
      <div className="shrink-0 bg-[#0a0a0b]/95 backdrop-blur-sm">
        <div className="mx-auto w-full max-w-[760px] px-3 py-3 sm:px-6 min-w-0">
          {llmMissing ? (
            <LlmMissingNotice className="mb-2.5" />
          ) : null}
          {/* Scope chips */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                const next = !webSearch;
                setWebSearch(next);
                try {
                  window.localStorage.setItem("open-glean.webSearch", next ? "1" : "0");
                } catch {
                  // best-effort
                }
              }}
              aria-pressed={webSearch}
              className={cn(
                "flex h-[24px] items-center gap-1.5 rounded-full border border-solid px-2.5 text-[11.5px] font-medium transition-colors",
                webSearch
                  ? "border-accent-line bg-white/10 text-text-3"
                  : "border-stroke-1 text-text-2 hover:border-stroke-3 hover:text-text-1",
              )}
              title={
                webSearch
                  ? "Web search is on — answers can cite live results"
                  : "Web search is off — answers use your context only"
              }
            >
              <Icon name="globe" size={12} />
              Web
            </button>
            <button
              type="button"
              onClick={() => {
                const next = nextMode(mode);
                setMode(next);
                storeMode(next);
              }}
              aria-pressed={mode !== "fast"}
              className={cn(
                "flex h-[24px] items-center gap-1.5 rounded-full border border-solid px-2.5 text-[11.5px] font-medium transition-colors",
                mode !== "fast"
                  ? "border-accent-line bg-white/10 text-text-3"
                  : "border-stroke-1 text-text-2 hover:border-stroke-3 hover:text-text-1",
              )}
              title={MODE_META[mode].title}
            >
              <Icon name={MODE_META[mode].icon} size={12} />
              {MODE_META[mode].label}
            </button>
            {filters && Object.keys(filters).length > 0 ? (
              <button
                type="button"
                onClick={() => setFilters(undefined)}
                className="flex h-[24px] items-center gap-1.5 rounded-full border border-solid border-accent-line bg-white/10 px-2.5 text-[11.5px] font-medium text-text-3 transition-colors hover:bg-white/[0.14]"
                title="Clear the metadata filters"
              >
                <Icon name="filter" size={12} />
                {Object.keys(filters).length} filter{Object.keys(filters).length === 1 ? "" : "s"}
                <Icon name="x" size={10} />
              </button>
            ) : null}
          </div>
          <div
            className={cn(
              "flex items-end gap-2 rounded-xl border border-stroke-1 bg-white/[0.03] px-3 py-2 shadow-2xl shadow-black/60 transition-colors",
              "focus-within:border-stroke-3 focus-within:ring-4 focus-within:ring-white/[0.06]",
              running && "opacity-60",
            )}
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              disabled={running}
              onChange={(e) => {
                setInput(e.target.value);
                composerGrow();
              }}
              onKeyDown={onComposerKey}
              placeholder="Ask anything from your second brain…"
              aria-label="Message"
              className="no-focus-ring max-h-[116px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-relaxed text-fg outline-none placeholder:text-fg-4 disabled:cursor-not-allowed"
            />
            {running ? (
              <button
                onClick={stopRun}
                className="btn shrink-0 rounded-full border border-stroke-1 text-text-1 hover:bg-white/[0.06]"
                aria-label="Stop generating"
              >
                <Icon name="stop" size={14} />
                <span className="hidden sm:inline">Stop</span>
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!input.trim() || running}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text-1 text-[#0a0a0b] transition-colors hover:bg-text-3 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Send"
              >
                <Icon name="send" size={14} />
              </button>
            )}
          </div>
          <p className="mt-1.5 px-1 text-[11px] text-fg-5">
            {running
              ? "Retrieving context and writing…"
              : filters && Object.keys(filters).length > 0
                ? `${Object.keys(filters).length} metadata filter${Object.keys(filters).length === 1 ? "" : "s"} active · Enter ↵ to send`
                : "Enter ↵ to send · Shift+Enter for a new line"}
          </p>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={doDelete}
        title="Delete conversation?"
        message="This removes the conversation (and its sources) from your device. This cannot be undone."
        confirmLabel="Delete"
      />

      <Modal
        open={ratingDraft !== null}
        onClose={() => setRatingDraft(null)}
        title="What was wrong with these results?"
        width={440}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setRatingDraft(null)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                if (!ratingDraft) return;
                submitRating(
                  ratingDraft.messageId,
                  ratingDraft.requestId,
                  "negative",
                  ratingDraft.text,
                );
                setRatingDraft(null);
              }}
            >
              Send feedback
            </button>
          </>
        }
      >
        <p className="mb-2.5 text-[12.5px] leading-relaxed text-fg-3">
          Specifics tune retrieval; &ldquo;bad results&rdquo; can&rsquo;t.
          Something like &ldquo;returned the 2023 policy, the current one is in
          the Q3 handbook&rdquo; is what helps. Optional — you can send it blank.
        </p>
        <textarea
          autoFocus
          rows={3}
          value={ratingDraft?.text ?? ""}
          onChange={(e) =>
            setRatingDraft((d) => (d ? { ...d, text: e.target.value } : d))
          }
          placeholder="What did you expect to see instead?"
          className="w-full resize-none rounded-md border border-stroke-1 bg-surface-4 px-3 py-2 text-[13px] text-text-1 outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-stroke-3 focus:ring-3 focus:ring-white/[0.06]"
        />
      </Modal>
    </div>
  );
}