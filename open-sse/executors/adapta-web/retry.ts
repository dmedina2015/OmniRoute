/**
 * Bounded retry policy for tool-aware Adapta calls.
 *
 * A single tool-aware call succeeds roughly 40-70% of the time depending on the tool,
 * because the failure mode is a text refusal or a promise instead of an action. An
 * agentic task composes multiplicatively (five steps at 60%/step is ~17% end-to-end),
 * so retrying inside the provider turns ~60% per step into ~94%.
 *
 * The retry carries the correction: re-sending the identical payload usually
 * reproduces the identical refusal, so a short instruction is appended as one extra
 * user turn.
 */
export const ADAPTA_MAX_TOOL_RETRIES = 3;

export type CorrectiveKind = "refusal" | "promise" | "empty";

export interface CorrectiveContext {
  /** Last tool result that reported a failure, from the request history. */
  lastToolError?: string | null;
}

export function buildCorrectiveNudge(
  kind: CorrectiveKind,
  context: CorrectiveContext = {}
): string {
  if (kind === "empty") {
    return (
      "Your previous reply was completely empty. Continue the task now: either emit one " +
      "fenced ```bash block with the command you still need, or answer the user with the " +
      "result you already have."
    );
  }
  if (kind === "promise") {
    return (
      "STOP. Your previous reply only announced an intention and emitted no command. " +
      "Do not explain, do not describe a plan, and do not say what you are about to do. " +
      "Reply NOW with exactly one fenced ```bash block containing the first real command."
    );
  }
  // When the history carries a failing tool result, the model tends to read its own
  // failed command as "the tool was rejected / the shell is gone". Quote the real error:
  // the tool ran, the command failed, and it can be fixed.
  const errorHint = context.lastToolError
    ? ' Your last tool call DID run and failed with: "' +
      context.lastToolError.replace(/\s+/g, " ").slice(0, 240) +
      '". The tool is working — fix the command or the file content and try again.'
    : "";
  return (
    "STOP. You have ALREADY used these client tools successfully in this very session, and " +
    "they are available right now." +
    errorHint +
    " Do not claim they are unavailable, do not describe a patch, and do not ask the user " +
    "to apply it. Reply NOW with exactly one fenced ```bash block containing the corrected command."
  );
}
