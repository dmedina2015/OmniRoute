import { buildToolAwareResult } from "../../translator/webTools.ts";
import { classifyBashCommand, extractCommand, shellToolName } from "./bash.ts";
import type { OpenAIToolCallMsg } from "./types.ts";

export interface AdaptaToolAwareResult {
  content: string;
  toolCalls: OpenAIToolCallMsg[] | null;
  finishReason: string;
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
  if (structured.toolCalls) return structured;

  const command = extractCommand(text);
  if (!command) return structured;

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
