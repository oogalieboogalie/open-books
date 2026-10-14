# Open Books

Free, open-source bookkeeping for small businesses. Track income and expenses, and every transaction is sorted automatically into the categories your tax return uses (IRS Schedule C), so tax time is a download instead of a shoebox.

This is the first module of a larger open toolkit for small business owners. Mileage tracking, legal documents, e-signatures, and entity formation help are planned to build on it (see [Roadmap](#roadmap)).

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
- **AI assistant** that answers questions about your own books ("how did last month compare?", "did the spring promo bring in sales?", "what's my self-employment tax so far?"). Runs on Claude with your own API key, or entirely on your machine with Ollama. See [AI assistant](#ai-assistant).
- **AI categorization** of whatever the built-in categorizer was unsure about, using your own past choices as examples.
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

`docker compose --profile ollama up` also runs Ollama and pulls the assistant's models on first start. To use an NVIDIA GPU, add the GPU override: `docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile ollama up`. If Ollama already runs on your computer, skip the profile and set `OLLAMA_URL=http://host.docker.internal:11434`.

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
| `AI_PROVIDER` | `anthropic` if a key is set, else `ollama` | `anthropic`, `ollama`, or `off`. |
| `ANTHROPIC_API_KEY` | unset | Your own Anthropic API key. Usage is billed to your account. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Which Claude model answers. |
| `AI_EFFORT` | `medium` | `low`, `medium`, or `high`: how much Claude thinks before answering. |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama runs. |
| `OLLAMA_MODEL` | `qwen3:8b` | Local chat model. Must support tool calling. |
| `OLLAMA_NUM_CTX` | `16384` | Context window for the local model. |
| `EMBED_PROVIDER` | `ollama` | `off` uses keyword search only. |
| `EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model for search. |
| `AI_AUTO_CATEGORIZE` | on | Set to `0` to stop sorting new imports with AI. |

## Integrations

Everything is set up on the **Integrations** page, which also walks through each step.

**Google (Sheets and Calendar).** Each server uses its own Google Cloud project, so data only travels between Google and your server. Create a project, enable the Sheets and Calendar APIs, set up the consent screen, and create a *Web application* OAuth client with the redirect URI `{APP_URL}/integrations/google/callback`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Open Books asks only for the scopes a feature needs, when you turn it on. Without Google set up, you can still import a sheet shared as "Anyone with the link can view".

**Receipts by email.** Point any inbound email service at `/api/email/inbound?token=…` (the page shows your URL): a Cloudflare Email Worker (code on the page), Postmark, Mailgun, or SendGrid all work. Set `INBOUND_EMAIL_DOMAIN` to show the forwarding address.

**Gmail** needs the `gmail.readonly` scope, which Google treats as restricted: a public app needs a security assessment to use it. For your own server, enable the Gmail API and set `GOOGLE_ENABLE_GMAIL=1`. **IMAP** works with any provider using an app password.

**Syncing** runs in the background every `SYNC_INTERVAL_MINUTES`. Imports run first, then waiting receipts are matched, then the export sheet is rewritten. Receipts are matched when the amount is the same, the charge posts within a few days, and it is the only such charge (or the only one from that vendor). Anything less certain is suggested on the Receipts page.

## AI assistant

The **Assistant** page answers questions about your books in plain English, with every lookup it made shown under the answer and linked to the records. **AI setup** shows whether the model and search index are working and lets you sort the review queue with AI.

Pick a model:

- **Claude, with your own key.** Set `ANTHROPIC_API_KEY`. Best answers; questions and the records needed to answer them are sent to the Anthropic API.
- **Ollama, fully local.** Install [Ollama](https://ollama.com), run `ollama pull qwen3:8b` and `ollama pull nomic-embed-text`, and start Open Books. Nothing leaves your machine. An 8 GB GPU runs both models comfortably; bigger tool-calling models (`qwen3:14b`, `llama3.3`) answer better if you have the memory.

How it works:

1. **Search index.** Every transaction, event, month, and rule becomes a short plain-English document in `ai_documents` (`src/lib/ai/knowledge.ts`), updated by content hash each time you ask. Search blends Postgres full-text ranking with pgvector similarity (embeddings from Ollama), merged by reciprocal rank fusion. On a Postgres server without pgvector, or with `EMBED_PROVIDER=off`, it uses full-text search alone. The embedded database ships with pgvector.
2. **Retrieval and tools.** Each question is sent with the records search finds, and the model can call tools (`src/lib/ai/tools.ts`) for exact figures: search, filtered transaction lists with totals, period summaries with events and tracked numbers, the timeline, and the Schedule C summary. It can also recategorize a transaction or add a rule, only when you ask.
3. **Providers.** `src/lib/ai/anthropic.ts` and `src/lib/ai/ollama.ts` implement the same small interface (`provider.ts`). Conversations are stored with each provider's exact messages, so a conversation continues unchanged, and falls back to plain text if you switch models.

## How categorization works

Each transaction goes through a chain of classifiers (`src/lib/categorize/engine.ts`); the first one with an answer wins:

1. **Your rules.** Created from corrections or on the Rules page. Confidence 99%.
2. **Built-in merchant knowledge** (`src/lib/categorize/keywords.ts`). About 570 merchants and keywords, each with a confidence that reflects how ambiguous it is. A gas station is almost certainly car and truck expense; a Walmart run could be anything, so it is flagged for review. Money coming back from an expense merchant is treated as a refund in the same category.
3. **Fallback.** Unknown deposits are treated as possible income and flagged; unknown spending is left uncategorized.
4. **AI pass (optional).** When an AI model is configured, transactions the chain was unsure about are sent to it after each import, along with how you categorized similar merchants before (`src/lib/ai/categorizer.ts`). Answers at 85% confidence or more leave the review queue; the rest stay, marked "AI:". It runs as a separate pass rather than inside the chain because it is slow and costs tokens, while re-running the chain after every rule change must stay instant. Re-running the chain keeps AI answers unless one of your rules matches.

Anything below 70% confidence lands in the review queue. Descriptions are normalized first (`normalize.ts`), stripping card-network noise like `POS DEBIT 10/14 SQ *` and store numbers, so `STARBUCKS STORE #08812 SEATTLE WA` and `STARBUCKS 1234 PORTLAND OR` share one merchant key.

The `Classifier` interface is the extension point for other fast, local categorizers.

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
src/lib/ai/                  AI assistant: providers, search index, tools, AI categorization
src/app/                     Next.js pages and server actions
tests/                       Vitest tests (npm test)
```

Stack: Next.js (App Router, server actions), React, TypeScript, Postgres with pgvector (via `pg`, or embedded PGlite), the Anthropic SDK and Ollama for AI, Vitest.

Tests run on the embedded database by default; set `TEST_DATABASE_URL` to run them against a real Postgres server.

## Contributing

Contributions are welcome, especially merchant keywords. To teach the categorizer a merchant, add it to `src/lib/categorize/keywords.ts` and a case to `tests/categorize.test.ts`, then run `npm test`.

## Roadmap

- [x] Income and expense tracking with automatic Schedule C categorization
- [ ] Accounts and sign-in, multiple businesses per user (the data model is already scoped by business)
- [x] Timeline of money, events, and tracked numbers, with drill-down and tracked links
- [x] Google Sheets import and export, Google Calendar appointments, receipts from email
- [ ] Pull more numbers in automatically (booking tools, CRM, website analytics, social platforms)
- [x] AI assistant with retrieval over your own books (pgvector), with Claude (your own key) or local models in Ollama
- [ ] Hosted tier with a managed assistant
- [x] Receipt capture and matching (email, Gmail, IMAP, upload)
- [ ] Automatic mileage capture and the standard mileage deduction
- [ ] Quarterly estimated tax reminders
- [ ] Proposals and invoices
- [ ] Customizable legal documents and e-signatures
- [ ] LLC and entity formation help: name check, articles of organization, operating agreements
- [ ] Website templates and links to copyright registration

## License

MIT
