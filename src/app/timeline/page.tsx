import Link from "next/link";
import { headers } from "next/headers";
import { Activity } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { todayIso } from "@/lib/format";
import { getBooks } from "@/lib/server";
import { EVENT_KINDS, RANGE_PRESETS, autoGranularity, eventKindLabel, formatDay, resolveRange, type Granularity } from "@/lib/timeline";
import { deleteEventAction, deleteLinkAction } from "../actions";
import { EventForm, LinkForm, MetricForm } from "../components/ActivityForms";
import { TimelineExplorer } from "../components/TimelineExplorer";

export const dynamic = "force-dynamic";

type Params = { range?: string; by?: string; focus?: string };

export default async function TimelinePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const books = getBooks();
  const activity = Activity.for(books, getDb());
  const today = todayIso();
  const range = resolveRange(params.range, today, activity.earliestDate());
  const granularity: Granularity = params.by === "day" || params.by === "week" || params.by === "month" ? params.by : autoGranularity(range.from, range.to);
  const data = activity.timeline(range.from, range.to, granularity);
  const recentEvents = activity.listEvents(range.from, range.to).reverse().slice(0, 10);
  const links = activity.listLinks();
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  const href = (p: Partial<Params>) => `?${new URLSearchParams({ range: range.key, by: granularity, ...p } as Record<string, string>).toString()}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Timeline</h1>
          <p className="muted">Money, events, and the numbers you track, on one timeline. Hover a column, click it to see what happened.</p>
        </div>
      </div>

      <div className="card">
        <div className="filters" style={{ marginBottom: 12 }}>
          <div className="segmented" role="group" aria-label="Date range">
            {RANGE_PRESETS.map((p) => (
              <Link key={p.key} href={`?range=${p.key}`} aria-current={p.key === range.key ? "true" : undefined}>{p.label}</Link>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Group by">
            {(["day", "week", "month"] as const).map((g) => (
              <Link key={g} href={href({ by: g })} aria-current={g === granularity ? "true" : undefined}>By {g}</Link>
            ))}
          </div>
          <span className="muted" style={{ fontSize: "0.85rem" }}>{formatDay(range.from, true)} to {formatDay(range.to, true)}</span>
        </div>
        <TimelineExplorer key={`${range.key}-${granularity}`} data={data} initialFocus={params.focus} />
      </div>

      <div className="grid-2">
        <EventForm today={today} kinds={EVENT_KINDS.map((k) => ({ ...k }))} />
        <MetricForm today={today} metrics={activity.metricDefs().filter((m) => !m.derived)} />
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Events in this range</h2>
          {recentEvents.length === 0 && <p className="muted">None yet.</p>}
          <ul className="plain-list">
            {recentEvents.map((e) => (
              <li key={e.id}>
                <span className="tag">{eventKindLabel(e.kind)}</span> <strong>{e.title}</strong>
                <div className="tx-meta">
                  {formatDay(e.date, true)}
                  {e.linkSlug && <> · tracked as /go/{e.linkSlug}</>}
                </div>
                <form action={deleteEventAction}>
                  <input type="hidden" name="id" value={e.id} />
                  <button type="submit" className="danger" style={{ fontSize: "0.85rem" }}>Delete</button>
                </form>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h2>Tracked links</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Put one of these in a post instead of the plain link. Each click is counted on the day it happens, then the visitor is sent on to your page.
          </p>
          <ul className="plain-list">
            {links.map((l) => (
              <li key={l.id}>
                <code>{origin}/go/{l.slug}</code> <strong>{l.clicks}</strong> click{l.clicks === 1 ? "" : "s"}
                <div className="tx-meta">
                  {l.eventTitle ? `${l.eventTitle} · ` : ""}to {l.destination}
                </div>
                <form action={deleteLinkAction}>
                  <input type="hidden" name="id" value={l.id} />
                  <button type="submit" className="danger" style={{ fontSize: "0.85rem" }}>Delete</button>
                </form>
              </li>
            ))}
          </ul>
          <LinkForm />
        </div>
      </div>
    </>
  );
}
