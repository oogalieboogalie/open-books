import { getDb } from "@/lib/db";
import { parseFromHeader } from "@/lib/receipts/extract";
import { receiptFromEmail, receiptFromParts, Receipts, type ReceiptInput } from "@/lib/receipts/receipts";
import { businessForInboundToken } from "@/lib/integrations/store";

export const dynamic = "force-dynamic";

const MAX_BYTES = 30 * 1024 * 1024;
const TOKEN_IN_ADDRESS = /(?:\+|^|[\s<,"])([a-f0-9]{24})@/i;

/**
 * Receipts sent to the business's forwarding address. Point an inbound email
 * service here; the business is identified by the token in the address
 * (receipts+TOKEN@your-domain) or by ?token=TOKEN on this URL. Accepts:
 * - a raw email (message/rfc822 or text/plain body), e.g. from a Cloudflare Email Worker
 * - Postmark inbound JSON
 * - SendGrid Inbound Parse and Mailgun routes (multipart form, raw or parsed)
 */
export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return Response.json({ error: "Email too large" }, { status: 413 });

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  if (queryToken && !(await businessForInboundToken(await getDb(), queryToken))) return Response.json({ error: "Unknown forwarding address" }, { status: 404 });
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  let input: ReceiptInput;
  let recipients = "";
  try {
    if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
      const form = await request.formData();
      recipients = ["to", "recipient", "envelope", "cc"].map((k) => String(form.get(k) ?? "")).join(" ");
      const raw = form.get("email") ?? form.get("body-mime");
      if (raw) {
        input = await receiptFromEmail(typeof raw === "string" ? raw : new Uint8Array(await raw.arrayBuffer()), "forward");
      } else {
        const from = parseFromHeader(String(form.get("from") ?? form.get("sender") ?? ""));
        const attachments = [];
        for (const [, value] of form.entries()) {
          if (typeof value !== "string") attachments.push({ filename: value.name, contentType: value.type || "application/octet-stream", data: new Uint8Array(await value.arrayBuffer()) });
        }
        input = receiptFromParts(
          {
            ...from,
            subject: String(form.get("subject") ?? ""),
            text: String(form.get("body-plain") ?? form.get("text") ?? ""),
            html: String(form.get("body-html") ?? form.get("html") ?? ""),
            sentAt: toIso(String(form.get("Date") ?? form.get("date") ?? "")),
            messageId: String(form.get("Message-Id") ?? form.get("message-id") ?? ""),
            attachments,
          },
          "forward",
        );
      }
    } else if (type.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      if (typeof body.raw === "string") {
        input = await receiptFromEmail(body.raw, "forward");
        recipients = String(body.to ?? "");
      } else {
        // Postmark inbound webhook.
        const full = (body.FromFull ?? {}) as { Email?: string; Name?: string };
        recipients = [body.To, body.OriginalRecipient, body.Cc].map((v) => String(v ?? "")).join(" ");
        input = receiptFromParts(
          {
            fromName: String(full.Name ?? body.FromName ?? ""),
            fromAddress: String(full.Email ?? body.From ?? "").toLowerCase(),
            subject: String(body.Subject ?? ""),
            text: String(body.TextBody ?? ""),
            html: String(body.HtmlBody ?? ""),
            sentAt: toIso(String(body.Date ?? "")),
            messageId: String(body.MessageID ?? ""),
            attachments: ((body.Attachments ?? []) as { Name?: string; Content?: string; ContentType?: string }[]).map((a) => ({
              filename: a.Name ?? "",
              contentType: a.ContentType ?? "application/octet-stream",
              data: new Uint8Array(Buffer.from(a.Content ?? "", "base64")),
            })),
          },
          "forward",
        );
      }
    } else {
      const raw = new Uint8Array(await request.arrayBuffer());
      if (raw.byteLength === 0) return Response.json({ error: "Empty body" }, { status: 400 });
      recipients = request.headers.get("x-original-to") ?? "";
      input = await receiptFromEmail(raw, "forward");
    }
  } catch (err) {
    return Response.json({ error: `Could not read the email: ${(err as Error).message}` }, { status: 400 });
  }

  const token = queryToken ?? recipients.match(TOKEN_IN_ADDRESS)?.[1]?.toLowerCase() ?? "";
  const db = await getDb();
  const businessId = await businessForInboundToken(db, token);
  if (!businessId) return Response.json({ error: "Unknown forwarding address" }, { status: 404 });

  const result = await new Receipts(db, businessId).add(input);
  if (!result) return Response.json({ ok: true, duplicate: true });
  return Response.json({ ok: true, receiptId: result.id, matched: result.matched, vendor: input.vendor, amountCents: input.amountCents });
}

function toIso(s: string): string | null {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
