import path from "node:path";

/**
 * Postgres everywhere. With DATABASE_URL set, the app talks to that server
 * (Docker, a managed host, anything with Postgres 15+). Without it, an embedded
 * Postgres (PGlite) stores data in ./data/pglite so the app runs with no setup.
 *
 * Schema changes are appended to MIGRATIONS and applied in order on startup;
 * never edit a migration that has shipped.
 */

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Runs several statements separated by semicolons, without parameters. */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE businesses (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'sole_prop',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE accounts (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'checking',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE rules (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    match_type TEXT NOT NULL DEFAULT 'contains',
    direction TEXT NOT NULL DEFAULT 'any',
    category_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (business_id, pattern, match_type, direction)
  );

  CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    date DATE NOT NULL,
    description TEXT NOT NULL,
    merchant_key TEXT NOT NULL DEFAULT '',
    amount_cents BIGINT NOT NULL,
    category_id TEXT NOT NULL DEFAULT 'uncategorized',
    category_source TEXT NOT NULL DEFAULT 'fallback',
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
    needs_review BOOLEAN NOT NULL DEFAULT true,
    notes TEXT NOT NULL DEFAULT '',
    import_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX idx_tx_business_date ON transactions (business_id, date);
  CREATE INDEX idx_tx_business_category ON transactions (business_id, category_id);
  CREATE UNIQUE INDEX idx_tx_import_hash ON transactions (business_id, import_hash) WHERE import_hash IS NOT NULL;

  -- Things that happened (a social post, a promo) and daily numbers (contacts,
  -- appointments), so they can be lined up against the money on one timeline.
  CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_events_business_date ON events (business_id, date);

  CREATE TABLE metric_entries (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    metric TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (business_id, date, metric)
  );

  CREATE TABLE custom_metrics (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (business_id, key)
  );

  CREATE TABLE tracked_links (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    destination TEXT NOT NULL,
    event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE link_clicks (
    id BIGSERIAL PRIMARY KEY,
    link_id INTEGER NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_link_clicks_link_time ON link_clicks (link_id, clicked_at);
  `,
  // Integrations: Google (Sheets, Calendar, Gmail), email receipts, IMAP.
  `
  ALTER TABLE businesses ADD COLUMN inbound_token TEXT UNIQUE;
  ALTER TABLE transactions ADD COLUMN source TEXT NOT NULL DEFAULT '';

  -- A connected account (one Google account per business). Credentials are
  -- encrypted with APP_SECRET (see src/lib/secrets.ts).
  CREATE TABLE integrations (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    scopes TEXT NOT NULL DEFAULT '',
    credentials TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (business_id, provider)
  );

  -- Something that syncs on a schedule: a sheet to import from or export to,
  -- a calendar, a Gmail search, an IMAP mailbox.
  CREATE TABLE sync_sources (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    state JSONB NOT NULL DEFAULT '{}',
    secret TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_synced_at TIMESTAMPTZ,
    last_result TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_sync_sources_business ON sync_sources (business_id, kind);

  CREATE TABLE calendar_events (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sync_sources(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    date DATE NOT NULL,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    all_day BOOLEAN NOT NULL DEFAULT false,
    title TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    attendees INTEGER NOT NULL DEFAULT 0,
    declined BOOLEAN NOT NULL DEFAULT false,
    url TEXT NOT NULL DEFAULT '',
    UNIQUE (source_id, external_id)
  );
  CREATE INDEX idx_calendar_events_business_date ON calendar_events (business_id, date);

  CREATE TABLE receipts (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    external_id TEXT,
    from_address TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    vendor TEXT NOT NULL DEFAULT '',
    date DATE,
    amount_cents BIGINT,
    amount_confident BOOLEAN NOT NULL DEFAULT false,
    order_ref TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unmatched',
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    match_kind TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_receipts_external ON receipts (business_id, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX idx_receipts_business_status ON receipts (business_id, status);
  CREATE INDEX idx_receipts_transaction ON receipts (transaction_id);

  CREATE TABLE receipt_files (
    id SERIAL PRIMARY KEY,
    receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BYTEA NOT NULL
  );
  CREATE INDEX idx_receipt_files_receipt ON receipt_files (receipt_id);
  `,
];

// Return dates as 'YYYY-MM-DD', timestamps as ISO-ish strings, and int8/numeric
// as numbers, from both drivers. Cents fit comfortably in a JS number.
const OID = { int8: 20, numeric: 1700, date: 1082, timestamp: 1114, timestamptz: 1184 };
const PARSERS: Record<number, (v: string) => unknown> = {
  [OID.int8]: (v) => Number(v),
  [OID.numeric]: (v) => Number(v),
  [OID.date]: (v) => v,
  [OID.timestamp]: (v) => v,
  [OID.timestamptz]: (v) => v,
};

async function migrate(db: Db) {
  await db.transaction(async (tx) => {
    // Serialize concurrent starts (several app processes against one database).
    await tx.query("SELECT pg_advisory_xact_lock(727274)");
    await tx.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const row = await tx.one<{ v: number }>("SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_migrations");
    for (let v = row?.v ?? 0; v < MIGRATIONS.length; v++) {
      await tx.exec(MIGRATIONS[v]);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [v + 1]);
    }
  });
}

async function openPg(url: string): Promise<Db> {
  const pg = await import("pg");
  const Pool = pg.default?.Pool ?? pg.Pool;
  const types = pg.default?.types ?? pg.types;
  const pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
  for (const [oid, parse] of Object.entries(PARSERS)) types.setTypeParser(Number(oid), parse);

  type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  const wrap = (q: Queryable, tx: Db["transaction"]): Db => ({
    query: async <T,>(sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows as T[],
    one: async <T,>(sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows[0] as T | undefined,
    exec: async (sql: string) => {
      await q.query(sql);
    },
    transaction: tx,
    close: async () => pool.end(),
  });

  const transaction = async <T,>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Nested calls run inside the same transaction.
      const inner: Db = wrap(client, (f) => f(inner));
      const result = await fn(inner);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };
  return wrap(pool, transaction);
}

async function openPglite(dataDir: string | undefined): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = await PGlite.create({ dataDir, parsers: PARSERS });

  type Queryable = { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>; exec: (sql: string) => Promise<unknown> };
  const wrap = (q: Queryable, tx: Db["transaction"]): Db => ({
    query: async <T,>(sql: string, params: unknown[] = []) => (await q.query<T>(sql, params)).rows,
    one: async <T,>(sql: string, params: unknown[] = []) => (await q.query<T>(sql, params)).rows[0],
    exec: async (sql: string) => {
      await q.exec(sql);
    },
    transaction: tx,
    close: async () => pglite.close(),
  });

  const transaction = <T,>(fn: (tx: Db) => Promise<T>): Promise<T> =>
    pglite.transaction(async (t) => {
      const inner: Db = wrap(t as unknown as Queryable, (f) => f(inner));
      return fn(inner);
    }) as Promise<T>;
  return wrap(pglite as unknown as Queryable, transaction);
}

/**
 * Opens a database: a postgres:// URL, a directory for embedded Postgres, or
 * "memory" for a throwaway in-memory database (used by tests).
 */
export async function openDatabase(target: string): Promise<Db> {
  const db = /^postgres(ql)?:\/\//.test(target) ? await openPg(target) : await openPglite(target === "memory" ? undefined : target);
  await migrate(db);
  return db;
}

const globalForDb = globalThis as unknown as { __openBooksDb?: Promise<Db> };

/** The app's shared database: DATABASE_URL, else embedded Postgres in PGLITE_DIR or ./data/pglite. */
export function getDb(): Promise<Db> {
  if (!globalForDb.__openBooksDb) {
    const target = process.env.DATABASE_URL || process.env.PGLITE_DIR || path.join(process.cwd(), "data", "pglite");
    globalForDb.__openBooksDb = openDatabase(target).catch((err) => {
      globalForDb.__openBooksDb = undefined;
      throw err;
    });
  }
  return globalForDb.__openBooksDb;
}

/** IANA timezone used to decide which day a timestamp (like a link click) falls on. */
export function businessTimeZone(): string {
  return process.env.BUSINESS_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
