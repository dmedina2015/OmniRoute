import { buildToolAwareResult } from "../../translator/webTools.ts";
import {
  classifyBashCommand,
  extractCommand,
  looksLikeShellCommand,
  shellToolName,
} from "./bash.ts";
import { readToolSpecs } from "./toolSchema.ts";
import type { OpenAIToolCallMsg } from "./types.ts";

export interface AdaptaToolAwareResult {
  content: string;
  toolCalls: OpenAIToolCallMsg[] | null;
  finishReason: string;
}

function callSatisfiesSchema(call: OpenAIToolCallMsg, tools: unknown): boolean {
  const name = call.function?.name;
  if (!name) return false;
  const spec = readToolSpecs(tools).find((s) => s.name === name);
  // A call for a tool the client never declared would also be rejected by the client.
  if (!spec) return false;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
  } catch {
    return false;
  }
  return spec.required.every(
    (key) => args[key] !== undefined && args[key] !== null && args[key] !== ""
  );
}

const FENCED_BLOCK_RE = /```(?:bash|sh|shell|zsh)?[^\S\n]*\n[\s\S]*?```/g;

/**
 * Turn an Adapta reply into an OpenAI tool-call result.
 *
 * Two protocols are accepted, because the same model may answer either way depending
 * on how it was primed:
 *  1. a structured envelope (`<tool>{…}</tool>` or a native DSML call), parsed by the
 *     shared translator so history/tooling stays consistent with every other provider;
 *  2. a fenced shell command, which is what Adapta's contract asks for.
 */
export function buildAdaptaToolAwareResult(
  text: string,
  tools: unknown,
  idSeed = "adp"
): AdaptaToolAwareResult {
  const structured = buildToolAwareResult(text, tools, idSeed);
  if (structured.toolCalls) {
    // The shared parser passes a <tool> envelope through without checking it against
    // the tool's own schema; an envelope with required fields missing reached the
    // client as an invalid call ("read: path missing"). Only keep calls that satisfy
    // the declared schema, otherwise fall back to the text.
    if (structured.toolCalls.every((call) => callSatisfiesSchema(call, tools))) return structured;
    // Dropping the call must not leave the client with an empty message: keep the raw
    // text so the user sees what the model tried to do.
    return { content: text, toolCalls: null, finishReason: "stop" };
  }

  const command = extractCommand(text);
  if (!command) return structured;

  // Pasted file content is not a command: asked to show a file, models often put the
  // file's text inside a ```bash block. Executing that produced a loop of identical
  // shell calls (the client ran prose, failed, the model retried).
  if (!looksLikeShellCommand(command)) return structured;

  const classified = classifyBashCommand(command, tools);
  const shell = shellToolName(tools);
  const name = classified?.name ?? shell;
  // No shell-shaped tool was declared: keep the reply as plain text rather than
  // inventing a tool call the client cannot execute.
  if (!name) return structured;

  const args = classified?.args ?? { command };
  return {
    content: structured.content.replace(FENCED_BLOCK_RE, "").trim(),
    toolCalls: [
      {
        id: `${idSeed}-${Date.now()}-0`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
    finishReason: "tool_calls",
  };
}
