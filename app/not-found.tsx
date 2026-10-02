/**
 * 404 page.
 *
 * Chats are scoped to a browser subject, so another browser's conversation id
 * is simply not found. That makes a missing page an ordinary case, not a rare
 * one. Without this file Next serves its own unstyled default.
 */
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-pixel text-[22px] font-normal text-text-3">Page not found</h1>
      <p className="max-w-sm text-sm text-text-2">
        This page does not exist. If you were looking for a conversation, it may
        have been deleted. Chats are saved in one browser, not to an account, so
        a chat from another browser will not show up here.
      </p>
      <Link href="/ask" className="btn-primary">
        Go to Ask
      </Link>
    </main>
  );
}
