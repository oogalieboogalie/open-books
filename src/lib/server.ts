import { Activity } from "./activity";
import { Books } from "./books";
import { getDb } from "./db";

/** The signed-in business. Single-business for now; accounts and auth come later. */
export async function getBooks(): Promise<Books> {
  return Books.forDefaultBusiness(await getDb());
}

export async function getActivity(): Promise<Activity> {
  return Activity.for(await getBooks());
}
