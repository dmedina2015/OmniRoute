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

// Live: mid-session the model denied having the tools it had just used, and offered a
// patch instead of applying it.
describe("refusal dialects seen mid-session", () => {
  it("detects a denial phrased as unavailability of the file/shell tools", () => {
    assert.equal(
      isAdaptaRefusal(
        "Não consegui aplicar a edição direto no arquivo nesta sessão — as ferramentas de " +
          "arquivo e terminal não estão disponíveis agora. Mas o tui.py está todo no " +
          "contexto, então segue o patch completo"
      ),
      true
    );
  });

  it("detects the English variants", () => {
    assert.equal(
      isAdaptaRefusal("I can't write to the file in this session; the tools are not available."),
      true
    );
  });

  it("does not flag a legitimate answer that needs clarification", () => {
    assert.equal(isAdaptaRefusal("Não consegui entender o requisito, pode explicar?"), false);
    assert.equal(isAdaptaRefusal("O arquivo tem 412 linhas e 3 exports."), false);
  });
});

// Live: "Nao consigo MAIS rodar comandos nesta conversa — o shell saiu do ambiente."
// The adverb between verb and action broke the earlier pattern.
describe("denials with adverbs or an 'environment left' claim", () => {
  it("detects 'nao consigo mais <action>'", () => {
    assert.equal(
      isAdaptaRefusal(
        "Não consigo mais rodar comandos nesta conversa — o shell saiu do ambiente. " +
          "Então vou ser direto sobre a causa e te dar o patch para aplicar."
      ),
      true
    );
  });

  it("detects 'o shell/terminal nao esta mais disponivel'", () => {
    assert.equal(isAdaptaRefusal("O terminal não está mais disponível nesta sessão."), true);
    assert.equal(isAdaptaRefusal("Perdi acesso ao shell, segue o patch."), true);
  });

  it("detects the English equivalent", () => {
    assert.equal(isAdaptaRefusal("I can no longer run commands in this session."), true);
  });
});

// Live: the model read its OWN failing command as "the shell was rejected" and refused.
// The corrective nudge now quotes the real error so the retry has evidence to the
// contrary.
describe("refusal after a failing tool call", () => {
  it("includes the real tool error in the retry payload", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
      }
      if (url.includes("/tokens")) return Response.json({ jwt: "eyJ.tool-error-retry.jwt" });
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      const reply =
        bodies.length === 1
          ? "Não consigo mais rodar comandos: a chamada anterior foi rejeitada."
          : "```bash\npython3 -c 'print(1)'\n```";
      return new Response(
        `data: ${JSON.stringify({ type: "text-delta", id: "1", delta: reply })}\n\n` +
          `data: ${JSON.stringify({ type: "done" })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const result = await new mod.AdaptaWebExecutor().execute({
        model: "adapta-qwen-3-8-flash",
        stream: false,
        body: {
          messages: [
            { role: "user", content: "corrija o arquivo" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  function: { name: "shell", arguments: '{"command":"python3 tui.py"}' },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "c1",
              content: "SyntaxError: unterminated string literal",
            },
          ],
          tools: TOOLS,
        },
        credentials: { apiKey: "__client=unique-tool-error-cookie" },
        signal: null,
      });

      assert.equal(bodies.length, 2, "the refusal must be retried");
      const retryPayload = JSON.stringify(bodies[1]);
      assert.match(retryPayload, /SyntaxError/, "the nudge must quote the real error");
      const json = await result.response.json();
      assert.match(json.choices[0].message.tool_calls[0].function.name, /^(bash|shell)$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Five refusal phrasings in a row motivated a structural detector: a tool/execution noun
// plus a negative availability state in the same sentence, in either order.
describe("structural refusal detection", () => {
  it("detects the environment-unavailable family", () => {
    const family = [
      "O ambiente parou de aceitar execução de comandos no meio da tarefa — o shell ficou indisponível e não consigo mais gravar/rodar nada nesta sessão.",
      "Não consigo mais rodar comandos nesta conversa — o shell saiu do ambiente.",
      "as ferramentas de arquivo e terminal não estão disponíveis agora",
      "O terminal ficou indisponível.",
      "The shell is unavailable in this session.",
    ];
    for (const text of family) assert.equal(isAdaptaRefusal(text), true, text.slice(0, 40));
  });

  it("never flags a failing tool report or a normal answer", () => {
    const controls = [
      "O comando falhou com SyntaxError na linha 575 e o arquivo segue quebrado.",
      "O arquivo tem 412 linhas e 3 exports.",
      "Não consegui entender o requisito, pode explicar?",
      "Segue o patch completo para você aplicar em _acao_nova.",
    ];
    for (const text of controls) assert.equal(isAdaptaRefusal(text), false, text.slice(0, 40));
  });
});
