import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getCategory, isCategoryId } from "./categories";
import { categorize, defaultClassifiers, REVIEW_THRESHOLD, type MatchType, type Suggestion, type UserRule } from "./categorize/engine";
import { merchantKey, normalizeDescription } from "./categorize/normalize";
import type { ImportedRow } from "./csv";
import { transaction } from "./db";

export const ACCOUNT_TYPES = ["checking", "savings", "credit_card", "cash", "other"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface Account {
  id: number;
  name: string;
  type: AccountType;
}

export interface Transaction {
  id: number;
  accountId: number | null;
  accountName: string | null;
  date: string;
  description: string;
  merchantKey: string;
  amountCents: number;
  categoryId: string;
  categorySource: Suggestion["source"] | "user";
  confidence: number;
  reason: string;
  needsReview: boolean;
  notes: string;
}

export interface TransactionFilter {
  year?: number;
  categoryId?: string;
  needsReview?: boolean;
  search?: string;
  accountId?: number;
  limit?: number;
  offset?: number;
}

export interface NewTransaction {
  date: string;
  description: string;
  amountCents: number;
  accountId?: number | null;
  categoryId?: string;
  notes?: string;
}

interface TxRow {
  id: number;
  account_id: number | null;
  account_name: string | null;
  date: string;
  description: string;
  merchant_key: string;
  amount_cents: number;
  category_id: string;
  category_source: Transaction["categorySource"];
  confidence: number;
  reason: string;
  needs_review: number;
  notes: string;
}

const toTransaction = (r: TxRow): Transaction => ({
  id: r.id,
  accountId: r.account_id,
  accountName: r.account_name,
  date: r.date,
  description: r.description,
  merchantKey: r.merchant_key,
  amountCents: r.amount_cents,
  categoryId: r.category_id,
  categorySource: r.category_source,
  confidence: r.confidence,
  reason: r.reason,
  needsReview: r.needs_review === 1,
  notes: r.notes,
});

/**
 * All bookkeeping reads and writes for one business. Every query is scoped by
 * business id so the same database can later hold many businesses and users.
 */
export class Books {
  constructor(
    private db: DatabaseSync,
    readonly businessId: number,
  ) {}

  static forDefaultBusiness(db: DatabaseSync): Books {
    const existing = db.prepare("SELECT id FROM businesses ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (existing) return new Books(db, existing.id);
    const res = db.prepare("INSERT INTO businesses (name) VALUES (?)").run("My Business");
    const books = new Books(db, Number(res.lastInsertRowid));
    books.createAccount("Business checking", "checking");
    return books;
  }

  // Accounts

  listAccounts(): Account[] {
    // node:sqlite returns null-prototype rows; copy them into plain objects so they can cross into client components.
    return this.db.prepare("SELECT id, name, type FROM accounts WHERE business_id = ? ORDER BY id").all(this.businessId).map((r) => ({ ...r }) as unknown as Account);
  }

  createAccount(name: string, type: AccountType): number {
    if (!ACCOUNT_TYPES.includes(type)) throw new Error("Unknown account type");
    const res = this.db.prepare("INSERT INTO accounts (business_id, name, type) VALUES (?, ?, ?)").run(this.businessId, name.trim(), type);
    return Number(res.lastInsertRowid);
  }

  private assertAccount(accountId: number | null | undefined): number | null {
    if (accountId == null) return null;
    const row = this.db.prepare("SELECT id FROM accounts WHERE id = ? AND business_id = ?").get(accountId, this.businessId);
    if (!row) throw new Error("Account not found");
    return accountId;
  }

  // Rules

  listRules(): UserRule[] {
    return this.db
      .prepare("SELECT id, pattern, match_type AS matchType, direction, category_id AS categoryId FROM rules WHERE business_id = ? ORDER BY pattern")
      .all(this.businessId)
      .map((r) => ({ ...r }) as unknown as UserRule);
  }

  /** Creates (or updates) a rule and applies it to every transaction the user has not categorized by hand. */
  createRule(input: { pattern: string; categoryId: string; matchType?: MatchType; direction?: UserRule["direction"] }): number {
    if (!isCategoryId(input.categoryId)) throw new Error("Unknown category");
    const pattern = normalizeDescription(input.pattern);
    if (!pattern) throw new Error("Pattern is empty");
    const matchType = input.matchType ?? "contains";
    const direction = input.direction ?? "any";
    if (!["contains", "starts_with", "exact"].includes(matchType)) throw new Error("Unknown match type");
    if (!["any", "in", "out"].includes(direction)) throw new Error("Unknown direction");
    const row = this.db
      .prepare(
        `INSERT INTO rules (business_id, pattern, match_type, direction, category_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (business_id, pattern, match_type, direction) DO UPDATE SET category_id = excluded.category_id
         RETURNING id`,
      )
      .get(this.businessId, pattern, matchType, direction, input.categoryId) as { id: number };
    this.recategorize();
    return row.id;
  }

  deleteRule(id: number) {
    this.db.prepare("DELETE FROM rules WHERE id = ? AND business_id = ?").run(id, this.businessId);
    this.recategorize();
  }

  suggest(description: string, amountCents: number): Suggestion {
    return categorize({ description, amountCents }, defaultClassifiers(this.listRules()));
  }

  /** Re-runs categorization on everything not set by hand. Returns how many changed. */
  recategorize(): number {
    const classifiers = defaultClassifiers(this.listRules());
    const rows = this.db
      .prepare("SELECT id, description, amount_cents, category_id, rule_id, confidence FROM transactions WHERE business_id = ? AND category_source != 'user'")
      .all(this.businessId) as { id: number; description: string; amount_cents: number; category_id: string; rule_id: number | null; confidence: number }[];
    const update = this.db.prepare(
      "UPDATE transactions SET category_id = ?, category_source = ?, confidence = ?, reason = ?, rule_id = ?, needs_review = ?, updated_at = datetime('now') WHERE id = ?",
    );
    let changed = 0;
    transaction(this.db, () => {
      for (const r of rows) {
        const s = categorize({ description: r.description, amountCents: r.amount_cents }, classifiers);
        if (s.categoryId === r.category_id && (s.ruleId ?? null) === r.rule_id && s.confidence === r.confidence) continue;
        update.run(s.categoryId, s.source, s.confidence, s.reason, s.ruleId ?? null, s.confidence < REVIEW_THRESHOLD ? 1 : 0, r.id);
        changed++;
      }
    });
    return changed;
  }

  // Transactions

  listTransactions(filter: TransactionFilter = {}): { rows: Transaction[]; total: number } {
    const where = ["t.business_id = ?"];
    const params: SQLInputValue[] = [this.businessId];
    if (filter.year) {
      where.push("t.date >= ? AND t.date < ?");
      params.push(`${filter.year}-01-01`, `${filter.year + 1}-01-01`);
    }
    if (filter.categoryId) {
      where.push("t.category_id = ?");
      params.push(filter.categoryId);
    }
    if (filter.needsReview) where.push("t.needs_review = 1");
    if (filter.accountId) {
      where.push("t.account_id = ?");
      params.push(filter.accountId);
    }
    if (filter.search) {
      where.push("(t.description LIKE ? OR t.notes LIKE ?)");
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    const whereSql = where.join(" AND ");
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${whereSql}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(
        `SELECT t.*, a.name AS account_name FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
         WHERE ${whereSql} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit ?? 100, filter.offset ?? 0) as unknown as TxRow[];
    return { rows: rows.map(toTransaction), total };
  }

  getTransaction(id: number): Transaction | null {
    const row = this.db
      .prepare("SELECT t.*, a.name AS account_name FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ? AND t.business_id = ?")
      .get(id, this.businessId) as TxRow | undefined;
    return row ? toTransaction(row) : null;
  }

  addTransaction(input: NewTransaction, importHash: string | null = null): number | null {
    const accountId = this.assertAccount(input.accountId);
    const description = input.description.trim();
    let s: Suggestion | { categoryId: string; source: "user"; confidence: number; reason: string; ruleId?: undefined };
    if (input.categoryId && input.categoryId !== "uncategorized") {
      if (!isCategoryId(input.categoryId)) throw new Error("Unknown category");
      s = { categoryId: input.categoryId, source: "user", confidence: 1, reason: "Set by you" };
    } else {
      s = this.suggest(description, input.amountCents);
    }
    const res = this.db
      .prepare(
        `INSERT INTO transactions (business_id, account_id, date, description, merchant_key, amount_cents, category_id, category_source, confidence, reason, rule_id, needs_review, notes, import_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        this.businessId,
        accountId,
        input.date,
        description,
        merchantKey(description),
        input.amountCents,
        s.categoryId,
        s.source,
        s.confidence,
        s.reason,
        s.ruleId ?? null,
        s.confidence < REVIEW_THRESHOLD ? 1 : 0,
        input.notes ?? "",
        importHash,
      );
    return res.changes === 0 ? null : Number(res.lastInsertRowid);
  }

  /**
   * Imports parsed CSV rows. Re-importing the same file (or an overlapping date
   * range) skips rows already present, including legitimately repeated rows such
   * as two identical coffees on the same day.
   */
  importRows(accountId: number, rows: ImportedRow[]): { imported: number; duplicates: number; needsReview: number } {
    this.assertAccount(accountId);
    const seen = new Map<string, number>();
    let imported = 0;
    let duplicates = 0;
    let needsReview = 0;
    transaction(this.db, () => {
      for (const row of rows) {
        const base = `${accountId}|${row.date}|${row.amountCents}|${normalizeDescription(row.description)}`;
        const occurrence = (seen.get(base) ?? 0) + 1;
        seen.set(base, occurrence);
        const hash = createHash("sha256").update(`${base}|${occurrence}`).digest("hex");
        const id = this.addTransaction({ ...row, accountId }, hash);
        if (id === null) {
          duplicates++;
        } else {
          imported++;
          if (this.getTransaction(id)?.needsReview) needsReview++;
        }
      }
    });
    return { imported, duplicates, needsReview };
  }

  /**
   * Sets a category by hand. With `remember`, also creates a rule for this
   * merchant so future and existing matching transactions follow it.
   */
  setCategory(id: number, categoryId: string, opts: { remember?: boolean } = {}): { ruleId?: number } {
    if (!isCategoryId(categoryId)) throw new Error("Unknown category");
    const tx = this.getTransaction(id);
    if (!tx) throw new Error("Transaction not found");
    this.db
      .prepare(
        "UPDATE transactions SET category_id = ?, category_source = 'user', confidence = 1, reason = 'Set by you', rule_id = NULL, needs_review = 0, updated_at = datetime('now') WHERE id = ? AND business_id = ?",
      )
      .run(categoryId, id, this.businessId);
    if (opts.remember && tx.merchantKey && categoryId !== "uncategorized") {
      const kind = getCategory(categoryId).kind;
      // Income and expense rules only fire in the matching direction, so a refund
      // from a vendor is not mistaken for sales and vice versa.
      const direction = kind === "income" ? "in" : kind === "non_pl" ? "any" : tx.amountCents < 0 ? "out" : "any";
      return { ruleId: this.createRule({ pattern: tx.merchantKey, categoryId, direction }) };
    }
    return {};
  }

  markReviewed(id: number) {
    this.db.prepare("UPDATE transactions SET needs_review = 0, updated_at = datetime('now') WHERE id = ? AND business_id = ?").run(id, this.businessId);
  }

  updateNotes(id: number, notes: string) {
    this.db.prepare("UPDATE transactions SET notes = ?, updated_at = datetime('now') WHERE id = ? AND business_id = ?").run(notes, id, this.businessId);
  }

  deleteTransaction(id: number) {
    this.db.prepare("DELETE FROM transactions WHERE id = ? AND business_id = ?").run(id, this.businessId);
  }

  // Reporting

  /** Signed totals per category for a year. */
  categoryTotals(year: number): Map<string, number> {
    const rows = this.db
      .prepare("SELECT category_id, SUM(amount_cents) AS total FROM transactions WHERE business_id = ? AND date >= ? AND date < ? GROUP BY category_id")
      .all(this.businessId, `${year}-01-01`, `${year + 1}-01-01`) as { category_id: string; total: number }[];
    return new Map(rows.map((r) => [r.category_id, r.total]));
  }

  monthlyTotals(year: number): { month: number; incomeCents: number; expenseCents: number }[] {
    const rows = this.db
      .prepare("SELECT CAST(substr(date, 6, 2) AS INTEGER) AS month, category_id, SUM(amount_cents) AS total FROM transactions WHERE business_id = ? AND date >= ? AND date < ? GROUP BY month, category_id")
      .all(this.businessId, `${year}-01-01`, `${year + 1}-01-01`) as { month: number; category_id: string; total: number }[];
    const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, incomeCents: 0, expenseCents: 0 }));
    for (const r of rows) {
      const kind = getCategory(r.category_id).kind;
      if (kind === "income") months[r.month - 1].incomeCents += r.total;
      else if (kind === "expense" || kind === "cogs") months[r.month - 1].expenseCents += -r.total;
    }
    return months;
  }

  reviewCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE business_id = ? AND needs_review = 1").get(this.businessId) as { n: number }).n;
  }

  years(): number[] {
    const rows = this.db.prepare("SELECT DISTINCT CAST(substr(date, 1, 4) AS INTEGER) AS y FROM transactions WHERE business_id = ? ORDER BY y DESC").all(this.businessId) as { y: number }[];
    return rows.map((r) => r.y);
  }
}
