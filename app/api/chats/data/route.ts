/**
 * /api/chats/data — export or erase everything this browser has stored.
 *
 *   GET    → every conversation, as JSON
 *   DELETE → remove them all
 *
 * Exists because of what the identity model is. The subject is an anonymous
 * per-browser id with no account behind it: clear the cookie and the rows are
 * orphaned forever, readable and deletable by nobody. So the only moment a
 * person can take their data out or erase it is while they still hold the
 * cookie, and there was no way to do either.
 *
 * That also makes this the app's answer to a self-hoster's data-subject
 * obligations, which matters more once the repo is public and someone runs it
 * in the EU.
 */
import { NextResponse } from "next/server";
import { deleteAllChats, exportChats } from "@/lib/mongo";
import { getSubject, NO_SUBJECT_MESSAGE } from "../requireSubject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sub = await getSubject();
  if (!sub) {
    return NextResponse.json({ error: NO_SUBJECT_MESSAGE }, { status: 400 });
  }
  try {
    const chats = await exportChats(sub);
    return NextResponse.json(
      { exportedAt: new Date().toISOString(), count: chats.length, chats },
      {
        headers: {
          "cache-control": "no-store",
          "content-disposition": 'attachment; filename="open-glean-chats.json"',
        },
      },
    );
  } catch (err) {
    console.error("[api/chats/data GET]", err);
    return NextResponse.json({ error: "Could not export your chats." }, { status: 503 });
  }
}

export async function DELETE() {
  const sub = await getSubject();
  if (!sub) {
    return NextResponse.json({ error: NO_SUBJECT_MESSAGE }, { status: 400 });
  }
  try {
    const deleted = await deleteAllChats(sub);
    return NextResponse.json({ deleted });
  } catch (err) {
    console.error("[api/chats/data DELETE]", err);
    return NextResponse.json({ error: "Could not delete your chats." }, { status: 503 });
  }
}
