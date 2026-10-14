import Link from "next/link";
import { headers } from "next/headers";
import { businessTimeZone } from "@/lib/db";
import { listCalendars, type CalendarConfig, type CalendarListEntry } from "@/lib/integrations/calendar";
import { GOOGLE_FEATURES, GoogleClient, gmailEnabled, googleConfig, hasFeature, redirectUri, type GoogleFeature } from "@/lib/integrations/google";
import { DEFAULT_GMAIL_QUERY, type GmailConfig, type ImapConfig } from "@/lib/integrations/mail";
import type { SheetExportConfig, SheetImportConfig } from "@/lib/integrations/sheets";
import { Integrations, type SyncSource } from "@/lib/integrations/store";
import { getBooks } from "@/lib/server";
import { disconnectGoogleAction, removeSourceAction, rotateInboundAction, syncSourceAction, toggleSourceAction, updateCalendarAction } from "./actions";
import { CalendarForm, CreateExportButton, GmailForm, ImapForm, SheetImportForm, SyncAllButton } from "./IntegrationForms";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  "google-not-configured": "Google is not set up on this server yet. See the steps below.",
  "google-state": "That sign-in link expired. Try connecting again.",
  "google-denied": "Google access was not granted.",
  "google-no-refresh": "Google did not return long-term access. Remove Open Books from your Google account's third-party access, then connect again.",
  "google-failed": "Google sign-in did not finish. Check the client ID, secret, and redirect URI, then try again.",
};

function when(ts: string | null): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: businessTimeZone() });
}

function SourceRow({ source, children, link }: { source: SyncSource<object>; children?: React.ReactNode; link?: string }) {
  return (
    <li>
      <strong>{source.name}</strong> {!source.enabled && <span className="tag">Paused</span>}
      {source.lastError && <span className="tag review">Needs attention</span>}
      <div className="tx-meta">
        Last synced {when(source.lastSyncedAt)}
        {source.lastResult && <> · {source.lastResult}</>}
        {link && <> · <a href={link} target="_blank" rel="noreferrer">open</a></>}
      </div>
      {source.lastError && <p className="msg error" style={{ fontSize: "0.85rem" }}>{source.lastError}</p>}
      {children}
      <div className="tx-actions" style={{ marginTop: 4 }}>
        <form action={syncSourceAction}>
          <input type="hidden" name="id" value={source.id} />
          <button type="submit" className="link">Sync now</button>
        </form>
        <form action={toggleSourceAction}>
          <input type="hidden" name="id" value={source.id} />
          <input type="hidden" name="enabled" value={source.enabled ? "0" : "1"} />
          <button type="submit" className="link">{source.enabled ? "Pause" : "Resume"}</button>
        </form>
        <form action={removeSourceAction}>
          <input type="hidden" name="id" value={source.id} />
          <button type="submit" className="danger">Remove</button>
        </form>
      </div>
    </li>
  );
}

function ConnectButton({ features, label, secondary }: { features: GoogleFeature[]; label: string; secondary?: boolean }) {
  return (
    <a className={`button${secondary ? " secondary" : ""}`} href={`/integrations/google/connect?${features.map((f) => `feature=${f}`).join("&")}`}>
      {label}
    </a>
  );
}

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const params = await searchParams;
  const books = await getBooks();
  const integrations = new Integrations(books.db, books.businessId);
  const [accounts, google, sources, token] = await Promise.all([books.listAccounts(), integrations.connection("google"), integrations.listSources(), integrations.inboundToken()]);
  const cfg = googleConfig();
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  const googleOk = !!google && google.status === "ok";
  const can = (f: GoogleFeature) => googleOk && hasFeature(google!.scopes, f);
  const of = <C,>(kind: SyncSource["kind"]) => sources.filter((s) => s.kind === kind) as SyncSource<C>[];
  const sheetImports = of<SheetImportConfig>("sheet_import");
  const sheetExports = of<SheetExportConfig>("sheet_export");
  const calendars = of<CalendarConfig>("calendar");
  const gmail = of<GmailConfig>("gmail")[0];
  const imap = of<ImapConfig>("imap");

  let calendarChoices: CalendarListEntry[] = [];
  let calendarError = "";
  if (can("calendar")) {
    try {
      calendarChoices = await listCalendars(await GoogleClient.for(integrations));
    } catch (err) {
      calendarError = (err as Error).message;
    }
  }

  const inboundDomain = process.env.INBOUND_EMAIL_DOMAIN?.trim();
  const forwardAddress = inboundDomain ? `receipts+${token}@${inboundDomain}` : null;
  const webhook = `${(process.env.APP_URL || origin).replace(/\/+$/, "")}/api/email/inbound?token=${token}`;
  const interval = Number(process.env.SYNC_INTERVAL_MINUTES ?? 15);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <p className="muted">
            Bring in transactions from Google Sheets, appointments from Google Calendar, and receipts from your email.{" "}
            {interval > 0 ? `Everything syncs every ${interval} minutes.` : "Automatic sync is off; use the button to sync."}
          </p>
        </div>
        <SyncAllButton />
      </div>

      {params.error && <div className="banner">{ERRORS[params.error] ?? "Something went wrong connecting Google."}</div>}
      {params.connected && !params.error && (
        <p className="msg ok" role="status">
          Connected {params.connected.split(",").map((f) => GOOGLE_FEATURES[f as GoogleFeature]?.label ?? "Google").join(" and ")}.
        </p>
      )}

      <section className="card" id="google">
        <h2>Google account</h2>
        {!cfg ? (
          <>
            <p className="muted">
              Each Open Books server uses its own Google Cloud project, so your data only ever goes between Google and your server. Setup takes about ten minutes:
            </p>
            <ol className="steps">
              <li>
                In the <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud console</a>, create a project.
              </li>
              <li>
                Enable the <a href="https://console.cloud.google.com/apis/library/sheets.googleapis.com" target="_blank" rel="noreferrer">Google Sheets API</a> and the{" "}
                <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noreferrer">Google Calendar API</a>
                {" "}(and the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer">Gmail API</a> if you want Gmail receipts).
              </li>
              <li>
                Under <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noreferrer">Google Auth Platform</a>, set up the consent screen. Choose <em>External</em>, and add yourself as a test user.
              </li>
              <li>
                Under <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">Clients</a>, create a <em>Web application</em> client with this authorized redirect URI:
                <br /><code>{redirectUri(origin)}</code>
              </li>
              <li>
                Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in your environment (and <code>APP_URL</code> if the server is reached at a different address), then restart Open Books.
              </li>
            </ol>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              No Google project? You can still import a sheet shared with &quot;Anyone with the link&quot; below, and receive receipts by email.
            </p>
          </>
        ) : !google ? (
          <>
            <p className="muted">Connect the Google account that holds your sheets and calendar. Open Books only asks for what each feature needs.</p>
            <div className="actions">
              <ConnectButton features={["sheets", "calendar"]} label="Connect Google Sheets and Calendar" />
              <ConnectButton features={["sheets"]} label="Sheets only" secondary />
              <ConnectButton features={["calendar"]} label="Calendar only" secondary />
            </div>
          </>
        ) : (
          <>
            <p>
              Connected as <strong>{google.account || "your Google account"}</strong>.{" "}
              {(Object.keys(GOOGLE_FEATURES) as GoogleFeature[])
                .filter((f) => hasFeature(google.scopes, f))
                .map((f) => <span key={f} className="tag" style={{ marginRight: 4 }}>{GOOGLE_FEATURES[f].label}</span>)}
            </p>
            {google.status === "reauth" && (
              <div className="banner" style={{ marginBottom: 12 }}>
                Google access expired or was removed, so syncing has stopped. <a href={`/integrations/google/connect?${google.scopes.length ? (Object.keys(GOOGLE_FEATURES) as GoogleFeature[]).filter((f) => hasFeature(google.scopes, f)).map((f) => `feature=${f}`).join("&") : ""}`}>Reconnect</a>
              </div>
            )}
            <div className="actions">
              {!hasFeature(google.scopes, "sheets") && <ConnectButton features={["sheets"]} label="Add Google Sheets" secondary />}
              {!hasFeature(google.scopes, "calendar") && <ConnectButton features={["calendar"]} label="Add Google Calendar" secondary />}
              <form action={disconnectGoogleAction}>
                <button type="submit" className="danger">Disconnect Google</button>
              </form>
            </div>
          </>
        )}
      </section>

      <div className="grid-2">
        <section className="card" id="sheets">
          <h2>Import from Google Sheets</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Keep your books in a spreadsheet? Connect it and new rows come in on every sync, categorized like a bank import. Rows already imported are skipped.
          </p>
          {sheetImports.length > 0 && (
            <ul className="plain-list" style={{ marginBottom: 16 }}>
              {sheetImports.map((s) => (
                <SourceRow key={s.id} source={s} link={s.config.url}>
                  <div className="tx-meta">
                    Into {accounts.find((a) => a.id === s.config.accountId)?.name ?? "an account"}
                    {s.config.mode === "link" && " · read from its share link"}
                  </div>
                </SourceRow>
              ))}
            </ul>
          )}
          <SheetImportForm accounts={accounts} viaGoogle={can("sheets")} />
        </section>

        <section className="card" id="sheet-export">
          <h2>Keep a Google Sheet of your books</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            A spreadsheet in your Google Drive with every transaction, monthly totals, and a Schedule C summary for each year, rewritten on every sync. Share it with your accountant or a partner.
          </p>
          {sheetExports.length > 0 ? (
            <ul className="plain-list">
              {sheetExports.map((s) => (
                <SourceRow key={s.id} source={s} link={s.config.url} />
              ))}
            </ul>
          ) : can("sheets") ? (
            <CreateExportButton />
          ) : cfg ? (
            <ConnectButton features={["sheets"]} label="Connect Google Sheets first" secondary />
          ) : (
            <p className="muted">Needs a Google account. Set up Google above.</p>
          )}
        </section>
      </div>

      <section className="card" id="calendar">
        <h2>Appointments from Google Calendar</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Bookings show up on the <Link href="/timeline">timeline</Link> as &quot;Booked appointments&quot; next to your income, so you can see which weeks were busy and what they earned. Click a day to see each appointment.
        </p>
        {calendars.length > 0 && (
          <ul className="plain-list" style={{ marginBottom: 16 }}>
            {calendars.map((s) => (
              <SourceRow key={s.id} source={s}>
                <details>
                  <summary>What counts as an appointment</summary>
                  <form action={updateCalendarAction} className="inline-form" style={{ marginTop: 6 }}>
                    <input type="hidden" name="id" value={s.id} />
                    <label className="muted">
                      <input type="checkbox" name="onlyWithGuests" defaultChecked={s.config.onlyWithGuests} /> Only events with a guest
                    </label>
                    <input name="keyword" defaultValue={s.config.keyword} placeholder="Title contains…" aria-label="Title contains" maxLength={60} />
                    <button type="submit" className="secondary">Save</button>
                  </form>
                </details>
              </SourceRow>
            ))}
          </ul>
        )}
        {can("calendar") ? (
          calendarError ? <p className="msg error">{calendarError}</p> : <CalendarForm calendars={calendarChoices.filter((c) => !calendars.some((s) => s.config.calendarId === c.id))} />
        ) : cfg ? (
          <ConnectButton features={["calendar"]} label="Connect Google Calendar" />
        ) : (
          <p className="muted">Needs a Google account. Set up Google above.</p>
        )}
      </section>

      <section className="card" id="email">
        <h2>Receipts by email</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Forward receipts to your Open Books address, or let it watch a mailbox. Each one is read for the store, total, and date, and matched to the card or bank charge when it shows up.{" "}
          <Link href="/receipts">See your receipts</Link>
        </p>

        <h3>Your forwarding address</h3>
        {forwardAddress ? (
          <p>
            <code>{forwardAddress}</code>
            <br />
            <span className="muted" style={{ fontSize: "0.85rem" }}>Forward any receipt here, or set up a filter in your email to forward them automatically.</span>
          </p>
        ) : (
          <p className="muted">
            To get an address like <code>receipts+…@yourdomain.com</code>, connect an inbound email service to this server and set <code>INBOUND_EMAIL_DOMAIN</code>. Any of these work:
          </p>
        )}
        <details>
          <summary>Set up inbound email (Cloudflare, Postmark, Mailgun, or SendGrid)</summary>
          <p>Have your email service deliver incoming mail to this address. It is secret: anyone with it can add receipts.</p>
          <p><code>{webhook}</code></p>
          <ul>
            <li>
              <strong>Cloudflare Email Routing</strong> (free with a domain on Cloudflare): create an Email Worker with the code below and route <code>receipts@yourdomain</code> (and <code>receipts+*</code>) to it.
              <pre className="code">{`export default {
  async email(message) {
    await fetch("${webhook}", {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: message.raw,
    });
  },
};`}</pre>
            </li>
            <li><strong>Postmark</strong>: set the inbound webhook URL to the address above.</li>
            <li><strong>Mailgun</strong>: create a route that forwards to the address above (choose &quot;store and notify&quot; or MIME delivery).</li>
            <li><strong>SendGrid</strong>: add an Inbound Parse host with the address above as the destination URL, and tick &quot;POST the raw, full MIME message&quot;.</li>
          </ul>
          <form action={rotateInboundAction}>
            <button type="submit" className="danger">Make a new secret address (the old one stops working)</button>
          </form>
        </details>

        <h3>Gmail</h3>
        {!gmailEnabled() ? (
          <p className="muted">
            Reading receipts straight from Gmail is available for self-hosted servers: enable the Gmail API in your Google project and set <code>GOOGLE_ENABLE_GMAIL=1</code>. (Google requires a security review before a public app can read inboxes, so it is off by default.) Forwarding works without it.
          </p>
        ) : can("gmail") ? (
          <>
            {gmail && <ul className="plain-list" style={{ marginBottom: 12 }}><SourceRow source={gmail} /></ul>}
            <GmailForm query={gmail?.config.query ?? ""} defaultQuery={DEFAULT_GMAIL_QUERY} connected={!!gmail} />
            <p className="muted" style={{ fontSize: "0.85rem" }}>Tip: make a Gmail label called &quot;receipts&quot; and a filter that applies it. Emails without an amount or an attached PDF are skipped.</p>
          </>
        ) : cfg ? (
          <ConnectButton features={["gmail"]} label="Connect Gmail" secondary />
        ) : (
          <p className="muted">Needs a Google account. Set up Google above.</p>
        )}

        <h3>Any other mailbox (IMAP)</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Outlook, iCloud, Fastmail, Zoho, or your own domain. Use an app password from your email provider, and ideally a folder that only holds receipts. The password is stored encrypted.
        </p>
        {imap.length > 0 && (
          <ul className="plain-list" style={{ marginBottom: 12 }}>
            {imap.map((s) => (
              <SourceRow key={s.id} source={s}>
                <div className="tx-meta">{s.config.host}</div>
              </SourceRow>
            ))}
          </ul>
        )}
        <details>
          <summary>{imap.length ? "Add another mailbox" : "Connect a mailbox"}</summary>
          <div style={{ marginTop: 10 }}>
            <ImapForm />
          </div>
        </details>
      </section>
    </>
  );
}
