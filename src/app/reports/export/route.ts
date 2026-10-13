import { pickYear } from "@/lib/format";
import { buildScheduleC, scheduleCCsv } from "@/lib/reports";
import { getBooks } from "@/lib/server";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const books = getBooks();
  const year = pickYear(new URL(request.url).searchParams.get("year") ?? undefined, books.years());
  const csv = scheduleCCsv(buildScheduleC(books.categoryTotals(year), year));
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="schedule-c-${year}.csv"`,
    },
  });
}
