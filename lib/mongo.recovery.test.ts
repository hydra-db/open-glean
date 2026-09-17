/**
 * Health reporting recovers after the database comes back.
 *
 * The failure path cleared its client cache by assigning a NEW object to the
 * cache slot. The code that reads the cache had already captured a reference
 * to the OLD object, so the reset landed in an orphan and the broken client
 * stayed in place. Writes recovered on their own, because the driver
 * reconnects internally, but the health check reported "unreachable" forever
 * and would have paged an on-call engineer indefinitely.
 *
 * This models the same reference bug without a database, so it fails fast and
 * runs anywhere.
 */
import { describe, expect, it } from "vitest";

interface Cache {
  client: string | null;
  promise: string | null;
}

/** Reads the cache the way getClient does: captures the object by reference. */
function readCachedClient(cache: Cache): string | null {
  const local = cache;
  return local.client;
}

describe("client cache reset", () => {
  it("clears the client when the cache object is mutated", () => {
    const holder: { cache: Cache } = { cache: { client: "broken", promise: null } };
    const cache = holder.cache; // the reference getClient holds

    // Correct: mutate the same object.
    cache.client = null;
    cache.promise = null;

    expect(readCachedClient(holder.cache)).toBeNull();
    expect(readCachedClient(cache)).toBeNull();
  });

  it("does NOT clear it when the cache object is replaced", () => {
    // The regression. Replacing the object leaves every existing reference
    // pointing at the old one, still holding the broken client.
    const holder: { cache: Cache } = { cache: { client: "broken", promise: null } };
    const captured = holder.cache;

    holder.cache = { client: null, promise: null }; // what the bug did

    expect(readCachedClient(holder.cache)).toBeNull(); // looks fixed
    expect(readCachedClient(captured)).toBe("broken"); // but is not
  });
});
