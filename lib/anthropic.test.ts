import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  LlmRefusalError,
  anthropicComplete,
  anthropicErrorMessage,
  openAnthropicStream,
} from "@/lib/anthropic";

const creds = {
  apiKey: "sk-ant-test",
  baseUrl: "https://api.anthropic.com/v1",
  model: "claude-opus-5-5",
};

type Event = Record<string, unknown> & { type: string };

function sse(events: Event[]): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function message(blocks: Event[], stopReason: string): Event[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: creds.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    ...blocks,
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
}

function textBlock(index: number, ...chunks: string[]): Event[] {
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ...chunks.map((text) => ({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    })),
    { type: "content_block_stop", index },
  ];
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn(async () => responses.shift() ?? new Response("", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>, call = 0) {
  const init = (fetchMock.mock.calls[call] as unknown[])[1] as RequestInit;
  return JSON.parse(init.body as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openAnthropicStream", () => {
  it("streams text deltas and sends the Messages API request shape", async () => {
    const fetchMock = stubFetch(sse(message(textBlock(0, "Hel", "lo"), "end_turn")));
    const handle = await openAnthropicStream(creds, [
      { role: "system", content: "Answer from context." },
      { role: "user", content: "Hi" },
    ]);
    const deltas: string[] = [];
    await handle.pump((t) => deltas.push(t));

    expect(deltas.join("")).toBe("Hello");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init.headers).get("x-api-key")).toBe("sk-ant-test");
    const body = sentBody(fetchMock);
    expect(body.system).toBe("Answer from context.");
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("collects web search results as citations", async () => {
    const results = {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            url: "https://example.com/a",
            title: "A",
            encrypted_content: "x",
            page_age: null,
          },
        ],
      },
    };
    const fetchMock = stubFetch(
      sse(
        message(
          [results, { type: "content_block_stop", index: 0 }, ...textBlock(1, "Answer")],
          "end_turn",
        ),
      ),
    );
    const handle = await openAnthropicStream(creds, [{ role: "user", content: "Q" }], {
      webSearch: true,
    });
    const { citations } = await handle.pump(() => {});

    expect(citations).toEqual([{ url: "https://example.com/a", title: "A" }]);
    expect(sentBody(fetchMock).tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 5 },
    ]);
  });

  it("resumes a paused turn by sending the partial turn back", async () => {
    const fetchMock = stubFetch(
      sse(message(textBlock(0, "Part one. "), "pause_turn")),
      sse(message(textBlock(0, "Part two."), "end_turn")),
    );
    const handle = await openAnthropicStream(creds, [{ role: "user", content: "Q" }]);
    const deltas: string[] = [];
    await handle.pump((t) => deltas.push(t));

    expect(deltas.join("")).toBe("Part one. Part two.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 1).messages).toEqual([
      { role: "user", content: "Q" },
      { role: "assistant", content: [{ type: "text", text: "Part one. " }] },
    ]);
  });

  it("raises a refusal as LlmRefusalError", async () => {
    stubFetch(sse(message([], "refusal")));
    const handle = await openAnthropicStream(creds, [{ role: "user", content: "Q" }]);
    await expect(handle.pump(() => {})).rejects.toBeInstanceOf(LlmRefusalError);
  });

  it("rejects before streaming when the provider rejects the request", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "not_found_error", message: "model: claude-nope" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
    const err = await openAnthropicStream({ ...creds, model: "claude-nope" }, [
      { role: "user", content: "Q" },
    ]).catch((e: unknown) => e);
    expect(anthropicErrorMessage(err)).toEqual({ status: 404, message: "model: claude-nope" });
  });
});

describe("anthropicComplete", () => {
  it("returns the joined text of a non-streaming response", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: creds.model,
          content: [
            { type: "thinking", thinking: "", signature: "s" },
            { type: "text", text: "Plan: " },
            { type: "text", text: "done" },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(anthropicComplete(creds, [{ role: "user", content: "Q" }])).resolves.toBe(
      "Plan: done",
    );
  });

  it("refuses to follow a redirect", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 307, headers: { location: "http://10.0.0.1/" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(anthropicComplete(creds, [{ role: "user", content: "Q" }])).rejects.toThrow();
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(String(call[0])).toBe("https://api.anthropic.com/v1/messages");
      expect(call[1].redirect).toBe("manual");
    }
  });
});
