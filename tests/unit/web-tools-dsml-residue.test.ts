import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { parseToolCallsFromText } = await import("../../open-sse/translator/webTools.ts");

const TOOLS = [
  {
    type: "function",
    function: { name: "bash", parameters: { type: "object", properties: {} } },
  },
];

// #adapta-dsml-residue: models occasionally emit a DSML-style closing tag after the
// command and forget to close the code fence. normalizeDsmlToolCalls() only handled
// complete <invoke> envelopes and stripped <...calls>, so the orphan
// `</｜｜DSML｜｜ parameter>` / `</｜｜DSML｜｜ invoke>` lines were captured by the
// unclosed-fence fallback and ended up INSIDE the command — the shell then received
// a script ending in markup and failed to execute it.
describe("parseToolCallsFromText — DSML residue", () => {
  it("keeps the command clean when an unclosed fence is followed by DSML closing tags", () => {
    const text =
      "```bash\nsed -i 's/a/b/' index.html\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>";

    const result = parseToolCallsFromText(text, "t", TOOLS);
    assert.ok(result.toolCalls, "the command must still become a tool call");
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    assert.equal(args.command, "sed -i 's/a/b/' index.html");
    assert.doesNotMatch(args.command, /DSML/);
  });

  it("strips residue for every DSML bar variant", () => {
    const variants = ["｜｜DSML｜｜", "｜DSML｜", "|DSML|"];
    for (const v of variants) {
      const text = `\`\`\`bash\nnpm test\n</${v} parameter>\n</${v} invoke>`;
      const result = parseToolCallsFromText(text, "t", TOOLS);
      const args = JSON.parse(result.toolCalls![0].function.arguments);
      assert.equal(args.command, "npm test", `variant ${v} leaked residue`);
    }
  });

  it("keeps residue out of the visible content of a closed fence", () => {
    const text =
      "Vou editar.\n```bash\nsed -i 's/a/b/' index.html\n```\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>";

    const result = parseToolCallsFromText(text, "t", TOOLS);
    const args = JSON.parse(result.toolCalls![0].function.arguments);
    assert.equal(args.command, "sed -i 's/a/b/' index.html");
    assert.doesNotMatch(result.content, /DSML/);
    assert.match(result.content, /Vou editar/);
  });

  it("still converts a complete DSML envelope into a tool call", () => {
    const text =
      '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="command">ls -la</｜DSML｜parameter></｜DSML｜invoke>';

    const result = parseToolCallsFromText(text, "t", TOOLS);
    const args = JSON.parse(result.toolCalls![0].function.arguments);
    assert.equal(args.command, "ls -la");
  });

  it("leaves an ordinary fenced command untouched", () => {
    const result = parseToolCallsFromText("```bash\nnpm test\n```", "t", TOOLS);
    const args = JSON.parse(result.toolCalls![0].function.arguments);
    assert.equal(args.command, "npm test");
  });
});
