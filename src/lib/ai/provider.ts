/**
 * The small surface the assistant needs from a language model, so Claude and
 * Ollama are interchangeable. Messages are kept in each provider's own format
 * ("native") and stored as-is, so a conversation continues exactly as the
 * model produced it.
 */

/** JSON Schema for a tool's input: always an object. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  call: ToolCall;
  output: string;
  isError?: boolean;
}

export interface ModelTurn {
  /** The assistant message to append to the history, in the provider's format. */
  native: unknown;
  text: string;
  toolCalls: ToolCall[];
  /** "refusal": the model declined; "length": the answer was cut off. */
  stop: "done" | "tool_use" | "length" | "refusal";
}

export interface StepRequest {
  system: string;
  messages: unknown[];
  tools: ToolSpec[];
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface ChatProvider {
  id: "anthropic" | "ollama";
  model: string;
  /** One model call. Visible text streams through onText as it arrives. */
  step(req: StepRequest): Promise<ModelTurn>;
  userMessage(text: string): unknown;
  /** Messages carrying tool results back to the model. */
  toolResults(results: ToolResult[]): unknown[];
  /** A single answer that matches `schema`, parsed. */
  json<T>(req: { system: string; prompt: string; schema: JsonSchema; signal?: AbortSignal }): Promise<T>;
  /** Whether the provider is reachable and the model is available. */
  check(): Promise<{ ok: boolean; detail: string }>;
}

export interface Embedder {
  model: string;
  /** Documents and queries may be embedded differently (some models want a prefix). */
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
  check(): Promise<{ ok: boolean; detail: string }>;
}

export class AiUnavailableError extends Error {}
