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
});
