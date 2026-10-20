// MCP server runtime: open projects ("handles") shared by several agents without dead stops.
//  - Unguessable handles for editing; an owner key (returned at open) for save, close and undoing other callers' work.
//  - One call at a time per handle (a queue); a call that would wait too long gets "busy" with a retry time instead
//    of hanging.
//  - Every change is one journal entry tagged with its caller: undo reverts the caller's own last change (refusing
//    only when someone else's later change touched the same items), redo re-applies it.
//  - Memory: projects are admitted against a budget; idle or least recently used projects are moved out to a lossless
//    recovery file and come back by themselves on the next call (nothing is ever discarded).
//  - Long work can run as a job that the agent checks with job_status.
//  - With a root folder, every path is confined to it (symlinks resolved); --automation-read-root / --automation-write-root
//    fence reads (read or write root) and writes (write root) separately, like the craft forks.
//  - Every failure is a ToolError with a code and a next step.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync, writeSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { ABSENT, record, rollback, type Journal } from '../core/journal.ts';
import { dbLines, DbReader } from '../core/db-file.ts';
import type { Db } from '../core/db.ts';
import type { Format } from '../renderer/io.ts';

// ---------------------------------------------------------------- errors with a way forward
export class ToolError extends Error {
  code: string; hint?: string; retryAfter?: number; data?: Record<string, unknown>;
  constructor(code: string, message: string, hint?: string, extra: { retryAfter?: number; data?: Record<string, unknown> } = {}) {
    super(message); this.code = code; this.hint = hint; this.retryAfter = extra.retryAfter; this.data = extra.data;
  }
}
export const fail = (code: string, message: string, hint?: string, extra?: { retryAfter?: number; data?: Record<string, unknown> }): never => { throw new ToolError(code, message, hint, extra); };

// ---------------------------------------------------------------- configuration
export interface Config {
  root: string | null; readRoot: string | null; writeRoot: string | null; requireOwnerKey: boolean; maxHandles: number; budgetBytes: number; idleMinutes: number;
  memFactor: number; busyWaitMs: number; softTimeoutMs: number; maxResponseChars: number;
}
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const config: Config = {
  root: null, readRoot: null, writeRoot: null, requireOwnerKey: false,
  maxHandles: num(process.env.P6CLONE_MAX_HANDLES, 8),
  budgetBytes: num(process.env.P6CLONE_MEM_BUDGET_MB, 3072) * 1048576,
  idleMinutes: num(process.env.P6CLONE_IDLE_MINUTES, 30),
  memFactor: num(process.env.P6CLONE_MEM_FACTOR, 3), // memory per byte of file: a parsed XER takes ~2x, plus undo and schedule work
  busyWaitMs: num(process.env.P6CLONE_BUSY_WAIT_MS, 20000),
  softTimeoutMs: num(process.env.P6CLONE_SOFT_TIMEOUT_MS, 25000),
  maxResponseChars: num(process.env.P6CLONE_MAX_RESPONSE_CHARS, 400000),
};
/** What the process can really hold: the budget, but never more than V8's heap limit allows. */
export const effectiveBudget = () => Math.min(config.budgetBytes, getHeapStatistics().heap_size_limit - 512 * 1048576);

// ---------------------------------------------------------------- paths
const real = new Map<string, string>(); // root -> its real path
const made = (dir: string | null | undefined, create: boolean) => {
  if (!dir) return null;
  const d = resolve(dir);
  if (create) mkdirSync(d, { recursive: true });
  real.set(d, existsSync(d) ? realpathSync(d) : d);
  return d;
};
export function setRoot(dir: string | null): void { config.root = made(dir, true); }
/** --automation-read-root / --automation-write-root (the write root is created when missing). */
export function setRoots(read: string | null | undefined, write: string | null | undefined): void { config.readRoot = made(read, false); config.writeRoot = made(write, true); }
/** Where writes go and relative write paths start: the write root, else the storage root. */
export const writeBase = () => config.writeRoot ?? config.root;
const fences = (mode: 'read' | 'write') => (mode === 'write' ? [writeBase()] : config.readRoot || config.writeRoot ? [config.readRoot, writeBase()] : [config.root]).filter((x): x is string => !!x);
/** A path argument, made absolute and kept inside the roots (when there are any), symlinks included. Reading: the read
 *  root or the write root; writing: the write root. A relative path is taken from the write root (reads: from the read
 *  root when the file is there). */
export function pathArg(p: unknown, what = 'path', mode: 'read' | 'write' = 'read'): string {
  if (typeof p !== 'string' || !p.trim()) fail('bad_input', `Give "${what}" (a file path).`, 'Pass the file path as a string.');
  const s = (p as string).trim();
  const base = writeBase();
  const abs = isAbsolute(s) ? resolve(s) : mode === 'read' && config.readRoot && (existsSync(resolve(config.readRoot, s)) || !base) ? resolve(config.readRoot, s) : base ? resolve(base, s) : resolve(s);
  const fs = fences(mode);
  if (!fs.length) return abs;
  // resolve the deepest existing part through symlinks, then check it is still inside a root
  let probe = abs, rest = '';
  while (!existsSync(probe) && dirname(probe) !== probe) { rest = join(probe.slice(dirname(probe).length + 1), rest); probe = dirname(probe); }
  const r = join(existsSync(probe) ? realpathSync(probe) : probe, rest);
  if (!fs.some((f) => { const x = real.get(f) ?? f; return r === x || r.startsWith(x + sep); })) {
    const which = config.readRoot || config.writeRoot ? (mode === 'write' ? 'the write root' : 'the read and write roots') : 'the storage root';
    fail('path_outside_root', `"${s}" is outside ${which}.`, `Use a path inside ${which} (relative paths are taken from ${config.writeRoot ? 'the write root' : 'the root'}).`, { data: { root: config.root, read_root: config.readRoot, write_root: writeBase() } });
  }
  return abs;
}
export const recoveryDir = () => join(config.root ?? tmpdir(), '.p6clone-recovery');

// ---------------------------------------------------------------- sessions
export interface Change { id: number; label: string; caller: string; j: Journal; after: Map<unknown[], unknown[]>; at: number }
export interface Session {
  handle: string; ownerKey: string; db: Db; path: string | null; format: Format; hpd: number;
  history: Change[]; redo: Map<string, { change: Change; mark: number }[]>; dirty: boolean;
  lastUsed: number; bytes: number; notice?: string;
}
interface Evicted { file: string; ownerKey: string; path: string | null; format: Format; hpd: number; at: number; reason: string; dirty: boolean }
export const sessions = new Map<string, Session>();
const evicted = new Map<string, Evicted>();
let changeSeq = 0;
const token = (prefix: string, n = 18) => prefix + randomBytes(n).toString('base64url');

export function createSession(db: Db, init: { path: string | null; format: Format; hpd: number; bytes: number; dirty: boolean }): Session {
  admit(init.bytes);
  const s: Session = { handle: token('h_'), ownerKey: token('ok_', 24), db, ...init, history: [], redo: new Map(), lastUsed: Date.now() };
  sessions.set(s.handle, s);
  return s;
}
export const estimateBytes = (fileBytes: number) => Math.round(fileBytes * config.memFactor) + 8 * 1048576;
const usedBytes = () => [...sessions.values()].reduce((a, s) => a + s.bytes, 0);

/** Make room for a project: refuse only when even moving every idle project out would not be enough. */
export function admit(bytes: number, keep?: string): void {
  const budget = effectiveBudget();
  const byAge = () => [...sessions.values()].filter((s) => s.handle !== keep && !busy.has(s.handle)).sort((a, b) => a.lastUsed - b.lastUsed);
  while ((sessions.size >= config.maxHandles || usedBytes() + bytes > budget) && byAge().length) evict(byAge()[0], 'memory');
  if (sessions.size >= config.maxHandles) fail('handle_limit', `All ${config.maxHandles} project slots are busy right now.`, 'Retry shortly, or close a project you no longer need.', { retryAfter: 5 });
  if (usedBytes() + bytes > budget) fail('memory_budget', `This file needs about ${mb(bytes)} of memory; ${mb(budget - usedBytes())} of the ${mb(budget)} budget is free while other calls are running.`, bytes > budget ? 'The file is larger than the whole memory budget: raise P6CLONE_MEM_BUDGET_MB (and the Node heap with --max-old-space-size) or split the file.' : 'Retry when the running calls have finished; idle projects are moved out automatically.', { retryAfter: 10, data: { needed_mb: Math.round(bytes / 1048576), budget_mb: Math.round(budget / 1048576) } });
}
const mb = (b: number) => `${Math.round(b / 1048576)} MB`;

/** Move a project out of memory into a lossless recovery file; it comes back on its next call. */
export function evict(s: Session, reason: string): string {
  mkdirSync(recoveryDir(), { recursive: true });
  const file = join(recoveryDir(), `${s.handle}.p6db.jsonl`);
  // line by line: a big project's file is larger than the longest possible string
  const fd = openSync(file, 'w');
  try { for (const l of dbLines(s.db, null)) writeSync(fd, l + '\n'); } finally { closeSync(fd); }
  evicted.set(s.handle, { file, ownerKey: s.ownerKey, path: s.path, format: s.format, hpd: s.hpd, at: Date.now(), reason, dirty: s.dirty });
  sessions.delete(s.handle);
  saveIndex();
  return file;
}
/** Read a recovery file in pieces (see evict). */
function readDbFile(file: string) {
  const r = new DbReader(), dec = new TextDecoder(), buf = new Uint8Array(1 << 24), fd = openSync(file, 'r');
  let rest = '';
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) {
      const ls = (rest + dec.decode(buf.subarray(0, n), { stream: true })).split('\n');
      rest = ls.pop()!;
      for (const l of ls) r.add(l);
    }
  } finally { closeSync(fd); }
  r.add(rest + dec.decode());
  return r.finish();
}
const indexFile = () => join(recoveryDir(), 'index.json');
function saveIndex(): void { try { writeFileSync(indexFile(), JSON.stringify(Object.fromEntries(evicted))); } catch { /* best effort */ } }
/** After a restart, projects moved out earlier can still be reached by their handles. */
export function loadIndex(): void { try { for (const [h, e] of Object.entries(JSON.parse(readFileSync(indexFile(), 'utf8')) as Record<string, Evicted>)) if (existsSync(e.file)) evicted.set(h, e); } catch { /* none */ } }

/** The session behind a handle; a project moved out of memory is brought back (with a notice for the caller). */
export function getSession(h: unknown): Session {
  const handle = String(h ?? '');
  const s = sessions.get(handle);
  if (s) { s.lastUsed = Date.now(); return s; }
  const e = evicted.get(handle);
  if (!e) fail('unknown_handle', handle ? `No open project with handle "${handle}".` : 'Give "handle".', 'Open the file again with open_file (or list_open to see the open handles). Handles from before a server restart come back only if they had been saved to recovery.');
  const bytes = Math.round(statSync(e!.file).size * 1.5) + 8 * 1048576;
  admit(bytes, handle);
  const { db } = readDbFile(e!.file);
  const back: Session = { handle, ownerKey: e!.ownerKey, db, path: e!.path, format: e!.format, hpd: e!.hpd, history: [], redo: new Map(), dirty: e!.dirty, lastUsed: Date.now(), bytes,
    notice: `This project had been moved out of memory (${e!.reason === 'idle' ? `idle for ${config.idleMinutes} minutes` : 'to make room'}) and was restored from ${e!.file}. Its undo history before that is gone; nothing else was lost.` };
  sessions.set(handle, back);
  evicted.delete(handle); saveIndex();
  try { rmSync(e!.file); } catch { /* keep */ }
  return back;
}
/** Projects moved out with unsaved changes, read back from their recovery files (for the save at exit). */
export function* unsavedEvicted(): Generator<{ handle: string; path: string | null; hpd: number; db: Db }> {
  for (const [handle, e] of evicted) if (e.dirty && existsSync(e.file)) yield { handle, path: e.path, hpd: e.hpd, db: readDbFile(e.file).db };
}
export const isDirty = (h: string) => sessions.get(h)?.dirty ?? evicted.get(h)?.dirty ?? false;
export function closeSession(s: Session): void { sessions.delete(s.handle); evicted.delete(s.handle); }
export function forgetEvicted(handle: string): void { const e = evicted.get(handle); if (e) { try { rmSync(e.file); } catch { /* */ } evicted.delete(handle); saveIndex(); } }
export const evictedList = () => [...evicted].map(([h, e]) => ({ handle: h, file: e.path, recovery_file: e.file, reason: e.reason, unsaved_changes: e.dirty, since: new Date(e.at).toISOString() }));

/** Idle projects leave memory (as hygiene); they return on their next call. */
export function sweepIdle(): void {
  const limit = Date.now() - config.idleMinutes * 60000;
  for (const s of [...sessions.values()]) if (s.lastUsed < limit && !busy.has(s.handle)) evict(s, 'idle');
}

export function requireOwner(s: Session, key: unknown, what: string): void {
  if (!config.requireOwnerKey && key == null) return;
  if (key == null || key === '') fail('owner_key_required', `${what} needs the project's owner key.`, 'The owner key was returned by open_file / new_project to whoever opened the project; that caller (or the bridge holding it) can do this.');
  if (key !== s.ownerKey) fail('invalid_owner_key', 'That owner key does not belong to this project.', 'Use the owner_key returned when this handle was opened.');
}

// ---------------------------------------------------------------- one call at a time per handle
const tails = new Map<string, Promise<void>>();
const busy = new Set<string>();
export async function exclusive<T>(handle: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = tails.get(handle) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => mine);
  tails.set(handle, tail);
  const ready = await Promise.race([prev.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), config.busyWaitMs).unref?.())]);
  if (!ready) { void prev.then(() => release()); fail('busy', 'Another call on this project is still running.', 'Retry after the suggested wait; calls on one project run one at a time.', { retryAfter: 3 }); }
  busy.add(handle);
  try { return await fn(); } finally { busy.delete(handle); release(); if (tails.get(handle) === tail) tails.delete(handle); }
}

// ---------------------------------------------------------------- changes, undo, redo by caller
export function change<T>(s: Session, caller: string, label: string, fn: (db: Db) => T): T {
  let out!: T;
  const j = record(s.db, (d) => { out = fn(d); });
  const after = new Map([...j.arrays.keys()].map((a) => [a, a.slice()]));
  s.history.push({ id: ++changeSeq, label, caller, j, after, at: Date.now() });
  if (s.history.length > 100) s.history.shift();
  s.redo.delete(caller);
  s.dirty = true;
  return out;
}
/** Drop the last change if it turned out to be unwanted (e.g. scheduling failed). */
export function dropLast(s: Session): void { const c = s.history.pop(); if (c) rollback(c.j); }

/** Undo one change even when later changes exist, if those did not touch what it touched. */
function revert(c: { j: Journal; after: Map<unknown[], unknown[]> }, later: Change[]): { j: Journal; after: Map<unknown[], unknown[]> } {
  const added = new Set<unknown>();
  for (const [a, before] of c.j.arrays) { const b = new Set(before); for (const x of c.after.get(a) ?? []) if (!b.has(x)) added.add(x); }
  for (const L of later) {
    for (const [o, keys] of c.j.fields) { const lk = L.j.fields.get(o); if (lk) for (let i = 0; i < keys.length; i += 2) if (lk.some((x, n) => n % 2 === 0 && x === keys[i])) fail('undo_conflict', `A later change ("${L.label}" by ${L.caller}) changed the same item.`, 'Undo that change first (with the owner key: any_caller), or make a correcting edit instead.'); }
    for (const o of L.j.fields.keys()) if (added.has(o)) fail('undo_conflict', `A later change ("${L.label}" by ${L.caller}) edited something this change created.`, 'Undo that change first (with the owner key: any_caller), or make a correcting edit instead.');
  }
  if (!later.length) { const j = rollback(c.j); return { j, after: new Map([...j.arrays.keys()].map((a) => [a, a.slice()])) }; }
  const back: Journal = { fields: new Map(), arrays: new Map() };
  for (const [o, keys] of c.j.fields) {
    const m: unknown[] = [], r = o as Record<PropertyKey, unknown>;
    for (let i = 0; i < keys.length; i += 2) {
      const k = keys[i] as PropertyKey, old = keys[i + 1];
      m.push(k, Object.prototype.hasOwnProperty.call(r, k) ? r[k] : ABSENT);
      if (old !== ABSENT) r[k] = old; else delete r[k];
    }
    back.fields.set(o, m);
  }
  const afterOut = new Map<unknown[], unknown[]>();
  for (const [a, before] of c.j.arrays) {
    // sets, not includes(): tables have 100k+ rows
    const now = a.slice(), afterC = new Set(c.after.get(a) ?? []), beforeSet = new Set(before);
    const mine = new Set([...afterC].filter((x) => !beforeSet.has(x)));
    const next = now.filter((x) => !mine.has(x));
    const present = new Set(next);
    before.forEach((x, i) => { if (!afterC.has(x) && !present.has(x)) { next.splice(Math.min(i, next.length), 0, x); present.add(x); } });
    back.arrays.set(a, now);
    a.length = 0; for (const x of next) a.push(x);
    afterOut.set(a, a.slice());
  }
  return { j: back, after: afterOut };
}

export function undo(s: Session, caller: string, anyCaller: boolean): { undone: string | null; by?: string } {
  let i = s.history.length - 1;
  if (!anyCaller) while (i >= 0 && s.history[i].caller !== caller) i--;
  if (i < 0) return { undone: null };
  const c = s.history[i];
  const back = revert(c, s.history.slice(i + 1));
  s.history.splice(i, 1);
  const stack = s.redo.get(c.caller) ?? [];
  stack.push({ change: { ...c, j: back.j, after: back.after }, mark: changeSeq });
  s.redo.set(c.caller, stack);
  s.dirty = true;
  return { undone: c.label, by: c.caller };
}

export function redo(s: Session, caller: string): { redone: string | null } {
  const stack = s.redo.get(caller);
  const r = stack?.pop();
  if (!r) return { redone: null };
  const back = revert(r.change, s.history.filter((h) => h.id > r.mark));
  s.history.push({ id: ++changeSeq, label: r.change.label, caller, j: back.j, after: back.after, at: Date.now() });
  s.dirty = true;
  return { redone: r.change.label };
}

// ---------------------------------------------------------------- jobs (long work the agent checks on)
interface Job { id: string; tool: string; handle?: string; started: number; done?: number; result?: unknown; error?: ToolError | Error; progress?: string; abort?: AbortController }
const jobs = new Map<string, Job>();
export function startJob(tool: string, handle: string | undefined, p: Promise<unknown>, abort?: AbortController): Job {
  const job: Job = { id: token('job_', 12), tool, handle, started: Date.now(), abort };
  jobs.set(job.id, job);
  p.then((r) => { job.result = r; }, (e) => { job.error = e; }).finally(() => { job.done = Date.now(); });
  return job;
}
export function jobView(job: Job) {
  const base = { job_id: job.id, tool: job.tool, handle: job.handle, running_seconds: Math.round(((job.done ?? Date.now()) - job.started) / 1000) };
  if (!job.done) return { ...base, status: 'running', progress: job.progress, note: 'Call job_status again shortly (pass wait_seconds to wait up to 20 s).' };
  if (job.error) return { ...base, status: job.error instanceof ToolError && job.error.code === 'cancelled' ? 'cancelled' : 'failed', error: job.error instanceof ToolError ? { code: job.error.code, reason: job.error.message, next_step: job.error.hint, message: job.error.message, hint: job.error.hint } : { code: 'internal', reason: job.error.message, message: job.error.message } };
  return { ...base, status: 'done', result: job.result };
}
export function getJob(id: unknown): Job {
  const j = jobs.get(String(id ?? ''));
  if (!j) fail('unknown_job', `No job "${id}".`, 'Jobs are kept for an hour after they finish; start the work again if it is gone.');
  return j!;
}
export function sweepJobs(): void { const limit = Date.now() - 3600000; for (const [id, j] of jobs) if (j.done && j.done < limit) jobs.delete(id); }
export const jobsList = () => [...jobs.values()].map((j) => ({ job_id: j.id, tool: j.tool, handle: j.handle, status: j.done ? (j.error ? 'failed' : 'done') : 'running' }));
export const setProgress = (job: Job | undefined, msg: string) => { if (job) job.progress = msg; };

export function status() {
  const m = process.memoryUsage();
  return {
    memory: { rss_bytes: m.rss, rss_mb: Math.round(m.rss / 1048576), heap_used_mb: Math.round(m.heapUsed / 1048576), budget_mb: Math.round(effectiveBudget() / 1048576), projects_mb: Math.round(usedBytes() / 1048576), heap_limit_mb: Math.round(getHeapStatistics().heap_size_limit / 1048576) },
    limits: { max_handles: config.maxHandles, idle_minutes: config.idleMinutes, busy_wait_seconds: config.busyWaitMs / 1000, root: config.root, read_root: config.readRoot, write_root: writeBase(), owner_key_required: config.requireOwnerKey },
    open: [...sessions.values()].map((s) => ({ handle: s.handle, file: s.path, memory_mb: Math.round(s.bytes / 1048576), idle_seconds: Math.round((Date.now() - s.lastUsed) / 1000), busy: busy.has(s.handle), unsaved_changes: s.dirty, changes: s.history.length })),
    moved_out: evictedList(),
    jobs: jobsList(),
  };
}
export const isBusy = (h: string) => busy.has(h);
