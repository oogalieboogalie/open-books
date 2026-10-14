import Link from "next/link";
import { money, shortDate, todayIso } from "@/lib/format";
import { Receipts, type MatchCandidate, type Receipt, type ReceiptStatus } from "@/lib/receipts/receipts";
import { getBooks } from "@/lib/server";
import { deleteReceiptAction, ignoreReceiptAction, linkReceiptAction, receiptToTransactionAction, unlinkReceiptAction, updateReceiptAction } from "../integrations/actions";
import { ReceiptUploadForm } from "../integrations/IntegrationForms";

export const dynamic = "force-dynamic";

const TABS: { key: ReceiptStatus | "all"; label: string }[] = [
  { key: "unmatched", label: "To match" },
  { key: "matched", label: "Matched" },
  { key: "ignored", label: "Ignored" },
  { key: "all", label: "All" },
];

const SOURCE_LABEL: Record<Receipt["source"], string> = { forward: "Forwarded", gmail: "Gmail", imap: "Mailbox", upload: "Uploaded" };

function fileLabel(f: Receipt["files"][number]): string {
  if (f.contentType === "text/html") return "Original email";
  if (f.contentType === "application/pdf") return f.filename || "PDF";
  return f.filename || "Photo";
}

export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<{ status?: string; id?: string; page?: string }> }) {
  const params = await searchParams;
  const books = await getBooks();
  const receipts = Receipts.for(books);
  const focusId = Number(params.id) || null;
  const status = (TABS.some((t) => t.key === params.status) ? params.status : focusId ? "all" : "unmatched") as ReceiptStatus | "all";
  const page = Math.max(1, Number(params.page) || 1);
  const perPage = 25;
  const [counts, accounts, list, focus] = await Promise.all([
    receipts.counts(),
    books.listAccounts(),
    receipts.list({ status: status === "all" ? undefined : status, limit: perPage, offset: (page - 1) * perPage }),
    focusId ? receipts.get(focusId) : null,
  ]);
  const rows = focus ? [focus, ...list.rows.filter((r) => r.id !== focus.id)] : list.rows;
  const candidates = new Map<number, MatchCandidate[]>();
  const linked = new Map<number, { description: string; date: string; amountCents: number }>();
  await Promise.all(
    rows.map(async (r) => {
      if (r.status === "unmatched") candidates.set(r.id, await receipts.candidates(r.id, 4));
      if (r.transactionId) {
        const t = await books.getTransaction(r.transactionId);
        if (t) linked.set(r.id, t);
      }
    }),
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pageCount = Math.max(1, Math.ceil(list.total / perPage));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Receipts</h1>
          <p className="muted">
            Receipts from email and uploads, matched to the transactions they belong to. <Link href="/integrations#email">Set up email receipts</Link>
          </p>
        </div>
      </div>

      <div className="grid-2">
        <div className="kpis" style={{ alignContent: "start" }}>
          <div className="kpi"><div className="label">To match</div><div className="value">{counts.unmatched}</div><div className="sub">waiting for a transaction</div></div>
          <div className="kpi"><div className="label">Matched</div><div className="value">{counts.matched}</div><div className="sub">attached to transactions</div></div>
        </div>
        <ReceiptUploadForm today={todayIso()} />
      </div>

      <div className="card">
        <div className="filters" style={{ marginBottom: 8 }}>
          <div className="segmented" role="group" aria-label="Show">
            {TABS.map((t) => (
              <Link key={t.key} href={`?status=${t.key}`} aria-current={t.key === status ? "true" : undefined}>
                {t.label} ({t.key === "all" ? total : counts[t.key]})
              </Link>
            ))}
          </div>
        </div>

        {rows.length === 0 && (
          <p className="muted">
            {status === "unmatched" ? "Nothing waiting. Receipts that arrive before their transaction is imported wait here, then match on their own." : "No receipts here yet."}
          </p>
        )}

        {rows.map((r) => {
          const t = linked.get(r.id);
          const cands = candidates.get(r.id) ?? [];
          return (
            <article key={r.id} className={`receipt${r.id === focusId ? " focus" : ""}`} id={`r${r.id}`}>
              <div>
                <strong>{r.vendor || r.subject || "Receipt"}</strong>{" "}
                {r.status === "matched" && <span className="tag good">Matched{r.matchKind === "auto" ? " automatically" : ""}</span>}
                {r.status === "ignored" && <span className="tag">Ignored</span>}
                {r.amountCents !== null && !r.amountConfident && <span className="tag review">Check the amount</span>}
                <div className="tx-meta">
                  {r.date ? shortDate(r.date) : "No date"} · {SOURCE_LABEL[r.source]}
                  {r.fromAddress && <> · {r.fromName ? `${r.fromName} ` : ""}&lt;{r.fromAddress}&gt;</>}
                  {r.orderRef && <> · Order {r.orderRef}</>}
                </div>
                {r.subject && r.subject !== r.vendor && <div className="tx-meta">{r.subject}</div>}
              </div>
              <div className="amount">{r.amountCents === null ? <span className="muted">No amount</span> : money(r.amountCents)}</div>

              <div className="body">
                {r.files.length > 0 && (
                  <div className="tx-actions">
                    {r.files.map((f) => (
                      <a key={f.id} href={`/receipts/files/${f.id}`} target="_blank" rel="noreferrer">{fileLabel(f)}</a>
                    ))}
                  </div>
                )}

                {t && (
                  <div className="candidate">
                    <span>
                      {t.description} <span className="muted">· {shortDate(t.date)}</span>
                    </span>
                    <span className="inline-form">
                      <strong className="num">{money(t.amountCents)}</strong>
                      <form action={unlinkReceiptAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <button type="submit" className="link">Unlink</button>
                      </form>
                    </span>
                  </div>
                )}

                {r.status === "unmatched" && (
                  <>
                    {cands.length > 0 ? (
                      <>
                        <div className="tx-meta">Is it one of these?</div>
                        {cands.map((c) => (
                          <div key={c.id} className="candidate">
                            <span>
                              {c.description} <span className="muted">· {shortDate(c.date)} · {c.reason}</span>
                            </span>
                            <span className="inline-form">
                              <strong className="num">{money(c.amountCents)}</strong>
                              <form action={linkReceiptAction}>
                                <input type="hidden" name="id" value={r.id} />
                                <input type="hidden" name="transactionId" value={c.id} />
                                <button type="submit" className="secondary">This one</button>
                              </form>
                            </span>
                          </div>
                        ))}
                      </>
                    ) : (
                      <div className="tx-meta">No matching charge yet. It will match automatically when the transaction is imported.</div>
                    )}
                    <div className="tx-actions">
                      <details>
                        <summary>Fix the details</summary>
                        <form action={updateReceiptAction} className="inline-form" style={{ marginTop: 6 }}>
                          <input type="hidden" name="id" value={r.id} />
                          <input name="vendor" defaultValue={r.vendor} placeholder="Paid to" aria-label="Paid to" />
                          <input name="amount" defaultValue={r.amountCents !== null ? (r.amountCents / 100).toFixed(2) : ""} placeholder="Amount" aria-label="Amount" inputMode="decimal" style={{ width: 110 }} />
                          <input type="date" name="date" defaultValue={r.date ?? ""} aria-label="Date" />
                          <button type="submit" className="secondary">Save</button>
                        </form>
                      </details>
                      {r.amountCents !== null && r.date && (
                        <details>
                          <summary>Record as a new expense</summary>
                          <form action={receiptToTransactionAction} className="inline-form" style={{ marginTop: 6 }}>
                            <input type="hidden" name="id" value={r.id} />
                            <select name="accountId" aria-label="Paid from">
                              {accounts.map((a) => (
                                <option key={a.id} value={a.id}>{a.name}</option>
                              ))}
                            </select>
                            <button type="submit" className="secondary">Add {money(-r.amountCents)}</button>
                          </form>
                          <p className="tx-meta" style={{ margin: "4px 0 0" }}>For cash or a card you don&apos;t import, so it isn&apos;t counted twice.</p>
                        </details>
                      )}
                    </div>
                  </>
                )}

                <div className="tx-actions">
                  {r.status !== "matched" && (
                    <form action={ignoreReceiptAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="ignored" value={r.status === "ignored" ? "0" : "1"} />
                      <button type="submit" className="link">{r.status === "ignored" ? "Restore" : "Not a business expense"}</button>
                    </form>
                  )}
                  <form action={deleteReceiptAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="danger">Delete</button>
                  </form>
                </div>
              </div>
            </article>
          );
        })}

        {pageCount > 1 && (
          <p className="filters">
            {page > 1 && <Link href={`?status=${status}&page=${page - 1}`}>Previous</Link>}
            <span className="muted">Page {page} of {pageCount}</span>
            {page < pageCount && <Link href={`?status=${status}&page=${page + 1}`}>Next</Link>}
          </p>
        )}
      </div>
    </>
  );
}
