import { parseDate } from "../csv";

/**
 * Reads a receipt email and pulls out who it was from, the total, the date,
 * and an order number. Handles receipts forwarded by the owner (Gmail,
 * Outlook, and Apple Mail forwarding formats) by looking at the original
 * message inside. Plain pattern matching, no AI: it gets the common receipt
 * layouts right and says when it is guessing.
 */

export interface EmailLike {
  fromName: string;
  fromAddress: string;
  subject: string;
  text: string;
  html: string;
  /** When the email was sent, ISO 8601 if known. */
  date: string | null;
}

export interface ExtractedReceipt {
  vendor: string;
  /** Spend in cents; negative for a refund. Null when no amount was found. */
  amountCents: number | null;
  /** False when the amount is a best guess (no "Total" label was found). */
  amountConfident: boolean;
  date: string | null;
  orderRef: string;
  /** The sender of the original receipt (after unwrapping a forward). */
  original: { fromName: string; fromAddress: string; subject: string };
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", dollar: "$", pound: "£", euro: "€", copy: "©", reg: "®", trade: "™", hellip: "…" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|header|footer)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, (s) => (s.includes("\t") ? "\t" : " "))
    .replace(/ *\n[\s]*\n+/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

const FORWARD_MARKERS = [/^-{2,}\s*Forwarded message\s*-{2,}\s*$/im, /^Begin forwarded message:?\s*$/im, /^-{2,}\s*Original Message\s*-{2,}\s*$/im, /^_{10,}\s*$/m];

/** Finds the original message's headers and body inside a forwarded email. */
export function unwrapForward(text: string): { fromName: string; fromAddress: string; subject: string; date: string | null; body: string } | null {
  for (const marker of FORWARD_MARKERS) {
    const m = marker.exec(text);
    if (!m) continue;
    const rest = text.slice(m.index + m[0].length).replace(/^\s+/, "");
    const lines = rest.split("\n");
    const headers: Record<string, string> = {};
    let i = 0;
    for (; i < Math.min(lines.length, 14); i++) {
      const line = lines[i].replace(/^>\s?/, "").replace(/^\*|\*$/g, "").trim();
      if (!line) {
        if (Object.keys(headers).length) break;
        continue;
      }
      const h = line.match(/^\*?(From|Date|Sent|Subject|To|Cc|Reply-To)\*?:\s*\*?\s*(.*)$/i);
      if (!h) {
        if (Object.keys(headers).length) break;
        continue;
      }
      headers[h[1].toLowerCase()] = h[2].trim();
    }
    if (!headers.from) continue;
    const from = parseFromHeader(headers.from);
    return {
      ...from,
      subject: headers.subject ?? "",
      date: parseLooseDate(headers.date ?? headers.sent ?? ""),
      body: lines.slice(i).join("\n").trim(),
    };
  }
  return null;
}

export function parseFromHeader(value: string): { fromName: string; fromAddress: string } {
  const angle = value.match(/^\s*"?([^"<]*?)"?\s*<\s*(?:mailto:)?([^>\s]+@[^>\s]+)\s*>/);
  if (angle) return { fromName: angle[1].trim(), fromAddress: angle[2].toLowerCase() };
  const bracket = value.match(/^\s*(.*?)\s*\[(?:mailto:)?([^\]\s]+@[^\]\s]+)\]/);
  if (bracket) return { fromName: bracket[1].trim(), fromAddress: bracket[2].toLowerCase() };
  const bare = value.match(/([^\s<>"]+@[^\s<>"]+)/);
  return { fromName: bare ? value.replace(bare[1], "").replace(/[<>"()]/g, "").trim() : value.trim(), fromAddress: bare ? bare[1].toLowerCase() : "" };
}

/** Dates as they appear in forwarded headers: "Fri, Oct 10, 2026 at 3:14 PM", "Friday, October 10, 2026 3:14 PM". */
export function parseLooseDate(raw: string): string | null {
  const s = raw
    .replace(/\s+at\s+/i, " ")
    .replace(/\b(\d{1,2}:\d{2})(?::\d{2})?\s*([AP]M)\b.*$/i, "$1 $2")
    .replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s*/i, "")
    .trim();
  if (!s) return null;
  return parseDate(s) ?? parseDate(s.replace(/\s+\d{1,2}:\d{2}.*$/, ""));
}

const MONEY = /(-)?\s*(?:US\s?|USD\s?|CA)?\$\s?(-)?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?(?!\d)|\b(?:USD|US\$)\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?(?!\d)|(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\s?USD\b/g;

function moneyIn(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(MONEY)) {
    let dollars: string;
    let cents: string;
    if (m[3] !== undefined) {
      dollars = m[3];
      cents = m[4] ?? "";
    } else if (m[5] !== undefined) {
      dollars = m[5];
      cents = m[6] ?? "";
    } else {
      dollars = m[7];
      cents = `.${m[8]}`;
    }
    const value = Math.round(parseFloat(`${dollars.replace(/,/g, "")}${cents}`) * 100);
    const negative = !!(m[1] || m[2]) || /\(\s*\$?[\d,.]+\s*\)/.test(line);
    if (Number.isFinite(value)) out.push(negative ? -value : value);
  }
  return out;
}

const STRONG_TOTAL = /\b(grand total|order total|total charged|amount charged|charged to|amount paid|total paid|you paid|payment (?:total|amount)|total due|amount due|balance due|total amount|invoice total|total \(usd\)|total usd)\b/i;
const TOTAL = /\btotal\b/i;
const NOT_TOTAL = /\b(sub-?\s?total|subtotal|tax(es)?|tip|gratuity|shipping|delivery fee|discount|savings|saved|you save|points|previous balance|items?\s*\(\d+\)|before tax)\b/i;

/** Finds the receipt total. Prefers clearly labeled totals; falls back to the largest amount. */
export function findTotal(text: string): { cents: number | null; confident: boolean } {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  let best: { score: number; cents: number; idx: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const strong = STRONG_TOTAL.test(line);
    const plain = !strong && TOTAL.test(line) && !NOT_TOTAL.test(line);
    if (!strong && !plain) continue;
    let amounts = moneyIn(line);
    // Totals in HTML tables often put the label and the amount on separate lines.
    if (amounts.length === 0 && i + 1 < lines.length) amounts = moneyIn(lines[i + 1]);
    if (amounts.length === 0) continue;
    const cents = amounts[amounts.length - 1];
    const score = strong ? 3 : 2;
    if (!best || score > best.score || (score === best.score && i > best.idx)) best = { score, cents, idx: i };
  }
  if (best) return { cents: Math.abs(best.cents), confident: true };
  const all = lines.flatMap(moneyIn).map(Math.abs).filter((c) => c > 0);
  return all.length ? { cents: Math.max(...all), confident: false } : { cents: null, confident: false };
}

const GENERIC_SENDER = /^(no[-_. ]?reply|do[-_. ]?not[-_. ]?reply|receipts?|billing|invoices?|orders?|payments?|support|notifications?|info|hello|team|accounts?|service|customer ?service|mail(er)?|auto[-_ ]?confirm|store[-_ ]?news|digital[-_ ]?no[-_ ]?reply)$/i;

function cleanVendor(s: string): string {
  return s
    .replace(/\s*(#|order|no\.|number)\s*[\w-]*\d[\w-]*.*$/i, "")
    .replace(/\s+(via|through)\s+.*$/i, "")
    .replace(/\s+(payment|order|purchase|billing)$/i, "")
    .replace(/\s*[-–—|:(]\s*$/, "")
    .replace(/[,.]?\s+(Inc|LLC|Ltd|Corp|Co)\.?$/i, "")
    .replace(/^["'“”]+|["'“”.!]+$/g, "")
    .trim()
    .slice(0, 80);
}

const SUBJECT_VENDOR = [
  /\b(?:receipt|invoice|order|purchase|payment|trip|ride|booking|reservation)\s+(?:from|for|with|at)\s+(.+?)(?:\s+[-–—|(#]|[.!]?$)/i,
  /\bthank(?:s| you) for (?:your )?(?:order|purchase|shopping|payment|business)\s+(?:from|with|at)\s+(.+?)(?:[.!]?$|\s+[-–—|(#])/i,
  /\byour\s+(.+?)\s+(?:order|receipt|invoice|purchase|subscription|bill|trip|ride)\b/i,
  /\b(?:order|purchase)\s+(?:confirmation|confirmed)\s*(?:from|[-–—:])\s*(.+?)(?:[.!]?$|\s+[-–—|(#])/i,
  /^(.+?)\s+(?:receipt|invoice|order confirmation)\b/i,
];

/** Who was paid: the store named in the subject, else the sender's name, else their domain. */
export function findVendor(original: { fromName: string; fromAddress: string; subject: string }): string {
  const subject = original.subject.replace(/^((re|fwd?|fw)\s*:\s*)+/i, "").trim();
  const tag = subject.match(/^\[([^\]]{2,40})\]/);
  if (tag) return cleanVendor(tag[1]);
  for (const re of SUBJECT_VENDOR) {
    const m = subject.match(re);
    if (m) {
      const v = cleanVendor(m[1]);
      if (v && !/^(your|my|the|an?|new|recent|this)$/i.test(v) && v.length >= 2) return v;
    }
  }
  const name = cleanVendor(original.fromName.replace(/\b(receipts?|billing|orders?|payments?|no-?reply|team|support|notifications?)\b/gi, "").replace(/\s{2,}/g, " "));
  if (name && !GENERIC_SENDER.test(name) && !name.includes("@")) return name;
  const domain = original.fromAddress.split("@")[1] ?? "";
  const parts = domain.split(".").filter(Boolean);
  const base = parts.length >= 3 && /^(co|com|org|net)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2];
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "";
}

const ORDER_REF = /\b(?:order|invoice|receipt|confirmation|transaction|reference|ref)[ \t]*(?:number|no\.?|num|#|id)?[ \t]*[:#]?[ \t]*#?[ \t]*([A-Z0-9][A-Z0-9-]{4,30})\b/gi;

export function extractReceipt(email: EmailLike): ExtractedReceipt {
  const fullText = (email.text?.trim() || htmlToText(email.html ?? "")).replace(/\r\n?/g, "\n");
  const forwarded = unwrapForward(fullText);
  const original = forwarded
    ? { fromName: forwarded.fromName, fromAddress: forwarded.fromAddress, subject: forwarded.subject || email.subject }
    : { fromName: email.fromName, fromAddress: email.fromAddress, subject: email.subject };
  const body = forwarded?.body || fullText;
  // Totals are easier to find in the HTML version: text parts often drop table cells.
  const htmlText = email.html ? htmlToText(email.html) : "";
  let total = findTotal(body);
  if (!total.confident && htmlText) {
    const fromHtml = findTotal(forwarded ? (unwrapForward(htmlText)?.body ?? htmlText) : htmlText);
    if (fromHtml.confident || total.cents === null) total = fromHtml;
  }
  const refund = /\brefund(ed)?\b/i.test(original.subject);
  const sentDate = forwarded?.date ?? (email.date ? email.date.slice(0, 10) : null);
  const orderRef = [...`${original.subject}\n${body}`.matchAll(ORDER_REF)].map((m) => m[1]).find((ref) => /\d/.test(ref)) ?? "";
  return {
    vendor: findVendor(original),
    amountCents: total.cents === null ? null : refund ? -total.cents : total.cents,
    amountConfident: total.confident,
    date: sentDate,
    orderRef,
    original,
    text: body.slice(0, 20_000),
  };
}
