import type { Books } from "../books";
import { CATEGORIES, getCategory, isCategoryId } from "../categories";
import { money } from "../format";
import type { ChatProvider, JsonSchema } from "./provider";

/**
 * The AI step of categorization. The built-in chain (your rules, then merchant
 * knowledge) runs instantly on every import; this pass then takes what the
 * chain was unsure about and asks the model, showing it the business's own
 * past choices. It runs as a separate pass rather than inside the chain
 * because it is slow and costs tokens, and re-running the chain after every
 * rule change must stay free. Results are tagged "ai" and survive re-runs of
 * the chain unless one of your rules matches.
 */

/** AI answers at or above this confidence leave the review queue; the rest stay for a human look. */
export const AI_CLEAR_THRESHOLD = 0.85;
const BATCH = 25;

interface Candidate {
  id: number;
  date: string;
  description: string;
  amount_cents: number;
  category_id: string;
}

interface AiAnswer {
  results: { id: number; category_id: string; confidence: number; reason: string }[];
}

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          category_id: { type: "string", enum: CATEGORIES.map((c) => c.id) },
          confidence: { type: "number", description: "0 to 1" },
          reason: { type: "string", description: "A few words on why" },
        },
        required: ["id", "category_id", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const SYSTEM = `You categorize a small business's bank and card transactions into US tax categories (IRS Schedule C and related forms). For each transaction pick the single best category id from the list. Use the business's own past choices as the strongest signal. Money in from an unknown source might be sales, a refund, a transfer, or a loan; only call it income when the description suggests a customer payment. Clearly personal spending is "owner_draw"; moving money between the business's own accounts is "transfer". Give an honest confidence from 0 to 1: below 0.6 when the description alone can't tell (for example a big-box store or a person's name).

Categories:
${CATEGORIES.map((c) => `- ${c.id}: ${c.name} (${c.kind}). ${c.description}`).join("\n")}`;

export interface AiCategorizeResult {
  considered: number;
  updated: number;
  cleared: number;
}

/**
 * Asks the model about transactions the built-in categorizer was unsure of.
 * With `ids`, only those transactions are considered.
 */
export async function aiCategorize(books: Books, provider: ChatProvider, opts: { ids?: number[]; limit?: number; signal?: AbortSignal } = {}): Promise<AiCategorizeResult> {
  const db = books.db;
  const params: unknown[] = [books.businessId, Math.min(opts.limit ?? 100, 500)];
  const idFilter = opts.ids ? `AND id = ANY($3::int[])` : "";
  if (opts.ids) params.push(opts.ids);
  const candidates = await db.query<Candidate>(
    `SELECT id, date, description, amount_cents, category_id FROM transactions
     WHERE business_id = $1 AND needs_review AND category_source IN ('fallback', 'keyword') ${idFilter}
     ORDER BY date DESC, id DESC LIMIT $2`,
    params,
  );
  const result: AiCategorizeResult = { considered: candidates.length, updated: 0, cleared: 0 };
  if (!candidates.length) return result;

  const examples = await db.query<{ description: string; amount_cents: number; category_id: string }>(
    `SELECT DISTINCT ON (merchant_key) description, amount_cents, category_id FROM transactions
     WHERE business_id = $1 AND category_source IN ('user', 'rule') AND merchant_key <> ''
     ORDER BY merchant_key, updated_at DESC LIMIT 60`,
    [books.businessId],
  );
  const business = await db.one<{ name: string; entity_type: string }>("SELECT name, entity_type FROM businesses WHERE id = $1", [books.businessId]);
  const exampleText = examples.length
    ? `How this business has categorized similar things before:\n${examples.map((e) => `- ${e.description} (${e.amount_cents >= 0 ? "in" : "out"}) -> ${e.category_id}`).join("\n")}\n\n`
    : "";

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const items = batch.map((c) =>
      JSON.stringify({ id: c.id, date: c.date, description: c.description, direction: c.amount_cents >= 0 ? "money in" : "money out", amount: money(Math.abs(c.amount_cents)), current_guess: c.category_id }),
    );
    const prompt = `Business: ${business?.name ?? "a small business"} (${business?.entity_type ?? "sole_prop"}).\n\n${exampleText}Categorize these transactions:\n${items.join("\n")}`;
    const answer = await provider.json<AiAnswer>({ system: SYSTEM, prompt, schema: SCHEMA, signal: opts.signal });
    const byId = new Map(batch.map((c) => [c.id, c]));
    for (const r of answer.results ?? []) {
      const c = byId.get(r.id);
      if (!c || !isCategoryId(r.category_id) || r.category_id === "uncategorized") continue;
      byId.delete(r.id);
      const confidence = Math.max(0, Math.min(0.95, Number(r.confidence) || 0));
      const needsReview = confidence < AI_CLEAR_THRESHOLD;
      const reason = `AI: ${String(r.reason || getCategory(r.category_id).name).slice(0, 200)}`;
      // Skips rows the owner or a rule has touched since this pass started.
      const updated = await db.query(
        `UPDATE transactions SET category_id = $1, category_source = 'ai', confidence = $2, reason = $3, rule_id = NULL, needs_review = $4, updated_at = now()
         WHERE id = $5 AND business_id = $6 AND category_source IN ('fallback', 'keyword') RETURNING id`,
        [r.category_id, confidence, reason, needsReview, c.id, books.businessId],
      );
      if (updated.length) {
        result.updated++;
        if (!needsReview) result.cleared++;
      }
    }
  }
  return result;
}
