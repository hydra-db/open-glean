/**
 * Which conversations are abandoned and safe to delete.
 *
 * The store writes the conversation eagerly, on submit, so it survives a reload
 * mid-answer. The cost is a row left behind whenever the answer never arrives.
 * This module decides which of those rows are dead.
 *
 * The rule is conservative. A streaming chat also has no assistant content, so
 * any rule stricter than "empty AND untouched for a while" would delete live
 * conversations. A stale row is cosmetic. Deleting an in-flight question is not.
 *
 * A sweep on read rather than a TTL index. A Mongo TTL index expires
 * on a date field, and the condition here is "empty AND old", which a TTL
 * cannot express — it would delete every conversation after the window,
 * answered or not. Move to a TTL only if a dedicated `expiresAt` field is
 * added, set at create and cleared on first answer.
 */
import type { Conversation } from "@/lib/types";

/**
 * How long an empty conversation is left alone.
 *
 * Long enough to cover a slow Deep Research run (minutes, not seconds) plus a
 * user who walks away mid-answer and comes back.
 */
export const REAP_AFTER_MS = 60 * 60 * 1000; // 1 hour

/**
 * True when the conversation holds something worth keeping.
 *
 * An errored or stopped answer counts. Its status is terminal, so the run
 * finished, and the user may want to see the failure or retry it. Only a
 * conversation with no outcome at all is a candidate for reaping.
 */
function hasRealAnswer(conv: Conversation): boolean {
  return conv.messages.some(
    (m) =>
      m.role === "assistant" &&
      (m.content.trim().length > 0 ||
        m.status === "error" ||
        m.status === "stopped"),
  );
}

/**
 * True when a conversation was started and never produced an answer, and
 * enough time has passed that it is not simply still running.
 */
export function isAbandoned(conv: Conversation, now: number = Date.now()): boolean {
  if (hasRealAnswer(conv)) return false;
  // Take the later of the two timestamps. A row with no updatedAt must not be
  // reaped while the store still writes to it.
  const touched = Math.max(conv.createdAt ?? 0, conv.updatedAt ?? 0);
  return now - touched > REAP_AFTER_MS;
}
