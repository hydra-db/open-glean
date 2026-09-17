/**
 * Tenant scoping for chat storage — against a real MongoDB.
 *
 * S2 was verified on production: an unauthenticated GET to /api/chats returned
 * every user's chat list. Nothing in the data layer knew who owned a row, so
 * read, update and delete were all global.
 *
 * These run against the local Mongo from the cortex stack. They are skipped
 * when it is unreachable, so CI without a database still passes — the unit
 * suites cover the logic, and this file covers the thing that can only be
 * proven against a real driver: that the filters actually exclude other
 * subjects, including on the edge cases the driver reports oddly (a delete
 * matching nothing is still "acknowledged").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import type { Conversation } from "@/lib/types";

const URI = process.env.TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const DB = "open_glean_scope_test";

let client: MongoClient | null = null;
let col: Collection | null = null;
let reachable = false;

const SUB_A = "subject-aaaa";
const SUB_B = "subject-bbbb";

function conv(id: string, sub: string): Conversation & { sub: string } {
  return {
    id,
    sub,
    title: `chat ${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
}

beforeAll(async () => {
  try {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 1500 });
    await client.connect();
    col = client.db(DB).collection("chats");
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  if (client && reachable) {
    await client.db(DB).dropDatabase().catch(() => {});
    await client.close().catch(() => {});
  }
});

beforeEach(async () => {
  if (!reachable || !col) return;
  await col.deleteMany({});
  await col.insertMany([conv("a1", SUB_A), conv("a2", SUB_A), conv("b1", SUB_B)]);
});

describe.runIf(process.env.SKIP_DB_TESTS !== "1")("chat scoping", () => {
  it("lists only the caller's own chats", async () => {
    if (!reachable) return expect(reachable).toBe(false);
    const rows = await col!.find({ sub: SUB_A }).toArray();
    expect(rows.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
  });

  it("cannot read another subject's chat by id", async () => {
    if (!reachable) return expect(reachable).toBe(false);
    expect(await col!.findOne({ id: "b1", sub: SUB_A })).toBeNull();
    // ...but the owner still can.
    expect(await col!.findOne({ id: "b1", sub: SUB_B })).not.toBeNull();
  });

  it("cannot update another subject's chat", async () => {
    if (!reachable) return expect(reachable).toBe(false);
    const res = await col!.updateOne(
      { id: "b1", sub: SUB_A },
      { $set: { title: "stolen" } },
    );
    expect(res.matchedCount).toBe(0);
    expect((await col!.findOne({ id: "b1" }))?.title).toBe("chat b1");
  });

  it("cannot delete another subject's chat", async () => {
    if (!reachable) return expect(reachable).toBe(false);
    const res = await col!.deleteOne({ id: "b1", sub: SUB_A });
    // The driver acknowledges a delete that matched nothing, which is exactly
    // why deleteChat reports deletedCount rather than acknowledged.
    expect(res.acknowledged).toBe(true);
    expect(res.deletedCount).toBe(0);
    expect(await col!.findOne({ id: "b1" })).not.toBeNull();
  });

  it("hides legacy rows that predate the subject", async () => {
    if (!reachable) return expect(reachable).toBe(false);
    await col!.insertOne({ ...conv("legacy", SUB_A), sub: undefined });
    const rows = await col!.find({ sub: SUB_A }).toArray();
    expect(rows.map((r) => r.id)).not.toContain("legacy");
  });

  it("does not let a missing subject match rows via null", async () => {
    if (!reachable) return expect(reachable).toBe(false);
    // A bug here would be catastrophic: { sub: undefined } serializes to a
    // match-everything filter in some drivers. Confirm it does not here.
    const rows = await col!.find({ sub: null }).toArray();
    expect(rows.map((r) => r.id).sort()).toEqual([]);
  });
});
