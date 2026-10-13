import { pickYear } from "@/lib/format";
import { buildScheduleC, scheduleCCsv } from "@/lib/reports";
import { getBooks } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const books = await getBooks();
  const year = pickYear(new URL(request.url).searchParams.get("year") ?? undefined, await books.years());
  const csv = scheduleCCsv(buildScheduleC(await books.categoryTotals(year), year));
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="schedule-c-${year}.csv"`,
    },
  });
}
