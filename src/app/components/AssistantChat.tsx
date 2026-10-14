"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AssistantEvent, ChatMessage, Conversation } from "@/lib/ai/assistant";
import type { Source, ToolActivity } from "@/lib/ai/tools";
import { Markdown } from "./Markdown";

interface Msg {
  key: string;
  role: "user" | "assistant";
  content: string;
  activity: ToolActivity[];
  status?: string;
  error?: string;
  pending?: boolean;
}

const SUGGESTIONS = [
  "How did last month compare with the month before?",
  "What are my biggest expenses this year, and anything unusual?",
  "Did my most recent social post or promotion bring in sales?",
  "Go through what needs review and tell me what you think each one is.",
  "Estimate my self-employment tax for this year so far.",
  "Which months had the most new contacts, and what happened around them?",
];

function sourceHref(s: Source): string {
  if (s.type === "transaction") return `/transactions?${new URLSearchParams({ year: "all", q: s.title, ...(s.date ? { from: s.date, to: s.date } : {}) })}`;
  if (s.type === "rule") return "/rules";
  if (s.date) return `/timeline?${new URLSearchParams({ range: "all", by: "month", focus: `${s.date.slice(0, 7)}-01` })}`;
  return "/timeline";
}

function Activity({ items }: { items: ToolActivity[] }) {
  if (!items.length) return null;
  // Records the tools looked up come first; search context fills in when there are none.
  const fromTools = items.filter((a) => a.tool !== "context").flatMap((a) => a.sources ?? []);
  const sources = fromTools.length ? fromTools : items.flatMap((a) => a.sources ?? []);
  const unique = [...new Map(sources.map((s) => [`${s.type}:${s.id}`, s])).values()].slice(0, 12);
  return (
    <details className="chat-activity">
      <summary>
        {items.some((a) => a.changed) ? "Changed your books · " : ""}
        {items.filter((a) => a.tool !== "context").length || "No"} lookup{items.filter((a) => a.tool !== "context").length === 1 ? "" : "s"}
        {unique.length ? `, ${unique.length} record${unique.length === 1 ? "" : "s"}` : ""}
      </summary>
      <ul>
        {items.map((a, i) => (
          <li key={i} className={a.error ? "msg error" : a.changed ? "changed" : undefined}>{a.label}</li>
        ))}
      </ul>
      {unique.length > 0 && (
        <div className="chat-sources">
          {unique.map((s) => (
            <Link key={`${s.type}:${s.id}`} href={sourceHref(s)} className="tag">
              {s.date ? `${s.date} · ` : ""}
              {s.title}
            </Link>
          ))}
        </div>
      )}
    </details>
  );
}

export function AssistantChat(props: { conversationId: number | null; initialMessages: ChatMessage[]; conversations: Conversation[]; providerLabel: string }) {
  const [conversationId, setConversationId] = useState(props.conversationId);
  const [conversations, setConversations] = useState(props.conversations);
  const [messages, setMessages] = useState<Msg[]>(() =>
    props.initialMessages.map((m) => ({ key: `m${m.id}`, role: m.role, content: m.content, activity: m.activity })),
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const updateLast = (fn: (m: Msg) => Msg) => setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1])]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const stamp = Date.now();
    setMessages((ms) => [
      ...ms,
      { key: `u${stamp}`, role: "user", content: q, activity: [] },
      { key: `a${stamp}`, role: "assistant", content: "", activity: [], pending: true, status: "Thinking" },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, conversationId }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `The assistant answered ${res.status}.`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) handle(JSON.parse(line) as AssistantEvent);
        }
        if (done) break;
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") updateLast((m) => ({ ...m, error: (err as Error).message }));
    } finally {
      updateLast((m) => ({ ...m, pending: false, status: undefined }));
      setBusy(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }

  function handle(e: AssistantEvent) {
    switch (e.type) {
      case "conversation":
        setConversationId(e.id);
        setConversations((cs) => [{ id: e.id, title: e.title, updatedAt: new Date().toISOString() }, ...cs]);
        window.history.replaceState(null, "", `/assistant?c=${e.id}`);
        break;
      case "status":
        updateLast((m) => ({ ...m, status: e.text }));
        break;
      case "tool":
        updateLast((m) => ({ ...m, activity: [...m.activity, e.activity], status: e.activity.tool === "context" ? "Thinking" : e.activity.label }));
        break;
      case "text":
        updateLast((m) => ({ ...m, content: m.content + e.delta, status: undefined }));
        break;
      case "error":
        updateLast((m) => ({ ...m, error: e.message }));
        break;
      case "done":
        break;
    }
  }

  return (
    <div className="chat-layout">
      <aside className="card chat-history" aria-label="Conversations">
        <a href="/assistant" className="chat-new">+ New conversation</a>
        {conversations.length === 0 ? (
          <p className="muted">Your conversations appear here.</p>
        ) : (
          <ul>
            {conversations.map((c) => (
              <li key={c.id}>
                <a href={`/assistant?c=${c.id}`} aria-current={c.id === conversationId ? "true" : undefined}>{c.title}</a>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="card chat-main" aria-label="Assistant">
        <div className="chat-log" aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-empty">
              <p className="muted">Ask anything about your books. Answers come from your own records, and every lookup is shown.</p>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="secondary" onClick={() => ask(s)} disabled={busy}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.key} className={`chat-msg ${m.role}`}>
              {m.role === "user" ? (
                <p>{m.content}</p>
              ) : (
                <>
                  <Activity items={m.activity} />
                  {m.content && <Markdown text={m.content} />}
                  {m.pending && m.status && <p className="muted chat-status">{m.status}…</p>}
                  {m.error && <p className="msg error" role="alert">{m.error}</p>}
                </>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={2}
            placeholder="Ask about income, expenses, taxes, or what happened after a post…"
            aria-label="Your question"
          />
          {busy ? (
            <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>Stop</button>
          ) : (
            <button type="submit" disabled={!input.trim()}>Ask</button>
          )}
        </form>
        <p className="muted chat-foot">Answered by {props.providerLabel}. Not tax or legal advice.</p>
      </section>
    </div>
  );
}
