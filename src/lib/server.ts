import { Books } from "./books";
import { getDb } from "./db";

/** The signed-in business. Single-business for now; accounts and auth come later. */
export function getBooks(): Books {
  return Books.forDefaultBusiness(getDb());
}
