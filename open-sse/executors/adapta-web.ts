import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { prepareToolMessages, looksLikeToolRefusal } from "../translator/webTools.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";

const ADAPTA_APP_URL = "https://agent.adapta.one";
const ADAPTA_CLERK_URL = "https://clerk.agent.adapta.one";
const ADAPTA_STREAM_URL = `${ADAPTA_APP_URL}/api/chat/stream/v1`;
const ADAPTA_PUBLIC_STREAM_ERROR = `\n\n[Erro: ${sanitizeErrorMessage("Adapta upstream error")}]`;

// Default model key in Adapta's catalog (auto-select).
const DEFAULT_MODEL_KEY = "ONE";

// #adapta-refusal-retry: Adapta's web models are non-deterministic enough that a single
// tool-aware call succeeds only ~40-70% of the time depending on the tool — the rest of
// the time the model replies with a plain-text refusal ("I don't have access to the
// terminal", "only the platform catalog is active") instead of a <tool> block. Because
// agentic tasks compose multiplicatively (5 steps at 60%/step ≈ 17% end-to-end), a
// bounded in-provider retry turns a ~60% per-step success into ~94%. Mirrors the
// established bounded-retry pattern in deepseek-web.ts (MAX_TOOL_PARSE_ATTEMPTS).
const ADAPTA_MAX_REFUSAL_RETRIES = 3;

// Map from OmniRoute model IDs to Adapta catalog model keys.
export const MODEL_KEY_MAP: Record<string, string> = {
  "adapta-one": "ONE",
  "adapta-gpt-6-luna": "GPT_6_LUNA",
  "adapta-claude-5-5-haiku": "CLAUDE_5_5_HAIKU",
  "adapta-claude-5-5-sonnet": "CLAUDE_5_5_SONNET",
  "adapta-claude-5-sonnet": "CLAUDE_5_SONNET",
  "adapta-gemini-3-8-flash": "GEMINI_3_8_FLASH",
  "adapta-gemini-3-7-flash": "GEMINI_3_7_FLASH",
  "adapta-gemini-3-1-pro-preview": "GEMINI_3_1_PRO_PREVIEW",
  "adapta-deepseek-v4-1-flash-1017": "DEEPSEEK_V4_1_FLASH_1017",
  "adapta-deepseek-v4-flash-updated": "DEEPSEEK_V4_FLASH_UPDATED",
  "adapta-deepseek-v4-pro-0813": "DEEPSEEK_V4_PRO_0813",
  "adapta-kimi-k2-7-code": "KIMI_K2_7_CODE",
  "adapta-kimi-k2-6": "KIMI_K2_6",
  "adapta-minimax-m3": "MINIMAX_M3",
  "adapta-minimax-m3-1-flash": "MINIMAX_M3_1_FLASH",
  "adapta-minimax-m2-7-highspeed": "MINIMAX_M2_7_HIGHSPEED",
  "adapta-minimax-m2-7": "MINIMAX_M2_7",
  "adapta-qwen-3-8-27b": "QWEN_3_8_27B",
  "adapta-qwen-3-8-flash": "QWEN_3_8_FLASH",
  "adapta-qwen-3-7-plus": "QWEN_3_7_PLUS",
  "adapta-glm-5-3-flash": "GLM_5_3_FLASH",
  "adapta-glm-5-2": "GLM_5_2",
  "adapta-grok-43": "GROK_43",
  "adapta-muse-spark-1-3": "MUSE_SPARK_1_3",
  "adapta-sonar-pro": "SONAR_PRO",
  "adapta-nvidia-nemotron-super": "NVIDIA_NEMOTRON_SUPER",
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ── In-memory session cache ───────────────────────────────────────────────────

interface CachedSession {
  sessionId: string;
  jwt: string;
  jwtExpiresAt: number; // unix ms
}

const SESSION_CACHE_MAX = 100;

function evictOldest(cache: Map<string, CachedSession>): void {
  if (cache.size >= SESSION_CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
}

// Keyed by the first 32 chars of the stored __client JWT
const sessionCache = new Map<string, CachedSession>();

function cacheKey(clientJwt: string): string {
  return clientJwt.slice(0, 32);
}

function cachedJwt(clientJwt: string): string | null {
  const entry = sessionCache.get(cacheKey(clientJwt));
  if (!entry) return null;
  // Keep a 30-second buffer before expiry
  if (Date.now() >= entry.jwtExpiresAt - 30_000) {
    sessionCache.delete(cacheKey(clientJwt));
    return null;
  }
  return entry.jwt;
}

function storeSession(clientJwt: string, sessionId: string, jwt: string, expMs: number): void {
  evictOldest(sessionCache);
  sessionCache.set(cacheKey(clientJwt), { sessionId, jwt, jwtExpiresAt: expMs });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractClientJwt(rawApiKey: string): string {
  // Users may paste the full "name=value" form or just the JWT value
  const trimmed = rawApiKey.trim();
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx > 0 && !trimmed.startsWith("eyJ")) {
    return trimmed.slice(eqIdx + 1).trim();
  }
  return trimmed;
}

/** Decode the exp claim from a JWT without verifying signature. */
function jwtExpMs(jwt: string): number {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error", code: `HTTP_${status}` } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

// ── Clerk auth flow ───────────────────────────────────────────────────────────

/** Step 1: GET /v1/client → returns active session ID. */
async function getSessionId(
  clientJwt: string,
  signal?: AbortSignal | null,
  log?: ExecuteInput["log"]
): Promise<string> {
  const resp = await fetch(`${ADAPTA_CLERK_URL}/v1/client`, {
    headers: {
      Cookie: `__client=${clientJwt}`,
      "User-Agent": USER_AGENT,
      Origin: ADAPTA_APP_URL,
    },
    signal: signal ?? undefined,
  });

  if (!resp.ok) {
    throw new Error(`Clerk /v1/client returned HTTP ${resp.status} — check your __client cookie`);
  }

  const body = await resp.json();
  const sessions: Array<{ id: string; status: string }> = body?.response?.sessions ?? [];
  const active = sessions.find((s) => s.status === "active");
  if (!active?.id) {
    throw new Error(
      "No active Clerk session found — your __client cookie may be expired or invalid"
    );
  }

  log?.info?.("ADAPTA-WEB", `Got session ID: ${active.id}`);
  return active.id;
}

/** Step 2: POST /v1/client/sessions/{id}/tokens → fresh short-lived JWT. */
async function refreshSessionJwt(
  clientJwt: string,
  sessionId: string,
  signal?: AbortSignal | null,
  log?: ExecuteInput["log"]
): Promise<string> {
  const resp = await fetch(`${ADAPTA_CLERK_URL}/v1/client/sessions/${sessionId}/tokens`, {
    method: "POST",
    headers: {
      Cookie: `__client=${clientJwt}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Origin: ADAPTA_APP_URL,
    },
    signal: signal ?? undefined,
  });

  if (!resp.ok) {
    throw new Error(`Clerk token refresh returned HTTP ${resp.status}`);
  }

  const body = await resp.json();
  const jwt = body?.jwt;
  if (typeof jwt !== "string" || !jwt.startsWith("eyJ")) {
    throw new Error("Clerk token refresh did not return a valid JWT");
  }

  log?.info?.("ADAPTA-WEB", `Got fresh session JWT (${jwt.length} chars)`);
  return jwt;
}

/** Returns a valid (non-expired) session JWT, refreshing if necessary. */
async function getSessionJwt(
  clientJwt: string,
  signal?: AbortSignal | null,
  log?: ExecuteInput["log"]
): Promise<string> {
  const cached = cachedJwt(clientJwt);
  if (cached) {
    log?.info?.("ADAPTA-WEB", "Using cached session JWT");
    return cached;
  }

  const sessionId = await getSessionId(clientJwt, signal, log);
  const jwt = await refreshSessionJwt(clientJwt, sessionId, signal, log);
  storeSession(clientJwt, sessionId, jwt, jwtExpMs(jwt) || Date.now() + 55_000);
  return jwt;
}

// ── Request/response translation ──────────────────────────────────────────────

interface OpenAIToolCallMsg {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role: string;
  content: unknown;
  tool_calls?: OpenAIToolCallMsg[];
  tool_call_id?: string;
  name?: string;
}

interface AdaptaPart {
  type: "text" | "step-start";
  text?: string;
  state?: string;
}

interface AdaptaMessage {
  id: string;
  role: string;
  parts: AdaptaPart[];
  metadata?: Record<string, unknown>;
  state?: string;
}

/**
 * Whether this request's Adapta chat should be created as temporary (not kept in the
 * user's agent.adapta.one web history). Defaults to `true`: an agentic client (OpenCode,
 * curl scripts, etc.) sends one Adapta chat per turn, and that conversation is already
 * persisted on the client's own side — there's no reason for it to also permanently
 * pollute the user's Adapta web UI. Opt back into persistent chats per request with
 * `provider_options.adapta.isTemporaryChat` (or the `adapta-web` id, matching the
 * `provider_options.<provider>` bag convention used by the search handlers).
 */
export function resolveIsTemporaryChat(bodyObj: Record<string, unknown>): boolean {
  const providerOptions = bodyObj.provider_options;
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    return true;
  }
  const bag =
    (providerOptions as Record<string, unknown>).adapta ??
    (providerOptions as Record<string, unknown>)["adapta-web"];
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return true;
  const override = (bag as Record<string, unknown>).isTemporaryChat;
  return typeof override === "boolean" ? override : true;
}

/** Extract plain text from an OpenAI message content (string or content-parts array). */
function extractText(content: unknown): string {
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
 * Render an assistant's tool_calls as `<tool>{...}</tool>` blocks — the same envelope
 * `translator/webTools.ts` teaches the model to emit — and fold them into its text so
 * a later history re-send still shows the model its own prior call.
 */
function renderAssistantToolCalls(toolCalls: OpenAIToolCallMsg[]): string[] {
  const lines: string[] = [];
  for (const tc of toolCalls) {
    const fnName = tc?.function?.name;
    if (!fnName) continue;
    const args = tc.function?.arguments ?? "{}";
    lines.push(`<tool>{"name":${JSON.stringify(fnName)},"arguments":${args}}</tool>`);
  }
  return lines;
}

/** Build the final Adapta messages array, injecting system prompt into first user message. */
export function buildAdaptaMessages(
  messages: OpenAIMessage[],
  modelKey: string,
  chatId: string
): AdaptaMessage[] {
  // Split system/developer content into "leading" (appears before the first real
  // turn — the client's own system prompt) and "trailing" (appears after the last
  // real turn — e.g. the <tool> contract `prepareToolMessages()` deliberately
  // appends LAST, see its docstring: prepending it loses to big system prompts).
  // Merging both into one blob glued onto turn 1 — the previous behavior — buried
  // the trailing tool contract inside a huge leading block for clients like
  // OpenCode whose system prompt runs tens of KB, so the model never reliably
  // saw it (#tool-contract-buried).
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
      if (idx > lastNonSystemIdx) {
        trailingSystemText += (trailingSystemText ? "\n" : "") + extractText(msg.content);
      } else {
        leadingSystemText += (leadingSystemText ? "\n" : "") + extractText(msg.content);
      }
    } else {
      rest.push(msg);
    }
  });

  // tool_call_id -> function name, so a later tool-result turn can be labeled
  // with which function produced it (Adapta has no native "tool" role/field).
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
    // Adapta's wire format only knows "user"/"assistant" roles. Previously a
    // role:"tool" message hit `continue` here and was silently dropped — the
    // model never saw its own tool result, so a follow-up turn re-derived the
    // same "no history" prompt and re-emitted the identical tool call forever.
    // Fold it into a user turn instead, labeled with the function that produced it.
    if (msg.role === "tool") {
      const text = extractText(msg.content).trim();
      if (!text) continue;
      const name = msg.name || callIdToName.get(String(msg.tool_call_id ?? "")) || "tool";
      const id = crypto.randomUUID();
      adapted.push({
        id,
        role: "user",
        parts: [{ type: "text", text: `[Tool result: ${name}]\n${text}` }],
      });
      continue;
    }

    if (msg.role !== "user" && msg.role !== "assistant") continue;
    let text = extractText(msg.content);

    // An assistant turn that only called a tool has `content: null` — extractText()
    // alone would collapse it to "", the second half of the same drop (#tool-exchange-dropped).
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const callLines = renderAssistantToolCalls(msg.tool_calls);
      text = [text.trim(), ...callLines].filter(Boolean).join("\n\n");
    }

    if (!text.trim() && msg.role !== "assistant") continue;

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

    if (!systemInjected && leadingSystemText && msg.role === "user") {
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
    // Always its own turn — the last thing the model reads before generating,
    // never merged into the leading system block or into the last real user query.
    adapted.push({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: trailingSystemText }],
    });
  }

  return adapted;
}

// ── SSE transform: Adapta → OpenAI ───────────────────────────────────────────

function transformStream(adaptaStream: ReadableStream, model: string): ReadableStream {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-adp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  let roleEmitted = false;

  return new ReadableStream({
    async start(controller) {
      const reader = adaptaStream.getReader();
      let buffer = "";

      const emit = (obj: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      const chunk = (delta: object, finish?: string) =>
        emit({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        });

      const ensureRole = () => {
        if (!roleEmitted) {
          roleEmitted = true;
          chunk({ role: "assistant", content: "" });
        }
      };

      const finalize = () => {
        ensureRole();
        chunk({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }

            const type = event.type as string;

            if (type === "text-delta") {
              const delta = event.delta as string;
              // Suppress the "quick-response" loading placeholder
              if (event.id === "quick-response") continue;
              if (typeof delta === "string" && delta.length > 0) {
                ensureRole();
                chunk({ content: delta });
              }
            } else if (type === "text-end") {
              if (event.id === "quick-response") continue;
              // Real text ended — stream will send more events or close
            } else if (type === "error") {
              ensureRole();
              // Keep upstream diagnostics private: the transformed SSE is a public HTTP 200 body.
              chunk({ content: ADAPTA_PUBLIC_STREAM_ERROR });
              finalize();
              return;
            } else if (type === "done" || type === "end" || type === "finish") {
              finalize();
              return;
            }
          }
        }
      } catch {
        // Stream aborted or network error — emit what we have
      }

      finalize();
    },
  });
}

// ── Executor ──────────────────────────────────────────────────────────────────

export class AdaptaWebExecutor extends BaseExecutor {
  constructor() {
    super("adapta-web", { baseUrl: ADAPTA_STREAM_URL });
  }

  async testConnection(
    credentials: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const rawKey = String((credentials as Record<string, unknown>)?.apiKey ?? "");
      if (!rawKey) return false;
      const clientJwt = extractClientJwt(rawKey);
      const sessionId = await getSessionId(clientJwt, signal);
      return !!sessionId;
    } catch {
      return false;
    }
  }

  async execute({ model, body, stream, credentials, signal, log }: ExecuteInput) {
    const bodyObj = (body ?? {}) as Record<string, unknown>;
    const messages = (Array.isArray(bodyObj.messages) ? bodyObj.messages : []) as OpenAIMessage[];
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(bodyObj, messages);

    // 1. Extract and validate credentials
    const rawKey = String((credentials as Record<string, unknown>)?.apiKey ?? "");
    if (!rawKey) {
      return {
        response: makeErrorResponse(
          401,
          "Missing Adapta credentials — paste your __client cookie from .clerk.agent.adapta.one"
        ),
        url: ADAPTA_STREAM_URL,
        headers: {},
        transformedBody: body,
      };
    }
    const clientJwt = extractClientJwt(rawKey);

    let sessionJwt: string;
    try {
      log?.info?.("ADAPTA-WEB", "Obtaining session JWT via Clerk...");
      sessionJwt = await getSessionJwt(clientJwt, signal, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn?.("ADAPTA-WEB", `Auth failed: ${msg}`);
      return {
        response: makeErrorResponse(401, `Adapta auth failed: ${sanitizeErrorMessage(msg)}`),
        url: ADAPTA_STREAM_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // 2. Build Adapta request body
    const modelKey = MODEL_KEY_MAP[model] ?? DEFAULT_MODEL_KEY;
    const chatId = crypto.randomUUID();
    const adaptaMessages = buildAdaptaMessages(effectiveMessages, modelKey, chatId);

    if (adaptaMessages.length === 0) {
      return {
        response: makeErrorResponse(400, "No messages provided"),
        url: ADAPTA_STREAM_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const requestPayload = {
      chatId,
      id: chatId,
      isTemporaryChat: resolveIsTemporaryChat(bodyObj),
      mandatoryTools: [],
      skipImagePromptOptimization: true,
      modelAi: modelKey,
      trigger: "submit-message",
      messages: adaptaMessages,
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${sessionJwt}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": USER_AGENT,
      Origin: ADAPTA_APP_URL,
      Referer: `${ADAPTA_APP_URL}/agentic-chat`,
    };

    log?.info?.(
      "ADAPTA-WEB",
      `POST ${ADAPTA_STREAM_URL} | model=${model} modelAi=${modelKey} msgs=${adaptaMessages.length}`
    );

    // 3. Fire request
    //
    // #adapta-refusal-retry: a tool-aware call to Adapta succeeds only ~40-70% of the
    // time — the failure mode is a plain-text refusal instead of a <tool> block, which
    // used to be returned to the client as if it were a final answer, stalling the
    // agentic loop. When tools are in play, a refused reply is therefore retried
    // upstream (bounded), because the upstream is non-deterministic and asking again
    // usually just works.
    const fireRequest = async (): Promise<Response> =>
      fetch(ADAPTA_STREAM_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal: signal ?? undefined,
      });

    /** Drain an upstream SSE response down to its concatenated text. */
    const collectText = async (
      body: ReadableStream
    ): Promise<{ text: string; error: string | null }> => {
      const decoder = new TextDecoder();
      const reader = body.getReader();
      let buf = "";
      let fullText = "";
      let upstreamErrorMessage: string | null = null;

      try {
        readLoop: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "text-delta" && ev.id !== "quick-response") {
                fullText += String(ev.delta ?? "");
              } else if (ev.type === "error") {
                upstreamErrorMessage = "Adapta upstream error";
                break readLoop;
              }
            } catch {
              // skip
            }
          }
        }
      } finally {
        if (upstreamErrorMessage) {
          void reader.cancel("Adapta upstream SSE error").catch(() => undefined);
        }
        reader.releaseLock();
      }

      return { text: fullText, error: upstreamErrorMessage };
    };

    const resp = await fireRequest();

    if (!resp.ok) {
      let errMsg = `Adapta error HTTP ${resp.status}`;
      if (resp.status === 401 || resp.status === 403) {
        errMsg =
          "Adapta session expired or invalid — re-paste your __client cookie from .clerk.agent.adapta.one";
        // Evict cached JWT so next request re-authenticates
        sessionCache.delete(cacheKey(clientJwt));
      } else if (resp.status === 429) {
        errMsg = "Adapta rate limited — wait and retry";
      }
      log?.warn?.("ADAPTA-WEB", errMsg);
      return {
        response: makeErrorResponse(resp.status, errMsg),
        url: ADAPTA_STREAM_URL,
        headers,
        transformedBody: requestPayload,
      };
    }

    // 4. Stream or collect.
    // Real token-by-token streaming is only safe when no tools are requested: Adapta has
    // no native tool calling, so a tool-aware reply arrives as a literal `<tool>{...}</tool>`
    // envelope in the text. Streaming that straight through (the previous behavior) leaked
    // the raw envelope to the client as visible assistant prose with finish_reason "stop" —
    // it never became `tool_calls`, so agentic clients (OpenCode defaults to streaming
    // requests) saw a fake "I called the tool" narration that never actually ran anything
    // (#tool-leak-raw-text). Buffer the full reply first whenever tools are in play, parse
    // it with buildToolAwareResult()/buildToolModeResponse(), THEN replay it as a single
    // terminal SSE chunk if the client asked for streaming — mirroring the established
    // chatgptWebTools.ts pattern already used by gemini-web.ts, maxai.ts, uc.ts, etc.
    if (!hasTools && stream !== false) {
      return {
        response: new Response(transformStream(resp.body!, model), {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        url: ADAPTA_STREAM_URL,
        headers,
        transformedBody: requestPayload,
      };
    }

    // Collect all text-delta events (used for: non-streaming requests, and any
    // tool-aware request regardless of its requested stream mode).
    let collected = await collectText(resp.body!);

    if (collected.error) {
      return {
        response: new Response(JSON.stringify(buildErrorBody(502, collected.error)), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
        url: ADAPTA_STREAM_URL,
        headers,
        transformedBody: requestPayload,
      };
    }

    if (hasTools) {
      // Retry loop for a refused tool-aware reply. A refusal is detected on the RAW text
      // (before parsing): a reply that refuses produced no <tool> block at all, so there is
      // nothing for the parser to recover. A legitimate final answer (the model really
      // answered, no tool needed) is NOT a refusal and must never be retried — retrying it
      // would burn an upstream call and could replace a correct answer with a worse one.
      let fullText = collected.text;
      let attempts = 0;
      while (attempts < ADAPTA_MAX_REFUSAL_RETRIES && looksLikeToolRefusal(fullText)) {
        attempts += 1;
        log?.warn?.(
          "ADAPTA-WEB",
          `Tool-aware reply refused (attempt ${attempts}/${ADAPTA_MAX_REFUSAL_RETRIES}) — retrying upstream`
        );
        const retryResp = await fireRequest();
        if (!retryResp.ok) {
          // An HTTP-level failure on retry is surfaced as-is rather than silently
          // degrading to the refused text the client already rejected.
          log?.warn?.("ADAPTA-WEB", `Adapta retry failed with HTTP ${retryResp.status}`);
          return {
            response: makeErrorResponse(retryResp.status, `Adapta error HTTP ${retryResp.status}`),
            url: ADAPTA_STREAM_URL,
            headers,
            transformedBody: requestPayload,
          };
        }
        const retryCollected = await collectText(retryResp.body!);
        if (retryCollected.error) {
          return {
            response: new Response(JSON.stringify(buildErrorBody(502, retryCollected.error)), {
              status: 502,
              headers: { "Content-Type": "application/json" },
            }),
            url: ADAPTA_STREAM_URL,
            headers,
            transformedBody: requestPayload,
          };
        }
        fullText = retryCollected.text;
      }

      const bufferedJson = new Response(
        JSON.stringify({
          id: `chatcmpl-adp-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
      return {
        response: await buildToolModeResponse(bufferedJson, requestedTools, stream !== false, {
          cid: `chatcmpl-adp-${Date.now()}`,
          created: Math.floor(Date.now() / 1000),
          model,
          idSeed: "adp",
        }),
        url: ADAPTA_STREAM_URL,
        headers,
        transformedBody: requestPayload,
      };
    }

    return {
      response: new Response(
        JSON.stringify({
          id: `chatcmpl-adp-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: collected.text },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
      url: ADAPTA_STREAM_URL,
      headers,
      transformedBody: requestPayload,
    };
  }
}
