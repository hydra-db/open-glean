"use client";

/**
 * Last-resort error boundary.
 *
 * `app/error.tsx` catches errors below the layout that renders it. It cannot
 * catch an error thrown by the root layout itself or its providers. Without a
 * global boundary, such an error is a blank page on every route with no way
 * back. This gives the user a reset instead.
 *
 * It renders its own <html> and <body>, because at this level the root layout
 * did not run.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const clearAndReload = () => {
    try {
      localStorage.clear();
    } catch {
      // Ignore: private mode or storage disabled.
    }
    location.href = "/ask";
  };

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          background: "#101010",
          color: "#ececec",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "1.1rem", fontWeight: 600 }}>Open Glean could not start</h1>
        <p style={{ fontSize: "0.9rem", color: "#b4b4b4", maxWidth: "28rem" }}>
          Something in this browser&apos;s saved settings is unreadable. Resetting
          local data fixes it. Your chats on the server are not affected.
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={reset}
            style={btnStyle("#26262a", "#ececec")}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={clearAndReload}
            style={btnStyle("#ececec", "#0a0a0b")}
          >
            Reset local data
          </button>
        </div>
      </body>
    </html>
  );
}

function btnStyle(bg: string, fg: string): React.CSSProperties {
  return {
    background: bg,
    color: fg,
    border: "none",
    borderRadius: "0.5rem",
    padding: "0.5rem 1rem",
    fontSize: "0.85rem",
    fontWeight: 500,
    cursor: "pointer",
  };
}
