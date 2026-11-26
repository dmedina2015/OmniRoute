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

export type CorrectiveKind = "refusal" | "promise";

export function buildCorrectiveNudge(kind: CorrectiveKind): string {
  if (kind === "promise") {
    return (
      "STOP. Your previous reply only announced an intention and emitted no command. " +
      "Do not explain, do not describe a plan, and do not say what you are about to do. " +
      "Reply NOW with exactly one fenced ```bash block containing the first real command."
    );
  }
  return (
    "STOP. The client tools above are available in this conversation and are invoked " +
    "with a fenced ```bash block. Do not claim they are unavailable and do not describe " +
    "them. Reply NOW with exactly one fenced ```bash block containing the first real command."
  );
}
