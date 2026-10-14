import type { Db } from "../db";
import { decrypt, encrypt, randomToken } from "../secrets";

export const SOURCE_KINDS = ["sheet_import", "sheet_export", "calendar", "gmail", "imap"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SyncSource<C = Record<string, unknown>, S = Record<string, unknown>> {
  id: number;
  kind: SourceKind;
  name: string;
  config: C;
  state: S;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastResult: string;
  lastError: string;
  createdAt: string;
}

export interface Connection {
  id: number;
  provider: string;
  account: string;
  scopes: string[];
  status: "ok" | "reauth";
  lastError: string;
}

const SOURCE_COLUMNS = `id, kind, name, config, state, enabled, last_synced_at AS "lastSyncedAt", last_result AS "lastResult", last_error AS "lastError", created_at AS "createdAt"`;

/**
 * Connected accounts and the things that sync from them, for one business.
 * Credentials and per-source secrets are stored encrypted.
 */
export class Integrations {
  constructor(
    readonly db: Db,
    readonly businessId: number,
  ) {}

  // Connected accounts

  async connection(provider: string): Promise<Connection | null> {
    const row = await this.db.one<Omit<Connection, "scopes"> & { scopes: string }>(
      `SELECT id, provider, account, scopes, status, last_error AS "lastError" FROM integrations WHERE business_id = $1 AND provider = $2`,
      [this.businessId, provider],
    );
    return row ? { ...row, scopes: row.scopes.split(" ").filter(Boolean) } : null;
  }

  async credentials<T>(provider: string): Promise<T | null> {
    const row = await this.db.one<{ credentials: string }>("SELECT credentials FROM integrations WHERE business_id = $1 AND provider = $2", [this.businessId, provider]);
    if (!row) return null;
    const plain = decrypt(row.credentials);
    return plain ? (JSON.parse(plain) as T) : null;
  }

  async saveConnection(provider: string, input: { account: string; scopes: string[]; credentials: unknown }): Promise<void> {
    await this.db.query(
      `INSERT INTO integrations (business_id, provider, account, scopes, credentials) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, provider) DO UPDATE SET account = excluded.account, scopes = excluded.scopes,
         credentials = excluded.credentials, status = 'ok', last_error = '', updated_at = now()`,
      [this.businessId, provider, input.account, [...new Set(input.scopes)].join(" "), encrypt(JSON.stringify(input.credentials))],
    );
  }

  async updateCredentials(provider: string, credentials: unknown): Promise<void> {
    await this.db.query("UPDATE integrations SET credentials = $1, updated_at = now() WHERE business_id = $2 AND provider = $3", [
      encrypt(JSON.stringify(credentials)),
      this.businessId,
      provider,
    ]);
  }

  /** Marks a connection as needing the owner to sign in again (revoked or expired grant). */
  async markNeedsReauth(provider: string, error: string): Promise<void> {
    await this.db.query("UPDATE integrations SET status = 'reauth', last_error = $1, updated_at = now() WHERE business_id = $2 AND provider = $3", [
      error.slice(0, 500),
      this.businessId,
      provider,
    ]);
  }

  async disconnect(provider: string): Promise<void> {
    await this.db.query("DELETE FROM integrations WHERE business_id = $1 AND provider = $2", [this.businessId, provider]);
  }

  // Sync sources

  listSources<C = Record<string, unknown>, S = Record<string, unknown>>(kind?: SourceKind): Promise<SyncSource<C, S>[]> {
    return kind
      ? this.db.query(`SELECT ${SOURCE_COLUMNS} FROM sync_sources WHERE business_id = $1 AND kind = $2 ORDER BY id`, [this.businessId, kind])
      : this.db.query(`SELECT ${SOURCE_COLUMNS} FROM sync_sources WHERE business_id = $1 ORDER BY id`, [this.businessId]);
  }

  async getSource<C = Record<string, unknown>, S = Record<string, unknown>>(id: number): Promise<SyncSource<C, S> | null> {
    return (await this.db.one<SyncSource<C, S>>(`SELECT ${SOURCE_COLUMNS} FROM sync_sources WHERE id = $1 AND business_id = $2`, [id, this.businessId])) ?? null;
  }

  async addSource(input: { kind: SourceKind; name: string; config: unknown; secret?: string }): Promise<number> {
    const row = await this.db.one<{ id: number }>(
      "INSERT INTO sync_sources (business_id, kind, name, config, secret) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [this.businessId, input.kind, input.name.trim().slice(0, 200), JSON.stringify(input.config ?? {}), input.secret ? encrypt(input.secret) : ""],
    );
    return row!.id;
  }

  async updateSourceConfig(id: number, config: unknown, name?: string): Promise<void> {
    await this.db.query("UPDATE sync_sources SET config = $1, name = COALESCE($2, name) WHERE id = $3 AND business_id = $4", [
      JSON.stringify(config),
      name ?? null,
      id,
      this.businessId,
    ]);
  }

  async sourceSecret(id: number): Promise<string | null> {
    const row = await this.db.one<{ secret: string }>("SELECT secret FROM sync_sources WHERE id = $1 AND business_id = $2", [id, this.businessId]);
    return row?.secret ? decrypt(row.secret) : null;
  }

  async saveState(id: number, state: unknown): Promise<void> {
    await this.db.query("UPDATE sync_sources SET state = $1 WHERE id = $2 AND business_id = $3", [JSON.stringify(state ?? {}), id, this.businessId]);
  }

  async recordSync(id: number, result: { ok: true; summary: string } | { ok: false; error: string }): Promise<void> {
    if (result.ok) {
      await this.db.query("UPDATE sync_sources SET last_synced_at = now(), last_result = $1, last_error = '' WHERE id = $2 AND business_id = $3", [
        result.summary.slice(0, 500),
        id,
        this.businessId,
      ]);
    } else {
      await this.db.query("UPDATE sync_sources SET last_error = $1 WHERE id = $2 AND business_id = $3", [result.error.slice(0, 500), id, this.businessId]);
    }
  }

  async setEnabled(id: number, enabled: boolean): Promise<void> {
    await this.db.query("UPDATE sync_sources SET enabled = $1 WHERE id = $2 AND business_id = $3", [enabled, id, this.businessId]);
  }

  async removeSource(id: number): Promise<void> {
    await this.db.query("DELETE FROM sync_sources WHERE id = $1 AND business_id = $2", [id, this.businessId]);
  }

  // Inbound email

  /** The secret token in this business's receipt forwarding address, created on first use. */
  async inboundToken(): Promise<string> {
    const row = await this.db.one<{ inbound_token: string | null }>("SELECT inbound_token FROM businesses WHERE id = $1", [this.businessId]);
    if (row?.inbound_token) return row.inbound_token;
    const token = randomToken();
    const updated = await this.db.one<{ inbound_token: string }>(
      "UPDATE businesses SET inbound_token = COALESCE(inbound_token, $1) WHERE id = $2 RETURNING inbound_token",
      [token, this.businessId],
    );
    return updated!.inbound_token;
  }

  async rotateInboundToken(): Promise<string> {
    const token = randomToken();
    await this.db.query("UPDATE businesses SET inbound_token = $1 WHERE id = $2", [token, this.businessId]);
    return token;
  }
}

/** Which business a forwarding token belongs to. */
export async function businessForInboundToken(db: Db, token: string): Promise<number | null> {
  if (!/^[a-f0-9]{16,64}$/.test(token)) return null;
  const row = await db.one<{ id: number }>("SELECT id FROM businesses WHERE inbound_token = $1", [token]);
  return row?.id ?? null;
}
