import { beforeEach, describe, expect, it } from "vitest";
import { Activity, recordClick } from "@/lib/activity";
import type { Books } from "@/lib/books";
import { addMonths, autoGranularity, bucketStart, buildBuckets, resolveRange } from "@/lib/timeline";
import { businessTimeZone } from "@/lib/db";
import { freshBooks } from "./helpers";

describe("bucketing", () => {
  it("starts weeks on Monday and months on the 1st", () => {
    expect(bucketStart("2026-10-15", "week")).toBe("2026-10-12"); // Thursday -> Monday
    expect(bucketStart("2026-10-12", "week")).toBe("2026-10-12");
    expect(bucketStart("2026-10-18", "week")).toBe("2026-10-12"); // Sunday
    expect(bucketStart("2026-10-15", "month")).toBe("2026-10-01");
  });

  it("builds contiguous buckets that cover the range", () => {
    const b = buildBuckets("2026-01-30", "2026-03-02", "month");
    expect(b.map((x) => [x.start, x.end])).toEqual([
      ["2026-01-01", "2026-01-31"],
      ["2026-02-01", "2026-02-28"],
      ["2026-03-01", "2026-03-31"],
    ]);
    expect(buildBuckets("2026-10-01", "2026-10-30", "day")).toHaveLength(30);
  });

  it("clamps month math to the end of short months", () => {
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("resolves presets and picks a sensible granularity", () => {
    const r = resolveRange("6m", "2026-10-13", null);
    expect(r).toEqual({ key: "6m", from: "2026-04-14", to: "2026-10-13" });
    expect(autoGranularity(r.from, r.to)).toBe("week");
    expect(autoGranularity("2026-10-01", "2026-10-13")).toBe("day");
    expect(autoGranularity("2025-10-14", "2026-10-13")).toBe("month");
  });
});

describe("Activity timeline", () => {
  let books: Books;
  let activity: Activity;

  beforeEach(async () => {
    books = await freshBooks();
    activity = Activity.for(books);
  });

  it("lines up money, sales count, logged numbers, events, and link clicks per bucket", async () => {
    await books.importRows((await books.listAccounts())[0].id, [
      { date: "2026-10-05", description: "STRIPE TRANSFER", amountCents: 50_000 },
      { date: "2026-10-06", description: "SQUARE INC", amountCents: 20_000 },
      { date: "2026-10-06", description: "ADOBE", amountCents: -6_000 },
      { date: "2026-10-07", description: "ONLINE TRANSFER TO SAVINGS", amountCents: -99_999 },
    ]);
    const eventId = await activity.addEvent({ date: "2026-10-05", kind: "social_post", title: "Instagram reel: fall promo", url: "https://instagram.com/p/abc" });
    const slug = await activity.createLink({ destination: "https://example.com/book", eventId, slug: "fall-promo" });
    await activity.logMetric({ date: "2026-10-06", metric: "appointments", value: 4 });
    await activity.logMetric({ date: "2026-10-06", metric: "appointments", value: 5 }); // replaces
    await activity.logMetric({ date: "2026-10-07", metric: "Podcast downloads", value: 120 });

    expect(await recordClick(books.db, "FALL-PROMO")).toBe("https://example.com/book");
    await recordClick(books.db, slug);
    await recordClick(books.db, slug, { count: false }); // a link-preview bot
    expect(await recordClick(books.db, "nope")).toBeNull();

    const { d: today } = (await books.db.one<{ d: string }>("SELECT (now() AT TIME ZONE $1)::date AS d", [businessTimeZone()]))!;
    const t = await activity.timeline("2026-10-05", "2026-10-07", "day");
    expect(t.buckets.map((b) => [b.incomeCents, b.expenseCents])).toEqual([
      [50_000, 0],
      [20_000, 6_000],
      [0, 0],
    ]);
    const series = Object.fromEntries(t.series.map((s) => [s.key, s.values]));
    expect(series.sales_count).toEqual([1, 1, 0]);
    expect(series.appointments).toEqual([0, 5, 0]);
    expect(series.podcast_downloads).toEqual([0, 0, 120]);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ bucket: 0, linkSlug: "fall-promo" });

    // Clicks land on today's date, so check them over a range that includes today.
    const clicks = (await activity.timeline(today, today, "day")).series.find((s) => s.key === "link_clicks");
    expect(clicks?.values).toEqual([2]);

    const detail = await activity.periodDetail("2026-10-06", "2026-10-06", books);
    expect(detail.incomeCents).toBe(20_000);
    expect(detail.expenseCents).toBe(6_000);
    expect(detail.transactionCount).toBe(2);
    expect(detail.metrics).toEqual([{ date: "2026-10-06", key: "appointments", name: "Appointments", value: 5 }]);
    expect((await activity.periodDetail(today, today, books)).clicks).toEqual([
      { slug: "fall-promo", destination: "https://example.com/book", eventTitle: "Instagram reel: fall promo", count: 2 },
    ]);
  });

  it("rejects bad input", async () => {
    await expect(activity.logMetric({ date: "2026-10-06", metric: "link_clicks", value: 1 })).rejects.toThrow(/automatically/);
    await expect(activity.logMetric({ date: "2026-10-06", metric: "contacts", value: -1 })).rejects.toThrow();
    await expect(activity.createLink({ destination: "javascript:alert(1)" })).rejects.toThrow();
    await expect(activity.addEvent({ date: "2026-10-06", kind: "ad", title: "x", url: "ftp://x" })).rejects.toThrow();
    await activity.createLink({ destination: "https://a.com", slug: "taken" });
    await expect(activity.createLink({ destination: "https://b.com", slug: "taken" })).rejects.toThrow(/taken/);
  });
});
