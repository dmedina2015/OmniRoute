/**
 * Wire shapes Adapta accepts.
 *
 * Adapta's chat endpoint is not an OpenAI-compatible API: it speaks a web-UI payload
 * with `user`/`assistant` roles only, `parts[]` instead of `content`, and a per-message
 * `id`. This module keeps those shapes in one place so the executor never invents them
 * inline.
 */

export interface OpenAIMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCallMsg[];
}

export interface OpenAIToolCallMsg {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export type AdaptaPart =
  | { type: "text"; text: string }
  /** Adapta emits step markers between assistant text blocks. */
  | { type: "step-start"; id: string };

export interface AdaptaMessage {
  id: string;
  role: string;
  parts: AdaptaPart[];
  metadata?: Record<string, unknown>;
  state?: string;
}
