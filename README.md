# Open Books

Free, open-source bookkeeping for small businesses. Track income and expenses, and every transaction is sorted automatically into the categories your tax return uses (IRS Schedule C), so tax time is a download instead of a shoebox.

This is the first module of a larger open toolkit for small business owners. Mileage tracking, legal documents, e-signatures, entity formation help, and AI assistance are planned to build on it (see [Roadmap](#roadmap)).

> Open Books helps you organize your records. It is not tax or legal advice; check with a tax professional for your situation.

## What it does today

- **Income and expense tracking** across multiple accounts (checking, savings, credit cards, cash).
- **CSV import** from any bank or card. Detects the date, description, and amount columns (or separate debit/credit columns), skips bank preamble lines, and safely skips anything already imported.
- **Automatic categorization** into 30+ tax categories mapped to Schedule C lines, plus Schedule 1 deductions (self-employed health insurance, owner retirement) and non-deductible movements (transfers, owner draws, income tax payments).
- **Learns from you.** Change a category and tick "Always for…" to create a rule for that merchant; it applies to past and future transactions.
- **Needs-review queue** for anything the categorizer is unsure about.
- **Timeline** of income and expenses by day, week, or month, with events (a social post, a promotion, an email) and the numbers you track (new contacts, appointments, leads, or anything you name) on the same axis. Hover a column for a summary; click it to see every transaction, event, and number from that period.
- **Tracked links.** Make a short link (`/go/fall-special`) for a post; each click is counted on the day it happens and shows up on the timeline next to your sales. Link previews from social networks are not counted.
- **Google Sheets, both ways.** Connect a sheet you already keep your books in and new rows come in on every sync, categorized like a bank import. Or have Open Books keep a sheet of your books (transactions, monthly totals, a Schedule C summary per year) for your accountant.
- **Google Calendar appointments** on the timeline as "Booked appointments", next to income, with each appointment listed when you click a day. Choose which events count (only ones with guests, or titles with a keyword).
- **Receipts by email.** Forward receipts to your own address, or let Open Books watch Gmail or any IMAP mailbox. Each receipt is read for the store, total, date, and order number (including receipts you forwarded), keeps its PDF, and is matched to the card charge, even if the charge is imported days later. Upload photos and PDFs by hand too.
- **Tax report** shaped like Schedule C, with meals at 50%, an estimate of self-employment tax, and a CSV download for your tax preparer.

## Quick start

Requires Node.js 22 or newer.

```bash
npm install
npm run seed:demo   # optional: six months of sample data to explore
npm run dev         # http://localhost:3000
```

With no configuration, data is stored in an embedded Postgres ([PGlite](https://pglite.dev)) under `./data/pglite`, so there is nothing to install. Only one process can open that folder at a time, so stop the app before running `seed:demo`.

For production, or to share a database, point the app at any Postgres 15+ server:

```bash
DATABASE_URL=postgres://user:pass@host:5432/books npm run build && npm start
```

### Docker

`docker compose up` runs the app on Alpine with Postgres 17 and pgvector, entirely on your machine. Open http://localhost:3000. Data lives in the `pgdata` volume.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | unset | Postgres connection string. When unset, the embedded database is used. |
| `PGLITE_DIR` | `./data/pglite` | Where the embedded database keeps its files. |
| `BUSINESS_TZ` | server timezone | IANA timezone (e.g. `America/Chicago`) for deciding which day a link click falls on. |
| `DATABASE_POOL_SIZE` | `10` | Max connections to `DATABASE_URL`. |
| `APP_SECRET` | random, saved in `./data/.app-secret` | Encrypts stored Google tokens and mailbox passwords. Set it in production. |
| `APP_URL` | the request's address | Public address of the app, used for the Google redirect URI and the inbound email URL. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset | Your Google OAuth client, for Sheets, Calendar, and Gmail. |
| `GOOGLE_ENABLE_GMAIL` | off | Set to `1` to offer reading receipts from Gmail (self-hosted only; see below). |
| `INBOUND_EMAIL_DOMAIN` | unset | Domain of your receipt forwarding address (`receipts+TOKEN@domain`). |
| `SYNC_INTERVAL_MINUTES` | `15` | How often connected sheets, calendars, and mailboxes sync. `0` turns it off. |
| `CRON_SECRET` | unset | Enables `POST /api/integrations/sync` with `Authorization: Bearer …` for an external scheduler. |

## Integrations

Everything is set up on the **Integrations** page, which also walks through each step.

**Google (Sheets and Calendar).** Each server uses its own Google Cloud project, so data only travels between Google and your server. Create a project, enable the Sheets and Calendar APIs, set up the consent screen, and create a *Web application* OAuth client with the redirect URI `{APP_URL}/integrations/google/callback`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Open Books asks only for the scopes a feature needs, when you turn it on. Without Google set up, you can still import a sheet shared as "Anyone with the link can view".

**Receipts by email.** Point any inbound email service at `/api/email/inbound?token=…` (the page shows your URL): a Cloudflare Email Worker (code on the page), Postmark, Mailgun, or SendGrid all work. Set `INBOUND_EMAIL_DOMAIN` to show the forwarding address.

**Gmail** needs the `gmail.readonly` scope, which Google treats as restricted: a public app needs a security assessment to use it. For your own server, enable the Gmail API and set `GOOGLE_ENABLE_GMAIL=1`. **IMAP** works with any provider using an app password.

**Syncing** runs in the background every `SYNC_INTERVAL_MINUTES`. Imports run first, then waiting receipts are matched, then the export sheet is rewritten. Receipts are matched when the amount is the same, the charge posts within a few days, and it is the only such charge (or the only one from that vendor). Anything less certain is suggested on the Receipts page.

## How categorization works

Each transaction goes through a chain of classifiers (`src/lib/categorize/engine.ts`); the first one with an answer wins:

1. **Your rules.** Created from corrections or on the Rules page. Confidence 99%.
2. **Built-in merchant knowledge** (`src/lib/categorize/keywords.ts`). About 570 merchants and keywords, each with a confidence that reflects how ambiguous it is. A gas station is almost certainly car and truck expense; a Walmart run could be anything, so it is flagged for review. Money coming back from an expense merchant is treated as a refund in the same category.
3. **Fallback.** Unknown deposits are treated as possible income and flagged; unknown spending is left uncategorized.

Anything below 70% confidence lands in the review queue. Descriptions are normalized first (`normalize.ts`), stripping card-network noise like `POS DEBIT 10/14 SQ *` and store numbers, so `STARBUCKS STORE #08812 SEATTLE WA` and `STARBUCKS 1234 PORTLAND OR` share one merchant key.

The `Classifier` interface is the extension point for an AI categorizer that can reason about unfamiliar merchants and the business's own history.

## Project layout

```
src/lib/categories.ts        Tax categories and their Schedule C lines
src/lib/categorize/          Normalization, built-in keywords, classifier chain
src/lib/csv.ts               CSV parsing and bank format detection
src/lib/books.ts             All reads and writes, scoped to one business
src/lib/reports.ts           Schedule C summary and SE tax estimate
src/lib/activity.ts          Events, daily numbers, tracked links, timeline queries
src/lib/timeline.ts          Day/week/month bucketing and range presets
src/lib/integrations/        Google sign-in, Sheets, Calendar, Gmail/IMAP, the sync runner
src/lib/receipts/            Reading receipt emails and matching them to transactions
src/lib/secrets.ts           Encryption for stored credentials
src/lib/db.ts                Postgres connection (server or embedded) and migrations
src/app/                     Next.js pages and server actions
tests/                       Vitest tests (npm test)
```

Stack: Next.js (App Router, server actions), React, TypeScript, Postgres (via `pg`, or embedded PGlite), Vitest.

Tests run on the embedded database by default; set `TEST_DATABASE_URL` to run them against a real Postgres server.

## Contributing

Contributions are welcome, especially merchant keywords. To teach the categorizer a merchant, add it to `src/lib/categorize/keywords.ts` and a case to `tests/categorize.test.ts`, then run `npm test`.

## Roadmap

- [x] Income and expense tracking with automatic Schedule C categorization
- [ ] Accounts and sign-in, multiple businesses per user (the data model is already scoped by business)
- [x] Timeline of money, events, and tracked numbers, with drill-down and tracked links
- [x] Google Sheets import and export, Google Calendar appointments, receipts from email
- [ ] Pull more numbers in automatically (booking tools, CRM, website analytics, social platforms)
- [ ] AI assistant with retrieval over your own books (pgvector), hosted or self-hosted with your own API key
- [x] Receipt capture and matching (email, Gmail, IMAP, upload)
- [ ] Automatic mileage capture and the standard mileage deduction
- [ ] Quarterly estimated tax reminders
- [ ] Proposals and invoices
- [ ] Customizable legal documents and e-signatures
- [ ] LLC and entity formation help: name check, articles of organization, operating agreements
- [ ] Website templates and links to copyright registration

## License

MIT
