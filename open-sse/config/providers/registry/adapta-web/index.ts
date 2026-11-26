import type { RegistryEntry } from "../../shared.ts";

// Limits below come from each model vendor's own documentation (not from Adapta,
// which publishes no numbers). Adapta only proxies these models and maps its own
// catalog keys onto them, so the wire limits are the vendor's.
//
//   openai:    develop.../gpt-6-luna           1,050,000 ctx / 128,000 out (922k max input)
//   anthropic: platform.claude.com models      1M ctx / 128k out (Sonnet 5.5, Haiku 5.5, Sonnet 5)
//   google:    ai.google.dev gemini-3.7/3.8    1,048,576 ctx / 65,536 out (3.1 Pro: 1M / 64k)
//   deepseek:  api-docs.deepseek.com           1,048,576 ctx / 393,216 out (V4 Flash retired → V4.1)
//   moonshot:  platform.kimi.ai                262,144 ctx / 32,768 out (per-step default)
//   minimax:   platform.minimax.io             1M ctx / 512,000 out (M3, M3.1 Flash)
//                                              204,800 ctx / 131,072 out (M2.7 family)
//   alibaba:   model-studio qwen3.8/3.7        1M ctx / 131,072 out (3.7 Plus: 65,536)
//   zhipu:     docs.z.ai glm-5.3               1M ctx / 131,072 out (GLM 5.2 shares the base)
//   xai:       docs.x.ai pricing               4.3: 1M ctx · 4.5: 500k ctx (no published max output)
//   meta:      muse-spark-1.3                  1,048,576 ctx / 131,072 out
//   perplexity: sonar-pro                      200,000 ctx / 8,192 out
//   nvidia:    nemotron 3 super (Bedrock card) 262,144 ctx / 32,768 out
//
// `adapta-one` is Adapta's own opaque model: no vendor publishes limits for it,
// so it keeps a deliberately conservative 128k / 32k rather than an invented 1M.
export const adapta_webProvider: RegistryEntry = {
  id: "adapta-web",
  alias: "adp-web",
  format: "openai",
  executor: "adapta-web",
  baseUrl: "https://agent.adapta.one/api/chat/stream/v1",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    {
      id: "adapta-one",
      name: "ONE Smart (via Adapta)",
      toolCalling: false,
      contextLength: 128000,
      maxOutputTokens: 32768,
      // Pre-catalog ids stay routable: they all resolved to Adapta's ONE.
      aliases: [
        "adapta-gpt",
        "adapta-claude",
        "adapta-gemini",
        "adapta-grok",
        "adapta-deepseek",
        "adapta-llama",
      ],
    },
    {
      id: "adapta-gpt-6-luna",
      name: "GPT-6 Luna (via Adapta)",
      toolCalling: false,
      contextLength: 1050000,
      maxOutputTokens: 128000,
    },
    {
      id: "adapta-claude-5-5-haiku",
      name: "Claude 5.5 Haiku (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 128000,
    },
    {
      id: "adapta-claude-5-5-sonnet",
      name: "Claude 5.5 Sonnet (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 128000,
    },
    {
      id: "adapta-claude-5-sonnet",
      name: "Claude 5 Sonnet (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 128000,
    },
    {
      id: "adapta-gemini-3-8-flash",
      name: "Gemini 3.8 Flash (via Adapta)",
      toolCalling: false,
      contextLength: 1048576,
      maxOutputTokens: 65536,
    },
    {
      id: "adapta-gemini-3-7-flash",
      name: "Gemini 3.7 Flash (via Adapta)",
      toolCalling: false,
      contextLength: 1048576,
      maxOutputTokens: 65536,
    },
    {
      id: "adapta-gemini-3-1-pro-preview",
      name: "Gemini 3.1 Pro (via Adapta)",
      toolCalling: false,
      contextLength: 1048576,
      maxOutputTokens: 65536,
    },
    {
      id: "adapta-deepseek-v4-1-flash-1017",
      name: "DeepSeek V4.1 Flash - 1017 (via Adapta)",
      toolCalling: false,
      contextLength: 1048576,
      maxOutputTokens: 393216,
    },
    {
      // Upstream retired this alias: DeepSeek routes deepseek-v4-flash to
      // DeepSeek-V4.1-Flash-1017, so it inherits the same wire limits.
      id: "adapta-deepseek-v4-flash-updated",
      name: "DeepSeek V4 - 0731 (via Adapta)",
      toolCalling: false,
      contextLength: 1048576,
      maxOutputTokens: 393216,
    },
    {
      id: "adapta-deepseek-v4-pro-0813",
      name: "DeepSeek V4 Pro - 0813 (via Adapta)",
      toolCalling: false,
      contextLength: 1048576,
      maxOutputTokens: 393216,
    },
    {
      id: "adapta-kimi-k2-7-code",
      name: "Kimi K2.7 Code (via Adapta)",
      toolCalling: false,
      contextLength: 262144,
      maxOutputTokens: 32768,
    },
    {
      id: "adapta-kimi-k2-6",
      name: "Kimi K2.6 (via Adapta)",
      toolCalling: false,
      contextLength: 262144,
      maxOutputTokens: 32768,
    },
    {
      id: "adapta-minimax-m3",
      name: "MiniMax M3 (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 512000,
    },
    {
      id: "adapta-minimax-m3-1-flash",
      name: "MiniMax M3.1 Flash (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 512000,
    },
    {
      id: "adapta-minimax-m2-7-highspeed",
      name: "MiniMax M2.7 Highspeed (via Adapta)",
      toolCalling: false,
      contextLength: 204800,
      maxOutputTokens: 131072,
    },
    {
      id: "adapta-minimax-m2-7",
      name: "MiniMax M2.7 (via Adapta)",
      toolCalling: false,
      contextLength: 204800,
      maxOutputTokens: 131072,
    },
    {
      id: "adapta-qwen-3-8-27b",
      name: "Qwen 3.8 27B (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 131072,
    },
    {
      id: "adapta-qwen-3-8-flash",
      name: "Qwen 3.8 Flash (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 131072,
    },
    {
      id: "adapta-qwen-3-7-plus",
      name: "Qwen 3.7 Plus (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 65536,
    },
    {
      id: "adapta-glm-5-3-flash",
      name: "GLM 5.3 Flash (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 131072,
    },
    {
      id: "adapta-glm-5-2",
      name: "GLM 5.2 (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 131072,
    },
    {
      // xAI publishes a 1M context for 4.3 but no max-output figure; 32k is the
      // conservative client-side cap rather than an invented vendor claim.
      id: "adapta-grok-43",
      name: "Grok 4.3 (via Adapta)",
      toolCalling: false,
      contextLength: 1000000,
      maxOutputTokens: 32768,
    },
    {
      // xAI: 500k context for 4.5, no published max output (reasoning counts
      // toward the same window).
      id: "adapta-grok-45",
      name: "Grok 4.5 (via Adapta)",
      toolCalling: false,
      contextLength: 500000,
      maxOutputTokens: 32768,
    },
    {
      id: "adapta-muse-spark-1-3",
      name: "Muse Spark 1.3 (via Adapta)",
      toolCalling: false,
      contextLength: 1048576,
      maxOutputTokens: 131072,
    },
    {
      id: "adapta-sonar-pro",
      name: "Perplexity (via Adapta)",
      toolCalling: false,
      contextLength: 200000,
      maxOutputTokens: 8192,
    },
    {
      // NVIDIA's blog says 1M native; the AWS Bedrock model card (the served
      // endpoint most deployments use) documents 256K / 32K. Take the lower one.
      id: "adapta-nvidia-nemotron-super",
      name: "Nemotron Super (via Adapta)",
      toolCalling: false,
      contextLength: 262144,
      maxOutputTokens: 32768,
    },
  ],
};
