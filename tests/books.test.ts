import { beforeEach, describe, expect, it } from "vitest";
import { Books } from "@/lib/books";
import { openDatabase } from "@/lib/db";
import { buildScheduleC } from "@/lib/reports";

let books: Books;
let checking: number;

beforeEach(() => {
  books = Books.forDefaultBusiness(openDatabase(":memory:"));
  checking = books.listAccounts()[0].id;
});

describe("Books", () => {
  it("auto-categorizes on import and skips duplicates on re-import", () => {
    const rows = [
      { date: "2026-02-01", description: "STARBUCKS STORE #1", amountCents: -500 },
      { date: "2026-02-01", description: "STARBUCKS STORE #1", amountCents: -500 },
      { date: "2026-02-03", description: "STRIPE TRANSFER", amountCents: 100000 },
    ];
    expect(books.importRows(checking, rows)).toEqual({ imported: 3, duplicates: 0, needsReview: 0 });
    expect(books.importRows(checking, rows)).toEqual({ imported: 0, duplicates: 3, needsReview: 0 });
    const { rows: txs } = books.listTransactions({ year: 2026 });
    expect(txs.map((t) => t.categoryId).sort()).toEqual(["gross_receipts", "meals", "meals"]);
  });

  it("learns from a correction and applies it to matching transactions", () => {
    books.importRows(checking, [
      { date: "2026-02-01", description: "JOE'S PIZZA 123 BROOKLYN", amountCents: -2000 },
      { date: "2026-02-08", description: "JOE'S PIZZA 456 QUEENS", amountCents: -2400 },
      { date: "2026-02-09", description: "ACME WIDGETS LLC", amountCents: -9900 },
    ]);
    const [first] = books.listTransactions({ search: "PIZZA" }).rows;
    const { ruleId } = books.setCategory(first.id, "owner_draw", { remember: true });
    expect(ruleId).toBeDefined();
    const pizza = books.listTransactions({ search: "PIZZA" }).rows;
    expect(pizza.every((t) => t.categoryId === "owner_draw")).toBe(true);
    expect(pizza.find((t) => t.id !== first.id)?.categorySource).toBe("rule");

    // New imports follow the rule too.
    books.importRows(checking, [{ date: "2026-03-01", description: "JOE'S PIZZA 789 BRONX", amountCents: -1500 }]);
    expect(books.listTransactions({ search: "BRONX" }).rows[0].categoryId).toBe("owner_draw");

    // Deleting the rule reverts transactions it set, but not the hand-set one.
    books.deleteRule(ruleId!);
    const after = books.listTransactions({ search: "PIZZA" }).rows;
    expect(after.find((t) => t.id === first.id)?.categoryId).toBe("owner_draw");
    expect(after.filter((t) => t.id !== first.id).every((t) => t.categoryId === "meals")).toBe(true);
  });

  it("keeps businesses separate", () => {
    const db = openDatabase(":memory:");
    const a = Books.forDefaultBusiness(db);
    const otherId = Number(db.prepare("INSERT INTO businesses (name) VALUES ('Other')").run().lastInsertRowid);
    const b = new Books(db, otherId);
    a.addTransaction({ date: "2026-01-01", description: "ADOBE", amountCents: -100 });
    expect(b.listTransactions().total).toBe(0);
    expect(() => b.addTransaction({ date: "2026-01-01", description: "X", amountCents: -1, accountId: a.listAccounts()[0].id })).toThrow();
  });
});

describe("Schedule C summary", () => {
  it("rolls categories into lines, halves meals, and excludes transfers and tax payments", () => {
    books.importRows(checking, [
      { date: "2026-01-05", description: "STRIPE TRANSFER", amountCents: 1_000_000 },
      { date: "2026-01-06", description: "STARBUCKS", amountCents: -10_000 },
      { date: "2026-01-07", description: "ADOBE", amountCents: -20_000 },
      { date: "2026-01-08", description: "MONTHLY SERVICE FEE", amountCents: -1_000 },
      { date: "2026-01-09", description: "IRS USATAXPYMT", amountCents: -300_000 },
      { date: "2026-01-10", description: "ONLINE TRANSFER TO SAVINGS", amountCents: -50_000 },
      { date: "2025-12-31", description: "STRIPE TRANSFER", amountCents: 999_999 },
    ]);
    const s = buildScheduleC(books.categoryTotals(2026), 2026);
    expect(s.grossReceiptsCents).toBe(1_000_000);
    const meals = s.expenseLines.find((l) => l.line === "24b")!;
    expect(meals.amountCents).toBe(10_000);
    expect(meals.deductibleCents).toBe(5_000);
    const other = s.expenseLines.find((l) => l.line === "27a")!;
    expect(other.amountCents).toBe(21_000);
    expect(s.totalExpensesCents).toBe(26_000);
    expect(s.netProfitCents).toBe(974_000);
    expect(s.nonPl.map((n) => n.category.id).sort()).toEqual(["income_tax_payment", "transfer"]);
    // 9,740 * 0.9235 = 8,994.89 net earnings; * 15.3% = 1,376.22
    expect(s.seTax.totalCents).toBe(137_622);
  });

  it("owes no SE tax under $400 of net earnings", () => {
    expect(buildScheduleC(new Map([["gross_receipts", 40_000]]), 2026).seTax.totalCents).toBe(0);
  });
});
