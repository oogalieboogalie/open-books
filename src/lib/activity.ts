import { randomBytes } from "node:crypto";
import type { Books, Transaction } from "./books";
import { getCategory } from "./categories";
import { businessTimeZone, type Db } from "./db";
import { appointmentCounts, appointmentsBetween, type Appointment } from "./integrations/calendar";
import { BUILTIN_METRICS, DERIVED_METRICS, EVENT_KINDS, bucketIndex, buildBuckets, metricKey, type Bucket, type Granularity } from "./timeline";

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
  /** Appointments from connected calendars. */
  appointments: Appointment[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Everything on the timeline that is not a transaction: events (a social post,
 * a promotion), daily numbers (contacts, appointments), and tracked links whose
 * clicks are counted automatically. Scoped to one business like Books.
 */
export class Activity {
  constructor(
    private db: Db,
    readonly businessId: number,
  ) {}

  static for(books: Books): Activity {
    return new Activity(books.db, books.businessId);
  }

  // Events

  async addEvent(input: { date: string; kind: string; title: string; url?: string; notes?: string }): Promise<number> {
    if (!ISO.test(input.date)) throw new Error("Enter a date.");
    if (!input.title.trim()) throw new Error("Give the event a short title.");
    const kind = EVENT_KINDS.some((k) => k.key === input.kind) ? input.kind : "other";
    const url = (input.url ?? "").trim();
    if (url && !/^https?:\/\//i.test(url)) throw new Error("Links should start with http:// or https://");
    const row = await this.db.one<{ id: number }>(
      "INSERT INTO events (business_id, date, kind, title, url, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [this.businessId, input.date, kind, input.title.trim(), url, (input.notes ?? "").trim()],
    );
    return row!.id;
  }

  async deleteEvent(id: number): Promise<void> {
    await this.db.query("DELETE FROM events WHERE id = $1 AND business_id = $2", [id, this.businessId]);
  }

  listEvents(from: string, to: string): Promise<BusinessEvent[]> {
    return this.db.query<BusinessEvent>(
      `SELECT e.id, e.date, e.kind, e.title, e.url, e.notes,
         (SELECT slug FROM tracked_links l WHERE l.event_id = e.id ORDER BY l.id LIMIT 1) AS "linkSlug"
       FROM events e WHERE e.business_id = $1 AND e.date BETWEEN $2 AND $3 ORDER BY e.date, e.id`,
      [this.businessId, from, to],
    );
  }

  // Metrics

  async metricDefs(): Promise<MetricDef[]> {
    const custom = await this.db.query<MetricDef>("SELECT key, name FROM custom_metrics WHERE business_id = $1 ORDER BY name", [this.businessId]);
    return [...BUILTIN_METRICS.map((m) => ({ ...m })), ...custom, ...DERIVED_METRICS.map((m) => ({ ...m, derived: true }))];
  }

  /**
   * Records a daily number. Logging the same metric on the same day again
   * replaces the earlier value. `metric` may be a new name, which creates a
   * custom metric.
   */
  async logMetric(input: { date: string; metric: string; value: number }): Promise<void> {
    if (!ISO.test(input.date)) throw new Error("Enter a date.");
    if (!Number.isFinite(input.value) || input.value < 0) throw new Error("Enter a number of zero or more.");
    let key = input.metric;
    const defs = await this.metricDefs();
    const def = defs.find((m) => m.key === key);
    if (def?.derived) throw new Error(`${def.name} is counted automatically.`);
    if (!def) {
      key = metricKey(input.metric);
      if (!key) throw new Error("Name the metric.");
      const existing = defs.find((m) => m.key === key);
      if (existing?.derived) throw new Error(`${existing.name} is counted automatically.`);
      if (!existing) {
        await this.db.query("INSERT INTO custom_metrics (business_id, key, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [this.businessId, key, input.metric.trim()]);
      }
    }
    await this.db.query(
      `INSERT INTO metric_entries (business_id, date, metric, value) VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, date, metric) DO UPDATE SET value = excluded.value`,
      [this.businessId, input.date, key, input.value],
    );
  }

  // Tracked links

  /** Creates a short link that redirects to `destination` and counts each click. */
  async createLink(input: { destination: string; eventId?: number | null; slug?: string }): Promise<string> {
    const destination = input.destination.trim();
    if (!/^https?:\/\/\S+$/i.test(destination)) throw new Error("Enter the full link, starting with https://");
    if (input.eventId != null) {
      const ok = await this.db.one("SELECT 1 FROM events WHERE id = $1 AND business_id = $2", [input.eventId, this.businessId]);
      if (!ok) throw new Error("Event not found");
    }
    let slug = (input.slug ?? "").trim().toLowerCase();
    if (slug && !/^[a-z0-9-]{3,40}$/.test(slug)) throw new Error("Short names use 3 to 40 letters, numbers, or dashes.");
    if (!slug) slug = randomBytes(4).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
    const row = await this.db.one(
      "INSERT INTO tracked_links (business_id, slug, destination, event_id) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING RETURNING id",
      [this.businessId, slug, destination, input.eventId ?? null],
    );
    if (!row) throw new Error(`The short name "${slug}" is taken.`);
    return slug;
  }

  listLinks(): Promise<TrackedLink[]> {
    return this.db.query<TrackedLink>(
      `SELECT l.id, l.slug, l.destination, l.event_id AS "eventId", e.title AS "eventTitle", l.created_at AS "createdAt",
         (SELECT COUNT(*)::int FROM link_clicks c WHERE c.link_id = l.id) AS clicks
       FROM tracked_links l LEFT JOIN events e ON e.id = l.event_id
       WHERE l.business_id = $1 ORDER BY l.id DESC`,
      [this.businessId],
    );
  }

  async deleteLink(id: number): Promise<void> {
    await this.db.query("DELETE FROM tracked_links WHERE id = $1 AND business_id = $2", [id, this.businessId]);
  }

  // Timeline

  async timeline(from: string, to: string, granularity: Granularity): Promise<TimelineData> {
    const buckets: TimelineBucket[] = buildBuckets(from, to, granularity).map((b) => ({ ...b, incomeCents: 0, expenseCents: 0 }));
    const rangeFrom = buckets[0]?.start ?? from;
    const rangeTo = buckets[buckets.length - 1]?.end ?? to;
    const seriesMap = new Map<string, number[]>();
    const add = (key: string, date: string, value: number) => {
      const i = bucketIndex(buckets, date);
      if (i === -1) return;
      if (!seriesMap.has(key)) seriesMap.set(key, buckets.map(() => 0));
      seriesMap.get(key)![i] += value;
    };

    const [txRows, metricRows, clickRows, defs, events, apptRows] = await Promise.all([
      this.db.query<{ date: string; category_id: string; total: number; deposits: number }>(
        `SELECT date, category_id, SUM(amount_cents)::bigint AS total, COUNT(*) FILTER (WHERE amount_cents > 0)::int AS deposits
         FROM transactions WHERE business_id = $1 AND date BETWEEN $2 AND $3 GROUP BY date, category_id`,
        [this.businessId, rangeFrom, rangeTo],
      ),
      this.db.query<{ date: string; metric: string; value: number }>(
        "SELECT date, metric, value FROM metric_entries WHERE business_id = $1 AND date BETWEEN $2 AND $3",
        [this.businessId, rangeFrom, rangeTo],
      ),
      this.clicksByDay(rangeFrom, rangeTo),
      this.metricDefs(),
      this.listEvents(rangeFrom, rangeTo),
      appointmentCounts(this.db, this.businessId, rangeFrom, rangeTo),
    ]);

    for (const r of txRows) {
      const i = bucketIndex(buckets, r.date);
      if (i === -1) continue;
      const kind = getCategory(r.category_id).kind;
      if (kind === "income") buckets[i].incomeCents += r.total;
      else if (kind === "expense" || kind === "cogs") buckets[i].expenseCents -= r.total;
      if (r.category_id === "gross_receipts") add("sales_count", r.date, r.deposits);
    }
    for (const r of metricRows) add(r.metric, r.date, r.value);
    for (const r of clickRows) add("link_clicks", r.date, r.count);
    for (const r of apptRows) add("booked_appointments", r.date, r.count);

    const series = defs
      .filter((d) => seriesMap.get(d.key)?.some((v) => v !== 0))
      .map((d) => ({ key: d.key, name: d.name, values: seriesMap.get(d.key)! }));

    return {
      from: rangeFrom,
      to: rangeTo,
      granularity,
      buckets,
      series,
      events: events.map((e) => ({ ...e, bucket: bucketIndex(buckets, e.date) })),
    };
  }

  /** Clicks per link per day, where "day" is the business's local day (BUSINESS_TZ). */
  private clicksByDay(from: string, to: string) {
    return this.db.query<{ date: string; count: number; slug: string; destination: string; eventTitle: string | null }>(
      `SELECT (c.clicked_at AT TIME ZONE $4)::date AS date, l.slug, l.destination, e.title AS "eventTitle", COUNT(*)::int AS count
       FROM link_clicks c JOIN tracked_links l ON l.id = c.link_id LEFT JOIN events e ON e.id = l.event_id
       WHERE l.business_id = $1 AND (c.clicked_at AT TIME ZONE $4)::date BETWEEN $2 AND $3
       GROUP BY 1, l.id, e.title`,
      [this.businessId, from, to, businessTimeZone()],
    );
  }

  async periodDetail(from: string, to: string, books: Books): Promise<PeriodDetail> {
    const range = [this.businessId, from, to];
    const [totals, list, events, metricRows, clickRows, defs, appointments] = await Promise.all([
      this.db.query<{ category_id: string; total: number; n: number }>(
        "SELECT category_id, SUM(amount_cents)::bigint AS total, COUNT(*)::int AS n FROM transactions WHERE business_id = $1 AND date BETWEEN $2 AND $3 GROUP BY category_id",
        range,
      ),
      books.listTransactions({ from, to, limit: 200 }),
      this.listEvents(from, to),
      this.db.query<{ date: string; key: string; value: number }>(
        "SELECT date, metric AS key, value FROM metric_entries WHERE business_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date, metric",
        range,
      ),
      this.clicksByDay(from, to),
      this.metricDefs(),
      appointmentsBetween(this.db, this.businessId, from, to),
    ]);

    let incomeCents = 0;
    let expenseCents = 0;
    for (const t of totals) {
      const kind = getCategory(t.category_id).kind;
      if (kind === "income") incomeCents += t.total;
      else if (kind === "expense" || kind === "cogs") expenseCents -= t.total;
    }
    const clickMap = new Map<string, PeriodDetail["clicks"][number]>();
    for (const c of clickRows) {
      const entry = clickMap.get(c.slug) ?? { slug: c.slug, destination: c.destination, eventTitle: c.eventTitle, count: 0 };
      entry.count += c.count;
      clickMap.set(c.slug, entry);
    }
    return {
      from,
      to,
      incomeCents,
      expenseCents,
      transactions: list.rows,
      transactionCount: list.total,
      events,
      metrics: metricRows.map((m) => ({ ...m, name: defs.find((d) => d.key === m.key)?.name ?? m.key })),
      clicks: [...clickMap.values()].sort((a, b) => b.count - a.count),
      appointments,
    };
  }

  async earliestDate(): Promise<string | null> {
    const row = await this.db.one<{ d: string | null }>(
      `SELECT LEAST(
         (SELECT MIN(date) FROM transactions WHERE business_id = $1),
         (SELECT MIN(date) FROM events WHERE business_id = $1),
         (SELECT MIN(date) FROM metric_entries WHERE business_id = $1)) AS d`,
      [this.businessId],
    );
    return row?.d ?? null;
  }
}

/** Records a click and returns where to send the visitor, or null for an unknown link. */
export async function recordClick(db: Db, slug: string, opts: { count?: boolean } = {}): Promise<string | null> {
  const link = await db.one<{ id: number; destination: string }>("SELECT id, destination FROM tracked_links WHERE slug = $1", [slug.toLowerCase()]);
  if (!link) return null;
  if (opts.count !== false) await db.query("INSERT INTO link_clicks (link_id) VALUES ($1)", [link.id]);
  return link.destination;
}
