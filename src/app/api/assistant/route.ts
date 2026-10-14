import type { AssistantEvent } from "@/lib/ai/assistant";
import { continueIndexingInBackground, getAi, refreshIndex } from "@/lib/ai/server";
import { todayIso } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Asks the assistant a question. Streams newline-delimited JSON events
 * (AssistantEvent) so the answer appears as it is written.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { question?: unknown; conversationId?: unknown };
  const question = typeof body.question === "string" ? body.question.slice(0, 4000) : "";
  const conversationId = Number(body.conversationId) || null;
  if (!question.trim()) return Response.json({ error: "Ask a question." }, { status: 400 });

  const { assistant, knowledge, services } = await getAi();
  if (!assistant) return Response.json({ error: services.reason ?? "The assistant is not set up." }, { status: 503 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AssistantEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          // The browser went away; keep going so the answer is still saved.
        }
      };
      try {
        emit({ type: "status", text: "Reading your latest records" });
        await refreshIndex(knowledge);
        await assistant.ask({ conversationId, question, today: todayIso(), emit, signal: request.signal });
      } catch (err) {
        emit({ type: "error", message: (err as Error).message });
      } finally {
        try {
          controller.close();
        } catch {}
        continueIndexingInBackground(knowledge);
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
