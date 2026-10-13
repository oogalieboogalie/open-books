import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Books, type Transaction } from "./books";
import { getCategory } from "./categories";
import {
  BUILTIN_METRICS,
  DERIVED_METRICS,
  EVENT_KINDS,
  bucketIndex,
  buildBuckets,
  metricKey,
  type Bucket,
  type Granularity,
} from "./timeline";

export interface BusinessEvent {
  id: number;
  date: string;
  kind: string;
  title: string;
  url: string;
  notes: string;
  /** Short link slug, when a tracked link was made for this event. */
  linkSlug: string | null;
}

export interface MetricDef {
  key: string;
  name: string;
  derived?: boolean;
}

export interface TrackedLink {
  id: number;
  slug: string;
  destination: string;
  eventId: number | null;
  eventTitle: string | null;
  clicks: number;
  createdAt: string;
}

export interface TimelineBucket extends Bucket {
  incomeCents: number;
  expenseCents: number;
}

export interface TimelineData {
  from: string;
  to: string;
  granularity: Granularity;
  buckets: TimelineBucket[];
  /** One value per bucket, for every metric with data in the range. */
  series: { key: string; name: string; values: number[] }[];
  events: (BusinessEvent & { bucket: number })[];
}

export interface PeriodDetail {
  from: string;
  to: string;
  incomeCents: number;
  expenseCents: number;
  transactions: Transaction[];
  transactionCount: number;
  events: BusinessEvent[];
  metrics: { date: string; key: string; name: string; value: number }[];
  clicks: { slug: string; destination: string; eventTitle: string | null; count: number }[];
}

const plain = <T,>(rows: unknown[]): T[] => rows.map((r) => ({ ...(r as object) }) as T);

/**
 * Everything on the timeline that is not a transaction: events (a social post,
 * a promotion), daily numbers (contacts, appointments), and tracked links whose
 * clicks are counted automatically. Scoped to one business like Books.
 */
export class Activity {
  constructor(
    private db: DatabaseSync,
    readonly businessId: number,
  ) {}

  static for(books: Books, db: DatabaseSync): Activity {
    return new Activity(db, books.businessId);
  }

  // Events

  addEvent(input: { date: string; kind: string; title: string; url?: string; notes?: string }): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Enter a date.");
    if (!input.title.trim()) throw new Error("Give the event a short title.");
    const kind = EVENT_KINDS.some((k) => k.key === input.kind) ? input.kind : "other";
    const url = (input.url ?? "").trim();
    if (url && !/^https?:\/\//i.test(url)) throw new Error("Links should start with http:// or https://");
    const res = this.db
      .prepare("INSERT INTO events (business_id, date, kind, title, url, notes) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.businessId, input.date, kind, input.title.trim(), url, (input.notes ?? "").trim());
    return Number(res.lastInsertRowid);
  }

  deleteEvent(id: number) {
    this.db.prepare("DELETE FROM events WHERE id = ? AND business_id = ?").run(id, this.businessId);
  }

  listEvents(from: string, to: string): BusinessEvent[] {
    return plain<BusinessEvent>(
      this.db
        .prepare(
          `SELECT e.id, e.date, e.kind, e.title, e.url, e.notes,
             (SELECT slug FROM tracked_links l WHERE l.event_id = e.id ORDER BY l.id LIMIT 1) AS linkSlug
           FROM events e WHERE e.business_id = ? AND e.date >= ? AND e.date <= ? ORDER BY e.date, e.id`,
        )
        .all(this.businessId, from, to),
    );
  }

  // Metrics

  metricDefs(): MetricDef[] {
    const custom = plain<MetricDef>(this.db.prepare("SELECT key, name FROM custom_metrics WHERE business_id = ? ORDER BY name").all(this.businessId));
    return [...BUILTIN_METRICS.map((m) => ({ ...m })), ...custom, ...DERIVED_METRICS.map((m) => ({ ...m, derived: true }))];
  }

  private metricName(key: string): string {
    return this.metricDefs().find((m) => m.key === key)?.name ?? key;
  }

  /**
   * Records a daily number. Logging the same metric on the same day again
   * replaces the earlier value. `metric` may be a new name, which creates a
   * custom metric.
   */
  logMetric(input: { date: string; metric: string; value: number }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Enter a date.");
    if (!Number.isFinite(input.value) || input.value < 0) throw new Error("Enter a number of zero or more.");
    let key = input.metric;
    const defs = this.metricDefs();
    const def = defs.find((m) => m.key === key);
    if (def?.derived) throw new Error(`${def.name} is counted automatically.`);
    if (!def) {
      key = metricKey(input.metric);
      if (!key) throw new Error("Name the metric.");
      const existing = defs.find((m) => m.key === key);
      if (existing?.derived) throw new Error(`${existing.name} is counted automatically.`);
      if (!existing) this.db.prepare("INSERT INTO custom_metrics (business_id, key, name) VALUES (?, ?, ?)").run(this.businessId, key, input.metric.trim());
    }
    this.db
      .prepare(
        `INSERT INTO metric_entries (business_id, date, metric, value) VALUES (?, ?, ?, ?)
         ON CONFLICT (business_id, date, metric) DO UPDATE SET value = excluded.value`,
      )
      .run(this.businessId, input.date, key, input.value);
  }

  deleteMetricEntry(date: string, metric: string) {
    this.db.prepare("DELETE FROM metric_entries WHERE business_id = ? AND date = ? AND metric = ?").run(this.businessId, date, metric);
  }

  // Tracked links

  /** Creates a short link that redirects to `destination` and counts each click. */
  createLink(input: { destination: string; eventId?: number | null; slug?: string }): string {
    const destination = input.destination.trim();
    if (!/^https?:\/\/\S+$/i.test(destination)) throw new Error("Enter the full link, starting with https://");
    if (input.eventId != null) {
      const ok = this.db.prepare("SELECT 1 FROM events WHERE id = ? AND business_id = ?").get(input.eventId, this.businessId);
      if (!ok) throw new Error("Event not found");
    }
    let slug = (input.slug ?? "").trim().toLowerCase();
    if (slug && !/^[a-z0-9-]{3,40}$/.test(slug)) throw new Error("Short names use 3 to 40 letters, numbers, or dashes.");
    if (!slug) slug = randomBytes(4).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
    try {
      this.db
        .prepare("INSERT INTO tracked_links (business_id, slug, destination, event_id) VALUES (?, ?, ?, ?)")
        .run(this.businessId, slug, destination, input.eventId ?? null);
    } catch {
      throw new Error(`The short name "${slug}" is taken.`);
    }
    return slug;
  }

  listLinks(): TrackedLink[] {
    return plain<TrackedLink>(
      this.db
        .prepare(
          `SELECT l.id, l.slug, l.destination, l.event_id AS eventId, e.title AS eventTitle, l.created_at AS createdAt,
             (SELECT COUNT(*) FROM link_clicks c WHERE c.link_id = l.id) AS clicks
           FROM tracked_links l LEFT JOIN events e ON e.id = l.event_id
           WHERE l.business_id = ? ORDER BY l.id DESC`,
        )
        .all(this.businessId),
    );
  }

  deleteLink(id: number) {
    this.db.prepare("DELETE FROM tracked_links WHERE id = ? AND business_id = ?").run(id, this.businessId);
  }

  // Timeline

  timeline(from: string, to: string, granularity: Granularity): TimelineData {
    const buckets: TimelineBucket[] = buildBuckets(from, to, granularity).map((b) => ({ ...b, incomeCents: 0, expenseCents: 0 }));
    const rangeFrom = buckets[0]?.start ?? from;
    const rangeTo = buckets[buckets.length - 1]?.end ?? to;
    const zero = () => buckets.map(() => 0);
    const seriesMap = new Map<string, number[]>();
    const add = (key: string, date: string, value: number) => {
      const i = bucketIndex(buckets, date);
      if (i === -1) return;
      if (!seriesMap.has(key)) seriesMap.set(key, zero());
      seriesMap.get(key)![i] += value;
    };

    const txRows = this.db
      .prepare("SELECT date, category_id, SUM(amount_cents) AS total, SUM(CASE WHEN amount_cents > 0 THEN 1 ELSE 0 END) AS deposits FROM transactions WHERE business_id = ? AND date >= ? AND date <= ? GROUP BY date, category_id")
      .all(this.businessId, rangeFrom, rangeTo) as { date: string; category_id: string; total: number; deposits: number }[];
    for (const r of txRows) {
      const i = bucketIndex(buckets, r.date);
      if (i === -1) continue;
      const kind = getCategory(r.category_id).kind;
      if (kind === "income") buckets[i].incomeCents += r.total;
      else if (kind === "expense" || kind === "cogs") buckets[i].expenseCents -= r.total;
      if (r.category_id === "gross_receipts") add("sales_count", r.date, r.deposits);
    }

    const metricRows = this.db
      .prepare("SELECT date, metric, value FROM metric_entries WHERE business_id = ? AND date >= ? AND date <= ?")
      .all(this.businessId, rangeFrom, rangeTo) as { date: string; metric: string; value: number }[];
    for (const r of metricRows) add(r.metric, r.date, r.value);

    for (const r of this.clicksByDay(rangeFrom, rangeTo)) add("link_clicks", r.date, r.count);

    const defs = this.metricDefs();
    const series = defs
      .filter((d) => seriesMap.has(d.key) && seriesMap.get(d.key)!.some((v) => v !== 0))
      .map((d) => ({ key: d.key, name: d.name, values: seriesMap.get(d.key)! }));

    const events = this.listEvents(rangeFrom, rangeTo).map((e) => ({ ...e, bucket: bucketIndex(buckets, e.date) }));
    return { from: rangeFrom, to: rangeTo, granularity, buckets, series, events };
  }

  private clicksByDay(from: string, to: string): { date: string; count: number; slug: string; destination: string; eventTitle: string | null }[] {
    // Clicks are stored in UTC; the day is the server's local day.
    return this.db
      .prepare(
        `SELECT date(c.clicked_at, 'localtime') AS date, l.slug, l.destination, e.title AS eventTitle, COUNT(*) AS count
         FROM link_clicks c JOIN tracked_links l ON l.id = c.link_id LEFT JOIN events e ON e.id = l.event_id
         WHERE l.business_id = ? AND date(c.clicked_at, 'localtime') BETWEEN ? AND ?
         GROUP BY date(c.clicked_at, 'localtime'), l.id`,
      )
      .all(this.businessId, from, to) as { date: string; count: number; slug: string; destination: string; eventTitle: string | null }[];
  }

  periodDetail(from: string, to: string, books: Books): PeriodDetail {
    const where = "business_id = ? AND date >= ? AND date <= ?";
    const params: SQLInputValue[] = [this.businessId, from, to];
    const txAll = this.db.prepare(`SELECT id, category_id, amount_cents FROM transactions WHERE ${where}`).all(...params) as { id: number; category_id: string; amount_cents: number }[];
    let incomeCents = 0;
    let expenseCents = 0;
    for (const t of txAll) {
      const kind = getCategory(t.category_id).kind;
      if (kind === "income") incomeCents += t.amount_cents;
      else if (kind === "expense" || kind === "cogs") expenseCents -= t.amount_cents;
    }
    const { rows: transactions } = books.listTransactions({ from, to, limit: 200 });
    const defs = this.metricDefs();
    const metrics = (this.db.prepare(`SELECT date, metric AS key, value FROM metric_entries WHERE ${where} ORDER BY date, metric`).all(...params) as { date: string; key: string; value: number }[]).map(
      (m) => ({ ...m, name: defs.find((d) => d.key === m.key)?.name ?? m.key }),
    );
    const clickMap = new Map<string, PeriodDetail["clicks"][number]>();
    for (const c of this.clicksByDay(from, to)) {
      const entry = clickMap.get(c.slug) ?? { slug: c.slug, destination: c.destination, eventTitle: c.eventTitle, count: 0 };
      entry.count += c.count;
      clickMap.set(c.slug, entry);
    }
    return {
      from,
      to,
      incomeCents,
      expenseCents,
      transactions,
      transactionCount: txAll.length,
      events: this.listEvents(from, to),
      metrics,
      clicks: [...clickMap.values()].sort((a, b) => b.count - a.count),
    };
  }

  earliestDate(): string | null {
    const row = this.db
      .prepare(
        `SELECT MIN(d) AS d FROM (
           SELECT MIN(date) AS d FROM transactions WHERE business_id = ?1
           UNION ALL SELECT MIN(date) FROM events WHERE business_id = ?1
           UNION ALL SELECT MIN(date) FROM metric_entries WHERE business_id = ?1)`,
      )
      .get(this.businessId) as { d: string | null };
    return row.d;
  }
}

/** Records a click and returns where to send the visitor, or null for an unknown link. */
export function recordClick(db: DatabaseSync, slug: string): string | null {
  const link = db.prepare("SELECT id, destination FROM tracked_links WHERE slug = ?").get(slug.toLowerCase()) as { id: number; destination: string } | undefined;
  if (!link) return null;
  db.prepare("INSERT INTO link_clicks (link_id) VALUES (?)").run(link.id);
  return link.destination;
}
