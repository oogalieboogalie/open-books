import Anthropic from "@anthropic-ai/sdk";
import type { AiConfig } from "./config";
import { AiUnavailableError, type ChatProvider, type ToolCall, type ToolResult, type ToolSpec } from "./provider";

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
// On these, a declined request is re-run on Anthropic's recommended model in
// the same call instead of coming back empty.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Claude through the Anthropic API, with the business's own key. */
export function anthropicProvider(config: AiConfig["anthropic"], client?: Anthropic): ChatProvider {
  if (!client && !config.apiKey) throw new AiUnavailableError("Set ANTHROPIC_API_KEY to use Claude.");
  const api = client ?? new Anthropic({ apiKey: config.apiKey });
  const model = config.model;
  const fallback = FALLBACK_MODELS.has(model);

  const base = () => ({
    model,
    thinking: { type: "adaptive" as const },
    ...(fallback ? { fallbacks: "default" as const, betas: [FALLBACK_BETA] } : {}),
  });

  const toTool = (t: ToolSpec): Anthropic.Beta.BetaTool => ({
    name: t.name,
    description: t.description,
    input_schema: { ...t.parameters },
    // Inputs stream as they are generated; the assistant validates them before running a tool.
    eager_input_streaming: true,
  });

  return {
    id: "anthropic",
    model,

    async step({ system, messages, tools, onText, signal }) {
      const stream = api.beta.messages.stream(
        {
          ...base(),
          max_tokens: 32000,
          output_config: { effort: config.effort },
          // The system prompt and tool list never change within a conversation,
          // so the whole history before the new question is served from cache.
          system: [{ type: "text", text: system }],
          tools: tools.map(toTool),
          messages: messages as Anthropic.Beta.BetaMessageParam[],
          cache_control: { type: "ephemeral" },
        },
        { signal },
      );
      if (onText) stream.on("text", (delta) => onText(delta));
      const message = await stream.finalMessage();

      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls: ToolCall[] = message.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
      const stop =
        message.stop_reason === "refusal" ? "refusal" : message.stop_reason === "max_tokens" ? "length" : toolCalls.length ? "tool_use" : "done";
      return { native: { role: "assistant", content: message.content }, text, toolCalls, stop };
    },

    userMessage: (text) => ({ role: "user", content: text }),

    toolResults(results: ToolResult[]) {
      // All results for one turn go back in a single user message.
      return [
        {
          role: "user",
          content: results.map((r) => ({ type: "tool_result", tool_use_id: r.call.id, content: r.output, ...(r.isError ? { is_error: true } : {}) })),
        },
      ];
    },

    async json<T>({ system, prompt, schema, signal }: { system: string; prompt: string; schema: ToolSpec["parameters"]; signal?: AbortSignal }) {
      const stream = api.beta.messages.stream(
        {
          ...base(),
          max_tokens: 16000,
          output_config: { effort: "low", format: { type: "json_schema", schema: { ...schema } } },
          system,
          messages: [{ role: "user", content: prompt }],
        },
        { signal },
      );
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") throw new Error("The model declined this request.");
      const text = message.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text ?? "";
      return JSON.parse(text) as T;
    },

    async check() {
      try {
        const m = await api.models.retrieve(model);
        return { ok: true, detail: `Claude (${m.display_name ?? model})` };
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return { ok: false, detail: "The Anthropic API key was rejected." };
        if (err instanceof Anthropic.NotFoundError) return { ok: false, detail: `Model ${model} was not found for this key.` };
        if (err instanceof Anthropic.APIConnectionError) return { ok: false, detail: "Could not reach the Anthropic API." };
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
