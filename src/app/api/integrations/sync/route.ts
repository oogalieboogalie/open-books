import { timingSafeEqual } from "node:crypto";
import { syncEverything } from "@/lib/integrations/sync";

export const dynamic = "force-dynamic";

/** For an external scheduler (cron, a GitHub Action): POST with "Authorization: Bearer $CRON_SECRET". */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Set CRON_SECRET to enable this endpoint." }, { status: 404 });
  const given = Buffer.from((request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  await syncEverything();
  return Response.json({ ok: true });
}
