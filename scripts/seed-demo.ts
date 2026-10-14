/**
 * Fills the app with six months of realistic sample data so you can explore it:
 * `npm run seed:demo`. Uses the same database as the app (DATABASE_URL, or the
 * embedded database in ./data/pglite, so stop the app first in that case).
 * Running it twice does nothing the second time.
 *
 * The story: a small design studio that posts on social media now and then.
 * Posts are followed by a bump in contacts, appointments, and sales, so the
 * timeline has something to show.
 */
import { Activity } from "../src/lib/activity";
import { Books } from "../src/lib/books";
import { businessTimeZone, getDb } from "../src/lib/db";
import { todayIso } from "../src/lib/format";
import { Receipts } from "../src/lib/receipts/receipts";
import { addDays } from "../src/lib/timeline";

let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));

async function main() {
  const db = await getDb();
  const books = await Books.forDefaultBusiness(db);
  const activity = Activity.for(books);
  const account = (await books.listAccounts())[0].id;
  const today = todayIso();
  const start = addDays(today, -182);

  if ((await activity.listEvents(start, today)).length > 0) {
    console.log("Demo data is already loaded.");
    await db.close();
    return;
  }

  // Days when something was posted, and the boost it gives the following week.
  const posts = [
    { offset: 20, kind: "social_post", title: "Instagram reel: before and after brand refresh", url: "https://instagram.com/p/demo1" },
    { offset: 55, kind: "email", title: "Newsletter: spring availability", url: "" },
    { offset: 90, kind: "social_post", title: "TikTok: logo design time-lapse", url: "https://tiktok.com/@demo/video/2" },
    { offset: 118, kind: "promotion", title: "Summer bundle, 15% off brand kits", url: "" },
    { offset: 150, kind: "social_post", title: "LinkedIn post: client case study", url: "https://linkedin.com/posts/demo3" },
    { offset: 172, kind: "ad", title: "Meta ads test, $150 budget", url: "" },
  ];
  const boost = (day: number) => posts.reduce((b, p) => (day >= p.offset && day < p.offset + 10 ? b + (10 - (day - p.offset)) / 10 : b), 0);

  const rows: { date: string; description: string; amountCents: number }[] = [];
  for (let d = 0; d <= 182; d++) {
    const date = addDays(start, d);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekday = dow > 0 && dow < 6;
    const b = boost(d);

    // Sales: a couple a week normally, more after a post.
    const sales = (weekday && rand() < 0.3 ? 1 : 0) + (rand() < b * 0.6 ? between(1, 2) : 0);
    for (let i = 0; i < sales; i++) rows.push({ date, description: rand() < 0.7 ? "STRIPE TRANSFER" : "SQUARE INC", amountCents: between(150, 1800) * 100 });

    await activity.logMetric({ date, metric: "contacts", value: between(0, 2) + Math.round(b * between(2, 6)) });
    if (weekday) await activity.logMetric({ date, metric: "appointments", value: (rand() < 0.35 ? 1 : 0) + Math.round(b * between(0, 3)) });

    // Spending
    if (date.endsWith("-03")) rows.push({ date, description: "ADOBE *CREATIVE CLD", amountCents: -5999 });
    if (date.endsWith("-05")) rows.push({ date, description: "GOOGLE *GSUITE_STUDIO", amountCents: -1440 });
    if (date.endsWith("-01")) rows.push({ date, description: "WEWORK MEMBERSHIP", amountCents: -45000 });
    if (date.endsWith("-14")) rows.push({ date, description: "COMCAST CABLE COMM", amountCents: -8999 });
    if (date.endsWith("-28")) rows.push({ date, description: "MONTHLY SERVICE FEE", amountCents: -1500 });
    if (weekday && rand() < 0.15) rows.push({ date, description: "STARBUCKS STORE #08812", amountCents: -between(5, 14) * 100 });
    if (rand() < 0.05) rows.push({ date, description: "SHELL OIL 57444", amountCents: -between(35, 60) * 100 });
    if (rand() < 0.04) rows.push({ date, description: "UPWORK -REF", amountCents: -between(200, 700) * 100 });
    if (rand() < 0.03) rows.push({ date, description: "AMZN MKTP US", amountCents: -between(15, 90) * 100 });
  }
  for (const p of posts.filter((p) => p.kind === "ad")) rows.push({ date: addDays(start, p.offset), description: "FACEBK *ADS", amountCents: -15000 });

  const result = await books.importRows(account, rows);
  for (const p of posts) {
    const id = await activity.addEvent({ date: addDays(start, p.offset), kind: p.kind, title: p.title, url: p.url });
    if (p.kind === "social_post") {
      const slug = await activity.createLink({ destination: "https://example.com/book-a-call", eventId: id });
      const link = (await db.one<{ id: number }>("SELECT id FROM tracked_links WHERE slug = $1", [slug]))!;
      for (let d = 0; d < 7; d++) {
        const clicks = Math.round((7 - d) * between(2, 5));
        // Mid-afternoon in the business's timezone, so each click lands on the intended day.
        await db.query(
          "INSERT INTO link_clicks (link_id, clicked_at) SELECT $1, ($2::date + time '15:00') AT TIME ZONE $3 FROM generate_series(1, $4)",
          [link.id, addDays(start, p.offset + d), businessTimeZone(), clicks],
        );
      }
    }
  }
  // Receipts: a few that arrived by email and matched their charges, and one still waiting for its transaction.
  const receipts = Receipts.for(books);
  const recent = (await books.listTransactions({ from: addDays(today, -40), to: today, limit: 500 })).rows;
  const emailed = [
    { match: "ADOBE", vendor: "Adobe", fromAddress: "mail@mail.adobe.com", subject: "Your Adobe invoice" },
    { match: "GOOGLE", vendor: "Google Workspace", fromAddress: "payments-noreply@google.com", subject: "Google Workspace: Your invoice is available" },
    { match: "WEWORK", vendor: "WeWork", fromAddress: "billing@wework.com", subject: "Your WeWork receipt" },
    { match: "AMZN", vendor: "Amazon.com", fromAddress: "auto-confirm@amazon.com", subject: "Your Amazon.com order" },
  ];
  for (const r of emailed) {
    const t = recent.find((x) => x.description.startsWith(r.match));
    if (!t) continue;
    await receipts.add({ source: "forward", vendor: r.vendor, fromAddress: r.fromAddress, subject: r.subject, date: t.date, amountCents: -t.amountCents, externalId: `demo:${t.id}` });
  }
  await receipts.add({ source: "forward", vendor: "Blick Art Materials", fromAddress: "orders@dickblick.com", subject: "Your Blick order confirmation", date: addDays(today, -1), amountCents: 4217, orderRef: "B7731920", externalId: "demo:blick" });

  console.log(`Imported ${result.imported} transactions, ${posts.length} events, daily contacts and appointments, and sample receipts from ${start} to ${today}.`);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
