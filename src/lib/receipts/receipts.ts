import PostalMime from "postal-mime";
import type { Books } from "../books";
import { merchantKey } from "../categorize/normalize";
import type { Db } from "../db";
import { localDate } from "../integrations/calendar";
import { addDays, daysBetween } from "../timeline";
import { extractReceipt } from "./extract";

type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>;

/**
 * Receipts that arrive by email (a forwarding address, Gmail, or an IMAP
 * mailbox) or are uploaded by hand. Each one is read for vendor, total, and
 * date, then matched to the bank or card transaction it belongs to. Receipts
 * that arrive before the transaction is imported are matched when it shows up.
 */

export const RECEIPT_SOURCES = ["forward", "gmail", "imap", "upload"] as const;
export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];
export type ReceiptStatus = "unmatched" | "matched" | "ignored";

export interface Receipt {
  id: number;
  source: ReceiptSource;
  fromAddress: string;
  fromName: string;
  subject: string;
  receivedAt: string;
  vendor: string;
  date: string | null;
  amountCents: number | null;
  amountConfident: boolean;
  orderRef: string;
  status: ReceiptStatus;
  transactionId: number | null;
  matchKind: "" | "auto" | "manual" | "created";
  files: { id: number; filename: string; contentType: string; size: number }[];
}

export interface ReceiptFileInput {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface ReceiptInput {
  source: ReceiptSource;
  externalId?: string | null;
  fromAddress?: string;
  fromName?: string;
  subject?: string;
  receivedAt?: string;
  vendor: string;
  date: string | null;
  amountCents: number | null;
  amountConfident?: boolean;
  orderRef?: string;
  bodyText?: string;
  files?: ReceiptFileInput[];
}

export interface MatchCandidate {
  id: number;
  date: string;
  description: string;
  amountCents: number;
  /** Higher is a better match. */
  score: number;
  reason: string;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const KEPT_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp|heic|heif))$/i;

const RECEIPT_COLUMNS = `r.id, r.source, r.from_address AS "fromAddress", r.from_name AS "fromName", r.subject, r.received_at AS "receivedAt", r.vendor, r.date,
  r.amount_cents AS "amountCents", r.amount_confident AS "amountConfident", r.order_ref AS "orderRef", r.status, r.transaction_id AS "transactionId", r.match_kind AS "matchKind",
  COALESCE((SELECT json_agg(json_build_object('id', f.id, 'filename', f.filename, 'contentType', f.content_type, 'size', f.size) ORDER BY f.id)
    FROM receipt_files f WHERE f.receipt_id = r.id), '[]'::json) AS files`;

/** Days a card charge may post before or after the receipt date. */
const MATCH_BEFORE = 3;
const MATCH_AFTER = 10;

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

const bytesOf = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : typeof v === "string" && v.startsWith("\\x") ? Uint8Array.from(Buffer.from(v.slice(2), "hex")) : new Uint8Array());

export class Receipts {
  constructor(
    readonly db: Db,
    readonly businessId: number,
  ) {}

  static for(books: Books): Receipts {
    return new Receipts(books.db, books.businessId);
  }

  // Intake

  /** Stores a receipt, then tries to match it. Returns null if this email was already received. */
  async add(input: ReceiptInput): Promise<{ id: number; matched: boolean } | null> {
    const id = await this.db.transaction(async (tx) => {
      const row = await tx.one<{ id: number }>(
        `INSERT INTO receipts (business_id, source, external_id, from_address, from_name, subject, received_at, vendor, date, amount_cents, amount_confident, order_ref, body_text)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          this.businessId,
          input.source,
          input.externalId ?? null,
          (input.fromAddress ?? "").slice(0, 300),
          (input.fromName ?? "").slice(0, 300),
          (input.subject ?? "").slice(0, 500),
          input.receivedAt ?? null,
          input.vendor.slice(0, 200),
          input.date,
          input.amountCents,
          input.amountConfident ?? true,
          (input.orderRef ?? "").slice(0, 60),
          (input.bodyText ?? "").slice(0, 20_000),
        ],
      );
      if (!row) return null;
      for (const f of input.files ?? []) {
        await tx.query("INSERT INTO receipt_files (receipt_id, filename, content_type, size, data) VALUES ($1, $2, $3, $4, $5)", [
          row.id,
          f.filename.slice(0, 200),
          f.contentType,
          f.data.byteLength,
          Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength),
        ]);
      }
      return row.id;
    });
    if (id == null) return null;
    return { id, matched: await this.autoMatch(id) };
  }

  /** Reads a raw email (RFC 822) and stores it as a receipt. */
  async addEmail(raw: string | Uint8Array | ArrayBuffer, source: ReceiptSource, opts: { externalId?: string; timeZone?: string } = {}): Promise<{ id: number; matched: boolean } | null> {
    const input = await receiptFromEmail(raw, source, opts);
    return this.add(input);
  }

  // Reading

  async list(filter: { status?: ReceiptStatus; limit?: number; offset?: number } = {}): Promise<{ rows: Receipt[]; total: number }> {
    const params: unknown[] = [this.businessId];
    let where = "r.business_id = $1";
    if (filter.status) {
      params.push(filter.status);
      where += ` AND r.status = $${params.length}`;
    }
    const total = (await this.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM receipts r WHERE ${where}`, params))!.n;
    params.push(filter.limit ?? 50, filter.offset ?? 0);
    const rows = await this.db.query<Receipt>(
      `SELECT ${RECEIPT_COLUMNS} FROM receipts r WHERE ${where} ORDER BY COALESCE(r.date, r.received_at::date) DESC, r.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows: rows.map(fixFiles), total };
  }

  async get(id: number): Promise<(Receipt & { bodyText: string }) | null> {
    const row = await this.db.one<Receipt & { bodyText: string }>(`SELECT ${RECEIPT_COLUMNS}, r.body_text AS "bodyText" FROM receipts r WHERE r.id = $1 AND r.business_id = $2`, [id, this.businessId]);
    return row ? fixFiles(row) : null;
  }

  async counts(): Promise<Record<ReceiptStatus, number>> {
    const rows = await this.db.query<{ status: ReceiptStatus; n: number }>("SELECT status, COUNT(*)::int AS n FROM receipts WHERE business_id = $1 GROUP BY status", [this.businessId]);
    const out: Record<ReceiptStatus, number> = { unmatched: 0, matched: 0, ignored: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  async file(fileId: number): Promise<{ filename: string; contentType: string; data: Uint8Array } | null> {
    const row = await this.db.one<{ filename: string; contentType: string; data: unknown }>(
      `SELECT f.filename, f.content_type AS "contentType", f.data FROM receipt_files f JOIN receipts r ON r.id = f.receipt_id WHERE f.id = $1 AND r.business_id = $2`,
      [fileId, this.businessId],
    );
    return row ? { filename: row.filename, contentType: row.contentType, data: bytesOf(row.data) } : null;
  }

  // Matching

  /** Transactions this receipt could belong to, best first. */
  async candidates(id: number, limit = 8): Promise<MatchCandidate[]> {
    const r = await this.get(id);
    if (!r || r.amountCents === null || !r.date) return [];
    const want = -r.amountCents;
    // Same amount, or within 25% (a tip added after the receipt) from the same vendor.
    const rows = await this.db.query<{ id: number; date: string; description: string; merchant_key: string; amount_cents: number }>(
      `SELECT t.id, t.date, t.description, t.merchant_key, t.amount_cents FROM transactions t
       WHERE t.business_id = $1 AND t.date BETWEEN $2 AND $3 AND SIGN(t.amount_cents) = SIGN($4::bigint)
         AND ABS(t.amount_cents) BETWEEN ABS($4::bigint) * 0.75 AND ABS($4::bigint) * 1.35
         AND NOT EXISTS (SELECT 1 FROM receipts o WHERE o.transaction_id = t.id AND o.id <> $5)
       LIMIT 200`,
      [this.businessId, addDays(r.date, -MATCH_BEFORE), addDays(r.date, MATCH_AFTER), want, id],
    );
    const vendorKey = merchantKey(r.vendor);
    const vendorWords = vendorKey.split(" ").filter((w) => w.length >= 3);
    return rows
      .map((t) => {
        const exact = t.amount_cents === want;
        const sameVendor = vendorWords.length > 0 && vendorWords.some((w) => t.merchant_key.includes(w) || t.description.toUpperCase().includes(w));
        const days = Math.abs(daysBetween(r.date!, t.date));
        const score = (exact ? 10 : 0) + (sameVendor ? 6 : 0) - days * 0.5;
        const reason = [exact ? "same amount" : "close amount", sameVendor ? "same vendor" : "", days === 0 ? "same day" : `${days} day${days === 1 ? "" : "s"} apart`].filter(Boolean).join(", ");
        return { id: t.id, date: t.date, description: t.description, amountCents: t.amount_cents, score, reason, exact, sameVendor };
      })
      .filter((c) => c.exact || c.sameVendor)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ exact: _e, sameVendor: _s, ...c }) => c);
  }

  /**
   * Links the receipt to a transaction when there is one clear match: the same
   * amount, and either the only such charge in the window or the only one from
   * the same vendor.
   */
  async autoMatch(id: number): Promise<boolean> {
    const r = await this.db.one<{ status: string; amount_confident: boolean }>("SELECT status, amount_confident FROM receipts WHERE id = $1 AND business_id = $2", [id, this.businessId]);
    if (!r || r.status !== "unmatched") return false;
    const exact = (await this.candidates(id, 50)).filter((c) => c.reason.startsWith("same amount"));
    const vendor = exact.filter((c) => c.reason.includes("same vendor"));
    const pick = vendor.length === 1 ? vendor[0] : exact.length === 1 && (r.amount_confident || vendor.length === 1) ? exact[0] : null;
    if (!pick) return false;
    await this.link(id, pick.id, "auto");
    return true;
  }

  /** Tries every unmatched receipt again, after new transactions arrive. Returns how many matched. */
  async matchUnmatched(): Promise<number> {
    const rows = await this.db.query<{ id: number }>("SELECT id FROM receipts WHERE business_id = $1 AND status = 'unmatched' AND amount_cents IS NOT NULL ORDER BY id", [this.businessId]);
    let n = 0;
    for (const r of rows) if (await this.autoMatch(r.id)) n++;
    return n;
  }

  async link(id: number, transactionId: number, kind: "auto" | "manual" | "created" = "manual"): Promise<void> {
    const ok = await this.db.one("SELECT 1 FROM transactions WHERE id = $1 AND business_id = $2", [transactionId, this.businessId]);
    if (!ok) throw new Error("Transaction not found");
    await this.db.query("UPDATE receipts SET transaction_id = $1, status = 'matched', match_kind = $2 WHERE id = $3 AND business_id = $4", [transactionId, kind, id, this.businessId]);
  }

  async unlink(id: number): Promise<void> {
    await this.db.query("UPDATE receipts SET transaction_id = NULL, status = 'unmatched', match_kind = '' WHERE id = $1 AND business_id = $2", [id, this.businessId]);
  }

  async setIgnored(id: number, ignored: boolean): Promise<void> {
    await this.db.query(
      `UPDATE receipts SET status = CASE WHEN $1 THEN 'ignored' WHEN transaction_id IS NULL THEN 'unmatched' ELSE 'matched' END WHERE id = $2 AND business_id = $3`,
      [ignored, id, this.businessId],
    );
  }

  async update(id: number, input: { vendor?: string; amountCents?: number | null; date?: string | null }): Promise<void> {
    await this.db.query(
      `UPDATE receipts SET vendor = COALESCE($1, vendor), amount_cents = CASE WHEN $2::boolean THEN $3::bigint ELSE amount_cents END,
         amount_confident = CASE WHEN $2::boolean THEN true ELSE amount_confident END, date = COALESCE($4::date, date)
       WHERE id = $5 AND business_id = $6`,
      [input.vendor?.trim() || null, input.amountCents !== undefined, input.amountCents ?? null, input.date || null, id, this.businessId],
    );
    await this.autoMatch(id);
  }

  async delete(id: number): Promise<void> {
    await this.db.query("DELETE FROM receipts WHERE id = $1 AND business_id = $2", [id, this.businessId]);
  }

  /**
   * Records the purchase as a new transaction and attaches the receipt, for
   * spending that will not arrive through an import (cash, a personal card).
   */
  async createTransaction(id: number, books: Books, accountId: number | null): Promise<number> {
    const r = await this.get(id);
    if (!r) throw new Error("Receipt not found");
    if (r.amountCents === null || !r.date) throw new Error("Add the amount and date first.");
    const added = await books.addTransaction({
      date: r.date,
      description: r.vendor || r.subject || "Receipt",
      amountCents: -r.amountCents,
      accountId,
      notes: [r.orderRef && `Order ${r.orderRef}`, r.subject].filter(Boolean).join(" · ").slice(0, 300),
    });
    await this.link(id, added!.id, "created");
    return added!.id;
  }
}

function fixFiles<T extends { files: unknown }>(row: T): T {
  const files = typeof row.files === "string" ? JSON.parse(row.files) : row.files;
  return { ...row, files: Array.isArray(files) ? files : [] };
}

const firstMailbox = (a: ParsedEmail["from"]): { name: string; address: string } => {
  if (!a) return { name: "", address: "" };
  if (a.address !== undefined) return { name: a.name ?? "", address: a.address ?? "" };
  return a.group?.[0] ? { name: a.group[0].name ?? "", address: a.group[0].address ?? "" } : { name: a.name ?? "", address: "" };
};

export interface EmailParts {
  fromName: string;
  fromAddress: string;
  subject: string;
  text: string;
  html: string;
  /** When it was sent, ISO 8601. */
  sentAt: string | null;
  messageId: string;
  attachments: { filename: string; contentType: string; data: Uint8Array }[];
}

/** Turns an already-split email (from a mail provider's webhook, or a parsed message) into a receipt. */
export function receiptFromParts(email: EmailParts, source: ReceiptSource, opts: { externalId?: string; timeZone?: string; outer?: { name: string; address: string } } = {}): ReceiptInput {
  const extracted = extractReceipt({
    fromName: email.fromName,
    fromAddress: email.fromAddress,
    subject: email.subject,
    text: email.text,
    html: email.html,
    date: email.sentAt ? localDate(email.sentAt, opts.timeZone) : null,
  });
  const files: ReceiptFileInput[] = [];
  for (const a of email.attachments) {
    if (!KEPT_TYPES.test(a.contentType)) continue;
    if (a.data.byteLength === 0 || a.data.byteLength > MAX_FILE_BYTES) continue;
    files.push({ filename: a.filename || `attachment.${a.contentType.split("/")[1]}`, contentType: a.contentType.toLowerCase(), data: a.data });
  }
  if (email.html && email.html.length <= MAX_HTML_BYTES) files.push({ filename: "email.html", contentType: "text/html", data: new TextEncoder().encode(email.html) });
  const messageId = email.messageId.trim();
  return {
    source,
    externalId: opts.externalId ?? (messageId ? `msg:${messageId.slice(0, 300)}` : null),
    fromAddress: extracted.original.fromAddress || opts.outer?.address || email.fromAddress,
    fromName: extracted.original.fromName || opts.outer?.name || email.fromName,
    subject: extracted.original.subject,
    receivedAt: email.sentAt ?? undefined,
    vendor: extracted.vendor,
    date: extracted.date,
    amountCents: extracted.amountCents,
    amountConfident: extracted.amountConfident,
    orderRef: extracted.orderRef,
    bodyText: extracted.text,
    files,
  };
}

/** Turns a raw email (RFC 822) into a receipt: the original receipt inside a forward, its total and date, and any PDF or image attachments. */
export async function receiptFromEmail(raw: string | Uint8Array | ArrayBuffer, source: ReceiptSource, opts: { externalId?: string; timeZone?: string } = {}): Promise<ReceiptInput> {
  let email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer", rfc822Attachments: true });
  // "Forward as attachment" wraps the original message in a message/rfc822 part.
  const inner = email.attachments.find((a) => a.mimeType === "message/rfc822");
  let wrapper: ParsedEmail | null = null;
  if (inner && !email.text?.match(/\$\s?\d/) && !email.html?.match(/\$\s?\d/)) {
    wrapper = email;
    email = await PostalMime.parse(toBytes(inner.content), { attachmentEncoding: "arraybuffer" });
  }
  const from = firstMailbox(email.from);
  const sentAt = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : null;
  return receiptFromParts(
    {
      fromName: from.name,
      fromAddress: from.address,
      subject: email.subject ?? "",
      text: email.text ?? "",
      html: email.html ?? "",
      sentAt,
      messageId: (wrapper ?? email).messageId ?? "",
      attachments: [...email.attachments, ...(wrapper?.attachments ?? [])]
        .filter((a) => a.mimeType !== "message/rfc822")
        .map((a) => ({ filename: a.filename ?? "", contentType: a.mimeType, data: toBytes(a.content) })),
    },
    source,
    { ...opts, outer: wrapper ? firstMailbox(wrapper.from) : undefined },
  );
}
