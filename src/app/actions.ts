"use server";

import { revalidatePath } from "next/cache";
import type { AccountType } from "@/lib/books";
import type { MatchType, UserRule } from "@/lib/categorize/engine";
import { rowsFromCsv } from "@/lib/csv";
import { dollarsToCents } from "@/lib/format";
import { getBooks } from "@/lib/server";

const refresh = () => revalidatePath("/", "layout");

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export interface FormState {
  ok?: string;
  error?: string;
}

export async function addTransactionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const date = str(form, "date");
  const description = str(form, "description");
  const cents = dollarsToCents(str(form, "amount"));
  const direction = str(form, "direction");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Enter a date." };
  if (!description) return { error: "Enter a description." };
  if (cents === null || cents === 0) return { error: "Enter an amount, like 42.50." };
  const amountCents = direction === "in" ? Math.abs(cents) : -Math.abs(cents);
  const accountId = Number(str(form, "accountId")) || null;
  const categoryId = str(form, "categoryId") || undefined;
  getBooks().addTransaction({ date, description, amountCents, accountId, categoryId, notes: str(form, "notes") });
  refresh();
  return { ok: "Added." };
}

export async function setCategoryAction(form: FormData) {
  getBooks().setCategory(Number(form.get("id")), str(form, "categoryId"), { remember: form.get("remember") === "on" });
  refresh();
}

export async function markReviewedAction(form: FormData) {
  getBooks().markReviewed(Number(form.get("id")));
  refresh();
}

export async function updateNotesAction(form: FormData) {
  getBooks().updateNotes(Number(form.get("id")), str(form, "notes"));
  refresh();
}

export async function deleteTransactionAction(form: FormData) {
  getBooks().deleteTransaction(Number(form.get("id")));
  refresh();
}

export interface ImportState extends FormState {
  imported?: number;
  duplicates?: number;
  needsReview?: number;
  skipped?: string[];
}

export async function importCsvAction(_prev: ImportState, form: FormData): Promise<ImportState> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file to import." };
  if (file.size > 10 * 1024 * 1024) return { error: "That file is over 10 MB. Split it into smaller date ranges." };
  const accountId = Number(form.get("accountId"));
  const { rows, errors } = rowsFromCsv(await file.text(), { flipSigns: form.get("flipSigns") === "on" });
  if (rows.length === 0) return { error: errors[0] ?? "No transactions found in that file." };
  const result = getBooks().importRows(accountId, rows);
  refresh();
  return { ...result, skipped: errors.slice(0, 20) };
}

export async function createAccountAction(_prev: FormState, form: FormData): Promise<FormState> {
  const name = str(form, "name");
  if (!name) return { error: "Name the account." };
  getBooks().createAccount(name, (str(form, "type") || "checking") as AccountType);
  refresh();
  return { ok: `Added ${name}.` };
}

export async function createRuleAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    getBooks().createRule({
      pattern: str(form, "pattern"),
      categoryId: str(form, "categoryId"),
      matchType: (str(form, "matchType") || "contains") as MatchType,
      direction: (str(form, "direction") || "any") as UserRule["direction"],
    });
  } catch (err) {
    return { error: (err as Error).message };
  }
  refresh();
  return { ok: "Rule saved and applied." };
}

export async function deleteRuleAction(form: FormData) {
  getBooks().deleteRule(Number(form.get("id")));
  refresh();
}

export async function recategorizeAction() {
  getBooks().recategorize();
  refresh();
}
