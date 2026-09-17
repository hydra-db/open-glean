/**
 * GET /api/health — liveness and dependency status.
 *
 * The app had nothing for a load balancer, an uptime monitor or a deploy check
 * to probe. `pingOk` existed in lib/mongo.ts and no route called it, so a total
 * database outage produced no log, no metric and no alert: the API kept
 * answering 200 while persisting nothing.
 *
 * Deliberately unauthenticated and deliberately thin. It reports whether this
 * instance is up and whether chat persistence is reachable, and nothing about
 * configuration — an unauthenticated endpoint must not become a way to
 * enumerate which keys a deployment has set.
 *
 * When no database is configured, the app runs on the browser localStorage
 * fallback. That is a valid deployment, so the probe reports 200 and a
 * "disabled" persistence state instead of failing.
 *
 * When a database is configured, the probe returns 200 if it is reachable and
 * 503 if it is not, so a monitor can page on it without parsing the body.
 */
import { NextResponse } from "next/server";
import { pingOk, persistenceConfigured } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();

  // No database configured: the localStorage fallback is in use, so there is
  // nothing to probe and the instance is healthy.
  if (!persistenceConfigured) {
    return NextResponse.json(
      { ok: true, up: true, persistence: "disabled", checkedInMs: 0 },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  let persistence = false;
  try {
    persistence = await pingOk();
  } catch {
    persistence = false;
  }

  return NextResponse.json(
    {
      ok: persistence,
      // `up` distinguishes "this instance is serving" from "its dependencies
      // are healthy". A liveness probe should not restart a pod because the
      // database is down.
      up: true,
      persistence: persistence ? "ok" : "unreachable",
      checkedInMs: Date.now() - startedAt,
    },
    {
      status: persistence ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
