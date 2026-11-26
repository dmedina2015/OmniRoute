import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/adapta-web.ts");
const { isAdaptaRefusal, isAdaptaPromise } =
  await import("../../open-sse/executors/adapta-web/refusals.ts");

const TOOLS = [
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } },
];

describe("Adapta refusal and promise detection", () => {
  it("recognises the refusal dialects captured live", () => {
    assert.equal(isAdaptaRefusal("I don't have access to the terminal here."), true);
    assert.equal(isAdaptaRefusal("No shell access in this session."), true);
    assert.equal(isAdaptaRefusal("Não consigo executar esse comando."), true);
    assert.equal(isAdaptaRefusal("A ferramenta está indisponível."), true);
  });

  it("does not flag an ordinary answer as a refusal", () => {
    assert.equal(isAdaptaRefusal("O arquivo tem 412 linhas."), false);
    assert.equal(isAdaptaRefusal("Done — the diff is in app.js."), false);
    assert.equal(isAdaptaRefusal(""), false);
  });

  it("recognises a promise that announces instead of acting", () => {
    assert.equal(isAdaptaPromise("I'll start by inspecting the three files."), true);
    assert.equal(isAdaptaPromise("Vou começar analisando o HTML."), true);
    assert.equal(isAdaptaPromise("Let me check the stylesheet."), true);
  });

  it("does not flag a reply that already carries an action", () => {
    assert.equal(isAdaptaPromise("Sure:\n```bash\nls -la\n```"), false);
    assert.equal(isAdaptaPromise("I'll start by explaining. " + "x".repeat(600)), false);
    assert.equal(isAdaptaPromise("O arquivo tem 412 linhas."), false);
  });
});

describe("AdaptaWebExecutor — corrective retry", () => {
  function stub(replies: string[], bodies: Array<Record<string, unknown>>) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
      }
      if (url.includes("/tokens")) return Response.json({ jwt: "eyJ.retry-test.jwt" });
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      const reply = replies[Math.min(bodies.length - 1, replies.length - 1)];
      return new Response(
        `data: ${JSON.stringify({ type: "text-delta", id: "1", delta: reply })}\n\n` +
          `data: ${JSON.stringify({ type: "done" })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    }) as typeof fetch;
  }

  it("retries a promise with a corrective nudge and returns the action that follows", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = stub(
      ["I'll start by inspecting the three files.", "```bash\nls -la\n```"],
      bodies
    );

    try {
      const result = await new mod.AdaptaWebExecutor().execute({
        model: "adapta-kimi-k2-7-code",
        stream: false,
        body: { messages: [{ role: "user", content: "list files" }], tools: TOOLS },
        credentials: { apiKey: "__client=unique-retry-promise-cookie" },
        signal: null,
      });

      assert.equal(bodies.length, 2, "one initial call plus one corrective retry");
      const retryPayload = JSON.stringify(bodies[1]);
      assert.match(retryPayload, /STOP/);
      assert.match(retryPayload, /announced an intention/);

      const json = await result.response.json();
      assert.equal(json.choices[0].finish_reason, "tool_calls");
      assert.equal(json.choices[0].message.tool_calls[0].function.name, "bash");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry a real answer", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = stub(["O arquivo tem 412 linhas."], bodies);

    try {
      const result = await new mod.AdaptaWebExecutor().execute({
        model: "adapta-kimi-k2-7-code",
        stream: false,
        body: { messages: [{ role: "user", content: "how many lines?" }], tools: TOOLS },
        credentials: { apiKey: "__client=unique-retry-answer-cookie" },
        signal: null,
      });
      assert.equal(bodies.length, 1);
      const json = await result.response.json();
      assert.match(json.choices[0].message.content, /412 linhas/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the previous reply when the retry comes back empty", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = stub(["I don't have access to the terminal here.", ""], bodies);

    try {
      const result = await new mod.AdaptaWebExecutor().execute({
        model: "adapta-kimi-k2-7-code",
        stream: false,
        body: { messages: [{ role: "user", content: "write the file" }], tools: TOOLS },
        credentials: { apiKey: "__client=unique-retry-empty-cookie" },
        signal: null,
      });
      assert.equal(bodies.length, 2);
      const json = await result.response.json();
      assert.notEqual(json.choices[0].message.content, "");
      assert.match(json.choices[0].message.content, /don't have access/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
