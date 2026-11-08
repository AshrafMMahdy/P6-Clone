// Long computations off the server's main thread. The root cause of one call freezing the others is heavy synchronous work on the single
// thread that serves every handle: a Monte Carlo of 20,000 iterations, a crash or optimiser search, a levelling run, F9 on a big
// programme, a PDF. The main thread now only routes: a tool that can run long (see OFFLOAD in server.ts) runs on a COPY of its project in a
// worker thread (this file: the same server code, started with workerData.p6Compute), and hands back its answer and its changes as a patch
// (journalPatch.ts), which the main thread applies as one undoable change of the handle. Other handles' calls, the heartbeat of the
// server, job_status and cancel_job are never behind it. Cancelling a call ends its worker at once (terminate(): even a worker in a
// synchronous loop), which is safe because the worker works on a copy.
// What the copy costs: the main thread serialises the project once per call (milliseconds per 10,000 activities) and the memory budget
// reserves the copy. What does not move, and why: opening and saving files (they CREATE or serialise the session's database: the main
// thread would pay the copy of the whole result), editing (finite, fast operations on the database itself), and the 4D tools, which work on
// models held in the main process (their heavy parts already run in worker processes: geometry, index, readers).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatch, isEmptyPatch, patchFrom, type DbPatch } from '../core/journalPatch.ts';
import { ToolError, adjustReserved, change, config, countMemory, effectiveBudget, getSession, regrow, reserveMemory, sessions, setRoot, setRoots, usedMemory, workerBudget, type Session } from './runtime.ts';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cwdLost, ensureCwd, markCwdLost, safeCwd } from '../core/cwd.ts';
import { lobSidecars } from './lob.ts';
import { unitWatch } from '../core/bim/liveness.ts';
import { formatP6Date } from '../core/dates.ts';

type Ctx = { caller: string; job?: any; signal: AbortSignal; progress?: (done: number, total: number, message: string) => void; /** a finished row of the answer, sent out as it is done (kept if the worker is ended) */ keep?: (row: unknown) => void };
interface Snapshot { handle: string; ownerKey: string; db: Session['db']; path: string | null; format: Session['format']; hpd: number; encoding?: Session['encoding']; savedTo?: string; dirty: boolean; bytes: number }
interface Job { id: number; /** this job's tag in its temporary files' names, and where the worker logs them (readable even after the worker is ended) */ token: string; tmpLog: SharedArrayBuffer; name: string; a: Record<string, any>; caller: string; snap: Snapshot; /** other open projects the call reads (windows_analysis updates by handle): their data goes with the job, read only */ others: Snapshot[]; /** the memory budget in use on the main thread besides this call's own copy */ externalUsed: number; lobSide: unknown; cfg: { cwdLost: string | null; root: string | null; readRoot: string | null; writeRoot: string | null; requireOwnerKey: boolean } }
type Answer =
  | { id: number; type: 'progress'; done: number; total: number; message: string }
  | { id: number; type: 'note'; text: string }
  | { id: number; type: 'reserved'; delta: number }
  | { id: number; type: 'kept'; row: unknown }
  | { id: number; type: 'done'; result: unknown; patch: DbPatch | null; label: string; lobSide: unknown }
  | { id: number; type: 'error'; tool: { code: string; message: string; hint?: string; retryAfter?: number; data?: Record<string, unknown> } | null; message: string; stack?: string };

// ---------------------------------------------------------------- the main thread
/** The file the worker threads run: the server's own entry (the bundle, or server.ts in the repository), started with workerData.p6Compute. */
function entry(): string {
  try { if (typeof __filename === 'string' && /p6clone-mcp|server\.(cjs|js)$/.test(__filename)) return __filename; } catch { /* ESM */ }
  return join(dirname(fileURLToPath(import.meta.url)), 'server.ts');
}
const maxWorkers = () => Math.max(2, Number(process.env.P6CLONE_COMPUTE_WORKERS) || Math.max(2, cpus().length - 1));
const idle: { w: Worker; timer: NodeJS.Timeout }[] = [];
let active = 0;
const waiting: (() => void)[] = [];
const IDLE_MS = 60_000;
/** Tools that keep their finished work when cancelled: the worker is asked to stop at its next step and answers with what it has
 *  (partial). There is no fixed time limit and no stop while it works: it is ended only when FROZEN (no progress and no busy time of
 *  its thread for two windows in a row: the platform's rule, liveness.ts), and then the rows it had sent out (ctx.keep) are the answer. */
const STOPS_GRACEFULLY = new Set(['monte_carlo', 'evaluate_batch']);
/** A worker thread's own processor time so far (ms): Worker.cpuUsage (Node 22.19+). Undefined where it is not offered: no reading.
 *  (Not the event loop's busy time: a thread blocked waiting reads as busy there.) */
export const threadCpu = (w: Worker): (() => Promise<number>) | undefined => (typeof (w as { cpuUsage?: unknown }).cpuUsage === 'function'
  ? async () => { const c = await (w as unknown as { cpuUsage(): Promise<{ user: number; system: number }> }).cpuUsage(); return (c.user + c.system) / 1000; }
  : undefined);
/** The answer a tool's kept rows make when its worker was ended (frozen) before it answered: only tools whose rows ARE their answer. */
export const FROM_KEPT: Record<string, (rows: unknown[], a: Record<string, any>) => unknown> = {
  evaluate_batch: (rows, a) => ({ ok: true, partial: true, stopped: 'cancelled', scenarios: rows, scenarios_done: rows.length, scenarios_requested: Array.isArray(a.scenarios) ? a.scenarios.length : rows.length, best: null, note: 'The worker stopped responding after the cancel and was ended; these are the scenarios it had finished (the base and the best are not worked out).' }),
  // each finished iteration's project finish: the finish statistics are exact for those iterations; what needs every activity's samples is not kept
  monte_carlo: (rows, a) => {
    const f = rows.map(Number).filter(Number.isFinite).sort((x, y) => x - y), n = f.length;
    const at = (p: number) => formatP6Date(f[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]);
    const mean = f.reduce((x, y) => x + y, 0) / n;
    return { partial: true, stopped: 'cancelled', iterations_done: rows.length, iterations_requested: Math.min(20000, Math.max(10, Math.floor(Number(a.iterations) || 1000))),
      finish: { P10: at(0.1), P50: at(0.5), P80: at(0.8), P90: at(0.9), mean: formatP6Date(mean), min: formatP6Date(f[0]), max: formatP6Date(f[n - 1]) },
      note: `The worker stopped responding after the cancel and was ended; these finish dates are of the ${rows.length} iterations it had finished (criticality, sensitivity, milestones and the histogram need every activity's samples and are not worked out: run it again for them).` };
  },
};

// The workers' own runtime (a Node isolate: measured 37 MB each) is counted once per live worker in the memory budget, not again in every call:
// a job reserves what it adds to a worker that is there already. Idle workers give theirs back when memory is wanted (trim).
const live = new Set<Worker>();
/** What one worker's runtime takes (measured 37 MB, rounded up). */
export const WORKER_RUNTIME_BYTES = 40 * 1048576;
countMemory(() => live.size * WORKER_RUNTIME_BYTES, () => { for (const i of idle.splice(0)) { clearTimeout(i.timer); stop(i.w); } });
function stop(w: Worker): void { live.delete(w); void w.terminate(); }
function spawnWorker(): Worker {
  ensureCwd();
  // room for a new runtime is made (idle workers and idle projects go first) or the call is refused, in words
  reserveMemory(WORKER_RUNTIME_BYTES, 'A new worker thread (its own runtime)', 'Close projects you no longer need, or retry when the running calls have finished.')();
  const w = new Worker(entry(), { workerData: { p6Compute: true }, resourceLimits: { maxOldGenerationSizeMb: Math.max(1024, Math.floor(effectiveBudget() / 1048576)) } });
  w.unref();
  live.add(w);
  w.once('exit', () => live.delete(w));
  return w;
}
async function acquire(): Promise<Worker> {
  while (active >= maxWorkers()) await new Promise<void>((r) => waiting.push(r));
  const i = idle.pop();
  if (i) { clearTimeout(i.timer); active++; return i.w; }
  const w = spawnWorker();
  active++;
  return w;
}
function release(w: Worker, keep: boolean): void {
  active--;
  if (keep) { const timer = setTimeout(() => { const k = idle.findIndex((x) => x.w === w); if (k >= 0) idle.splice(k, 1); stop(w); }, IDLE_MS); timer.unref(); idle.push({ w, timer }); }
  else stop(w);
  waiting.shift()?.();
}
let jobSeq = 0;
/** What a call adds in a worker that is there already, on a project of `bytes` (the session's estimate): the copy and the engines' working memory
 *  on top, measured on a 12 MB XER (a 43 MB session; peak over the runtime): schedule 1.9 x, levelling 2.0, check 2.0, crash 1.0, evaluate 1.2,
 *  PDF 1.0, DCMA 0.4 - so 2 x. Monte Carlo (2.8 x) and the other tools workset.ts knows reserve their own working set on top, as they always
 *  did (server.ts withWorkingSet). The worker's runtime is counted per worker (WORKER_RUNTIME_BYTES), not here. */
export const WORKER_PEAK_PER_SESSION_BYTE = 2;
export const workerPeak = (sessionBytes: number) => WORKER_PEAK_PER_SESSION_BYTE * Math.max(sessionBytes, 8 * 1048576);
/** offload() answer when the worker could not be afforded and nothing else is running: the caller runs the tool here, as before workers existed
 *  (the tool's own working-set check still refuses what cannot fit). */
export const RUN_HERE = Symbol('run here');
const snapshotOf = (s: Session): Snapshot => ({ handle: s.handle, ownerKey: s.ownerKey, db: s.db, path: s.path, format: s.format, hpd: s.hpd, ...(s.encoding ? { encoding: s.encoding } : {}), ...(s.savedTo ? { savedTo: s.savedTo } : {}), dirty: s.dirty, bytes: s.bytes });
/** The other open projects a call reads by handle (windows_analysis: updates[].handle). */
const readsHandles = (name: string, a: Record<string, any>): string[] => (name === 'windows_analysis' && Array.isArray(a.updates) ? a.updates.filter((u: any) => u?.handle).map((u: any) => String(u.handle))
  : (name === 'import_file' || name === 'transfer_progress') && a.other_handle ? [String(a.other_handle)] : []);
/** A file the worker was writing: "<folder>/.<name>.<tag><hex>.p6clone-tmp" is the temporary file of "<folder>/<name>" (server.ts writeOutWith). */
export const targetOf = (tmp: string) => join(dirname(tmp), basename(tmp).replace(/^\./, '').replace(/\.(?:j[0-9a-f]{6}-)?[0-9a-f]{8}\.p6clone-tmp$/, ''));
const tagOf = (token: string) => `j${token}-`;
// The temporary files a worker is about to write are logged in shared memory BEFORE they are made: a message could be lost when the worker
// is ended at once, memory the main thread holds is not. Layout: Int32 [0] = bytes used; then paths, each ended by a NUL.
export function logTmp(log: SharedArrayBuffer, path: string): void {
  const used = new Int32Array(log, 0, 1), bytes = Buffer.from(`${path}\0`, 'utf8'), at = 4 + Atomics.load(used, 0);
  if (at + bytes.length > log.byteLength) return; // full: the sweep by name still finds the file
  new Uint8Array(log, at, bytes.length).set(bytes);
  Atomics.store(used, 0, at - 4 + bytes.length);
}
export const readTmpLog = (log: SharedArrayBuffer): string[] => Buffer.from(new Uint8Array(log, 4, Atomics.load(new Int32Array(log, 0, 1), 0))).toString('utf8').split('\0').filter(Boolean);
/** The folders a call may have written into: those of the temporary files logged, and those its arguments name (a path, or a folder). */
function foldersOf(logged: string[], a: Record<string, any>): string[] {
  const dirs = new Set(logged.map((t) => dirname(t))), base = config.writeRoot ?? config.root ?? safeCwd();
  const walk = (v: unknown, depth: number) => {
    if (dirs.size > 40 || depth > 3) return;
    if (typeof v === 'string' && v.length < 1024) {
      try { const p = resolve(base, v); dirs.add(dirname(p)); if (existsSync(p) && statSync(p).isDirectory()) dirs.add(p); } catch { /* not a path */ }
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(a, 0);
  return [...dirs];
}
/** After a worker was ended mid-call: remove the temporary files it left (the ones logged, and any of this job's by name), and say
 *  exactly which files it had finished. */
export function settleWrites(logged: string[], since: number, folders: string[] = [], token = ''): string[] {
  const finished: string[] = [];
  for (const t of logged) {
    try { if (existsSync(t)) { rmSync(t, { force: true }); continue; } } catch { /* in use: left to the temp cleaner */ }
    const target = targetOf(t);
    try { if (existsSync(target) && statSync(target).mtimeMs >= since - 1000) finished.push(target); } catch { /* gone */ }
  }
  if (token) for (const d of folders) {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) if (n.startsWith('.') && n.endsWith('.p6clone-tmp') && n.includes(`.${tagOf(token)}`)) { try { rmSync(join(d, n), { force: true }); } catch { /* in use */ } }
  }
  return finished;
}

/** Run a tool call on a copy of its project in a worker thread; its changes come back as a patch applied here as one change. `s` is the
 *  handle's session (the caller holds the handle's queue: nothing else changes it meanwhile). */
export async function offload(name: string, a: Record<string, any>, s: Session, ctx: Ctx): Promise<unknown> {
  const others = readsHandles(name, a).map((h) => getSession(h)).filter((o) => o.handle !== s.handle); // an unknown handle is refused here, as it always was
  const releases: (() => void)[] = [];
  const started = Date.now(), token = randomBytes(3).toString('hex'), tmpLog = new SharedArrayBuffer(1 << 16);
  const settle = () => settleWrites(readTmpLog(tmpLog), started, foldersOf(readTmpLog(tmpLog), a), token);
  let worker: Worker | null = null, held = 0; // held: what the worker reserved inside the call, counted here against the budget while it runs
  let healthy = false; // the worker answered (a result or the tool's own refusal): it can serve the next call
  try {
    // what the worker adds is reserved before it starts (a new runtime is counted when it is made), so the workers running together never add up
    // past the budget. Nothing else running and no room for a worker: the tool runs here, in the server, as it did before workers (RUN_HERE);
    // while other calls run, a call that would overshoot is refused with a way forward.
    try {
      releases.push(reserveMemory(workerPeak(s.bytes), `The worker that runs ${name} (a copy of the project and its working memory)`, 'Close projects you no longer need, or retry when the running calls have finished.', s.handle));
      for (const o of others) releases.push(reserveMemory(Math.max(o.bytes, 8 * 1048576), `A copy of project ${o.handle} for the worker that runs ${name}`, 'Close projects you no longer need, then call again.', s.handle));
      worker = await acquire();
    } catch (e) {
      if (e instanceof ToolError && e.code === 'memory_budget' && active === 0 && !worker) return RUN_HERE;
      throw e;
    }
    const w = worker;
    const id = ++jobSeq;
    const job: Job = {
      id, token, tmpLog, name, a, caller: ctx.caller, lobSide: lobSidecars.get(s.handle) ?? null,
      snap: snapshotOf(s), others: others.map(snapshotOf), externalUsed: Math.max(0, usedMemory() - 2 * s.bytes),
      cfg: { cwdLost: cwdLost(), root: config.root, readRoot: config.readRoot, writeRoot: config.writeRoot, requireOwnerKey: config.requireOwnerKey },
    };
    const done = await new Promise<Extract<Answer, { type: 'done' }>>((resolve, reject) => {
      // watched from the start (its line says when it works without progress); ended only once a stop was asked AND it is frozen
      // (no progress, no busy time of its thread, two windows in a row — liveness.ts). Its busy time: the thread's event loop use.
      let stopping = false, frozen = false;
      const kept: unknown[] = [];
      // its processor time: the thread's own (Worker.cpuUsage, Node 22.19+); where that is not offered there is no reading (frozen after
      // three windows with no progress, as the platform's rule). Not the event loop's busy time: a thread blocked waiting reads as busy there.
      const cpu = threadCpu(w);
      // (a watch that found it frozen stops; progress after that starts a new one: frozen is the state now, not once)
      const watchNew = () => unitWatch({ step: name, cpu, onStuck: () => { frozen = true; if (stopping) kill(); } });
      let watch = watchNew();
      const cleanup = () => { watch.stop(); w.off('message', onMessage); w.off('error', onError); w.off('exit', onExit); ctx.signal.removeEventListener('abort', onAbort); };
      const onMessage = (m: Answer) => {
        if (m.id !== id) return;
        if (m.type === 'progress') { if (frozen) { frozen = false; watch = watchNew(); } watch.beat(m.done, m.total); ctx.progress?.(m.done, m.total, m.message); }
        else if (m.type === 'kept') kept.push(m.row);
        else if (m.type === 'note') { if (ctx.job) ctx.job.progress = m.text; }
        else if (m.type === 'reserved') { held += m.delta; adjustReserved(m.delta); }
        else if (m.type === 'done') { healthy = true; cleanup(); resolve(m); }
        else { healthy = true; cleanup(); reject(m.tool ? new ToolError(m.tool.code, m.tool.message, m.tool.hint, { ...(m.tool.retryAfter ? { retryAfter: m.tool.retryAfter } : {}), ...(m.tool.data ? { data: m.tool.data } : {}) }) : Object.assign(new Error(m.message), m.stack ? { stack: m.stack } : {})); }
      };
      const onError = (e: Error) => { cleanup(); settle(); reject(new ToolError('compute_failed', `The worker that runs ${name} stopped: ${e.message}`, /memory/i.test(e.message) ? 'The project is too big for this computation within the memory budget; close other projects or work on part of the plan.' : 'Call again; if it repeats, report it with the message.')); };
      const onExit = (code: number) => { cleanup(); settle(); reject(new ToolError('compute_failed', `The worker that runs ${name} ended (code ${code}) before it answered.`, 'Call again.')); };
      // A cancelled call that can stop gracefully (STOPS_GRACEFULLY) is asked to stop and answers with what it finished; it is
      // ended only if it is frozen (above). Any other call ends its worker at once, even in a synchronous loop: it works on a
      // copy, so nothing is half done (its temporary files go, and what it had finished writing is said).
      const onAbort = () => {
        if (STOPS_GRACEFULLY.has(name) && !stopping) { stopping = true; w.postMessage({ stop: id }); if (frozen) kill(); return; }
        kill();
      };
      const kill = () => {
        cleanup();
        void w.terminate().then(() => {
          const finished = settle();
          // the rows it had sent out are kept: they are the answer (marked partial) where the tool's rows are its answer
          if (stopping && kept.length && FROM_KEPT[name]) { resolve({ id, type: 'done', result: FROM_KEPT[name](kept, a), patch: null, label: name, lobSide: null }); return; }
          reject(new ToolError('cancelled', finished.length ? `The call was cancelled after it had finished writing ${finished.join(', ')}; nothing else was written.` : 'The call was cancelled.', finished.length ? 'Those files are complete; delete them if you do not want them.' : 'Nothing was kept or written by it; call again when needed.', finished.length ? { data: { written: finished } } : {}));
        });
      };
      w.on('message', onMessage); w.once('error', onError); w.once('exit', onExit);
      // cancelled before the job was sent (while it waited for a worker or memory): nothing ran, the worker stays idle and healthy
      if (ctx.signal.aborted) { cleanup(); healthy = true; return reject(new ToolError('cancelled', 'The call was cancelled before it started.', 'Nothing was done or written; call again when needed.')); }
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      w.postMessage(job);
    });
    if (done.patch && !isEmptyPatch(done.patch)) change(s, ctx.caller, done.label || name, (d) => applyPatch(d, done.patch!));
    if (done.lobSide) lobSidecars.set(s.handle, done.lobSide as never);
    if (name.startsWith('lob_') || name === 'import_file') regrow(s); // (as the server does: an LOB plan or an imported project adds thousands of rows)
    return done.result;
  } finally { adjustReserved(-held); for (const r of releases) r(); if (worker) release(worker, healthy); }
}

// ---------------------------------------------------------------- the reasoner's status
type ReasonerState = { loaded: boolean | null; model: string | null; runtime?: string; checking?: boolean; error?: string };
let reasonerKnown: ReasonerState | null = null, reasonerAsked = false;
/** server_status asks "did the schedule reasoner load?". Loading the ONNX model takes 0.3-0.8 s of synchronous work, which on the server's main
 *  thread stalled every other call (and let a job being watched finish before the caller could look at it). It is loaded once in a throw-away
 *  worker thread; until that has answered the status says it is checking (loaded: null), and every later call has the answer at once. */
export function reasonerState(inProcess: () => Promise<ReasonerState>, modelPath: () => string | null): ReasonerState {
  if (reasonerKnown) return reasonerKnown;
  if (!reasonerAsked) {
    reasonerAsked = true;
    const done = (r: ReasonerState) => { reasonerKnown = r; };
    const here = () => { void inProcess().then(done, (e) => done({ loaded: false, model: modelPath(), error: (e as Error).message })); };
    if (process.env.P6CLONE_COMPUTE_WORKERS === '0') here();
    else {
      try {
        const w = new Worker(entry(), { workerData: { p6Reasoner: true } });
        w.unref();
        w.once('message', (m: ReasonerState) => { done(m); void w.terminate(); });
        w.once('error', () => { reasonerAsked = true; here(); });
      } catch { here(); }
    }
  }
  return { loaded: null, model: modelPath(), checking: true };
}
/** In the throw-away worker (server.ts starts it with workerData.p6Reasoner): load the model and say so. */
export function answerReasoner(status: () => Promise<ReasonerState>): void {
  if (isMainThread || !workerData?.p6Reasoner || !parentPort) return;
  const port = parentPort;
  void status().then((r) => port.postMessage(r), (e) => port.postMessage({ loaded: false, model: null, error: (e as Error).message }));
}

// ---------------------------------------------------------------- the worker thread
/** Start the worker loop (server.ts calls it when it is started with workerData.p6Compute). `run` is the server's own tool runner. */
export function startComputeWorker(run: (name: string, a: Record<string, any>, ctx: any) => Promise<unknown>, hookWrites: (notice: (tmp: string) => void) => { value: string }): void {
  if (isMainThread || !workerData?.p6Compute || !parentPort) return;
  const port = parentPort;
  const post = (m: Answer) => port.postMessage(m);
  let rooted = '', log: SharedArrayBuffer | null = null;
  const tag = hookWrites((tmp) => { if (log) logTmp(log, tmp); }); // a file about to be written is logged where the main thread can read it even if this worker is ended at once

  let stopJob: ((id: number) => void) | null = null; // the main thread asks the running job to stop at its next step
  port.on('message', async (job: Job | { stop: number }) => {
    if ('stop' in job) { stopJob?.(job.stop); return; }
    log = job.tmpLog; tag.value = tagOf(job.token);
    workerBudget({ externalUsed: job.externalUsed, notice: (delta) => post({ id: job.id, type: 'reserved', delta }) });
    markCwdLost(job.cfg.cwdLost); // (the worker cannot move the process; the main thread says that the folder it started in is gone)
    const key = JSON.stringify(job.cfg);
    if (key !== rooted) { rooted = key; setRoot(job.cfg.root); setRoots(job.cfg.readRoot, job.cfg.writeRoot); config.requireOwnerKey = job.cfg.requireOwnerKey; }
    const t = job.snap;
    const s: Session = { handle: t.handle, ownerKey: t.ownerKey, db: t.db, path: t.path, format: t.format, hpd: t.hpd, ...(t.encoding ? { encoding: t.encoding } : {}), ...(t.savedTo ? { savedTo: t.savedTo } : {}), history: [], redo: new Map(), dirty: t.dirty, lastUsed: Date.now(), bytes: t.bytes };
    sessions.set(s.handle, s);
    for (const o of job.others) sessions.set(o.handle, { handle: o.handle, ownerKey: o.ownerKey, db: o.db, path: o.path, format: o.format, hpd: o.hpd, ...(o.encoding ? { encoding: o.encoding } : {}), ...(o.savedTo ? { savedTo: o.savedTo } : {}), history: [], redo: new Map(), dirty: o.dirty, lastUsed: Date.now(), bytes: o.bytes });
    if (job.lobSide) lobSidecars.set(s.handle, job.lobSide as never);
    let last = 0;
    const stopper = new AbortController();
    stopJob = (id) => { if (id === job.id) stopper.abort(); };
    const ctx: Ctx = {
      caller: job.caller, signal: stopper.signal,
      progress: (done, total, message) => post({ id: job.id, type: 'progress', done, total, message }),
      keep: (row) => post({ id: job.id, type: 'kept', row }),
      job: { set progress(text: string | undefined) { const now = Date.now(); if (now - last > 250) { last = now; post({ id: job.id, type: 'note', text: String(text) }); } } },
    };
    try {
      const result = await run(job.name, job.a, ctx);
      const patch = s.history.length ? patchFrom(s.db, s.history.map((c) => c.j)) : null;
      post({ id: job.id, type: 'done', result, patch, label: s.history[0]?.label ?? job.name, lobSide: lobSidecars.get(s.handle) ?? null });
    } catch (e) {
      const t2 = e as ToolError;
      post({ id: job.id, type: 'error', tool: e instanceof ToolError ? { code: t2.code, message: t2.message, ...(t2.hint ? { hint: t2.hint } : {}), ...(t2.retryAfter ? { retryAfter: t2.retryAfter } : {}), ...(t2.data ? { data: t2.data } : {}) } : null, message: (e as Error)?.message ?? String(e), stack: (e as Error)?.stack });
    } finally { stopJob = null; sessions.delete(s.handle); for (const o of job.others) sessions.delete(o.handle); lobSidecars.delete(s.handle); }
  });
}
