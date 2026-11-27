import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/adapta-web.ts");

const TOOLS = [
  {
    type: "function",
    function: { name: "write", parameters: { type: "object", properties: {} } },
  },
];

function stubUpstream(reply: string) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/client")) {
      return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
    }
    if (url.includes("/tokens")) {
      return Response.json({ jwt: "eyJ.streaming-tools-test.jwt" });
    }
    return new Response(
      `data: ${JSON.stringify({ type: "text-delta", id: "1", delta: reply })}\n\n` +
        `data: ${JSON.stringify({ type: "done" })}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;
}

// Adapta has no native tool calling: the tool call arrives as text. A streaming
// request used to forward that text verbatim, so the client rendered the envelope as
// prose with finish_reason "stop" and never executed anything.
describe("AdaptaWebExecutor — streaming with tools", () => {
  it("parses a <tool> envelope into tool_calls and replays it as SSE", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubUpstream(
      '<tool>{"name":"write","arguments":{"path":"a.txt","content":"x"}}</tool>'
    );

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-kimi-k2-7-code",
        stream: true,
        body: {
          messages: [{ role: "user", content: "write a.txt" }],
          tools: TOOLS,
        },
        credentials: { apiKey: "__client=unique-streaming-tools-cookie" },
        signal: null,
      });

      assert.equal(result.response.status, 200);
      assert.match(result.response.headers.get("content-type") ?? "", /text\/event-stream/);
      const sse = await result.response.text();
      assert.doesNotMatch(sse, /"content":"<tool>/, "the raw envelope must not leak as text");
      assert.match(sse, /"finish_reason":"tool_calls"/);
      assert.match(sse, /"name":"write"/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps real token streaming for tools-free requests", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stubUpstream("oi");

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-one",
        stream: true,
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "__client=unique-streaming-plain-cookie" },
        signal: null,
      });

      assert.match(result.response.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.match(await result.response.text(), /"content":"oi"/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
