// A worker process's heartbeat, for the parent's liveness watch (liveness.ts, heartbeatWatcher). No time limit stops a
// worker (owner rule 2026-10-27); the parent judges it stuck only after two windows in a row with no progress and no
// processor time, so the worker has to tell it both, on every platform (no /proc, no PowerShell).
// A thread of its own writes one line to fd 1 (stdout) every P6CLONE_HEARTBEAT_MS (5000): "\u0001HB {json}" with the
// process's own processor time (process.cpuUsage, user + system, all threads, microseconds), its RSS and a progress
// counter the worker bumps (elements, bytes or entities done: progress(n)). The thread runs while the main thread is
// inside one long synchronous call (WebAssembly, a big mesh), which is when a heartbeat matters. It is on only when the
// parent asks (P6CLONE_HEARTBEAT_MS set): the line is the parent's, not a worker's output for anyone else.
import { Worker } from 'node:worker_threads';

const shared = new SharedArrayBuffer(8), counter = new Float64Array(shared);
/** Progress so far, absolute (elements meshed, bytes written...). */
export const progress = (n) => { counter[0] = n; };

const THREAD = `
const { workerData: { shared, every } } = require('node:worker_threads');
const fs = require('node:fs');
const counter = new Float64Array(shared);
setInterval(() => {
  const c = process.cpuUsage();
  try { fs.writeSync(1, '\\u0001HB ' + JSON.stringify({ cpu: Math.round((c.user + c.system) / 1000), rss: process.memoryUsage().rss, progress: counter[0] }) + '\\n'); } catch { /* the parent is gone */ }
}, every);
`;
/** Start the heartbeat (once, first thing in the worker) when the parent asked for it. */
export function startHeartbeat() {
  const every = Number(process.env.P6CLONE_HEARTBEAT_MS);
  if (!(every > 0)) return;
  const t = new Worker(THREAD, { eval: true, workerData: { shared, every } });
  t.unref();
  t.on('error', () => { /* no heartbeat: the parent then sees silence, and judges it as such */ });
}
