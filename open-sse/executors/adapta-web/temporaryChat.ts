/**
 * Adapta's "temporary chat" flag.
 *
 * Every chat OmniRoute opens on the user's Adapta account is stored in that account's
 * web history. An agentic client issues one request per turn, so a single session left
 * a trail of chats the user never asked for — while the conversation is already kept by
 * the client. Defaulting to temporary keeps the account clean; an operator who wants
 * the upstream history can opt back in per request.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Resolve the flag from `provider_options.adapta` (or `provider_options["adapta-web"]`). */
export function resolveIsTemporaryChat(body: Record<string, unknown>): boolean {
  const options = asRecord(body.provider_options);
  const adapta = asRecord(options?.adapta) ?? asRecord(options?.["adapta-web"]);
  const explicit = adapta?.isTemporaryChat;
  if (typeof explicit === "boolean") return explicit;
  return true;
}
