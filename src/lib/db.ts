import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite through Node's built-in driver, so there is nothing native to compile
 * and self-hosting is one file. Schema changes are appended to MIGRATIONS and
 * applied in order on startup; never edit a migration that has shipped.
 */

const MIGRATIONS: string[] = [
  `
  CREATE TABLE businesses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'sole_prop',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'checking',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    match_type TEXT NOT NULL DEFAULT 'contains',
    direction TEXT NOT NULL DEFAULT 'any',
    category_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (business_id, pattern, match_type, direction)
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    merchant_key TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL,
    category_id TEXT NOT NULL DEFAULT 'uncategorized',
    category_source TEXT NOT NULL DEFAULT 'fallback',
    confidence REAL NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
    needs_review INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    import_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX idx_tx_business_date ON transactions (business_id, date);
  CREATE INDEX idx_tx_business_category ON transactions (business_id, category_id);
  CREATE UNIQUE INDEX idx_tx_import_hash ON transactions (business_id, import_hash) WHERE import_hash IS NOT NULL;
  `,
  // 2: things that happened (a social post, a promo) and daily numbers (contacts,
  // appointments), so they can be lined up against the money on one timeline.
  `
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_events_business_date ON events (business_id, date);

  CREATE TABLE metric_entries (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (business_id, date, metric)
  );

  CREATE TABLE custom_metrics (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (business_id, key)
  );

  CREATE TABLE tracked_links (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    destination TEXT NOT NULL,
    event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE link_clicks (
    id INTEGER PRIMARY KEY,
    link_id INTEGER NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
    clicked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_link_clicks_link_time ON link_clicks (link_id, clicked_at);
  `,
];

function migrate(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v + 1);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

const globalForDb = globalThis as unknown as { __openBooksDb?: DatabaseSync };

/** The app's shared connection. Path comes from BOOKS_DB_PATH (default ./data/books.db). */
export function getDb(): DatabaseSync {
  if (!globalForDb.__openBooksDb) {
    const file = process.env.BOOKS_DB_PATH ?? path.join(process.cwd(), "data", "books.db");
    globalForDb.__openBooksDb = openDatabase(file);
  }
  return globalForDb.__openBooksDb;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
