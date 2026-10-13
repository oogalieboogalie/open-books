import { describe, expect, it } from "vitest";
import { categorize, defaultClassifiers, type UserRule } from "@/lib/categorize/engine";
import { merchantKey, normalizeDescription } from "@/lib/categorize/normalize";

const auto = (description: string, amountCents: number, rules: UserRule[] = []) =>
  categorize({ description, amountCents }, defaultClassifiers(rules));

describe("normalizeDescription", () => {
  it("strips card boilerplate, dates, and store numbers", () => {
    expect(normalizeDescription("POS DEBIT 10/14 SQ *BLUE BOTTLE COF 12345 OAKLAND CA")).toBe("BLUE BOTTLE COF OAKLAND CA");
    expect(normalizeDescription("PURCHASE AUTHORIZED ON 03/02 SHELL OIL 57444 AUSTIN TX")).toBe("SHELL OIL AUSTIN TX");
    expect(normalizeDescription("STARBUCKS STORE #08812")).toBe("STARBUCKS STORE");
  });

  it("gives the same merchant key across locations", () => {
    expect(merchantKey("STARBUCKS STORE #08812 SEATTLE WA")).toBe(merchantKey("STARBUCKS STORE 1234 PORTLAND OR"));
    expect(merchantKey("TST* JOE'S PIZZA 9988 BROOKLYN NY")).toBe("JOE'S PIZZA");
  });
});

describe("keyword categorization", () => {
  const cases: [string, number, string][] = [
    ["SHELL OIL 57444 AUSTIN TX", -4512, "car_truck"],
    ["STARBUCKS STORE #08812", -675, "meals"],
    ["UBER EATS HELP.UBER.COM", -2899, "meals"],
    ["UBER *TRIP HELP.UBER.COM", -1830, "travel"],
    ["DELTA AIR 0062345 ATLANTA", -48900, "travel"],
    ["DELTA DENTAL OF CA", -5400, "se_health_insurance"],
    ["GOOGLE *ADS1234567", -15000, "advertising"],
    ["GOOGLE *GSUITE_ACME", -1440, "software"],
    ["AMAZON WEB SERVICES AWS.AMAZON.CO", -2210, "software"],
    ["ADOBE *CREATIVE CLD", -5999, "software"],
    ["STRIPE TRANSFER ST-A1B2C3", 125000, "gross_receipts"],
    ["STRIPE", -2900, "commissions_fees"],
    ["SHOPIFY PAYOUT", 98000, "gross_receipts"],
    ["SHOPIFY* 123456789", -3900, "software"],
    ["UPWORK -123456789REF", -50000, "contract_labor"],
    ["IRS USATAXPYMT 270556123", -250000, "income_tax_payment"],
    ["PAYMENT THANK YOU - WEB", 150000, "transfer"],
    ["ONLINE TRANSFER TO SAVINGS XXXXX1234", -100000, "transfer"],
    ["MONTHLY SERVICE FEE", -1500, "bank_fees"],
    ["USPS PO 0512345", -1265, "office_expense"],
    ["COMCAST CABLE COMM", -8999, "utilities"],
    ["GUSTO PAYROLL", -420000, "wages"],
    ["LEGALZOOM.COM", -14900, "legal_professional"],
    ["CA SECRETARY OF STATE", -2000, "taxes_licenses"],
    ["WEWORK MEMBERSHIP", -45000, "rent_property"],
    ["THE HOME DEPOT #4521", -8743, "supplies"],
    ["INTEREST CHARGE ON PURCHASES", -1832, "interest_other"],
  ];
  it.each(cases)("%s (%i) -> %s", (description, amount, expected) => {
    expect(auto(description, amount).categoryId).toBe(expected);
  });

  it("treats money back from an expense merchant as a refund in the same category", () => {
    const s = auto("THE HOME DEPOT RETURN", 2500);
    expect(s.categoryId).toBe("supplies");
    expect(s.reason).toMatch(/Refund/);
  });

  it("flags ambiguous merchants for review", () => {
    expect(auto("AMZN MKTP US*2K4", -3499).confidence).toBeLessThan(0.7);
    expect(auto("WALMART SUPERCENTER", -5000).confidence).toBeLessThan(0.7);
  });

  it("falls back to income for unknown deposits and uncategorized for unknown spending, both flagged", () => {
    const deposit = auto("ACME CORP", 50000);
    expect(deposit.categoryId).toBe("gross_receipts");
    expect(deposit.confidence).toBeLessThan(0.7);
    const spend = auto("ZXQW HOLDINGS", -5000);
    expect(spend.categoryId).toBe("uncategorized");
  });
});

describe("user rules", () => {
  const rules: UserRule[] = [
    { id: 1, pattern: "ACME CORP", matchType: "contains", direction: "in", categoryId: "gross_receipts" },
    { id: 2, pattern: "STARBUCKS", matchType: "contains", direction: "out", categoryId: "owner_draw" },
  ];

  it("beat built-in keywords", () => {
    const s = auto("STARBUCKS STORE #1", -500, rules);
    expect(s.categoryId).toBe("owner_draw");
    expect(s.source).toBe("rule");
    expect(s.ruleId).toBe(2);
  });

  it("respect direction", () => {
    expect(auto("ACME CORP INVOICE 42", -500, rules).source).not.toBe("rule");
    expect(auto("ACME CORP INVOICE 42", 500, rules).confidence).toBe(0.99);
  });

  it("match whole words only", () => {
    expect(auto("ACME CORPORATE TRAVEL", 500, rules).source).not.toBe("rule");
  });
});

describe("isGenericMerchant", () => {
  it("flags payment-rail descriptions so they are not remembered by default", async () => {
    const { isGenericMerchant } = await import("@/lib/categorize/normalize");
    expect(isGenericMerchant(merchantKey("MOBILE DEPOSIT REF 99812"))).toBe(true);
    expect(isGenericMerchant(merchantKey("ZELLE PAYMENT FROM JOHN"))).toBe(true);
    expect(isGenericMerchant(merchantKey("STARBUCKS STORE #1"))).toBe(false);
  });
});
