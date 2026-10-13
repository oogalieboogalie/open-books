/**
 * Tax categories, keyed to IRS Schedule C (Form 1040), "Profit or Loss From Business".
 *
 * Every transaction lands in exactly one of these. Categories that are not on
 * Schedule C (transfers, owner draws, income tax payments, deductions that go on
 * Schedule 1) are still tracked so the books balance, but they are kept out of
 * the profit-and-loss totals.
 */

export type CategoryKind =
  /** Business income (Schedule C Part I). */
  | "income"
  /** Cost of goods sold (Schedule C Part III, flows to line 4). */
  | "cogs"
  /** Deductible business expense (Schedule C Part II). */
  | "expense"
  /** Deductible, but on another form (e.g. Schedule 1), not Schedule C. */
  | "other_deduction"
  /** Money that is not income or expense: transfers, owner draws, loans. */
  | "non_pl"
  /** Not yet categorized. */
  | "uncategorized";

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  /** Where it is reported, e.g. "Sch. C line 24b". */
  taxLine: string | null;
  /** Schedule C line number used for ordering and report grouping. */
  scheduleCLine: string | null;
  /** Share of the amount that is deductible, 0-100. Meals are 50%. */
  deductiblePct: number;
  description: string;
}

const c = (
  id: string,
  name: string,
  kind: CategoryKind,
  scheduleCLine: string | null,
  description: string,
  opts: { deductiblePct?: number; taxLine?: string } = {},
): Category => ({
  id,
  name,
  kind,
  scheduleCLine,
  taxLine: opts.taxLine ?? (scheduleCLine ? `Sch. C line ${scheduleCLine}` : null),
  deductiblePct: opts.deductiblePct ?? (kind === "expense" || kind === "cogs" || kind === "other_deduction" ? 100 : 0),
  description,
});

export const CATEGORIES: Category[] = [
  // Part I: Income
  c("gross_receipts", "Sales & services income", "income", "1", "Money customers pay you for products or services, including payouts from Stripe, Square, PayPal, Shopify, Etsy."),
  c("returns_allowances", "Refunds to customers", "income", "2", "Refunds and discounts you give customers. Reduces gross receipts."),
  c("other_income", "Other business income", "income", "6", "Business income that is not from sales, such as finder's fees, prizes, or recovered bad debts."),

  // Part III: Cost of goods sold
  c("cogs_purchases", "Inventory & materials (COGS)", "cogs", "4", "Products bought for resale and raw materials that go into products you sell. Reported through Part III.", { taxLine: "Sch. C line 4 (Part III)" }),

  // Part II: Expenses
  c("advertising", "Advertising & marketing", "expense", "8", "Ads, promotions, business cards, sponsorships, and marketing services."),
  c("car_truck", "Car & truck expenses", "expense", "9", "Business share of gas, oil, repairs, parking, and tolls. If you use the standard mileage rate, only parking and tolls are added on top of mileage."),
  c("commissions_fees", "Commissions & fees", "expense", "10", "Payment processing fees, marketplace fees, and commissions paid to non-employees."),
  c("contract_labor", "Contract labor", "expense", "11", "Payments to independent contractors and freelancers. Anyone paid $600+ in a year may need a 1099-NEC."),
  c("depreciation", "Equipment & depreciation", "expense", "13", "Computers, machinery, furniture, and other assets that last more than a year. Often fully deductible in year one under Section 179 or the de minimis rule.", { taxLine: "Sch. C line 13 (Form 4562)" }),
  c("employee_benefits", "Employee benefit programs", "expense", "14", "Health, life, and other benefit programs for employees (not for you as the owner)."),
  c("insurance", "Insurance (business)", "expense", "15", "General liability, professional liability, business property, and commercial auto insurance. Not health insurance for yourself."),
  c("interest_mortgage", "Mortgage interest (business property)", "expense", "16a", "Interest on a mortgage for business real estate."),
  c("interest_other", "Interest on business debt", "expense", "16b", "Interest on business loans and business credit cards."),
  c("legal_professional", "Legal & professional services", "expense", "17", "Attorneys, accountants, bookkeepers, tax preparers, and business formation services."),
  c("office_expense", "Office expense", "expense", "18", "Postage, shipping, printer ink, paper, and other office costs."),
  c("pension_plans", "Employee retirement plans", "expense", "19", "Contributions to retirement plans for employees. Your own contributions go on Schedule 1."),
  c("rent_equipment", "Rent: vehicles & equipment", "expense", "20a", "Leasing or renting vehicles, machinery, and equipment for business."),
  c("rent_property", "Rent: business property", "expense", "20b", "Office, coworking, studio, storage unit, or retail space rent."),
  c("repairs", "Repairs & maintenance", "expense", "21", "Repairs to business equipment and property that do not add value or extend its life."),
  c("supplies", "Supplies", "expense", "22", "Materials and supplies used up in the business that are not inventory."),
  c("taxes_licenses", "Taxes & licenses", "expense", "23", "Business licenses, state filing fees, LLC annual fees, the employer share of payroll taxes, and sales tax you paid on business purchases. Not federal income tax."),
  c("travel", "Travel", "expense", "24a", "Airfare, lodging, rental cars, and transportation while traveling away from home overnight for business."),
  c("meals", "Business meals (50%)", "expense", "24b", "Meals with clients or while traveling for business. Generally 50% deductible; keep a note of who and why.", { deductiblePct: 50 }),
  c("utilities", "Utilities", "expense", "25", "Phone, internet, electricity, water, and gas for a business location, or the business share of your own."),
  c("wages", "Wages (employees)", "expense", "26", "Gross wages paid to W-2 employees. Not payments to yourself as a sole proprietor or single-member LLC."),
  c("software", "Software & subscriptions", "expense", "27a", "Software, SaaS, web hosting, domains, and online tools.", { taxLine: "Sch. C line 27a (Part V)" }),
  c("bank_fees", "Bank fees", "expense", "27a", "Account maintenance, wire, overdraft, and ATM fees on business accounts.", { taxLine: "Sch. C line 27a (Part V)" }),
  c("education", "Education & training", "expense", "27a", "Courses, books, conferences, and training that maintain or improve skills used in your current business.", { taxLine: "Sch. C line 27a (Part V)" }),
  c("dues_memberships", "Dues & memberships", "expense", "27a", "Professional associations, trade groups, and chambers of commerce.", { taxLine: "Sch. C line 27a (Part V)" }),
  c("other_expense", "Other business expense", "expense", "27a", "Ordinary and necessary business expenses that do not fit another line.", { taxLine: "Sch. C line 27a (Part V)" }),

  // Deductions that are reported outside Schedule C
  c("se_health_insurance", "Health insurance (self-employed)", "other_deduction", null, "Health, dental, and long-term care premiums for you and your family if you are self-employed and not eligible for an employer plan.", { taxLine: "Sch. 1 line 17" }),
  c("retirement_owner", "Retirement contributions (owner)", "other_deduction", null, "Your own SEP-IRA, SIMPLE IRA, or Solo 401(k) contributions.", { taxLine: "Sch. 1 line 16" }),

  // Not profit or loss
  c("transfer", "Transfer between accounts", "non_pl", null, "Moving money between your own accounts, including paying off a business credit card."),
  c("owner_contribution", "Owner contribution", "non_pl", null, "Money you put into the business from personal funds. Not income."),
  c("owner_draw", "Owner draw / personal", "non_pl", null, "Money taken out for personal use, and personal purchases made on a business account. Not deductible."),
  c("income_tax_payment", "Income tax payment", "non_pl", null, "Federal and state income tax payments, including quarterly estimated taxes. Track them, but they are not deductible."),
  c("loan", "Loan principal", "non_pl", null, "Loan proceeds received and principal repaid. Only the interest portion is deductible (line 16b)."),
  c("sales_tax_collected", "Sales tax collected/remitted", "non_pl", null, "Sales tax you collect from customers and pass on to the state."),

  c("uncategorized", "Uncategorized", "uncategorized", null, "Needs a category."),
];

const BY_ID = new Map(CATEGORIES.map((cat) => [cat.id, cat]));

export function getCategory(id: string): Category {
  return BY_ID.get(id) ?? BY_ID.get("uncategorized")!;
}

export function isCategoryId(id: string): boolean {
  return BY_ID.has(id);
}

export const CATEGORY_GROUPS: { label: string; kinds: CategoryKind[] }[] = [
  { label: "Income", kinds: ["income"] },
  { label: "Cost of goods sold", kinds: ["cogs"] },
  { label: "Business expenses (Schedule C)", kinds: ["expense"] },
  { label: "Other deductions", kinds: ["other_deduction"] },
  { label: "Not income or expense", kinds: ["non_pl"] },
  { label: "Other", kinds: ["uncategorized"] },
];
