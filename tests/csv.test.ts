import { describe, expect, it } from "vitest";
import { parseAmountCents, parseCsv, parseDate, rowsFromCsv } from "@/lib/csv";

describe("parseCsv", () => {
  it("handles quotes, embedded commas, escaped quotes, and CRLF", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\r\n')).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });
});

describe("parsers", () => {
  it("reads amounts", () => {
    expect(parseAmountCents("$1,234.56")).toBe(123456);
    expect(parseAmountCents("-12.5")).toBe(-1250);
    expect(parseAmountCents("(12.00)")).toBe(-1200);
    expect(parseAmountCents("45.00 DR")).toBe(-4500);
    expect(parseAmountCents("abc")).toBeNull();
  });
  it("reads dates", () => {
    expect(parseDate("2026-03-04")).toBe("2026-03-04");
    expect(parseDate("3/4/2026")).toBe("2026-03-04");
    expect(parseDate("03/04/26")).toBe("2026-03-04");
    expect(parseDate("13/45/2026")).toBeNull();
  });
});

describe("rowsFromCsv", () => {
  it("reads a signed-amount export (Chase style)", () => {
    const csv = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n03/02/2026,03/03/2026,SHELL OIL 57444,Gas,Sale,-45.12,\n03/05/2026,03/05/2026,Payment Thank You-Mobile,,Payment,500.00,\n";
    const { rows, errors } = rowsFromCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { date: "2026-03-02", description: "SHELL OIL 57444", amountCents: -4512 },
      { date: "2026-03-05", description: "Payment Thank You-Mobile", amountCents: 50000 },
    ]);
  });

  it("reads debit and credit columns and skips preamble lines", () => {
    const csv = "Account: Business Checking\n\nDate,Description,Debit,Credit,Balance\n2026-01-02,STRIPE TRANSFER,,1200.00,5000\n2026-01-03,ADOBE,59.99,,4940.01\n";
    const { rows } = rowsFromCsv(csv);
    expect(rows.map((r) => r.amountCents)).toEqual([120000, -5999]);
  });

  it("can flip signs for card exports that show charges as positive", () => {
    const { rows } = rowsFromCsv("Date,Description,Amount\n01/02/2026,ADOBE,59.99\n", { flipSigns: true });
    expect(rows[0].amountCents).toBe(-5999);
  });

  it("explains when columns cannot be found", () => {
    expect(rowsFromCsv("foo,bar\n1,2\n").errors[0]).toMatch(/Could not find/);
  });
});
