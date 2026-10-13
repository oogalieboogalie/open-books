import Link from "next/link";
import { money, pickYear } from "@/lib/format";
import { buildScheduleC } from "@/lib/reports";
import { getBooks } from "@/lib/server";
import { YearPicker } from "../components/YearPicker";

export const dynamic = "force-dynamic";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const books = await getBooks();
  const years = await books.years();
  const year = pickYear((await searchParams).year, years);
  const s = buildScheduleC(await books.categoryTotals(year), year);
  const review = await books.reviewCount();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tax report: {year}</h1>
          <p className="muted">Your books laid out like Schedule C (Profit or Loss From Business). Share it with your tax preparer.</p>
        </div>
        <div className="filters">
          <YearPicker years={years} year={year} />
          <a href={`/reports/export?year=${year}`}>Download CSV</a>
        </div>
      </div>

      {(review > 0 || s.uncategorizedCents !== 0) && (
        <div className="banner">
          {s.uncategorizedCents !== 0 && <>{money(Math.abs(s.uncategorizedCents))} is uncategorized and not counted below. </>}
          {review > 0 && <>{review} transaction{review === 1 ? "" : "s"} could use a review. </>}
          <Link href="/transactions?review=1">Review now</Link>
        </div>
      )}

      <div className="card table-wrap">
        <h2>Part I: Income</h2>
        <table>
          <tbody>
            <Row line="1" label="Gross receipts or sales" cents={s.grossReceiptsCents} />
            <Row line="2" label="Returns and allowances" cents={s.returnsCents} />
            <Row line="4" label="Cost of goods sold" cents={s.cogsCents} />
            <Row line="5" label="Gross profit" cents={s.grossProfitCents} />
            <Row line="6" label="Other income" cents={s.otherIncomeCents} />
            <Row line="7" label="Gross income" cents={s.grossIncomeCents} total />
          </tbody>
        </table>
      </div>

      <div className="card table-wrap">
        <h2>Part II: Expenses</h2>
        <table>
          <thead>
            <tr>
              <th>Line</th>
              <th>Expense</th>
              <th className="num">Spent</th>
              <th className="num">Deductible</th>
            </tr>
          </thead>
          <tbody>
            {s.expenseLines.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">No expenses recorded for {year}.</td>
              </tr>
            )}
            {s.expenseLines.flatMap((l) => [
              <tr key={l.line}>
                <td>{l.line}</td>
                <td>{l.label}</td>
                <td className="num">{money(l.amountCents)}</td>
                <td className="num">{money(l.deductibleCents)}</td>
              </tr>,
              ...(l.categories.length > 1
                ? l.categories.map((c) => (
                    <tr className="sub" key={`${l.line}-${c.category.id}`}>
                      <td />
                      <td><Link href={`/transactions?year=${year}&category=${c.category.id}`}>{c.category.name}</Link></td>
                      <td className="num">{money(c.amountCents)}</td>
                      <td />
                    </tr>
                  ))
                : []),
            ])}
            <tr className="total">
              <td>28</td>
              <td>Total expenses</td>
              <td />
              <td className="num">{money(s.totalExpensesCents)}</td>
            </tr>
            <tr className="total">
              <td>31</td>
              <td>Net profit or (loss)</td>
              <td />
              <td className="num">{money(s.netProfitCents)}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Line 30 (business use of your home) is not included. If you work from home, you may be able to deduct $5 per square foot of
          dedicated office space, up to 300 sq ft, using the simplified method.
        </p>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Self-employment tax estimate</h2>
          <table>
            <tbody>
              <Row label="Net earnings from self-employment (92.35%)" cents={s.seTax.netEarningsCents} />
              <Row label={`Social Security (12.4%, up to ${money(s.seTax.wageBaseCents)})`} cents={s.seTax.socialSecurityCents} />
              <Row label="Medicare (2.9%)" cents={s.seTax.medicareCents} />
              <Row label="Estimated SE tax" cents={s.seTax.totalCents} total />
              <Row label="Half is deductible (Schedule 1)" cents={s.seTax.deductibleHalfCents} />
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            This is on top of income tax. It ignores W-2 wages and the 0.9% Additional Medicare Tax, so treat it as a planning number.
          </p>
        </div>
        <div className="card">
          <h2>Outside Schedule C</h2>
          {s.otherDeductions.length === 0 && s.nonPl.length === 0 && <p className="muted">Nothing for {year}.</p>}
          <table>
            <tbody>
              {s.otherDeductions.map((d) => (
                <Row key={d.category.id} line={d.category.taxLine ?? ""} label={`${d.category.name} (deductible)`} cents={d.amountCents} />
              ))}
              {s.nonPl.map((d) => (
                <Row key={d.category.id} line="" label={`${d.category.name} (not deductible)`} cents={d.amountCents} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Row({ line, label, cents, total }: { line?: string; label: string; cents: number; total?: boolean }) {
  return (
    <tr className={total ? "total" : undefined}>
      {line !== undefined && <td>{line}</td>}
      <td>{label}</td>
      <td className="num">{money(cents)}</td>
    </tr>
  );
}
