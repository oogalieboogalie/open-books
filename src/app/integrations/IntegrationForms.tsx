"use client";

import { useActionState } from "react";
import {
  addCalendarAction,
  addGmailAction,
  addImapAction,
  createExportSheetAction,
  sheetImportAction,
  syncAllAction,
  uploadReceiptAction,
  type ActionState,
  type SheetCheckState,
} from "./actions";

function Status({ state }: { state: ActionState }) {
  if (state.error) return <p className="msg error" role="alert">{state.error}</p>;
  if (state.ok) return <p className="msg ok" role="status">{state.ok}</p>;
  return null;
}

const money = (cents: number) => (cents / 100 + 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function SyncAllButton() {
  const [state, action, pending] = useActionState(syncAllAction, {});
  return (
    <form action={action} className="actions">
      <button type="submit" disabled={pending}>{pending ? "Syncing…" : "Sync everything now"}</button>
      <Status state={state} />
    </form>
  );
}

export function SheetImportForm({ accounts, viaGoogle }: { accounts: { id: number; name: string }[]; viaGoogle: boolean }) {
  const [state, action, pending] = useActionState<SheetCheckState, FormData>(sheetImportAction, {});
  const checked = !!state.preview?.mapping && !state.added;
  const keep = state.added ? {} : state;
  return (
    // React resets a form after its action runs, so fields take their defaults from the last result.
    <form action={action} className="form-grid" key={state.seq ?? 0}>
      <label className="wide">
        Link to the sheet
        <input name="url" defaultValue={keep.url ?? ""} placeholder="https://docs.google.com/spreadsheets/d/…" required />
      </label>
      {!viaGoogle && (
        <p className="muted wide" style={{ margin: 0, fontSize: "0.85rem" }}>
          Without a connected Google account, the sheet must be shared as &quot;Anyone with the link can view&quot;. Connect Google above to keep it private.
        </p>
      )}
      {state.tabs && state.tabs.length > 1 && (
        <label>
          Tab
          <select name="gid" defaultValue={state.gid ?? undefined}>
            {state.tabs.map((t) => (
              <option key={t.gid} value={t.gid}>{t.title}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        Into account
        <select name="accountId" defaultValue={keep.accountId}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>
      <label className="check wide">
        <input type="checkbox" name="flipSigns" defaultChecked={keep.flipSigns} /> Spending is written as positive numbers in this sheet
      </label>

      {state.preview && state.preview.mapping && !state.added && (
        <div className="wide">
          <p className="muted" style={{ margin: "0 0 6px" }}>
            {state.title ? <strong>{state.title}</strong> : "Sheet"}: found {state.preview.total} transaction{state.preview.total === 1 ? "" : "s"}
            {state.preview.header.length > 0 && <> in columns {state.preview.header.filter(Boolean).join(", ")}</>}. Latest:
          </p>
          <div className="table-wrap">
            <table>
              <tbody>
                {state.preview.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{r.date}</td>
                    <td>{r.description}</td>
                    <td className={`num ${r.amountCents > 0 ? "pos" : ""}`}>{money(r.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.preview.errors.length > 0 && <p className="muted" style={{ fontSize: "0.85rem" }}>{state.preview.errors.join(" ")}</p>}
        </div>
      )}

      <div className="actions">
        {checked ? (
          <>
            <button type="submit" name="confirm" value="1" disabled={pending}>{pending ? "Importing…" : "Connect and import"}</button>
            <button type="submit" className="secondary" disabled={pending}>Check again</button>
          </>
        ) : (
          <button type="submit" disabled={pending}>{pending ? "Reading the sheet…" : "Check the sheet"}</button>
        )}
        <Status state={state} />
      </div>
    </form>
  );
}

export function CreateExportButton() {
  const [state, action, pending] = useActionState(createExportSheetAction, {});
  return (
    <form action={action} className="actions">
      <button type="submit" disabled={pending}>{pending ? "Creating…" : "Create a Google Sheet of my books"}</button>
      <Status state={state} />
    </form>
  );
}

export function CalendarForm({ calendars }: { calendars: { id: string; name: string; primary: boolean }[] }) {
  const [state, action, pending] = useActionState(addCalendarAction, {});
  return (
    <form action={action} className="form-grid">
      <label className="wide">
        Calendar
        <select name="calendarId" defaultValue={calendars.find((c) => c.primary)?.id}>
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.primary ? " (main)" : ""}</option>
          ))}
        </select>
      </label>
      <label className="check wide">
        <input type="checkbox" name="onlyWithGuests" defaultChecked /> Only count events with a guest (skips personal blocks and reminders)
      </label>
      <label className="wide">
        Only count events whose title contains (optional)
        <input name="keyword" placeholder="e.g. Consult, Appointment, Session" maxLength={60} />
      </label>
      <div className="actions">
        <button type="submit" disabled={pending}>{pending ? "Loading events…" : "Add calendar"}</button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function GmailForm({ query, defaultQuery, connected }: { query: string; defaultQuery: string; connected: boolean }) {
  const [state, action, pending] = useActionState(addGmailAction, {});
  return (
    <form action={action} className="form-grid">
      <label className="wide">
        Gmail search for receipts
        <input name="query" defaultValue={query || defaultQuery} />
      </label>
      <div className="actions">
        <button type="submit" disabled={pending}>{pending ? "Working…" : connected ? "Save search" : "Start pulling receipts"}</button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function ImapForm() {
  const [state, action, pending] = useActionState(addImapAction, {});
  return (
    <form action={action} className="form-grid">
      <label>
        Mail server
        <input name="host" placeholder="imap.fastmail.com" required />
      </label>
      <label>
        Security
        <select name="security" defaultValue="tls">
          <option value="tls">SSL/TLS (port 993)</option>
          <option value="starttls">STARTTLS (port 143)</option>
        </select>
      </label>
      <label>
        Port
        <input name="port" inputMode="numeric" placeholder="993" />
      </label>
      <label>
        Username
        <input name="user" autoComplete="off" placeholder="you@yourbusiness.com" required />
      </label>
      <label>
        App password
        <input name="password" type="password" autoComplete="new-password" required />
      </label>
      <label>
        Folder
        <input name="folder" placeholder="INBOX" defaultValue="Receipts" />
      </label>
      <div className="actions">
        <button type="submit" disabled={pending}>{pending ? "Connecting…" : "Connect mailbox"}</button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function ReceiptUploadForm({ today }: { today: string }) {
  const [state, action, pending] = useActionState(uploadReceiptAction, {});
  return (
    <form action={action} className="card form-grid">
      <h2>Add a receipt</h2>
      <label className="wide">
        Photo or PDF
        <input type="file" name="file" accept="application/pdf,image/*" capture="environment" />
      </label>
      <label>
        Paid to
        <input name="vendor" placeholder="e.g. Home Depot" />
      </label>
      <label>
        Amount
        <input name="amount" inputMode="decimal" placeholder="0.00" />
      </label>
      <label>
        Date
        <input type="date" name="date" defaultValue={today} />
      </label>
      <div className="actions">
        <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save receipt"}</button>
        <Status state={state} />
      </div>
    </form>
  );
}
