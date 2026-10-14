import Link from "next/link";
import { getAi } from "@/lib/ai/server";
import { AssistantChat } from "../components/AssistantChat";
import { deleteConversationAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const params = await searchParams;
  const { assistant, services } = await getAi();

  if (!assistant) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Assistant</h1>
            <p className="muted">Ask questions about your books in plain English.</p>
          </div>
        </div>
        <div className="banner">
          {services.reason} <Link href="/assistant/setup">See how to set it up.</Link>
        </div>
      </>
    );
  }

  const conversations = await assistant.listConversations();
  const requested = Number(params.c) || null;
  const current = requested && conversations.some((c) => c.id === requested) ? requested : null;
  const messages = current ? await assistant.messages(current) : [];
  const p = services.provider!;
  const providerLabel = p.id === "anthropic" ? `Claude (${p.model}) with your API key` : `${p.model} running locally in Ollama`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Assistant</h1>
          <p className="muted">Ask about income, expenses, taxes, and what happened around your posts and promotions.</p>
        </div>
        <div className="actions">
          {current && (
            <form action={deleteConversationAction}>
              <input type="hidden" name="id" value={current} />
              <button type="submit" className="danger">Delete this conversation</button>
            </form>
          )}
          <Link href="/assistant/setup">AI setup</Link>
        </div>
      </div>
      <AssistantChat key={current ?? "new"} conversationId={current} initialMessages={messages} conversations={conversations} providerLabel={providerLabel} />
    </>
  );
}
