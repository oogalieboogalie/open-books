"use client";

import { useActionState } from "react";
import { aiCategorizeAction, rebuildIndexAction } from "../assistant/actions";
import type { FormState } from "../actions";

function Status({ state }: { state: FormState }) {
  if (state.error) return <p className="msg error" role="alert">{state.error}</p>;
  if (state.ok) return <p className="msg ok" role="status">{state.ok}</p>;
  return null;
}

export function RebuildIndexForm({ canEmbed }: { canEmbed: boolean }) {
  const [state, action, pending] = useActionState(rebuildIndexAction, {});
  return (
    <form action={action} className="inline-form">
      <button type="submit" className="secondary" disabled={pending}>{pending ? "Updating…" : "Update the index now"}</button>
      {canEmbed && (
        <label className="remember">
          <input type="checkbox" name="reembed" /> Re-embed everything (after changing the embedding model)
        </label>
      )}
      <Status state={state} />
    </form>
  );
}

export function AiCategorizeForm() {
  const [state, action, pending] = useActionState(aiCategorizeAction, {});
  return (
    <form action={action} className="inline-form">
      <button type="submit" disabled={pending}>{pending ? "Sorting…" : "Sort the review queue with AI"}</button>
      <Status state={state} />
    </form>
  );
}
