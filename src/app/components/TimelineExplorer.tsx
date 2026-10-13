"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PeriodDetail, TimelineData } from "@/lib/activity";
import { eventKindLabel, formatDay } from "@/lib/timeline";

type Detail = Omit<PeriodDetail, "transactions"> & { transactions: (PeriodDetail["transactions"][number] & { categoryName: string })[] };

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
// Hand-rolled so server and browser render identical text (compact Intl output varies by ICU version).
const usdShort = (dollars: number) => (dollars >= 1_000_000 ? `$${+(dollars / 1_000_000).toFixed(1)}M` : dollars >= 1000 ? `$${+(dollars / 1000).toFixed(1)}k` : `$${dollars}`);
const money = (cents: number) => usd.format(cents / 100 + 0);
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

const PAD = { left: 64, right: 12 };
const MAIN_H = 260;
const EVENT_BAND = 22;
const AXIS_H = 24;
const SMALL_H = 64;

/**
 * Income and expenses over time with events and tracked numbers on the same
 * x-axis. Hover a column to see that period; click it (or press Enter) to see
 * every transaction, event, and number behind it.
 */
export function TimelineExplorer({ data, initialFocus }: { data: TimelineData; initialFocus?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [hover, setHover] = useState<number | null>(null);
  const initial = initialFocus ? data.buckets.findIndex((b) => b.start === initialFocus) : -1;
  const [selected, setSelected] = useState<number | null>(initial >= 0 ? initial : null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(300, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = data.buckets.length;
  const plotW = width - PAD.left - PAD.right;
  const band = plotW / Math.max(1, n);
  const cx = (i: number) => PAD.left + band * i + band / 2;
  const barW = Math.max(1, Math.min(16, (band - 4) / 2));

  const max = Math.max(1, ...data.buckets.flatMap((b) => [b.incomeCents, b.expenseCents]));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const plotTop = EVENT_BAND + 6;
  const plotH = MAIN_H - plotTop - AXIS_H;
  const y = (v: number) => plotTop + plotH - (Math.max(0, v) / top) * plotH;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(plotW / 64)));

  const eventsByBucket = new Map<number, TimelineData["events"]>();
  for (const e of data.events) {
    if (e.bucket < 0) continue;
    eventsByBucket.set(e.bucket, [...(eventsByBucket.get(e.bucket) ?? []), e]);
  }

  const select = useCallback(
    (i: number) => {
      setSelected(i);
      const b = data.buckets[i];
      const url = new URL(window.location.href);
      url.searchParams.set("focus", b.start);
      window.history.replaceState(null, "", url);
    },
    [data.buckets],
  );

  useEffect(() => {
    if (selected === null) return;
    const b = data.buckets[selected];
    if (!b) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetch(`/api/period?from=${b.start}&to=${b.end}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d: Detail) => {
        setDetail(d);
        setLoading(false);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [selected, data.buckets]);

  const pick = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const i = Math.floor((clientX - rect.left - PAD.left) / band);
    return i >= 0 && i < n ? i : null;
  };

  const onKey = (e: React.KeyboardEvent) => {
    const cur = hover ?? selected ?? n - 1;
    if (e.key === "ArrowLeft") setHover(Math.max(0, cur - 1));
    else if (e.key === "ArrowRight") setHover(Math.min(n - 1, cur + 1));
    else if (e.key === "Enter" || e.key === " ") select(cur);
    else return;
    e.preventDefault();
  };

  const active = hover ?? null;
  const tipBucket = active !== null ? data.buckets[active] : null;
  const tipLeft = active !== null ? cx(active) : 0;
  const flip = tipLeft > width - 240;

  const columnInteraction = {
    onMouseMove: (e: React.MouseEvent) => setHover(pick(e.clientX)),
    onMouseLeave: () => setHover(null),
    onClick: (e: React.MouseEvent) => {
      const i = pick(e.clientX);
      if (i !== null) select(i);
    },
  };

  return (
    <div className="timeline">
      <div className="legend" aria-hidden="true">
        <span><i style={{ background: "var(--income)" }} />Income</span>
        <span><i style={{ background: "var(--expense)" }} />Expenses</span>
        <span><i className="event-key" />Event</span>
      </div>

      <div
        ref={wrap}
        className="timeline-plot"
        tabIndex={0}
        role="group"
        aria-label="Timeline. Use left and right arrows to move between periods and Enter to see details."
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <svg width={width} height={MAIN_H} {...columnInteraction} role="img" aria-label={`Income and expenses by ${data.granularity}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="axis" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">{usdShort(t / 100)}</text>
            </g>
          ))}
          {selected !== null && <rect className="col-selected" x={PAD.left + band * selected} y={0} width={band} height={MAIN_H - AXIS_H} />}
          {active !== null && <rect className="col-hover" x={PAD.left + band * active} y={0} width={band} height={MAIN_H - AXIS_H} />}
          {[...eventsByBucket.entries()].map(([i, evs]) => (
            <g key={`ev-${i}`} className="event-marker">
              <line x1={cx(i)} x2={cx(i)} y1={EVENT_BAND - 2} y2={MAIN_H - AXIS_H} />
              <circle cx={cx(i)} cy={EVENT_BAND / 2} r={evs.length > 1 ? 8 : 5} />
              {evs.length > 1 && <text x={cx(i)} y={EVENT_BAND / 2 + 4} textAnchor="middle">{evs.length}</text>}
            </g>
          ))}
          {data.buckets.map((b, i) => (
            <g key={b.start}>
              <Bar x={cx(i) - barW - 1} w={barW} y0={y(0)} y1={y(b.incomeCents)} fill="var(--income)" />
              <Bar x={cx(i) + 1} w={barW} y0={y(0)} y1={y(b.expenseCents)} fill="var(--expense)" />
              {i % labelEvery === 0 && (
                <text className="axis" x={cx(i)} y={MAIN_H - 7} textAnchor="middle">{shortLabel(b.start, data.granularity)}</text>
              )}
            </g>
          ))}
          <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
        </svg>

        {data.series.map((s) => {
          const smax = Math.max(1, ...s.values);
          const sy = (v: number) => 6 + (SMALL_H - 12) * (1 - v / smax);
          const total = s.values.reduce((a, b) => a + b, 0);
          return (
            <div className="small-multiple" key={s.key}>
              <div className="sm-title">
                <span>{s.name}</span>
                <span className="muted">{num(total)} in range</span>
              </div>
              <svg width={width} height={SMALL_H} {...columnInteraction} role="img" aria-label={`${s.name} by ${data.granularity}`}>
                {selected !== null && <rect className="col-selected" x={PAD.left + band * selected} y={0} width={band} height={SMALL_H} />}
                {active !== null && <rect className="col-hover" x={PAD.left + band * active} y={0} width={band} height={SMALL_H} />}
                {[...eventsByBucket.keys()].map((i) => (
                  <line key={i} className="event-guide" x1={cx(i)} x2={cx(i)} y1={0} y2={SMALL_H} />
                ))}
                <text className="axis" x={PAD.left - 8} y={14} textAnchor="end">{num(smax)}</text>
                {s.values.map((v, i) => (
                  <Bar key={i} x={cx(i) - Math.max(1, Math.min(14, band - 4)) / 2} w={Math.max(1, Math.min(14, band - 4))} y0={SMALL_H - 6} y1={sy(v)} fill="var(--metric)" />
                ))}
                <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={SMALL_H - 6} y2={SMALL_H - 6} />
              </svg>
            </div>
          );
        })}

        {tipBucket && active !== null && (
          <div className="tooltip" style={flip ? { right: width - tipLeft + 12 } : { left: tipLeft + 12 }} role="status">
            <strong>{tipBucket.label}</strong>
            <div><i style={{ background: "var(--income)" }} />Income <b>{money(tipBucket.incomeCents)}</b></div>
            <div><i style={{ background: "var(--expense)" }} />Expenses <b>{money(tipBucket.expenseCents)}</b></div>
            {data.series.map((s) =>
              s.values[active] ? (
                <div key={s.key}><i style={{ background: "var(--metric)" }} />{s.name} <b>{num(s.values[active])}</b></div>
              ) : null,
            )}
            {(eventsByBucket.get(active) ?? []).map((e) => (
              <div key={e.id} className="tip-event"><i className="event-key" />{e.title}</div>
            ))}
            <div className="muted tip-hint">Click for details</div>
          </div>
        )}
      </div>

      {data.series.length === 0 && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Log events and daily numbers (contacts, appointments, leads) below and they&apos;ll appear here, lined up with your money.
        </p>
      )}

      <details className="table-view">
        <summary>Show as a table</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th className="num">Income</th>
                <th className="num">Expenses</th>
                {data.series.map((s) => <th key={s.key} className="num">{s.name}</th>)}
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b, i) => (
                <tr key={b.start}>
                  <td><button type="button" className="link" onClick={() => select(i)}>{b.label}</button></td>
                  <td className="num">{money(b.incomeCents)}</td>
                  <td className="num">{money(b.expenseCents)}</td>
                  {data.series.map((s) => <td key={s.key} className="num">{num(s.values[i])}</td>)}
                  <td>{(eventsByBucket.get(i) ?? []).map((e) => e.title).join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {selected !== null && (
        <div ref={detailRef} className="period-detail" aria-live="polite">
          <PeriodPanel label={data.buckets[selected].label} detail={detail} loading={loading} onClose={() => { setSelected(null); setDetail(null); }} />
        </div>
      )}
    </div>
  );
}

function PeriodPanel({ label, detail, loading, onClose }: { label: string; detail: Detail | null; loading: boolean; onClose: () => void }) {
  return (
    <section className="card">
      <div className="page-head">
        <h2 style={{ margin: 0 }}>{label}</h2>
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>
      {!detail || loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="kpis" style={{ margin: "12px 0" }}>
            <div className="kpi"><div className="label">Income</div><div className="value">{money(detail.incomeCents)}</div></div>
            <div className="kpi"><div className="label">Expenses</div><div className="value">{money(detail.expenseCents)}</div></div>
            <div className="kpi"><div className="label">Net</div><div className="value">{money(detail.incomeCents - detail.expenseCents)}</div></div>
          </div>

          <div className="grid-2">
            <div>
              <h3>What happened</h3>
              {detail.events.length === 0 && <p className="muted">No events logged.</p>}
              <ul className="plain-list">
                {detail.events.map((e) => (
                  <li key={e.id}>
                    <span className="tag">{eventKindLabel(e.kind)}</span> <strong>{e.title}</strong>
                    <div className="tx-meta">
                      {formatDay(e.date, true)}
                      {e.url && <> · <a href={e.url} target="_blank" rel="noreferrer">link</a></>}
                      {e.notes && <> · {e.notes}</>}
                    </div>
                  </li>
                ))}
              </ul>
              {detail.clicks.length > 0 && (
                <>
                  <h3>Tracked link clicks</h3>
                  <ul className="plain-list">
                    {detail.clicks.map((c) => (
                      <li key={c.slug}>
                        <strong>{c.count}</strong> on /go/{c.slug}
                        <div className="tx-meta">{c.eventTitle ? `${c.eventTitle} · ` : ""}{c.destination}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div>
              <h3>Numbers logged</h3>
              {detail.metrics.length === 0 && <p className="muted">None logged.</p>}
              <ul className="plain-list">
                {groupMetrics(detail.metrics).map((g) => (
                  <li key={g.key}>
                    <strong>{num(g.total)}</strong> {g.name}
                    {g.days.length > 1 && (
                      <div className="tx-meta">{g.days.map((d) => `${formatDay(d.date)}: ${num(d.value)}`).join(" · ")}</div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <h3>Transactions ({detail.transactionCount})</h3>
          {detail.transactions.length === 0 ? (
            <p className="muted">No transactions.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {detail.transactions.map((t) => (
                    <tr key={t.id}>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>{formatDay(t.date)}</td>
                      <td>
                        <div className="tx-desc">{t.description}</div>
                        <div className="tx-meta">{t.categoryName}{t.notes ? ` · ${t.notes}` : ""}</div>
                      </td>
                      <td className={`num ${t.amountCents > 0 ? "pos" : ""}`}>{money(t.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {detail.transactionCount > detail.transactions.length && (
            <p><a href={`/transactions?from=${detail.from}&to=${detail.to}&year=all`}>See all {detail.transactionCount} transactions</a></p>
          )}
        </>
      )}
    </section>
  );
}

function groupMetrics(metrics: Detail["metrics"]) {
  const groups = new Map<string, { key: string; name: string; total: number; days: { date: string; value: number }[] }>();
  for (const m of metrics) {
    const g = groups.get(m.key) ?? { key: m.key, name: m.name, total: 0, days: [] };
    g.total += m.value;
    g.days.push({ date: m.date, value: m.value });
    groups.set(m.key, g);
  }
  return [...groups.values()];
}

function Bar({ x, w, y0, y1, fill }: { x: number; w: number; y0: number; y1: number; fill: string }) {
  const h = y0 - y1;
  if (h <= 0) return null;
  const r = Math.min(4, h / 2, w / 2);
  return <path d={`M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`} fill={fill} pointerEvents="none" />;
}

function shortLabel(start: string, g: TimelineData["granularity"]): string {
  const [y, m, d] = start.split("-").map(Number);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  if (g === "month") return m === 1 ? `${mon} ${y}` : mon;
  return `${mon} ${d}`;
}

function niceStep(raw: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}
