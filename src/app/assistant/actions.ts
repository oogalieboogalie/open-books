"use server";

import { revalidatePath } from "next/cache";
import { aiCategorize } from "@/lib/ai/categorizer";
import { getAi, refreshIndex } from "@/lib/ai/server";
import type { FormState } from "../actions";

export async function rebuildIndexAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { knowledge } = await getAi();
    if (form.get("reembed") === "on") await knowledge.resetEmbeddings();
    const r = await refreshIndex(knowledge, 90_000);
    const stats = await knowledge.stats();
    revalidatePath("/assistant/setup");
    if (r.embedError) return { error: `Index updated (${r.changed} changed), but embedding failed: ${r.embedError}` };
    const left = stats.documents - stats.embedded;
    return { ok: `Index updated: ${r.changed} changed, ${r.embedded} embedded${left > 0 && stats.vectorSupport && stats.embedModel ? `, ${left} still to embed (it keeps going in the background as you use the assistant)` : ""}.` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function aiCategorizeAction(_prev: FormState): Promise<FormState> {
  try {
    const { books, services } = await getAi();
    if (!services.provider) return { error: services.reason ?? "AI is not set up." };
    const r = await aiCategorize(books, services.provider, { limit: 100 });
    revalidatePath("/", "layout");
    if (!r.considered) return { ok: "Nothing to sort: the review queue has no transactions the built-in categorizer was unsure about." };
    return { ok: `Looked at ${r.considered}: suggested a category for ${r.updated}, and ${r.cleared} were clear enough to leave the review queue.` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function deleteConversationAction(form: FormData) {
  const { assistant } = await getAi();
  await assistant?.deleteConversation(Number(form.get("id")));
  revalidatePath("/assistant");
}
