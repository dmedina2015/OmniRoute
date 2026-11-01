import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/adapta-web.ts");

describe("AdaptaWebExecutor", () => {
  it("can be instantiated", () => {
    const executor = new mod.AdaptaWebExecutor();
    assert.ok(executor);
  });

  it("returns 401 when credentials are missing", async () => {
    const executor = new mod.AdaptaWebExecutor();
    const result = await executor.execute({
      model: "adapta-one",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
      signal: null,
    });
    assert.equal(result.response.status, 401);
    const json = await result.response.json();
    assert.ok(json.error.message.includes("Missing Adapta credentials"));
  });

  it("returns 401 when apiKey is empty", async () => {
    const executor = new mod.AdaptaWebExecutor();
    const result = await executor.execute({
      model: "adapta-one",
      body: { messages: [{ role: "user", content: "test" }] },
      stream: false,
      credentials: { apiKey: "" },
      signal: null,
    });
    assert.equal(result.response.status, 401);
  });

  it("execute returns proper result shape on auth failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-one",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "invalid-jwt" },
        signal: null,
      });
      assert.ok(result.response instanceof Response);
      assert.ok(typeof result.url === "string");
      assert.ok(typeof result.headers === "object");
      assert.ok(result.transformedBody !== undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("testConnection returns false for invalid credentials", async () => {
    const executor = new mod.AdaptaWebExecutor();
    const connected = await executor.testConnection({ apiKey: "" });
    assert.equal(connected, false);
  });

  it("buildAdaptaMessages produces Adapta-shaped messages with ids", () => {
    const msgs = mod.buildAdaptaMessages(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      "CLAUDE_5_5_SONNET",
      "chat-1"
    );
    assert.equal(msgs.length, 2);
    assert.ok(typeof msgs[0].id === "string" && msgs[0].id.length > 0);
    assert.equal(msgs[0].role, "user");
    assert.deepEqual(msgs[0].parts, [{ type: "text", text: "sys\n\nhi" }]);
    assert.equal(msgs[1].role, "assistant");
    assert.equal(msgs[1].parts[0].text, "hello");
    assert.equal(msgs[1].state, "done");
    assert.equal(msgs[1].metadata?.model, "CLAUDE_5_5_SONNET");
  });

  // #tool-exchange-dropped: Adapta's wire format has no "tool" role and
  // buildAdaptaMessages used to `continue` past role:"tool" messages entirely,
  // silently dropping the function result. The prior assistant tool_calls
  // message also collapsed to empty text. Net effect: the model never saw its
  // own tool call or the result, so a follow-up turn re-derived the same
  // "no history" prompt and re-emitted the identical tool call forever.
  it("buildAdaptaMessages folds assistant tool_calls and tool results into the history", () => {
    const msgs = mod.buildAdaptaMessages(
      [
        { role: "user", content: "Qual a temperatura em Lisboa?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Lisboa"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temperature_c":18}' },
      ],
      "KIMI_K2_7_CODE",
      "chat-1"
    );

    assert.equal(msgs.length, 3);

    assert.equal(msgs[1].role, "assistant");
    assert.ok(msgs[1].parts[0].text.includes("get_weather"));
    assert.ok(msgs[1].parts[0].text.includes('"city":"Lisboa"'));

    // The tool result must reach the model as a conversation turn — not be dropped.
    assert.equal(msgs[2].role, "user");
    assert.ok(msgs[2].parts[0].text.includes("get_weather"));
    assert.ok(msgs[2].parts[0].text.includes('"temperature_c":18'));
  });

  // #tool-contract-buried: prepareToolMessages() (translator/webTools.ts) deliberately
  // appends the full <tool> contract as the LAST message (after the whole conversation) —
  // its own docstring documents that prepending it loses to big system prompts (observed
  // 0/3 tool calls vs 16/17 for trailing placement). buildAdaptaMessages used to fold EVERY
  // system message (the client's original huge system prompt AND the trailing tool
  // contract) into one blob glued onto the FIRST user message, silently undoing that fix
  // for every agentic client (e.g. OpenCode) whose system prompt is large.
  it("buildAdaptaMessages keeps a trailing tool contract at the tail, not glued to turn 1", () => {
    const hugeSystemPrompt = "You are a coding agent.\n".repeat(2000); // simulate OpenCode's big system prompt
    const toolContract =
      'To invoke one, reply with a <tool> block:\n<tool>{"name": "<tool_name>", "arguments": { ... }}</tool>\n\nAvailable tools:\n- bash: run a shell command\n- write: write a file';

    const msgs = mod.buildAdaptaMessages(
      [
        { role: "system", content: hugeSystemPrompt },
        { role: "user", content: "Liste os arquivos do diretório atual." },
        // prepareToolMessages() appends this AFTER the whole conversation.
        { role: "system", content: toolContract },
      ],
      "KIMI_K2_7_CODE",
      "chat-1"
    );

    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "user");
    assert.ok(msgs[0].parts[0].text.startsWith("You are a coding agent."));
    assert.ok(
      !msgs[0].parts[0].text.includes("Available tools:"),
      "the trailing tool contract must not be buried inside turn 1's huge leading system block"
    );

    // The tool contract must survive at the tail — the last thing the model reads.
    const last = msgs[msgs.length - 1];
    assert.ok(last.parts[0].text.includes("Available tools:"));
    assert.ok(last.parts[0].text.includes("bash: run a shell command"));
  });

  // #tool-leak-raw-text: when the request streams AND carries tools[], execute() used to
  // forward Adapta's raw text-delta events straight through as plain `content` chunks via
  // transformStream() — it never ran buildToolAwareResult() on them. The upstream's literal
  // `<tool>{"name":...,"arguments":{...}}</tool>` envelope reached the client as visible
  // assistant prose instead of becoming `tool_calls`, so agentic clients (OpenCode's default
  // request is streaming) saw a fake "I called the tool" narration that never actually
  // executed anything, instead of a real tool_calls turn they could act on.
  it("parses <tool> blocks into tool_calls even when streaming is requested", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
      }
      if (url.includes("/tokens")) {
        return Response.json({ jwt: "eyJ.tool-leak-test.jwt" });
      }
      const sse =
        `data: ${JSON.stringify({ type: "text-delta", id: "1", delta: '<tool>{"name":"write","arguments":{"path":"daniel.txt","content":"oi"}}</tool>' })}\n\n` +
        `data: ${JSON.stringify({ type: "done" })}\n\n`;
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-kimi-k2-7-code",
        stream: true,
        body: {
          messages: [{ role: "user", content: "Crie o arquivo daniel.txt" }],
          tools: [
            {
              type: "function",
              function: { name: "write", parameters: { type: "object", properties: {} } },
            },
          ],
        },
        credentials: { apiKey: "__client=unique-tool-leak-cookie" },
        signal: null,
      });

      assert.equal(result.response.status, 200);
      const sseText = await result.response.text();
      // The raw <tool> envelope must never reach the client as visible text.
      assert.doesNotMatch(sseText, /"content":"<tool>/);
      assert.match(sseText, /"finish_reason":"tool_calls"/);
      assert.match(sseText, /"name":"write"/);
      assert.match(sseText, /\\"path\\":\\"daniel\.txt\\"/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // #tool-leak-corrupted-close: reproduces the Kimi K2.7 Code / Adapta report where the
  // model's own native closing tokens leaked through instead of a clean </tool>, end-to-end
  // through the real streaming executor path (not just the parser unit above).
  it("salvages a <tool>{json} call whose close was replaced by corrupted native tokens, over streaming", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
      }
      if (url.includes("/tokens")) {
        return Response.json({ jwt: "eyJ.corrupted-close-test.jwt" });
      }
      const delta =
        'Vou escrever o arquivo.\n\n<tool>{"name":"write","arguments":{"path":"daniel.txt","content":"ola"}}' +
        "</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>";
      const sse =
        `data: ${JSON.stringify({ type: "text-delta", id: "1", delta })}\n\n` +
        `data: ${JSON.stringify({ type: "done" })}\n\n`;
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-kimi-k2-7-code",
        stream: true,
        body: {
          messages: [{ role: "user", content: "Crie o arquivo daniel.txt" }],
          tools: [
            {
              type: "function",
              function: { name: "write", parameters: { type: "object", properties: {} } },
            },
          ],
        },
        credentials: { apiKey: "__client=unique-corrupted-close-cookie" },
        signal: null,
      });

      assert.equal(result.response.status, 200);
      const sseText = await result.response.text();
      assert.doesNotMatch(sseText, /DSML/, "the corrupted native close tokens must not leak");
      assert.doesNotMatch(sseText, /<tool>/, "the raw envelope must not leak as visible content");
      assert.match(sseText, /"finish_reason":"tool_calls"/);
      assert.match(sseText, /"name":"write"/);
      assert.match(sseText, /\\"path\\":\\"daniel\.txt\\"/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // #adapta-temporary-chat: iterating through an agentic client (OpenCode, curl tests, etc.)
  // sends one Adapta chat per turn, each one permanently polluting the user's
  // agent.adapta.one web history — the conversation is already persisted on the client's own
  // side (OpenCode's session store), so there is no reason for Adapta's web UI to keep it too.
  it("defaults isTemporaryChat to true so iteration doesn't pollute the user's Adapta web history", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
      }
      if (url.includes("/tokens")) {
        return Response.json({ jwt: "eyJ.temp-chat-default-test.jwt" });
      }
      return new Response(
        `data: ${JSON.stringify({ type: "text-delta", id: "1", delta: "oi" })}\n\n` +
          `data: ${JSON.stringify({ type: "done" })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-kimi-k2-7-code",
        stream: false,
        body: { messages: [{ role: "user", content: "oi" }] },
        credentials: { apiKey: "__client=unique-temp-chat-cookie" },
        signal: null,
      });
      assert.equal((result.transformedBody as Record<string, unknown>)?.isTemporaryChat, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("honors an explicit provider_options.adapta.isTemporaryChat override", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
      }
      if (url.includes("/tokens")) {
        return Response.json({ jwt: "eyJ.temp-chat-override-test.jwt" });
      }
      return new Response(
        `data: ${JSON.stringify({ type: "text-delta", id: "1", delta: "oi" })}\n\n` +
          `data: ${JSON.stringify({ type: "done" })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const executor = new mod.AdaptaWebExecutor();
      const result = await executor.execute({
        model: "adapta-kimi-k2-7-code",
        stream: false,
        body: {
          messages: [{ role: "user", content: "oi" }],
          provider_options: { adapta: { isTemporaryChat: false } },
        },
        credentials: { apiKey: "__client=unique-temp-chat-override-cookie" },
        signal: null,
      });
      assert.equal((result.transformedBody as Record<string, unknown>)?.isTemporaryChat, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
