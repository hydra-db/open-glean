"use client";

/**
 * Conversation store — MongoDB-backed with a localStorage fallback.
 *
 * - On mount, hydrates the list from /api/chats (server persists to Mongo).
 * - Every mutation applies locally first (optimistic) and mirrors to the API.
 *   Streaming content is persisted only once the message reaches a terminal
 *   state — one write per answer, not per delta. Which patches are worth a
 *   write is decided by ./persistPatch.
 * - Writes go through `write`, which notices when one does not land. A failure
 *   mirrors the data to localStorage and flips `saveFailed`, which the
 *   SaveStatusBanner surfaces. Mirrors were previously gated on `localMode`,
 *   which is only set during hydration, so an outage that began after load
 *   wrote nothing anywhere and the conversation vanished on refresh.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChatMessage, Conversation } from "@/lib/types";
import { shouldPersistPatch } from "./persistPatch";

const STORAGE_KEY = "open-glean.chats.v1";
/** Ids whose server DELETE failed, so recovery can retry and not resurrect them. */
const PENDING_DELETE_KEY = "open-glean.pendingDeletes.v1";
const MAX_CONVERSATIONS = 200;

function loadPendingDeletes(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(PENDING_DELETE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function savePendingDeletes(ids: Set<string>): void {
  try {
    localStorage.setItem(PENDING_DELETE_KEY, JSON.stringify([...ids]));
  } catch {
    // best-effort
  }
}

interface ChatStoreValue {
  conversations: Conversation[];
  /** True when the server-side (Mongo) persistence is active. */
  persisted: boolean;
  /**
   * True once a write has failed. Distinct from `!persisted`, which only ever
   * described the state at page load: an outage that starts mid-session sets
   * this while `persisted` stays true.
   */
  saveFailed: boolean;
  hydrated: boolean;
  getConversation: (id: string) => Conversation | undefined;
  createConversation: (
    title?: string,
    messages?: ChatMessage[],
  ) => Conversation;
  updateConversation: (id: string, patch: Partial<Conversation>) => void;
  addMessage: (id: string, message: ChatMessage) => void;
  updateMessage: (id: string, messageId: string, patch: Partial<ChatMessage>) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
}

const ChatStoreContext = createContext<ChatStoreValue | null>(null);

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadLocal(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c) => c && typeof c.id === "string")
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function saveLocal(conversations: Conversation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // storage full — keep in-memory only
  }
}

/**
 * API mirror. Never throws, but reports WHY it failed.
 *
 * The old version collapsed every failure to `null`, so a transport error and
 * a server that persisted nothing were indistinguishable — and every caller
 * discarded the result anyway. That is how a Mongo outage after page load
 * became silent data loss: writes kept "succeeding" into nothing.
 */
async function api(
  path: string,
  init?: RequestInit,
): Promise<{ persisted?: boolean; chats?: unknown; conversation?: unknown } | null> {
  try {
    const res = await fetch(`/api/chats${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
    return (await res.json()) as { persisted?: boolean };
  } catch {
    return null;
  }
}

/**
 * True when a write did not reach the database.
 *
 * `null` is a transport failure; `{ persisted: false }` is the server telling
 * us it could not store the write. Both mean the data is not saved, and both
 * were previously thrown away.
 */
function writeFailed(res: { persisted?: boolean } | null): boolean {
  return res === null || res.persisted === false;
}

export function ChatStoreProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [persisted, setPersisted] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  /**
   * Set once a write fails after a healthy start. `persisted` only ever
   * described the state at page load, so an outage that began afterwards was
   * invisible — the store kept reporting `true` while nothing was saving.
   */
  const [saveFailed, setSaveFailed] = useState(false);
  /** Conversation ids the server already knows about (skip re-creating). */
  const serverIds = useRef(new Set<string>());
  /** Ids the user deleted whose server DELETE has not yet confirmed. Persisted,
   *  so a delete that failed during an outage is retried and filtered on the
   *  next load instead of the chat reappearing. */
  const pendingDeletes = useRef<Set<string>>(new Set());
  const localMode = useRef(false);
  /** Per-conversation op queue — serializes mutations behind the create POST
   *  so an append can never race ahead of the insert (which silently dropped
   *  messages). */
  const opQueues = useRef(new Map<string, Promise<unknown>>());
  const enqueue = useCallback((id: string, fn: () => Promise<unknown>) => {
    const prev = opQueues.current.get(id) ?? Promise.resolve();
    const next = prev.then(fn).catch(() => {});
    opQueues.current.set(id, next);
    return next;
  }, []);

  /**
   * Queue a write and notice when it does not land.
   *
   * Every mutation used to be `void enqueue(...)` with the result dropped, so
   * a failed PATCH was indistinguishable from a successful one. Routing them
   * all through here means one place decides what a failure means, and a
   * later caller cannot forget to check.
   *
   * On failure the data is mirrored to localStorage so it survives a reload,
   * and `saveFailed` flips so the UI can say so. We do NOT flip `localMode`:
   * that would stop retrying the server for the rest of the session, and a
   * blip should not permanently downgrade a working deployment.
   */
  const write = useCallback(
    (id: string, fn: () => Promise<{ persisted?: boolean } | null>) =>
      enqueue(id, async () => {
        const res = await fn();
        if (writeFailed(res)) setSaveFailed(true);
        return res;
      }),
    [enqueue],
  );

  // Hydrate: server list first; fall back to (and merge) local storage.
  useEffect(() => {
    let alive = true;
    pendingDeletes.current = loadPendingDeletes();
    (async () => {
      const res = await api("", { method: "GET" });
      if (!alive) return;
      const local = loadLocal();
      if (res?.persisted) {
        setPersisted(true);
        // Retry any delete that never confirmed, so a chat the user removed
        // during an outage does not come back on recovery.
        for (const id of [...pendingDeletes.current]) {
          void enqueue(id, async () => {
            try {
              await api(`/${id}`, { method: "DELETE" });
              pendingDeletes.current.delete(id);
              savePendingDeletes(pendingDeletes.current);
            } catch {
              /* stays pending; retried next load */
            }
          });
        }
        // Merge: server list wins on id collisions (it has the full messages);
        // purely-local conversations are kept so nothing vanishes.
        const server = await Promise.all(
          (await Promise.all(
            ((res as unknown as { chats?: { id: string }[] }).chats ?? []).map(
              async (entry) => {
                const full = await api(`/${entry.id}`);
                return (full as unknown as { conversation?: Conversation })?.conversation ?? null;
              },
            ),
          )),
        );
        const serverConvs = server.filter(
          (c): c is Conversation => c !== null && !pendingDeletes.current.has(c.id),
        );
        serverConvs.forEach((c) => serverIds.current.add(c.id));
        const localOnly = local.filter((c) => !serverIds.current.has(c.id));
        setConversations(
          [...serverConvs, ...localOnly].sort((a, b) => b.updatedAt - a.updatedAt),
        );
        if (localOnly.length) saveLocal(localOnly);
      } else {
        localMode.current = true;
        setConversations(local);
      }
      setHydrated(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // LocalStorage mirror.
  //
  // Previously gated on `localMode`, which is only ever set during hydration —
  // so an outage that began AFTER load wrote nothing anywhere and the
  // conversation was gone on refresh. Mirroring once a write has failed keeps
  // the data recoverable without paying the serialization cost on the happy
  // path.
  useEffect(() => {
    if (!hydrated) return;
    if (localMode.current || saveFailed) saveLocal(conversations);
  }, [conversations, hydrated, saveFailed]);

  const getConversation = useCallback(
    (id: string) => conversations.find((c) => c.id === id),
    [conversations],
  );

  const createConversation = useCallback(
    (title = "New chat", messages: ChatMessage[] = []): Conversation => {
      const conv: Conversation = {
        id: uid(),
        title: title || "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages,
      };
      setConversations((prev) => [conv, ...prev].slice(0, MAX_CONVERSATIONS));
      if (!localMode.current) {
        // Optimistically mark as server-known so early appends enqueue; the
        // queue guarantees they run AFTER the insert. Roll back on failure.
        serverIds.current.add(conv.id);
        void write(conv.id, async () => {
          const r = await api("", {
            method: "POST",
            body: JSON.stringify({ conversation: conv }),
          });
          if (!r?.persisted) serverIds.current.delete(conv.id);
          return r;
        });
      }
      return conv;
    },
    [],
  );

  const updateConversation = useCallback(
    (id: string, patch: Partial<Conversation>) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c,
        ),
      );
      if (patch.title !== undefined && !localMode.current && serverIds.current.has(id)) {
        void write(id, () =>
          api(`/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ title: patch.title }),
          }),
        );
      }
    },
    [write],
  );

  const addMessage = useCallback((id: string, message: ChatMessage) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, messages: [...c.messages, message], updatedAt: Date.now() }
          : c,
      ),
    );
    if (!localMode.current && serverIds.current.has(id)) {
      void write(id, () =>
        api(`/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ appendMessage: message }),
        }),
      );
    }
  }, [write]);

  const updateMessage = useCallback(
    (id: string, messageId: string, patch: Partial<ChatMessage>) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, ...patch } : m,
                ),
              }
            : c,
        ),
      );
      // See shouldPersistPatch: "does this carry anything durable?", not
      // "is the message finished?". The old form dropped requestId,
      // webCitations, feedback and research-without-sources.
      if (shouldPersistPatch(patch) && !localMode.current && serverIds.current.has(id)) {
        void write(id, () =>
          api(`/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ setMessage: { id: messageId, patch } }),
          }),
        );
      }
    },
    [write],
  );

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    serverIds.current.delete(id);
    if (!localMode.current) {
      // Record the delete as pending and persist it. If the DELETE fails (an
      // outage mid-session), the row survives on the server and would be
      // reloaded on recovery — so we filter and retry it on next load until it
      // confirms, instead of the deleted chat silently reappearing.
      pendingDeletes.current.add(id);
      savePendingDeletes(pendingDeletes.current);
      void enqueue(id, async () => {
        try {
          await api(`/${id}`, { method: "DELETE" });
          pendingDeletes.current.delete(id);
          savePendingDeletes(pendingDeletes.current);
        } catch {
          // Keep it pending; the next load retries and filters it out. Flag the
          // outage so the user knows the deletion has not reached the server.
          setSaveFailed(true);
        }
      });
    } else {
      saveLocal(loadLocal().filter((c) => c.id !== id));
    }
  }, [enqueue]);

  const renameConversation = useCallback((id: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    if (!localMode.current && serverIds.current.has(id)) {
      void write(id, () =>
        api(`/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ title }),
        }),
      );
    }
  }, [write]);

  const value = useMemo<ChatStoreValue>(
    () => ({
      conversations,
      persisted,
      saveFailed,
      hydrated,
      getConversation,
      createConversation,
      updateConversation,
      addMessage,
      updateMessage,
      deleteConversation,
      renameConversation,
    }),
    [
      conversations,
      persisted,
      saveFailed,
      hydrated,
      getConversation,
      createConversation,
      updateConversation,
      addMessage,
      updateMessage,
      deleteConversation,
      renameConversation,
    ],
  );

  return (
    <ChatStoreContext.Provider value={value}>
      {children}
    </ChatStoreContext.Provider>
  );
}

export function useChatStore(): ChatStoreValue {
  const ctx = useContext(ChatStoreContext);
  if (!ctx) throw new Error("useChatStore must be used within ChatStoreProvider");
  return ctx;
}