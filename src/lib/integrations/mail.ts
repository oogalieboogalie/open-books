import type { Db } from "../db";
import { receiptFromEmail, Receipts, type ReceiptInput } from "../receipts/receipts";
import type { GoogleClient } from "./google";

/**
 * Pulling receipts from a mailbox instead of forwarding them:
 * - Gmail, through the connected Google account, using a Gmail search.
 * - Any IMAP mailbox (Outlook, Fastmail, iCloud, a business domain), with an
 *   app password, usually pointed at a "Receipts" folder.
 * Mail that has no amount and no PDF or image attached is skipped, so a broad
 * search does not fill the receipts inbox with newsletters.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_PER_SYNC = 100;

export const DEFAULT_GMAIL_QUERY = 'label:receipts OR subject:(receipt OR invoice OR "order confirmation" OR "payment received" OR "your order")';

export interface GmailConfig {
  query: string;
}
export interface GmailState {
  lastSyncAt?: number;
}

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  folder: string;
}
export interface ImapState {
  uidValidity?: string;
  lastUid?: number;
}

const looksLikeReceipt = (r: ReceiptInput) => r.amountCents !== null || (r.files ?? []).some((f) => f.contentType !== "text/html");

async function alreadyHave(db: Db, businessId: number, externalId: string): Promise<boolean> {
  return !!(await db.one("SELECT 1 FROM receipts WHERE business_id = $1 AND external_id = $2", [businessId, externalId]));
}

async function store(receipts: Receipts, input: ReceiptInput, counts: { added: number; matched: number; skipped: number }) {
  if (!looksLikeReceipt(input)) {
    counts.skipped++;
    return;
  }
  const r = await receipts.add(input);
  if (r) {
    counts.added++;
    if (r.matched) counts.matched++;
  }
}

function summary(c: { added: number; matched: number; skipped: number }): string {
  return `${c.added} receipt${c.added === 1 ? "" : "s"} added, ${c.matched} matched to transactions${c.skipped ? `, ${c.skipped} other emails skipped` : ""}`;
}

export async function syncGmail(receipts: Receipts, config: GmailConfig, state: GmailState, client: GoogleClient, now = Date.now()): Promise<{ state: GmailState; summary: string }> {
  // Gmail's after: is in whole seconds; overlap by two days so nothing slips between syncs.
  const since = state.lastSyncAt ? `after:${Math.floor(state.lastSyncAt / 1000) - 2 * 86_400}` : "newer_than:90d";
  const q = `(${config.query || DEFAULT_GMAIL_QUERY}) ${since}`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await client.json<{ messages?: { id: string }[]; nextPageToken?: string }>(`${GMAIL_API}/messages?${params}`);
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < 500);

  const counts = { added: 0, matched: 0, skipped: 0 };
  let fetched = 0;
  for (const id of ids.reverse()) {
    if (await alreadyHave(receipts.db, receipts.businessId, `gmail:${id}`)) continue;
    if (fetched++ >= MAX_PER_SYNC) break;
    const msg = await client.json<{ raw: string }>(`${GMAIL_API}/messages/${id}?format=raw`);
    const input = await receiptFromEmail(Buffer.from(msg.raw, "base64url"), "gmail", { externalId: `gmail:${id}` });
    await store(receipts, input, counts);
  }
  // Only move the window forward once everything in it was read.
  return { state: fetched > MAX_PER_SYNC ? state : { lastSyncAt: now }, summary: summary(counts) };
}

export async function syncImap(receipts: Receipts, config: ImapConfig, password: string, state: ImapState): Promise<{ state: ImapState; summary: string }> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: password },
    logger: false,
    socketTimeout: 60_000,
  });
  await client.connect();
  const counts = { added: 0, matched: 0, skipped: 0 };
  let next: ImapState = state;
  try {
    const lock = await client.getMailboxLock(config.folder || "INBOX");
    try {
      const box = client.mailbox;
      const uidValidity = box ? String(box.uidValidity) : "";
      const fresh = !state.lastUid || state.uidValidity !== uidValidity;
      let uids: number[];
      if (fresh) {
        const found = await client.search({ since: new Date(Date.now() - 90 * 86_400_000) }, { uid: true });
        uids = found || [];
      } else {
        const found = await client.search({ uid: `${state.lastUid! + 1}:*` }, { uid: true });
        uids = (found || []).filter((u) => u > state.lastUid!);
      }
      uids.sort((a, b) => a - b);
      const batch = uids.slice(0, MAX_PER_SYNC);
      let lastUid = fresh ? 0 : state.lastUid!;
      if (batch.length) {
        for await (const msg of client.fetch(batch.join(","), { uid: true, source: true }, { uid: true })) {
          if (msg.source) {
            const input = await receiptFromEmail(msg.source, "imap", { externalId: `imap:${config.host}:${config.user}:${uidValidity}:${msg.uid}` });
            await store(receipts, input, counts);
          }
          lastUid = Math.max(lastUid, msg.uid);
        }
      } else if (fresh) {
        lastUid = Math.max(0, (box ? Number(box.uidNext) : 1) - 1);
      }
      next = { uidValidity, lastUid };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return { state: next, summary: summary(counts) };
}

/** Checks IMAP settings before saving them: connects, signs in, and opens the folder. */
export async function testImap(config: ImapConfig, password: string): Promise<string> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host: config.host, port: config.port, secure: config.secure, auth: { user: config.user, pass: password }, logger: false, socketTimeout: 20_000 });
  await client.connect();
  try {
    const status = await client.status(config.folder || "INBOX", { messages: true });
    return `Connected. ${(status && status.messages) ?? 0} messages in ${config.folder || "INBOX"}.`;
  } finally {
    await client.logout().catch(() => undefined);
  }
}
