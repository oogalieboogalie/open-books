import { getCategory } from "@/lib/categories";
import { getBooks } from "@/lib/server";
import { Activity } from "@/lib/activity";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Everything that happened between two dates, for the timeline's drill-down panel. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!ISO.test(from) || !ISO.test(to) || from > to) return Response.json({ error: "Bad date range" }, { status: 400 });
  const books = await getBooks();
  const detail = await Activity.for(books).periodDetail(from, to, books);
  return Response.json({
    ...detail,
    transactions: detail.transactions.map((t) => ({ ...t, categoryName: getCategory(t.categoryId).name })),
  });
}
