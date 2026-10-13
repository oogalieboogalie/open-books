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
- [ ] Pull numbers in automatically (booking tools, CRM, website analytics, social platforms)
- [ ] AI assistant with retrieval over your own books (pgvector), hosted or self-hosted with your own API key
- [ ] Receipt capture and attachment
- [ ] Automatic mileage capture and the standard mileage deduction
- [ ] Quarterly estimated tax reminders
- [ ] Proposals and invoices
- [ ] Customizable legal documents and e-signatures
- [ ] LLC and entity formation help: name check, articles of organization, operating agreements
- [ ] Website templates and links to copyright registration

## License

MIT
