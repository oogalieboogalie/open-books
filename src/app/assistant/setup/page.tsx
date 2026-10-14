import Link from "next/link";
import { getAi } from "@/lib/ai/server";
import { AI_CLEAR_THRESHOLD } from "@/lib/ai/categorizer";
import { AiCategorizeForm, RebuildIndexForm } from "../../components/AiForms";

export const dynamic = "force-dynamic";

function Check({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <li>
      <span className={`dot${ok === null ? "" : ok ? " ok" : " bad"}`} aria-hidden />
      <span>{children}</span>
    </li>
  );
}

export default async function AiSetupPage() {
  const { services, knowledge, books } = await getAi();
  const { config, provider, embedder } = services;
  const [chat, embed, stats, review] = await Promise.all([
    provider ? provider.check() : Promise.resolve(null),
    embedder ? embedder.check() : Promise.resolve(null),
    knowledge.stats(),
    books.reviewCount(),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI setup</h1>
          <p className="muted">
            The assistant runs on Claude with your own Anthropic API key, or entirely on your machine with Ollama. Either way your books stay in your database.
          </p>
        </div>
        <Link href="/assistant">Back to the assistant</Link>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Status</h2>
          <ul className="status-list">
            <Check ok={chat?.ok ?? false}>
              <strong>Chat model:</strong> {chat ? chat.detail : services.reason}
            </Check>
            <Check ok={embed ? embed.ok : null}>
              <strong>Embeddings:</strong> {embed ? embed.detail : "Off. Search uses keywords only."}
            </Check>
            <Check ok={stats.vectorSupport}>
              <strong>pgvector:</strong> {stats.vectorSupport ? "Enabled in your database." : "Not available on this Postgres server, so search uses keywords only."}
            </Check>
            <Check ok={stats.documents > 0 ? true : null}>
              <strong>Index:</strong> {stats.documents} record{stats.documents === 1 ? "" : "s"}
              {stats.vectorSupport && stats.embedModel ? `, ${stats.embedded} embedded with ${stats.embedModel}` : ""}.
            </Check>
          </ul>
          <h3>Search index</h3>
          <p className="muted">
            Every transaction, event, month, and rule is indexed so the assistant can find them by meaning. It updates itself each time you ask a question.
          </p>
          <RebuildIndexForm canEmbed={!!embedder && stats.vectorSupport} />
        </div>

        <div className="card">
          <h2>AI categorization</h2>
          <p className="muted">
            Your rules and the built-in merchant list sort most transactions instantly. The AI then looks at the ones they were unsure about, using your own past choices as examples.
            Suggestions at {Math.round(AI_CLEAR_THRESHOLD * 100)}% confidence or more leave the review queue; the rest stay for you to check, marked &quot;AI:&quot;.
          </p>
          <p>
            {review} transaction{review === 1 ? "" : "s"} waiting for review.{" "}
            {config.autoCategorize ? "New imports are sorted automatically." : "Automatic sorting after import is off (AI_AUTO_CATEGORIZE=0)."}
          </p>
          {provider ? <AiCategorizeForm /> : <p className="muted">Set up a chat model first.</p>}
        </div>
      </div>

      <div className="card">
        <h2>Configuration</h2>
        <p className="muted">Set these as environment variables (in a <code>.env.local</code> file, or in <code>docker-compose.yml</code>) and restart the app.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Variable</th>
                <th>Now</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr><td><code>AI_PROVIDER</code></td><td>{config.provider}</td><td><code>anthropic</code>, <code>ollama</code>, or <code>off</code>. Defaults to anthropic when a key is set, otherwise ollama.</td></tr>
              <tr><td><code>ANTHROPIC_API_KEY</code></td><td>{config.anthropic.apiKey ? "set" : "not set"}</td><td>Your own key from console.anthropic.com. Usage is billed to your Anthropic account.</td></tr>
              <tr><td><code>ANTHROPIC_MODEL</code></td><td>{config.anthropic.model}</td><td>Which Claude model answers.</td></tr>
              <tr><td><code>AI_EFFORT</code></td><td>{config.anthropic.effort}</td><td><code>low</code>, <code>medium</code>, or <code>high</code>: how much Claude thinks before answering.</td></tr>
              <tr><td><code>OLLAMA_URL</code></td><td>{config.ollama.url}</td><td>Where Ollama is running.</td></tr>
              <tr><td><code>OLLAMA_MODEL</code></td><td>{config.ollama.model}</td><td>A local chat model that supports tool calling.</td></tr>
              <tr><td><code>EMBED_MODEL</code></td><td>{config.embed.model}</td><td>Ollama embedding model for search. <code>EMBED_PROVIDER=off</code> uses keyword search only.</td></tr>
              <tr><td><code>AI_AUTO_CATEGORIZE</code></td><td>{config.autoCategorize ? "on" : "off"}</td><td>Set to <code>0</code> to stop sorting new imports with AI.</td></tr>
            </tbody>
          </table>
        </div>
        <h3>Running everything locally with Ollama</h3>
        <ol>
          <li>Install Ollama from ollama.com, then run <code>ollama pull {config.ollama.model}</code> and <code>ollama pull {config.embed.model}</code>.</li>
          <li>Start Open Books. It finds Ollama at {config.ollama.url} by default.</li>
          <li>With Docker, <code>docker compose --profile ollama up</code> runs Ollama next to the app and pulls both models. Add <code>-f docker-compose.gpu.yml</code> (after <code>-f docker-compose.yml</code>) to use an NVIDIA GPU.</li>
        </ol>
      </div>
    </>
  );
}
