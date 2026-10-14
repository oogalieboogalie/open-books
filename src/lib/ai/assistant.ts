import type { Books } from "../books";
import { CATEGORIES } from "../categories";
import type { Knowledge } from "./knowledge";
import type { ChatProvider, ToolResult } from "./provider";
import { AssistantTools, TOOL_SPECS, type ToolActivity } from "./tools";

/**
 * The bookkeeping assistant: answers questions about the business's own books
 * with retrieval plus tools that read exact figures, and keeps conversations.
 */

export interface Conversation {
  id: number;
  title: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  activity: ToolActivity[];
  createdAt: string;
}

export type AssistantEvent =
  | { type: "conversation"; id: number; title: string }
  | { type: "status"; text: string }
  | { type: "tool"; activity: ToolActivity }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: number }
  | { type: "error"; message: string };

const MAX_STEPS = 10;
/** Ollama models have small context windows, so they get recent turns as plain text. */
const OLLAMA_HISTORY_MESSAGES = 8;

/** Stable for the life of a conversation, so it caches and never invalidates earlier turns. */
export function systemPrompt(businessName: string): string {
  const categories = CATEGORIES.map((c) => `- ${c.id}: ${c.name}${c.taxLine ? ` (${c.taxLine})` : ""}`).join("\n");
  return `You are the bookkeeping assistant inside Open Books, working for the owner of "${businessName}", a small business. You answer questions about their own books: income, expenses, categories, taxes, and the timeline of events (social posts, promotions, emails) and tracked numbers (contacts, appointments, leads, link clicks) recorded alongside the money.

How to work:
- Base every figure on the books. Each question arrives with records found by search; use the tools for exact totals, lists, and date ranges rather than adding up search snippets yourself.
- Say which dates and filters a number covers. If the books don't contain something, say so plainly instead of guessing.
- When asked how an event or promotion did, compare the money and tracked numbers in the days after it with a similar stretch before it, and say that this shows timing, not proof of cause.
- Only change the books (set_category, create_rule) when the owner asks you to. Say what you changed.
- On tax questions, explain using the Schedule C lines shown, and note that Open Books organizes records and is not tax advice; suggest a tax professional for judgment calls.
- Keep answers short and direct, lead with the answer, use short lists or a small table when it helps. Amounts are US dollars.

Category ids you can use with the tools:
${categories}`;
}

export class Assistant {
  readonly tools: AssistantTools;

  constructor(
    private books: Books,
    private provider: ChatProvider,
    private knowledge: Knowledge,
  ) {
    this.tools = new AssistantTools(books, knowledge);
  }

  private get db() {
    return this.books.db;
  }

  listConversations(limit = 50): Promise<Conversation[]> {
    return this.db.query<Conversation>(
      `SELECT id, title, updated_at AS "updatedAt" FROM ai_conversations WHERE business_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2`,
      [this.books.businessId, limit],
    );
  }

  async messages(conversationId: number): Promise<ChatMessage[]> {
    return this.db.query<ChatMessage>(
      `SELECT m.id, m.role, m.content, m.activity, m.created_at AS "createdAt" FROM ai_messages m
       JOIN ai_conversations c ON c.id = m.conversation_id WHERE c.id = $1 AND c.business_id = $2 ORDER BY m.id`,
      [conversationId, this.books.businessId],
    );
  }

  async deleteConversation(id: number): Promise<void> {
    await this.db.query("DELETE FROM ai_conversations WHERE id = $1 AND business_id = $2", [id, this.books.businessId]);
  }

  /** The history to send: exact native messages for the same model, plain text otherwise. */
  private async history(conversationId: number): Promise<unknown[]> {
    const rows = await this.db.query<{ role: string; content: string; native: unknown[]; provider: string; model: string }>(
      "SELECT role, content, native, provider, model FROM ai_messages WHERE conversation_id = $1 ORDER BY id",
      [conversationId],
    );
    const p = this.provider;
    // Turns that failed are saved without native messages; they stay out of the history.
    const complete = rows.filter((r) => r.native.length > 0);
    const asText = (r: (typeof rows)[number]) => (r.role === "user" ? p.userMessage(r.content) : { role: "assistant", content: r.content || "(no answer)" });
    if (p.id === "ollama") return complete.slice(-OLLAMA_HISTORY_MESSAGES).map(asText);
    return complete.flatMap((r) => (r.provider === p.id && r.model === p.model ? r.native : [asText(r)]));
  }

  /** The question as sent to the model: today's date and related records found by search. */
  async framedQuestion(question: string, today: string): Promise<{ text: string; sources: ToolActivity["sources"] }> {
    const hits = await this.knowledge.search(question, { limit: 6 }).catch(() => []);
    const lines = hits.map((h) => `- [${h.sourceType} ${h.sourceId}${h.date ? `, ${h.date}` : ""}] ${h.content}`);
    const context = lines.length ? `Records that may be related (found by search):\n${lines.join("\n")}\n\n` : "";
    return {
      text: `Today is ${today}.\n\n${context}Question: ${question}`,
      sources: hits.map((h) => ({ type: h.sourceType, id: h.sourceId, title: h.title, date: h.date })),
    };
  }

  async ask(input: { conversationId?: number | null; question: string; today: string; emit: (e: AssistantEvent) => void; signal?: AbortSignal }): Promise<void> {
    const { emit, signal } = input;
    const question = input.question.trim();
    if (!question) return emit({ type: "error", message: "Ask a question." });

    let conversationId = input.conversationId ?? null;
    let system = "";
    if (conversationId) {
      const row = await this.db.one<{ system_prompt: string }>("SELECT system_prompt FROM ai_conversations WHERE id = $1 AND business_id = $2", [
        conversationId,
        this.books.businessId,
      ]);
      if (!row) conversationId = null;
      else system = row.system_prompt;
    }
    if (!conversationId) {
      system = systemPrompt(await this.businessName());
      const title = question.length > 60 ? `${question.slice(0, 57).trimEnd()}...` : question;
      const row = await this.db.one<{ id: number }>(
        "INSERT INTO ai_conversations (business_id, title, provider, model, system_prompt) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [this.books.businessId, title, this.provider.id, this.provider.model, system],
      );
      conversationId = row!.id;
      emit({ type: "conversation", id: conversationId, title });
    }
    if (!system) system = systemPrompt(await this.businessName());

    const history = await this.history(conversationId);
    const framed = await this.framedQuestion(question, input.today);
    const userNative = this.provider.userMessage(framed.text);
    const messages = [...history, userNative];
    const produced: unknown[] = [];
    const activity: ToolActivity[] = [];
    if (framed.sources?.length) {
      const a: ToolActivity = { tool: "context", label: `Found ${framed.sources.length} related record${framed.sources.length === 1 ? "" : "s"}`, sources: framed.sources };
      activity.push(a);
      emit({ type: "tool", activity: a });
    }

    let answer = "";
    let failure: string | null = null;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        let sep = answer && !answer.endsWith("\n") ? "\n\n" : "";
        const turn = await this.provider.step({
          system,
          messages,
          tools: TOOL_SPECS,
          signal,
          onText: (delta) => {
            if (sep) {
              emit({ type: "text", delta: sep });
              answer += sep;
              sep = "";
            }
            answer += delta;
            emit({ type: "text", delta });
          },
        });
        messages.push(turn.native);
        produced.push(turn.native);

        if (turn.stop === "refusal") {
          failure = "The model declined to answer that.";
          break;
        }
        if (turn.stop === "length" && turn.toolCalls.length) {
          failure = "The answer was cut off before it finished. Try a narrower question.";
          break;
        }
        if (!turn.toolCalls.length) break;

        const results: ToolResult[] = [];
        for (const call of turn.toolCalls) {
          const outcome = await this.tools.run(call);
          activity.push(outcome.activity);
          emit({ type: "tool", activity: outcome.activity });
          results.push({ call, output: outcome.output, isError: outcome.isError });
        }
        const resultMessages = this.provider.toolResults(results);
        messages.push(...resultMessages);
        produced.push(...resultMessages);
        if (step === MAX_STEPS - 1) failure = "Stopped after too many lookups. Try a narrower question.";
      }
    } catch (err) {
      failure = signal?.aborted ? "Stopped." : (err as Error).message || "Something went wrong.";
    }

    // A turn that did not finish cleanly is kept for reading but left out of
    // the model's history, so the next question starts from a clean state.
    const complete = !failure;
    const content = failure ? `${answer}${answer ? "\n\n" : ""}_${failure}_` : answer;
    const { id } = await this.db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO ai_messages (conversation_id, role, content, native, provider, model) VALUES ($1, 'user', $2, $3, $4, $5)",
        [conversationId, question, JSON.stringify(complete ? [userNative] : []), this.provider.id, this.provider.model],
      );
      const row = await tx.one<{ id: number }>(
        "INSERT INTO ai_messages (conversation_id, role, content, activity, native, provider, model) VALUES ($1, 'assistant', $2, $3, $4, $5, $6) RETURNING id",
        [conversationId, content, JSON.stringify(activity), JSON.stringify(complete ? produced : []), this.provider.id, this.provider.model],
      );
      await tx.query("UPDATE ai_conversations SET updated_at = now(), provider = $2, model = $3 WHERE id = $1", [conversationId, this.provider.id, this.provider.model]);
      return row!;
    });
    if (failure) emit({ type: "error", message: failure });
    emit({ type: "done", messageId: id });
  }

  private async businessName(): Promise<string> {
    const row = await this.db.one<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [this.books.businessId]);
    return row?.name ?? "the business";
  }
}
