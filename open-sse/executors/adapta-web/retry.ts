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

export function buildCorrectiveNudge(kind: CorrectiveKind): string {
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
  return (
    "STOP. You have ALREADY used these client tools successfully in this very session, and " +
    "they are available right now. Do not claim they are unavailable, do not describe a " +
    "patch, and do not ask the user to apply it. Reply NOW with exactly one fenced ```bash " +
    "block containing the first real command."
  );
}
