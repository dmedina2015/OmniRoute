import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/adapta-web.ts");
const { extractCommand } = await import("../../open-sse/executors/adapta-web/bash.ts");
const { buildAdaptaToolAwareResult } = await import("../../open-sse/executors/adapta-web/parse.ts");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

function stub(replies: string[], bodies: Array<Record<string, unknown>>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/client")) {
      return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
    }
    if (url.includes("/tokens")) return Response.json({ jwt: "eyJ.empty-reply.jwt" });
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const reply = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return new Response(
      `data: ${JSON.stringify({ type: "text-delta", id: "1", delta: reply })}\n\n` +
        `data: ${JSON.stringify({ type: "done" })}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }) as typeof fetch;
}

// Live report: the final turn of a code-review session came back with no content and no
// tool call, so the client showed a silent "completed".
describe("empty upstream replies", () => {
  it("retries an empty reply and returns the answer that follows", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = stub(["", "O arquivo tem 3 bugs principais."], bodies);
    try {
      const result = await new mod.AdaptaWebExecutor().execute({
        model: "adapta-qwen-3-8-flash",
        stream: false,
        body: { messages: [{ role: "user", content: "revise o código" }], tools: TOOLS },
        credentials: { apiKey: "__client=unique-empty-reply-cookie" },
        signal: null,
      });
      assert.equal(bodies.length, 2, "empty reply must be retried");
      const json = await result.response.json();
      assert.match(json.choices[0].message.content, /3 bugs/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports 502 instead of a silent empty 200 when every retry is empty", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = stub([""], bodies);
    try {
      const result = await new mod.AdaptaWebExecutor().execute({
        model: "adapta-qwen-3-8-flash",
        stream: false,
        body: { messages: [{ role: "user", content: "revise" }], tools: TOOLS },
        credentials: { apiKey: "__client=unique-empty-always-cookie" },
        signal: null,
      });
      assert.equal(result.response.status, 502);
      const json = await result.response.json();
      assert.match(JSON.stringify(json), /empty reply/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the model text when an invalid tool call is dropped", () => {
    const r = buildAdaptaToolAwareResult('<tool>{"name":"read","arguments":{}}</tool>', TOOLS);
    assert.equal(r.toolCalls, null);
    assert.notEqual(r.content, "", "dropping the call must not leave an empty message");
  });
});

describe("adjacent fenced blocks", () => {
  it("does not merge two blocks glued together", () => {
    const reply = "```bash\nfind . -type f | sort\n``````bash\nfind . -type f\n```";
    assert.equal(extractCommand(reply), "find . -type f | sort");
  });

  it("still keeps a heredoc that contains a single fence", () => {
    const reply = "```bash\ncat > a.md <<'EOF'\n```js\nx\n```\nEOF\n```";
    assert.match(extractCommand(reply) ?? "", /EOF/);
  });
});
