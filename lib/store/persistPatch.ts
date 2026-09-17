/**
 * Decide whether a message patch is worth a write.
 *
 * The rule lives here, apart from chat.tsx, so tests can call it and so the
 * list of durable fields appears in one place.
 *
 * The question is "does this patch carry anything durable?", not "is the
 * message finished?". Fields such as requestId, webCitations and feedback
 * arrive in patches of their own, with no terminal status.
 */
import type { ChatMessage } from "@/lib/types";

/**
 * Fields worth a round trip. `content` is absent on purpose. It arrives once
 * per streamed token, and the terminal status that accompanies the final value
 * persists it.
 */
const DURABLE_FIELDS = [
  "sources",
  "webCitations",
  "requestId",
  "feedback",
  "research",
  "error",
] as const satisfies readonly (keyof ChatMessage)[];

const TERMINAL_STATUSES = ["done", "error", "stopped"] as const;

export function shouldPersistPatch(patch: Partial<ChatMessage>): boolean {
  if (patch.status && (TERMINAL_STATUSES as readonly string[]).includes(patch.status)) {
    return true;
  }
  // Use `in`, not a truthiness check. Clearing a field (un-rating an answer) is
  // a change, and it must reach the server too.
  return DURABLE_FIELDS.some((field) => field in patch);
}
