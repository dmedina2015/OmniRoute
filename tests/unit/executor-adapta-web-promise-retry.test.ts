import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/adapta-web.ts");

const TOOLS = [
  {
    type: "function",
    function: { name: "write", parameters: { type: "object", properties: {} } },
  },
];

function sseOf(text: string) {
  return (
    `data: ${JSON.stringify({ type: "text-delta", id: "1", delta: text })}\n\n` +
    `data: ${JSON.stringify({ type: "done" })}\n\n`
  );
}

/** Stubs Clerk auth + the chat stream, capturing every upstream chat body. */
function stubAdapta(chatReplies: string[], bodies: Array<Record<string, unknown>>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/client")) {
      return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
    }
    if (url.includes("/tokens")) {
      return Response.json({ jwt: "eyJ.promise-retry-test.jwt" });
    }
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const text = chatReplies[Math.min(bodies.length - 1, chatReplies.length - 1)];
    return new Response(sseOf(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
}

// #adapta-tool-promise: a tool-aware reply that only ANNOUNCES the action used to be
// returned as the final answer — the client saw finish_reason "stop" with no
// tool_calls and the agentic loop ended having edited nothing. The retry now carries a
// corrective nudge, and this test proves both halves: the correction reaches the
// upstream AND the second reply's <tool> block becomes real tool_calls.
describe("AdaptaWebExecutor — promise-only replies", () => {
  it("retries a promise with a corrective nudge and returns the tool call it produced", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = stubAdapta(
      [
        "I'll start by inspecting the three files.",
        '<tool>{"name":"write","arguments":{"path":"a.txt","content":"x"}}</tool>',
      ],
      bodies
    );

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-kimi-k2-7-code",
        stream: false,
        body: {
          messages: [{ role: "user", content: "Edite os três arquivos" }],
          tools: TOOLS,
        },
        credentials: { apiKey: "__client=unique-promise-retry-cookie" },
        signal: null,
      });

      assert.equal(bodies.length, 2, "one initial call plus exactly one corrective retry");

      const retryMessages = (bodies[1].messages ?? []) as Array<{
        parts?: Array<{ text?: string }>;
      }>;
      const retryText = retryMessages
        .flatMap((m) => (m.parts ?? []).map((p) => p.text ?? ""))
        .join("\n");
      assert.match(retryText, /STOP/, "the retry must carry the corrective nudge");
      assert.match(retryText, /```bash/);

      assert.equal(result.response.status, 200);
      const json = await result.response.json();
      assert.equal(json.choices[0].finish_reason, "tool_calls");
      assert.equal(json.choices[0].message.tool_calls[0].function.name, "write");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry an ordinary final answer", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = stubAdapta(["O arquivo tem 412 linhas e 3 exports."], bodies);

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-kimi-k2-7-code",
        stream: false,
        body: {
          messages: [{ role: "user", content: "Quantas linhas tem o arquivo?" }],
          tools: TOOLS,
        },
        credentials: { apiKey: "__client=unique-final-answer-cookie" },
        signal: null,
      });

      assert.equal(bodies.length, 1, "a real answer must never burn a retry");
      const json = await result.response.json();
      assert.equal(json.choices[0].finish_reason, "stop");
      assert.match(json.choices[0].message.content, /412 linhas/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // #adapta-empty-retry: Adapta intermittently answers the repeated turn with no text.
  // Assigning that unconditionally replaced "the model planned" with content: "" — the
  // "completed without text" symptom clients reported.
  it("keeps the previous reply when the retry comes back empty", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = stubAdapta(["I don't have access to the terminal here.", ""], bodies);

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-kimi-k2-7-code",
        stream: false,
        body: {
          messages: [{ role: "user", content: "Escreva o arquivo" }],
          tools: TOOLS,
        },
        credentials: { apiKey: "__client=unique-empty-retry-cookie" },
        signal: null,
      });

      assert.equal(bodies.length, 2);
      const json = await result.response.json();
      assert.notEqual(json.choices[0].message.content, "", "empty retry must not erase text");
      assert.match(json.choices[0].message.content, /don't have access/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
