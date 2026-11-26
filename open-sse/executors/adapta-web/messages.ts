import type { AdaptaMessage, OpenAIMessage, OpenAIToolCallMsg } from "./types.ts";

/** Extract plain text from an OpenAI message content (string or content-parts array). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: Record<string, unknown>) => c.type === "text")
      .map((c: Record<string, unknown>) => String(c.text ?? ""))
      .join("");
  }
  return String(content ?? "");
}

/**
 * Render an assistant's tool_calls into the text protocol the model was taught.
 *
 * Adapta's wire format has no `tool` role and no `tool_calls` field, so a history
 * re-send would otherwise lose the model's own prior call: it would see its answer
 * without the call that produced it and re-emit the same call forever. The envelope
 * matches whichever protocol the contract asked for, so the replayed history reads
 * the same way as the live conversation.
 */
export function renderAssistantToolCalls(
  toolCalls: OpenAIToolCallMsg[],
  format: "tool-json" | "bash" = "tool-json"
): string[] {
  const lines: string[] = [];
  for (const tc of toolCalls) {
    const fnName = tc?.function?.name;
    if (!fnName) continue;
    const args = tc.function?.arguments ?? "{}";
    if (format === "bash") {
      let command = "";
      try {
        const parsed = JSON.parse(args) as Record<string, unknown>;
        command = typeof parsed.command === "string" ? parsed.command : "";
      } catch {
        command = "";
      }
      if (command) lines.push("```bash\n" + command + "\n```");
      continue;
    }
    lines.push(`<tool>{"name":${JSON.stringify(fnName)},"arguments":${args}}</tool>`);
  }
  return lines;
}

export interface BuildAdaptaMessagesOptions {
  /** Protocol used to replay the assistant's own tool calls into the history. */
  toolCallFormat?: "tool-json" | "bash";
}

/**
 * Build the Adapta messages array.
 *
 * Adapta only accepts `user`/`assistant` turns with `parts[]`, so the OpenAI history
 * has to be folded:
 *  - `system`/`developer` content is split into *leading* (before the first real turn —
 *    the client's own prompt) and *trailing* (after the last one — the tool contract,
 *    which `prepareToolMessages()` deliberately appends last). Gluing both to turn 1
 *    buried the contract inside a large client prompt and the model then claimed it had
 *    no tools; the trailing block must stay the last thing the model reads.
 *  - `tool` results become labeled user turns, because Adapta has no `tool` role.
 *  - an assistant turn that only called a tool has `content: null`; its calls are
 *    rendered back into the text so the model still sees what it asked for.
 */
export function buildAdaptaMessages(
  messages: OpenAIMessage[],
  modelKey: string,
  chatId: string,
  options: BuildAdaptaMessagesOptions = {}
): AdaptaMessage[] {
  const toolCallFormat = options.toolCallFormat ?? "tool-json";

  let lastNonSystemIdx = -1;
  messages.forEach((msg, idx) => {
    const role = msg.role === "developer" ? "system" : msg.role;
    if (role !== "system") lastNonSystemIdx = idx;
  });

  let leadingSystemText = "";
  let trailingSystemText = "";
  const rest: OpenAIMessage[] = [];

  messages.forEach((msg, idx) => {
    const role = msg.role === "developer" ? "system" : msg.role;
    if (role === "system") {
      const text = extractText(msg.content);
      if (idx > lastNonSystemIdx) {
        trailingSystemText += (trailingSystemText ? "\n" : "") + text;
      } else {
        leadingSystemText += (leadingSystemText ? "\n" : "") + text;
      }
      return;
    }
    rest.push(msg);
  });

  // tool_call_id -> function name, so a tool-result turn can name what produced it.
  const callIdToName = new Map<string, string>();
  for (const msg of rest) {
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (tc?.id && typeof tc.function?.name === "string") {
        callIdToName.set(String(tc.id), tc.function.name);
      }
    }
  }

  const adapted: AdaptaMessage[] = [];
  let systemInjected = false;

  for (const msg of rest) {
    if (msg.role === "tool") {
      const text = extractText(msg.content).trim();
      if (!text) continue;
      const name = msg.name || callIdToName.get(String(msg.tool_call_id ?? "")) || "tool";
      adapted.push({
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: `[Tool result: ${name}]\n${text}` }],
      });
      continue;
    }

    if (msg.role !== "user" && msg.role !== "assistant") continue;

    let text = extractText(msg.content);
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const callLines = renderAssistantToolCalls(msg.tool_calls, toolCallFormat);
      text = [text.trim(), ...callLines].filter(Boolean).join("\n\n");
    }

    // Drop a turn that carries nothing: empty content and no tool calls. An assistant
    // turn that ONLY called a tool has `content: null`, but its calls were rendered
    // above, so `text` is non-empty by now and the turn is kept.
    if (!text.trim()) continue;

    const id = crypto.randomUUID();

    if (msg.role === "assistant") {
      adapted.push({
        id,
        role: "assistant",
        parts: [{ type: "text", text }],
        metadata: { model: modelKey, chatId, messageId: id, isPaused: false },
        state: "done",
      });
      continue;
    }

    if (!systemInjected && leadingSystemText) {
      adapted.push({
        id,
        role: "user",
        parts: [{ type: "text", text: `${leadingSystemText}\n\n${text}` }],
      });
      systemInjected = true;
    } else {
      adapted.push({ id, role: "user", parts: [{ type: "text", text }] });
    }
  }

  if (trailingSystemText) {
    adapted.push({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: trailingSystemText }],
    });
  }

  return adapted;
}
