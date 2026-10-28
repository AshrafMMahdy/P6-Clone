// The MCP server's own process, watched (owner rules 2026-10-27/28: no fixed time limits; and the loops that run inside the server
// are watched too, not only the workers). The server DECLARES the sections that read input (the IFC index, the cached index, the 4D
// file readers) with watched(); a thread of its own (heartbeat.mjs startServerWatch) judges them by the same rule as the workers:
// ticks (progress(), tick(), alive()), windows of 4 x the longest gap, an opaque call's bound (10 x size x rate), a step's work bound.
//  - Stuck while the event loop still turns (the section waits on something that never comes): the section's job is cancelled with the
//    reason (a StuckError: step, silence or bound, tried, alternatives) and the server goes on.
//  - Stuck while the main thread is blocked in a synchronous loop: V8 cannot interrupt it, so the thread writes the reason into the
//    server's recovery folder and ends the process. Every project is checkpointed on disk shortly after its last change and comes back
//    under its handle on the next start, which tells the agent why (server_status recovery.previous_server_ended_stuck).
// Not covered, and why: the analysis and LOB engines (Monte Carlo, crash, optimize, windows analysis, LOB plans) have no measured rate
// to size a bound from and tick between steps only, so a legitimate long step would be a false kill of the whole server; they are
// ended by cancel_job. The O(elements) loops (links, exports, quantities) are finite array passes of milliseconds per 100,000
// elements and cannot hang; only input parsers can, and those are declared.
import { enterSection, expectedMs, leaveSection, serverWatching, startServerWatch } from './heartbeat.mjs';
import { StuckError, type StuckInfo } from './liveness.ts';

const waiting = new Set<{ label: string; stuck: (i: StuckInfo) => void }>();

/** Start the server's watch thread (once; no-op under P6CLONE_SERVER_WATCH=off). reportFile: where the reason is written if the process
 *  has to be ended. */
export function startWatch(reportFile: string, blockedMs?: number): boolean {
  return startServerWatch({ reportFile, ...(blockedMs ? { blockedMs } : {}), onStuck: (info: StuckInfo) => {
    // the section whose name the thread saw; a child's step forwarded into the section (a tiler under the indexer) renames it: then they all hear
    const mine = [...waiting].filter((w) => w.label === info.step);
    for (const w of mine.length ? mine : [...waiting]) w.stuck(info);
  } });
}

/** Run a section of the server's own work under the watch. expectMs: ONE call that cannot tick (ended past 10 x); capMs: the work bound of a
 *  ticking section (no silence may pass 10 x it); total: units in all (then only done ADVANCING is a tick). Where no watch runs (tests, a
 *  server started with P6CLONE_SERVER_WATCH=off) fn simply runs. */
export async function watched<T>(label: string, o: { what: string; next: string; tried?: string; expectMs?: number; capMs?: number; total?: number }, fn: () => T | Promise<T>): Promise<T> {
  if (!serverWatching()) return await fn();
  const prev = enterSection(label, { ...(o.expectMs ? { expect: o.expectMs } : {}), ...(o.capMs ? { cap: o.capMs } : {}), ...(o.total ? { total: o.total } : {}) });
  let entry!: { label: string; stuck: (i: StuckInfo) => void };
  const cancelled = new Promise<never>((_, reject) => { entry = { label, stuck: (i) => reject(new StuckError(i, { what: o.what, ...(o.tried ? { tried: o.tried } : {}), next: o.next })) }; waiting.add(entry); });
  cancelled.catch(() => { /* raced below */ });
  try { return await Promise.race([Promise.resolve().then(fn), cancelled]); } finally { waiting.delete(entry); leaveSection(prev); }
}
export { expectedMs };
