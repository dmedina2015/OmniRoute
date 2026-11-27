import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildAdaptaToolContract } = await import("../../open-sse/executors/adapta-web/contract.ts");
const { extractCommand, classifyBashCommand, stripDsmlResidue } =
  await import("../../open-sse/executors/adapta-web/bash.ts");
const { buildAdaptaToolAwareResult } = await import("../../open-sse/executors/adapta-web/parse.ts");

/**
 * The tool list a real client sends, trimmed to the parts the adapter reads. The names
 * and argument names here are the contract: `read` takes `path` (NOT `filePath`), which
 * is exactly what used to break when the adapter guessed argument names.
 */
const CLIENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search in files",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "List files",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Replace text",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
        },
        required: ["path", "oldString", "newString"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, workdir: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

const shellTool = (name = "bash") => [
  {
    type: "function",
    function: {
      name,
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, workdir: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

describe("Adapta tool contract", () => {
  it("asks for a closed bash block and lists the declared tools", () => {
    const c = buildAdaptaToolContract(shellTool());
    assert.match(c, /fenced code block tagged `bash`/);
    assert.match(c, /Always close the block/);
    assert.match(c, /Available tools and the command that invokes each one/);
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

describe("classifyBashCommand — argument names come from the client schema", () => {
  it("maps cat to read using the declared `path` argument", () => {
    const r = classifyBashCommand("cat a.txt", CLIENT_TOOLS);
    assert.equal(r?.name, "read");
    // The schema declares `path`; sending `filePath` is what made read fail.
    assert.deepEqual(r?.args, { path: "a.txt" });
  });

  it("maps printf > path to write", () => {
    const r = classifyBashCommand("printf 'olá' > a.txt", CLIENT_TOOLS);
    assert.equal(r?.name, "write");
    assert.deepEqual(r?.args, { path: "a.txt", content: "olá" });
  });

  it("maps grep to grep", () => {
    const r = classifyBashCommand("grep -n 'bem' a.txt", CLIENT_TOOLS);
    assert.equal(r?.name, "grep");
    assert.deepEqual(r?.args, { pattern: "bem", path: "a.txt" });
  });

  it("maps a bare glob to glob", () => {
    const r = classifyBashCommand("ls **/*.txt", CLIENT_TOOLS);
    assert.equal(r?.name, "glob");
    assert.deepEqual(r?.args, { pattern: "**/*.txt" });
  });

  it("maps sed -i to edit with the declared old/new argument names", () => {
    const r = classifyBashCommand("sed -i 's/old/new/' a.txt", CLIENT_TOOLS);
    assert.equal(r?.name, "edit");
    assert.deepEqual(r?.args, { path: "a.txt", oldString: "old", newString: "new" });
  });

  it("follows a client that names its arguments differently", () => {
    const snake = [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      },
    ];
    const r = classifyBashCommand("cat b.txt", snake);
    assert.equal(r?.name, "read_file");
    assert.deepEqual(r?.args, { file_path: "b.txt" });
  });

  // Rewriting part of a compound command would change what was asked for.
  it("leaves compound commands as shell", () => {
    assert.equal(classifyBashCommand("printf 'x' > a.txt && cat a.txt", CLIENT_TOOLS), null);
    assert.equal(classifyBashCommand("cat a.txt | grep x", CLIENT_TOOLS), null);
  });

  // No declared tool for the intent: keep it shell instead of inventing a name.
  it("does not invent a tool the client never declared", () => {
    assert.equal(classifyBashCommand("cat a.txt", shellTool()), null);
  });
});

describe("buildAdaptaToolAwareResult", () => {
  it("turns a bash block into a shell tool call", () => {
    const r = buildAdaptaToolAwareResult("```bash\nls -la\n```", shellTool());
    assert.equal(r.finishReason, "tool_calls");
    assert.equal(r.toolCalls?.[0].function?.name, "bash");
    assert.equal(JSON.parse(r.toolCalls![0].function!.arguments!).command, "ls -la");
    assert.equal(r.content, "");
  });

  it("uses the specific tool and its declared arguments when the command maps", () => {
    const r = buildAdaptaToolAwareResult("```bash\ncat a.txt\n```", CLIENT_TOOLS);
    assert.equal(r.toolCalls?.[0].function?.name, "read");
    assert.deepEqual(JSON.parse(r.toolCalls![0].function!.arguments!), { path: "a.txt" });
  });

  it("still prefers a structured <tool> envelope when the model emits one", () => {
    const r = buildAdaptaToolAwareResult(
      '<tool>{"name":"bash","arguments":{"command":"pwd"}}</tool>',
      shellTool()
    );
    assert.equal(r.toolCalls?.[0].function?.name, "bash");
    assert.equal(JSON.parse(r.toolCalls![0].function!.arguments!).command, "pwd");
  });

  it("leaves a plain answer alone", () => {
    const r = buildAdaptaToolAwareResult("412 linhas.", shellTool());
    assert.equal(r.toolCalls, null);
    assert.match(r.content, /412 linhas/);
  });
});

describe("classifyBashCommand — real grep shapes", () => {
  it("accepts long flags and drops --include when the tool does not declare it", () => {
    const r = classifyBashCommand("grep -rn --include='*' -i 'bem' /tmp/x", CLIENT_TOOLS);
    assert.equal(r?.name, "grep");
    assert.deepEqual(r?.args, { pattern: "bem", path: "/tmp/x" });
  });

  it("forwards --include when the tool declares that argument", () => {
    const withInclude = CLIENT_TOOLS.map((t) =>
      t.function.name === "grep"
        ? {
            ...t,
            function: {
              ...t.function,
              parameters: {
                type: "object",
                properties: {
                  pattern: { type: "string" },
                  path: { type: "string" },
                  include: { type: "string" },
                },
                required: ["pattern"],
              },
            },
          }
        : t
    );
    const r = classifyBashCommand("grep -rn --include='*.ts' 'bem' .", withInclude);
    assert.equal(r?.name, "grep");
    assert.deepEqual(r?.args, { pattern: "bem", path: ".", include: "*.ts" });
  });

  it("still maps the plain grep idiom", () => {
    const r = classifyBashCommand("grep -n 'bem' a.txt", CLIENT_TOOLS);
    assert.deepEqual(r?.args, { pattern: "bem", path: "a.txt" });
  });
});

describe("parser edge cases from the live matrix", () => {
  it("accepts a grep flag after the pattern", () => {
    const r = classifyBashCommand("grep -n 'bem' -r /tmp/x", CLIENT_TOOLS);
    assert.equal(r?.name, "grep");
    assert.deepEqual(r?.args, { pattern: "bem", path: "/tmp/x" });
  });

  it("accepts grep without a path", () => {
    const r = classifyBashCommand("grep -rn 'bem'", CLIENT_TOOLS);
    assert.equal(r?.name, "grep");
    assert.deepEqual(r?.args, { pattern: "bem" });
  });

  it("drops the language label the model repeated inside the block", () => {
    assert.equal(extractCommand("```bash\nbash\nls /tmp/*.txt\n```"), "ls /tmp/*.txt");
  });

  it("keeps a command that legitimately starts with sh-like text intact", () => {
    assert.equal(extractCommand("```bash\nshellcheck a.sh\n```"), "shellcheck a.sh");
  });
});
