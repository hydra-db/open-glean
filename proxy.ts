/**
 * Mints the anonymous per-browser subject.
 *
 * Next 16 renamed `middleware.ts` to `proxy.ts` and changed the default runtime
 * to Node.js. This file can therefore use `node:crypto` and share one signing
 * implementation with the route handlers.
 *
 * Minting happens here, not in a route handler. `setSession` is a
 * read-modify-write of the whole credential cookie with no compare-and-swap,
 * and the chat store fans out up to 200 concurrent requests on a cold start.
 * Per-request minting would race, produce N subjects, and could clobber a
 * concurrently written Hydra key. One mint per document navigation avoids that.
 *
 * The subject gets its own cookie. It is NOT part of the credential session,
 * because disconnecting a key must not destroy the identity that owns the chats.
 */
import { NextResponse, type NextRequest } from "next/server";
import { SUBJECT_COOKIE, mintSubject, readSubject } from "@/lib/subject";

export function proxy(request: NextRequest) {
  const existing = request.cookies.get(SUBJECT_COOKIE)?.value;
  if (readSubject(existing)) return NextResponse.next();

  const minted = mintSubject();

  // Put the cookie on the request as well as the response. Otherwise the
  // browser gains it only on the next navigation, and the API calls from this
  // page load arrive with no subject and get refused.
  const headers = new Headers(request.headers);
  const forwarded = [request.headers.get("cookie"), `${SUBJECT_COOKIE}=${minted}`]
    .filter(Boolean)
    .join("; ");
  headers.set("cookie", forwarded);

  const response = NextResponse.next({ request: { headers } });
  response.cookies.set(SUBJECT_COOKIE, minted, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // This must outlive the credential cookie's 90 days. A subject that expires
    // before its credentials orphans the chats it owns. The reverse is
    // harmless, because only the connect gate reappears.
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}

export const config = {
  // Document navigations only. API routes must never mint. A request with no
  // subject is a race, a bot, or a cookieless client, and a fresh identity
  // would hide that.
  //
  // This pattern excludes /api, Next internals and static assets.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|static/).*)"],
};
