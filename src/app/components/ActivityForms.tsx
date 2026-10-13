"use client";

import { useActionState, useState } from "react";
import { addEventAction, createLinkAction, logMetricAction, type FormState } from "../actions";

function Status({ state }: { state: FormState }) {
  if (state.error) return <p className="msg error" role="alert">{state.error}</p>;
  if (state.ok) return <p className="msg ok" role="status">{state.ok}</p>;
  return null;
}

export function EventForm({ today, kinds }: { today: string; kinds: { key: string; label: string }[] }) {
  const [state, action, pending] = useActionState(addEventAction, {});
  const [track, setTrack] = useState(false);
  return (
    <form action={action} className="card form-grid">
      <h2>Log an event</h2>
      <p className="muted wide" style={{ margin: 0 }}>A post, an email, a promo, anything that might move the numbers.</p>
      <label>
        Date
        <input type="date" name="date" defaultValue={today} required />
      </label>
      <label>
        Type
        <select name="kind" defaultValue="social_post">
          {kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </select>
      </label>
      <label className="wide">
        What happened
        <input name="title" placeholder="e.g. Instagram reel about the fall special" required />
      </label>
      <label className="wide">
        Link to the post (optional)
        <input name="url" type="url" placeholder="https://" />
      </label>
      <label className="wide">
        Notes
        <input name="notes" placeholder="Audience, spend, anything worth remembering" />
      </label>
      <label className="check wide">
        <input type="checkbox" name="track" checked={track} onChange={(e) => setTrack(e.target.checked)} /> Make a tracked link to put in the post, so clicks are counted
      </label>
      {track && (
        <>
          <label className="wide">
            Where the link should send people
            <input name="trackDestination" type="url" placeholder="https://yoursite.com/booking" required />
          </label>
          <label>
            Short name (optional)
            <input name="slug" placeholder="fall-special" pattern="[a-zA-Z0-9\-]{3,40}" />
          </label>
        </>
      )}
      <div className="actions">
        <button type="submit" disabled={pending}>Log event</button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function MetricForm({ today, metrics }: { today: string; metrics: { key: string; name: string }[] }) {
  const [state, action, pending] = useActionState(logMetricAction, {});
  const [metric, setMetric] = useState(metrics[0]?.key ?? "__new");
  return (
    <form action={action} className="card form-grid">
      <h2>Log daily numbers</h2>
      <p className="muted wide" style={{ margin: 0 }}>New contacts, appointments booked, leads. Logging a day again replaces it.</p>
      <label>
        Date
        <input type="date" name="date" defaultValue={today} required />
      </label>
      <label>
        What
        <select name="metric" value={metric} onChange={(e) => setMetric(e.target.value)}>
          {metrics.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
          <option value="__new">Something else…</option>
        </select>
      </label>
      {metric === "__new" && (
        <label>
          Name
          <input name="newMetric" placeholder="e.g. Quotes sent" required />
        </label>
      )}
      <label>
        How many
        <input name="value" type="number" min="0" step="any" inputMode="decimal" required />
      </label>
      <div className="actions">
        <button type="submit" disabled={pending}>Save</button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function LinkForm() {
  const [state, action, pending] = useActionState(createLinkAction, {});
  return (
    <form action={action} className="inline-form">
      <input name="destination" type="url" placeholder="https://where-it-goes.com" aria-label="Destination" required />
      <input name="slug" placeholder="short-name (optional)" aria-label="Short name" pattern="[a-zA-Z0-9\-]{3,40}" />
      <button type="submit" disabled={pending}>Create link</button>
      <Status state={state} />
    </form>
  );
}
