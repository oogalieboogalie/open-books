/**
 * Loads sample transactions so you can try the app: `npm run seed:demo`.
 * Uses the same database as the app (BOOKS_DB_PATH or ./data/books.db).
 */
import fs from "node:fs";
import path from "node:path";
import { Books } from "../src/lib/books";
import { rowsFromCsv } from "../src/lib/csv";
import { getDb } from "../src/lib/db";

const books = Books.forDefaultBusiness(getDb());
const account = books.listAccounts()[0];
const csv = fs.readFileSync(path.join(__dirname, "..", "samples", "business-checking-2026.csv"), "utf8");
const { rows, errors } = rowsFromCsv(csv);
const result = books.importRows(account.id, rows);
console.log(`Imported ${result.imported} into "${account.name}" (${result.duplicates} already there, ${result.needsReview} to review).`);
for (const e of errors) console.warn(e);
