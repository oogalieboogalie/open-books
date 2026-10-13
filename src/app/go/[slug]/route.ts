import { recordClick } from "@/lib/activity";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// Link previews from social networks and chat apps fetch the link too; count only people.
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|linkedin|twitter|skype|pinterest|vkshare|quora/i;

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  const isBot = BOTS.test(request.headers.get("user-agent") ?? "");
  const destination = isBot
    ? ((db.prepare("SELECT destination FROM tracked_links WHERE slug = ?").get(slug.toLowerCase()) as { destination: string } | undefined)?.destination ?? null)
    : recordClick(db, slug);
  if (!destination) return new Response("Link not found", { status: 404 });
  return Response.redirect(destination, 302);
}
