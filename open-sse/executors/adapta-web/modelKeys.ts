/**
 * Adapta catalog key resolution.
 *
 * Adapta's wire protocol identifies a model by its own catalog key ("ONE",
 * "KIMI_K2_7_CODE", …), not by the OpenAI-style model id the client sends. This map
 * is the single place that translation happens; the provider registry lists the same
 * ids (tests/unit/adapta-web-model-catalog.test.ts keeps both lists in sync).
 */
export const DEFAULT_MODEL_KEY = "ONE";

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

/** Catalog key for a client-facing model id, falling back to Adapta's auto-select. */
export function resolveModelKey(model: string | null | undefined): string {
  if (!model) return DEFAULT_MODEL_KEY;
  return MODEL_KEY_MAP[model] ?? DEFAULT_MODEL_KEY;
}
