import { createOpenAI } from "@ai-sdk/openai";

export const localProvider = createOpenAI({
  apiKey: process.env.LOCAL_AI_API_KEY || "sk-no-key-required",
  baseURL: process.env.LOCAL_AI_BASE_URL || "http://localhost:1234/v1",
});

export const defaultModel = process.env.LOCAL_AI_MODEL_NAME || "hermes";

export type AiApiMode = "chat" | "responses";

export const AI_API_MODES = [
  { id: "chat", labelKey: "settings.ai.client.apiMode.chat" },
  { id: "responses", labelKey: "settings.ai.client.apiMode.responses" },
] as const;

export function normalizeAiApiMode(value?: string | null): AiApiMode {
  return value === "responses" ? "responses" : "chat";
}

/** AI channel type configuration */
export const CHANNEL_TYPES = [
  { id: "openai", label: "OpenAI", modelsUrl: "/v1/models" },
  { id: "anthropic", label: "Anthropic", modelsUrl: "/v1/models" },
  { id: "deepseek", label: "DeepSeek", modelsUrl: "/v1/models" },
  { id: "qwen", label: "通义千问", modelsUrl: "/v1/models" },
  { id: "local", label: "本地 / LocalAI", modelsUrl: "/v1/models" },
  { id: "ollama", label: "Ollama", modelsUrl: "/api/tags" },
  { id: "custom", label: "自定义兼容接口", modelsUrl: "/v1/models" },
] as const;

export function getModelsUrl(channelType: string): string {
  return CHANNEL_TYPES.find(t => t.id === channelType)?.modelsUrl ?? "/v1/models";
}
