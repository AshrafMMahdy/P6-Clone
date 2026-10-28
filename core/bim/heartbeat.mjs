// A worker process's heartbeat and the work-relative bounds it declares, for the parent's liveness watch (liveness.ts,
// heartbeatWatcher). No fixed time limit stops a worker (owner rule 2026-10-27, 2026-10-28). Two layers:
//  1. A loop we own reports progress: progress(n) / tick() (a unit of work done: product, tile, element), alive() (a step
//     happened that is not a unit: a window written, a stream inflated). Stuck = no tick for two windows, a window being
//     4 times the longest gap between ticks THIS job has shown (measured here, at the source, every 100 ms), never under
//     the floor. Processor time is NOT life: a loop that spins without ticking is stuck.
//  2. An opaque call that cannot tick (a WebAssembly read, one inflate of a whole section) is wrapped in opaque(): the
//     worker declares how long it should take (expectedMs: input bytes x the measured rate on this machine) and the
//     parent ends it past BOUND_MULTIPLE times that.
// A thread of its own writes one line to fd 1 every P6CLONE_HEARTBEAT_MS (5000): "\u0001HB {json}" with the step now
// running, the time since its last tick, the longest gap, the declared bound, and the process's own processor time and
// memory (for the message and the Revit memory proxy; they are not evidence of life). It runs while the main thread is
// inside one long synchronous call, which is when a heartbeat matters. On only when the parent asks
// (P6CLONE_HEARTBEAT_MS set): the line is the parent's, not a worker's output for anyone else.
import { Worker } from 'node:worker_threads';

// ---- the measured rates (seconds of work per MB of input, ONE place; docs/4d-tiles-contract.md section 6) ---------------
/** web-ifc: OpenModel + meshing, per MB of the run's IFC. Measured 0.24, 0.39, 0.38, 0.29 s/MB (105 MB, 365 MB, 1.06 GB,
 *  1.87 GB models, chunker and tiler included): the worst, rounded up. */
export const GEOMETRY_S_PER_MB = 0.4;
/** Navisworks reader: per MB of the file. The 509 MB federation opened in 6.8 min = 0.80 s/MB for the whole open
 *  (sections, tree, pieces, tiles); a single section is a part of that. */
export const NAVISWORKS_S_PER_MB = 0.8;
/** rvt-rs unpacking and scanning a Revit file, per MB of the .rvt (the whole reader: unpack, scan, IFC written). Measured on
 *  the owner's PC (benchmark 261 ms, factor 1), 3 runs each: 0.28 s/MB (the Helsinki model, 11.4 MB), 0.11-0.14 (17.8 MB),
 *  0.18-0.21 (5.7 MB), 0.21-0.23 (5.3 MB): the worst, rounded up. The unpack is also watched by its memory growth. */
export const REVIT_S_PER_MB = 0.3;
/** Microsoft Project's COM open and save as XML, per MB of the .mpp (Project's start included). Measured on the owner's PC,
 *  3 runs each: 0.72-0.87 s/MB (4.9 MB, 4.2 MB), 6.1-9.8 (0.58 MB), 12.2-12.9 (0.46 MB), 9.0-9.2 (0.40 MB); small files
 *  are Project's 3.5 s start: the worst, rounded up. */
export const MSPROJECT_S_PER_MB = 13;
/** MPXJ turning a .mpp into Microsoft Project XML (Java's start included), per MB of the .mpp. Measured on the owner's PC,
 *  3 runs each: 0.18-0.19 s/MB (4.9 MB, 4.2 MB), 1.29-1.39 (0.58, 0.46 MB), 1.71-1.74 (0.40 MB; Java's 0.6 s start): the
 *  worst, rounded up. */
export const MPXJ_S_PER_MB = 1.8;
/** The IFC index (stepIndex: the streaming STEP pass and the index built from it, in the server's own process), per MB of the IFC.
 *  Measured 0.095, 0.096, 0.098 s/MB (105 MB, 365 MB, 1.06 GB models, section 6 "open (index only)"): rounded up. */
export const INDEX_S_PER_MB = 0.1;
export const RATES = { geometry: GEOMETRY_S_PER_MB, navisworks: NAVISWORKS_S_PER_MB, revit: REVIT_S_PER_MB, msproject: MSPROJECT_S_PER_MB, mpxj: MPXJ_S_PER_MB, index: INDEX_S_PER_MB };
/** An opaque call is ended past this many times its expected time (owner decision 2026-10-28). */
export const BOUND_MULTIPLE = 10;

// ---- the rate on THIS machine ----------------------------------------------------------------------------------------
/** The benchmark's time (ms) on the machine the rates above were measured on (a 4 vCPU hosted VM). */
export const BENCH_REFERENCE_MS = 285;
/** Three runs of a fixed arithmetic and typed-array loop (about 300 ms in all); the least of the three, times three (ms). */
export function benchmarkMs() {
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const a = new Float64Array(4096), t = process.hrtime.bigint();
    let x = 1;
    for (let i = 0; i < 60_000_000; i++) { x = x * 1.0000001 + (i & 7) * 0.5; a[i & 4095] = x; }
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6 + (a[5] > 1e99 ? 1 : 0));
  }
  return best * 3;
}
let machine = 0;
/** How much slower this machine is than the one the rates were measured on: the benchmark once (about 300 ms), clamped to
 *  1..5. P6CLONE_MACHINE_FACTOR (the parent hands it to its workers; tests set it) replaces the measurement. */
export function machineFactor() {
  if (!machine) {
    const given = Number(process.env.P6CLONE_MACHINE_FACTOR);
    machine = given > 0 ? given : benchmarkMs() / BENCH_REFERENCE_MS;
    machine = Math.min(5, Math.max(1, machine));
  }
  return machine;
}
// the job's own measured rates (s/MB): the slowest unit seen so far; the parent passes its own to a child (P6CLONE_OWN_RATES)
const own = (() => { try { return JSON.parse(process.env.P6CLONE_OWN_RATES || '{}'); } catch { return {}; } })();
/** A unit of the job finished: input bytes in ms. The bound of the next unit uses the slower of this and the benchmark rate. */
export function noteRate(kind, ms, bytes) {
  if (!(bytes >= 1048576) || !(ms > 0)) return; // under 1 MB the fixed costs are the time, not the rate
  own[kind] = Math.max(own[kind] ?? 0, ms / 1000 / (bytes / 1048576));
}
/** A new job starts: what the last one measured of itself is not this one's. */
export function forgetRates(kind) { delete own[kind]; }
/** The environment that hands the job's own rates and the machine factor to a child. */
export const rateEnv = () => ({ P6CLONE_OWN_RATES: JSON.stringify(own), P6CLONE_MACHINE_FACTOR: String(machineFactor()) });
/** How long (ms) a call on `bytes` of input is expected to take: the slower of the benchmark-scaled reference rate and the
 *  job's own measured rate. The parent ends it past BOUND_MULTIPLE times this. */
export const expectedMs = (bytes, kind) => (Math.max(0, bytes) / 1048576) * Math.max(RATES[kind] * machineFactor(), own[kind] ?? 0) * 1000;

// ---- what the main thread tells the heartbeat thread (shared memory) -------------------------------------------------
// a plain buffer where shared memory is not offered (the desktop app's page loads this module but never starts the thread)
const shared = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(128 + 256) : new ArrayBuffer(128 + 256), f = new Float64Array(shared, 0, 16), nameBytes = new Uint8Array(shared, 128, 256);
// f: 0 done (progress), 1 alive counter, 2 step sequence, 3 expected ms (an opaque call), 4 cap ms (the whole step's bound), 5 total, 6 memory-growth counts as life
const enc = new TextEncoder();
let cur = { name: 'starting', expect: 0, cap: 0, total: 0, mem: 0 };
function publish() {
  nameBytes.fill(0);
  enc.encodeInto(cur.name, nameBytes.subarray(0, 255));
  f[3] = cur.expect; f[4] = cur.cap; f[5] = cur.total; f[6] = cur.mem;
  f[2]++;
}
/** Progress so far, absolute (elements meshed, bytes written...). */
export const progress = (n) => { f[0] = n; };
/** One more unit done. */
export const tick = () => { f[0]++; };
/** Something happened that shows the loop moves, and is not a unit of work. */
export const alive = () => { f[1]++; };
/** A new step of the job (its name is in the error when it hangs): its counter restarts. o.total: units in all;
 *  o.cap: the work bound (ms, expectedMs) no silence in this step may pass, whatever its own gaps; o.mem: growth of the
 *  process's memory counts as life, up to the step's own bound (o.expect or o.cap, 10 x): an opaque call that cannot tick but is known to grow
 *  while it works; o.expect: the
 *  step is one opaque call of this many ms (a parent forwarding what its child declared). */
export function step(name, o = {}) { f[0] = 0; cur = { name, expect: o.expect ?? 0, cap: o.cap ?? 0, total: o.total ?? 0, mem: o.mem ? 1 : 0 }; publish(); }
/** An opaque call: expectMs is how long it should take (expectedMs); the parent ends it past BOUND_MULTIPLE times that. The
 *  step before it continues after. */
export function opaque(label, expectMs, fn, o = {}) {
  const prev = cur;
  cur = { name: label, expect: Math.max(1, expectMs), cap: 0, total: 0, mem: o.mem ? 1 : 0 }; publish();
  try { return fn(); } finally { cur = prev; publish(); alive(); }
}
export async function opaqueAsync(label, expectMs, fn, o = {}) {
  const prev = cur;
  cur = { name: label, expect: Math.max(1, expectMs), cap: 0, total: 0, mem: o.mem ? 1 : 0 }; publish();
  try { return await fn(); } finally { cur = prev; publish(); alive(); }
}

const THREAD = `
const { workerData: { shared, every, sample, mult } } = require('node:worker_threads');
const fs = require('node:fs');
const f = new Float64Array(shared, 0, 16), nameBytes = new Uint8Array(shared, 128, 256), dec = new TextDecoder();
let lastDone = f[0], lastAlive = f[1], lastSeq = f[2], opaque = f[3] > 0, tickAt = Date.now(), stepAt = tickAt, maxGap = 0, lastBeat = 0, rssMax = process.memoryUsage.rss();
setInterval(() => {
  const now = Date.now(), rss = process.memoryUsage.rss();
  if (f[2] !== lastSeq) { // a new step, or back from an opaque call: the clock restarts; the gap across the boundary is nobody's gap
    lastSeq = f[2]; lastDone = f[0]; lastAlive = f[1]; opaque = f[3] > 0; tickAt = stepAt = now; rssMax = rss;
  } else if (f[0] !== lastDone || (f[1] !== lastAlive && !f[5])) {
    // a tick: done moved on, or (where the loop does not know its total) something happened that is not a unit of work. Where the
    // step knows done and total, only done ADVANCING counts: a loop that goes round again with the same count is silent
    if (!opaque) maxGap = Math.max(maxGap, now - tickAt);
    lastDone = f[0]; lastAlive = f[1]; tickAt = now;
  } else if (f[1] !== lastAlive) { lastAlive = f[1]; }
  else if (f[6] && rss >= rssMax + 1048576 && now - stepAt <= mult * Math.max(f[3], f[4])) {
    // memory growth is life for a call that cannot tick, but only up to its own work bound (10 x the expected time): a slow leak is
    // not alive for ever, and a step with no bound has no such life at all
    tickAt = now; rssMax = rss;
  }
  if (now - lastBeat < every) return;
  lastBeat = now;
  const c = process.cpuUsage();
  let n = 0; while (n < 255 && nameBytes[n]) n++;
  try { fs.writeSync(1, '\\u0001HB ' + JSON.stringify({ cpu: Math.round((c.user + c.system) / 1000), rss, done: f[0], total: f[5], step: dec.decode(nameBytes.subarray(0, n)), expectMs: f[3], capMs: f[4], sinceMs: now - tickAt, stepMs: now - stepAt, maxGapMs: maxGap }) + '\\n'); } catch { /* the parent is gone */ }
}, sample);
`;
/** Start the heartbeat (once, first thing in the worker) when the parent asked for it. */
export function startHeartbeat() {
  const every = Number(process.env.P6CLONE_HEARTBEAT_MS);
  if (!(every > 0)) return;
  publish(); // step "starting"
  const t = new Worker(THREAD, { eval: true, workerData: { shared, every, sample: Math.max(10, Math.min(100, every)), mult: BOUND_MULTIPLE } });
  t.unref();
  t.on('error', () => { /* no heartbeat: the parent then sees silence, and judges it as such */ });
}
