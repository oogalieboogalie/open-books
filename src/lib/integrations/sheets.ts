import type { Books } from "../books";
import { getCategory } from "../categories";
import { detectColumns, parseCsv, rowsFromTable, type ColumnMapping, type ImportedRow } from "../csv";
import { buildScheduleC, scheduleCCsv } from "../reports";
import type { FetchLike, GoogleClient } from "./google";

/**
 * Google Sheets in both directions:
 * - Import: read transactions from a sheet the owner already keeps, with the
 *   same column detection as CSV import. Re-syncing only adds new rows.
 * - Export: keep a sheet of the books (transactions, monthly totals, and a
 *   Schedule C summary per year) up to date for an accountant or partner.
 *
 * A sheet can be read through the connected Google account, or, with no
 * Google setup at all, through a "anyone with the link can view" share link.
 */

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export interface SheetImportConfig {
  spreadsheetId: string;
  /** The tab's id from the URL (#gid=...). Null means the first tab. */
  gid: number | null;
  /** The tab's title, used for API reads. */
  sheetTitle: string;
  accountId: number;
  flipSigns: boolean;
  /** "google" reads through the connected account; "link" reads a public share link. */
  mode: "google" | "link";
  url: string;
}

export interface SheetExportConfig {
  spreadsheetId: string;
  url: string;
}

export interface SheetTab {
  title: string;
  gid: number;
}

export function parseSheetUrl(input: string): { spreadsheetId: string; gid: number | null } | null {
  const s = input.trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/) ?? s.match(/^([a-zA-Z0-9-_]{30,})$/);
  if (!m) return null;
  const gid = s.match(/[#&?]gid=(\d+)/);
  return { spreadsheetId: m[1], gid: gid ? Number(gid[1]) : null };
}

export function sheetUrl(spreadsheetId: string, gid?: number | null): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit${gid != null ? `#gid=${gid}` : ""}`;
}

export async function spreadsheetInfo(client: GoogleClient, spreadsheetId: string): Promise<{ title: string; tabs: SheetTab[] }> {
  const meta = await client.json<{ properties: { title: string }; sheets: { properties: { title: string; sheetId: number } }[] }>(
    `${SHEETS_API}/${spreadsheetId}?fields=properties.title,sheets.properties(title,sheetId)`,
  );
  return { title: meta.properties.title, tabs: meta.sheets.map((s) => ({ title: s.properties.title, gid: s.properties.sheetId })) };
}

const a1Tab = (title: string) => `'${title.replace(/'/g, "''")}'`;

/** Reads every cell of one tab as text, the way it looks in the sheet. */
export async function readSheet(config: Pick<SheetImportConfig, "spreadsheetId" | "gid" | "sheetTitle" | "mode">, client: GoogleClient | null, fetchImpl: FetchLike = fetch): Promise<string[][]> {
  if (config.mode === "link") {
    const url = `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/export?format=csv${config.gid != null ? `&gid=${config.gid}` : ""}`;
    const res = await fetchImpl(url, { redirect: "follow" });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/csv|text\/plain/.test(type)) {
      throw new Error("Could not read that sheet from its link. In Google Sheets, choose Share, then General access: Anyone with the link (Viewer). Or connect your Google account.");
    }
    return parseCsv(await res.text());
  }
  if (!client) throw new Error("Connect your Google account to read this sheet.");
  let title = config.sheetTitle;
  if (!title) {
    const info = await spreadsheetInfo(client, config.spreadsheetId);
    title = (info.tabs.find((t) => t.gid === config.gid) ?? info.tabs[0])?.title ?? "";
  }
  const res = await client.json<{ values?: string[][] }>(
    `${SHEETS_API}/${config.spreadsheetId}/values/${encodeURIComponent(a1Tab(title))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
  );
  return res.values ?? [];
}

export interface SheetPreview {
  header: string[];
  mapping: ColumnMapping | null;
  rows: ImportedRow[];
  total: number;
  errors: string[];
}

/** What an import would read, so the owner can check the columns before connecting. */
export function previewTable(table: string[][], flipSigns: boolean): SheetPreview {
  const result = rowsFromTable(table, { flipSigns });
  const headerIdx = result.mapping ? table.slice(0, 10).findIndex((r) => detectColumns(r.map(String)) !== null) : -1;
  return {
    header: headerIdx >= 0 ? table[headerIdx].map(String) : [],
    mapping: result.mapping,
    rows: result.rows.slice(-5).reverse(),
    total: result.rows.length,
    errors: result.errors.slice(0, 5),
  };
}

export async function syncSheetImport(books: Books, sourceId: number, config: SheetImportConfig, client: GoogleClient | null, fetchImpl: FetchLike = fetch): Promise<string> {
  const table = await readSheet(config, client, fetchImpl);
  const { rows, errors, mapping } = rowsFromTable(table, { flipSigns: config.flipSigns });
  if (!mapping) throw new Error(errors[0] ?? "Could not find date, description, and amount columns in the sheet.");
  const r = await books.importRows(config.accountId, rows, { source: `sheet:${sourceId}` });
  const parts = [`${r.imported} new`, `${r.duplicates} already in your books`];
  if (r.needsReview) parts.push(`${r.needsReview} to review`);
  if (errors.length) parts.push(`${errors.length} row${errors.length === 1 ? "" : "s"} skipped`);
  return parts.join(", ");
}

// Export

const EXPORT_TABS = ["Transactions", "Monthly"];

export async function createExportSpreadsheet(client: GoogleClient, title: string): Promise<SheetExportConfig> {
  const created = await client.json<{ spreadsheetId: string; spreadsheetUrl: string }>(SHEETS_API, {
    method: "POST",
    body: JSON.stringify({ properties: { title }, sheets: EXPORT_TABS.map((t) => ({ properties: { title: t, gridProperties: { frozenRowCount: 1 } } })) }),
  });
  return { spreadsheetId: created.spreadsheetId, url: created.spreadsheetUrl };
}

/** The tables written to the export sheet, keyed by tab title. */
export async function exportTables(books: Books): Promise<Map<string, (string | number)[][]>> {
  const { rows } = await books.listTransactions({ limit: 50_000 });
  const accounts = new Map((await books.listAccounts()).map((a) => [a.id, a.name]));
  const tables = new Map<string, (string | number)[][]>();

  const tx: (string | number)[][] = [["Date", "Description", "Amount", "Category", "Tax line", "Account", "Needs review", "Notes", "Receipt"]];
  const months = new Map<string, { income: number; expense: number }>();
  for (const t of rows) {
    const cat = getCategory(t.categoryId);
    tx.push([t.date, t.description, t.amountCents / 100, cat.name, cat.taxLine ?? "", t.accountId ? accounts.get(t.accountId) ?? "" : "", t.needsReview ? "yes" : "", t.notes, t.receiptId ? "yes" : ""]);
    const m = months.get(t.date.slice(0, 7)) ?? { income: 0, expense: 0 };
    if (cat.kind === "income") m.income += t.amountCents;
    else if (cat.kind === "expense" || cat.kind === "cogs") m.expense -= t.amountCents;
    months.set(t.date.slice(0, 7), m);
  }
  tables.set("Transactions", tx);

  const monthly: (string | number)[][] = [["Month", "Income", "Expenses", "Net"]];
  for (const [month, m] of [...months.entries()].sort()) monthly.push([month, m.income / 100, m.expense / 100, (m.income - m.expense) / 100]);
  tables.set("Monthly", monthly);

  for (const year of (await books.years()).slice(0, 3)) {
    const summary = buildScheduleC(await books.categoryTotals(year), year);
    const table = parseCsv(scheduleCCsv(summary)).map((r) => r.map((cell, i) => (i >= 2 && cell !== "" && !Number.isNaN(Number(cell)) ? Number(cell) : cell)));
    tables.set(`Schedule C ${year}`, table);
  }
  return tables;
}

export async function syncSheetExport(books: Books, config: SheetExportConfig, client: GoogleClient): Promise<string> {
  const tables = await exportTables(books);
  const info = await spreadsheetInfo(client, config.spreadsheetId);
  const missing = [...tables.keys()].filter((t) => !info.tabs.some((tab) => tab.title === t));
  if (missing.length) {
    await client.json(`${SHEETS_API}/${config.spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) }),
    });
  }
  const ranges = [...tables.keys()].map(a1Tab);
  await client.json(`${SHEETS_API}/${config.spreadsheetId}/values:batchClear`, { method: "POST", body: JSON.stringify({ ranges }) });
  // RAW keeps a description like "=SUM(...)" as text instead of a formula.
  await client.json(`${SHEETS_API}/${config.spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data: [...tables.entries()].map(([title, values]) => ({ range: `${a1Tab(title)}!A1`, values })) }),
  });
  const txCount = (tables.get("Transactions")?.length ?? 1) - 1;
  return `Wrote ${txCount} transaction${txCount === 1 ? "" : "s"} and ${tables.size - 1} summary tab${tables.size === 2 ? "" : "s"}`;
}
