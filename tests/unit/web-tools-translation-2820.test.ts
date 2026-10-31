// #2820 — tool-call translation for web-cookie providers (deepseek-web first).
// The web UIs accept only a plain prompt string and reply with tool invocations as
// raw text. These pure helpers (a) serialize the OpenAI `tools` array into a
// system-prompt contract, and (b) parse the upstream `<tool>{...}</tool>` text back
// into OpenAI `tool_calls`.
import test from "node:test";
import assert from "node:assert/strict";

const { serializeToolsToPrompt, parseToolCallsFromText } =
  await import("../../open-sse/translator/webTools.ts");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

test("serializeToolsToPrompt lists the tool and the <tool> invocation contract", () => {
  const prompt = serializeToolsToPrompt(TOOLS);
  assert.ok(prompt.includes("get_weather"), "tool name present");
  assert.ok(prompt.includes("Get the current weather"), "tool description present");
  assert.ok(prompt.includes("<tool>"), "invocation contract mentions the <tool> tag");
});

test("serializeToolsToPrompt returns empty string for no tools", () => {
  assert.equal(serializeToolsToPrompt([]), "");
  assert.equal(serializeToolsToPrompt(undefined), "");
});

test("parseToolCallsFromText extracts a single tool call and strips it from content", () => {
  const text =
    'Sure, let me check.\n<tool>{"name": "get_weather", "arguments": {"city": "Paris"}}</tool>';
  const { content, toolCalls } = parseToolCallsFromText(text);
  assert.ok(toolCalls && toolCalls.length === 1, "one tool call parsed");
  assert.equal(toolCalls[0].type, "function");
  assert.equal(toolCalls[0].function.name, "get_weather");
  // OpenAI tool_calls arguments is a JSON *string*.
  assert.equal(typeof toolCalls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: "Paris" });
  assert.ok(toolCalls[0].id, "tool call has an id");
  assert.ok(!content.includes("<tool>"), "the raw block is stripped from content");
  assert.ok(content.includes("Sure, let me check."), "surrounding text preserved");
});

test("parseToolCallsFromText returns null toolCalls when there is no tool block", () => {
  const { content, toolCalls } = parseToolCallsFromText("just a normal answer");
  assert.equal(toolCalls, null);
  assert.equal(content, "just a normal answer");
});

test("parseToolCallsFromText does NOT promote bare JSON to tool_calls even when tools are requested (#9343)", () => {
  const text = '{"name":"get_weather","arguments":{"city":"Paris"}}';
  const { content, toolCalls } = parseToolCallsFromText(text, "call", TOOLS);

  assert.equal(toolCalls, null, "bare JSON must not be promoted");
  assert.equal(content, text, "bare JSON must be preserved as content text");
});

test("parseToolCallsFromText does not parse bare JSON without requested tools", () => {
  const text = '{"name":"get_weather","arguments":{"city":"Paris"}}';
  const { content, toolCalls } = parseToolCallsFromText(text);

  assert.equal(toolCalls, null);
  assert.equal(content, text);
});

test("parseToolCallsFromText does NOT promote Python-dict-ish bare JSON (#9343)", () => {
  const text =
    "{'command': 'get_weather', 'arguments': {'city': 'Paris', 'units': 'metric', 'fresh': True}}";
  const { content, toolCalls } = parseToolCallsFromText(text, "call", TOOLS);

  assert.equal(toolCalls, null, "bare JSON must not be promoted");
  assert.equal(content, text, "bare JSON must be preserved as content text");
});

test("parseToolCallsFromText does NOT promote bare JSON with single-quoted strings (#9343)", () => {
  // Backward-compat note: single-quoted JSON is still a valid format, but without
  // the <tool> envelope it must not be promoted to a tool call.
  const text = "{'command': 'get_weather', 'arguments': {'city': 'Paris \"City\"'}}";
  const { content, toolCalls } = parseToolCallsFromText(text, "call", TOOLS);

  assert.equal(toolCalls, null, "bare JSON must not be promoted");
  assert.equal(content, text, "bare JSON must be preserved as content text");
});

test("parseToolCallsFromText does NOT promote fuzzy-matched bare JSON (#9343)", () => {
  const text = '{"name":"getWeather","arguments":{"city":"Paris"}}';
  const { content, toolCalls } = parseToolCallsFromText(text, "call", TOOLS);

  assert.equal(toolCalls, null, "bare JSON must not be promoted");
  assert.equal(content, text, "bare JSON must be preserved as content text");
});

test("parseToolCallsFromText does NOT strip bare JSON from surrounding text (#9343)", () => {
  const text =
    'I will check now.\n{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}\nDone.';
  const { content, toolCalls } = parseToolCallsFromText(text, "call", TOOLS);

  assert.equal(toolCalls, null, "bare JSON must not be promoted");
  assert.equal(content, text, "bare JSON must be preserved as content text");
});

test("parseToolCallsFromText ignores bare JSON whose tool is not requested", () => {
  const text = '{"name":"delete_everything","arguments":{"force":true}}';
  const { content, toolCalls } = parseToolCallsFromText(text, "call", TOOLS);

  assert.equal(toolCalls, null);
  assert.equal(content, text);
});

test("parseToolCallsFromText parses multiple tool calls", () => {
  const text =
    '<tool>{"name": "a", "arguments": {"x": 1}}</tool>\n<tool>{"name": "b", "arguments": {}}</tool>';
  const { toolCalls } = parseToolCallsFromText(text);
  assert.equal(toolCalls?.length, 2);
  assert.equal(toolCalls[0].function.name, "a");
  assert.equal(toolCalls[1].function.name, "b");
});

test("parseToolCallsFromText converts full-width DSML parallel calls", () => {
  const text =
    '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="get_weather">{"city":"東京\\n中心"}</｜｜DSML｜｜ invoke>' +
    '<｜｜DSML｜｜ invoke name="get_weather">{"city":"München — ✓"}</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  const { content, toolCalls } = parseToolCallsFromText(text, "call", TOOLS);
  assert.equal(toolCalls?.length, 2);
  assert.deepEqual(JSON.parse(toolCalls![0].function.arguments), { city: "東京\n中心" });
  assert.deepEqual(JSON.parse(toolCalls![1].function.arguments), { city: "München — ✓" });
  assert.equal(content, "");
});

test("parseToolCallsFromText tolerates a tool block with no arguments", () => {
  const { toolCalls } = parseToolCallsFromText('<tool>{"name": "ping"}</tool>');
  assert.equal(toolCalls?.length, 1);
  assert.equal(toolCalls[0].function.name, "ping");
  assert.equal(toolCalls[0].function.arguments, "{}");
});

// #tool-leak-corrupted-close: the model opens the real <tool> protocol (genuine intent —
// the #9343 bare-JSON hardening above still requires this explicit opener), but its native
// dialect's closing tokens leak through instead of a clean </tool> (observed via
// adapta-web/Kimi K2.7 Code: Adapta's own rendering of Kimi's native tool-call close didn't
// match our `</tool>` contract, so findTagBlocks() never found a complete pair and the whole
// thing — including the raw JSON — leaked to the client as plain content with finish_reason
// "stop"). Recover by salvaging the first balanced JSON object right after a genuine <tool>
// opener even when no matching closer is found, mirroring deepseekWebTools.ts's proven
// salvageLeadingJsonObject() fix for the same "<tool>{json}<garbage>" shape.
const WRITE_TOOLS = [
  {
    type: "function",
    function: {
      name: "write",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    },
  },
];

test("parseToolCallsFromText salvages a <tool>{json} block whose close was replaced by corrupted native tokens", () => {
  const text =
    "Vou escrever o arquivo.\n\n" +
    '<tool>{"name": "write", "arguments": {"path": "daniel.txt", "content": "ola mundo"}}' +
    "</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>";
  const { content, toolCalls } = parseToolCallsFromText(text, "call", WRITE_TOOLS);
  assert.ok(
    toolCalls && toolCalls.length === 1,
    "the malformed-close block must still be recovered"
  );
  assert.equal(toolCalls[0].function.name, "write");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
    path: "daniel.txt",
    content: "ola mundo",
  });
  assert.ok(!content.includes("<tool>"), "the raw envelope must not leak into visible content");
  assert.ok(!content.includes("DSML"), "the corrupted close markers must not leak either");
  assert.ok(content.includes("Vou escrever o arquivo."), "surrounding prose is preserved");
});

test("parseToolCallsFromText does NOT salvage when the JSON itself is genuinely truncated (no opener-gated false positive)", () => {
  const text = '<tool>{"name": "write", "arguments": {"path": "a.txt" truncated mid-stream';
  const { content, toolCalls } = parseToolCallsFromText(text, "call", WRITE_TOOLS);
  assert.equal(toolCalls, null, "a genuinely unbalanced object must not be promoted");
  assert.equal(content, text, "unrecovered content passes through unchanged");
});

test("parseToolCallsFromText still refuses bare JSON with no <tool> opener at all, even near a corrupted-looking suffix (#9343 preserved)", () => {
  const text = '{"name":"write","arguments":{"path":"a.txt","content":"x"}}</｜DSML｜ parameter>';
  const { content, toolCalls } = parseToolCallsFromText(text, "call", WRITE_TOOLS);
  assert.equal(toolCalls, null, "no <tool> opener means no genuine protocol intent");
  assert.equal(content, text);
});
