const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// "+ 0" turns -0 into 0 so nothing renders as "-$0.00".
export const money = (cents: number) => usd.format(cents / 100 + 0);
export const moneyWhole = (cents: number) => usdWhole.format(Math.round(cents / 100) + 0);

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "12.34" or "-12.34" or "$1,200" into integer cents. */
export function dollarsToCents(input: string): number | null {
  const s = input.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

export function pickYear(param: string | undefined, years: number[]): number {
  const n = Number(param);
  if (Number.isInteger(n) && n > 1900 && n < 3000) return n;
  return years[0] ?? new Date().getFullYear();
}

/** Today as YYYY-MM-DD in the server's local timezone. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
