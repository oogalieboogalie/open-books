import { money, moneyWhole } from "@/lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Income vs. expenses per month as paired bars. Each bar has a hover tooltip. */
export function MonthlyChart({ data }: { data: { month: number; incomeCents: number; expenseCents: number }[] }) {
  const W = 720;
  const H = 240;
  const pad = { top: 10, right: 8, bottom: 26, left: 56 };
  const max = Math.max(1, ...data.flatMap((d) => [d.incomeCents, d.expenseCents]));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const plotH = H - pad.top - pad.bottom;
  const band = (W - pad.left - pad.right) / 12;
  const barW = Math.min(18, (band - 10) / 2);
  const y = (v: number) => pad.top + plotH - (Math.max(0, v) / top) * plotH;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <div className="legend" aria-hidden="true">
        <span><i style={{ background: "var(--income)" }} />Income</span>
        <span><i style={{ background: "var(--expense)" }} />Expenses</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Monthly income and expenses">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={pad.left - 8} y={y(t) + 4} textAnchor="end">{moneyWhole(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.left + band * i + band / 2;
          return (
            <g key={d.month}>
              <Bar x={cx - barW - 1} w={barW} y0={y(0)} y1={y(d.incomeCents)} fill="var(--income)" label={`${MONTHS[i]} income: ${money(d.incomeCents)}`} />
              <Bar x={cx + 1} w={barW} y0={y(0)} y1={y(d.expenseCents)} fill="var(--expense)" label={`${MONTHS[i]} expenses: ${money(d.expenseCents)}`} />
              <text className="axis" x={cx} y={H - 8} textAnchor="middle">{MONTHS[i]}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="muted" style={{ fontSize: "0.8rem" }}>Hover a bar for its amount. Expenses are before deduction limits.</figcaption>
    </figure>
  );
}

function Bar({ x, w, y0, y1, fill, label }: { x: number; w: number; y0: number; y1: number; fill: string; label: string }) {
  const h = y0 - y1;
  const r = Math.min(4, h / 2, w / 2);
  // Rounded top, square base anchored to the axis.
  const d = h <= 0 ? "" : `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`;
  return (
    <g>
      <title>{label}</title>
      {d && <path d={d} fill={fill} />}
      <rect x={x - 2} y={10} width={w + 4} height={y0 - 10} fill="transparent" />
    </g>
  );
}

function niceStep(raw: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}
