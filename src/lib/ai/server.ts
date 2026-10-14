import type { Books } from "../books";
import { getBooks } from "../server";
import { Assistant } from "./assistant";
import { aiCategorize, type AiCategorizeResult } from "./categorizer";
import { Knowledge } from "./knowledge";
import { aiServices, type AiServices } from "./services";

/** Everything the assistant pages need for the current business. */
export async function getAi(): Promise<{ books: Books; services: AiServices; knowledge: Knowledge; assistant: Assistant | null }> {
  const books = await getBooks();
  const services = aiServices();
  const knowledge = new Knowledge(books, services.embedder);
  const assistant = services.provider ? new Assistant(books, services.provider, knowledge) : null;
  return { books, services, knowledge, assistant };
}

// One index refresh at a time per process; callers share the running one.
const globalForAi = globalThis as unknown as { __openBooksIndex?: Promise<unknown>; __openBooksSort?: Promise<unknown> };

/**
 * Syncs the index with the books, then embeds new documents for up to
 * `budgetMs`. Embedding failures (Ollama down) leave full-text search working.
 */
export function refreshIndex(knowledge: Knowledge, budgetMs = 8_000): Promise<{ changed: number; embedded: number; embedError?: string }> {
  const run = async () => {
    const { changed } = await knowledge.sync();
    try {
      return { changed, embedded: await knowledge.embedPending(budgetMs) };
    } catch (err) {
      return { changed, embedded: 0, embedError: (err as Error).message };
    }
  };
  const previous = globalForAi.__openBooksIndex ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  globalForAi.__openBooksIndex = next.catch(() => undefined);
  return next;
}

/** Keeps embedding in the background after an answer, so the next question has fuller vector search. */
export function continueIndexingInBackground(knowledge: Knowledge): void {
  refreshIndex(knowledge, 120_000).catch((err) => console.error("[open-books] indexing failed:", err));
}

/** Sorts the review queue with AI in the background (after an import). Runs one pass at a time. */
export function categorizeInBackground(books: Books, ids?: number[]): void {
  const { provider, config } = aiServices();
  if (!provider || !config.autoCategorize) return;
  const previous = globalForAi.__openBooksSort ?? Promise.resolve();
  globalForAi.__openBooksSort = previous
    .catch(() => undefined)
    .then(() => aiCategorize(books, provider, { ids, limit: 500 }))
    .then((r: AiCategorizeResult) => console.log(`[open-books] AI sorted ${r.updated} of ${r.considered} transactions (${r.cleared} cleared review).`))
    .catch((err) => console.error("[open-books] AI categorization failed:", (err as Error).message));
}
