/**
 * In-flight concurrency cap for expensive routes.
 *
 * Deep Research costs up to 18 LLM calls plus 8 graph-enabled Hydra queries per
 * request. The deployment's keys pay for all of them, and the route needs no
 * credentials from the caller. Without a cap, a loop of POSTs drains the
 * account.
 *
 * This is a per-instance in-memory counter, not a rate limiter. On a
 * serverless platform each instance has its own, and the platform adds
 * instances under load — so this bounds the damage per instance and does not
 * bound it globally. That is a real limit and it is stated here rather than
 * implied away.
 *
 * The cap is still worth having. It needs no new infrastructure, it stops a
 * single client from parallelising a drain through one warm instance, and it
 * fails closed. A global limit needs a shared store (Redis, Upstash, Vercel KV)
 * plus a secret to configure it. To move to one, replace the body of `acquire`.
 * Every caller stays unchanged.
 */

/** Default ceiling. Deep Research is slow, so a small number is plenty. */
const DEFAULT_MAX_CONCURRENT = 3;

export class CapacityError extends Error {
  constructor(message = "The server is busy running other research. Try again shortly.") {
    super(message);
    this.name = "CapacityError";
  }
}

export interface SpendGuard {
  /** @throws CapacityError when the cap is already reached. */
  acquire(): () => void;
  inFlight(): number;
}

export function createSpendGuard(max = DEFAULT_MAX_CONCURRENT): SpendGuard {
  let current = 0;
  return {
    acquire() {
      if (current >= max) throw new CapacityError();
      current++;
      let released = false;
      // The release is idempotent. Callers release in a `finally` that can run
      // twice on some abort paths, and a double release inflates capacity.
      return () => {
        if (released) return;
        released = true;
        current--;
      };
    },
    inFlight() {
      return current;
    },
  };
}

/** Shared guard for the research route. */
export const researchGuard = createSpendGuard(
  Number(process.env.OPEN_GLEAN_MAX_CONCURRENT_RESEARCH) || DEFAULT_MAX_CONCURRENT,
);
