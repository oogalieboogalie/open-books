import { createHash } from "node:crypto";
import { getCategory, isCategoryId } from "./categories";
import { categorize, defaultClassifiers, REVIEW_THRESHOLD, type MatchType, type Suggestion, type UserRule } from "./categorize/engine";
import { merchantKey, normalizeDescription } from "./categorize/normalize";
import type { ImportedRow } from "./csv";
import type { Db } from "./db";

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
  /** A receipt matched to this transaction, if any. */
  receiptId: number | null;
}

export interface TransactionFilter {
  year?: number;
  /** Inclusive YYYY-MM-DD bounds. */
  from?: string;
  to?: string;
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
  /** Where it came from, such as "sheet:3". Empty for typed or CSV entries. */
  source?: string;
}

const TX_COLUMNS = `t.id, t.account_id AS "accountId", a.name AS "accountName", t.date, t.description, t.merchant_key AS "merchantKey",
  t.amount_cents AS "amountCents", t.category_id AS "categoryId", t.category_source AS "categorySource", t.confidence, t.reason,
  t.needs_review AS "needsReview", t.notes,
  (SELECT r.id FROM receipts r WHERE r.transaction_id = t.id ORDER BY r.id LIMIT 1) AS "receiptId"`;

/**
 * All bookkeeping reads and writes for one business. Every query is scoped by
 * business id so the same database can hold many businesses and users.
 */
export class Books {
  constructor(
    readonly db: Db,
    readonly businessId: number,
  ) {}

  static async forDefaultBusiness(db: Db): Promise<Books> {
    return db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(727275)");
      const existing = await tx.one<{ id: number }>("SELECT id FROM businesses ORDER BY id LIMIT 1");
      if (existing) return new Books(db, existing.id);
      const created = await tx.one<{ id: number }>("INSERT INTO businesses (name) VALUES ('My Business') RETURNING id");
      await new Books(tx, created!.id).createAccount("Business checking", "checking");
      return new Books(db, created!.id);
    });
  }

  /** Runs `fn` with a Books bound to a single database transaction. */
  private inTransaction<T>(fn: (books: Books) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new Books(tx, this.businessId)));
  }

  // Accounts

  listAccounts(): Promise<Account[]> {
    return this.db.query<Account>("SELECT id, name, type FROM accounts WHERE business_id = $1 ORDER BY id", [this.businessId]);
  }

  async createAccount(name: string, type: AccountType): Promise<number> {
    if (!ACCOUNT_TYPES.includes(type)) throw new Error("Unknown account type");
    const row = await this.db.one<{ id: number }>("INSERT INTO accounts (business_id, name, type) VALUES ($1, $2, $3) RETURNING id", [this.businessId, name.trim(), type]);
    return row!.id;
  }

  private async assertAccount(accountId: number | null | undefined): Promise<number | null> {
    if (accountId == null) return null;
    const row = await this.db.one("SELECT id FROM accounts WHERE id = $1 AND business_id = $2", [accountId, this.businessId]);
    if (!row) throw new Error("Account not found");
    return accountId;
  }

  // Rules

  listRules(): Promise<UserRule[]> {
    return this.db.query<UserRule>(
      `SELECT id, pattern, match_type AS "matchType", direction, category_id AS "categoryId" FROM rules WHERE business_id = $1 ORDER BY pattern`,
      [this.businessId],
    );
  }

  /** Creates (or updates) a rule and applies it to every transaction the user has not categorized by hand. */
  async createRule(input: { pattern: string; categoryId: string; matchType?: MatchType; direction?: UserRule["direction"] }): Promise<number> {
    if (!isCategoryId(input.categoryId)) throw new Error("Unknown category");
    const pattern = normalizeDescription(input.pattern);
    if (!pattern) throw new Error("Pattern is empty");
    const matchType = input.matchType ?? "contains";
    const direction = input.direction ?? "any";
    if (!["contains", "starts_with", "exact"].includes(matchType)) throw new Error("Unknown match type");
    if (!["any", "in", "out"].includes(direction)) throw new Error("Unknown direction");
    return this.inTransaction(async (books) => {
      const row = await books.db.one<{ id: number }>(
        `INSERT INTO rules (business_id, pattern, match_type, direction, category_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (business_id, pattern, match_type, direction) DO UPDATE SET category_id = excluded.category_id
         RETURNING id`,
        [this.businessId, pattern, matchType, direction, input.categoryId],
      );
      await books.recategorize();
      return row!.id;
    });
  }

  async deleteRule(id: number): Promise<void> {
    await this.inTransaction(async (books) => {
      await books.db.query("DELETE FROM rules WHERE id = $1 AND business_id = $2", [id, this.businessId]);
      await books.recategorize();
    });
  }

  async suggest(description: string, amountCents: number): Promise<Suggestion> {
    return categorize({ description, amountCents }, defaultClassifiers(await this.listRules()));
  }

  /** Re-runs categorization on everything not set by hand. Returns how many changed. */
  async recategorize(): Promise<number> {
    const classifiers = defaultClassifiers(await this.listRules());
    const rows = await this.db.query<{ id: number; description: string; amount_cents: number; category_id: string; rule_id: number | null; confidence: number }>(
      "SELECT id, description, amount_cents, category_id, rule_id, confidence FROM transactions WHERE business_id = $1 AND category_source <> 'user'",
      [this.businessId],
    );
    let changed = 0;
    for (const r of rows) {
      const s = categorize({ description: r.description, amountCents: r.amount_cents }, classifiers);
      if (s.categoryId === r.category_id && (s.ruleId ?? null) === r.rule_id && s.confidence === r.confidence) continue;
      await this.db.query(
        "UPDATE transactions SET category_id = $1, category_source = $2, confidence = $3, reason = $4, rule_id = $5, needs_review = $6, updated_at = now() WHERE id = $7",
        [s.categoryId, s.source, s.confidence, s.reason, s.ruleId ?? null, s.confidence < REVIEW_THRESHOLD, r.id],
      );
      changed++;
    }
    return changed;
  }

  // Transactions

  async listTransactions(filter: TransactionFilter = {}): Promise<{ rows: Transaction[]; total: number }> {
    const params: unknown[] = [this.businessId];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = ["t.business_id = $1"];
    if (filter.year) where.push(`t.date >= ${p(`${filter.year}-01-01`)} AND t.date < ${p(`${filter.year + 1}-01-01`)}`);
    if (filter.from) where.push(`t.date >= ${p(filter.from)}`);
    if (filter.to) where.push(`t.date <= ${p(filter.to)}`);
    if (filter.categoryId) where.push(`t.category_id = ${p(filter.categoryId)}`);
    if (filter.needsReview) where.push("t.needs_review");
    if (filter.accountId) where.push(`t.account_id = ${p(filter.accountId)}`);
    if (filter.search) {
      const term = p(`%${filter.search}%`);
      where.push(`(t.description ILIKE ${term} OR t.notes ILIKE ${term})`);
    }
    const whereSql = where.join(" AND ");
    const total = (await this.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM transactions t WHERE ${whereSql}`, params))!.n;
    const rows = await this.db.query<Transaction>(
      `SELECT ${TX_COLUMNS} FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE ${whereSql} ORDER BY t.date DESC, t.id DESC LIMIT ${p(filter.limit ?? 100)} OFFSET ${p(filter.offset ?? 0)}`,
      params,
    );
    return { rows, total };
  }

  async getTransaction(id: number): Promise<Transaction | null> {
    const row = await this.db.one<Transaction>(
      `SELECT ${TX_COLUMNS} FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = $1 AND t.business_id = $2`,
      [id, this.businessId],
    );
    return row ?? null;
  }

  /** Adds a transaction, categorizing it unless a category is given. Returns null if it was a duplicate import. */
  async addTransaction(input: NewTransaction, importHash: string | null = null, rules?: UserRule[]): Promise<{ id: number; needsReview: boolean } | null> {
    const accountId = await this.assertAccount(input.accountId);
    const description = input.description.trim();
    let s: Pick<Suggestion, "categoryId" | "confidence" | "reason" | "ruleId"> & { source: Transaction["categorySource"] };
    if (input.categoryId && input.categoryId !== "uncategorized") {
      if (!isCategoryId(input.categoryId)) throw new Error("Unknown category");
      s = { categoryId: input.categoryId, source: "user", confidence: 1, reason: "Set by you" };
    } else {
      s = categorize({ description, amountCents: input.amountCents }, defaultClassifiers(rules ?? (await this.listRules())));
    }
    const needsReview = s.confidence < REVIEW_THRESHOLD;
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO transactions (business_id, account_id, date, description, merchant_key, amount_cents, category_id, category_source, confidence, reason, rule_id, needs_review, notes, import_hash, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT DO NOTHING RETURNING id`,
      [this.businessId, accountId, input.date, description, merchantKey(description), input.amountCents, s.categoryId, s.source, s.confidence, s.reason, s.ruleId ?? null, needsReview, input.notes ?? "", importHash, input.source ?? ""],
    );
    return row ? { id: row.id, needsReview } : null;
  }

  /**
   * Imports parsed CSV rows. Re-importing the same file (or an overlapping date
   * range) skips rows already present, including legitimately repeated rows such
   * as two identical coffees on the same day.
   */
  async importRows(accountId: number, rows: ImportedRow[], opts: { source?: string } = {}): Promise<{ imported: number; duplicates: number; needsReview: number }> {
    await this.assertAccount(accountId);
    return this.inTransaction(async (books) => {
      const rules = await books.listRules();
      const seen = new Map<string, number>();
      let imported = 0;
      let duplicates = 0;
      let needsReview = 0;
      for (const row of rows) {
        const base = `${accountId}|${row.date}|${row.amountCents}|${normalizeDescription(row.description)}`;
        const occurrence = (seen.get(base) ?? 0) + 1;
        seen.set(base, occurrence);
        const hash = createHash("sha256").update(`${base}|${occurrence}`).digest("hex");
        const added = await books.addTransaction({ ...row, accountId, source: opts.source }, hash, rules);
        if (!added) {
          duplicates++;
        } else {
          imported++;
          if (added.needsReview) needsReview++;
        }
      }
      return { imported, duplicates, needsReview };
    });
  }

  /**
   * Sets a category by hand. With `remember`, also creates a rule for this
   * merchant so future and existing matching transactions follow it.
   */
  async setCategory(id: number, categoryId: string, opts: { remember?: boolean } = {}): Promise<{ ruleId?: number }> {
    if (!isCategoryId(categoryId)) throw new Error("Unknown category");
    const tx = await this.getTransaction(id);
    if (!tx) throw new Error("Transaction not found");
    await this.db.query(
      "UPDATE transactions SET category_id = $1, category_source = 'user', confidence = 1, reason = 'Set by you', rule_id = NULL, needs_review = false, updated_at = now() WHERE id = $2 AND business_id = $3",
      [categoryId, id, this.businessId],
    );
    if (opts.remember && tx.merchantKey && categoryId !== "uncategorized") {
      const kind = getCategory(categoryId).kind;
      // Income and expense rules only fire in the matching direction, so a refund
      // from a vendor is not mistaken for sales and vice versa.
      const direction = kind === "income" ? "in" : kind === "non_pl" ? "any" : tx.amountCents < 0 ? "out" : "any";
      return { ruleId: await this.createRule({ pattern: tx.merchantKey, categoryId, direction }) };
    }
    return {};
  }

  async markReviewed(id: number): Promise<void> {
    await this.db.query("UPDATE transactions SET needs_review = false, updated_at = now() WHERE id = $1 AND business_id = $2", [id, this.businessId]);
  }

  async updateNotes(id: number, notes: string): Promise<void> {
    await this.db.query("UPDATE transactions SET notes = $1, updated_at = now() WHERE id = $2 AND business_id = $3", [notes, id, this.businessId]);
  }

  async deleteTransaction(id: number): Promise<void> {
    await this.db.query("DELETE FROM transactions WHERE id = $1 AND business_id = $2", [id, this.businessId]);
  }

  // Reporting

  /** Signed totals per category for a year. */
  async categoryTotals(year: number): Promise<Map<string, number>> {
    const rows = await this.db.query<{ category_id: string; total: number }>(
      "SELECT category_id, SUM(amount_cents)::bigint AS total FROM transactions WHERE business_id = $1 AND date >= $2 AND date < $3 GROUP BY category_id",
      [this.businessId, `${year}-01-01`, `${year + 1}-01-01`],
    );
    return new Map(rows.map((r) => [r.category_id, r.total]));
  }

  async reviewCount(): Promise<number> {
    return (await this.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM transactions WHERE business_id = $1 AND needs_review", [this.businessId]))!.n;
  }

  async years(): Promise<number[]> {
    const rows = await this.db.query<{ y: number }>(
      "SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS y FROM transactions WHERE business_id = $1 ORDER BY y DESC",
      [this.businessId],
    );
    return rows.map((r) => r.y);
  }
}
