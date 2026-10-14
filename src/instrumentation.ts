/**
 * Background sync. Every SYNC_INTERVAL_MINUTES (default 15; 0 turns it off),
 * the server pulls from connected sheets, calendars, and mailboxes. Hosts that
 * prefer an external scheduler can call POST /api/integrations/sync instead.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const minutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? 15);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const { syncEverything } = await import("./lib/integrations/sync");
  const run = () => syncEverything().catch((err) => console.warn("[open-books] background sync failed:", (err as Error).message));
  // Give the server a moment to start before the first run.
  setTimeout(run, 30_000).unref?.();
  setInterval(run, minutes * 60_000).unref?.();
}
