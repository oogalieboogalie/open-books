import type { Books } from "../books";
import { Receipts } from "../receipts/receipts";
import { syncCalendar, type CalendarConfig, type CalendarState } from "./calendar";
import { GoogleClient, type FetchLike } from "./google";
import { syncGmail, syncImap, type GmailConfig, type GmailState, type ImapConfig, type ImapState } from "./mail";
import { syncSheetExport, syncSheetImport, type SheetExportConfig, type SheetImportConfig } from "./sheets";
import { Integrations, type SyncSource } from "./store";

/**
 * Runs syncs: one source on demand, or everything on a schedule. Imports run
 * first, then receipts are matched against what arrived, and the export sheet
 * is written last so it includes the new rows.
 */

const ORDER: Record<string, number> = { sheet_import: 0, imap: 1, gmail: 1, calendar: 2, sheet_export: 3 };

export interface SyncOutcome {
  id: number;
  name: string;
  ok: boolean;
  message: string;
}

export async function syncSource(books: Books, source: SyncSource, opts: { fetchImpl?: FetchLike } = {}): Promise<SyncOutcome> {
  const integrations = new Integrations(books.db, books.businessId);
  const receipts = Receipts.for(books);
  const google = () => GoogleClient.for(integrations, opts.fetchImpl);
  try {
    let message: string;
    switch (source.kind) {
      case "sheet_import": {
        const cfg = source.config as unknown as SheetImportConfig;
        message = await syncSheetImport(books, source.id, cfg, cfg.mode === "google" ? await google() : null, opts.fetchImpl);
        const matched = await receipts.matchUnmatched();
        if (matched) message += `, ${matched} receipt${matched === 1 ? "" : "s"} matched`;
        break;
      }
      case "sheet_export":
        message = await syncSheetExport(books, source.config as unknown as SheetExportConfig, await google());
        break;
      case "calendar": {
        const r = await syncCalendar(books.db, books.businessId, source.id, source.config as unknown as CalendarConfig, source.state as CalendarState, await google());
        await integrations.saveState(source.id, r.state);
        message = r.summary;
        break;
      }
      case "gmail": {
        const r = await syncGmail(receipts, source.config as unknown as GmailConfig, source.state as GmailState, await google());
        await integrations.saveState(source.id, r.state);
        message = r.summary;
        break;
      }
      case "imap": {
        const password = await integrations.sourceSecret(source.id);
        if (!password) throw new Error("The saved password could not be read. Remove this mailbox and add it again.");
        const r = await syncImap(receipts, source.config as unknown as ImapConfig, password, source.state as ImapState);
        await integrations.saveState(source.id, r.state);
        message = r.summary;
        break;
      }
      default:
        throw new Error(`Unknown source type ${source.kind}`);
    }
    await integrations.recordSync(source.id, { ok: true, summary: message });
    return { id: source.id, name: source.name, ok: true, message };
  } catch (err) {
    const message = (err as Error).message || String(err);
    await integrations.recordSync(source.id, { ok: false, error: message });
    return { id: source.id, name: source.name, ok: false, message };
  }
}

export async function syncAll(books: Books, opts: { fetchImpl?: FetchLike } = {}): Promise<SyncOutcome[]> {
  const sources = (await new Integrations(books.db, books.businessId).listSources()).filter((s) => s.enabled).sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
  const out: SyncOutcome[] = [];
  for (const s of sources) out.push(await syncSource(books, s, opts));
  return out;
}

const running = globalThis as unknown as { __openBooksSyncing?: boolean };

/** Syncs every business, skipping a run if the previous one has not finished. */
export async function syncEverything(): Promise<void> {
  if (running.__openBooksSyncing) return;
  running.__openBooksSyncing = true;
  try {
    const { getDb } = await import("../db");
    const { Books } = await import("../books");
    const db = await getDb();
    const businesses = await db.query<{ id: number }>("SELECT DISTINCT business_id AS id FROM sync_sources WHERE enabled");
    for (const b of businesses) {
      const results = await syncAll(new Books(db, b.id));
      for (const r of results) if (!r.ok) console.warn(`[open-books] sync of "${r.name}" failed: ${r.message}`);
    }
  } finally {
    running.__openBooksSyncing = false;
  }
}
