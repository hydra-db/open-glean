/**
 * /api/chats/[id] — one conversation: GET full, PATCH mutations, DELETE.
 *
 * Every operation is scoped to the caller's subject, applied as part of the
 * database filter rather than as a check after reading. A filter cannot be
 * forgotten by a later caller and cannot leak the row before the check runs.
 *
 * `{ persisted: false }` (200) still means "Mongo is down, degrade to
 * localStorage". A missing subject answers 400 instead, because a write that
 * can never be read back must not be reported as saved.
 */
import { NextRequest, NextResponse } from "next/server";
import type { ChatMessage } from "@/lib/types";
import { deleteChat, getChat, updateChat } from "@/lib/mongo";
import { getSubject, NO_SUBJECT_MESSAGE } from "../requireSubject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const sub = await getSubject();
  // Indistinguishable from "no such chat" on purpose: whether a row exists
  // under another subject is not this caller's business.
  if (!sub) return NextResponse.json({ persisted: true, conversation: null });
  try {
    const conversation = await getChat(id, sub);
    return NextResponse.json({ persisted: true, conversation });
  } catch (err) {
    console.error("[api/chats GET id]", err);
    return NextResponse.json({ persisted: false, conversation: null });
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const sub = await getSubject();
  if (!sub) {
    return NextResponse.json({ error: NO_SUBJECT_MESSAGE }, { status: 400 });
  }
  try {
    const body = (await req.json()) as {
      title?: string;
      appendMessage?: ChatMessage;
      setMessage?: { id: string; patch: Partial<ChatMessage> };
      touch?: boolean;
    };
    const ok = await updateChat(id, sub, body);
    return NextResponse.json({ persisted: ok });
  } catch (err) {
    console.error("[api/chats PATCH]", err);
    return NextResponse.json({ persisted: false });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const sub = await getSubject();
  if (!sub) {
    return NextResponse.json({ error: NO_SUBJECT_MESSAGE }, { status: 400 });
  }
  try {
    // Was a hardcoded `true`, which reported a failed proxy delete as success.
    const persisted = await deleteChat(id, sub);
    return NextResponse.json({ persisted });
  } catch (err) {
    console.error("[api/chats DELETE]", err);
    return NextResponse.json({ persisted: false });
  }
}
