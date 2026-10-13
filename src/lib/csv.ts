/**
 * Import bank and credit card CSV exports. Column layouts differ by bank, so
 * the importer looks at the header row and works out which columns hold the
 * date, description, and amount (either one signed column, or separate debit
 * and credit columns).
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^﻿/, "");

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface ColumnMapping {
  date: number;
  description: number;
  amount?: number;
  debit?: number;
  credit?: number;
  /** A column saying "debit"/"credit" when the amount column is unsigned. */
  type?: number;
}

function findColumn(headers: string[], patterns: RegExp[], exclude: number[] = []): number | undefined {
  for (const pattern of patterns) {
    const idx = headers.findIndex((h, i) => !exclude.includes(i) && pattern.test(h));
    if (idx !== -1) return idx;
  }
  return undefined;
}

export function detectColumns(header: string[]): ColumnMapping | null {
  const h = header.map((x) => x.trim().toLowerCase());
  const date = findColumn(h, [/^(transaction|trans\.?) date$/, /^date$/, /^posted date$/, /^post(ing)? date$/, /date/]);
  const description = findColumn(h, [/^description$/, /^payee$/, /^merchant$/, /^name$/, /description/, /payee|merchant/, /^memo$/, /details|narrative/]);
  const amount = findColumn(h, [/^amount$/, /^transaction amount$/, /amount/], [date ?? -1]);
  const debit = findColumn(h, [/^debit$/, /debit|withdrawal|money out|paid out/]);
  const credit = findColumn(h, [/^credit$/, /credit|deposit|money in|paid in/]);
  const type = findColumn(h, [/^type$/, /^transaction type$/, /dr\/cr|credit debit indicator/]);

  if (date === undefined || description === undefined) return null;
  if (amount !== undefined) return { date, description, amount, type };
  if (debit !== undefined || credit !== undefined) return { date, description, debit, credit };
  return null;
}

/** Parses "$1,234.56", "-12.00", "(12.00)", "12.00 CR" into integer cents. */
export function parseAmountCents(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/\bDR$/i.test(s)) {
    sign = -1;
    s = s.replace(/\s*DR$/i, "");
  }
  s = s.replace(/\s*CR$/i, "");
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  return sign * Math.round(parseFloat(s) * 100);
}

/** Parses common US date formats into YYYY-MM-DD. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
  if (m) {
    let year = +m[3];
    if (year < 100) year += 2000;
    return ymd(year, +m[1], +m[2]);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface ImportedRow {
  date: string;
  description: string;
  amountCents: number;
}

export interface ImportResult {
  rows: ImportedRow[];
  errors: string[];
  mapping: ColumnMapping | null;
}

export interface ImportOptions {
  /** Credit card exports often show purchases as positive numbers. */
  flipSigns?: boolean;
}

export function rowsFromCsv(text: string, options: ImportOptions = {}): ImportResult {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], errors: ["The file is empty."], mapping: null };

  // Some banks put a few lines of account info above the header.
  let headerIdx = -1;
  let mapping: ColumnMapping | null = null;
  for (let i = 0; i < Math.min(table.length, 10); i++) {
    mapping = detectColumns(table[i]);
    if (mapping) {
      headerIdx = i;
      break;
    }
  }
  if (!mapping) {
    return {
      rows: [],
      errors: ["Could not find date, description, and amount columns. The first row should be a header such as: Date, Description, Amount."],
      mapping: null,
    };
  }

  const rows: ImportedRow[] = [];
  const errors: string[] = [];
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    const lineNo = i + 1;
    const date = parseDate(r[mapping.date] ?? "");
    const description = (r[mapping.description] ?? "").trim();
    let amount: number | null = null;

    if (mapping.amount !== undefined) {
      amount = parseAmountCents(r[mapping.amount] ?? "");
      if (amount !== null && mapping.type !== undefined) {
        const type = (r[mapping.type] ?? "").trim().toLowerCase();
        if (/^(debit|dr|withdrawal|sale|purchase)$/.test(type)) amount = -Math.abs(amount);
        else if (/^(credit|cr|deposit)$/.test(type)) amount = Math.abs(amount);
      }
    } else {
      const debit = mapping.debit !== undefined ? parseAmountCents(r[mapping.debit] ?? "") : null;
      const credit = mapping.credit !== undefined ? parseAmountCents(r[mapping.credit] ?? "") : null;
      if (debit !== null && debit !== 0) amount = -Math.abs(debit);
      else if (credit !== null) amount = Math.abs(credit);
      else if (debit === 0) amount = 0;
    }

    if (!date || !description || amount === null) {
      errors.push(`Row ${lineNo}: skipped (could not read ${!date ? "date" : !description ? "description" : "amount"}).`);
      continue;
    }
    rows.push({ date, description, amountCents: options.flipSigns ? -amount : amount });
  }
  return { rows, errors, mapping };
}
