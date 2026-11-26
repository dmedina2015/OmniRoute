import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildAdaptaToolContract } = await import("../../open-sse/executors/adapta-web/contract.ts");
const { extractCommand, classifyBashCommand, stripDsmlResidue } =
  await import("../../open-sse/executors/adapta-web/bash.ts");
const { buildAdaptaToolAwareResult } = await import("../../open-sse/executors/adapta-web/parse.ts");

const bash = (name = "bash") => [
  { type: "function", function: { name, parameters: { type: "object", properties: {} } } },
];

describe("Adapta tool contract", () => {
  it("asks for a closed bash block and lists the declared tools", () => {
    const c = buildAdaptaToolContract(bash());
    assert.match(c, /fenced code block with language tag 'bash'/);
    assert.match(c, /Always close the block/);
    assert.match(c, /Available tools:/);
    // The neutral alias is what the model sees; the client keeps the real name.
    assert.match(c, /- terminal/);
    assert.doesNotMatch(c, /- bash/);
  });

  it("returns an empty contract when no tools are declared", () => {
    assert.equal(buildAdaptaToolContract([]), "");
    assert.equal(buildAdaptaToolContract(undefined), "");
  });
});

describe("extractCommand", () => {
  it("reads a tagged block", () => {
    assert.equal(extractCommand("ok\n```bash\nls -la\n```"), "ls -la");
  });

  it("recovers an unclosed fence", () => {
    assert.equal(extractCommand("```bash\nnpm test"), "npm test");
  });

  it("keeps a heredoc that contains fences inside the body", () => {
    const reply = "```bash\ncat > a.md <<'EOF'\n```js\nx\n```\nEOF\n```";
    assert.match(extractCommand(reply) ?? "", /cat > a\.md/);
    assert.match(extractCommand(reply) ?? "", /EOF/);
  });

  it("strips orphan DSML tags left after an unclosed fence", () => {
    const reply =
      "```bash\nsed -i 's/a/b/' index.html\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>";
    assert.equal(extractCommand(reply), "sed -i 's/a/b/' index.html");
    assert.doesNotMatch(stripDsmlResidue(reply), /DSML/);
  });

  it("returns null when there is no block", () => {
    assert.equal(extractCommand("O arquivo tem 412 linhas."), null);
  });
});

describe("classifyBashCommand", () => {
  const tools = ["read", "write", "grep", "glob", "edit", "bash"].map((name) => ({
    type: "function",
    function: { name, parameters: { type: "object", properties: {} } },
  }));

  it("maps simple commands onto the specific tool", () => {
    assert.equal(classifyBashCommand("cat a.txt", tools)?.name, "read");
    assert.equal(classifyBashCommand("grep -n foo a.txt", tools)?.name, "grep");
    assert.equal(classifyBashCommand("printf 'x' > a.txt", tools)?.name, "write");
    assert.equal(classifyBashCommand("sed -i 's/a/b/' a.txt", tools)?.name, "edit");
  });

  // Rewriting a compound command would change what the user asked for.
  it("leaves compound commands as shell", () => {
    assert.equal(classifyBashCommand("cat a.txt | grep x", tools), null);
    assert.equal(classifyBashCommand("cd x && ls", tools), null);
  });
});

describe("buildAdaptaToolAwareResult", () => {
  it("turns a bash block into a shell tool call", () => {
    const r = buildAdaptaToolAwareResult("```bash\nls -la\n```", bash());
    assert.equal(r.finishReason, "tool_calls");
    assert.equal(r.toolCalls?.[0].function?.name, "bash");
    assert.equal(JSON.parse(r.toolCalls![0].function!.arguments!).command, "ls -la");
    assert.equal(r.content, "");
  });

  it("uses a specific tool when the command maps to one", () => {
    const tools = [
      { type: "function", function: { name: "read", parameters: { type: "object" } } },
    ];
    const r = buildAdaptaToolAwareResult("```bash\ncat a.txt\n```", tools);
    assert.equal(r.toolCalls?.[0].function?.name, "read");
  });

  it("still prefers a structured <tool> envelope when the model emits one", () => {
    const r = buildAdaptaToolAwareResult(
      '<tool>{"name":"bash","arguments":{"command":"pwd"}}</tool>',
      bash()
    );
    assert.equal(r.toolCalls?.[0].function?.name, "bash");
    assert.equal(JSON.parse(r.toolCalls![0].function!.arguments!).command, "pwd");
  });

  it("leaves a plain answer alone", () => {
    const r = buildAdaptaToolAwareResult("412 linhas.", bash());
    assert.equal(r.toolCalls, null);
    assert.match(r.content, /412 linhas/);
  });
});
