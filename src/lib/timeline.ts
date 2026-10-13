/**
 * Date bucketing for the timeline: turn a range and a granularity into the
 * day, week, or month columns the chart draws. Pure functions on YYYY-MM-DD
 * strings, all in UTC so a date never shifts by a timezone.
 */

export type Granularity = "day" | "week" | "month";

export const RANGE_PRESETS = [
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "6m", label: "6 months" },
  { key: "12m", label: "12 months" },
  { key: "ytd", label: "This year" },
  { key: "all", label: "All time" },
] as const;
export type RangeKey = (typeof RANGE_PRESETS)[number]["key"];

export interface Bucket {
  /** First day in the bucket. */
  start: string;
  /** Last day in the bucket (inclusive). */
  end: string;
  label: string;
}

const DAY = 86_400_000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, n: number): string {
  return toIso(new Date(toDate(iso).getTime() + n * DAY));
}

export function addMonths(iso: string, n: number): string {
  const d = toDate(iso);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return toIso(target);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY);
}

/** The first day of the bucket containing `iso`. Weeks start on Monday. */
export function bucketStart(iso: string, g: Granularity): string {
  if (g === "day") return iso;
  if (g === "month") return `${iso.slice(0, 7)}-01`;
  const dow = (toDate(iso).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(iso, -dow);
}

function nextBucket(start: string, g: Granularity): string {
  return g === "day" ? addDays(start, 1) : g === "week" ? addDays(start, 7) : addMonths(start, 1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDay(iso: string, withYear = false): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ""}`;
}

function bucketLabel(start: string, end: string, g: Granularity): string {
  if (g === "day") return formatDay(start, true);
  if (g === "month") return `${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;
  return `Week of ${formatDay(start, true)}`;
}

export function buildBuckets(from: string, to: string, g: Granularity): Bucket[] {
  const buckets: Bucket[] = [];
  for (let start = bucketStart(from, g); start <= to; start = nextBucket(start, g)) {
    const end = addDays(nextBucket(start, g), -1);
    buckets.push({ start, end, label: bucketLabel(start, end, g) });
    if (buckets.length > 1000) break;
  }
  return buckets;
}

/** Index of the bucket containing `iso`, or -1. Buckets must be sorted. */
export function bucketIndex(buckets: Bucket[], iso: string): number {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (iso < buckets[mid].start) hi = mid - 1;
    else if (iso > buckets[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function resolveRange(key: string | undefined, today: string, earliest: string | null): { key: RangeKey; from: string; to: string } {
  const k = (RANGE_PRESETS.some((p) => p.key === key) ? key : "6m") as RangeKey;
  const to = today;
  switch (k) {
    case "30d":
      return { key: k, from: addDays(to, -29), to };
    case "90d":
      return { key: k, from: addDays(to, -89), to };
    case "6m":
      return { key: k, from: addDays(addMonths(to, -6), 1), to };
    case "12m":
      return { key: k, from: addDays(addMonths(to, -12), 1), to };
    case "ytd":
      return { key: k, from: `${to.slice(0, 4)}-01-01`, to };
    case "all":
      return { key: k, from: earliest && earliest < to ? earliest : addDays(to, -29), to };
  }
}

/** Day columns for short ranges, weeks for a few months, months beyond that. */
export function autoGranularity(from: string, to: string): Granularity {
  const days = daysBetween(from, to) + 1;
  if (days <= 45) return "day";
  if (days <= 200) return "week";
  return "month";
}

export const EVENT_KINDS = [
  { key: "social_post", label: "Social media post" },
  { key: "email", label: "Email or newsletter" },
  { key: "ad", label: "Ad campaign" },
  { key: "promotion", label: "Promotion or sale" },
  { key: "website", label: "Website change" },
  { key: "press", label: "Press or mention" },
  { key: "in_person", label: "In-person event" },
  { key: "other", label: "Other" },
] as const;

export function eventKindLabel(key: string): string {
  return EVENT_KINDS.find((k) => k.key === key)?.label ?? "Other";
}

/** Numbers people track by hand. Custom ones can be added per business. */
export const BUILTIN_METRICS = [
  { key: "contacts", name: "New contacts" },
  { key: "leads", name: "Leads" },
  { key: "appointments", name: "Appointments" },
  { key: "website_visits", name: "Website visits" },
  { key: "followers", name: "New followers" },
] as const;

/** Series computed from other data rather than logged. */
export const DERIVED_METRICS = [
  { key: "sales_count", name: "Sales count" },
  { key: "link_clicks", name: "Link clicks" },
] as const;

export function metricKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}
