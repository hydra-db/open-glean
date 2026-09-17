/**
 * Turn stored conversation messages into LLM prompt history.
 *
 * The chat page adds the user's question and an empty assistant placeholder to
 * the store before the answer runs. A naive read of the store therefore treats
 * the in-flight turn as history and sends the question twice.
 *
 * This function excludes two classes of message:
 *
 *   - The in-flight turn: the assistant placeholder that receives the stream,
 *     plus the user message that prompted it. Both are already in `opts.query`.
 *   - Failed turns: an errored or stopped assistant message holds placeholder
 *     text such as "_I couldn't answer that._". That text is not an answer, and
 *     it teaches the model the wrong thing on replay.
 */
import type { ChatMessage } from "@/lib/types";

export interface HistoryMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Statuses whose content is placeholder text, not a real answer. */
const FAILED_STATUSES = new Set(["error", "stopped"]);

/**
 * @param messages     the conversation, oldest first
 * @param inFlightId   id of the assistant message currently streaming
 * @param limit        how many messages to keep, most recent first
 */
export function usableHistory(
  messages: ChatMessage[],
  inFlightId: string,
  limit = 8,
): HistoryMessage[] {
  const liveIndex = messages.findIndex((m) => m.id === inFlightId);
  // Everything from the in-flight assistant message onward is the current
  // turn. The user message immediately before it is the question being asked,
  // which the caller passes separately.
  const cutoff = liveIndex >= 0 ? Math.max(0, liveIndex - 1) : messages.length;

  const usable = messages.slice(0, cutoff).filter((m) => {
    if (m.role === "assistant") {
      // An empty assistant message is a placeholder that never filled in.
      // It comes from an abandoned turn, or from an in-flight turn with an
      // unknown id.
      if (!m.content.trim()) return false;
      if (m.status && FAILED_STATUSES.has(m.status)) return false;
    }
    return Boolean(m.content.trim());
  });

  return usable
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }));
}
