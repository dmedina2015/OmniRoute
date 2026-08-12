import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/commandCode.ts");

describe("CommandCodeExecutor", () => {
  it("can be instantiated", () => {
    const executor = new mod.CommandCodeExecutor();
    assert.ok(executor);
  });

  it("can be instantiated with custom provider", () => {
    const executor = new mod.CommandCodeExecutor("custom-provider");
    assert.ok(executor);
  });

  it("buildUrl returns a string", () => {
    const executor = new mod.CommandCodeExecutor();
    const url = executor.buildUrl();
    assert.ok(typeof url === "string");
    assert.ok(url.includes("generate") && url.includes("commandcode"));
  });

  it("execute throws when no API key", async () => {
    const executor = new mod.CommandCodeExecutor();
    try {
      await executor.execute({
        model: "test",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: {},
        signal: null,
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("API key"));
    }
  });

  it("execute returns result shape with valid key (will fail on fetch)", async () => {
    const executor = new mod.CommandCodeExecutor();
    try {
      const result = await executor.execute({
        model: "test",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "fake-key" },
        signal: null,
      });
      // If it returns (network error caught), check shape
      assert.ok(result.response instanceof Response);
      assert.ok(typeof result.url === "string");
      assert.ok(typeof result.headers === "object");
    } catch {
      // Network error is expected in test environment
    }
  });

  it("assistant tool-call conversion always emits a valid required arguments field (#regression input[N] missing required field arguments)", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        init: init || {},
        body: JSON.parse(String((init as RequestInit | undefined)?.body)),
      });
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const executor = new mod.CommandCodeExecutor();
    const pairedId = "call_paired";
    const body = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            // Missing arguments entirely -> must still get a valid arguments field
            { id: "call_missing", type: "function", function: { name: "lookup" } },
            // Empty string arguments -> "{}"
            {
              id: "call_empty",
              type: "function",
              function: { name: "lookup", arguments: "" },
            },
            // Valid object arguments -> round-trips as JSON string
            {
              id: pairedId,
              type: "function",
              function: { name: "lookup", arguments: { q: "docs" } },
            },
            // Valid string arguments -> preserved as-is
            {
              id: "call_string",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"string"}' },
            },
            // Invalid JSON string arguments -> defaults to "{}"
            {
              id: "call_invalid",
              type: "function",
              function: { name: "lookup", arguments: "{invalid-json" },
            },
            // Tool call without name -> defaults tool-result toolName to "unknown"
            {
              id: "call_unnamed",
              type: "function",
              function: { arguments: { q: "unnamed" } },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_missing", content: "r1" },
        { role: "tool", tool_call_id: "call_empty", content: "r2" },
        { role: "tool", tool_call_id: pairedId, content: "r3" },
        { role: "tool", tool_call_id: "call_string", content: "r4" },
        { role: "tool", tool_call_id: "call_invalid", content: "r5" },
        { role: "tool", tool_call_id: "call_unnamed", content: "r6" },
      ],
    };

    try {
      await executor.execute({
        model: "test",
        body,
        stream: false,
        credentials: { apiKey: "fake-key" },
        signal: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 1, "exactly one upstream call");
    const sentBody = calls[0].body as {
      params: { messages: Array<{ role: string; content: unknown }> };
    };
    const assistant = sentBody.params.messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "assistant turn present");
    const parts = assistant.content as Array<Record<string, unknown>>;
    const toolCalls = parts.filter((p) => p.type === "tool-call");
    assert.equal(toolCalls.length, 6, "all six paired tool calls converted");

    for (const call of toolCalls) {
      assert.equal(
        typeof call.arguments,
        "string",
        `tool-call ${String(call.toolCallId)} must carry a string arguments field`
      );
      const parsed = JSON.parse(call.arguments as string);
      assert.equal(typeof parsed, "object");
      assert.ok(!Array.isArray(parsed), "arguments must parse to a JSON object");
    }

    const byId = new Map(toolCalls.map((c) => [String(c.toolCallId), c]));
    assert.equal(byId.get("call_missing").arguments, "{}", "missing arguments -> empty object");
    assert.equal(byId.get("call_empty").arguments, "{}", "empty string arguments -> empty object");
    assert.equal(
      byId.get(pairedId).arguments,
      '{"q":"docs"}',
      "object arguments round-trip as JSON string"
    );
    assert.equal(
      byId.get("call_string").arguments,
      '{"q":"string"}',
      "valid string arguments preserved as-is"
    );
    assert.equal(
      byId.get("call_invalid").arguments,
      "{}",
      "invalid JSON string arguments -> empty object"
    );

    const toolMsgs = sentBody.params.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 6, "all 6 tool result messages present");
    const resultByName = new Map(
      toolMsgs.map((m) => {
        const p = (m.content as Array<Record<string, unknown>>)[0];
        return [String(p.toolCallId), String(p.toolName)];
      })
    );
    assert.equal(resultByName.get("call_missing"), "lookup");
    assert.equal(
      resultByName.get("call_unnamed"),
      "unknown",
      "unnamed call falls back to 'unknown'"
    );

    // /alpha/generate also requires `arguments` on tool-result parts; a
    // missing one is rejected with `input[N] missing required field 'arguments'`
    // (the index landing on the tool message). Echo the paired call's
    // normalized arguments.
    const resultById = new Map(
      toolMsgs.map((m) => {
        const p = (m.content as Array<Record<string, unknown>>)[0];
        return [String(p.toolCallId), p];
      })
    );
    assert.equal(resultById.size, 6, "each tool result maps to its call id");
    for (const p of resultById.values()) {
      assert.equal(
        typeof p.arguments,
        "string",
        `tool-result ${String(p.toolCallId)} must carry a string arguments field`
      );
      const parsed = JSON.parse(p.arguments as string);
      assert.equal(typeof parsed, "object");
      assert.ok(!Array.isArray(parsed), "tool-result arguments must parse to a JSON object");
    }
    assert.equal(
      resultById.get("call_missing").arguments,
      "{}",
      "tool-result echoes paired call's missing arguments as empty object"
    );
    assert.equal(
      resultById.get(pairedId).arguments,
      '{"q":"docs"}',
      "tool-result echoes paired call's object arguments as JSON string"
    );
    assert.equal(
      resultById.get("call_string").arguments,
      '{"q":"string"}',
      "tool-result echoes paired call's valid string arguments as-is"
    );
    assert.equal(
      resultById.get("call_empty").arguments,
      "{}",
      "tool-result echoes paired call's empty arguments as empty object"
    );
    assert.equal(
      resultById.get("call_invalid").arguments,
      "{}",
      "tool-result echoes paired call's invalid JSON arguments as empty object"
    );
  });

  it("COMMAND_CODE_VERSION default constant is 1.15.1", () => {
    assert.equal(mod.COMMAND_CODE_VERSION, "1.15.1");
  });

  it("renames tool names colliding with upstream built-ins on the wire and un-renames on the response (#regression input[N] missing required field arguments from a tool_search result)", async () => {
    // Upstream /alpha/generate normalizes tool-call/result parts against its
    // OWN built-in registry for matching names; `tool_search` collides and its
    // result is rejected with `input[N] missing required field 'arguments'`.
    // Verified live: renaming the pair to a non-colliding name passes.
    const body = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_00_AAAAAAAAAAAAAAAAA",
              type: "function",
              function: { name: "tool_search", arguments: '{"query":"x"}' },
            },
            {
              id: "call_01_BBBBBBBBBBBBBBBBB",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"1"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_00_AAAAAAAAAAAAAAAAA", content: "r1" },
        { role: "tool", tool_call_id: "call_01_BBBBBBBBBBBBBBBBB", content: "r2" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "tool_search",
            description: "search tools",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
        {
          type: "function",
          function: {
            name: "lookup",
            description: "lookup",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ],
    };

    const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    // execute() makes a single upstream fetch; capture the wire request and
    // return a stream with a tool-call event using the renamed wire name.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        init: init || {},
        body: JSON.parse(String((init as RequestInit | undefined)?.body)),
      });
      const streamBody =
        'data: {"type":"tool-call","toolCallId":"c1","toolName":"omniroute_tool_search","input":{"query":"x"}}\n\n' +
        'data: {"type":"finish","finishReason":"tool_use"}\n\n' +
        "data: [DONE]\n\n";
      return new Response(streamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const executor = new mod.CommandCodeExecutor();
    let result: { response: Response } | null = null;
    try {
      result = await executor.execute({
        model: "test",
        body,
        stream: false,
        credentials: { apiKey: "fake-key" },
        signal: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const sentBody = calls[0].body as {
      params: {
        messages: Array<{ role: string; content: unknown }>;
        tools: Array<{ name: string }>;
      };
    };
    const toolDefNames = sentBody.params.tools.map((t) => t.name);
    assert.ok(
      toolDefNames.includes("omniroute_tool_search"),
      "colliding tool def renamed on the wire"
    );
    assert.ok(toolDefNames.includes("lookup"), "non-colliding tool def untouched");

    const assistant = sentBody.params.messages.find((m) => m.role === "assistant");
    const toolCallParts = (assistant?.content as Array<Record<string, unknown>>).filter(
      (p) => p.type === "tool-call"
    );
    const toolSearchCall = toolCallParts.find((p) => p.toolName === "omniroute_tool_search");
    assert.ok(toolSearchCall, "assistant tool-call part renamed on the wire");
    const lookupCall = toolCallParts.find((p) => p.toolName === "lookup");
    assert.ok(lookupCall, "non-colliding tool-call part untouched");

    const toolMsgs = sentBody.params.messages.filter((m) => m.role === "tool");
    const toolSearchResult = toolMsgs.find(
      (m) => (m.content as Array<Record<string, unknown>>)[0]?.toolName === "omniroute_tool_search"
    );
    assert.ok(toolSearchResult, "tool-result part renamed on the wire");

    // Response path: upstream emits the renamed wire name; the client must get
    // its original name back.
    assert.ok(result, "execute returned a response");
    const json = (await result.response.json()) as {
      choices: Array<{ message: { tool_calls?: Array<{ function: { name: string } }> } }>;
    };
    const toolCalls = json.choices[0].message.tool_calls ?? [];
    assert.equal(toolCalls.length, 1, "one tool call translated");
    assert.equal(
      toolCalls[0].function.name,
      "tool_search",
      "renamed wire name un-renamed for the client"
    );
  });
});
