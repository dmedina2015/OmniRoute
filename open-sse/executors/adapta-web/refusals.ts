/**
 * Replies that are NOT the answer, captured live from Adapta.
 *
 * Adapta's web models answer a tool-aware prompt with a deadline-miss far more often
 * than a native tool-calling API would: either a plain refusal ("I don't have access
 * to the terminal", "only the platform catalog is active") or a promise ("I'll start
 * by inspecting the files") with no action attached. Both end the turn with
 * finish_reason "stop" and no tool call, which stalls an agentic loop having done
 * nothing — so both must be recognised and retried rather than returned as an answer.
 *
 * Kept in the provider's folder: the dialects are specific to the models Adapta
 * proxies, not to the HTTP clients that reach them.
 */

const DENIAL_PATTERNS: RegExp[] = [
  /\b(?:i\s+)?(?:cannot|can't|unable\s+to)\s+execute\s+(?:that\s+|this\s+|the\s+|a\s+)?(?:command|listing|tool\s+call|shell\s+command)\b/i,
  /\b(?:this\s+|the\s+|that\s+)?(?:session|conversation|environment|chat)\s+(?:has|have)\s+no\s+access\s+to\b/i,
  /\b(?:this\s+|the\s+|that\s+)?(?:session|conversation|environment|chat)\s+(?:does\s+not|doesn't|do\s+not|don't)\s+(?:expose|provide|include|offer)\b/i,
  /\bno\s+shell\s+(?:access|available)\b/i,
  /\bno\s+filesystem\s+(?:access|available)\b/i,
  /\b(?:the\s+)?(?:tools|features)\s+(?:actually\s+)?(?:available|linked)\s+(?:here|to\s+this\s+(?:session|chat|conversation))\b/i,
  /\bi\s+(?:don't|do\s+not)\s+have\s+access\s+to\s+(?:a\s+|the\s+|any\s+)?(?:terminal|shell|bash|filesystem|file\s+system|files)\b/i,
  /\bn[aã]o\s+(?:consigo|conseguo|posso|consegue|consegui)\s+(?:executar|rodar|chamar|invocar|usar)\b/i,
  /\bn[aã]o\s+(?:consigo|conseguo)\s+executar\s+(?:essa\s+|esta\s+|o\s+|um\s+|uma\s+)?(?:listagem|comando|ferramenta)\b/i,
  /\bn[aã]o\s+(?:ha|há|tem|t[eê]m)\s+(?:acesso\s+)?(?:a|à)\s+(?:o\s+|a\s+|as\s+|terminal|shell|bash|sistema\s+de\s+arquivos|ferramentas?\s+de\s+arquivos)/i,
  /\b(?:esta\s+|essa\s+|nesta\s+)?(?:sess[aã]o|conversa|ambiente|chat)\s+n[aã]o\s+(?:tem|possui|exp[oõ]e|oferece)\b/i,
  /\bn[aã]o\s+exp[oõ]e\s+(?:essa\s+|a\s+|o\s+)?(?:ferramenta|terminal|shell|bash|acesso)/i,
  /\b(?:as\s+)?ferramentas\s+(?:reaismente\s+|de\s+)?(?:dispon[ií]ve[l]?s?|ligadas?)\s+(?:aqui|s[aã]o|s[oõ]\s+)?/i,
  /\bn[aã]o\s+consigo\s+(?:ler|listar|abrir)\s+(?:o\s+|a\s+|arquivos|diret[oó]rio)/i,
  /\bferramenta\s+(?:est[aá]\s+)?indispon[ií]vel\b/i,
  /\b(?:n[aã]o\s+)?chegou\s+a\s+rodar\b/i,
];

/** Verbs that turn "I'll …" into a promise to act rather than a final answer. */
const PROMISE_LEAD_PATTERNS: RegExp[] = [
  /^\s*(?:(?:ok(?:ay)?|alright|sure|got\s+it|understood)[.,!\s-]+)?(?:i(?:'|’)?ll|i\s+will|i(?:'|’)?m\s+going\s+to|let\s+me|now)\b/i,
  /^\s*(?:vou|vamos|vou\s+começar|começarei|comeco|primeiro\s+(?:vou|vamos)|antes\s+de\s+(?:tudo|começar|editar))\b/i,
  /^\s*(?:start(?:ing)?\s+by|first,?\s+(?:i(?:'|’)?ll|let\s+me))\b/i,
  /^\s*(?:let\s+us|let's)\b/i,
];

function normalize(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when the reply declines to use the client tools instead of using them. */
export function isAdaptaRefusal(text: string | null | undefined): boolean {
  const trimmed = normalize(text);
  if (!trimmed) return false;
  return DENIAL_PATTERNS.some((re) => re.test(trimmed));
}

const PROMISE_MAX_CHARS = 500;

/**
 * True when a SHORT reply only announces the next action.
 *
 * Narrow on purpose so ordinary answers are never retried: the promise must lead the
 * reply, the reply must be short, and it must not already carry a fenced block or a
 * structured envelope (that is an action, even if parsing later rejects it).
 */
export function isAdaptaPromise(text: string | null | undefined): boolean {
  const trimmed = normalize(text);
  if (!trimmed || trimmed.length > PROMISE_MAX_CHARS) return false;
  if (/```|<tool/i.test(trimmed)) return false;
  return PROMISE_LEAD_PATTERNS.some((re) => re.test(trimmed));
}
