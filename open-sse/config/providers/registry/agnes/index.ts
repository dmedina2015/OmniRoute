import type { RegistryEntry } from "../../shared.ts";

export const agnesProvider: RegistryEntry = {
  id: "agnes",
  format: "openai-responses",
  executor: "default",
  baseUrl: "https://apihub.agnes-ai.com/v1/responses",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    {
      id: "agnes-2.5-pro",
      name: "Agnes 2.5 Pro",
      contextLength: 1048576,
      maxOutputTokens: 65536,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
      interleavedField: "reasoning_content",
    },
    {
      id: "agnes-2.5-flash",
      name: "Agnes 2.5 Flash",
      contextLength: 524288,
      maxOutputTokens: 65536,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
      interleavedField: "reasoning_content",
    },
  ],
};
