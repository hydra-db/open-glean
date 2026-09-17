import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * This file was the untouched scaffold, so the app shipped none. That matters
 * more here than in a typical app: Open Glean renders LLM output containing text
 * from an indexed corpus other people write into, and it holds API keys in a
 * session cookie. Untrusted content rendered in a page with access to
 * credentials is the exact case CSP exists to contain.
 *
 * On the CSP itself:
 *
 *  - 'unsafe-inline' for styles is required. Tailwind and next/font inject
 *    inline style tags, and React sets inline styles on the graph canvas.
 *  - 'unsafe-inline' for scripts is required by Next's bootstrap and inline
 *    hydration payload. Removing it needs per-request nonces, which needs the
 *    proxy to rewrite every response. That is worth doing, but it does not
 *    block the open-source release.
 *  - 'unsafe-eval' is set in development only. React uses eval() in dev for
 *    debugging and never in production. The production bundle's only
 *    eval-family call is a Function("return this") globalThis polyfill that
 *    never runs in a browser, so production CSP never has to allow it. See the
 *    scriptSrc value below.
 *  - connect-src stays broad because the browser talks to whatever LLM
 *    endpoint the user configures. The server-side SSRF guard is what
 *    constrains that, not this header.
 *
 * frame-ancestors 'none' is the one that carries real weight today: the app
 * was clickjackable, and an iframed Open Glean with a live session is a way to
 * trick someone into deleting their own data.
 */
// React uses eval() in development for debugging (rebuilding call stacks). It
// never uses eval() in production. So allow 'unsafe-eval' in dev only, and keep
// production locked down. The only eval-family call in the production bundle is
// a Function("return this") globalThis polyfill that never runs in a browser.
const scriptSrc =
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";

const csp = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Emit a self-contained server for the Docker image: only the runtime files
  // and the dependencies the build actually uses.
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          // Redundant with frame-ancestors for modern browsers, kept for old ones.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          // Only meaningful over https; harmless on a local http deployment.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
