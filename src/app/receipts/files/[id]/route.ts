import { Receipts } from "@/lib/receipts/receipts";
import { getBooks } from "@/lib/server";

export const dynamic = "force-dynamic";

/** A receipt's PDF, image, or original email. Served sandboxed, since email HTML is untrusted. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new Response("Not found", { status: 404 });
  const file = await Receipts.for(await getBooks()).file(id);
  if (!file) return new Response("Not found", { status: 404 });
  const download = new URL(request.url).searchParams.has("download");
  const name = file.filename.replace(/[^\w.\- ]/g, "_");
  return new Response(Buffer.from(file.data), {
    headers: {
      "content-type": file.contentType === "text/html" ? "text/html; charset=utf-8" : file.contentType,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
      // No scripts, forms, or same-origin access, and no remote images (tracking pixels).
      "content-security-policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, max-age=3600",
    },
  });
}
