import { beforeEach, describe, expect, it } from "vitest";
import { Activity } from "@/lib/activity";
import { Assistant, type AssistantEvent } from "@/lib/ai/assistant";
import { anthropicProvider } from "@/lib/ai/anthropic";
import { AI_CLEAR_THRESHOLD, aiCategorize } from "@/lib/ai/categorizer";
import { aiConfig } from "@/lib/ai/config";
import { Knowledge } from "@/lib/ai/knowledge";
import { ollamaEmbedder, ollamaProvider } from "@/lib/ai/ollama";
import type { ChatProvider, Embedder, ModelTurn, StepRequest } from "@/lib/ai/provider";
import { AssistantTools, TOOL_SPECS, validateInput } from "@/lib/ai/tools";
import type { Books } from "@/lib/books";
import { freshBooks } from "./helpers";

/** A deterministic stand-in for an embedding model: hashed bag of words with a few synonyms. */
const SYNONYMS: Record<string, string> = { laptop: "computer", macbook: "computer", pc: "computer", coffee: "cafe", latte: "cafe" };
const fakeEmbedder: Embedder = {
  model: "fake-embed",
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(64).fill(0);
      for (const raw of t.toLowerCase().match(/[a-z]+/g) ?? []) {
        const w = SYNONYMS[raw] ?? raw;
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % 64] += 1;
      }
      return v;
    });
  },
  check: async () => ({ ok: true, detail: "fake" }),
};

/** A scripted model: each step returns the next turn, recording what it was sent. */
function scriptedProvider(turns: ((req: StepRequest) => Omit<ModelTurn, "native">)[], id: "anthropic" | "ollama" = "anthropic", model = "test-model") {
  const calls: StepRequest[] = [];
  let n = 0;
  const provider: ChatProvider & { calls: StepRequest[] } = {
    id,
    model,
    calls,
    async step(req) {
      calls.push({ ...req, messages: [...req.messages] });
      const turn = turns[n++](req);
      if (turn.text) req.onText?.(turn.text);
      const content = [
        ...(turn.text ? [{ type: "text", text: turn.text }] : []),
        ...turn.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
      ];
      return { ...turn, native: { role: "assistant", content } };
    },
    userMessage: (text) => ({ role: "user", content: text }),
    toolResults: (results) => [{ role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.call.id, content: r.output })) }],
    async json() {
      throw new Error("not scripted");
    },
    check: async () => ({ ok: true, detail: "scripted" }),
  };
  return provider;
}

let books: Books;
let checking: number;

beforeEach(async () => {
  books = await freshBooks();
  checking = (await books.listAccounts())[0].id;
  await books.importRows(checking, [
    { date: "2026-03-02", description: "APPLE STORE MACBOOK PRO", amountCents: -249900 },
    { date: "2026-03-05", description: "STARBUCKS STORE #88", amountCents: -650 },
    { date: "2026-03-10", description: "STRIPE TRANSFER", amountCents: 420000 },
    { date: "2026-04-03", description: "STAPLES 0042", amountCents: -4520 },
    { date: "2026-04-12", description: "ZELLE FROM J SMITH", amountCents: 75000 },
  ]);
  await Activity.for(books).addEvent({ date: "2026-03-09", kind: "social_post", title: "Spring sale announcement on Instagram" });
});

describe("Knowledge index", () => {
  it("indexes transactions, events, and months, and stays in sync", async () => {
    const k = new Knowledge(books, null);
    const first = await k.sync();
    // 5 transactions + 1 event + 2 months
    expect(first).toEqual({ changed: 8, removed: 0 });
    expect(await k.sync()).toEqual({ changed: 0, removed: 0 });

    const [staples] = (await books.listTransactions({ search: "STAPLES" })).rows;
    await books.updateNotes(staples.id, "printer paper");
    // The transaction and its month summary both change? Only the transaction text includes notes.
    expect((await k.sync()).changed).toBe(1);

    await books.deleteTransaction(staples.id);
    const after = await k.sync();
    expect(after.removed).toBe(1);
    expect(after.changed).toBe(1); // April's summary
  });

  it("finds records by keyword without embeddings", async () => {
    const k = new Knowledge(books, null);
    await k.sync();
    const hits = await k.search("instagram sale");
    expect(hits[0].sourceType).toBe("event");
    expect(hits[0].content).toContain("Spring sale");
    const months = await k.search("summary", { types: ["month"] });
    expect(months.map((m) => m.sourceId).sort()).toEqual(["2026-03", "2026-04"]);
  });

  it("embeds documents with pgvector and finds them by meaning", async () => {
    const k = new Knowledge(books, fakeEmbedder);
    await k.sync();
    expect(await k.embedPending()).toBe(8);
    expect(await k.embedPending()).toBe(0);
    const stats = await k.stats();
    expect(stats).toMatchObject({ documents: 8, embedded: 8, vectorSupport: true });

    // "laptop" never appears in the books; only the vector side can match it to the MacBook.
    const hits = await k.search("laptop", { types: ["transaction"] });
    expect(hits[0].title).toContain("MACBOOK");

    await k.resetEmbeddings();
    expect((await k.stats()).embedded).toBe(0);
  });
});

describe("Assistant tools", () => {
  it("validates input against the tool schema", () => {
    const find = TOOL_SPECS.find((t) => t.name === "find_transactions")!.parameters;
    expect(validateInput(find, { from: "2026-03-01", direction: "out" })).toBeNull();
    expect(validateInput(find, { from: "March" })).toMatch(/date/);
    expect(validateInput(find, { direction: "sideways" })).toMatch(/one of/);
    expect(validateInput(find, { limit: 2.5 })).toMatch(/whole number/);
    expect(validateInput(find, { bogus: 1 })).toMatch(/Unknown/);
    const set = TOOL_SPECS.find((t) => t.name === "set_category")!.parameters;
    expect(validateInput(set, { category_id: "meals" })).toMatch(/transaction_id/);
  });

  it("finds transactions with exact filters and totals", async () => {
    const tools = new AssistantTools(books, new Knowledge(books, null));
    const out = await tools.run({ id: "1", name: "find_transactions", input: { direction: "out", from: "2026-03-01", to: "2026-03-31" } });
    const body = JSON.parse(out.output);
    expect(body.matching).toBe(2);
    expect(body.net_total).toBe("-$2,505.50");
    expect(out.activity.sources).toHaveLength(2);

    const big = JSON.parse((await tools.run({ id: "2", name: "find_transactions", input: { min_amount: 1000 } })).output);
    expect(big.transactions.map((t: { description: string }) => t.description).sort()).toEqual(["APPLE STORE MACBOOK PRO", "STRIPE TRANSFER"]);
  });

  it("summarizes a period with events and reports errors as tool errors", async () => {
    const tools = new AssistantTools(books, new Knowledge(books, null));
    const out = JSON.parse((await tools.run({ id: "1", name: "summarize_period", input: { from: "2026-03-01", to: "2026-03-31" } })).output);
    expect(out.income).toBe("$4,200.00");
    expect(out.events[0].title).toContain("Spring sale");
    expect(out.top_spending_merchants[0].total).toBe("$2,499.00");

    const bad = await tools.run({ id: "2", name: "set_category", input: { transaction_id: 999999, category_id: "meals" } });
    expect(bad.isError).toBe(true);
    expect(bad.output).toMatch(/not found/);
  });

  it("changes a category and remembers it when asked", async () => {
    const tools = new AssistantTools(books, new Knowledge(books, null));
    const [zelle] = (await books.listTransactions({ search: "ZELLE" })).rows;
    const out = await tools.run({ id: "1", name: "set_category", input: { transaction_id: zelle.id, category_id: "owner_contribution", remember: true } });
    expect(out.activity.changed).toBe(true);
    expect((await books.getTransaction(zelle.id))!.categoryId).toBe("owner_contribution");
    expect((await books.listRules()).length).toBe(1);
  });

  it("gives the year's Schedule C summary", async () => {
    const tools = new AssistantTools(books, new Knowledge(books, null));
    const out = JSON.parse((await tools.run({ id: "1", name: "tax_summary", input: { year: 2026 } })).output);
    expect(out.line_1_gross_receipts).toMatch(/^\$/);
    expect(out).toHaveProperty("self_employment_tax_estimate");
  });
});

describe("Assistant", () => {
  it("answers with tools, streams events, and saves the conversation", async () => {
    const provider = scriptedProvider([
      () => ({ text: "Let me check.", toolCalls: [{ id: "t1", name: "find_transactions", input: { text: "starbucks" } }], stop: "tool_use" }),
      (req) => {
        const last = req.messages[req.messages.length - 1] as { content: { content: string }[] };
        const result = JSON.parse(last.content[0].content);
        return { text: `You spent ${result.net_total.replace("-", "")} at Starbucks.`, toolCalls: [], stop: "done" };
      },
    ]);
    const assistant = new Assistant(books, provider, new Knowledge(books, null));
    await new Knowledge(books, null).sync();
    const events: AssistantEvent[] = [];
    await assistant.ask({ question: "How much at Starbucks?", today: "2026-10-14", emit: (e) => events.push(e) });

    const conv = events.find((e) => e.type === "conversation");
    expect(conv).toBeDefined();
    const text = events.filter((e): e is Extract<AssistantEvent, { type: "text" }> => e.type === "text").map((e) => e.delta).join("");
    expect(text).toBe("Let me check.\n\nYou spent $6.50 at Starbucks.");
    expect(events.some((e) => e.type === "tool" && e.activity.tool === "find_transactions")).toBe(true);
    expect(events[events.length - 1].type).toBe("done");

    // The question is framed with today's date and related records; the system prompt lists categories.
    const firstUser = provider.calls[0].messages[0] as { content: string };
    expect(firstUser.content).toContain("Today is 2026-10-14.");
    expect(firstUser.content).toContain("STARBUCKS");
    expect(provider.calls[0].system).toContain("office_expense");

    const id = (conv as { id: number }).id;
    const saved = await assistant.messages(id);
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(saved[1].content).toBe(text);
    expect(saved[1].activity.some((a) => a.tool === "find_transactions")).toBe(true);
  });

  it("continues a conversation with the exact earlier messages", async () => {
    const provider = scriptedProvider([
      () => ({ text: "First answer.", toolCalls: [], stop: "done" }),
      () => ({ text: "Second answer.", toolCalls: [], stop: "done" }),
    ]);
    const assistant = new Assistant(books, provider, new Knowledge(books, null));
    const events: AssistantEvent[] = [];
    await assistant.ask({ question: "One?", today: "2026-10-14", emit: (e) => events.push(e) });
    const id = (events.find((e) => e.type === "conversation") as { id: number }).id;
    await assistant.ask({ conversationId: id, question: "Two?", today: "2026-10-14", emit: () => {} });

    const second = provider.calls[1];
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "First answer." }] });
    // The system prompt is fixed when the conversation starts.
    expect(second.system).toBe(provider.calls[0].system);
    expect((await assistant.listConversations())[0].title).toBe("One?");
  });

  it("falls back to plain text history when the model changes", async () => {
    const a = scriptedProvider([() => ({ text: "From Claude.", toolCalls: [], stop: "done" })]);
    const events: AssistantEvent[] = [];
    await new Assistant(books, a, new Knowledge(books, null)).ask({ question: "Hi", today: "2026-10-14", emit: (e) => events.push(e) });
    const id = (events.find((e) => e.type === "conversation") as { id: number }).id;

    const b = scriptedProvider([() => ({ text: "From Ollama.", toolCalls: [], stop: "done" })], "ollama", "qwen3:8b");
    await new Assistant(books, b, new Knowledge(books, null)).ask({ conversationId: id, question: "Again", today: "2026-10-14", emit: () => {} });
    expect(b.calls[0].messages[0]).toEqual({ role: "user", content: "Hi" });
    expect(b.calls[0].messages[1]).toEqual({ role: "assistant", content: "From Claude." });
  });

  it("keeps a failed turn for reading but out of the model's history", async () => {
    const provider = scriptedProvider([
      () => {
        throw new Error("network down");
      },
      () => ({ text: "Recovered.", toolCalls: [], stop: "done" }),
    ]);
    const assistant = new Assistant(books, provider, new Knowledge(books, null));
    const events: AssistantEvent[] = [];
    await assistant.ask({ question: "Q1", today: "2026-10-14", emit: (e) => events.push(e) });
    expect(events.some((e) => e.type === "error" && e.message === "network down")).toBe(true);
    const id = (events.find((e) => e.type === "conversation") as { id: number }).id;
    await assistant.ask({ conversationId: id, question: "Q2", today: "2026-10-14", emit: () => {} });
    expect(provider.calls[1].messages).toHaveLength(1);
    expect((await assistant.messages(id)).length).toBe(4);
  });
});

describe("AI categorization", () => {
  it("sorts uncertain transactions, keeps unsure ones in review, and survives re-runs", async () => {
    const provider = scriptedProvider([]);
    const prompts: string[] = [];
    provider.json = async <T,>({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      const ids = [...prompt.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));
      const rows = await Promise.all(ids.map((id) => books.getTransaction(id)));
      return {
        results: rows.map((t) =>
          t!.description.includes("ZELLE")
            ? { id: t!.id, category_id: "gross_receipts", confidence: 0.6, reason: "Looks like a customer payment" }
            : { id: t!.id, category_id: "office_expense", confidence: 0.9, reason: "Office supplies" },
        ),
      } as T;
    };
    const before = (await books.listTransactions({ needsReview: true })).rows;
    expect(before.length).toBeGreaterThan(0);

    const result = await aiCategorize(books, provider);
    expect(result.considered).toBe(before.length);
    expect(prompts[0]).toContain("Categorize these transactions");

    const zelle = (await books.listTransactions({ search: "ZELLE" })).rows[0];
    expect(zelle).toMatchObject({ categorySource: "ai", categoryId: "gross_receipts", needsReview: true });
    expect(zelle.reason).toMatch(/^AI: /);
    expect(0.6).toBeLessThan(AI_CLEAR_THRESHOLD);

    // Re-running the built-in chain keeps the AI's answer...
    await books.recategorize();
    expect((await books.getTransaction(zelle.id))!.categorySource).toBe("ai");
    // ...unless one of the owner's rules matches.
    await books.createRule({ pattern: "zelle from j smith", categoryId: "owner_contribution" });
    expect((await books.getTransaction(zelle.id))!.categoryId).toBe("owner_contribution");
  });

  it("only touches transactions the built-in chain was unsure about", async () => {
    const provider = scriptedProvider([]);
    let asked = 0;
    provider.json = async <T,>() => {
      asked++;
      return { results: [] } as T;
    };
    const [stripe] = (await books.listTransactions({ search: "STRIPE" })).rows;
    expect(await aiCategorize(books, provider, { ids: [stripe.id] })).toEqual({ considered: 0, updated: 0, cleared: 0 });
    expect(asked).toBe(0);
  });
});

describe("Providers", () => {
  it("picks Claude when a key is set and Ollama otherwise", () => {
    expect(aiConfig({}).provider).toBe("ollama");
    expect(aiConfig({ ANTHROPIC_API_KEY: "k" }).provider).toBe("anthropic");
    expect(aiConfig({ ANTHROPIC_API_KEY: "k", AI_PROVIDER: "ollama" }).provider).toBe("ollama");
    expect(aiConfig({ AI_PROVIDER: "off" }).embed.provider).toBe("off");
    expect(aiConfig({}).anthropic.model).toBe("claude-opus-5-5");
  });

  it("streams Ollama chat, collects tool calls, and formats tool results", async () => {
    const lines = [
      { message: { role: "assistant", content: "Look" }, done: false },
      { message: { role: "assistant", content: "ing", tool_calls: [{ function: { name: "tax_summary", arguments: { year: 2026 } } }] }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop" },
    ];
    let sent: { tools: unknown[]; messages: { role: string }[]; options: { num_ctx: number } } | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n"));
    }) as typeof fetch;
    const p = ollamaProvider({ url: "http://ollama:11434", model: "qwen3:8b", numCtx: 8192 }, fakeFetch);
    let streamed = "";
    const turn = await p.step({ system: "sys", messages: [p.userMessage("hi")], tools: TOOL_SPECS, onText: (d) => (streamed += d) });
    expect(streamed).toBe("Looking");
    expect(turn.toolCalls).toEqual([{ id: expect.any(String), name: "tax_summary", input: { year: 2026 } }]);
    expect(turn.stop).toBe("tool_use");
    expect(sent!.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(sent!.tools).toHaveLength(TOOL_SPECS.length);
    expect(sent!.options.num_ctx).toBe(8192);
    expect(p.toolResults([{ call: turn.toolCalls[0], output: "{}" }])).toEqual([{ role: "tool", tool_name: "tax_summary", content: "{}" }]);
  });

  it("adds nomic task prefixes to Ollama embeddings", async () => {
    let input: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      input = JSON.parse(String(init.body)).input;
      return Response.json({ embeddings: input.map(() => [0.1, 0.2]) });
    }) as typeof fetch;
    const e = ollamaEmbedder({ provider: "ollama", model: "nomic-embed-text", url: "http://x" }, fakeFetch);
    expect(await e.embed(["coffee"], "query")).toEqual([[0.1, 0.2]]);
    expect(input).toEqual(["search_query: coffee"]);
  });

  it("explains an Ollama that is not running", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const p = ollamaProvider({ url: "http://localhost:11434", model: "qwen3:8b", numCtx: 8192 }, fakeFetch);
    await expect(p.step({ system: "", messages: [], tools: [] })).rejects.toThrow(/Is it running/);
    expect(await p.check()).toEqual({ ok: false, detail: "Could not reach Ollama at http://localhost:11434." });
  });

  it("sends Claude a cache-friendly request with refusal fallback and maps the reply", async () => {
    let params: Record<string, unknown> = {};
    const message = {
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "tu_1", name: "tax_summary", input: { year: 2026 } },
      ],
      stop_reason: "tool_use",
    };
    const fakeClient = {
      beta: {
        messages: {
          stream(p: Record<string, unknown>) {
            params = p;
            return { on: () => undefined, finalMessage: async () => message };
          },
        },
      },
    };
    const p = anthropicProvider({ apiKey: undefined, model: "claude-opus-5-5", effort: "medium" }, fakeClient as never);
    const turn = await p.step({ system: "sys", messages: [p.userMessage("hi")], tools: TOOL_SPECS });
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      cache_control: { type: "ephemeral" },
    });
    expect(turn.text).toBe("Checking.");
    expect(turn.toolCalls).toEqual([{ id: "tu_1", name: "tax_summary", input: { year: 2026 } }]);
    // The whole reply, thinking included, goes back unchanged.
    expect(turn.native).toEqual({ role: "assistant", content: message.content });
    expect(p.toolResults([{ call: turn.toolCalls[0], output: "{}", isError: true }])).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "{}", is_error: true }] },
    ]);
  });
});
