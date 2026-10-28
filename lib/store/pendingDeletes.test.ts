/**
 * Pending-delete reconciliation for the chat store.
 *
 * `api()` in `lib/store/chat.tsx` never throws; it returns `null` on transport
 * errors and `{ persisted: false }` when the server could not reach Mongo.
 * Both `deleteConversation` and the hydration retry loop previously wrapped
 * `await api(\`/${id}\`, { method: "DELETE" })` in `try / catch` without
 * inspecting the response:
 *
 *   - The `catch` block (`setSaveFailed(true)` / keeping the id in
 *     `pendingDeletes`) was unreachable dead code.
 *   - `pendingDeletes.current.delete(id)` ran unconditionally, even when the
 *     server was down, so the deleted chat reappeared on the next reload.
 *   - During hydration, the retry loop mutated `pendingDeletes.current` while
 *     `GET /api/chats/:id` was still in flight for the un-filtered `res.chats`
 *     list, racing the filter on `serverConvs`.
 */
import { describe, expect, it } from "vitest";
import type { Conversation } from "@/lib/types";
import {
  filterLocalOnly,
  planHydrationDeletes,
  writeFailed,
} from "./pendingDeletes";

function conv(id: string): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: 1,
    updatedAt: 2,
    messages: [],
  };
}

describe("writeFailed", () => {
  it("treats null (network / HTTP error) as a failed write", () => {
    expect(writeFailed(null)).toBe(true);
  });

  it("treats { persisted: false } as a failed write", () => {
    expect(writeFailed({ persisted: false })).toBe(true);
  });

  it("treats { persisted: true } as a confirmed write", () => {
    expect(writeFailed({ persisted: true })).toBe(false);
  });
});

describe("planHydrationDeletes", () => {
  it("excludes pending deletes from entriesToLoad before retries run", () => {
    const plan = planHydrationDeletes(
      ["c1", "c2", "c3"],
      new Set(["c2"]),
    );
    expect(plan.entriesToLoad).toEqual(["c1", "c3"]);
    expect(plan.toRetry).toEqual(["c2"]);
    expect(plan.alreadyGone).toEqual([]);
  });

  it("marks pending IDs that are no longer on the server as alreadyGone instead of retrying", () => {
    // A DELETE for a row that is already gone returns deletedCount === 0
    // ({ persisted: false }), which would otherwise look like a failed delete
    // and keep the id stuck in pendingDeletes forever.
    const plan = planHydrationDeletes(
      ["c1"],
      new Set(["c-already-deleted", "c1"]),
    );
    expect(plan.alreadyGone).toEqual(["c-already-deleted"]);
    expect(plan.toRetry).toEqual(["c1"]);
    expect(plan.entriesToLoad).toEqual([]);
  });

  it("retries off-page pending deletes when the server list hits the 200-entry cap", () => {
    // listChats returns only the newest 200 chats. When all 200 slots are full,
    // an older pending-delete chat may still exist on the server beyond the
    // first page and must be retried rather than marked alreadyGone.
    const fullPage = Array.from({ length: 200 }, (_, i) => `c-${i}`);
    const plan = planHydrationDeletes(
      fullPage,
      new Set(["c-older-than-200", "c-0"]),
      200,
    );
    expect(plan.alreadyGone).toEqual([]);
    expect(plan.toRetry).toEqual(["c-older-than-200", "c-0"]);
    expect(plan.entriesToLoad).toHaveLength(199);
    expect(plan.entriesToLoad).not.toContain("c-0");
  });
});

describe("filterLocalOnly", () => {
  it("excludes conversations that are either on the server or pending deletion", () => {
    const local = [conv("server-chat"), conv("deleted-chat"), conv("local-chat")];
    const result = filterLocalOnly(
      local,
      new Set(["server-chat"]),
      new Set(["deleted-chat"]),
    );
    expect(result.map((c) => c.id)).toEqual(["local-chat"]);
  });
});
