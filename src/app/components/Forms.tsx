"use client";

import { useActionState } from "react";
import { addTransactionAction, createAccountAction, createRuleAction, importCsvAction, type FormState, type ImportState } from "../actions";

function Status({ state }: { state: FormState }) {
  if (state.error) return <p className="msg error" role="alert">{state.error}</p>;
  if (state.ok) return <p className="msg ok" role="status">{state.ok}</p>;
  return null;
}

export function AddTransactionForm({ accounts, today, children }: { accounts: { id: number; name: string }[]; today: string; children: React.ReactNode }) {
  const [state, action, pending] = useActionState(addTransactionAction, {});
  return (
    <form action={action} className="card form-grid">
      <h2>Add a transaction</h2>
      <label>
        Date
        <input type="date" name="date" defaultValue={today} required />
      </label>
      <label className="wide">
        Description
        <input name="description" placeholder="e.g. Staples, printer paper" required />
      </label>
      <label>
        Type
        <select name="direction" defaultValue="out">
          <option value="out">Money out</option>
          <option value="in">Money in</option>
        </select>
      </label>
      <label>
        Amount
        <input name="amount" inputMode="decimal" placeholder="0.00" required />
      </label>
      <label>
        Account
        <select name="accountId">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>
      <label className="wide">
        Category
        <select name="categoryId" defaultValue="">{children}</select>
      </label>
      <label className="wide">
        Notes
        <input name="notes" placeholder="Who, what, and why (helpful for meals and travel)" />
      </label>
      <div className="actions">
        <button type="submit" disabled={pending}>{pending ? "Adding…" : "Add transaction"}</button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function ImportForm({ accounts }: { accounts: { id: number; name: string }[] }) {
  const [state, action, pending] = useActionState<ImportState, FormData>(importCsvAction, {});
  return (
    <form action={action} className="card form-grid">
      <label className="wide">
        CSV file from your bank or card
        <input type="file" name="file" accept=".csv,text/csv" required />
      </label>
      <label>
        Account
        <select name="accountId">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>
      <label className="check wide">
        <input type="checkbox" name="flipSigns" /> Purchases show as positive numbers in this file (common for credit card exports)
      </label>
      <div className="actions">
        <button type="submit" disabled={pending}>{pending ? "Importing…" : "Import"}</button>
      </div>
      {state.error && <p className="msg error wide" role="alert">{state.error}</p>}
      {state.imported !== undefined && (
        <div className="msg ok wide" role="status">
          <p>
            Imported {state.imported} transaction{state.imported === 1 ? "" : "s"}
            {state.duplicates ? `, skipped ${state.duplicates} already imported` : ""}.{" "}
            {state.needsReview ? (
              <>
                <a href="/transactions?review=1">{state.needsReview} need a quick review.</a>
                {state.aiSorting ? " The AI assistant is sorting those now, so refresh in a minute to see fewer." : ""}
              </>
            ) : (
              <a href="/transactions">View transactions.</a>
            )}
          </p>
          {state.skipped && state.skipped.length > 0 && (
            <ul className="muted">
              {state.skipped.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

export function AccountForm() {
  const [state, action, pending] = useActionState(createAccountAction, {});
  return (
    <form action={action} className="inline-form">
      <input name="name" placeholder="Account name, e.g. Amex Business" aria-label="Account name" required />
      <select name="type" aria-label="Account type" defaultValue="credit_card">
        <option value="checking">Checking</option>
        <option value="savings">Savings</option>
        <option value="credit_card">Credit card</option>
        <option value="cash">Cash</option>
        <option value="other">Other</option>
      </select>
      <button type="submit" disabled={pending}>Add account</button>
      <Status state={state} />
    </form>
  );
}

export function RuleForm({ children }: { children: React.ReactNode }) {
  const [state, action, pending] = useActionState(createRuleAction, {});
  return (
    <form action={action} className="card form-grid">
      <h2>New rule</h2>
      <label className="wide">
        When the description
        <span className="row">
          <select name="matchType" aria-label="Match type" defaultValue="contains">
            <option value="contains">contains</option>
            <option value="starts_with">starts with</option>
            <option value="exact">is exactly</option>
          </select>
          <input name="pattern" placeholder="e.g. JOE'S PIZZA" aria-label="Text to match" required />
        </span>
      </label>
      <label>
        For
        <select name="direction" defaultValue="any">
          <option value="any">Money in or out</option>
          <option value="out">Money out</option>
          <option value="in">Money in</option>
        </select>
      </label>
      <label className="wide">
        Categorize as
        <select name="categoryId" required>{children}</select>
      </label>
      <div className="actions">
        <button type="submit" disabled={pending}>Save rule</button>
        <Status state={state} />
      </div>
    </form>
  );
}
