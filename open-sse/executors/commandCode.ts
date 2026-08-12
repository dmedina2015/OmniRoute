import { randomUUID } from "node:crypto";

import { isVisionModelId } from "@/shared/constants/visionModels";
import { REGISTRY } from "../config/providerRegistry.ts";
import { BaseExecutor, mergeUpstreamExtraHeaders, type ExecuteInput } from "./base.ts";

type JsonRecord = Record<string, unknown>;

export const COMMAND_CODE_VERSION = process.env.COMMAND_CODE_VERSION?.trim() || "1.15.1";
// Hard server-side ceiling enforced by Command Code's /alpha/generate endpoint:
// any request with params.max_tokens > 200_000 is rejected with a 400
// "Too big: expected number to be <=200000 at params.max_tokens". We only use
// this to clamp a CLIENT-SUPPLIED max_tokens down to a value the endpoint will
// accept; we never fabricate this number for requests that omit the field (see
// clampMaxTokens / buildCommandCodeBody).
const MAX_COMMAND_CODE_TOKENS = 200_000;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordOrEmpty(value: unknown): JsonRecord {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch (error) {
      console.warn(
        "[commandCode] tool arg parse failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return {};
}

/**
 * Build the `arguments` field for an assistant tool-call part that Command
 * Code's /alpha/generate schema REQUIRES (rejects a missing field with
 * `missing required field 'arguments'`). Valid source values round-trip:
 *   - object arguments  -> JSON string of the object
 *   - valid JSON string arguments -> the string as-is
 *   - missing / empty / invalid JSON string -> "{}" (a valid empty-object string)
 */
function toolCallArgumentsString(value: unknown): string {
  if (isRecord(value)) return JSON.stringify(value);
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return value;
    } catch {
      return "{}";
    }
    return "{}";
  }
  return JSON.stringify(recordOrEmpty(value));
}

/**
 * Tool names that collide with Command Code's server-side built-in tools.
 * The /alpha/generate server normalizes tool-call/tool-result parts against
 * ITS OWN built-in registry for matching names; for its built-in `tool_search`
 * the result normalization requires `arguments` in a shape we do not send, so
 * the result is rejected with `input[N] missing required field 'arguments'`
 * (verified live 2026-08-10 — renaming the call/result `tool_search` → `grep`
 * makes the identical request pass; the server pairs each tool-result with the
 * nearest preceding tool-call, so any result following such a call is affected).
 * We rename the colliding name consistently on the wire — definitions, calls
 * and results — then un-rename on the response path so the client still sees
 * its original tool names.
 */
const COMMAND_CODE_RESERVED_TOOL_NAMES = new Set(["tool_search"]);

function wireToolName(clientName: string, toolNameMap: Map<string, string>): string {
  if (COMMAND_CODE_RESERVED_TOOL_NAMES.has(clientName)) {
    const wire = `omniroute_${clientName}`;
    toolNameMap.set(wire, clientName);
    return wire;
  }
  return clientName;
}

function clientToolName(wireName: string, toolNameMap: Map<string, string>): string {
  return toolNameMap.get(wireName) ?? wireName;
}

function normalizeContentText(content: unknown): string {
  if (typeof content === "string") return content;
  return asRecordArray(content)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) || "")
    .join("\n");
}

/**
 * Model id patterns for Command Code models that have `text, vision`
 * capability per the official CC model registry, but are NOT caught
 * by the shared {@link isVisionModelId} heuristic. Kept as a local
 * set because these are CC-specific model IDs (vendor-prefix shapes
 * like "moonshotai/Kimi-K2.6" or CC aliases like "gpt-5.6-luna").
 *
 * Source: Command Code /alpha/generate model registry (docs).
 */
const CC_VISION_MODEL_PATTERNS: readonly RegExp[] = [
  // Open Source
  /kimi-k2/i, // moonshotai/Kimi-K2.6, Kimi-K2.7-Code, Kimi-K2.5
  /qwen3\.\d/i, // Qwen/Qwen3.6-Plus, Qwen/Qwen3.7-Plus
  /step-?3/i, // stepfun/Step-3.7-Flash
  // Anthropic
  /claude-fable/i, // claude-fable-5 (not covered by claude-opus/sonnet/haiku-4)
  // OpenAI
  /gpt-5/i, // gpt-5.6, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex
  // NOTE: gpt-5.4-mini and gpt-5.3-codex deliberately stay inside the `/gpt-5/`
  // family — both accept image input on the OpenAI API, and there is no
  // verified Command Code backend data marking them text-only. Excluding them
  // without evidence would re-create #4071 (image stripped from a model that
  // can see it). Revisit only with per-model CC registry capability data.
  // Sakana
  /fugu/i, // sakana/fugu-ultra
];

/**
 * Whether a model id routed through the Command Code executor is
 * vision-capable. Checks Mimo-specific rules first, then CC-specific
 * patterns, then falls through to the shared {@link isVisionModelId}
 * heuristic (which covers minimax-m3, claude-3/4 families, gemini,
 * gpt-4o/4.1, mistral-medium-3, and general "-vision" / "multimodal").
 */
function isCommandCodeVisionModel(model?: string | null): boolean {
  if (!model) return false;
  // mimo-v2.5-pro is text-only — exclude before any positive check
  if (/(?:^|\/)mimo-v2\.5-pro$/i.test(model)) return false;
  // Only mimo-v2.5 and mimo-v2-omni accept images per Xiaomi vendor docs
  if (/(?:^|\/)mimo-v2\.5$/i.test(model)) return true;
  if (/(?:^|\/)mimo-v2-omni$/i.test(model)) return true;
  // CC-specific patterns: Kimi K2, Qwen 3.x, Stepfun, Claude Fable,
  // GPT-5, Sakana Fugu — not covered by the shared heuristic
  if (CC_VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model))) return true;
  // Fall through: minimax-m3, claude-3/4, gemini-2/3, gpt-4o, -vision, multimodal
  return isVisionModelId(model);
}

/**
 * Extract the image URL from an OpenAI-compatible or Command Code
 * content part, returning undefined for non-image parts.
 *
 * OpenAI-compatible:  { type: "image_url", image_url: { url: "..." } }
 * Command Code CLI:   { type: "image", image: "..." }
 * AI SDK image:       { type: "image", image: "data:...;base64,..." } (#1330)
 * Anthropic image:    { type: "image", source: { type: "base64", media_type, data } }
 *                     or { type: "image", source: { type: "url", url } }
 *
 * The Anthropic-shaped block is common for Claude-Code-compatible clients
 * (e.g. Zoo Code) that send Messages-style content arrays to the
 * OpenAI `/v1/chat/completions` surface. Without this branch the image was
 * silently dropped before reaching the upstream vision model.
 */
function extractImageUrl(part: JsonRecord): string | undefined {
  if (part.type === "image") {
    const direct = stringValue(part.image);
    if (direct) return direct;

    // Anthropic source block: { source: { type: "base64", media_type, data } } or
    // { source: { type: "url", url } }.
    const source = isRecord(part.source) ? part.source : null;
    if (source) {
      if (source.type === "base64") {
        const mediaType = stringValue(source.media_type) || "image/png";
        const data = stringValue(source.data);
        if (data) return `data:${mediaType};base64,${data}`;
      }
      if (source.type === "url") {
        const url = stringValue(source.url);
        if (url) return url;
      }
    }
    return undefined;
  }
  if (part.type === "image_url") {
    if (isRecord(part.image_url)) return stringValue(part.image_url.url);
    return stringValue(part.image_url);
  }
  return undefined;
}

/**
 * Convert an OpenAI-format content array to Command Code's internal
 * CLI format. For vision-capable models (MiniMax M3, MiMo v2.5, etc.)
 * this also preserves image parts alongside text.
 */
function convertUserContentParts(content: unknown, isVisionModel: boolean): string | unknown[] {
  // For non-vision models or string content, extract text only.
  if (!isVisionModel || typeof content === "string") {
    return normalizeContentText(content);
  }

  const parts: unknown[] = [];
  for (const part of asRecordArray(content)) {
    if (part.type === "text") {
      const text = stringValue(part.text);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    const imgUrl = extractImageUrl(part);
    if (imgUrl) {
      parts.push({ type: "image", image: imgUrl });
      continue;
    }
    // Always drop tool_use / tool_result / thinking parts from user
    // messages (Command Code doesn't accept them for role:"user").
  }

  // When every part was stripped, fall back to empty text so the
  // message is still valid JSON (Command Code rejects empty content).
  if (parts.length === 0) parts.push({ type: "text", text: "" });

  return parts;
}

function convertTools(tools: unknown, toolNameMap: Map<string, string>): unknown[] {
  return asRecordArray(tools).map((tool) => {
    const fn = isRecord(tool.function) ? tool.function : tool;
    return {
      type: "function",
      name: wireToolName(stringValue(fn.name) || "", toolNameMap),
      description: stringValue(fn.description) || "",
      input_schema: isRecord(fn.parameters) ? fn.parameters : {},
    };
  });
}

function buildToolCallMetadata(
  messages: JsonRecord[],
  toolNameMap: Map<string, string>
): {
  pairedToolCallIds: Set<string>;
  toolCallNames: Map<string, string>;
  toolCallArgs: Map<string, string>;
} {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  const toolCallNames = new Map<string, string>();
  const toolCallArgs = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of asRecordArray(message.tool_calls)) {
        const id = stringValue(call.id);
        if (id) {
          callIds.add(id);
          const fn = isRecord(call.function) ? call.function : {};
          const name = stringValue(fn.name) || stringValue(call.name);
          if (name) toolCallNames.set(id, wireToolName(name, toolNameMap));
          toolCallArgs.set(id, toolCallArgumentsString(fn.arguments));
        }
      }
    } else if (message.role === "tool") {
      const id = stringValue(message.tool_call_id);
      if (id) resultIds.add(id);
    }
  }

  const pairedToolCallIds = new Set([...callIds].filter((id) => resultIds.has(id)));
  return { pairedToolCallIds, toolCallNames, toolCallArgs };
}

function convertMessages(
  messages: unknown,
  model?: string | null,
  toolNameMap?: Map<string, string>
): { system: string; messages: unknown[] } {
  const source = asRecordArray(messages);
  const { pairedToolCallIds, toolCallNames, toolCallArgs } = buildToolCallMetadata(
    source,
    toolNameMap ?? new Map<string, string>()
  );
  const out: unknown[] = [];
  const system: string[] = [];
  const isVision = isCommandCodeVisionModel(model);

  for (const message of source) {
    const role = stringValue(message.role);
    if (role === "system" || role === "developer") {
      const text = normalizeContentText(message.content);
      if (text) system.push(text);
      continue;
    }

    if (role === "user") {
      out.push({ role: "user", content: convertUserContentParts(message.content, isVision) });
      continue;
    }

    if (role === "assistant") {
      const parts: unknown[] = [];
      const text = normalizeContentText(message.content);
      if (text) parts.push({ type: "text", text });

      for (const call of asRecordArray(message.tool_calls)) {
        const id = stringValue(call.id) || "";
        if (!id || !pairedToolCallIds.has(id)) continue;
        const fn = isRecord(call.function) ? call.function : {};
        const parsedInput = recordOrEmpty(fn.arguments);
        parts.push({
          type: "tool-call",
          toolCallId: id,
          toolName: wireToolName(
            stringValue(fn.name) || stringValue(call.name) || "unknown",
            toolNameMap ?? new Map<string, string>()
          ),
          input: parsedInput,
          // /alpha/generate requires this field on assistant tool-call parts;
          // a missing one is rejected with `missing required field 'arguments'`.
          arguments: toolCallArgumentsString(fn.arguments),
        });
      }

      if (parts.length > 0) out.push({ role: "assistant", content: parts });
      continue;
    }

    if (role === "tool") {
      const toolCallId = stringValue(message.tool_call_id) || "";
      if (!toolCallId || !pairedToolCallIds.has(toolCallId)) continue;
      const toolName = wireToolName(
        stringValue(message.name) || toolCallNames.get(toolCallId) || "unknown",
        toolNameMap ?? new Map<string, string>()
      );
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName,
            // /alpha/generate requires `arguments` here too (same rejection as
            // tool-call parts); echo the paired call's args, defensively "{}".
            arguments: toolCallArgs.get(toolCallId) ?? "{}",
            output: { type: "text", value: normalizeContentText(message.content) },
          },
        ],
      });
    }
  }

  return { system: system.join("\n\n"), messages: out };
}

// Clamp a client-supplied max_tokens to the endpoint ceiling, mirroring the
// provider-driven clamp in antigravity.ts: we only intervene when the value is
// present, positive AND would otherwise be rejected (> 200_000). A valid value
// is returned floored; anything absent, non-numeric or non-positive returns
// undefined so the caller can OMIT the field entirely and let Command Code's
// upstream apply the model's own native default (rather than us inventing a
// number). A non-positive value such as Zoo Code's max_tokens:-1 ("let the
// server choose") must be omitted, NOT forced to 1 — the old Math.max(1,...)
// truncated output to a single token (#5166).
function clampMaxTokens(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return Math.min(Math.floor(numeric), MAX_COMMAND_CODE_TOKENS);
}

// Reasoning/thinking fields that payload rules or clients may inject and that
// CommandCode's upstream accepts inside `params`. Without this pass-through,
// payload-rule overrides on these fields are silently dropped (#2986 follow-up).
const COMMAND_CODE_PASSTHROUGH_FIELDS = [
  "reasoning_effort",
  "reasoning",
  "thinking",
  "effort",
  "output_config",
  "extra_body",
] as const;

function buildCommandCodeBody(
  model: string,
  body: unknown,
  stream = false
): { body: JsonRecord; toolNameMap: Map<string, string> } {
  const input = isRecord(body) ? body : {};
  const toolNameMap = new Map<string, string>();

  // Payload rules may rewrite `body.model` (e.g. deepseek-v4-pro-max →
  // deepseek/deepseek-v4-pro for the command-code provider). Prefer the
  // rewritten value if present; fall back to the resolved combo model arg.
  const resolvedModel =
    typeof input.model === "string" && input.model.trim().length > 0 ? input.model : model;

  const converted = convertMessages(input.messages, resolvedModel, toolNameMap);
  const explicitSystem = typeof input.system === "string" ? input.system : "";
  const system = [converted.system, explicitSystem].filter(Boolean).join("\n\n");

  const params: JsonRecord = {
    model: resolvedModel,
    messages: converted.messages,
    tools: convertTools(input.tools, toolNameMap),
    system,
    stream: true,
  };

  // Only forward max_tokens when the client actually supplied one. Omitting it
  // lets Command Code's upstream apply the model's own native default, so we
  // never invent a value (the old behavior, which sent the wrong number and got
  // DeepSeek V4 rejected with "Too big: expected number to be <=200000"). When
  // present, it is clamped to the endpoint ceiling so an oversized client value
  // degrades gracefully instead of 400ing.
  const maxTokens = clampMaxTokens(input.max_tokens ?? input.max_completion_tokens);
  if (maxTokens !== undefined) {
    params.max_tokens = maxTokens;
  }

  for (const field of COMMAND_CODE_PASSTHROUGH_FIELDS) {
    const value = input[field];
    if (value !== undefined && value !== null) {
      params[field] = value;
    }
  }

  return {
    body: {
      config: {
        workingDir: "/workspace",
        date: new Date().toISOString().slice(0, 10),
        environment: "external",
        structure: [],
        isGitRepo: false,
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
      memory: "",
      taste: "",
      skills: "",
      permissionMode: "standard",
      params,
    },
    toolNameMap,
  };
}

function parseStreamLine(line: string): unknown | undefined {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === "[DONE]") return undefined;

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn(
      "[commandCode] stream line parse failed:",
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
}

function mapFinishReason(reason: unknown): "stop" | "length" | "tool_calls" {
  if (reason === "tool-calls" || reason === "tool_calls" || reason === "toolUse")
    return "tool_calls";
  if (
    reason === "length" ||
    reason === "max_tokens" ||
    reason === "max-tokens" ||
    reason === "max_output_tokens"
  ) {
    return "length";
  }
  return "stop";
}

function chatCompletionChunk(
  id: string,
  model: string,
  delta: JsonRecord,
  finishReason: unknown = null
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

type AggregateState = {
  content: string;
  reasoning: string;
  toolCalls: JsonRecord[];
  finishReason: "stop" | "length" | "tool_calls";
  usage: JsonRecord | null;
};

function firstRecord(record: JsonRecord, keys: readonly string[]): JsonRecord {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  return {};
}

function firstNumber(record: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Keep earlier finish-step usage when the terminal finish event omits it. */
function mergeCommandCodeUsage(previous: JsonRecord | null, next: unknown): JsonRecord | null {
  if (!isRecord(next)) return previous;

  const merged: JsonRecord = { ...(previous || {}), ...next };
  for (const key of [
    "inputTokenDetails",
    "input_token_details",
    "input_tokens_details",
    "prompt_tokens_details",
    "outputTokenDetails",
    "output_token_details",
    "output_tokens_details",
    "completion_tokens_details",
    "reasoningTokenDetails",
    "reasoning_token_details",
  ]) {
    const before = isRecord(previous?.[key]) ? previous[key] : {};
    const after = isRecord(next[key]) ? next[key] : {};
    if (Object.keys(before).length > 0 || Object.keys(after).length > 0) {
      merged[key] = { ...before, ...after };
    }
  }
  return merged;
}

function rememberCommandCodeUsage(state: AggregateState, event: JsonRecord): void {
  const usage =
    event.type === "finish-step"
      ? (event.usage ?? event.totalUsage)
      : (event.totalUsage ?? event.usage);
  state.usage = mergeCommandCodeUsage(state.usage, usage);
}

function applyEventToAggregate(
  event: JsonRecord,
  state: AggregateState,
  toolNameMap: Map<string, string>
): void {
  // Some Command Code protocol revisions attach usage to the terminal payload
  // without preserving the event type. Capture it before event-specific handling.
  rememberCommandCodeUsage(state, event);

  switch (event.type) {
    case "text-delta":
      state.content += stringValue(event.text) || "";
      break;
    case "reasoning-delta":
      state.reasoning += stringValue(event.text) || "";
      break;
    case "tool-call": {
      const args = recordOrEmpty(event.input ?? event.args ?? event.arguments);
      state.toolCalls.push({
        id: stringValue(event.toolCallId) || stringValue(event.id) || randomUUID(),
        type: "function",
        function: {
          name: clientToolName(
            stringValue(event.toolName) || stringValue(event.name) || "",
            toolNameMap
          ),
          arguments: JSON.stringify(args),
        },
      });
      break;
    }
    case "finish-step":
      break;
    case "finish":
      state.finishReason = mapFinishReason(event.finishReason);
      break;
  }
}

function applyEventToAggregateOrThrow(
  event: JsonRecord,
  state: AggregateState,
  toolNameMap: Map<string, string>
): void {
  if (event.type === "error") {
    const error = isRecord(event.error) ? event.error : {};
    throw new Error(
      stringValue(error.message) || stringValue(event.error) || "Command Code stream error"
    );
  }

  applyEventToAggregate(event, state, toolNameMap);
}

function usageFromCommandCode(usage: JsonRecord | null) {
  if (!usage) return undefined;
  const inputDetails = firstRecord(usage, [
    "inputTokenDetails",
    "input_token_details",
    "input_tokens_details",
    "prompt_tokens_details",
  ]);
  const outputDetails = firstRecord(usage, [
    "outputTokenDetails",
    "output_token_details",
    "output_tokens_details",
    "completion_tokens_details",
  ]);
  const reasoningDetails = firstRecord(usage, [
    "reasoningTokenDetails",
    "reasoning_token_details",
    "reasoning_tokens_details",
  ]);
  const cacheRead =
    firstNumber(usage, [
      "cachedInputTokens",
      "cached_input_tokens",
      "cacheReadInputTokens",
      "cache_read_input_tokens",
      "cacheReadTokens",
      "cache_read_tokens",
      "cached_tokens",
    ]) ??
    firstNumber(inputDetails, [
      "cachedTokens",
      "cached_tokens",
      "cacheReadTokens",
      "cache_read_tokens",
    ]);
  const noCache = firstNumber(inputDetails, ["noCacheTokens", "no_cache_tokens"]);
  // Command Code's totalUsage.inputTokens is the FULL prompt total and already
  // includes the cached portion (noCacheTokens + cacheReadTokens = inputTokens),
  // so we must NOT add cacheRead back — that would double-count. There is no
  // cache-write field in the upstream payload, so cache creation stays unset.
  const prompt =
    firstNumber(usage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]) ??
    (noCache ?? 0) + (cacheRead ?? 0);
  const reasoning =
    firstNumber(usage, ["reasoningTokens", "reasoning_tokens"]) ??
    firstNumber(outputDetails, ["reasoningTokens", "reasoning_tokens"]) ??
    firstNumber(reasoningDetails, ["reasoningTokens", "reasoning_tokens"]);
  const textOutput = firstNumber(outputDetails, ["textTokens", "text_tokens"]);
  const completion =
    firstNumber(usage, [
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
    ]) ?? (textOutput ?? 0) + (reasoning ?? 0);
  const total = firstNumber(usage, ["totalTokens", "total_tokens"]) ?? prompt + completion;
  const result: JsonRecord = {
    prompt_tokens: prompt,
    prompt_tokens_details: { cached_tokens: cacheRead ?? 0 },
    completion_tokens: completion,
    completion_tokens_details: { reasoning_tokens: reasoning ?? 0 },
    total_tokens: total,
  };
  // Surface the cache breakdown as informational fields so logUsage prints
  // `| cache_read=X | no_cache=Y` and appendRequestLog persists them. These are
  // NOT added to prompt_tokens (already included) — metering stays accurate.
  if (cacheRead !== undefined && cacheRead > 0) result.cache_read_input_tokens = cacheRead;
  if (noCache !== undefined && noCache > 0) result.no_cache_tokens = noCache;
  if (reasoning !== undefined && reasoning > 0) result.reasoning_tokens = reasoning;
  return result;
}

function createStreamResponse(
  upstream: Response,
  model: string,
  signal?: AbortSignal | null,
  toolNameMap: Map<string, string> = new Map()
): Response {
  const id = `chatcmpl-${randomUUID()}`;
  const reader = upstream.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sentRole = false;
  let closed = false;
  const state: AggregateState = {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!reader) {
        controller.error(new Error("Command Code response missing body"));
        return;
      }

      const abort = () => {
        closed = true;
        reader.cancel().catch(() => undefined);
        controller.error(new DOMException("The operation was aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });

      const emitEvent = (event: unknown) => {
        if (!isRecord(event) || closed) return;
        rememberCommandCodeUsage(state, event);
        if (!sentRole) {
          sentRole = true;
          controller.enqueue(sse(chatCompletionChunk(id, model, { role: "assistant" })));
        }

        switch (event.type) {
          case "text-delta": {
            const text = stringValue(event.text) || "";
            if (text) controller.enqueue(sse(chatCompletionChunk(id, model, { content: text })));
            state.content += text;
            break;
          }
          case "reasoning-delta": {
            const text = stringValue(event.text) || "";
            if (text) {
              controller.enqueue(sse(chatCompletionChunk(id, model, { reasoning_content: text })));
              state.reasoning += text;
            }
            break;
          }
          case "tool-call": {
            const index = state.toolCalls.length;
            const args = recordOrEmpty(event.input ?? event.args ?? event.arguments);
            const toolCall = {
              id: stringValue(event.toolCallId) || stringValue(event.id) || randomUUID(),
              type: "function",
              function: {
                name: clientToolName(
                  stringValue(event.toolName) || stringValue(event.name) || "",
                  toolNameMap
                ),
                arguments: JSON.stringify(args),
              },
            };
            state.toolCalls.push(toolCall);
            controller.enqueue(
              sse(chatCompletionChunk(id, model, { tool_calls: [{ index, ...toolCall }] }))
            );
            break;
          }
          case "reasoning-end":
            break;
          case "finish-step":
            break;
          case "finish": {
            state.finishReason = mapFinishReason(event.finishReason);
            controller.enqueue(sse(chatCompletionChunk(id, model, {}, state.finishReason)));
            // Emit a standards-compliant usage-only chunk (choices: []) before
            // [DONE] when upstream reported usage. stream.ts's extractUsage
            // recognizes this shape (see stream.ts:1661) and logs the ACTUAL
            // token counts (in/out/cache_read/no_cache) instead of estimates.
            const usagePayload = usageFromCommandCode(state.usage);
            if (usagePayload) {
              controller.enqueue(
                sse({
                  id,
                  object: "chat.completion.chunk",
                  model,
                  usage: usagePayload,
                  choices: [],
                })
              );
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            closed = true;
            controller.close();
            reader.cancel().catch(() => undefined);
            break;
          }
          case "error": {
            const error = isRecord(event.error) ? event.error : {};
            throw new Error(
              stringValue(error.message) || stringValue(event.error) || "Command Code stream error"
            );
          }
        }
      };

      const pump = async () => {
        try {
          for (;;) {
            if (closed) return;
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) emitEvent(parseStreamLine(line));
          }
          if (buffer.trim()) emitEvent(parseStreamLine(buffer));
          if (!closed) {
            if (!sentRole)
              controller.enqueue(sse(chatCompletionChunk(id, model, { role: "assistant" })));
            controller.enqueue(sse(chatCompletionChunk(id, model, {}, state.finishReason)));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        } catch (error) {
          controller.error(error);
        } finally {
          signal?.removeEventListener("abort", abort);
          try {
            reader.releaseLock();
          } catch (error) {
            console.warn(
              "[commandCode] reader releaseLock failed:",
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      };

      pump();
    },
    cancel() {
      closed = true;
      return reader?.cancel();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

async function createJsonResponse(
  upstream: Response,
  model: string,
  signal?: AbortSignal | null,
  toolNameMap: Map<string, string> = new Map()
): Promise<Response> {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Command Code response missing body");

  const decoder = new TextDecoder();
  let buffer = "";
  const state: AggregateState = {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
  };

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseStreamLine(line);
        if (!isRecord(event)) continue;
        applyEventToAggregateOrThrow(event, state, toolNameMap);
      }
    }
    if (buffer.trim()) {
      const event = parseStreamLine(buffer);
      if (isRecord(event)) applyEventToAggregateOrThrow(event, state, toolNameMap);
    }
  } finally {
    try {
      await reader.cancel();
    } catch (error) {
      console.warn(
        "[commandCode] reader cancel failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      reader.releaseLock();
    } catch (error) {
      console.warn(
        "[commandCode] reader releaseLock failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const message: JsonRecord = { role: "assistant", content: state.content };
  if (state.reasoning) message.reasoning_content = state.reasoning;
  if (state.toolCalls.length > 0) message.tool_calls = state.toolCalls;

  const payload: JsonRecord = {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: state.finishReason }],
  };
  const usage = usageFromCommandCode(state.usage);
  if (usage) payload.usage = usage;

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export class CommandCodeExecutor extends BaseExecutor {
  constructor(provider = "command-code") {
    super(provider, REGISTRY["command-code"]);
  }

  buildUrl() {
    const baseUrl = (this.config.baseUrl || "https://api.commandcode.ai").replace(/\/$/, "");
    return `${baseUrl}${this.config.chatPath || "/alpha/generate"}`;
  }

  async execute({ model, body, stream, credentials, signal, upstreamExtraHeaders }: ExecuteInput) {
    const apiKey = credentials?.apiKey || credentials?.accessToken;
    if (!apiKey) throw new Error("Command Code API key required");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-command-code-version": COMMAND_CODE_VERSION,
      "x-cli-environment": "external",
      "x-project-slug": "pi-cc",
      "x-taste-learning": "false",
      "x-co-flag": "false",
      "x-session-id": randomUUID(),
    };
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);

    const { body: transformedBody, toolNameMap } = buildCommandCodeBody(model, body, stream);
    const url = this.buildUrl();
    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal: signal || undefined,
    });

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => {
        console.warn("[commandCode] upstream text failed");
        return "";
      });
      return {
        response: new Response(errorText || `Command Code API error ${upstream.status}`, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        }),
        url,
        headers,
        transformedBody,
      };
    }

    const response = stream
      ? createStreamResponse(upstream, model, signal, toolNameMap)
      : await createJsonResponse(upstream, model, signal, toolNameMap);

    return { response, url, headers, transformedBody };
  }
}
