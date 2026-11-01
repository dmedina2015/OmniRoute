import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeToolRefusal } from "../../open-sse/translator/webTools.ts";

// #adapta-refusal-retry: the refusal detector decides whether a tool-aware upstream
// reply is retryable. It must catch the refusal dialects observed live on adapta-web
// (Claude 5.5 Sonnet / Kimi K2.7 Code) and — just as importantly — NOT flag ordinary
// final answers, which would burn an extra upstream call and could replace a correct
// answer with a worse one.

test("looksLikeToolRefusal flags an explicit access denial", () => {
  assert.equal(looksLikeToolRefusal("Não tenho acesso a ferramentas neste ambiente."), true);
  assert.equal(
    looksLikeToolRefusal("I don't have access to the terminal, so I cannot run that command."),
    true
  );
  assert.equal(looksLikeToolRefusal("I cannot use a terminal here."), true);
  assert.equal(looksLikeToolRefusal("The terminal is not available in this session."), true);
});

test("looksLikeToolRefusal flags the platform-only-catalog confabulation", () => {
  assert.equal(
    looksLikeToolRefusal(
      "As ferramentas da plataforma estão ativas, mas o terminal não está disponível nesta sessão."
    ),
    true
  );
  assert.equal(
    looksLikeToolRefusal(
      "The client tools are not actually registered here — only the platform catalog is active."
    ),
    true
  );
  assert.equal(
    looksLikeToolRefusal("Only the platform-level tool registry is available in this chat."),
    true
  );
});

test("looksLikeToolRefusal flags the duplicate-session confabulation", () => {
  assert.equal(
    looksLikeToolRefusal(
      "Parece que há uma sessão duplicada; a execução aconteceu em outro ambiente."
    ),
    true
  );
  assert.equal(
    looksLikeToolRefusal("This looks like a separate session — the tool ran elsewhere."),
    true
  );
});

test("looksLikeToolRefusal flags stated intent that never emitted a tool block", () => {
  assert.equal(looksLikeToolRefusal("Vou criar o arquivo agora mesmo."), true);
  assert.equal(looksLikeToolRefusal("Let me run the tests first."), true);
  assert.equal(looksLikeToolRefusal("I'll write the file to disk."), true);
});

test("looksLikeToolRefusal returns false for a legitimate final answer", () => {
  assert.equal(looksLikeToolRefusal("O arquivo tem 412 linhas e exporta 3 funções."), false);
  assert.equal(
    looksLikeToolRefusal("Pronto — criei o documento com as 5 seções que você pediu."),
    false
  );
  assert.equal(looksLikeToolRefusal("The file has 412 lines and exports 3 functions."), false);
  assert.equal(
    looksLikeToolRefusal("I created the document with the 5 sections you asked for."),
    false
  );
  assert.equal(looksLikeToolRefusal(""), false);
  assert.equal(looksLikeToolRefusal("   \n  "), false);
  assert.equal(looksLikeToolRefusal(null), false);
  assert.equal(looksLikeToolRefusal(undefined), false);
});

test("looksLikeToolRefusal does not flag prose that merely mentions tools", () => {
  assert.equal(
    looksLikeToolRefusal("The shell command ran successfully and returned 3 lines of output."),
    false
  );
  assert.equal(
    looksLikeToolRefusal("Use the terminal tool to run `npm test` when you are ready."),
    false
  );
  assert.equal(
    looksLikeToolRefusal("Tooling note: the repository uses npm scripts for every task."),
    false
  );
});
