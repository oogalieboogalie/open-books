/**
 * Which model answers questions and which one turns text into embeddings,
 * chosen by environment variables so the same build runs hosted with Claude
 * or fully offline with Ollama.
 *
 *   AI_PROVIDER        anthropic | ollama | off. Defaults to anthropic when
 *                      ANTHROPIC_API_KEY is set, otherwise ollama.
 *   ANTHROPIC_API_KEY  Your own key (bring your own key).
 *   ANTHROPIC_MODEL    Defaults to claude-opus-5-5.
 *   AI_EFFORT          low | medium | high for Claude. Defaults to medium.
 *   OLLAMA_URL         Defaults to http://localhost:11434.
 *   OLLAMA_MODEL       Chat model. Defaults to qwen3:8b (fits an 8 GB GPU).
 *   OLLAMA_NUM_CTX     Context window for Ollama. Defaults to 16384.
 *   EMBED_PROVIDER     ollama | off. Defaults to ollama.
 *   EMBED_MODEL        Defaults to nomic-embed-text.
 *   AI_AUTO_CATEGORIZE Set to 0 to stop sorting new imports with AI.
 */

export type ProviderId = "anthropic" | "ollama";
export type Effort = "low" | "medium" | "high";

export interface AiConfig {
  provider: ProviderId | "off";
  anthropic: { apiKey: string | undefined; model: string; effort: Effort };
  ollama: { url: string; model: string; numCtx: number };
  embed: { provider: "ollama" | "off"; model: string; url: string };
  autoCategorize: boolean;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const DEFAULT_OLLAMA_MODEL = "qwen3:8b";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export function aiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const apiKey = env.ANTHROPIC_API_KEY || undefined;
  const requested = (env.AI_PROVIDER ?? "").toLowerCase();
  const provider = requested === "anthropic" || requested === "ollama" || requested === "off" ? requested : apiKey ? "anthropic" : "ollama";
  const effort = (["low", "medium", "high"] as const).find((e) => e === env.AI_EFFORT) ?? "medium";
  const ollamaUrl = (env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
  return {
    provider,
    anthropic: { apiKey, model: env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL, effort },
    ollama: { url: ollamaUrl, model: env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL, numCtx: Number(env.OLLAMA_NUM_CTX) || 16384 },
    embed: {
      provider: env.EMBED_PROVIDER === "off" || provider === "off" ? "off" : "ollama",
      model: env.EMBED_MODEL || DEFAULT_EMBED_MODEL,
      url: (env.EMBED_URL || ollamaUrl).replace(/\/+$/, ""),
    },
    autoCategorize: env.AI_AUTO_CATEGORIZE !== "0",
  };
}
