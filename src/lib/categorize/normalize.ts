/**
 * Bank descriptions are noisy: "POS DEBIT 10/14 SQ *BLUE BOTTLE COF 12345 OAKLAND CA".
 * normalizeDescription strips the card-network boilerplate so keyword and rule
 * matching sees "BLUE BOTTLE COF OAKLAND CA", and merchantKey shortens that to a
 * stable key ("BLUE BOTTLE") that is the same across store locations.
 */

const PREFIXES: RegExp[] = [
  /^PURCHASE AUTHORIZED ON \d{1,2}\/\d{1,2}\s+/,
  /^(POS|DBT|DEBIT)( CARD)? (PURCHASE|DEBIT|WITHDRAWAL)\s+/,
  /^(POS|DEBIT|CHECKCARD|CHECK CARD|VISA|CARD) (PURCHASE|DEBIT)?\s*/,
  /^(RECURRING|PREAUTHORIZED|ONLINE) (PAYMENT|DEBIT|PURCHASE)\s+/,
  /^ACH (DEBIT|CREDIT|DEPOSIT|WITHDRAWAL)\s+/,
  /^(SQ|TST|SP|PP|PAYPAL|IN|PY|BT|EB|DD|FS|PAR|WPY|CKE)\s?\*\s*/,
];

const NOISE: RegExp[] = [
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, // dates
  /#\s*\d+/g, // store numbers
  /\b(REF|CONF|TRACE|ID|TXN)\s*[:#]?\s*[A-Z0-9]*\d[A-Z0-9]*\b/g, // reference ids
  /\d{4,}/g, // long digit runs: card, store, and reference numbers
  /\bX{2,}\d*\b/g, // masked card numbers
];

export function normalizeDescription(raw: string): string {
  let s = raw.toUpperCase().replace(/\s+/g, " ").trim();
  // Prefixes can stack ("POS DEBIT 10/14 SQ *..."), so strip until nothing changes.
  let prev;
  do {
    prev = s;
    s = s.replace(/^\d{1,2}\/\d{1,2}(\/\d{2,4})?\s+/, "");
    for (const re of PREFIXES) s = s.replace(re, "");
  } while (s !== prev);
  s = s.replace(/\*/g, " ");
  for (const re of NOISE) s = s.replace(re, " ");
  s = s.replace(/[^A-Z0-9&.'\/\- ]+/g, " ");
  s = s.replace(/\s[-.\/]+(?=\s|$)/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
);

const KEY_STOPWORDS = new Set(["THE", "INC", "LLC", "CO", "CORP", "LTD", "STORE", "STORES", "OF"]);

/** A short, location-independent key for a merchant, used for learned rules. */
export function merchantKey(raw: string): string {
  let tokens = normalizeDescription(raw)
    .split(" ")
    .filter((t) => t.length > 0 && !KEY_STOPWORDS.has(t) && !/^\d+$/.test(t));
  // Drop a trailing "CITY ST" so every location of a chain shares one key.
  if (tokens.length >= 3 && US_STATES.has(tokens[tokens.length - 1])) tokens = tokens.slice(0, -2);
  return tokens.slice(0, 2).join(" ");
}

const GENERIC_WORDS = /\b(DEPOSIT|TRANSFER|XFER|PAYMENT|PMT|CHECK|ATM|WITHDRAWAL|ZELLE|VENMO|CASH APP|CASHOUT|ACH|WIRE)\b/;

/**
 * Keys like "MOBILE DEPOSIT" or "ZELLE PAYMENT" describe how money moved, not
 * who it came from, so a rule on them would sweep up unrelated transactions.
 */
export function isGenericMerchant(key: string): boolean {
  return key === "" || GENERIC_WORDS.test(key);
}

/** True when `needle` appears in `haystack` as whole words. Both must be normalized. */
export function containsWords(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9])${escaped}($|[^A-Z0-9])`).test(haystack);
}
