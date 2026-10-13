import { CATEGORIES, type Category } from "./categories";

/**
 * Turns per-category totals into the shape of Schedule C, plus an estimate of
 * self-employment tax. This is a planning aid for the owner and their tax
 * preparer, not a filed return.
 */

export interface ScheduleCLine {
  line: string;
  label: string;
  /** What was spent (expenses) or received (income), net of refunds. Cents. */
  amountCents: number;
  /** The deductible portion, after limits such as 50% for meals. Cents. */
  deductibleCents: number;
  categories: { category: Category; amountCents: number }[];
}

export interface ScheduleCSummary {
  year: number;
  grossReceiptsCents: number; // line 1
  returnsCents: number; // line 2
  cogsCents: number; // line 4
  grossProfitCents: number; // line 5
  otherIncomeCents: number; // line 6
  grossIncomeCents: number; // line 7
  expenseLines: ScheduleCLine[]; // lines 8-27a
  totalExpensesCents: number; // line 28
  netProfitCents: number; // line 31 (before business use of home)
  otherDeductions: { category: Category; amountCents: number }[];
  nonPl: { category: Category; amountCents: number }[];
  uncategorizedCents: number;
  seTax: SelfEmploymentTaxEstimate;
}

export interface SelfEmploymentTaxEstimate {
  netEarningsCents: number;
  socialSecurityCents: number;
  medicareCents: number;
  totalCents: number;
  /** Half of SE tax is deductible on Schedule 1. */
  deductibleHalfCents: number;
  wageBaseCents: number;
}

/** Social Security wage base by year (SSA). Unknown years use the latest known. */
const SS_WAGE_BASE: Record<number, number> = {
  2023: 160_200,
  2024: 168_600,
  2025: 176_100,
  2026: 184_500,
};

function wageBaseFor(year: number): number {
  const years = Object.keys(SS_WAGE_BASE).map(Number).sort((a, b) => a - b);
  const known = years.filter((y) => y <= year);
  return SS_WAGE_BASE[known.length ? known[known.length - 1] : years[0]];
}

export function estimateSelfEmploymentTax(netProfitCents: number, year: number): SelfEmploymentTaxEstimate {
  const wageBaseCents = wageBaseFor(year) * 100;
  const netEarningsCents = Math.max(0, Math.round(netProfitCents * 0.9235));
  // No SE tax is owed when net earnings are under $400.
  if (netEarningsCents < 400_00) {
    return { netEarningsCents, socialSecurityCents: 0, medicareCents: 0, totalCents: 0, deductibleHalfCents: 0, wageBaseCents };
  }
  const socialSecurityCents = Math.round(Math.min(netEarningsCents, wageBaseCents) * 0.124);
  const medicareCents = Math.round(netEarningsCents * 0.029);
  const totalCents = socialSecurityCents + medicareCents;
  return { netEarningsCents, socialSecurityCents, medicareCents, totalCents, deductibleHalfCents: Math.round(totalCents / 2), wageBaseCents };
}

const EXPENSE_LINE_LABELS: Record<string, string> = {
  "8": "Advertising",
  "9": "Car and truck expenses",
  "10": "Commissions and fees",
  "11": "Contract labor",
  "13": "Depreciation and section 179",
  "14": "Employee benefit programs",
  "15": "Insurance (other than health)",
  "16a": "Interest: mortgage",
  "16b": "Interest: other",
  "17": "Legal and professional services",
  "18": "Office expense",
  "19": "Pension and profit-sharing plans",
  "20a": "Rent or lease: vehicles, machinery, equipment",
  "20b": "Rent or lease: other business property",
  "21": "Repairs and maintenance",
  "22": "Supplies",
  "23": "Taxes and licenses",
  "24a": "Travel",
  "24b": "Deductible meals",
  "25": "Utilities",
  "26": "Wages",
  "27a": "Other expenses (Part V)",
};

const lineOrder = (line: string) => parseFloat(line) + (line.endsWith("b") ? 0.2 : line.endsWith("a") ? 0.1 : 0);

export function buildScheduleC(totals: Map<string, number>, year: number): ScheduleCSummary {
  const total = (id: string) => totals.get(id) ?? 0;

  const grossReceiptsCents = total("gross_receipts");
  const returnsCents = -total("returns_allowances");
  const cogsCents = -total("cogs_purchases");
  const grossProfitCents = grossReceiptsCents - returnsCents - cogsCents;
  const otherIncomeCents = total("other_income");
  const grossIncomeCents = grossProfitCents + otherIncomeCents;

  const lines = new Map<string, ScheduleCLine>();
  for (const category of CATEGORIES) {
    if (category.kind !== "expense" || !category.scheduleCLine) continue;
    const spent = -total(category.id);
    if (spent === 0) continue;
    const line = lines.get(category.scheduleCLine) ?? {
      line: category.scheduleCLine,
      label: EXPENSE_LINE_LABELS[category.scheduleCLine] ?? category.name,
      amountCents: 0,
      deductibleCents: 0,
      categories: [],
    };
    line.amountCents += spent;
    line.deductibleCents += Math.round((spent * category.deductiblePct) / 100);
    line.categories.push({ category, amountCents: spent });
    lines.set(category.scheduleCLine, line);
  }
  const expenseLines = [...lines.values()].sort((a, b) => lineOrder(a.line) - lineOrder(b.line));
  const totalExpensesCents = expenseLines.reduce((sum, l) => sum + l.deductibleCents, 0);
  const netProfitCents = grossIncomeCents - totalExpensesCents;

  const byKind = (kind: Category["kind"], sign: 1 | -1) =>
    CATEGORIES.filter((c) => c.kind === kind && total(c.id) !== 0).map((category) => ({ category, amountCents: sign * total(category.id) }));

  return {
    year,
    grossReceiptsCents,
    returnsCents,
    cogsCents,
    grossProfitCents,
    otherIncomeCents,
    grossIncomeCents,
    expenseLines,
    totalExpensesCents,
    netProfitCents,
    otherDeductions: byKind("other_deduction", -1),
    nonPl: byKind("non_pl", 1),
    uncategorizedCents: total("uncategorized"),
    seTax: estimateSelfEmploymentTax(netProfitCents, year),
  };
}

/** Rows for a CSV export of the summary, suitable for handing to a tax preparer. */
export function scheduleCCsv(s: ScheduleCSummary): string {
  const money = (cents: number) => (cents / 100).toFixed(2);
  const rows: string[][] = [["Line", "Description", "Amount", "Deductible"]];
  rows.push(["1", "Gross receipts or sales", money(s.grossReceiptsCents), ""]);
  rows.push(["2", "Returns and allowances", money(s.returnsCents), ""]);
  rows.push(["4", "Cost of goods sold", money(s.cogsCents), ""]);
  rows.push(["5", "Gross profit", money(s.grossProfitCents), ""]);
  rows.push(["6", "Other income", money(s.otherIncomeCents), ""]);
  rows.push(["7", "Gross income", money(s.grossIncomeCents), ""]);
  for (const l of s.expenseLines) {
    rows.push([l.line, l.label, money(l.amountCents), money(l.deductibleCents)]);
    if (l.categories.length > 1) {
      for (const c of l.categories) rows.push(["", `  ${c.category.name}`, money(c.amountCents), ""]);
    }
  }
  rows.push(["28", "Total expenses", "", money(s.totalExpensesCents)]);
  rows.push(["31", "Net profit or (loss), before business use of home", money(s.netProfitCents), ""]);
  for (const d of s.otherDeductions) rows.push([d.category.taxLine ?? "", d.category.name, money(d.amountCents), money(d.amountCents)]);
  rows.push(["", "Estimated self-employment tax (Schedule SE)", money(s.seTax.totalCents), ""]);
  return rows.map((r) => r.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\n") + "\n";
}
