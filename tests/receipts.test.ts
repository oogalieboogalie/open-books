import { beforeEach, describe, expect, it } from "vitest";
import { Books } from "@/lib/books";
import { extractReceipt, findTotal, findVendor, htmlToText, parseLooseDate, unwrapForward } from "@/lib/receipts/extract";
import { receiptFromEmail, Receipts } from "@/lib/receipts/receipts";
import { freshBooks } from "./helpers";

const email = (o: Partial<Parameters<typeof extractReceipt>[0]>) => extractReceipt({ fromName: "", fromAddress: "", subject: "", text: "", html: "", date: "2026-10-01", ...o });

describe("receipt extraction", () => {
  it("prefers the labeled total over subtotal, tax, and tip", () => {
    const text = ["Latte $5.50", "Muffin $3.25", "Subtotal $8.75", "Tax $0.79", "Tip $2.00", "Total $11.54", "Visa ending 4242"].join("\n");
    expect(findTotal(text)).toEqual({ cents: 1154, confident: true });
  });

  it("reads totals split across table cells in HTML", () => {
    const html = `<table><tr><td>Item</td><td>$40.00</td></tr><tr><td>Order Total:</td></tr><tr><td>$1,043.20</td></tr></table>`;
    expect(findTotal(htmlToText(html))).toEqual({ cents: 104320, confident: true });
  });

  it("guesses the largest amount when nothing is labeled", () => {
    expect(findTotal("Thanks!\nWidget $12.00\nGadget $30.00")).toEqual({ cents: 3000, confident: false });
    expect(findTotal("No money here")).toEqual({ cents: null, confident: false });
  });

  it("reads amounts written with USD", () => {
    expect(findTotal("Amount paid: USD 49.00").cents).toBe(4900);
    expect(findTotal("Total 1,200.00 USD").cents).toBe(120000);
  });

  it("finds the vendor in the subject, the sender name, or the domain", () => {
    expect(findVendor({ subject: "Your receipt from Blue Bottle Coffee #2231", fromName: "Square", fromAddress: "receipts@messaging.squareup.com" })).toBe("Blue Bottle Coffee");
    expect(findVendor({ subject: "Your Amazon.com order #112-555 has shipped", fromName: "Amazon.com", fromAddress: "auto-confirm@amazon.com" })).toBe("Amazon.com");
    expect(findVendor({ subject: "Payment confirmation", fromName: "Adobe Billing", fromAddress: "mail@mail.adobe.com" })).toBe("Adobe");
    expect(findVendor({ subject: "Payment confirmation", fromName: "", fromAddress: "no-reply@email.figma.co.uk" })).toBe("Figma");
    expect(findVendor({ subject: "Fwd: Receipt from Joe's Tacos", fromName: "Me", fromAddress: "me@x.com" })).toBe("Joe's Tacos");
  });

  it("unwraps a Gmail forward to the original sender, subject, and date", () => {
    const text = [
      "FYI for the books",
      "",
      "---------- Forwarded message ---------",
      "From: Uber Receipts <noreply@uber.com>",
      "Date: Fri, Oct 10, 2026 at 3:14 PM",
      "Subject: Your Thursday evening trip with Uber",
      "To: <alex@example.com>",
      "",
      "Total $23.41",
    ].join("\n");
    const fwd = unwrapForward(text)!;
    expect(fwd).toMatchObject({ fromName: "Uber Receipts", fromAddress: "noreply@uber.com", date: "2026-10-10", subject: "Your Thursday evening trip with Uber" });
    const r = email({ fromName: "Alex", fromAddress: "alex@example.com", subject: "Fwd: Your Thursday evening trip with Uber", text });
    expect(r).toMatchObject({ vendor: "Uber", amountCents: 2341, date: "2026-10-10" });
  });

  it("unwraps Outlook and Apple Mail forwards", () => {
    const outlook = ["________________________________", "From: Staples <orders@staples.com>", "Sent: Monday, October 6, 2026 9:02 AM", "To: Alex", "Subject: Order confirmation from Staples", "", "Order number: 7789123", "Order total: $64.18"].join("\n");
    expect(email({ text: outlook })).toMatchObject({ vendor: "Staples", amountCents: 6418, date: "2026-10-06", orderRef: "7789123" });
    const apple = ["Begin forwarded message:", "", "From: GitHub <billing@github.com>", "Subject: [GitHub] Payment Receipt", "Date: October 2, 2026 at 11:00:00 AM CDT", "", "Amount: $4.00", "Total: $4.00"].join("\n");
    expect(email({ text: apple })).toMatchObject({ vendor: "GitHub", amountCents: 400, date: "2026-10-02" });
  });

  it("treats refunds as money back", () => {
    expect(email({ subject: "Your refund from Best Buy", text: "Refund total: $129.99" }).amountCents).toBe(-12999);
  });

  it("parses forwarded header dates", () => {
    expect(parseLooseDate("Fri, Oct 10, 2026 at 3:14 PM")).toBe("2026-10-10");
    expect(parseLooseDate("Monday, October 6, 2026 9:02 AM")).toBe("2026-10-06");
    expect(parseLooseDate("")).toBeNull();
  });
});

const PDF = Buffer.from("%PDF-1.4 fake receipt").toString("base64");

function mime(opts: { from: string; subject: string; body: string; date?: string; messageId?: string; pdf?: boolean }) {
  const boundary = "XYZ";
  const head = [`From: ${opts.from}`, "To: receipts+abc@books.example", `Subject: ${opts.subject}`, `Date: ${opts.date ?? "Wed, 01 Oct 2026 15:00:00 +0000"}`, `Message-ID: ${opts.messageId ?? "<m1@example.com>"}`, "MIME-Version: 1.0"];
  if (!opts.pdf) return [...head, "Content-Type: text/plain; charset=utf-8", "", opts.body].join("\r\n");
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body,
    `--${boundary}`,
    'Content-Type: application/pdf; name="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "",
    PDF,
    `--${boundary}--`,
  ].join("\r\n");
}

describe("receipts", () => {
  let books: Books;
  let receipts: Receipts;
  let checking: number;

  beforeEach(async () => {
    books = await freshBooks();
    receipts = Receipts.for(books);
    checking = (await books.listAccounts())[0].id;
  });

  it("reads a raw email with a PDF attachment", async () => {
    const input = await receiptFromEmail(mime({ from: "Adobe <billing@adobe.com>", subject: "Your Adobe invoice", body: "Invoice INV-55821\nTotal: $59.99", pdf: true }), "forward", { timeZone: "UTC" });
    expect(input).toMatchObject({ vendor: "Adobe", amountCents: 5999, date: "2026-10-01", orderRef: "INV-55821", externalId: "msg:<m1@example.com>" });
    expect(input.files?.map((f) => f.contentType)).toEqual(["application/pdf"]);
  });

  it("reads a receipt forwarded as an attachment", async () => {
    const inner = mime({ from: "Lyft <no-reply@lyftmail.com>", subject: "Your ride with Lyft", body: "Total charged: $18.20", messageId: "<inner@lyft>" });
    const outer = [
      "From: Alex <alex@example.com>",
      "Subject: Fwd: Your ride with Lyft",
      "Message-ID: <outer@example.com>",
      'Content-Type: multipart/mixed; boundary="OUT"',
      "",
      "--OUT",
      "Content-Type: text/plain",
      "",
      "see attached",
      "--OUT",
      "Content-Type: message/rfc822",
      "",
      inner,
      "--OUT--",
    ].join("\r\n");
    const input = await receiptFromEmail(outer, "forward");
    expect(input).toMatchObject({ vendor: "Lyft", amountCents: 1820, fromAddress: "no-reply@lyftmail.com", externalId: "msg:<outer@example.com>" });
  });

  it("matches a receipt to the charge when it is imported later, and skips duplicates", async () => {
    const raw = mime({ from: "Staples <orders@staples.com>", subject: "Your Staples order", body: "Order total: $64.18" });
    const first = await receipts.addEmail(raw, "forward", { timeZone: "UTC" });
    expect(first).toEqual({ id: expect.any(Number), matched: false });
    expect(await receipts.addEmail(raw, "forward")).toBeNull();

    await books.importRows(checking, [
      { date: "2026-10-03", description: "STAPLES 00123 AUSTIN TX", amountCents: -6418 },
      { date: "2026-10-03", description: "SHELL OIL 5544", amountCents: -4000 },
    ]);
    expect(await receipts.matchUnmatched()).toBe(1);
    const r = (await receipts.get(first!.id))!;
    expect(r).toMatchObject({ status: "matched", matchKind: "auto" });
    const tx = (await books.getTransaction(r.transactionId!))!;
    expect(tx).toMatchObject({ description: "STAPLES 00123 AUSTIN TX", receiptId: r.id });
  });

  it("does not guess between two identical charges from other vendors", async () => {
    await books.importRows(checking, [
      { date: "2026-10-01", description: "ACME CO", amountCents: -2500 },
      { date: "2026-10-02", description: "WIDGETS INC", amountCents: -2500 },
    ]);
    const added = await receipts.add({ source: "upload", vendor: "Corner Deli", date: "2026-10-01", amountCents: 2500 });
    expect(added!.matched).toBe(false);
    const candidates = await receipts.candidates(added!.id);
    expect(candidates).toHaveLength(2);
    await receipts.link(added!.id, candidates[1].id);
    expect((await receipts.get(added!.id))!.matchKind).toBe("manual");
    await receipts.unlink(added!.id);
    expect((await receipts.get(added!.id))!.status).toBe("unmatched");
  });

  it("suggests a nearby charge from the same vendor with a tip added", async () => {
    await books.importRows(checking, [{ date: "2026-10-02", description: "SQ *BLUE BOTTLE COFFEE", amountCents: -1450 }]);
    const added = await receipts.add({ source: "forward", vendor: "Blue Bottle Coffee", date: "2026-10-01", amountCents: 1200 });
    expect(added!.matched).toBe(false);
    const [c] = await receipts.candidates(added!.id);
    expect(c.reason).toContain("same vendor");
  });

  it("creates a transaction from a receipt for cash purchases", async () => {
    const added = await receipts.add({ source: "upload", vendor: "Office Depot", date: "2026-09-15", amountCents: 3299, orderRef: "A1" });
    const txId = await receipts.createTransaction(added!.id, books, checking);
    const tx = (await books.getTransaction(txId))!;
    expect(tx).toMatchObject({ amountCents: -3299, description: "Office Depot", categoryId: "office_expense", receiptId: added!.id });
    expect(await receipts.counts()).toEqual({ unmatched: 0, matched: 1, ignored: 0 });
  });

  it("stores and serves attachments", async () => {
    const added = await receipts.add({ source: "upload", vendor: "X", date: null, amountCents: null, files: [{ filename: "r.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) }] });
    const r = (await receipts.get(added!.id))!;
    expect(r.files).toEqual([{ id: expect.any(Number), filename: "r.png", contentType: "image/png", size: 3 }]);
    const file = (await receipts.file(r.files[0].id))!;
    expect([...file.data]).toEqual([1, 2, 3]);
    const other = Receipts.for(await freshBooks());
    expect(await other.file(r.files[0].id)).toBeNull();
  });
});
