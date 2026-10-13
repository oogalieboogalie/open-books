import Link from "next/link";
import { getCategory } from "@/lib/categories";
import { money, moneyWhole, pickYear, shortDate } from "@/lib/format";
import { buildScheduleC } from "@/lib/reports";
import { getBooks } from "@/lib/server";
import { Activity } from "@/lib/activity";
import { TimelineExplorer } from "./components/TimelineExplorer";
import { YearPicker } from "./components/YearPicker";

export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ year?: string; focus?: string }> }) {
  const params = await searchParams;
  const books = await getBooks();
  const years = await books.years();
  const year = pickYear(params.year, years);
  const summary = buildScheduleC(await books.categoryTotals(year), year);
  const review = await books.reviewCount();
  const recent = (await books.listTransactions({ year, limit: 8 })).rows;
  const timeline = await Activity.for(books).timeline(`${year}-01-01`, `${year}-12-31`, "month");
  const topLines = [...summary.expenseLines].sort((a, b) => b.deductibleCents - a.deductibleCents).slice(0, 8);
  const topMax = Math.max(1, ...topLines.map((l) => l.amountCents));

  if (years.length === 0) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Welcome to Open Books</h1>
            <p className="muted">Track income and expenses, sorted into the categories your tax return uses.</p>
          </div>
        </div>
        <div className="card">
          <h2>Get started</h2>
          <ol>
            <li><Link href="/import">Import a CSV</Link> from your business bank account or credit card. Every transaction gets a tax category automatically.</li>
            <li><Link href="/transactions?review=1">Review</Link> anything the categorizer was unsure about. Your corrections become rules, so it learns your business.</li>
            <li>Open the <Link href="/reports">tax report</Link> to see your numbers laid out like Schedule C.</li>
          </ol>
          <p className="muted">Prefer to type them in? <Link href="/transactions">Add transactions by hand.</Link></p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Year to date, {year}</p>
        </div>
        <YearPicker years={years} year={year} />
      </div>

      {review > 0 && (
        <div className="banner">
          {review} transaction{review === 1 ? "" : "s"} need{review === 1 ? "s" : ""} a category check. <Link href="/transactions?review=1">Review now</Link>
        </div>
      )}

      <section className="kpis" aria-label="Summary">
        <Kpi label="Income" value={moneyWhole(summary.grossIncomeCents)} sub="Gross income (Sch. C line 7)" />
        <Kpi label="Deductible expenses" value={moneyWhole(summary.totalExpensesCents)} sub="Sch. C line 28" />
        <Kpi label="Net profit" value={moneyWhole(summary.netProfitCents)} sub="Sch. C line 31" />
        <Kpi label="Est. self-employment tax" value={moneyWhole(summary.seTax.totalCents)} sub="Plan to set this aside" />
      </section>

      <div className="card">
        <div className="page-head" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Income and expenses by month</h2>
          <Link href="/timeline">Open the timeline for days, weeks, and events</Link>
        </div>
        <TimelineExplorer key={year} data={timeline} initialFocus={params.focus} />
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Where the money went</h2>
          {topLines.length === 0 && <p className="muted">No expenses yet.</p>}
          {topLines.map((l) => (
            <div className="bar-row" key={l.line}>
              <span>{l.label}</span>
              <span className="bar-track"><span className="bar-fill" style={{ display: "block", width: `${(Math.max(0, l.amountCents) / topMax) * 100}%` }} /></span>
              <span className="num">{money(l.amountCents)}</span>
            </div>
          ))}
          <p><Link href={`/reports?year=${year}`}>Full tax report</Link></p>
        </div>
        <div className="card">
          <h2>Recent transactions</h2>
          <table>
            <tbody>
              {recent.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="tx-desc">{t.description}</div>
                    <div className="tx-meta">{shortDate(t.date)} · {getCategory(t.categoryId).name}</div>
                  </td>
                  <td className={`num ${t.amountCents > 0 ? "pos" : ""}`}>{money(t.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p><Link href="/transactions">All transactions</Link></p>
        </div>
      </div>
    </>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}
