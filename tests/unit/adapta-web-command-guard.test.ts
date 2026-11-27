import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { looksLikeShellCommand } = await import("../../open-sse/executors/adapta-web/bash.ts");
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

// Live loop: asked to show a file, the model pasted the file's text inside a ```bash
// block. The adapter executed it as a shell command, the client ran prose, and the
// model repeated — 15 identical calls in one session.
describe("pasted file content is not a command", () => {
  it("rejects a pasted sentence inside a bash block", () => {
    assert.equal(looksLikeShellCommand("Olá, tudo bem?\nSim, tudo bem e você?"), false);
  });

  it("rejects JSON / prose / accents", () => {
    assert.equal(looksLikeShellCommand('{"name":"x","value":1}'), false);
    assert.equal(looksLikeShellCommand("O arquivo contém 412 linhas."), false);
  });

  it("accepts real commands, paths and env prefixes", () => {
    assert.equal(looksLikeShellCommand("ls -la"), true);
    assert.equal(looksLikeShellCommand("cat > a.txt <<'EOF'\nhi\nEOF"), true);
    assert.equal(looksLikeShellCommand("./scripts/run.sh"), true);
    assert.equal(looksLikeShellCommand("FOO=1 npm test"), true);
  });

  it("does not emit a tool call for pasted content", () => {
    const r = buildAdaptaToolAwareResult(
      "```bash\nOlá, tudo bem?\nSim, tudo bem e você?\n```",
      TOOLS
    );
    assert.equal(r.toolCalls, null);
    assert.match(r.content, /tudo bem/);
  });

  it("still emits a tool call for a real command", () => {
    const r = buildAdaptaToolAwareResult("```bash\nls -la\n```", TOOLS);
    assert.equal(r.toolCalls?.[0].function?.name, "shell");
  });
});

// The shared <tool> parser passes envelopes through without checking the declared
// schema; one reached the client as `read` with no `path`.
describe("structured envelopes are validated against the client schema", () => {
  it("drops an envelope missing a required argument", () => {
    const r = buildAdaptaToolAwareResult('<tool>{"name":"read","arguments":{}}</tool>', TOOLS);
    assert.equal(r.toolCalls, null);
  });

  it("keeps an envelope that satisfies the schema", () => {
    const r = buildAdaptaToolAwareResult(
      '<tool>{"name":"read","arguments":{"path":"a.txt"}}</tool>',
      TOOLS
    );
    assert.equal(r.toolCalls?.[0].function?.name, "read");
  });

  it("drops a call for a tool the client never declared", () => {
    const r = buildAdaptaToolAwareResult(
      '<tool>{"name":"teleport","arguments":{"to":"moon"}}</tool>',
      TOOLS
    );
    assert.equal(r.toolCalls, null);
  });
});
