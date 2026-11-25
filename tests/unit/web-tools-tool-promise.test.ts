import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { looksLikeToolPromise, looksLikeToolRefusal, buildToolCorrectiveNudge } =
  await import("../../open-sse/translator/webTools.ts");

// #adapta-tool-promise: live Adapta replies like "I'll start by inspecting the three
// files." announced the action and stopped. looksLikeToolRefusal() only knew the verbs
// in its enumerations ("I'll create", "vou editar"), so the promise passed through as a
// final answer: finish_reason "stop", no tool_calls, nothing edited.
describe("looksLikeToolPromise", () => {
  it("detects the exact live failure that stalled a multi-file subagent", () => {
    assert.equal(looksLikeToolPromise("I'll start by inspecting the three files."), true);
  });

  it("detects the Portuguese variants a plan often opens with", () => {
    assert.equal(looksLikeToolPromise("Vou começar analisando o HTML."), true);
    assert.equal(looksLikeToolPromise("Vamos inspecionar os arquivos primeiro."), true);
    assert.equal(looksLikeToolPromise("Primeiro vou ver o template."), true);
    assert.equal(looksLikeToolPromise("Começarei lendo o CSS."), true);
  });

  it("detects the English lead-ins the refusal patterns missed", () => {
    assert.equal(looksLikeToolPromise("Let me check the current stylesheet."), true);
    assert.equal(looksLikeToolPromise("Starting by reading the template."), true);
    assert.equal(looksLikeToolPromise("Sure, I'll take a look at the files."), true);
  });

  // The retry must not fire for replies that already carry an action, even when the
  // parser later rejects the envelope — that is a parse problem, not a promise.
  it("returns false once the reply carries a fenced block or a tool envelope", () => {
    assert.equal(looksLikeToolPromise("I'll edit it:\n```bash\nsed -i s/a/b/ x.html\n```"), false);
    assert.equal(
      looksLikeToolPromise('I\'ll use the tool: <tool>{"name":"write","arguments":{}}</tool>'),
      false
    );
  });

  it("returns false for ordinary final answers", () => {
    assert.equal(looksLikeToolPromise("O arquivo tem 412 linhas e 3 exports."), false);
    assert.equal(looksLikeToolPromise("Done — the diff is in app.js."), false);
    assert.equal(looksLikeToolPromise(""), false);
    assert.equal(looksLikeToolPromise(null), false);
  });

  it("returns false for long replies, which are answers rather than promises", () => {
    const long = "I'll start by explaining the architecture. " + "x".repeat(600);
    assert.equal(looksLikeToolPromise(long), false);
  });

  it("keeps the refusal detector behaviour for the verbs it already covered", () => {
    assert.equal(looksLikeToolRefusal("I don't have access to the terminal here."), true);
    assert.equal(looksLikeToolRefusal("Vou criar o arquivo agora."), true);
  });
});

describe("buildToolCorrectiveNudge", () => {
  it("tells the model to act instead of re-announcing the plan", () => {
    const nudge = buildToolCorrectiveNudge("promise");
    assert.match(nudge, /STOP/);
    assert.match(nudge, /```bash/);
    assert.match(nudge, /Do not explain/);
  });

  it("reframes the refusal variant around tool availability", () => {
    const nudge = buildToolCorrectiveNudge("refusal");
    assert.match(nudge, /available/);
    assert.match(nudge, /```bash/);
  });

  it("returns different text per kind so the retry carries the right correction", () => {
    assert.notEqual(buildToolCorrectiveNudge("promise"), buildToolCorrectiveNudge("refusal"));
  });
});
