import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Activity } from "@/lib/activity";
import { Books } from "@/lib/books";
import { eventRow, listCalendars, localDate } from "@/lib/integrations/calendar";
import { authorizationUrl, exchangeCode, GoogleClient, hasFeature, type FetchLike, type GoogleTokens } from "@/lib/integrations/google";
import { DEFAULT_GMAIL_QUERY } from "@/lib/integrations/mail";
import { exportTables, parseSheetUrl, previewTable } from "@/lib/integrations/sheets";
import { Integrations } from "@/lib/integrations/store";
import { syncAll, syncSource } from "@/lib/integrations/sync";
import { Receipts } from "@/lib/receipts/receipts";
import { decrypt, encrypt, resetSecretKey } from "@/lib/secrets";
import { freshBooks } from "./helpers";

beforeAll(() => {
  process.env.APP_SECRET = "test-secret";
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.BUSINESS_TZ = "America/Chicago";
  resetSecretKey();
});

type Handler = (url: URL, init: RequestInit) => unknown | Response;

/** A stand-in for Google's APIs: routes requests to handlers by path, and records them. */
function fakeGoogle(routes: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fetchImpl: FetchLike = async (raw, init = {}) => {
    const url = new URL(raw);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, body });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && (url.origin + url.pathname).includes(p);
    });
    if (!key) return new Response(JSON.stringify({ error: { message: `no route for ${method} ${url}` } }), { status: 404 });
    const out = await routes[key](url, init);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

async function connectGoogle(books: Books, scopes: string[], tokens: Partial<GoogleTokens> = {}) {
  await new Integrations(books.db, books.businessId).saveConnection("google", {
    account: "owner@example.com",
    scopes,
    credentials: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000, ...tokens },
  });
}

const SHEETS = "https://www.googleapis.com/auth/spreadsheets";
const CAL = "https://www.googleapis.com/auth/calendar.readonly";

describe("secrets", () => {
  it("round-trips and rejects values sealed with another key", () => {
    const sealed = encrypt("refresh-token");
    expect(sealed).not.toContain("refresh-token");
    expect(decrypt(sealed)).toBe("refresh-token");
    process.env.APP_SECRET = "other";
    resetSecretKey();
    expect(decrypt(sealed)).toBeNull();
    process.env.APP_SECRET = "test-secret";
    resetSecretKey();
  });
});

describe("Google sign-in", () => {
  it("asks only for the scopes of the features being connected", () => {
    const url = new URL(authorizationUrl({ clientId: "id", clientSecret: "s" }, { features: ["calendar"], state: "st", redirectUri: "http://localhost:3000/integrations/google/callback" }));
    expect(url.searchParams.get("scope")).toBe(`openid email ${CAL}`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });

  it("reads the account and scopes from the token response", async () => {
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "owner@example.com" })).toString("base64url")}.y`;
    const { fetchImpl } = fakeGoogle({ "POST oauth2.googleapis.com/token": () => ({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: `openid ${SHEETS}`, id_token: idToken }) });
    const r = await exchangeCode({ clientId: "id", clientSecret: "s" }, "code", "http://x/cb", fetchImpl);
    expect(r.email).toBe("owner@example.com");
    expect(hasFeature(r.scopes, "sheets")).toBe(true);
    expect(hasFeature(r.scopes, "calendar")).toBe(false);
  });

  it("refreshes an expired token and stores the new one", async () => {
    const books = await freshBooks();
    await connectGoogle(books, [SHEETS], { expiresAt: Date.now() - 1000 });
    const { fetchImpl, calls } = fakeGoogle({
      "POST oauth2.googleapis.com/token": () => ({ access_token: "at-2", expires_in: 3600 }),
      "GET /calendar/v3/users/me/calendarList": (_u, init) => {
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer at-2");
        return { items: [{ id: "b", summary: "Bookings", accessRole: "owner" }, { id: "p", summary: "Me", primary: true, accessRole: "owner" }] };
      },
    });
    const client = await GoogleClient.for(new Integrations(books.db, books.businessId), fetchImpl);
    expect((await listCalendars(client)).map((c) => c.id)).toEqual(["p", "b"]);
    expect(calls[0].body).toContain("grant_type=refresh_token");
    const saved = await new Integrations(books.db, books.businessId).credentials<GoogleTokens>("google");
    expect(saved).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
  });

  it("marks the connection for sign-in again when the grant is revoked", async () => {
    const books = await freshBooks();
    await connectGoogle(books, [SHEETS], { expiresAt: 0 });
    const { fetchImpl } = fakeGoogle({ "POST oauth2.googleapis.com/token": () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) });
    const integrations = new Integrations(books.db, books.businessId);
    const client = await GoogleClient.for(integrations, fetchImpl);
    await expect(client.json("https://www.googleapis.com/calendar/v3/users/me/calendarList")).rejects.toThrow(/Reconnect/);
    expect((await integrations.connection("google"))!.status).toBe("reauth");
  });
});

describe("Google Sheets", () => {
  let books: Books;
  let checking: number;
  let integrations: Integrations;
  beforeEach(async () => {
    books = await freshBooks();
    checking = (await books.listAccounts())[0].id;
    integrations = new Integrations(books.db, books.businessId);
  });

  it("reads sheet links", () => {
    expect(parseSheetUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=42")).toEqual({ spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", gid: 42 });
    expect(parseSheetUrl("https://example.com/nope")).toBeNull();
  });

  it("previews the detected columns", () => {
    const p = previewTable([["My books"], ["Date", "Memo", "Amount"], ["10/1/2026", "Client payment", "$1,200.00"], ["10/2/2026", "Canva", "-12.99"]], false);
    expect(p.header).toEqual(["Date", "Memo", "Amount"]);
    expect(p.total).toBe(2);
    expect(p.rows[0]).toEqual({ date: "2026-10-02", description: "Canva", amountCents: -1299 });
  });

  it("imports through the Google account and only adds new rows on re-sync", async () => {
    await connectGoogle(books, [SHEETS]);
    const values = [["Date", "Description", "Debit", "Credit"], ["2026-10-01", "ADOBE CREATIVE CLOUD", "59.99", ""], ["2026-10-02", "Client invoice 1001", "", "800"]];
    const { fetchImpl, calls } = fakeGoogle({ "GET /v4/spreadsheets/SHEET123/values/": () => ({ values }) });
    const id = await integrations.addSource({ kind: "sheet_import", name: "My ledger", config: { spreadsheetId: "SHEET123", gid: 0, sheetTitle: "Ledger 2026", accountId: checking, flipSigns: false, mode: "google", url: "" } });
    const first = await syncSource(books, (await integrations.getSource(id))!, { fetchImpl });
    expect(first).toMatchObject({ ok: true, message: "2 new, 0 already in your books" });
    expect(decodeURIComponent(calls[0].url.pathname)).toContain("/values/'Ledger 2026'");

    values.push(["2026-10-03", "STAPLES 123", "20.00", ""]);
    const second = await syncSource(books, (await integrations.getSource(id))!, { fetchImpl });
    expect(second.message).toBe("1 new, 2 already in your books");
    const { rows } = await books.listTransactions({});
    expect(rows.map((r) => r.categoryId).sort()).toEqual(["gross_receipts", "office_expense", "software"]);
    expect((await integrations.getSource(id))!.lastResult).toBe("1 new, 2 already in your books");
  });

  it("imports from a public share link without a Google account", async () => {
    const { fetchImpl, calls } = fakeGoogle({
      "GET docs.google.com/spreadsheets/d/PUB/export": () => new Response("Date,Description,Amount\n2026-10-05,SHELL OIL,-40.00\n", { headers: { "content-type": "text/csv" } }),
    });
    const id = await integrations.addSource({ kind: "sheet_import", name: "Shared", config: { spreadsheetId: "PUB", gid: 7, sheetTitle: "", accountId: checking, flipSigns: false, mode: "link", url: "" } });
    expect((await syncSource(books, (await integrations.getSource(id))!, { fetchImpl })).ok).toBe(true);
    expect(calls[0].url.searchParams.get("gid")).toBe("7");
  });

  it("explains how to share a private sheet", async () => {
    const { fetchImpl } = fakeGoogle({ "GET docs.google.com/spreadsheets/d/PRIV/export": () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }) });
    const id = await integrations.addSource({ kind: "sheet_import", name: "Private", config: { spreadsheetId: "PRIV", gid: null, sheetTitle: "", accountId: checking, flipSigns: false, mode: "link", url: "" } });
    const r = await syncSource(books, (await integrations.getSource(id))!, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Anyone with the link/);
    expect((await integrations.getSource(id))!.lastError).toMatch(/Anyone with the link/);
  });

  it("writes the books to an export sheet as raw values", async () => {
    await connectGoogle(books, [SHEETS]);
    await books.importRows(checking, [
      { date: "2026-09-10", description: "=HYPERLINK(\"evil\")", amountCents: -500 },
      { date: "2026-10-01", description: "STRIPE TRANSFER", amountCents: 100000 },
    ]);
    const tables = await exportTables(books);
    expect([...tables.keys()]).toEqual(["Transactions", "Monthly", "Schedule C 2026"]);
    expect(tables.get("Monthly")).toEqual([["Month", "Income", "Expenses", "Net"], ["2026-09", 0, 0, 0], ["2026-10", 1000, 0, 1000]]);

    const { fetchImpl, calls } = fakeGoogle({
      "GET /v4/spreadsheets/OUT": () => ({ properties: { title: "Books" }, sheets: [{ properties: { title: "Transactions", sheetId: 0 } }] }),
      "POST /v4/spreadsheets/OUT:batchUpdate": () => ({}),
      "POST /v4/spreadsheets/OUT/values:batchClear": () => ({}),
      "POST /v4/spreadsheets/OUT/values:batchUpdate": () => ({}),
    });
    const id = await integrations.addSource({ kind: "sheet_export", name: "Books for my accountant", config: { spreadsheetId: "OUT", url: "" } });
    const r = await syncSource(books, (await integrations.getSource(id))!, { fetchImpl });
    expect(r).toMatchObject({ ok: true, message: "Wrote 2 transactions and 2 summary tabs" });
    const addTabs = calls.find((c) => c.url.pathname.endsWith(":batchUpdate"))!.body as { requests: { addSheet: { properties: { title: string } } }[] };
    expect(addTabs.requests.map((r) => r.addSheet.properties.title)).toEqual(["Monthly", "Schedule C 2026"]);
    const write = calls.find((c) => c.url.pathname.endsWith("values:batchUpdate"))!.body as { valueInputOption: string };
    expect(write.valueInputOption).toBe("RAW");
  });
});

describe("Google Calendar", () => {
  it("turns Google events into appointment rows", () => {
    expect(eventRow({ id: "1", status: "cancelled" })).toBeNull();
    expect(eventRow({ id: "2", eventType: "outOfOffice", start: { date: "2026-10-01" } })).toBeNull();
    expect(eventRow({ id: "3", summary: "Offsite", start: { date: "2026-10-01" }, end: { date: "2026-10-02" } })).toMatchObject({ allDay: true, date: "2026-10-01", attendees: 0 });
    // 1am UTC on Oct 2 is still Oct 1 in Chicago.
    const timed = eventRow({ id: "4", summary: "Consult", start: { dateTime: "2026-10-02T01:00:00Z" }, attendees: [{ self: true, responseStatus: "declined" }, {}, { resource: true }] }, "America/Chicago");
    expect(timed).toMatchObject({ date: "2026-10-01", attendees: 1, declined: true });
    expect(localDate("2026-10-02T01:00:00Z", "UTC")).toBe("2026-10-02");
  });

  it("syncs events, follows changes and cancellations, and counts appointments on the timeline", async () => {
    const books = await freshBooks();
    await connectGoogle(books, [CAL]);
    const integrations = new Integrations(books.db, books.businessId);
    let round = 0;
    const { fetchImpl, calls } = fakeGoogle({
      "GET /calendar/v3/calendars/": (url) => {
        round++;
        if (round === 1) {
          expect(url.searchParams.get("timeMin")).toBeTruthy();
          return {
            items: [
              { id: "a", summary: "Haircut - Sam", start: { dateTime: "2026-10-01T15:00:00Z" }, attendees: [{ self: true }, { email: "sam@x.com" }] },
              { id: "b", summary: "Dentist", start: { dateTime: "2026-10-01T18:00:00Z" } },
            ],
            nextPageToken: "p2",
          };
        }
        if (round === 2) return { items: [{ id: "c", summary: "Haircut - Lee", start: { dateTime: "2026-10-03T15:00:00Z" }, attendees: [{ email: "lee@x.com" }] }], nextSyncToken: "s1" };
        if (round === 3) {
          expect(url.searchParams.get("syncToken")).toBe("s1");
          return new Response(JSON.stringify({ error: { message: "Sync token is no longer valid" } }), { status: 410 });
        }
        return {
          items: [
            { id: "a", summary: "Haircut - Sam", start: { dateTime: "2026-10-01T15:00:00Z" }, attendees: [{ email: "sam@x.com" }] },
            { id: "b", summary: "Dentist", start: { dateTime: "2026-10-01T18:00:00Z" } },
            { id: "c", status: "cancelled" },
          ],
          nextSyncToken: "s2",
        };
      },
    });
    const id = await integrations.addSource({ kind: "calendar", name: "Bookings", config: { calendarId: "bookings@group.calendar.google.com", onlyWithGuests: true, keyword: "" } });
    expect(await syncSource(books, (await integrations.getSource(id))!, { fetchImpl })).toMatchObject({ ok: true, message: "3 events loaded" });
    expect(calls[0].url.pathname).toContain(encodeURIComponent("bookings@group.calendar.google.com"));

    const activity = Activity.for(books);
    let tl = await activity.timeline("2026-10-01", "2026-10-03", "day");
    expect(tl.series.find((s) => s.key === "booked_appointments")?.values).toEqual([1, 0, 1]);

    // The sync token expired: start over, and the cancelled event disappears.
    expect(await syncSource(books, (await integrations.getSource(id))!, { fetchImpl })).toMatchObject({ ok: true });
    tl = await activity.timeline("2026-10-01", "2026-10-03", "day");
    expect(tl.series.find((s) => s.key === "booked_appointments")?.values).toEqual([1, 0, 0]);
    expect((await integrations.getSource(id))!.state).toEqual({ syncToken: "s2" });

    // Counting every event, not just ones with guests, picks up the dentist.
    await integrations.updateSourceConfig(id, { calendarId: "x", onlyWithGuests: false, keyword: "" });
    const detail = await activity.periodDetail("2026-10-01", "2026-10-01", books);
    expect(detail.appointments.map((a) => a.title)).toEqual(["Haircut - Sam", "Dentist"]);
    await integrations.updateSourceConfig(id, { calendarId: "x", onlyWithGuests: false, keyword: "haircut" });
    expect((await activity.periodDetail("2026-10-01", "2026-10-01", books)).appointments).toHaveLength(1);
  });
});

describe("Gmail receipts", () => {
  it("pulls matching messages once and skips non-receipts", async () => {
    const books = await freshBooks();
    await connectGoogle(books, ["https://www.googleapis.com/auth/gmail.readonly"]);
    const integrations = new Integrations(books.db, books.businessId);
    const raw = (subject: string, body: string) =>
      Buffer.from([`From: Shop <orders@shop.com>`, `Subject: ${subject}`, "Date: Wed, 01 Oct 2026 15:00:00 +0000", "", body].join("\r\n")).toString("base64url");
    const { fetchImpl } = fakeGoogle({
      "GET /gmail/v1/users/me/messages/m1": () => ({ raw: raw("Your Shop order", "Order total: $25.00") }),
      "GET /gmail/v1/users/me/messages/m2": () => ({ raw: raw("Your Shop order shipped", "On its way!") }),
      "GET /gmail/v1/users/me/messages": (url) => {
        expect(url.searchParams.get("q")).toContain(DEFAULT_GMAIL_QUERY);
        return { messages: [{ id: "m2" }, { id: "m1" }] };
      },
    });
    const id = await integrations.addSource({ kind: "gmail", name: "Gmail", config: { query: DEFAULT_GMAIL_QUERY } });
    expect((await syncSource(books, (await integrations.getSource(id))!, { fetchImpl })).message).toBe("1 receipt added, 0 matched to transactions, 1 other emails skipped");
    expect((await Receipts.for(books).list()).rows.map((r) => [r.vendor, r.amountCents])).toEqual([["Shop", 2500]]);
    const again = await syncSource(books, (await integrations.getSource(id))!, { fetchImpl });
    expect(again.message).toMatch(/^0 receipts added/);
    expect((await integrations.getSource(id))!.state).toHaveProperty("lastSyncAt");
  });
});

describe("sync runner", () => {
  it("keeps going when one source fails, and skips paused ones", async () => {
    const books = await freshBooks();
    const integrations = new Integrations(books.db, books.businessId);
    const checking = (await books.listAccounts())[0].id;
    const { fetchImpl } = fakeGoogle({ "GET docs.google.com/spreadsheets/d/OK/export": () => new Response("Date,Description,Amount\n2026-10-05,X,-1\n", { headers: { "content-type": "text/csv" } }) });
    await integrations.addSource({ kind: "calendar", name: "No Google", config: { calendarId: "c", onlyWithGuests: false, keyword: "" } });
    const paused = await integrations.addSource({ kind: "sheet_import", name: "Paused", config: { spreadsheetId: "NOPE", gid: null, sheetTitle: "", accountId: checking, flipSigns: false, mode: "link", url: "" } });
    await integrations.setEnabled(paused, false);
    await integrations.addSource({ kind: "sheet_import", name: "Sheet", config: { spreadsheetId: "OK", gid: null, sheetTitle: "", accountId: checking, flipSigns: false, mode: "link", url: "" } });
    const results = await syncAll(books, { fetchImpl });
    expect(results.map((r) => [r.name, r.ok])).toEqual([["Sheet", true], ["No Google", false]]);
    expect(results[1].message).toMatch(/Connect your Google account/);
  });

  it("gives each business its own stable forwarding token", async () => {
    const a = new Integrations((await freshBooks()).db, (await freshBooks()).businessId);
    const token = await a.inboundToken();
    expect(token).toMatch(/^[a-f0-9]{24}$/);
    expect(await a.inboundToken()).toBe(token);
    expect(await a.rotateInboundToken()).not.toBe(token);
  });
});
