import { anthropicProvider } from "./anthropic";
import { aiConfig, type AiConfig } from "./config";
import { ollamaEmbedder, ollamaProvider } from "./ollama";
import type { ChatProvider, Embedder } from "./provider";

export interface AiServices {
  config: AiConfig;
  /** Null when AI is off or not configured; `reason` says why. */
  provider: ChatProvider | null;
  embedder: Embedder | null;
  reason?: string;
}

/** The configured chat model and embedder. Cheap to call; nothing connects until used. */
export function aiServices(config: AiConfig = aiConfig()): AiServices {
  const embedder = config.embed.provider === "ollama" ? ollamaEmbedder(config.embed) : null;
  if (config.provider === "off") return { config, provider: null, embedder: null, reason: "AI is turned off (AI_PROVIDER=off)." };
  if (config.provider === "anthropic") {
    if (!config.anthropic.apiKey) return { config, provider: null, embedder, reason: "AI_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set." };
    return { config, provider: anthropicProvider(config.anthropic), embedder };
  }
  return { config, provider: ollamaProvider(config.ollama), embedder };
}
