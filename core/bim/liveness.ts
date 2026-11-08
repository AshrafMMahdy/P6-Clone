// Liveness instead of time limits (owner rule 2026-10-27/28: no fixed time limits, only progress and liveness), judged by the
// PLATFORM's rule (owner decision 2026-11-08: one rule for the platform and the clone; White-Hat-IQ-2 craftSupervisor.ts
// livenessVerdict). Every window (5 s) a watch asks two things of the work it watches:
//  1. did it make progress in the window (a tick, a unit done, a new step, a beat whose last tick is newer, output written)?
//     Then it is alive.
//  2. else, did it use processor time (10 ms or more in the window)? Then it is working: alive. A job that uses the processor is
//     NEVER ended, a loop that spins included (the user can cancel it).
// It is frozen on the second window in a row with no progress and no processor time (a program waiting on a dialog nobody can
// see, a dead lock); where no processor reading can be had at all, on the third window in a row with no progress. Nothing else
// ends a job: no gap multiple, no floor, no work bound. A window whose check came late because THIS process's event loop was busy
// (it fired after a second window had begun) is not counted: the work was not watched in it.
// Workers we wrote report from their own thread (heartbeat.mjs: the step, the time since its last tick, its processor time); the
// parent judges (heartbeatWatcher). The browser and other programs we drive are watched from here (unitWatch: ticks we see, the
// processor time of the program's process tree; externalWatch: an external program's output and processor time). stuckMessage()
// is the one text for an ended job: which step, how long without progress, what was tried, the alternatives.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { rateEnv } from './heartbeat.mjs';

/** Summed processor time (ms) of a process and its descendants from a table of [pid, parent pid, ms] rows. */
export function sumTree(rows: Array<[number, number, number]>, pid: number): number {
  const mine = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const [p, pp] of rows) if (!mine.has(p) && mine.has(pp)) { mine.add(p); grew = true; } }
  return rows.filter(([p]) => mine.has(p)).reduce((n, [, , ms]) => n + ms, 0);
}
export interface ProcRow { pid: number; ppid: number; ms: number; name: string }
/** Windows: PowerShell's CIM table (Win32_Process: kernel and user time in 100 ns), or wmic's CSV of the same columns (Name too, when listed). */
export function parseWindowsProcs(csv: string): ProcRow[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = (lines.shift() ?? '').split(',').map((h) => h.replace(/"/g, '').trim().toLowerCase());
  const col = (n: string) => head.indexOf(n.toLowerCase());
  const [ip, ipp, ik, iu, inm] = [col('ProcessId'), col('ParentProcessId'), col('KernelModeTime'), col('UserModeTime'), col('Name')];
  if ([ip, ipp, ik, iu].some((i) => i < 0)) return [];
  return lines.map((l) => l.split(',').map((c) => c.replace(/"/g, '').trim())).map((c): ProcRow => ({ pid: Number(c[ip]), ppid: Number(c[ipp]), ms: (Number(c[ik]) + Number(c[iu])) / 10_000, name: inm >= 0 ? c[inm] ?? '' : '' })).filter((r) => Number.isFinite(r.pid) && Number.isFinite(r.ppid) && Number.isFinite(r.ms));
}
export function parseWindowsCpu(csv: string): Array<[number, number, number]> {
  return parseWindowsProcs(csv).map((r): [number, number, number] => [r.pid, r.ppid, r.ms]);
}
/** macOS / BSD: `ps -A -o pid=,ppid=,cputime=` ("[[dd-]hh:]mm:ss[.ff]"). */
export function parsePsCpu(text: string): Array<[number, number, number]> {
  const secs = (t: string) => { const [d, rest] = t.includes('-') ? t.split('-') : ['0', t]; return rest.split(':').reduce((n, x) => n * 60 + Number(x), 0) + Number(d) * 86400; };
  return text.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 3).map((c): [number, number, number] => [Number(c[0]), Number(c[1]), secs(c[2]) * 1000]).filter((r) => r.every(Number.isFinite));
}
const run = (cmd: string, args: string[]) => new Promise<string | null>((done) => {
  try { execFile(cmd, args, { windowsHide: true, timeout: 20_000, maxBuffer: 16 << 20 }, (e, out) => done(e ? null : String(out))); } catch { done(null); }
});
const lower = (n: string) => n.toLowerCase();
function sumRows(rows: ProcRow[], pid: number, names: string[]): number {
  const want = new Set(names.map(lower)), mine = new Set([pid]);
  for (const r of rows) if (want.has(lower(r.name))) mine.add(r.pid);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; } }
  return rows.filter((r) => mine.has(r.pid)).reduce((n, r) => n + r.ms, 0);
}
/** Like treeCpuMs, but only when the reading COVERS every program in `names`: the process table was read (not the tasklist fall
 *  back, which sees one process) and each name is running. Otherwise null: a reading that cannot see the program says nothing about
 *  whether it works, and an idle rule must not be built on it. */
export async function cpuCovering(pid: number, names: string[]): Promise<number | null> {
  try {
    const rows = await processRows();
    if (!rows || !names.every((n) => rows.some((r) => lower(r.name) === lower(n)))) return null;
    return sumRows(rows, pid, names);
  } catch { return null; }
}
/** Every process with its parent and processor time (and name, on Linux and Windows); null where no way works. */
export async function processRows(): Promise<ProcRow[] | null> {
  try {
    if (process.platform === 'linux') {
      const rows: ProcRow[] = [];
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        let stat: string;
        try { stat = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; } // gone since the listing
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // after "pid (comm) ": field 3 (state) is f[0]
        rows.push({ pid: Number(name), ppid: Number(f[1]), ms: (Number(f[11]) + Number(f[12])) * 10, name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) }); // ppid; utime, stime in ticks of 10 ms
      }
      return rows;
    }
    if (process.platform === 'win32') {
      const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,Name | ConvertTo-Csv -NoTypeInformation']);
      let rows = ps ? parseWindowsProcs(ps) : [];
      if (!rows.length) { const w = await run('wmic', ['process', 'get', 'Name,ProcessId,ParentProcessId,KernelModeTime,UserModeTime', '/format:csv']); rows = w ? parseWindowsProcs(w) : []; }
      return rows.length ? rows : null;
    }
    const ps = await run('ps', ['-A', '-o', 'pid=,ppid=,cputime=']);
    return ps ? parsePsCpu(ps).map(([pid, ppid, ms]) => ({ pid, ppid, ms, name: '' })) : null;
  } catch { return null; }
}
/** The processor time (ms) used so far by a process and all its descendants (a browser's renderer and graphics processes,
 *  say) and by every process named in `names` (a program a COM call started is not a descendant of the caller), read
 *  from outside; null where no way works. Linux: /proc (ticks of 10 ms). Windows: PowerShell, then wmic, then tasklist
 *  (the process itself only). macOS: ps. */
export async function treeCpuMs(pid: number, names: string[] = []): Promise<number | null> {
  try {
    const rows = await processRows();
    if (rows) return sumRows(rows, pid, names);
    if (process.platform === 'win32') {
      const t = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/V']); // "CPU Time" as h:mm:ss, the process alone
      const m = t && /"(\d+):(\d\d):(\d\d)"/.exec(t);
      return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
    }
    return null;
  } catch { return null; }
}
/** The pids of the processes with this name (case does not matter); null where the table cannot be read. */
export async function pidsNamed(name: string): Promise<number[] | null> {
  const rows = await processRows();
  return rows ? rows.filter((r) => lower(r.name) === lower(name)).map((r) => r.pid) : null;
}

/** V8 flags for the Node processes this server starts (geometry, index and reader workers). On Node 24 (V8 13.6) a process that ends with
 *  process.exit() while a background compile job waits for a garbage collection never ends: the main thread joins the platform's threads in
 *  its exit and the threads wait for the collection the main thread will not run. Seen in the tiler (all work done, tiles.json written, then
 *  silence) in about 1 run in 4 under load. Without the concurrent compilers it did not happen in 32 runs. The flags are Node 24 and later's
 *  only (earlier V8s may not know them) and not Electron's. */
export const childV8Flags = (): string[] => (!process.versions.electron && Number(process.versions.node.split('.')[0]) >= 24 ? ['--no-concurrent-recompilation', '--no-concurrent-sparkplug'] : []);

// ---- the rule (the platform's, craftSupervisor.ts livenessVerdict) ---------------------------------------------------
/** The window of the check (the platform's: 5 s). P6CLONE_LIVENESS_WINDOW_MS (the environment only: tests) shortens it. */
export const livenessWindowMs = () => Number(process.env.P6CLONE_LIVENESS_WINDOW_MS) || 5_000;
/** Processor time in a window that means the work is running (the platform's 10 ms). */
export const BUSY_CPU_MS = 10;
/** Windows in a row with no progress and no processor time that make the work frozen (the platform's: the second; a process starved on a
 *  loaded machine can get no processor for a moment). */
export const IDLE_FROZEN_WINDOWS = 2;
/** Windows in a row with no progress and NO processor reading to be had that make the work frozen (the platform's UNREAD_FROZEN_WINDOWS). */
export const UNREAD_FROZEN_WINDOWS = 3;

/** A watch's counters, kept between windows. */
export interface LiveCounters { idle: number; unread: number }
/** The verdict for one window, pure (tests drive it): progress or processor time = alive; else counted, frozen at the second idle window
 *  ('idle') or the third window with no reading ('silent'). cpuMs: processor time used in the window, null when it could not be read. */
export function verdict(c: LiveCounters, progressed: boolean, cpuMs: number | null): 'alive' | 'checking' | 'idle' | 'silent' {
  if (progressed) { c.idle = 0; c.unread = 0; return 'alive'; }
  if (cpuMs == null) { c.idle = 0; c.unread++; return c.unread >= UNREAD_FROZEN_WINDOWS ? 'silent' : 'checking'; }
  c.unread = 0;
  if (cpuMs >= BUSY_CPU_MS) { c.idle = 0; return 'alive'; }
  c.idle++;
  return c.idle >= IDLE_FROZEN_WINDOWS ? 'idle' : 'checking';
}

/** A window with no progress, as a watch reports it to the job it runs in (the job decides whether the agent is woken: runtime.ts
 *  noteSilence). maxGapMs: the longest gap between two progress points this work has shown (0: none yet); expectMs: what the step is
 *  expected to take (measured rates x this machine, 0 when none); usingCpu: null when no processor reading could be had. */
export interface Silence { step: string; done?: number; total?: number; silentMs: number; lastProgressAt: number; maxGapMs: number; expectMs: number; usingCpu: boolean | null; cpuMs: number | null }
/** What a watch tells the job it runs in (the server sets it for each call; a watch made inside the call reports to it):
 *  line — while its work uses the processor without progress, a line such as "using CPU, no progress since 10:42 (12 min) — cancel it
 *  if that is not expected", each window, and null once progress returns; silence — every window with no progress (the facts). Neither
 *  decides anything: the job is not stopped. */
export interface WatchReport { line(text: string | null): void; silence(s: Silence): void }
export const watchReport = new AsyncLocalStorage<WatchReport>();
const hhmm = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** The busy line's words. */
export const busyWords = (lastProgressAt: number, now = Date.now()) => `using CPU, no progress since ${hhmm(lastProgressAt)} (${dur(now - lastProgressAt)}) — cancel it if that is not expected`;

/** A job ended as frozen. */
export interface StuckInfo {
  /** idle: no progress and no processor time; silent: no progress and no processor reading to be had */
  kind: 'idle' | 'silent';
  step: string; done?: number; total?: number;
  /** ms since the work last showed progress */
  silentMs: number;
  /** the windows in a row that judged it, and their length */
  windows: number; windowMs: number;
  /** processor time (ms) it used in the last window; null: none could be read */
  cpuMs: number | null;
  /** what the step was expected to take (ms; informational, e.g. an opaque call's estimate), 0 when none */
  expectMs?: number;
}

/** What a watch needs of the work: when it last made progress (ms timestamp), its processor time so far (ms; null when it cannot be
 *  read), and where it is (for the message). */
interface Watched { lastProgressAt(): number; /** the longest gap between two progress points so far (ms; 0: none yet) */ maxGapMs(): number; cpu?: () => Promise<number | null>; where(): { step: string; done?: number; total?: number; expectMs?: number }; refresh?: () => Promise<void> }
/** The one watch loop: a check every window, the verdict above, onStuck once. Returns stop(). */
function watchLoop(w: Watched, onStuck: (i: StuckInfo) => void, windowMs = livenessWindowMs()): () => void {
  const c: LiveCounters = { idle: 0, unread: 0 };
  const report = watchReport.getStore();
  let told = false;
  const tell = (line: string | null) => { if (!report || (!line && !told)) return; told = !!line; try { report.line(line); } catch { /* the job is gone */ } };
  let stopped = false, winStart = Date.now(), due = 0, cpuThen: number | null = null, gotBase = false, timer: ReturnType<typeof setTimeout> | undefined;
  const base = w.cpu ? w.cpu().then((v) => { cpuThen = v; gotBase = true; }, () => { gotBase = true; }) : Promise.resolve();
  // One window after another, each starting where the last one ended (the time spent reading the processor time — PowerShell on
  // Windows can take longer than a window under load — belongs to the next window, so progress made meanwhile always counts).
  // due: when this check is meant to fire — the window's end, or now when our own reading already ran past it (that time is not lag).
  const next = () => { if (!stopped) { const now = Date.now(); due = Math.max(winStart + windowMs, now); timer = setTimeout(check, due - now); timer.unref?.(); } };
  const check = async () => {
    if (stopped) return;
    try {
      await base;
      const now = Date.now();
      // this process did not get to look for a whole window or more after the check was due (its own event loop was busy): that window
      // is not counted. Measured from when the timer was due, never from the window's start: a reading that took two windows or more
      // would otherwise make every later check "late" and no window would ever be judged (review 4L-13 H1).
      if (now - due >= windowMs) { winStart = now; cpuThen = w.cpu ? await w.cpu().catch(() => null) : null; return; }
      await w.refresh?.().catch(() => undefined);
      const progressed = w.lastProgressAt() >= winStart;
      const nextStart = Date.now();
      const cpuNow = w.cpu ? await w.cpu().catch(() => null) : null;
      const used = cpuNow != null && cpuThen != null && gotBase ? Math.max(0, cpuNow - cpuThen) : null;
      cpuThen = cpuNow; winStart = nextStart;
      const v = verdict(c, progressed, used);
      // working without progress: said on the job's line (never a reason to stop it); taken back once it moves again
      if (!progressed && used != null && used >= BUSY_CPU_MS) tell(busyWords(w.lastProgressAt())); else if (progressed) tell(null);
      // every window with no progress: its facts to the job (which may wake the agent; nothing is stopped by it)
      if (!progressed && report) {
        const at = w.where(), last = w.lastProgressAt();
        try { report.silence({ step: at.step, ...(at.done != null ? { done: at.done } : {}), ...(at.total ? { total: at.total } : {}), silentMs: Date.now() - last, lastProgressAt: last, maxGapMs: w.maxGapMs(), expectMs: at.expectMs ?? 0, usingCpu: used == null ? null : used >= BUSY_CPU_MS, cpuMs: used }); } catch { /* the job is gone */ }
      }
      if (v === 'idle' || v === 'silent') {
        stopped = true;
        onStuck({ kind: v, ...w.where(), silentMs: Date.now() - w.lastProgressAt(), windows: v === 'idle' ? c.idle : c.unread, windowMs, cpuMs: used });
      }
    } finally { next(); }
  };
  next();
  return () => { stopped = true; if (timer) clearTimeout(timer); tell(null); };
}

function dur(ms: number): string { return ms < 1000 ? `${Math.round(ms)} ms` : ms < 90_000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms / 6000) / 10} minutes`; }
/** The words for a job ended as frozen: which step, how long with no progress and no processor time, what was tried, the alternatives.
 *  what: who ("The geometry worker"); tried and next are the caller's. */
export function stuckMessage(i: StuckInfo, o: { what: string; tried?: string; next: string }): string {
  const at = i.total ? ` (${i.done ?? 0} of ${i.total})` : i.done ? ` (${i.done} done)` : '';
  const where = `${i.step}${at}`;
  const expected = i.expectMs ? ` (about ${dur(i.expectMs)} was expected for this input on this machine)` : '';
  const why = i.kind === 'idle'
    ? `no progress for ${dur(i.silentMs)} and no processor time (${i.cpuMs ?? 0} ms) in ${i.windows} windows of ${dur(i.windowMs)} in a row${expected} — it was frozen, or waiting on something nobody can answer (a dialog nobody can see)`
    : `no progress for ${dur(i.silentMs)} in ${i.windows} windows of ${dur(i.windowMs)} in a row, and its processor time could not be read here${expected}`;
  return `${o.what} was ended as frozen while ${where}: ${why}. It is never ended while it works (uses the processor).${o.tried ? ` Tried: ${o.tried}.` : ''} Alternatives: ${o.next}.`;
}

/** The structured fields of an ended job, for the tool's error data (the same facts as the words). */
export interface StuckData { step: string; kind: StuckInfo['kind']; silent_ms: number; windows: number; window_ms: number; cpu_ms: number | null; expected_ms?: number; done?: number; total?: number; tried?: string; alternatives: string }
export function stuckData(i: StuckInfo, o: { tried?: string; next: string }): StuckData {
  return {
    step: i.step, kind: i.kind, silent_ms: Math.round(i.silentMs), windows: i.windows, window_ms: Math.round(i.windowMs), cpu_ms: i.cpuMs == null ? null : Math.round(i.cpuMs),
    ...(i.expectMs ? { expected_ms: Math.round(i.expectMs) } : {}),
    ...(i.done != null ? { done: i.done } : {}), ...(i.total ? { total: i.total } : {}), ...(o.tried ? { tried: o.tried } : {}), alternatives: o.next,
  };
}
/** An Error for a job ended as frozen: its message is stuckMessage, its data the structured fields (tools put them in the error's data). */
export class StuckError extends Error {
  readonly stuck: StuckData;
  constructor(i: StuckInfo, o: { what: string; tried?: string; next: string }, prefix = '', suffix = '') { super(`${prefix}${stuckMessage(i, o)}${suffix}`); this.stuck = stuckData(i, o); this.name = 'StuckError'; }
}

/** What a worker's heartbeat line says (heartbeat.mjs): its process's processor time (ms) and memory, the step, its progress, the time
 *  since its last tick, the step's estimate (informational). */
export interface Beat { cpu: number; rss: number; done: number; total: number; step: string; expectMs: number; sinceMs: number; stepMs: number; /** the longest gap between two ticks the worker has shown (measured there; opaque calls are not gaps) */ maxGapMs?: number }
const HB = '\u0001HB ';

/** Watch a worker process we wrote: progress is what its heartbeats say (a tick newer than the window's start, a new step); its processor
 *  time is its process tree's (treeCpuMs), or where that cannot be read the time its own heartbeat reports (its process). The child must
 *  have stdout piped and the heartbeat environment (heartbeatEnv). onText gets what the worker printed besides heartbeats; onBeat each
 *  heartbeat (a parent that forwards a child's progress). */
export function heartbeatWatcher(child: ChildProcess, o: { onStuck: (i: StuckInfo) => void; onText?: (text: string) => void; onBeat?: (b: Beat) => void; windowMs?: number }): () => void {
  let rest = '', last: { b: Beat; at: number } | null = null, lastStep = '';
  let progressAt = Date.now();
  child.stdout?.on('data', (d) => {
    const lines = (rest + String(d)).split('\n'); rest = lines.pop() ?? '';
    const text: string[] = [];
    for (const l of lines) {
      if (!l.startsWith(HB)) { text.push(l); continue; }
      try {
        const b = JSON.parse(l.slice(HB.length)) as Beat, at = Date.now();
        // its last tick, by its own clock; a new step is progress too
        progressAt = Math.max(progressAt, at - Math.max(0, b.sinceMs), b.step !== lastStep ? at : 0);
        lastStep = b.step; last = { b, at };
        o.onBeat?.(b);
      } catch { /* a cut line */ }
    }
    if (text.length) o.onText?.(text.join('\n') + '\n');
  });
  child.stdout?.on('end', () => { if (rest && !rest.startsWith(HB)) o.onText?.(rest); });
  const cpu = async (): Promise<number | null> => (child.pid ? await treeCpuMs(child.pid) : null) ?? last?.b.cpu ?? null;
  return watchLoop({
    lastProgressAt: () => progressAt, maxGapMs: () => last?.b.maxGapMs ?? 0, cpu,
    where: () => (last ? { step: last.b.step, done: last.b.done, total: last.b.total, expectMs: last.b.expectMs } : { step: 'starting' }),
  }, o.onStuck, o.windowMs);
}
/** The environment that makes a worker send heartbeats (every P6CLONE_HEARTBEAT_MS, 5000), with this machine's speed factor
 *  (the start-up benchmark, once) and the job's own measured rates (its estimates). */
export const heartbeatEnv = (): Record<string, string> => ({ P6CLONE_HEARTBEAT_MS: String(Number(process.env.P6CLONE_HEARTBEAT_MS) || 5000), ...rateEnv() });

/** A watch on work whose ticks we see from here (frames drawn, tiles loaded, ffmpeg's frames, a compute worker's rows). A tick counts
 *  only when done ADVANCED (the same count again is no progress); a new step is progress. cpu: the work's processor time so far (the
 *  program's process tree, a worker thread's busy time); without one, frozen after three windows with no progress. */
export interface UnitWatch {
  beat(done: number, total?: number): void;
  /** a new step (its name is in the message); expectMs: what it is expected to take (informational) */
  step(name: string, o?: { expectMs?: number; total?: number }): void;
  stop(): void;
}
export function unitWatch(o: { onStuck: (i: StuckInfo) => void; step?: string; cpu?: () => Promise<number | null>; windowMs?: number }): UnitWatch {
  let name = o.step ?? 'starting', expect = 0, total = 0, doneN = 0, lastDone = -1, progressAt = Date.now(), maxGap = 0;
  const stop = watchLoop({ lastProgressAt: () => progressAt, maxGapMs: () => maxGap, cpu: o.cpu, where: () => ({ step: name, done: doneN, total, expectMs: expect }) }, o.onStuck, o.windowMs);
  return {
    beat(d, t) {
      if (t != null) total = t;
      if (d <= lastDone) return; // the same count again (or less) is no progress
      const now = Date.now();
      maxGap = Math.max(maxGap, now - progressAt); // the job's own record (kept across its steps)
      lastDone = d; doneN = d; progressAt = now;
    },
    step(n, s = {}) { name = n; expect = s.expectMs ?? 0; total = s.total ?? 0; doneN = 0; lastDone = -1; progressAt = Date.now(); },
    stop,
  };
}

/** A watch on a program we cannot see inside (Microsoft Project through COM, MPXJ): progress is its output growing; cpu: the processor
 *  time of everything of the program. Frozen as everywhere: no output and no processor time for two windows in a row (a program waiting
 *  on a dialog uses none), or no output for three with no reading. */
export function externalWatch(o: { step: string; expectMs?: number; output?: () => number | Promise<number>; cpu?: () => Promise<number | null>; onStuck: (i: StuckInfo) => void; windowMs?: number }): () => void {
  let progressAt = Date.now(), lastOut: number | null = null, maxGap = 0;
  // the output is read at each check: grown (or shrunk) since the last one is progress
  const refresh = async () => { if (!o.output) return; const out = await o.output(); if (lastOut != null && out !== lastOut) { const now = Date.now(); maxGap = Math.max(maxGap, now - progressAt); progressAt = now; } lastOut = out; };
  void refresh().catch(() => undefined);
  return watchLoop({ lastProgressAt: () => progressAt, maxGapMs: () => maxGap, cpu: o.cpu, refresh, where: () => ({ step: o.step, expectMs: o.expectMs ?? 0 }) }, o.onStuck, o.windowMs);
}
