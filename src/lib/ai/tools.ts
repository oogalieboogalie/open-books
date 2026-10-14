import { Activity } from "../activity";
import type { Books } from "../books";
import { getCategory, isCategoryId } from "../categories";
import { money } from "../format";
import { buildScheduleC } from "../reports";
import { autoGranularity, type Granularity } from "../timeline";
import type { Knowledge, SourceType } from "./knowledge";
import type { JsonSchema, ToolCall, ToolSpec } from "./provider";

/**
 * What the assistant can do with the books. Reads are free; the two writes
 * (recategorizing a transaction, adding a rule) are only used when the owner
 * asks, and every call is shown in the conversation.
 */

export interface Source {
  type: SourceType;
  id: string;
  title: string;
  date: string | null;
}

export interface ToolActivity {
  tool: string;
  label: string;
  /** True when the call changed the books. */
  changed?: boolean;
  error?: boolean;
  sources?: Source[];
}

export interface ToolOutcome {
  output: string;
  isError?: boolean;
  activity: ToolActivity;
}

const ISO = { type: "string", description: "Date as YYYY-MM-DD" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "search_records",
    description:
      "Search everything in the books by meaning and keywords: transactions, events (social posts, promotions, emails), monthly summaries, and categorization rules. Use it to find records when you don't know exact dates or names, e.g. 'website redesign', 'fall promotion', 'equipment purchases'.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in plain words" },
        types: { type: "array", items: { type: "string", enum: ["transaction", "event", "month", "rule"] }, description: "Limit to these kinds of records" },
        from: ISO,
        to: ISO,
        limit: { type: "integer", description: "1 to 25, default 10" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "find_transactions",
    description:
      "List transactions that match exact filters, with the total. Use for questions like 'what did I spend at Home Depot in March' or 'show deposits over $1,000 this year'. Amounts are in dollars and always positive in filters.",
    parameters: {
      type: "object",
      properties: {
        from: ISO,
        to: ISO,
        category_id: { type: "string", description: "A category id from the list in your instructions" },
        text: { type: "string", description: "Words that appear in the description or notes" },
        direction: { type: "string", enum: ["in", "out"], description: "Money in (deposits) or out (spending)" },
        min_amount: { type: "number" },
        max_amount: { type: "number" },
        needs_review: { type: "boolean", description: "Only transactions waiting for the owner's review" },
        limit: { type: "integer", description: "1 to 100, default 25" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "summarize_period",
    description:
      "Income, expenses, and net for a date range, broken down by category and by top merchant, plus the events, tracked numbers (contacts, appointments, leads...), and link clicks in that range.",
    parameters: { type: "object", properties: { from: ISO, to: ISO }, required: ["from", "to"], additionalProperties: false },
  },
  {
    name: "tax_summary",
    description: "The year's Schedule C summary (gross receipts, expenses by line, net profit) with an estimate of self-employment tax.",
    parameters: { type: "object", properties: { year: { type: "integer" } }, required: ["year"], additionalProperties: false },
  },
  {
    name: "timeline",
    description:
      "Income and expenses per day, week, or month over a range, side by side with events and tracked numbers. Use to spot trends or to see what happened around a post or promotion.",
    parameters: {
      type: "object",
      properties: { from: ISO, to: ISO, granularity: { type: "string", enum: ["day", "week", "month"] } },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "set_category",
    description:
      "Change one transaction's category. Only use when the owner asks you to. With remember=true, also creates a rule so this merchant is categorized this way from now on.",
    parameters: {
      type: "object",
      properties: { transaction_id: { type: "integer" }, category_id: { type: "string" }, remember: { type: "boolean" } },
      required: ["transaction_id", "category_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_rule",
    description:
      "Create a categorization rule and apply it to existing and future transactions. Only use when the owner asks you to. pattern is merchant words, e.g. 'adobe'.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, category_id: { type: "string" }, direction: { type: "string", enum: ["any", "in", "out"] } },
      required: ["pattern", "category_id"],
      additionalProperties: false,
    },
  },
];

/** Checks model-supplied input against a tool's schema. Returns an error message, or null when valid. */
export function validateInput(schema: JsonSchema, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Input must be an object.";
  const obj = input as Record<string, unknown>;
  for (const key of schema.required ?? []) if (obj[key] === undefined || obj[key] === null) return `Missing "${key}".`;
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key] as { type?: string; enum?: string[]; items?: { enum?: string[] } } | undefined;
    if (!prop) {
      if (schema.additionalProperties === false) return `Unknown field "${key}".`;
      continue;
    }
    if (value === null || value === undefined) continue;
    const ok =
      prop.type === "string" ? typeof value === "string" :
      prop.type === "integer" ? Number.isInteger(value) :
      prop.type === "number" ? typeof value === "number" && Number.isFinite(value) :
      prop.type === "boolean" ? typeof value === "boolean" :
      prop.type === "array" ? Array.isArray(value) : true;
    if (!ok) return `"${key}" should be ${prop.type === "integer" ? "a whole number" : `a ${prop.type}`}.`;
    if (prop.enum && !prop.enum.includes(value as string)) return `"${key}" must be one of ${prop.enum.join(", ")}.`;
    if (prop.type === "array" && prop.items?.enum && !(value as unknown[]).every((v) => prop.items!.enum!.includes(v as string))) {
      return `"${key}" values must be from ${prop.items.enum.join(", ")}.`;
    }
    if (schema.properties[key] === ISO && !DATE_RE.test(value as string)) return `"${key}" must be a date like 2026-03-31.`;
  }
  return null;
}

const dollars = (cents: number) => money(cents);

export class AssistantTools {
  private readonly activity: Activity;

  constructor(
    private books: Books,
    private knowledge: Knowledge,
  ) {
    this.activity = Activity.for(books);
  }

  async run(call: ToolCall): Promise<ToolOutcome> {
    const spec = TOOL_SPECS.find((t) => t.name === call.name);
    if (!spec) return this.fail(call, `There is no tool named ${call.name}.`);
    const problem = validateInput(spec.parameters, call.input);
    if (problem) return this.fail(call, problem);
    try {
      // Validated against the tool's schema above.
      const a = call.input as never;
      switch (call.name) {
        case "search_records":
          return await this.searchRecords(a);
        case "find_transactions":
          return await this.findTransactions(a);
        case "summarize_period":
          return await this.summarizePeriod(a);
        case "tax_summary":
          return await this.taxSummary(a);
        case "timeline":
          return await this.timeline(a);
        case "set_category":
          return await this.setCategory(a);
        case "create_rule":
          return await this.createRule(a);
      }
    } catch (err) {
      return this.fail(call, (err as Error).message);
    }
    return this.fail(call, "Not implemented.");
  }

  private fail(call: ToolCall, message: string): ToolOutcome {
    return { output: message, isError: true, activity: { tool: call.name, label: `${call.name}: ${message}`, error: true } };
  }

  private async searchRecords(a: { query: string; types?: SourceType[]; from?: string; to?: string; limit?: number }): Promise<ToolOutcome> {
    const hits = await this.knowledge.search(a.query, { types: a.types, from: a.from, to: a.to, limit: Math.min(a.limit ?? 10, 25) });
    return {
      output: hits.length ? JSON.stringify(hits.map((h) => ({ type: h.sourceType, id: h.sourceId, date: h.date, text: h.content }))) : "No matching records.",
      activity: {
        tool: "search_records",
        label: `Searched the books for "${a.query}" (${hits.length} found)`,
        sources: hits.map((h) => ({ type: h.sourceType, id: h.sourceId, title: h.title, date: h.date })),
      },
    };
  }

  private async findTransactions(a: {
    from?: string; to?: string; category_id?: string; text?: string; direction?: "in" | "out";
    min_amount?: number; max_amount?: number; needs_review?: boolean; limit?: number;
  }): Promise<ToolOutcome> {
    const params: unknown[] = [this.books.businessId];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = ["t.business_id = $1"];
    if (a.from) where.push(`t.date >= ${p(a.from)}`);
    if (a.to) where.push(`t.date <= ${p(a.to)}`);
    if (a.category_id) where.push(`t.category_id = ${p(a.category_id)}`);
    if (a.text) {
      const term = p(`%${a.text}%`);
      where.push(`(t.description ILIKE ${term} OR t.notes ILIKE ${term})`);
    }
    if (a.direction === "in") where.push("t.amount_cents > 0");
    if (a.direction === "out") where.push("t.amount_cents < 0");
    if (a.min_amount != null) where.push(`ABS(t.amount_cents) >= ${p(Math.round(a.min_amount * 100))}`);
    if (a.max_amount != null) where.push(`ABS(t.amount_cents) <= ${p(Math.round(a.max_amount * 100))}`);
    if (a.needs_review) where.push("t.needs_review");
    const w = where.join(" AND ");
    const db = this.books.db;
    const totals = (await db.one<{ n: number; total: number }>(`SELECT COUNT(*)::int AS n, COALESCE(SUM(t.amount_cents), 0)::bigint AS total FROM transactions t WHERE ${w}`, params))!;
    const limit = Math.min(Math.max(a.limit ?? 25, 1), 100);
    const rows = await db.query<{ id: number; date: string; description: string; amount_cents: number; category_id: string; notes: string; needs_review: boolean }>(
      `SELECT t.id, t.date, t.description, t.amount_cents, t.category_id, t.notes, t.needs_review FROM transactions t WHERE ${w} ORDER BY t.date DESC, t.id DESC LIMIT ${limit}`,
      params,
    );
    const out = {
      matching: totals.n,
      net_total: dollars(totals.total),
      shown: rows.length,
      transactions: rows.map((r) => ({
        id: r.id,
        date: r.date,
        description: r.description,
        amount: dollars(r.amount_cents),
        category: getCategory(r.category_id).name,
        category_id: r.category_id,
        ...(r.notes ? { notes: r.notes } : {}),
        ...(r.needs_review ? { needs_review: true } : {}),
      })),
    };
    const range = a.from || a.to ? ` from ${a.from ?? "the start"} to ${a.to ?? "today"}` : "";
    return {
      output: JSON.stringify(out),
      activity: {
        tool: "find_transactions",
        label: `Looked up transactions${a.text ? ` matching "${a.text}"` : ""}${range} (${totals.n} found)`,
        sources: rows.slice(0, 12).map((r) => ({ type: "transaction" as const, id: String(r.id), title: r.description, date: r.date })),
      },
    };
  }

  private async summarizePeriod(a: { from: string; to: string }): Promise<ToolOutcome> {
    const detail = await this.activity.periodDetail(a.from, a.to, this.books);
    const db = this.books.db;
    const [cats, merchants] = await Promise.all([
      db.query<{ category_id: string; total: number; n: number }>(
        "SELECT category_id, SUM(amount_cents)::bigint AS total, COUNT(*)::int AS n FROM transactions WHERE business_id = $1 AND date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY ABS(SUM(amount_cents)) DESC",
        [this.books.businessId, a.from, a.to],
      ),
      db.query<{ merchant: string; total: number; n: number }>(
        `SELECT COALESCE(NULLIF(merchant_key, ''), description) AS merchant, SUM(amount_cents)::bigint AS total, COUNT(*)::int AS n
         FROM transactions WHERE business_id = $1 AND date BETWEEN $2 AND $3 AND amount_cents < 0 GROUP BY 1 ORDER BY SUM(amount_cents) LIMIT 10`,
        [this.books.businessId, a.from, a.to],
      ),
    ]);
    const metricTotals = new Map<string, number>();
    for (const m of detail.metrics) metricTotals.set(m.name, (metricTotals.get(m.name) ?? 0) + m.value);
    const out = {
      from: a.from,
      to: a.to,
      income: dollars(detail.incomeCents),
      expenses: dollars(detail.expenseCents),
      net: dollars(detail.incomeCents - detail.expenseCents),
      transaction_count: detail.transactionCount,
      by_category: cats.map((c) => ({ category: getCategory(c.category_id).name, kind: getCategory(c.category_id).kind, total: dollars(c.total), count: c.n })),
      top_spending_merchants: merchants.map((m) => ({ merchant: m.merchant, total: dollars(-m.total), count: m.n })),
      events: detail.events.map((e) => ({ date: e.date, kind: e.kind, title: e.title, ...(e.linkSlug ? { link: `/go/${e.linkSlug}` } : {}) })),
      tracked_numbers: Object.fromEntries(metricTotals),
      link_clicks: detail.clicks.map((c) => ({ link: `/go/${c.slug}`, clicks: c.count, event: c.eventTitle })),
    };
    return {
      output: JSON.stringify(out),
      activity: {
        tool: "summarize_period",
        label: `Summarized ${a.from} to ${a.to}`,
        sources: detail.events.slice(0, 8).map((e) => ({ type: "event" as const, id: String(e.id), title: e.title, date: e.date })),
      },
    };
  }

  private async taxSummary(a: { year: number }): Promise<ToolOutcome> {
    const s = buildScheduleC(await this.books.categoryTotals(a.year), a.year);
    const out = {
      year: s.year,
      line_1_gross_receipts: dollars(s.grossReceiptsCents),
      line_2_returns: dollars(s.returnsCents),
      line_4_cogs: dollars(s.cogsCents),
      line_7_gross_income: dollars(s.grossIncomeCents),
      expenses: s.expenseLines.map((l) => ({ line: l.line, label: l.label, spent: dollars(l.amountCents), deductible: dollars(l.deductibleCents) })),
      line_28_total_expenses: dollars(s.totalExpensesCents),
      line_31_net_profit: dollars(s.netProfitCents),
      other_deductions: s.otherDeductions.map((d) => ({ name: d.category.name, where: d.category.taxLine, amount: dollars(d.amountCents) })),
      uncategorized: dollars(s.uncategorizedCents),
      self_employment_tax_estimate: dollars(s.seTax.totalCents),
      deductible_half_of_se_tax: dollars(s.seTax.deductibleHalfCents),
      waiting_for_review: await this.books.reviewCount(),
    };
    return { output: JSON.stringify(out), activity: { tool: "tax_summary", label: `Pulled the ${a.year} Schedule C summary` } };
  }

  private async timeline(a: { from: string; to: string; granularity?: Granularity }): Promise<ToolOutcome> {
    const g = a.granularity ?? autoGranularity(a.from, a.to);
    const t = await this.activity.timeline(a.from, a.to, g);
    // Long daily ranges are summarized by week so the answer stays readable.
    const buckets = t.buckets.slice(0, 120).map((b, i) => ({
      period: b.label,
      start: b.start,
      income: dollars(b.incomeCents),
      expenses: dollars(b.expenseCents),
      ...Object.fromEntries(t.series.filter((s) => s.values[i]).map((s) => [s.name, s.values[i]])),
      ...(t.events.some((e) => e.bucket === i) ? { events: t.events.filter((e) => e.bucket === i).map((e) => e.title) } : {}),
    }));
    return {
      output: JSON.stringify({ granularity: g, periods: buckets, truncated: t.buckets.length > 120 }),
      activity: { tool: "timeline", label: `Read the timeline by ${g} from ${a.from} to ${a.to}` },
    };
  }

  private async setCategory(a: { transaction_id: number; category_id: string; remember?: boolean }): Promise<ToolOutcome> {
    if (!isCategoryId(a.category_id)) throw new Error(`Unknown category "${a.category_id}".`);
    const tx = await this.books.getTransaction(a.transaction_id);
    if (!tx) throw new Error(`Transaction #${a.transaction_id} was not found.`);
    const { ruleId } = await this.books.setCategory(tx.id, a.category_id, { remember: a.remember });
    const name = getCategory(a.category_id).name;
    return {
      output: `Done. #${tx.id} "${tx.description}" is now ${name}${ruleId ? ", and a rule now applies it to this merchant" : ""}.`,
      activity: {
        tool: "set_category",
        label: `Changed "${tx.description}" (${tx.date}) to ${name}${ruleId ? " and remembered it" : ""}`,
        changed: true,
        sources: [{ type: "transaction", id: String(tx.id), title: tx.description, date: tx.date }],
      },
    };
  }

  private async createRule(a: { pattern: string; category_id: string; direction?: "any" | "in" | "out" }): Promise<ToolOutcome> {
    if (!isCategoryId(a.category_id)) throw new Error(`Unknown category "${a.category_id}".`);
    const before = await this.books.reviewCount();
    await this.books.createRule({ pattern: a.pattern, categoryId: a.category_id, direction: a.direction ?? "any" });
    const after = await this.books.reviewCount();
    const name = getCategory(a.category_id).name;
    return {
      output: `Rule saved: "${a.pattern}" goes to ${name}. Review queue went from ${before} to ${after}.`,
      activity: { tool: "create_rule", label: `Added a rule: "${a.pattern}" goes to ${name}`, changed: true },
    };
  }
}
