"use server";

import { revalidatePath } from "next/cache";
import { dollarsToCents } from "@/lib/format";
import { listCalendars, type CalendarConfig } from "@/lib/integrations/calendar";
import { GoogleClient, revokeToken, type GoogleTokens } from "@/lib/integrations/google";
import { DEFAULT_GMAIL_QUERY, testImap, type ImapConfig } from "@/lib/integrations/mail";
import { createExportSpreadsheet, parseSheetUrl, previewTable, readSheet, sheetUrl, spreadsheetInfo, type SheetImportConfig, type SheetPreview, type SheetTab } from "@/lib/integrations/sheets";
import { Integrations } from "@/lib/integrations/store";
import { syncAll, syncSource } from "@/lib/integrations/sync";
import { Receipts } from "@/lib/receipts/receipts";
import { getBooks } from "@/lib/server";

const refresh = () => revalidatePath("/", "layout");
const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export interface ActionState {
  ok?: string;
  error?: string;
}

async function ctx() {
  const books = await getBooks();
  return { books, integrations: new Integrations(books.db, books.businessId) };
}

// Google account

export async function disconnectGoogleAction() {
  const { integrations } = await ctx();
  const tokens = await integrations.credentials<GoogleTokens>("google");
  if (tokens?.refreshToken) await revokeToken(tokens.refreshToken);
  await integrations.disconnect("google");
  refresh();
}

// Sync controls

export async function syncSourceAction(form: FormData) {
  const { books, integrations } = await ctx();
  const source = await integrations.getSource(Number(form.get("id")));
  if (source) await syncSource(books, source);
  refresh();
}

export async function syncAllAction(_prev: ActionState): Promise<ActionState> {
  const { books } = await ctx();
  const results = await syncAll(books);
  refresh();
  if (results.length === 0) return { ok: "Nothing connected yet." };
  const failed = results.filter((r) => !r.ok);
  return failed.length ? { error: `${failed.length} of ${results.length} could not sync: ${failed.map((f) => `${f.name} (${f.message})`).join("; ")}` } : { ok: `Synced ${results.length} source${results.length === 1 ? "" : "s"}.` };
}

export async function toggleSourceAction(form: FormData) {
  const { integrations } = await ctx();
  await integrations.setEnabled(Number(form.get("id")), form.get("enabled") === "1");
  refresh();
}

export async function removeSourceAction(form: FormData) {
  const { integrations } = await ctx();
  await integrations.removeSource(Number(form.get("id")));
  refresh();
}

// Google Sheets

export interface SheetCheckState extends ActionState {
  url?: string;
  title?: string;
  tabs?: SheetTab[];
  gid?: number | null;
  mode?: "google" | "link";
  preview?: SheetPreview;
  added?: boolean;
  accountId?: number;
  flipSigns?: boolean;
  seq?: number;
}

/** Reads the sheet and shows what would be imported. With confirm=1, connects it and runs the first import. */
export async function sheetImportAction(prev: SheetCheckState, form: FormData): Promise<SheetCheckState> {
  const state = await checkOrAddSheet(form);
  return { ...state, seq: (prev.seq ?? 0) + 1, accountId: Number(str(form, "accountId")) || undefined, flipSigns: form.get("flipSigns") === "on" };
}

async function checkOrAddSheet(form: FormData): Promise<SheetCheckState> {
  const url = str(form, "url");
  const parsed = parseSheetUrl(url);
  if (!parsed) return { error: "Paste the link to a Google Sheet (it looks like docs.google.com/spreadsheets/d/…).", url };
  const { books, integrations } = await ctx();
  const conn = await integrations.connection("google");
  const mode: "google" | "link" = conn && conn.status === "ok" && conn.scopes.includes("https://www.googleapis.com/auth/spreadsheets") ? "google" : "link";
  const flipSigns = form.get("flipSigns") === "on";
  const accountId = Number(str(form, "accountId"));
  const gidField = str(form, "gid");
  const gid = gidField !== "" ? Number(gidField) : parsed.gid;
  try {
    const client = mode === "google" ? await GoogleClient.for(integrations) : null;
    let title = "";
    let tabs: SheetTab[] = [];
    if (client) ({ title, tabs } = await spreadsheetInfo(client, parsed.spreadsheetId));
    const tab = tabs.find((t) => t.gid === gid) ?? tabs[0];
    const config: SheetImportConfig = {
      spreadsheetId: parsed.spreadsheetId,
      gid: tab?.gid ?? gid,
      sheetTitle: tab?.title ?? "",
      accountId,
      flipSigns,
      mode,
      url: sheetUrl(parsed.spreadsheetId, tab?.gid ?? gid),
    };
    const preview = previewTable(await readSheet(config, client), flipSigns);
    const base = { url, title, tabs, gid: config.gid, mode, preview };
    if (!preview.mapping) return { ...base, error: preview.errors[0] ?? "Could not find date, description, and amount columns." };
    if (form.get("confirm") !== "1") return base;
    if (!(await books.listAccounts()).some((a) => a.id === accountId)) return { ...base, error: "Choose an account." };
    const name = [title || "Google Sheet", tab?.title].filter(Boolean).join(" · ");
    const id = await integrations.addSource({ kind: "sheet_import", name, config });
    const result = await syncSource(books, (await integrations.getSource(id))!);
    refresh();
    return result.ok ? { ok: `Connected. ${result.message}.`, added: true } : { ...base, error: result.message };
  } catch (err) {
    return { url, mode, error: (err as Error).message };
  }
}

export async function createExportSheetAction(_prev: ActionState): Promise<ActionState> {
  const { books, integrations } = await ctx();
  try {
    const client = await GoogleClient.for(integrations);
    const config = await createExportSpreadsheet(client, `Open Books · ${new Date().getFullYear()}`);
    const id = await integrations.addSource({ kind: "sheet_export", name: "Books export", config });
    const result = await syncSource(books, (await integrations.getSource(id))!);
    refresh();
    return result.ok ? { ok: "Created your sheet. It updates on every sync." } : { error: result.message };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// Google Calendar

export async function addCalendarAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const { books, integrations } = await ctx();
  const calendarId = str(form, "calendarId");
  if (!calendarId) return { error: "Choose a calendar." };
  try {
    const calendars = await listCalendars(await GoogleClient.for(integrations));
    const cal = calendars.find((c) => c.id === calendarId);
    if (!cal) return { error: "That calendar was not found." };
    if ((await integrations.listSources<CalendarConfig>("calendar")).some((s) => s.config.calendarId === calendarId)) return { error: `${cal.name} is already connected.` };
    const config: CalendarConfig = { calendarId, onlyWithGuests: form.get("onlyWithGuests") === "on", keyword: str(form, "keyword").slice(0, 60) };
    const id = await integrations.addSource({ kind: "calendar", name: cal.name, config });
    const result = await syncSource(books, (await integrations.getSource(id))!);
    refresh();
    return result.ok ? { ok: `Connected ${cal.name}: ${result.message}.` } : { error: result.message };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function updateCalendarAction(form: FormData) {
  const { integrations } = await ctx();
  const source = await integrations.getSource<CalendarConfig>(Number(form.get("id")));
  if (!source || source.kind !== "calendar") return;
  await integrations.updateSourceConfig(source.id, { ...source.config, onlyWithGuests: form.get("onlyWithGuests") === "on", keyword: str(form, "keyword").slice(0, 60) });
  refresh();
}

// Mailboxes

export async function addGmailAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const { books, integrations } = await ctx();
  const query = str(form, "query") || DEFAULT_GMAIL_QUERY;
  const existing = (await integrations.listSources("gmail"))[0];
  if (existing) {
    await integrations.updateSourceConfig(existing.id, { query });
    refresh();
    return { ok: "Search updated." };
  }
  const id = await integrations.addSource({ kind: "gmail", name: "Gmail", config: { query } });
  const result = await syncSource(books, (await integrations.getSource(id))!);
  refresh();
  return result.ok ? { ok: result.message } : { error: result.message };
}

export async function addImapAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const { books, integrations } = await ctx();
  const security = str(form, "security") || "tls";
  const config: ImapConfig = {
    host: str(form, "host").toLowerCase(),
    port: Number(str(form, "port")) || (security === "tls" ? 993 : 143),
    secure: security === "tls",
    user: str(form, "user"),
    folder: str(form, "folder") || "INBOX",
  };
  const password = String(form.get("password") ?? "");
  if (!/^[a-z0-9.-]+$/.test(config.host)) return { error: "Enter the mail server, like imap.fastmail.com." };
  if (!config.user || !password) return { error: "Enter the username and an app password." };
  try {
    await testImap(config, password);
  } catch (err) {
    return { error: `Could not sign in: ${(err as Error).message}` };
  }
  const id = await integrations.addSource({ kind: "imap", name: `${config.user} · ${config.folder}`, config, secret: password });
  const result = await syncSource(books, (await integrations.getSource(id))!);
  refresh();
  return result.ok ? { ok: `Connected. ${result.message}.` } : { error: result.message };
}

export async function rotateInboundAction() {
  const { integrations } = await ctx();
  await integrations.rotateInboundToken();
  refresh();
}

// Receipts

export async function uploadReceiptAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const { books } = await ctx();
  const file = form.get("file");
  const hasFile = file instanceof File && file.size > 0;
  if (hasFile && file.size > 10 * 1024 * 1024) return { error: "That file is over 10 MB." };
  if (hasFile && !/^(application\/pdf|image\/)/.test(file.type)) return { error: "Upload a PDF or a photo." };
  const vendor = str(form, "vendor");
  const amount = str(form, "amount");
  const cents = amount ? dollarsToCents(amount) : null;
  if (amount && cents === null) return { error: "Enter the amount like 42.50." };
  const date = str(form, "date") || null;
  if (!hasFile && !vendor) return { error: "Add a file or at least who you paid." };
  const added = await Receipts.for(books).add({
    source: "upload",
    vendor: vendor || (hasFile ? file.name.replace(/\.[a-z0-9]+$/i, "") : ""),
    date,
    amountCents: cents === null ? null : Math.abs(cents),
    files: hasFile ? [{ filename: file.name, contentType: file.type, data: new Uint8Array(await file.arrayBuffer()) }] : [],
  });
  refresh();
  return { ok: added?.matched ? "Saved and matched to a transaction." : "Saved." };
}

export async function updateReceiptAction(form: FormData) {
  const { books } = await ctx();
  const amount = str(form, "amount");
  const cents = amount ? dollarsToCents(amount) : null;
  await Receipts.for(books).update(Number(form.get("id")), {
    vendor: str(form, "vendor"),
    amountCents: cents === null ? undefined : Math.abs(cents),
    date: str(form, "date") || null,
  });
  refresh();
}

export async function linkReceiptAction(form: FormData) {
  const { books } = await ctx();
  await Receipts.for(books).link(Number(form.get("id")), Number(form.get("transactionId")));
  refresh();
}

export async function unlinkReceiptAction(form: FormData) {
  const { books } = await ctx();
  await Receipts.for(books).unlink(Number(form.get("id")));
  refresh();
}

export async function ignoreReceiptAction(form: FormData) {
  const { books } = await ctx();
  await Receipts.for(books).setIgnored(Number(form.get("id")), form.get("ignored") === "1");
  refresh();
}

export async function deleteReceiptAction(form: FormData) {
  const { books } = await ctx();
  await Receipts.for(books).delete(Number(form.get("id")));
  refresh();
}

export async function receiptToTransactionAction(form: FormData) {
  const { books } = await ctx();
  await Receipts.for(books).createTransaction(Number(form.get("id")), books, Number(form.get("accountId")) || null);
  refresh();
}
