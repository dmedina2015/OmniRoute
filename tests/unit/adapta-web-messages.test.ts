import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildAdaptaMessages } = await import("../../open-sse/executors/adapta-web/messages.ts");

const text = (m: { parts: Array<{ type: string; text?: string }> }) =>
  m.parts.map((p) => p.text ?? "").join("");

describe("buildAdaptaMessages", () => {
  it("keeps the leading system prompt on the first user turn", () => {
    const msgs = buildAdaptaMessages(
      [
        { role: "system", content: "SYS" },
        { role: "user", content: "hello" },
      ],
      "ONE",
      "chat-1"
    );
    assert.equal(msgs.length, 1);
    assert.equal(text(msgs[0]), "SYS\n\nhello");
  });

  // The tool contract is appended AFTER the conversation on purpose; burying it in a
  // large client prompt made the model claim it had no tools.
  it("sends a trailing system block as its own final turn", () => {
    const msgs = buildAdaptaMessages(
      [
        { role: "system", content: "SYS" },
        { role: "user", content: "hello" },
        { role: "system", content: "CONTRACT" },
      ],
      "ONE",
      "chat-1"
    );
    assert.equal(msgs.length, 2);
    assert.equal(text(msgs[0]), "SYS\n\nhello");
    assert.equal(msgs[1].role, "user");
    assert.equal(text(msgs[1]), "CONTRACT");
  });

  // Adapta has no `tool` role: a result has to survive as a labeled user turn or the
  // model repeats the same call forever.
  it("folds assistant tool_calls and tool results into the history", () => {
    const msgs = buildAdaptaMessages(
      [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: "conteúdo" },
      ],
      "ONE",
      "chat-1"
    );
    assert.equal(msgs.length, 3);
    assert.equal(msgs[1].role, "assistant");
    assert.match(text(msgs[1]), /<tool>\{"name":"read"/);
    assert.equal(msgs[2].role, "user");
    assert.match(text(msgs[2]), /\[Tool result: read\]/);
    assert.match(text(msgs[2]), /conteúdo/);
  });

  it("renders tool calls in the bash protocol when asked", () => {
    const msgs = buildAdaptaMessages(
      [
        { role: "user", content: "list" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "bash", arguments: '{"command":"ls -la"}' } }],
        },
      ],
      "ONE",
      "chat-1",
      { toolCallFormat: "bash" }
    );
    assert.match(text(msgs[1]), /```bash\nls -la\n```/);
  });

  it("drops an empty assistant turn", () => {
    const msgs = buildAdaptaMessages(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "" },
        { role: "user", content: "b" },
      ],
      "ONE",
      "chat-1"
    );
    assert.deepEqual(
      msgs.map((m) => m.role),
      ["user", "user"]
    );
  });
});
