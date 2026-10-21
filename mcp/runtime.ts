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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { ABSENT, record, recordAsync, rollback, type Journal } from '../core/journal.ts';
import { dbLines, DbReader } from '../core/db-file.ts';
import type { Db } from '../core/db.ts';
import type { Format } from '../renderer/io.ts';
import type { TextEncodingName } from '../core/encoding.ts';

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
  /** Write each changed project to the recovery folder this long after its last change (0: never; the server sets it),
   *  so a crash loses at most that much and a restart brings every handle back. */
  checkpointMs: number;
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
  checkpointMs: 0,
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
  // a read root alone fences reading; it must not leave writing unfenced
  if (mode === 'write' && !fs.length && config.readRoot) fail('path_outside_root', `"${s}" cannot be written: this server has a read root but no write root.`, 'Start the server with --automation-write-root (or --root) to save files.', { data: { read_root: config.readRoot } });
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
// ---------------------------------------------------------------- recovery folders, owned by liveness
// <root or the temp folder>/.p6clone-recovery/<pid>-<token>/ is this process's: owner.json (pid, start token, the
// process's start time), index.json (handles moved out, and checkpoints of those in memory) and one file per project.
// At start a server adopts every folder whose owner is dead (no such pid, or that pid started at another time: a reused
// pid), by renaming it into adopted/ (atomic: of two servers starting at once, one wins), and the shared index.json of
// servers before v0.1.15 likewise; their handles come back under their old keys. A folder whose owner is alive is never
// touched, and nothing is ever deleted: files are restored or moved only.
const TOKEN = randomBytes(6).toString('hex');
const OWNER = `${process.pid}-${TOKEN}`;
const recoveryBase = () => join(config.root ?? tmpdir(), '.p6clone-recovery');
export const recoveryDir = () => join(recoveryBase(), OWNER);
/** A process's start time as the OS keeps it: Linux /proc/<pid>/stat field 22; Windows the process's CreationDate
 *  (CIM, else wmic, each with a timeout); null where it cannot be read (liveness is then the pid alone). */
function procStart(pid: number): string | null {
  if (process.platform === 'win32') return windowsStart(pid);
  try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { return null; }
}
type Run = (cmd: string, args: string[]) => string;
const runCmd: Run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
/** Windows: CreationDate of a process (the same string for its whole life; another process reusing the pid differs). */
export function windowsStart(pid: number, run: Run = runCmd): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`]).trim();
    if (out) return `cim:${out}`;
  } catch { /* no PowerShell, or it timed out: wmic */ }
  try {
    const m = /CreationDate=(\S+)/.exec(run('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value']));
    if (m) return `wmic:${m[1]}`;
  } catch { /* neither: unknown */ }
  return null;
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
interface Lock { pid: number; token: string; started: string | null }
/** Start times compare only when read the same way (proc, cim or wmic): read two ways they tell nothing (alive, then). */
const sameKind = (a: string, b: string) => (a.match(/^(cim|wmic):/)?.[1] ?? 'proc') === (b.match(/^(cim|wmic):/)?.[1] ?? 'proc');
export const startsDiffer = (lock: string | null, now: string | null) => lock != null && now != null && sameKind(lock, now) && lock !== now;
const ownerAlive = (l: Lock) => { if (!Number.isInteger(l.pid) || l.pid <= 0 || !pidAlive(l.pid)) return false; return !startsDiffer(l.started, procStart(l.pid)); };
/** My folder, with its owner lock (made on first use). */
function myDir(): string {
  const dir = recoveryDir();
  if (!existsSync(join(dir, 'owner.json'))) {
    mkdirSync(dir, { recursive: true });
    try { writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, token: TOKEN, started: procStart(process.pid) } satisfies Lock), { flag: 'wx' }); } catch { /* there */ }
  }
  return dir;
}
/** What is known of a closed project's file (a .json beside it in closed/): the retention rule reads it. */
interface ClosedMeta { handle: string; path: string | null; dirty: boolean; changedAt: number | null; closedAt: number }
/** Move a closed project's file into my closed/ folder, with what the retention rule needs to know of it. */
function putAside(file: string, meta: Omit<ClosedMeta, 'closedAt'>): void {
  try {
    const d = join(myDir(), 'closed'), to = join(d, `${Date.now()}-${basename(file)}`);
    mkdirSync(d, { recursive: true });
    renameSync(file, to);
    writeFileSync(`${to}.json`, JSON.stringify({ ...meta, closedAt: Date.now() } satisfies ClosedMeta));
  } catch { /* left where it is */ }
}
const keepDays = () => num(process.env.P6CLONE_RECOVERY_KEEP_DAYS, 7);
const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return null; } };
/** Why a closed project's file must stay (unsaved work, or its saved file missing or older than its last change),
 *  or null when the saved file holds it all (then it goes keepDays after the close). */
function mustKeep(m: ClosedMeta | null): string | null {
  if (!m) return 'nothing is known of it';
  if (m.dirty) return 'unsaved changes';
  if (!m.path) return 'never saved to a file';
  const t = mtime(m.path);
  if (t == null) return 'its saved file is missing';
  // (file times run on the kernel's coarse clock, a few ms behind Date.now(): 2 s of slack; a change after the save
  // leaves the project dirty anyway)
  if (m.changedAt != null && t + 2000 < m.changedAt) return 'its saved file is older than its last change';
  return null;
}
const readMeta = (f: string): ClosedMeta | null => { try { return JSON.parse(readFileSync(`${f}.json`, 'utf8')); } catch { return null; } };
const isProjectFile = (n: string) => n.endsWith('.p6db.jsonl');
/** Retention: a closed project's file whose saved file holds every change goes keepDays after the close; anything with
 *  unsaved work, or whose saved file is missing, stays for ever. An adopted folder whose projects have all been taken
 *  out (restored into my folder) goes, and so does an adopted index of servers before v0.1.15 whose files are all
 *  gone from where it lists them. Returns what was removed. */
export function sweepRecovery(now = Date.now()): string[] {
  const gone: string[] = [];
  const closed = join(recoveryDir(), 'closed');
  for (const n of existsSync(closed) ? readdirSync(closed) : []) {
    if (!isProjectFile(n)) continue;
    const f = join(closed, n), m = readMeta(f);
    if (mustKeep(m) != null || now - m!.closedAt < keepDays() * 86400000) continue;
    try { unlinkSync(f); unlinkSync(`${f}.json`); gone.push(f); } catch { /* next time */ }
  }
  const aside = join(recoveryBase(), 'adopted');
  for (const n of existsSync(aside) ? readdirSync(aside) : []) {
    const p = join(aside, n);
    try {
      if (statSync(p).isDirectory()) {
        // empty of projects (and of closed files): its owner lock and index are all that is left
        const left = readdirSync(p).filter((x) => x !== 'owner.json' && x !== 'index.json' && !(x === 'closed' && !readdirSync(join(p, x)).length));
        if (left.length) continue;
        for (const x of ['owner.json', 'index.json']) if (existsSync(join(p, x))) unlinkSync(join(p, x));
        if (existsSync(join(p, 'closed'))) rmdirSync(join(p, 'closed'));
        rmdirSync(p); gone.push(p);
      } else if (n.startsWith('index-before-v0.1.15-')) {
        const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, Evicted>;
        if (Object.values(j).every((e) => !e?.file || !existsSync(e.file))) { unlinkSync(p); gone.push(p); }
      }
    } catch { /* next time */ }
  }
  return gone;
}
/** server_status: the recovery folder (all servers' and this one's), its size, and every item kept because it holds
 *  unsaved work or its saved file is missing, so nothing is left there unnoticed. */
export function recoveryStatus() {
  const size = (p: string): number => { try { const st = statSync(p); return st.isDirectory() ? readdirSync(p).reduce((a, n) => a + size(join(p, n)), 0) : st.size; } catch { return 0; } };
  const kept: { file: string; project_file: string | null; handle: string | null; why: string; since: string }[] = [];
  const closedDirs = [join(recoveryDir(), 'closed'), ...(existsSync(join(recoveryBase(), 'adopted')) ? readdirSync(join(recoveryBase(), 'adopted')).map((n) => join(recoveryBase(), 'adopted', n, 'closed')) : [])];
  for (const d of closedDirs) for (const n of existsSync(d) ? readdirSync(d) : []) {
    if (!isProjectFile(n)) continue;
    const f = join(d, n), m = readMeta(f), why = mustKeep(m);
    if (why) kept.push({ file: f, project_file: m?.path ?? null, handle: m?.handle ?? null, why, since: new Date(m?.closedAt ?? mtime(f) ?? 0).toISOString() });
  }
  for (const [h, e] of evicted) if (e.dirty) kept.push({ file: e.file, project_file: e.savedTo ?? e.path, handle: h, why: 'unsaved changes (moved out of memory; comes back with its handle)', since: new Date(e.at).toISOString() });
  return { folder: recoveryDir(), all_servers: recoveryBase(), bytes: size(recoveryDir()), bytes_all_servers: size(recoveryBase()), keep_days: keepDays(), kept_unsaved: kept.slice(0, 200), kept_unsaved_total: kept.length };
}

// ---------------------------------------------------------------- sessions
export interface Change { id: number; label: string; caller: string; j: Journal; after: Map<unknown[], unknown[]>; at: number }
export interface Session {
  handle: string; ownerKey: string; db: Db; path: string | null; format: Format; hpd: number;
  /** the text encoding its XER / MPX file was read in (BOM as read): what save writes when no encoding is given */
  encoding?: TextEncodingName;
  history: Change[]; redo: Map<string, { change: Change; mark: number }[]>; dirty: boolean;
  lastUsed: number; bytes: number; notice?: string;
  /** when it last changed (edit, schedule, undo...): a saved file at least this new holds every change */
  changedAt?: number;
  /** the file its last save (of the whole project, leaving no unsaved changes) wrote */
  savedTo?: string;
}
/** adopted: taken over from a server that is gone (its own exit saved its unsaved work already, or it crashed: the
 *  handle brings it back either way), so the save at exit leaves it to the handle */
interface Evicted { file: string; ownerKey: string; path: string | null; format: Format; hpd: number; encoding?: TextEncodingName; at: number; reason: string; dirty: boolean; adopted?: boolean; changedAt?: number; savedTo?: string }
export const sessions = new Map<string, Session>();
const evicted = new Map<string, Evicted>();
/** Projects in memory whose state is also on disk (checkpoint): what a restart, or a server after a crash, brings back. */
const checkpoints = new Map<string, Evicted>();
let changeSeq = 0;
const token = (prefix: string, n = 18) => prefix + randomBytes(n).toString('base64url');

export function createSession(db: Db, init: { path: string | null; format: Format; hpd: number; bytes: number; dirty: boolean }): Session {
  admit(init.bytes);
  const s: Session = { handle: token('h_'), ownerKey: token('ok_', 24), db, ...init, history: [], redo: new Map(), lastUsed: Date.now(), ...(init.dirty ? { changedAt: Date.now() } : {}) };
  sessions.set(s.handle, s);
  return s;
}
export const estimateBytes = (fileBytes: number) => Math.round(fileBytes * config.memFactor) + 8 * 1048576;
/** Memory held outside the projects (4D models shared by projects) and reserved by work in flight (a model being read,
 *  its geometry process): counted in the same budget. */
const counters = new Set<() => number>();
const trimmers = new Set<() => void>();
let reserved = 0;
export function countMemory(count: () => number, trim?: () => void): void { counters.add(count); if (trim) trimmers.add(trim); }
const usedBytes = () => [...sessions.values()].reduce((a, s) => a + s.bytes, 0) + [...counters].reduce((a, f) => a + f(), 0) + reserved;
/** The budget not taken by projects, models and work in flight. */
export const freeMemory = () => effectiveBudget() - usedBytes();
/** Reserve memory for work that is not a project (refused like a file that does not fit); call the result to release.
 *  `what` names the work in the refusal ("Monte Carlo on this project"), `hint` says what else the caller can do. */
export function reserveMemory(bytes: number, what?: string, hint?: string, keep?: string): () => void {
  admit(bytes, keep, what, hint);
  reserved += bytes;
  let done = false;
  return () => { if (!done) { done = true; reserved -= bytes; } };
}

/** Make room for a project or a call: refuse only when even moving every idle project out would not be enough. The
 *  refusal says what holds the memory, and asks to retry only when work in flight will give some back. */
export function admit(bytes: number, keep?: string, what = 'This file', hint?: string): void {
  const budget = effectiveBudget();
  const byAge = () => [...sessions.values()].filter((s) => s.handle !== keep && !busy.has(s.handle)).sort((a, b) => a.lastUsed - b.lastUsed);
  while ((sessions.size >= config.maxHandles || usedBytes() + bytes > budget) && byAge().length) { evict(byAge()[0], 'memory'); for (const t of trimmers) t(); }
  if (usedBytes() + bytes > budget) for (const t of trimmers) t();
  if (sessions.size >= config.maxHandles) fail('handle_limit', `All ${config.maxHandles} project slots are busy right now.`, 'Retry shortly, or close a project you no longer need.', { retryAfter: 5 });
  if (usedBytes() + bytes <= budget) return;
  const projects = [...sessions.values()].reduce((a, s) => a + s.bytes, 0), models = [...counters].reduce((a, f) => a + f(), 0);
  const running = reserved > 0 || [...busy].some((h) => h !== keep); // the call asking is not one to wait for
  const held = [`${sessions.size} project${sessions.size === 1 ? '' : 's'} in memory: ${mb(projects)}`, ...(models ? [`4D models: ${mb(models)}`] : []), ...(reserved ? [`calls running: ${mb(reserved)}`] : [])].join('; ');
  const next = bytes > budget ? `It needs more than the whole memory budget: ${hint ? `${hint}, or ` : ''}raise P6CLONE_MEM_BUDGET_MB (and the Node heap with --max-old-space-size).`
    : running ? `Retry when the running calls have finished (they give their memory back); idle projects are moved out automatically.${hint ? ` Or: ${hint}.` : ''}`
      : `${hint ? `${hint}; or ` : ''}close a project (close) or a 4D model you no longer need: what is in memory is in use by this call's project.`;
  fail('memory_budget', `${what} needs about ${mb(bytes)} of memory, and ${mb(Math.max(0, budget - usedBytes()))} of the ${mb(budget)} budget (P6CLONE_MEM_BUDGET_MB) is free (${held}).`, next,
    { ...(running ? { retryAfter: 10 } : {}), data: { needed_mb: Math.round(bytes / 1048576), free_mb: Math.round(Math.max(0, budget - usedBytes()) / 1048576), budget_mb: Math.round(budget / 1048576) } });
}
const mb = (b: number) => `${Math.round(b / 1048576)} MB`;
/** A project grown by a call (an LOB plan adds thousands of activities): its memory counted again, as an XER of about
 *  250 bytes a row would be (L-9); room is made by moving idle projects out, and it is counted even when none is made. */
export function regrow(s: Session): void {
  const est = estimateBytes(Object.values(s.db.tables).reduce((n, t) => n + t.rows.length, 0) * 250);
  if (est <= s.bytes) return;
  try { admit(est - s.bytes, s.handle); } catch { /* counted anyway: the next file to open waits for room */ }
  s.bytes = est;
}

/** Move a project out of memory into a lossless recovery file; it comes back on its next call. */
export function evict(s: Session, reason: string): string {
  const file = writeProject(s);
  evicted.set(s.handle, entryOf(s, file, reason));
  checkpoints.delete(s.handle);
  sessions.delete(s.handle);
  saveIndex();
  return file;
}
const entryOf = (s: Session, file: string, reason: string): Evicted => ({ file, ownerKey: s.ownerKey, path: s.path, format: s.format, hpd: s.hpd, encoding: s.encoding, at: Date.now(), reason, dirty: s.dirty, ...(s.changedAt ? { changedAt: s.changedAt } : {}), ...(s.savedTo ? { savedTo: s.savedTo } : {}) });
/** A project's lossless file in my folder, written beside and then renamed over the last one. */
function writeProject(s: Session): string {
  const file = join(myDir(), `${s.handle}.p6db.jsonl`), tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`;
  // line by line: a big project's file is larger than the longest possible string
  const fd = openSync(tmp, 'w');
  try { for (const l of dbLines(s.db, null)) writeSync(fd, l + '\n'); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return file;
}
/** Write a project in memory to the recovery folder now (a checkpoint): a restart or a crash then loses nothing of it. */
export function checkpoint(s: Session): void {
  if (!sessions.has(s.handle)) return;
  try { checkpoints.set(s.handle, entryOf(s, writeProject(s), 'restart')); saveIndex(); } catch { /* the next one */ }
}
const pendingCk = new Map<string, NodeJS.Timeout>();
/** After a change: a checkpoint config.checkpointMs after the project's last change. */
export function scheduleCheckpoint(handle: string): void {
  if (!config.checkpointMs) return;
  clearTimeout(pendingCk.get(handle));
  pendingCk.set(handle, setTimeout(() => { pendingCk.delete(handle); const s = sessions.get(handle); if (s && !busy.has(handle)) checkpoint(s); else if (s) scheduleCheckpoint(handle); }, config.checkpointMs).unref());
}
/** At exit: every project in memory checkpointed, so the next start brings each handle back. */
export function checkpointAll(): void { for (const s of sessions.values()) { clearTimeout(pendingCk.get(s.handle)); checkpoint(s); } }
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
function saveIndex(): void {
  try { const f = join(myDir(), 'index.json'), tmp = `${f}.tmp`; writeFileSync(tmp, JSON.stringify({ evicted: Object.fromEntries(evicted), checkpoints: Object.fromEntries(checkpoints) })); renameSync(tmp, f); } catch { /* best effort */ }
}
/** The handles of an adopted index (moved from `from` to `to`, or null when the files stayed where they were). */
function adoptIndex(file: string, from: string | null, to: string | null): string[] {
  let j: Record<string, any>;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  const all: Record<string, Evicted> = j && typeof j.evicted === 'object' ? { ...(j.checkpoints ?? {}), ...j.evicted } : j; // v0.1.16, or a flat list before
  const out: string[] = [];
  for (const [h, e] of Object.entries(all)) {
    if (!e || typeof e.file !== 'string' || sessions.has(h) || evicted.has(h)) continue;
    const at = from && to && e.file.startsWith(from + sep) ? join(to, e.file.slice(from.length + 1)) : e.file;
    if (existsSync(at)) { evicted.set(h, { ...e, file: at, reason: e.reason === 'restart' || !e.reason ? 'restart' : e.reason, adopted: true }); out.push(h); }
  }
  return out;
}
/** At start: take the lock of my folder and adopt what dead owners left (see above). Returns the handles adopted. */
export function adoptRecovery(): string[] {
  const base = recoveryBase();
  myDir();
  const took: string[] = [];
  const aside = join(base, 'adopted');
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return took; }
  for (const name of names) {
    if (name === OWNER || name === 'adopted') continue;
    const dir = join(base, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    let lock: Lock;
    try { lock = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')); } catch {
      const m = /^(\d+)-[0-9a-f]{12}$/.exec(name); // a v0.1.15 folder: the pid is in its name
      if (!m) continue;
      lock = { pid: Number(m[1]), token: '', started: null };
    }
    if (ownerAlive(lock)) continue;
    const to = join(aside, `${name}-by-${OWNER}`);
    try { mkdirSync(aside, { recursive: true }); renameSync(dir, to); } catch { continue; } // another server took it first
    took.push(...adoptIndex(join(to, 'index.json'), dir, to));
  }
  // the shared index of servers before v0.1.15 (their files stay where they are, until restored)
  const legacy = join(base, 'index.json');
  if (existsSync(legacy)) { const to = join(aside, `index-before-v0.1.15-by-${OWNER}.json`); try { mkdirSync(aside, { recursive: true }); renameSync(legacy, to); took.push(...adoptIndex(to, null, null)); } catch { /* another server took it */ } }
  saveIndex();
  sweepRecovery();
  return took;
}
/** Kept for callers of earlier versions: adoptRecovery. */
export const loadIndex = (): void => void adoptRecovery();

/** The session behind a handle; a project moved out of memory is brought back (with a notice for the caller). */
export function getSession(h: unknown): Session {
  const handle = String(h ?? '');
  const s = sessions.get(handle);
  if (s) { s.lastUsed = Date.now(); return s; }
  const e = evicted.get(handle);
  if (!e) fail('unknown_handle', handle ? `No open project with handle "${handle}".` : 'Give "handle".', 'Open the file again with open_file (or list_open to see the open handles). Handles come back after a server restart or crash (from the recovery folder) unless the project was closed.');
  const bytes = Math.round(statSync(e!.file).size * 1.5) + 8 * 1048576;
  admit(bytes, handle);
  const { db } = readDbFile(e!.file);
  // a project adopted from a server that is gone moves into my folder (its old folder can then empty and go)
  if (e!.adopted) { const to = join(myDir(), basename(e!.file)); try { renameSync(e!.file, to); e!.file = to; } catch { /* stays where it is */ } }
  const back: Session = { handle, ownerKey: e!.ownerKey, db, path: e!.path, format: e!.format, hpd: e!.hpd, encoding: e!.encoding, history: [], redo: new Map(), dirty: e!.dirty, lastUsed: Date.now(), bytes, ...(e!.changedAt ? { changedAt: e!.changedAt } : {}), ...(e!.savedTo ? { savedTo: e!.savedTo } : {}),
    notice: e!.reason === 'restart' ? `The server had restarted (or stopped): this project was restored from ${e!.file}, with the changes it had. Its undo history before that is gone.`
      : `This project had been moved out of memory (${e!.reason === 'idle' ? `idle for ${config.idleMinutes} minutes` : 'to make room'}) and was restored from ${e!.file}. Its undo history before that is gone; nothing else was lost.` };
  sessions.set(handle, back);
  // its file stays, as the checkpoint of the project now in memory (the next checkpoint writes over it)
  evicted.delete(handle); checkpoints.set(handle, { ...e!, reason: 'restart', adopted: false }); saveIndex();
  return back;
}
/** Projects moved out with unsaved changes, read back from their recovery files (for the save at exit). */
export function* unsavedEvicted(): Generator<{ handle: string; path: string | null; hpd: number; encoding?: TextEncodingName; db: Db }> {
  for (const [handle, e] of evicted) if (e.dirty && !e.adopted && existsSync(e.file)) yield { handle, path: e.path, hpd: e.hpd, encoding: e.encoding, db: readDbFile(e.file).db };
}
export const isDirty = (h: string) => sessions.get(h)?.dirty ?? evicted.get(h)?.dirty ?? false;
export function closeSession(s: Session): void {
  sessions.delete(s.handle); clearTimeout(pendingCk.get(s.handle));
  for (const m of [evicted, checkpoints]) { const e = m.get(s.handle); if (e) { putAside(e.file, { handle: s.handle, path: s.savedTo ?? s.path, dirty: s.dirty, changedAt: s.changedAt ?? null }); m.delete(s.handle); } }
  saveIndex();
}
export function forgetEvicted(handle: string): void { for (const m of [evicted, checkpoints]) { const e = m.get(handle); if (e) { putAside(e.file, { handle, path: e.savedTo ?? e.path, dirty: e.dirty, changedAt: e.changedAt ?? null }); m.delete(handle); } } saveIndex(); }
export const evictedList = () => [...evicted].map(([h, e]) => ({ handle: h, file: e.path, recovery_file: e.file, reason: e.reason, unsaved_changes: e.dirty, since: new Date(e.at).toISOString() }));

/** Idle projects leave memory (as hygiene); they return on their next call. */
export function sweepIdle(): void {
  const limit = Date.now() - config.idleMinutes * 60000;
  for (const s of [...sessions.values()]) if (s.lastUsed < limit && !busy.has(s.handle)) evict(s, 'idle');
  sweepRecovery();
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
  s.dirty = true; s.changedAt = Date.now();
  return out;
}
/** change for work that awaits between its steps (progress, cancellation): a cancelled or failed run leaves nothing. */
export async function changeAsync<T>(s: Session, caller: string, label: string, fn: (db: Db) => Promise<T>): Promise<T> {
  let out!: T;
  const j = await recordAsync(s.db, async (d) => { out = await fn(d); });
  const after = new Map([...j.arrays.keys()].map((a) => [a, a.slice()]));
  s.history.push({ id: ++changeSeq, label, caller, j, after, at: Date.now() });
  if (s.history.length > 100) s.history.shift();
  s.redo.delete(caller);
  s.dirty = true; s.changedAt = Date.now();
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
  s.dirty = true; s.changedAt = Date.now();
  return { undone: c.label, by: c.caller };
}

export function redo(s: Session, caller: string): { redone: string | null } {
  const stack = s.redo.get(caller);
  const r = stack?.pop();
  if (!r) return { redone: null };
  const back = revert(r.change, s.history.filter((h) => h.id > r.mark));
  s.history.push({ id: ++changeSeq, label: r.change.label, caller, j: back.j, after: back.after, at: Date.now() });
  s.dirty = true; s.changedAt = Date.now();
  return { redone: r.change.label };
}

// ---------------------------------------------------------------- jobs (long work the agent checks on)
interface Job { id: string; tool: string; handle?: string; started: number; done?: number; result?: unknown; error?: ToolError | Error; progress?: string; abort?: AbortController }
const jobs = new Map<string, Job>();
/** Told when a job starts, moves (its progress) and ends: the stdio front answers job_status from it while the main
 *  thread is busy in a long step (stdio.ts). */
let jobHook: ((id: string, view: ReturnType<typeof jobView> | null) => void) | null = null;
export function onJobChange(f: typeof jobHook): void { jobHook = f; }
export function startJob(tool: string, handle: string | undefined, p: Promise<unknown>, abort?: AbortController): Job {
  const job: Job = { id: token('job_', 12), tool, handle, started: Date.now(), abort };
  // progress is set as the work goes (often inside a long synchronous step): each change is passed on at once
  let progress: string | undefined;
  Object.defineProperty(job, 'progress', { enumerable: true, get: () => progress, set: (v: string | undefined) => { progress = v; jobHook?.(job.id, jobView(job)); } });
  jobs.set(job.id, job);
  jobHook?.(job.id, jobView(job));
  p.then((r) => { job.result = r; }, (e) => { job.error = e; }).finally(() => { job.done = Date.now(); jobHook?.(job.id, null); });
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
    memory: { rss_bytes: m.rss, rss_mb: Math.round(m.rss / 1048576), heap_used_mb: Math.round(m.heapUsed / 1048576), budget_mb: Math.round(effectiveBudget() / 1048576), projects_mb: Math.round(usedBytes() / 1048576), reserved_mb: Math.round(reserved / 1048576), heap_limit_mb: Math.round(getHeapStatistics().heap_size_limit / 1048576) },
    limits: { max_handles: config.maxHandles, idle_minutes: config.idleMinutes, busy_wait_seconds: config.busyWaitMs / 1000, root: config.root, read_root: config.readRoot, write_root: writeBase(), owner_key_required: config.requireOwnerKey },
    open: [...sessions.values()].map((s) => ({ handle: s.handle, file: s.path, memory_mb: Math.round(s.bytes / 1048576), idle_seconds: Math.round((Date.now() - s.lastUsed) / 1000), busy: busy.has(s.handle), unsaved_changes: s.dirty, changes: s.history.length })),
    moved_out: evictedList(),
    jobs: jobsList(),
  };
}
export const isBusy = (h: string) => busy.has(h);
