"use client";

/**
 * Route-level error boundary.
 *
 * The app had none, so any render-time throw in a client component produced a
 * blank white page with no way back. A malformed `research` blob read from the
 * database was enough to do it.
 */
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server logs are the only place this is visible today. Wire up structured
    // logging and error tracking here when a provider is added.
    console.error("[app error boundary]", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-medium text-text-1">Something broke</h1>
      <p className="max-w-sm text-sm text-text-2">
        This page hit an unexpected error. Your chats are unaffected.
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={reset} className="btn-primary">
          Try again
        </button>
        <a href="/ask" className="btn-soft">
          Go to Ask
        </a>
      </div>
    </main>
  );
}
