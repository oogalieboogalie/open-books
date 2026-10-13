import Link from "next/link";
import { getCategory } from "@/lib/categories";
import { money, pickYear, shortDate } from "@/lib/format";
import { getBooks } from "@/lib/server";
import { deleteTransactionAction, markReviewedAction, updateNotesAction } from "../actions";
import { CategoryOptions } from "../components/CategoryOptions";
import { CategoryPicker } from "../components/CategoryPicker";
import { AddTransactionForm } from "../components/Forms";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

type Params = { year?: string; category?: string; review?: string; q?: string; account?: string; page?: string; from?: string; to?: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const books = await getBooks();
  const years = await books.years();
  const year = params.year === "all" ? undefined : pickYear(params.year, years);
  const page = Math.max(1, Number(params.page) || 1);
  const needsReview = params.review === "1";
  const accounts = await books.listAccounts();
  const { rows, total } = await books.listTransactions({
    year,
    from: params.from && ISO.test(params.from) ? params.from : undefined,
    to: params.to && ISO.test(params.to) ? params.to : undefined,
    categoryId: params.category || undefined,
    needsReview,
    search: params.q || undefined,
    accountId: Number(params.account) || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (p: number) => `?${new URLSearchParams({ ...params, page: String(p) } as Record<string, string>).toString()}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Transactions</h1>
          <p className="muted">
            {total} transaction{total === 1 ? "" : "s"}
            {needsReview ? " to review" : ""}
            {params.from && params.to ? ` from ${shortDate(params.from)} to ${shortDate(params.to)}` : ""}. Change a category and Open Books remembers it for that merchant.
          </p>
        </div>
      </div>

      <form className="filters card" method="get" aria-label="Filters">
        <select name="year" defaultValue={year ?? "all"} aria-label="Year">
          <option value="all">All years</option>
          {[...new Set([...(year ? [year] : []), ...years])].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <select name="category" defaultValue={params.category ?? ""} aria-label="Category">
          <option value="">All categories</option>
          <CategoryOptions />
        </select>
        {accounts.length > 1 && (
          <select name="account" defaultValue={params.account ?? ""} aria-label="Account">
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}
        <input type="search" name="q" defaultValue={params.q ?? ""} placeholder="Search" aria-label="Search descriptions and notes" />
        <label className="muted">
          <input type="checkbox" name="review" value="1" defaultChecked={needsReview} /> Needs review only
        </label>
        <button type="submit" className="secondary">Filter</button>
        {(params.category || params.q || needsReview || params.account || params.from) && <Link href="/transactions">Clear</Link>}
      </form>

      <div className="card table-wrap">
        {rows.length === 0 ? (
          <p className="muted">
            Nothing here yet. <Link href="/import">Import a CSV</Link> or add a transaction below.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="col-date">Date</th>
                <th>Description</th>
                <th>Category</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="muted col-date" style={{ whiteSpace: "nowrap" }}>{shortDate(t.date)}</td>
                  <td>
                    <div className="tx-desc">{t.description}</div>
                    <div className="tx-meta">
                      <span className="date-inline">{shortDate(t.date)} · </span>
                      {t.accountName}
                      {t.notes && <> · {t.notes}</>}
                    </div>
                    <div className="tx-actions">
                      <details>
                        <summary>Notes</summary>
                        <form action={updateNotesAction} className="inline-form" style={{ marginTop: 6 }}>
                          <input type="hidden" name="id" value={t.id} />
                          <input name="notes" defaultValue={t.notes} placeholder="Business purpose, attendees…" aria-label="Notes" />
                          <button type="submit" className="secondary">Save</button>
                        </form>
                      </details>
                      <form action={deleteTransactionAction}>
                        <input type="hidden" name="id" value={t.id} />
                        <button type="submit" className="danger">Delete</button>
                      </form>
                    </div>
                  </td>
                  <td>
                    <CategoryPicker id={t.id} categoryId={t.categoryId} merchant={t.merchantKey}>
                      <CategoryOptions />
                    </CategoryPicker>
                    <div className="tx-meta">
                      {t.needsReview ? <span className="tag review">Needs review</span> : null} {t.reason}
                      {getCategory(t.categoryId).deductiblePct === 50 ? " · 50% deductible" : ""}
                    </div>
                    {t.needsReview && (
                      <form action={markReviewedAction}>
                        <input type="hidden" name="id" value={t.id} />
                        <button type="submit" className="link" style={{ fontSize: "0.85rem" }}>Looks right</button>
                      </form>
                    )}
                  </td>
                  <td className={`num ${t.amountCents > 0 ? "pos" : ""}`}>{money(t.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {pageCount > 1 && (
          <p className="filters">
            {page > 1 && <Link href={pageHref(page - 1)}>Previous</Link>}
            <span className="muted">Page {page} of {pageCount}</span>
            {page < pageCount && <Link href={pageHref(page + 1)}>Next</Link>}
          </p>
        )}
      </div>

      <AddTransactionForm accounts={accounts} today={new Date().toISOString().slice(0, 10)}>
        <CategoryOptions includeAuto />
      </AddTransactionForm>
    </>
  );
}
