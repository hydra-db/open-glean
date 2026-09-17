"use client";

/**
 * Tells the user when their chats have stopped saving.
 *
 * Before this, `persisted` was computed by the store, exposed on the context,
 * and read by nothing. A database outage was completely invisible: the API
 * answered 200, the client discarded the result, and the conversation was gone
 * on the next reload with no warning at any point.
 *
 * Deliberately not a toast. A toast disappears after a few seconds; this is a
 * condition that persists until the deployment is fixed, so it stays on screen
 * while it is true.
 */
import { useChatStore } from "@/lib/store/chat";

export function SaveStatusBanner() {
  const { saveFailed, hydrated } = useChatStore();

  // Nothing to say before the first load settles.
  if (!hydrated || !saveFailed) return null;

  return (
    <div
      // Announced to a screen reader, because the whole point is that the user
      // would not otherwise know. `polite` rather than `assertive`: it is
      // important but not worth interrupting a read in progress.
      role="status"
      aria-live="polite"
      className="border-b border-solid border-warning-1/30 bg-warn-fill px-4 py-2 text-xs text-text-1"
    >
      <p className="min-w-0">
        <span className="font-medium">Chats are not saving.</span>{" "}
        This conversation is kept in this browser only, and will be lost if you
        clear your browser data. The server could not be reached.
      </p>
    </div>
  );
}
