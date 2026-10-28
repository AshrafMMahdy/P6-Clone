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
import { ToolError, adjustReserved, change, config, effectiveBudget, getSession, regrow, reserveMemory, sessions, setRoot, setRoots, usedMemory, workerBudget, type Session } from './runtime.ts';
import { existsSync, rmSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { lobSidecars } from './lob.ts';

type Ctx = { caller: string; job?: any; signal: AbortSignal; progress?: (done: number, total: number, message: string) => void };
interface Snapshot { handle: string; ownerKey: string; db: Session['db']; path: string | null; format: Session['format']; hpd: number; encoding?: Session['encoding']; savedTo?: string; dirty: boolean; bytes: number }
interface Job { id: number; name: string; a: Record<string, any>; caller: string; snap: Snapshot; /** other open projects the call reads (windows_analysis updates by handle): their data goes with the job, read only */ others: Snapshot[]; /** the memory budget in use on the main thread besides this call's own copy */ externalUsed: number; lobSide: unknown; cfg: { root: string | null; readRoot: string | null; writeRoot: string | null; requireOwnerKey: boolean } }
type Answer =
  | { id: number; type: 'progress'; done: number; total: number; message: string }
  | { id: number; type: 'note'; text: string }
  | { id: number; type: 'tmp'; path: string }
  | { id: number; type: 'reserved'; delta: number }
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

function spawnWorker(): Worker {
  const w = new Worker(entry(), { workerData: { p6Compute: true }, resourceLimits: { maxOldGenerationSizeMb: Math.max(1024, Math.floor(effectiveBudget() / 1048576)) } });
  w.unref();
  return w;
}
async function acquire(): Promise<Worker> {
  while (active >= maxWorkers()) await new Promise<void>((r) => waiting.push(r));
  active++;
  const i = idle.pop();
  if (i) { clearTimeout(i.timer); return i.w; }
  return spawnWorker();
}
function release(w: Worker, keep: boolean): void {
  active--;
  if (keep) { const timer = setTimeout(() => { const k = idle.findIndex((x) => x.w === w); if (k >= 0) idle.splice(k, 1); void w.terminate(); }, IDLE_MS); timer.unref(); idle.push({ w, timer }); }
  else void w.terminate();
  waiting.shift()?.();
}
let jobSeq = 0;
const snapshotOf = (s: Session): Snapshot => ({ handle: s.handle, ownerKey: s.ownerKey, db: s.db, path: s.path, format: s.format, hpd: s.hpd, ...(s.encoding ? { encoding: s.encoding } : {}), ...(s.savedTo ? { savedTo: s.savedTo } : {}), dirty: s.dirty, bytes: s.bytes });
/** The other open projects a call reads by handle (windows_analysis: updates[].handle). */
const readsHandles = (name: string, a: Record<string, any>): string[] => (name === 'windows_analysis' && Array.isArray(a.updates) ? a.updates.filter((u: any) => u?.handle).map((u: any) => String(u.handle)) : []);
/** A file the worker was writing: "<folder>/.<name>.<hex>.p6clone-tmp" is the temporary file of "<folder>/<name>" (server.ts writeOutWith). */
export const targetOf = (tmp: string) => join(dirname(tmp), basename(tmp).replace(/^\./, '').replace(/\.[0-9a-f]{8}\.p6clone-tmp$/, ''));
/** After a worker was ended mid-call: remove the temporary files it left, and say exactly which files it had finished. */
export function settleWrites(tmps: Set<string>, since: number): string[] {
  const finished: string[] = [];
  for (const t of tmps) {
    try { if (existsSync(t)) { rmSync(t, { force: true }); continue; } } catch { /* in use: left to the temp cleaner */ }
    const target = targetOf(t);
    try { if (existsSync(target) && statSync(target).mtimeMs >= since - 1000) finished.push(target); } catch { /* gone */ }
  }
  return finished;
}

/** Run a tool call on a copy of its project in a worker thread; its changes come back as a patch applied here as one change. `s` is the
 *  handle's session (the caller holds the handle's queue: nothing else changes it meanwhile). */
export async function offload(name: string, a: Record<string, any>, s: Session, ctx: Ctx): Promise<unknown> {
  const others = readsHandles(name, a).map((h) => getSession(h)).filter((o) => o.handle !== s.handle); // an unknown handle is refused here, as it always was
  const releases: (() => void)[] = [];
  const tmps = new Set<string>(), started = Date.now();
  let worker: Worker | null = null, held = 0; // held: what the worker reserved inside the call, counted here against the budget while it runs
  let healthy = false; // the worker answered (a result or the tool's own refusal): it can serve the next call
  try {
    releases.push(reserveMemory(Math.max(s.bytes, 8 * 1048576), `A copy of the project for the worker that runs ${name}`, 'Close projects you no longer need, then call again.', s.handle));
    for (const o of others) releases.push(reserveMemory(Math.max(o.bytes, 8 * 1048576), `A copy of project ${o.handle} for the worker that runs ${name}`, 'Close projects you no longer need, then call again.', s.handle));
    const w = worker = await acquire();
    const id = ++jobSeq;
    const job: Job = {
      id, name, a, caller: ctx.caller, lobSide: lobSidecars.get(s.handle) ?? null,
      snap: snapshotOf(s), others: others.map(snapshotOf), externalUsed: Math.max(0, usedMemory() - 2 * s.bytes),
      cfg: { root: config.root, readRoot: config.readRoot, writeRoot: config.writeRoot, requireOwnerKey: config.requireOwnerKey },
    };
    const done = await new Promise<Extract<Answer, { type: 'done' }>>((resolve, reject) => {
      const cleanup = () => { w.off('message', onMessage); w.off('error', onError); w.off('exit', onExit); ctx.signal.removeEventListener('abort', onAbort); };
      const onMessage = (m: Answer) => {
        if (m.id !== id) return;
        if (m.type === 'progress') ctx.progress?.(m.done, m.total, m.message);
        else if (m.type === 'note') { if (ctx.job) ctx.job.progress = m.text; }
        else if (m.type === 'tmp') tmps.add(m.path);
        else if (m.type === 'reserved') { held += m.delta; adjustReserved(m.delta); }
        else if (m.type === 'done') { healthy = true; cleanup(); resolve(m); }
        else { healthy = true; cleanup(); reject(m.tool ? new ToolError(m.tool.code, m.tool.message, m.tool.hint, { ...(m.tool.retryAfter ? { retryAfter: m.tool.retryAfter } : {}), ...(m.tool.data ? { data: m.tool.data } : {}) }) : Object.assign(new Error(m.message), m.stack ? { stack: m.stack } : {})); }
      };
      const onError = (e: Error) => { cleanup(); settleWrites(tmps, started); reject(new ToolError('compute_failed', `The worker that runs ${name} stopped: ${e.message}`, /memory/i.test(e.message) ? 'The project is too big for this computation within the memory budget; close other projects or work on part of the plan.' : 'Call again; if it repeats, report it with the message.')); };
      const onExit = (code: number) => { cleanup(); settleWrites(tmps, started); reject(new ToolError('compute_failed', `The worker that runs ${name} ended (code ${code}) before it answered.`, 'Call again.')); };
      // a cancelled call ends its worker at once, even in a synchronous loop: it works on a copy, so nothing is half done
      // (its temporary files go, and what it had finished writing is said)
      const onAbort = () => {
        cleanup();
        void w.terminate().then(() => {
          const finished = settleWrites(tmps, started);
          reject(new ToolError('cancelled', finished.length ? `The call was cancelled after it had finished writing ${finished.join(', ')}; nothing else was written.` : 'The call was cancelled.', finished.length ? 'Those files are complete; delete them if you do not want them.' : 'Nothing was kept or written by it; call again when needed.', finished.length ? { data: { written: finished } } : {}));
        });
      };
      w.on('message', onMessage); w.once('error', onError); w.once('exit', onExit);
      if (ctx.signal.aborted) return onAbort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      w.postMessage(job);
    });
    if (done.patch && !isEmptyPatch(done.patch)) change(s, ctx.caller, done.label || name, (d) => applyPatch(d, done.patch!));
    if (done.lobSide) lobSidecars.set(s.handle, done.lobSide as never);
    regrow(s);
    return done.result;
  } finally { adjustReserved(-held); for (const r of releases) r(); if (worker) release(worker, healthy); }
}

// ---------------------------------------------------------------- the worker thread
/** Start the worker loop (server.ts calls it when it is started with workerData.p6Compute). `run` is the server's own tool runner. */
export function startComputeWorker(run: (name: string, a: Record<string, any>, ctx: any) => Promise<unknown>, hookWrites: (notice: (tmp: string) => void) => void): void {
  if (isMainThread || !workerData?.p6Compute || !parentPort) return;
  const port = parentPort;
  const post = (m: Answer) => port.postMessage(m);
  let rooted = '', current = 0;
  hookWrites((tmp) => post({ id: current, type: 'tmp', path: tmp })); // a file about to be written: if the call is ended, the main thread removes it

  port.on('message', async (job: Job) => {
    current = job.id;
    workerBudget({ externalUsed: job.externalUsed, notice: (delta) => post({ id: job.id, type: 'reserved', delta }) });
    const key = JSON.stringify(job.cfg);
    if (key !== rooted) { rooted = key; setRoot(job.cfg.root); setRoots(job.cfg.readRoot, job.cfg.writeRoot); config.requireOwnerKey = job.cfg.requireOwnerKey; }
    const t = job.snap;
    const s: Session = { handle: t.handle, ownerKey: t.ownerKey, db: t.db, path: t.path, format: t.format, hpd: t.hpd, ...(t.encoding ? { encoding: t.encoding } : {}), ...(t.savedTo ? { savedTo: t.savedTo } : {}), history: [], redo: new Map(), dirty: t.dirty, lastUsed: Date.now(), bytes: t.bytes };
    sessions.set(s.handle, s);
    for (const o of job.others) sessions.set(o.handle, { handle: o.handle, ownerKey: o.ownerKey, db: o.db, path: o.path, format: o.format, hpd: o.hpd, ...(o.encoding ? { encoding: o.encoding } : {}), ...(o.savedTo ? { savedTo: o.savedTo } : {}), history: [], redo: new Map(), dirty: o.dirty, lastUsed: Date.now(), bytes: o.bytes });
    if (job.lobSide) lobSidecars.set(s.handle, job.lobSide as never);
    let last = 0;
    const ctx: Ctx = {
      caller: job.caller, signal: new AbortController().signal,
      progress: (done, total, message) => post({ id: job.id, type: 'progress', done, total, message }),
      job: { set progress(text: string | undefined) { const now = Date.now(); if (now - last > 250) { last = now; post({ id: job.id, type: 'note', text: String(text) }); } } },
    };
    try {
      const result = await run(job.name, job.a, ctx);
      const patch = s.history.length ? patchFrom(s.db, s.history.map((c) => c.j)) : null;
      post({ id: job.id, type: 'done', result, patch, label: s.history[0]?.label ?? job.name, lobSide: lobSidecars.get(s.handle) ?? null });
    } catch (e) {
      const t2 = e as ToolError;
      post({ id: job.id, type: 'error', tool: e instanceof ToolError ? { code: t2.code, message: t2.message, ...(t2.hint ? { hint: t2.hint } : {}), ...(t2.retryAfter ? { retryAfter: t2.retryAfter } : {}), ...(t2.data ? { data: t2.data } : {}) } : null, message: (e as Error)?.message ?? String(e), stack: (e as Error)?.stack });
    } finally { sessions.delete(s.handle); for (const o of job.others) sessions.delete(o.handle); lobSidecars.delete(s.handle); }
  });
}
