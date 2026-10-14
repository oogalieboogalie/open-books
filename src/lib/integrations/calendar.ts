import { businessTimeZone, type Db } from "../db";
import { GoogleApiError, type GoogleClient } from "./google";

/**
 * Google Calendar appointments on the timeline. Events are copied into
 * calendar_events and kept current with Google's incremental sync tokens, so
 * edits and cancellations show up on the next sync. Which events count as
 * appointments (only ones with guests, only titles with a keyword) is decided
 * when the timeline is read, so changing a setting applies to past events too.
 */

const CAL_API = "https://www.googleapis.com/calendar/v3";

export interface CalendarConfig {
  calendarId: string;
  /** Count only events that have at least one other guest. */
  onlyWithGuests: boolean;
  /** Count only events whose title contains this text (case-insensitive). Empty counts all. */
  keyword: string;
}

export interface CalendarState {
  syncToken?: string;
}

export interface CalendarListEntry {
  id: string;
  name: string;
  primary: boolean;
  accessRole: string;
}

export interface Appointment {
  id: number;
  date: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  title: string;
  location: string;
  attendees: number;
  url: string;
  calendar: string;
}

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: { self?: boolean; resource?: boolean; responseStatus?: string }[];
  eventType?: string;
}

export async function listCalendars(client: GoogleClient): Promise<CalendarListEntry[]> {
  const res = await client.json<{ items?: { id: string; summary: string; summaryOverride?: string; primary?: boolean; accessRole: string }[] }>(
    `${CAL_API}/users/me/calendarList?minAccessRole=reader&maxResults=250`,
  );
  return (res.items ?? [])
    .map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary, accessRole: c.accessRole }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** The calendar date an instant falls on in the business's timezone. */
export function localDate(instant: string, timeZone = businessTimeZone()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Turns a Google event into a row, or null when it should not be stored (cancelled, or not a real meeting). */
export function eventRow(e: GEvent, timeZone = businessTimeZone()) {
  if (e.status === "cancelled") return null;
  if (e.eventType && !["default", "fromGmail"].includes(e.eventType)) return null; // focus time, out of office, working location
  const allDay = !!e.start?.date && !e.start?.dateTime;
  const date = allDay ? e.start!.date! : e.start?.dateTime ? localDate(e.start.dateTime, timeZone) : null;
  if (!date) return null;
  const others = (e.attendees ?? []).filter((a) => !a.self && !a.resource);
  const self = (e.attendees ?? []).find((a) => a.self);
  return {
    externalId: e.id,
    date,
    startsAt: allDay ? null : e.start!.dateTime!,
    endsAt: allDay ? null : (e.end?.dateTime ?? null),
    allDay,
    title: (e.summary ?? "(no title)").slice(0, 500),
    location: (e.location ?? "").slice(0, 500),
    attendees: others.length,
    declined: self?.responseStatus === "declined",
    url: e.htmlLink ?? "",
  };
}

/** Pulls new and changed events. The first sync covers the past year and everything ahead. */
export async function syncCalendar(
  db: Db,
  businessId: number,
  sourceId: number,
  config: CalendarConfig,
  state: CalendarState,
  client: GoogleClient,
  now = new Date(),
): Promise<{ state: CalendarState; summary: string }> {
  let syncToken = state.syncToken;
  let added = 0;
  let removed = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      do {
        const params = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "250" });
        if (syncToken) params.set("syncToken", syncToken);
        else params.set("timeMin", new Date(now.getTime() - 365 * 86_400_000).toISOString());
        if (pageToken) params.set("pageToken", pageToken);
        const page = await client.json<{ items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
          `${CAL_API}/calendars/${encodeURIComponent(config.calendarId)}/events?${params}`,
        );
        for (const e of page.items ?? []) {
          const row = eventRow(e);
          if (!row) {
            const del = await db.query("DELETE FROM calendar_events WHERE source_id = $1 AND external_id = $2 RETURNING id", [sourceId, e.id]);
            removed += del.length;
            continue;
          }
          await db.query(
            `INSERT INTO calendar_events (business_id, source_id, external_id, date, starts_at, ends_at, all_day, title, location, attendees, declined, url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (source_id, external_id) DO UPDATE SET date = excluded.date, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
               all_day = excluded.all_day, title = excluded.title, location = excluded.location, attendees = excluded.attendees,
               declined = excluded.declined, url = excluded.url`,
            [businessId, sourceId, row.externalId, row.date, row.startsAt, row.endsAt, row.allDay, row.title, row.location, row.attendees, row.declined, row.url],
          );
          added++;
        }
        pageToken = page.nextPageToken;
        nextSyncToken = page.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
      return {
        state: { syncToken: nextSyncToken },
        summary: syncToken ? `${added} new or changed, ${removed} removed` : `${added} event${added === 1 ? "" : "s"} loaded`,
      };
    } catch (err) {
      // Google expires sync tokens now and then; start over with a full sync.
      if (err instanceof GoogleApiError && err.status === 410 && syncToken) {
        await db.query("DELETE FROM calendar_events WHERE source_id = $1", [sourceId]);
        syncToken = undefined;
        added = removed = 0;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Calendar sync did not finish.");
}

/** SQL condition for the events that count as appointments under each calendar's settings. Expects aliases ce and s. */
export const APPOINTMENT_FILTER = `s.enabled AND NOT ce.declined
  AND (COALESCE((s.config->>'onlyWithGuests')::boolean, false) = false OR ce.attendees > 0)
  AND (COALESCE(s.config->>'keyword', '') = '' OR ce.title ILIKE '%' || (s.config->>'keyword') || '%')`;

export function appointmentsBetween(db: Db, businessId: number, from: string, to: string, limit = 200): Promise<Appointment[]> {
  return db.query<Appointment>(
    `SELECT ce.id, ce.date, ce.starts_at AS "startsAt", ce.ends_at AS "endsAt", ce.all_day AS "allDay", ce.title, ce.location, ce.attendees, ce.url, s.name AS calendar
     FROM calendar_events ce JOIN sync_sources s ON s.id = ce.source_id
     WHERE ce.business_id = $1 AND ce.date BETWEEN $2 AND $3 AND ${APPOINTMENT_FILTER}
     ORDER BY ce.date, ce.starts_at NULLS FIRST, ce.id LIMIT $4`,
    [businessId, from, to, limit],
  );
}

export function appointmentCounts(db: Db, businessId: number, from: string, to: string): Promise<{ date: string; count: number }[]> {
  return db.query(
    `SELECT ce.date, COUNT(*)::int AS count FROM calendar_events ce JOIN sync_sources s ON s.id = ce.source_id
     WHERE ce.business_id = $1 AND ce.date BETWEEN $2 AND $3 AND ${APPOINTMENT_FILTER} GROUP BY ce.date`,
    [businessId, from, to],
  );
}
