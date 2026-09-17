/**
 * /api/chats — MongoDB-backed conversation persistence.
 *
 *   GET    /api/chats           → list (metadata only)
 *   POST   /api/chats           → create { conversation }
 *   GET    /api/chats/[id]      → full conversation
 *   PATCH  /api/chats/[id]      → { title? | appendMessage? | setMessage? }
 *   DELETE /api/chats/[id]      → remove
 *
 * Every route is scoped to the caller's subject (see lib/subject.ts). Before
 * that, these routes were global: an unauthenticated GET returned every user's
 * chat list, and any visitor could read or delete any conversation by id.
 *
 * When Mongo is unreachable every route answers { persisted: false } with 200 —
 * the client store treats that as local-only mode and falls back to
 * localStorage instead of erroring. A MISSING SUBJECT is different, and answers
 * 400: it means the write could never be read back, so reporting success would
 * be the silent data loss this whole phase exists to prevent.
 */
import { NextRequest, NextResponse } from "next/server";
import type { Conversation } from "@/lib/types";
import { createChat, listChats, reapAbandoned } from "@/lib/mongo";
import { getSubject, NO_SUBJECT_MESSAGE } from "./requireSubject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sub = await getSubject();
  // No subject means no history to show. Not an error: a first-time visitor
  // whose proxy mint has not landed yet simply has nothing.
  if (!sub) return NextResponse.json({ persisted: true, chats: [] });
  try {
    // Clear conversations that were started and never answered before listing,
    // so the history page does not fill with "No answer yet". Failures
    // are swallowed inside reapAbandoned: stale rows must not break the list.
    await reapAbandoned(sub);
    const chats = await listChats(sub);
    return NextResponse.json({ persisted: true, chats });
  } catch (err) {
    console.error("[api/chats GET]", err);
    return NextResponse.json({ persisted: false, chats: [] });
  }
}

export async function POST(req: NextRequest) {
  const sub = await getSubject();
  if (!sub) {
    return NextResponse.json({ error: NO_SUBJECT_MESSAGE }, { status: 400 });
  }
  try {
    const body = (await req.json()) as { conversation?: Conversation };
    if (!body.conversation?.id) {
      return NextResponse.json({ error: "Missing conversation" }, { status: 400 });
    }
    // Report what actually happened. This used to be a hardcoded `true`
    // whenever createChat did not throw, which masked a proxy rejection as a
    // successful create.
    const persisted = await createChat(body.conversation, sub);
    return NextResponse.json({ persisted });
  } catch (err) {
    console.error("[api/chats POST]", err);
    return NextResponse.json({ persisted: false });
  }
}
