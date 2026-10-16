/**
 * Proxy-mode error propagation in lib/mongo.ts.
 *
 * `proxyFetch` catches every network/timeout error and turns any non-2xx HTTP
 * response into `{ persisted: false }`. `createChat` and `deleteChat` were
 * updated to check `res.persisted === true`, because callers inspect their
 * boolean return value.
 *
 * `listChats`, `getChat`, `exportChats` and `deleteAllChats` instead return
 * data (arrays, a conversation, or a count), and their route handlers rely on
 * a thrown error to enter `catch` and answer `{ persisted: false }` or `503`.
 * Discarding `res.persisted` in those four functions meant a dead or
 * misconfigured Lambda proxy was reported as:
 *   - `GET /api/chats`      → `{ persisted: true, chats: [] }` (client never
 *                              degrades to localStorage)
 *   - `GET /api/chats/[id]` → `{ persisted: true, conversation: null }`
 *   - `GET /api/chats/data` → `200 OK` with an empty `open-glean-chats.json`
 *   - `DELETE /api/chats/data` → `200 OK` with `{ deleted: 0 }`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROXY_URL = "https://proxy.example.com/prod";
const PROXY_KEY = "test-proxy-secret";

describe("mongo proxy-mode failure propagation", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.MONGODB_URI = PROXY_URL;
    process.env.MONGODB_PROXY_KEY = PROXY_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_PROXY_KEY;
  });

  it("throws from listChats, getChat, exportChats, and deleteAllChats when the proxy returns 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Proxy error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { listChats, getChat, exportChats, deleteAllChats } = await import(
      "./mongo"
    );

    await expect(listChats("sub-1")).rejects.toThrow(/listChats/);
    await expect(getChat("chat-1", "sub-1")).rejects.toThrow(/getChat/);
    await expect(exportChats("sub-1")).rejects.toThrow(/exportChats/);
    await expect(deleteAllChats("sub-1")).rejects.toThrow(/deleteAllChats/);
  });

  it("throws when the proxy request rejects (network / timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ETIMEDOUT")),
    );

    const { listChats, getChat, exportChats, deleteAllChats } = await import(
      "./mongo"
    );

    await expect(listChats("sub-1")).rejects.toThrow(/listChats/);
    await expect(getChat("chat-1", "sub-1")).rejects.toThrow(/getChat/);
    await expect(exportChats("sub-1")).rejects.toThrow(/exportChats/);
    await expect(deleteAllChats("sub-1")).rejects.toThrow(/deleteAllChats/);
  });

  it("resolves normally when the proxy answers with persisted: true", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("full=1")) {
        return new Response(
          JSON.stringify({
            persisted: true,
            chats: [{ id: "c1", title: "Hello", createdAt: 1, updatedAt: 2, messages: [] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/chats/c1")) {
        return new Response(
          JSON.stringify({
            persisted: true,
            conversation: { id: "c1", title: "Hello", createdAt: 1, updatedAt: 2, messages: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/chats/missing")) {
        return new Response(
          JSON.stringify({ persisted: true, conversation: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          persisted: true,
          chats: [{ id: "c1", title: "Hello", createdAt: 1, updatedAt: 2, messageCount: 0 }],
          deleted: 3,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listChats, getChat, exportChats, deleteAllChats } = await import(
      "./mongo"
    );

    await expect(listChats("sub-1")).resolves.toHaveLength(1);
    await expect(getChat("c1", "sub-1")).resolves.toMatchObject({ id: "c1" });
    // A missing chat with persisted: true must still return null rather than throwing.
    await expect(getChat("missing", "sub-1")).resolves.toBeNull();
    await expect(exportChats("sub-1")).resolves.toHaveLength(1);
    await expect(deleteAllChats("sub-1")).resolves.toBe(3);
  });
});
