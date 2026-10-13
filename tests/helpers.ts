import { afterAll } from "vitest";
import { Books } from "@/lib/books";
import { openDatabase, type Db } from "@/lib/db";

let shared: Promise<Db> | undefined;

/**
 * One database per test file (TEST_DATABASE_URL, else in-memory embedded
 * Postgres). Each call returns a fresh business with one checking account, so
 * tests never see each other's rows.
 */
export async function freshBooks(): Promise<Books> {
  if (!shared) {
    shared = openDatabase(process.env.TEST_DATABASE_URL || "memory");
    afterAll(async () => (await shared!).close());
  }
  const db = await shared;
  const row = await db.one<{ id: number }>("INSERT INTO businesses (name) VALUES ('Test') RETURNING id");
  const books = new Books(db, row!.id);
  await books.createAccount("Business checking", "checking");
  return books;
}
