import { getBooks } from "@/lib/server";
import { AccountForm, ImportForm } from "../components/Forms";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const accounts = await (await getBooks()).listAccounts();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Import transactions</h1>
          <p className="muted">Download a CSV from your bank or card&apos;s website and upload it here. Each transaction is categorized automatically.</p>
        </div>
      </div>
      <ImportForm accounts={accounts} />
      <div className="grid-2">
        <div className="card">
          <h2>Accounts</h2>
          <ul>
            {accounts.map((a) => (
              <li key={a.id}>{a.name} <span className="muted">({a.type.replace("_", " ")})</span></li>
            ))}
          </ul>
          <AccountForm />
        </div>
        <div className="card">
          <h2>Tips</h2>
          <ul>
            <li>Most banks offer CSV under &quot;Download&quot; or &quot;Export&quot; on the activity page.</li>
            <li>The file needs a header row with a date, a description, and either an amount or separate debit and credit columns.</li>
            <li>Importing an overlapping date range is safe: transactions already imported are skipped.</li>
            <li>Keep your books in Google Sheets? <a href="/integrations#sheets">Connect the sheet</a> and new rows come in automatically.</li>
            <li>Keep business and personal spending in separate accounts if you can. It makes your books much cleaner.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
