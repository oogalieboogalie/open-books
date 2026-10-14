import type { Integrations } from "./store";

/**
 * Google sign-in (OAuth 2.0) and an authorized fetch for Google APIs, with no
 * SDK. Each install brings its own Google Cloud project: set GOOGLE_CLIENT_ID
 * and GOOGLE_CLIENT_SECRET, and register {APP_URL}/integrations/google/callback
 * as a redirect URI. Features ask for their scopes only when turned on
 * (incremental authorization), so connecting Sheets never asks for Calendar.
 */

export const GOOGLE_FEATURES = {
  sheets: { label: "Google Sheets", scopes: ["https://www.googleapis.com/auth/spreadsheets"] },
  calendar: { label: "Google Calendar", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] },
  gmail: { label: "Gmail receipts", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
} as const;
export type GoogleFeature = keyof typeof GOOGLE_FEATURES;

const BASE_SCOPES = ["openid", "email"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function googleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Reading a whole inbox needs Google's restricted-scope review for a public app, so it is opt-in for self-hosters. */
export function gmailEnabled(): boolean {
  return process.env.GOOGLE_ENABLE_GMAIL === "1" || process.env.GOOGLE_ENABLE_GMAIL === "true";
}

export function hasFeature(scopes: string[], feature: GoogleFeature): boolean {
  return GOOGLE_FEATURES[feature].scopes.every((s) => scopes.includes(s));
}

export function redirectUri(origin: string): string {
  return `${(process.env.APP_URL || origin).replace(/\/+$/, "")}/integrations/google/callback`;
}

export function authorizationUrl(cfg: GoogleConfig, opts: { features: GoogleFeature[]; state: string; redirectUri: string; loginHint?: string }): string {
  const scopes = [...BASE_SCOPES, ...opts.features.flatMap((f) => GOOGLE_FEATURES[f].scopes)];
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    // Always ask, so Google returns a refresh token even on a repeat connect.
    prompt: "consent",
    state: opts.state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_URL}?${params}`;
}

export class GoogleAuthError extends Error {}

async function tokenRequest(body: Record<string, string>, fetchImpl: FetchLike) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(json.error_description ?? json.error ?? `Google sign-in failed (${res.status})`);
    if (json.error === "invalid_grant") throw new GoogleAuthError(msg);
    throw new Error(msg);
  }
  return json as { access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string };
}

/** Trades the code from the redirect for tokens, and reads which account and scopes were granted. */
export async function exchangeCode(cfg: GoogleConfig, code: string, redirect: string, fetchImpl: FetchLike = fetch) {
  const t = await tokenRequest({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }, fetchImpl);
  let email = "";
  if (t.id_token) {
    // The token came straight from Google over TLS, so its claims can be read without verifying the signature.
    try {
      email = String(JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString("utf8")).email ?? "");
    } catch {
      email = "";
    }
  }
  return {
    email,
    scopes: (t.scope ?? "").split(" ").filter(Boolean),
    tokens: { accessToken: t.access_token, refreshToken: t.refresh_token ?? "", expiresAt: Date.now() + (t.expires_in - 60) * 1000 } satisfies GoogleTokens,
  };
}

export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchImpl(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Calls Google APIs as the connected account, refreshing the access token when
 * it expires. A revoked grant marks the connection as needing sign-in again.
 */
export class GoogleClient {
  private tokens: GoogleTokens | null = null;

  constructor(
    private integrations: Integrations,
    private cfg: GoogleConfig,
    private fetchImpl: FetchLike = fetch,
  ) {}

  static async for(integrations: Integrations, fetchImpl: FetchLike = fetch): Promise<GoogleClient> {
    const cfg = googleConfig();
    if (!cfg) throw new Error("Google is not set up on this server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    const conn = await integrations.connection("google");
    if (!conn) throw new Error("Connect your Google account first.");
    if (conn.status === "reauth") throw new Error("Google access expired or was removed. Reconnect your Google account.");
    return new GoogleClient(integrations, cfg, fetchImpl);
  }

  private async accessToken(force = false): Promise<string> {
    this.tokens ??= await this.integrations.credentials<GoogleTokens>("google");
    if (!this.tokens) {
      await this.integrations.markNeedsReauth("google", "Stored credentials could not be read (APP_SECRET changed?)");
      throw new Error("Reconnect your Google account.");
    }
    if (!force && this.tokens.expiresAt > Date.now()) return this.tokens.accessToken;
    if (!this.tokens.refreshToken) throw new Error("Reconnect your Google account.");
    try {
      const t = await tokenRequest(
        { client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: this.tokens.refreshToken, grant_type: "refresh_token" },
        this.fetchImpl,
      );
      this.tokens = { accessToken: t.access_token, refreshToken: t.refresh_token || this.tokens.refreshToken, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
      await this.integrations.updateCredentials("google", this.tokens);
      return this.tokens.accessToken;
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        await this.integrations.markNeedsReauth("google", err.message);
        throw new Error("Google access expired or was removed. Reconnect your Google account.");
      }
      throw err;
    }
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const send = async (token: string) =>
      this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
    let res = await send(await this.accessToken());
    if (res.status === 401) res = await send(await this.accessToken(true));
    return res;
  }

  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(url, init.body ? { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) } } : init);
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new GoogleApiError(body.error?.message || `Google returned ${res.status}`, res.status);
    return body as T;
  }
}
