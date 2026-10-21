/**
 * Reconciliation rules for conversation deletes (`open-glean.pendingDeletes.v1`).
 *
 * `api()` in `./chat.tsx` never throws: it resolves to `null` on a network or
 * HTTP error and `{ persisted: false }` when the server could not reach Mongo.
 * Wrapping `await api(\`/${id}\`, { method: "DELETE" })` in `try / catch` left
 * the `catch` block unreachable, so a failed delete immediately cleared its own
 * `pendingDeletes` entry and never flipped `saveFailed`.
 *
 * Separating the reconciliation logic here lets tests verify:
 *   1. `writeFailed` catches both transport failures (`null`) and unpersisted
 *      server responses (`{ persisted: false }`).
 *   2. On hydration, pending deletes are Partitioned against the server's chat
 *      list *before* any concurrent `DELETE` mutates `pendingDeletes`:
 *        - IDs already absent from the server list are pruned without issuing a
 *          `DELETE` (which would return `{ persisted: false }` from
 *          `deletedCount === 0` and look like an outage).
 *        - IDs still present on the server are excluded from `entriesToLoad`
 *          up-front (so a `DELETE` finishing before `GET /api/chats/:id` cannot
 *          un-filter the row) and queued for retry.
 *   3. `filterLocalOnly` excludes `pendingDeletes` as well as `serverIds`.
 */
import type { Conversation } from "@/lib/types";

/**
 * True when a write or delete did not reach the database.
 *
 * `null` is a transport failure; `{ persisted: false }` is the server telling
 * us it could not store the mutation. Both mean the change is not saved.
 */
export function writeFailed(res: { persisted?: boolean } | null): boolean {
  return res === null || res.persisted === false;
}

export interface HydrationDeletePlan {
  /** Pending IDs already absent on the server — safe to clear immediately. */
  alreadyGone: string[];
  /** Pending IDs still present on the server — must be retried with DELETE. */
  toRetry: string[];
  /** Server chat IDs to fetch full conversations for (excludes pending deletes). */
  entriesToLoad: string[];
}

export const SERVER_LIST_LIMIT = 200;

/**
 * Partition the server chat list against `pendingDeletes` at hydration time.
 *
 * `listChats` returns at most `listLimit` (200) entries. A pending ID absent
 * from `serverEntryIds` is guaranteed gone on the server only when the list is
 * shorter than `listLimit`; when the list is full, an older conversation may
 * sit beyond page 1 and must still be retried with `DELETE`.
 */
export function planHydrationDeletes(
  serverEntryIds: readonly string[],
  pendingDeletes: ReadonlySet<string>,
  listLimit: number = SERVER_LIST_LIMIT,
): HydrationDeletePlan {
  const serverSet = new Set(serverEntryIds);
  const listIsComplete = serverEntryIds.length < listLimit;
  const alreadyGone: string[] = [];
  const toRetry: string[] = [];

  for (const pendingId of pendingDeletes) {
    const bucket =
      serverSet.has(pendingId) || !listIsComplete ? toRetry : alreadyGone;
    bucket.push(pendingId);
  }

  const entriesToLoad = serverEntryIds.filter((id) => !pendingDeletes.has(id));
  return { alreadyGone, toRetry, entriesToLoad };
}

/**
 * Keep only conversations from localStorage that are neither on the server nor
 * awaiting deletion.
 */
export function filterLocalOnly(
  local: readonly Conversation[],
  serverIds: ReadonlySet<string>,
  pendingDeletes: ReadonlySet<string>,
): Conversation[] {
  return local.filter((c) => !serverIds.has(c.id) && !pendingDeletes.has(c.id));
}
