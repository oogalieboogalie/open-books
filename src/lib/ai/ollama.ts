import type { AiConfig } from "./config";
import type { ChatProvider, Embedder, ToolCall, ToolResult } from "./provider";

/**
 * Ollama on this machine or the local network: nothing leaves the building.
 * Uses the native /api/chat and /api/embed endpoints.
 */

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

type Fetch = typeof fetch;

async function post(fetchFn: Fetch, url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new Error(`Could not reach Ollama at ${new URL(url).origin}. Is it running?`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const msg = /not found/i.test(detail) ? `${detail.replace(/^\{"error":"|"\}$/g, "")}. Run "ollama pull" for it.` : detail || res.statusText;
    throw new Error(`Ollama: ${msg}`);
  }
  return res;
}

/** Reads a newline-delimited JSON stream. */
async function* ndjson(res: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

async function checkModel(fetchFn: Fetch, url: string, model: string, label: string) {
  try {
    const res = await fetchFn(`${url}/api/tags`);
    if (!res.ok) return { ok: false, detail: `Ollama answered ${res.status}.` };
    const { models = [] } = (await res.json()) as { models?: { name: string }[] };
    const want = model.includes(":") ? model : `${model}:latest`;
    if (!models.some((m) => m.name === want || m.name === model)) return { ok: false, detail: `${label} ${model} is not pulled yet. Run: ollama pull ${model}` };
    return { ok: true, detail: `Ollama (${model})` };
  } catch {
    return { ok: false, detail: `Could not reach Ollama at ${url}.` };
  }
}

export function ollamaProvider(config: AiConfig["ollama"], fetchFn: Fetch = fetch): ChatProvider {
  const { url, model, numCtx } = config;
  let callSeq = 0;

  return {
    id: "ollama",
    model,

    async step({ system, messages, tools, onText, signal }) {
      const res = await post(
        fetchFn,
        `${url}/api/chat`,
        {
          model,
          stream: true,
          messages: [{ role: "system", content: system }, ...(messages as OllamaMessage[])],
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
          options: { num_ctx: numCtx },
        },
        signal,
      );
      let text = "";
      const calls: NonNullable<OllamaMessage["tool_calls"]> = [];
      let doneReason = "";
      for await (const chunk of ndjson(res)) {
        if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
        const msg = chunk.message as OllamaMessage | undefined;
        if (msg?.content) {
          text += msg.content;
          onText?.(msg.content);
        }
        if (msg?.tool_calls) calls.push(...msg.tool_calls);
        if (chunk.done) doneReason = String(chunk.done_reason ?? "");
      }
      const toolCalls: ToolCall[] = calls.map((c) => ({
        id: `call_${++callSeq}`,
        name: c.function.name,
        input: typeof c.function.arguments === "string" ? safeJson(c.function.arguments) : (c.function.arguments ?? {}),
      }));
      const native: OllamaMessage = { role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) };
      const stop = toolCalls.length ? "tool_use" : doneReason === "length" ? "length" : "done";
      return { native, text, toolCalls, stop };
    },

    userMessage: (text) => ({ role: "user", content: text }),

    toolResults: (results: ToolResult[]) =>
      results.map((r) => ({ role: "tool", tool_name: r.call.name, content: r.isError ? `Error: ${r.output}` : r.output })),

    async json<T>({ system, prompt, schema, signal }: Parameters<ChatProvider["json"]>[0]) {
      const res = await post(
        fetchFn,
        `${url}/api/chat`,
        {
          model,
          stream: false,
          format: schema,
          think: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          options: { num_ctx: numCtx, temperature: 0 },
        },
        signal,
      );
      const body = (await res.json()) as { message?: { content?: string } };
      return JSON.parse(body.message?.content ?? "") as T;
    },

    check: () => checkModel(fetchFn, url, model, "Chat model"),
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * Embeddings from Ollama. nomic-embed-text and similar models are trained with
 * task prefixes, which noticeably improve retrieval.
 */
export function ollamaEmbedder(config: AiConfig["embed"], fetchFn: Fetch = fetch): Embedder {
  const { url, model } = config;
  const prefixed = /nomic-embed/.test(model);
  return {
    model,
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      const input = prefixed ? texts.map((t) => `${kind === "query" ? "search_query" : "search_document"}: ${t}`) : texts;
      const res = await post(fetchFn, `${url}/api/embed`, { model, input, truncate: true });
      const body = (await res.json()) as { embeddings?: number[][] };
      if (!body.embeddings || body.embeddings.length !== texts.length) throw new Error("Ollama returned no embeddings.");
      return body.embeddings;
    },
    check: () => checkModel(fetchFn, url, model, "Embedding model"),
  };
}
