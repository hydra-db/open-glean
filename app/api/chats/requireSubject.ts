/**
 * Resolve the caller's subject, or refuse.
 *
 * One helper so no chat route can forget. The proxy (proxy.ts) mints the
 * subject on document navigations; routes never mint. A request arriving
 * without one is a pre-navigation race, a bot, or a client with cookies
 * disabled — and giving it a fresh identity here would hide the problem and
 * strand whatever it wrote.
 */
import { cookies } from "next/headers";
import { SUBJECT_COOKIE, readSubject } from "@/lib/subject";

export const NO_SUBJECT_MESSAGE =
  "No browser session. Enable cookies and reload the page.";

export async function getSubject(): Promise<string | null> {
  try {
    const store = await cookies();
    return readSubject(store.get(SUBJECT_COOKIE)?.value);
  } catch {
    return null;
  }
}
