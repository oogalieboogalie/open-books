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
  `
  -- The AI assistant's knowledge of the books: one searchable document per
  -- transaction, event, month, and rule. Full-text search always works; the
  -- embedding column is added at runtime when pgvector is available (see
  -- ensureVectorSupport), so plain Postgres servers still run the app.
  CREATE TABLE ai_documents (
    id BIGSERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    date DATE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embed_model TEXT,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || content)) STORED,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (business_id, source_type, source_id)
  );
  CREATE INDEX idx_ai_documents_tsv ON ai_documents USING gin (tsv);

  CREATE TABLE ai_conversations (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New conversation',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    -- Fixed when the conversation starts: changing it later would invalidate
    -- the model's earlier reasoning in this conversation.
    system_prompt TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_ai_conversations_business ON ai_conversations (business_id, updated_at);

  -- One row per question and per answer. "native" keeps the exact messages
  -- the provider produced (thinking and tool calls included) so a conversation
  -- can be continued without editing its history.
  CREATE TABLE ai_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    activity JSONB NOT NULL DEFAULT '[]',
    native JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_ai_messages_conversation ON ai_messages (conversation_id, id);
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
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const pglite = await PGlite.create({ dataDir, parsers: PARSERS, extensions: { vector } });

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

const vectorSupport = new WeakMap<Db, Promise<boolean>>();

/**
 * Enables pgvector and adds the embedding column, once per database. Returns
 * false on a Postgres server without the extension; the assistant then falls
 * back to full-text search only.
 */
export function ensureVectorSupport(db: Db): Promise<boolean> {
  let ready = vectorSupport.get(db);
  if (!ready) {
    ready = (async () => {
      try {
        await db.exec("CREATE EXTENSION IF NOT EXISTS vector; ALTER TABLE ai_documents ADD COLUMN IF NOT EXISTS embedding vector");
        return true;
      } catch {
        return false;
      }
    })();
    vectorSupport.set(db, ready);
  }
  return ready;
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
