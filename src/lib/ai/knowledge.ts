import { createHash } from "node:crypto";
import type { Books } from "../books";
import { getCategory } from "../categories";
import { ensureVectorSupport, type Db } from "../db";
import { money } from "../format";
import { eventKindLabel } from "../timeline";
import type { Embedder } from "./provider";

/**
 * The assistant's searchable copy of the books. Every transaction, event,
 * month, and rule becomes a short plain-English document, kept in sync by
 * content hash. Search blends Postgres full-text ranking with pgvector
 * similarity when embeddings are available, so it works with or without a
 * local embedding model.
 */

export type SourceType = "transaction" | "event" | "month" | "rule";

export interface KnowledgeDoc {
  sourceType: SourceType;
  sourceId: string;
  date: string | null;
  title: string;
  content: string;
}

export interface SearchHit extends KnowledgeDoc {
  score: number;
}

export interface IndexStats {
  documents: number;
  embedded: number;
  vectorSupport: boolean;
  embedModel: string | null;
}

const hash = (d: KnowledgeDoc) => createHash("sha256").update(`${d.date}|${d.title}|${d.content}`).digest("hex").slice(0, 32);
const BATCH = 500;
const EMBED_BATCH = 64;

export class Knowledge {
  private readonly db: Db;
  private readonly businessId: number;

  constructor(
    books: Books,
    private embedder: Embedder | null,
  ) {
    this.db = books.db;
    this.businessId = books.businessId;
  }

  /** Builds every document from the current books. */
  async buildDocuments(): Promise<KnowledgeDoc[]> {
    const id = [this.businessId];
    const [txs, events, months, monthCats, metrics, clicks, rules] = await Promise.all([
      this.db.query<{ id: number; date: string; description: string; amount_cents: number; category_id: string; notes: string; account: string | null; needs_review: boolean }>(
        `SELECT t.id, t.date, t.description, t.amount_cents, t.category_id, t.notes, a.name AS account, t.needs_review
         FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.business_id = $1`,
        id,
      ),
      this.db.query<{ id: number; date: string; kind: string; title: string; url: string; notes: string; slug: string | null; clicks: number }>(
        `SELECT e.id, e.date, e.kind, e.title, e.url, e.notes, l.slug,
           (SELECT COUNT(*)::int FROM link_clicks c WHERE c.link_id = l.id) AS clicks
         FROM events e LEFT JOIN LATERAL (SELECT id, slug FROM tracked_links WHERE event_id = e.id ORDER BY id LIMIT 1) l ON true
         WHERE e.business_id = $1`,
        id,
      ),
      this.db.query<{ month: string; n: number }>(
        `SELECT to_char(date, 'YYYY-MM') AS month, COUNT(*)::int AS n FROM transactions WHERE business_id = $1 GROUP BY 1
         UNION SELECT to_char(date, 'YYYY-MM'), 0 FROM events WHERE business_id = $1
         UNION SELECT to_char(date, 'YYYY-MM'), 0 FROM metric_entries WHERE business_id = $1`,
        id,
      ),
      this.db.query<{ month: string; category_id: string; total: number; n: number }>(
        `SELECT to_char(date, 'YYYY-MM') AS month, category_id, SUM(amount_cents)::bigint AS total, COUNT(*)::int AS n
         FROM transactions WHERE business_id = $1 GROUP BY 1, 2`,
        id,
      ),
      this.db.query<{ month: string; metric: string; name: string | null; value: number }>(
        `SELECT to_char(m.date, 'YYYY-MM') AS month, m.metric, c.name, SUM(m.value)::float8 AS value
         FROM metric_entries m LEFT JOIN custom_metrics c ON c.business_id = m.business_id AND c.key = m.metric
         WHERE m.business_id = $1 GROUP BY 1, 2, 3`,
        id,
      ),
      this.db.query<{ month: string; n: number }>(
        `SELECT to_char(c.clicked_at, 'YYYY-MM') AS month, COUNT(*)::int AS n
         FROM link_clicks c JOIN tracked_links l ON l.id = c.link_id WHERE l.business_id = $1 GROUP BY 1`,
        id,
      ),
      this.db.query<{ id: number; pattern: string; match_type: string; direction: string; category_id: string }>(
        "SELECT id, pattern, match_type, direction, category_id FROM rules WHERE business_id = $1",
        id,
      ),
    ]);

    const docs: KnowledgeDoc[] = [];
    for (const t of txs) {
      const cat = getCategory(t.category_id);
      const dir = t.amount_cents >= 0 ? "money in" : "money out";
      docs.push({
        sourceType: "transaction",
        sourceId: String(t.id),
        date: t.date,
        title: t.description,
        content:
          `Transaction #${t.id} on ${t.date}: ${t.description}. ${dir} ${money(Math.abs(t.amount_cents))}. ` +
          `Category: ${cat.name}${cat.taxLine ? ` (${cat.taxLine})` : ""}.` +
          (t.account ? ` Account: ${t.account}.` : "") +
          (t.needs_review ? " Needs review." : "") +
          (t.notes ? ` Notes: ${t.notes}` : ""),
      });
    }
    for (const e of events) {
      docs.push({
        sourceType: "event",
        sourceId: String(e.id),
        date: e.date,
        title: e.title,
        content:
          `${eventKindLabel(e.kind)} on ${e.date}: ${e.title}.` +
          (e.url ? ` Link: ${e.url}.` : "") +
          (e.notes ? ` Notes: ${e.notes}.` : "") +
          (e.slug ? ` Tracked link /go/${e.slug} has ${e.clicks} click${e.clicks === 1 ? "" : "s"}.` : ""),
      });
    }

    const monthNames = [...new Set(months.map((m) => m.month))].sort();
    for (const month of monthNames) {
      const cats = monthCats.filter((c) => c.month === month);
      let income = 0;
      let expense = 0;
      const lines: string[] = [];
      for (const c of cats.sort((a, b) => Math.abs(b.total) - Math.abs(a.total))) {
        const cat = getCategory(c.category_id);
        if (cat.kind === "income") income += c.total;
        else if (cat.kind === "expense" || cat.kind === "cogs") expense -= c.total;
        lines.push(`${cat.name} ${money(c.total)} (${c.n})`);
      }
      const m = metrics.filter((x) => x.month === month).map((x) => `${x.name ?? x.metric.replace(/_/g, " ")} ${x.value}`);
      const clickCount = clicks.find((c) => c.month === month)?.n ?? 0;
      const monthEvents = events.filter((e) => e.date.startsWith(month)).map((e) => `${e.date.slice(8)}: ${e.title}`);
      docs.push({
        sourceType: "month",
        sourceId: month,
        date: `${month}-01`,
        title: `Summary for ${month}`,
        content:
          `Month ${month}: income ${money(income)}, expenses ${money(expense)}, net ${money(income - expense)}.` +
          (lines.length ? ` By category: ${lines.join("; ")}.` : "") +
          (m.length ? ` Tracked numbers: ${m.join("; ")}.` : "") +
          (clickCount ? ` Link clicks: ${clickCount}.` : "") +
          (monthEvents.length ? ` Events: ${monthEvents.join("; ")}.` : ""),
      });
    }

    for (const r of rules) {
      const dir = r.direction === "in" ? " (money in)" : r.direction === "out" ? " (money out)" : "";
      docs.push({
        sourceType: "rule",
        sourceId: String(r.id),
        date: null,
        title: `Rule for ${r.pattern}`,
        content: `Categorization rule: when the description ${r.match_type.replace("_", " ")} "${r.pattern}"${dir}, use ${getCategory(r.category_id).name}.`,
      });
    }
    return docs;
  }

  /** Brings the index up to date with the books. Returns how many documents changed. */
  async sync(): Promise<{ changed: number; removed: number }> {
    const docs = await this.buildDocuments();
    const existing = await this.db.query<{ source_type: string; source_id: string; content_hash: string }>(
      "SELECT source_type, source_id, content_hash FROM ai_documents WHERE business_id = $1",
      [this.businessId],
    );
    const known = new Map(existing.map((e) => [`${e.source_type}:${e.source_id}`, e.content_hash]));
    const changed = docs.map((d) => ({ d, h: hash(d) })).filter(({ d, h }) => known.get(`${d.sourceType}:${d.sourceId}`) !== h);
    const live = new Set(docs.map((d) => `${d.sourceType}:${d.sourceId}`));
    const stale = existing.filter((e) => !live.has(`${e.source_type}:${e.source_id}`));

    for (let i = 0; i < changed.length; i += BATCH) {
      const batch = changed.slice(i, i + BATCH);
      // A changed document drops its embedding model so it is embedded again.
      await this.db.query(
        `INSERT INTO ai_documents (business_id, source_type, source_id, date, title, content, content_hash)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::date[], $5::text[], $6::text[], $7::text[])
         ON CONFLICT (business_id, source_type, source_id) DO UPDATE SET
           date = excluded.date, title = excluded.title, content = excluded.content, content_hash = excluded.content_hash,
           embed_model = NULL, updated_at = now()`,
        [
          this.businessId,
          batch.map((x) => x.d.sourceType),
          batch.map((x) => x.d.sourceId),
          batch.map((x) => x.d.date),
          batch.map((x) => x.d.title),
          batch.map((x) => x.d.content),
          batch.map((x) => x.h),
        ],
      );
    }
    for (let i = 0; i < stale.length; i += BATCH) {
      const batch = stale.slice(i, i + BATCH);
      await this.db.query(
        `DELETE FROM ai_documents d USING unnest($2::text[], $3::text[]) AS s(t, i)
         WHERE d.business_id = $1 AND d.source_type = s.t AND d.source_id = s.i`,
        [this.businessId, batch.map((s) => s.source_type), batch.map((s) => s.source_id)],
      );
    }
    return { changed: changed.length, removed: stale.length };
  }

  /**
   * Embeds documents that have no embedding for the current model, until
   * `budgetMs` runs out. Returns how many were embedded. Safe to call often.
   */
  async embedPending(budgetMs = 20_000): Promise<number> {
    if (!this.embedder || !(await ensureVectorSupport(this.db))) return 0;
    const started = Date.now();
    let done = 0;
    while (Date.now() - started < budgetMs) {
      const rows = await this.db.query<{ id: number; title: string; content: string }>(
        `SELECT id, title, content FROM ai_documents WHERE business_id = $1 AND embed_model IS DISTINCT FROM $2 ORDER BY date DESC NULLS LAST, id LIMIT ${EMBED_BATCH}`,
        [this.businessId, this.embedder.model],
      );
      if (rows.length === 0) break;
      const vectors = await this.embedder.embed(
        rows.map((r) => r.content),
        "document",
      );
      await this.db.query(
        `UPDATE ai_documents d SET embedding = v.e::vector, embed_model = $1
         FROM unnest($2::bigint[], $3::text[]) AS v(id, e) WHERE d.id = v.id`,
        [this.embedder.model, rows.map((r) => r.id), vectors.map((v) => `[${v.join(",")}]`)],
      );
      done += rows.length;
    }
    return done;
  }

  async stats(): Promise<IndexStats> {
    const vectorSupport = await ensureVectorSupport(this.db);
    const row = await this.db.one<{ documents: number; embedded: number }>(
      "SELECT COUNT(*)::int AS documents, COUNT(*) FILTER (WHERE embed_model = $2)::int AS embedded FROM ai_documents WHERE business_id = $1",
      [this.businessId, this.embedder?.model ?? ""],
    );
    return { documents: row!.documents, embedded: row!.embedded, vectorSupport, embedModel: this.embedder?.model ?? null };
  }

  /** Forgets all embeddings so the next sync embeds everything again. */
  async resetEmbeddings(): Promise<void> {
    await this.db.query("UPDATE ai_documents SET embed_model = NULL WHERE business_id = $1", [this.businessId]);
  }

  /**
   * Finds the documents most related to `query`: full-text matches and, when
   * embeddings exist, nearest neighbours, merged by reciprocal rank fusion.
   */
  async search(query: string, opts: { limit?: number; types?: SourceType[]; from?: string; to?: string } = {}): Promise<SearchHit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
    const params: unknown[] = [this.businessId];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = ["business_id = $1"];
    if (opts.types?.length) where.push(`source_type = ANY(${p(opts.types)}::text[])`);
    if (opts.from) where.push(`date >= ${p(opts.from)}`);
    if (opts.to) where.push(`date <= ${p(opts.to)}`);
    const filter = where.join(" AND ");
    const pool = limit * 3;

    type Row = { id: number; source_type: SourceType; source_id: string; date: string | null; title: string; content: string };
    const cols = "id, source_type, source_id, date, title, content";
    const ranked: Row[][] = [];

    const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].slice(0, 24);
    if (words.length) {
      const fts = [...params, words.join(" | ")];
      ranked.push(
        await this.db.query<Row>(
          `SELECT ${cols} FROM ai_documents, to_tsquery('english', $${fts.length}) q
           WHERE ${filter} AND tsv @@ q ORDER BY ts_rank(tsv, q) DESC, date DESC NULLS LAST LIMIT ${pool}`,
          fts,
        ),
      );
    }

    if (this.embedder && (await ensureVectorSupport(this.db))) {
      const model = p(this.embedder.model);
      const has = await this.db.one(`SELECT 1 FROM ai_documents WHERE ${filter} AND embed_model = ${model} LIMIT 1`, params);
      if (has) {
        try {
          const [vec] = await this.embedder.embed([query], "query");
          ranked.push(
            await this.db.query<Row>(
              `SELECT ${cols} FROM ai_documents WHERE ${filter} AND embed_model = ${model}
               ORDER BY embedding <=> ${p(`[${vec.join(",")}]`)}::vector LIMIT ${pool}`,
              params,
            ),
          );
        } catch {
          // The embedding model is down; full-text results still answer.
        }
      }
    }

    const scores = new Map<number, { row: Row; score: number }>();
    for (const list of ranked) {
      list.forEach((row, rank) => {
        const entry = scores.get(row.id) ?? { row, score: 0 };
        entry.score += 1 / (60 + rank);
        scores.set(row.id, entry);
      });
    }
    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score }) => ({
        sourceType: row.source_type,
        sourceId: row.source_id,
        date: row.date,
        title: row.title,
        content: row.content,
        score: Math.round(score * 10000) / 10000,
      }));
  }
}
