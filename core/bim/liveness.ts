// Liveness instead of time limits (owner rules 2026-10-27 and 2026-10-28: no fixed time limits; only progress and stated limits
// relative to the work). Two layers:
//  1. A loop we own ticks (a product meshed, a tile written, a frame drawn). A job is stuck when it has not ticked for two
//     windows, a window being 4 times the longest gap between ticks THIS job has shown, never under a floor (120 s, the
//     time a start, a garbage collection or a driver stall may take). Processor time is NOT life: a loop that spins without
//     ticking is stuck. A job that is slow but keeps ticking is never ended.
//  2. An opaque call (one WebAssembly read, one inflate of a whole section, a COM conversion) cannot tick: it declares how long
//     it should take (input size x the rate measured on this machine, heartbeat.mjs expectedMs) and is ended past
//     BOUND_MULTIPLE (10) times that, never under the floor.
// Workers we wrote report from their own thread (heartbeat.mjs: the step, the time since the last tick, the longest gap, the
// declared bound); the parent judges (heartbeatWatcher). The browser and other programs we drive are watched from here
// (unitWatch: ticks we see; externalWatch: an external program's output and processor time). stuckMessage() is the one
// text for an ended job: which step, how long without progress or which bound was passed, what was tried, the alternatives.
// The processor time of a process tree (treeCpuMs: /proc, PowerShell / wmic / tasklist, ps) is read only where it is
// evidence of something else than life (a program waiting on a dialog uses none).
import { execFile, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { BOUND_MULTIPLE, rateEnv } from './heartbeat.mjs';

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

export { BOUND_MULTIPLE };
/** The shortest a window may be: what a start, a garbage collection or a flush may take without it meaning anything.
 *  P6CLONE_WORKER_FLOOR_MS (the environment only: tests) shortens it. */
export const workerFloorMs = () => Number(process.env.P6CLONE_WORKER_FLOOR_MS) || 120_000;
/** A browser starting and loading the viewer has no work to size a bound from: one named window, two of them in a row = stuck. */
export const startupWindowMs = () => Number(process.env.P6CLONE_STARTUP_WINDOW_MS) || 60_000;

/** Where a job is, as the judge needs it. */
export interface StepState {
  /** the step now running ("meshing products") */
  step: string;
  /** ms since the step's last tick (or its start) */
  sinceMs: number;
  /** the longest gap between two ticks this job has shown */
  maxGapMs: number;
  /** > 0: the step is ONE opaque call that should take this long (ms); it is ended past BOUND_MULTIPLE times that */
  expectMs: number;
  /** > 0: the work bound of the whole step (ms): no silence may pass BOUND_MULTIPLE times it, whatever the gaps were */
  capMs: number;
  done?: number; total?: number;
  /** a window of its own (start-up) instead of 4 times the longest gap */
  windowMs?: number;
}
export interface StuckInfo {
  /** silent: no tick for two windows; bound: an opaque call past its work bound; idle: a program that used no processor time */
  kind: 'silent' | 'bound' | 'idle';
  step: string; done?: number; total?: number;
  silentMs: number; windowMs: number; limitMs: number; maxGapMs: number; expectMs: number; floorMs: number;
  /** the silence limit was lengthened to the step's work bound (one element, one piece may take as long as the whole step's size allows) */
  lengthened: boolean;
}

/** The one rule. null: alive. */
export function judge(s: StepState, floorMs: number): StuckInfo | null {
  const base = { step: s.step, ...(s.done != null ? { done: s.done } : {}), ...(s.total ? { total: s.total } : {}), silentMs: s.sinceMs, maxGapMs: s.maxGapMs, expectMs: s.expectMs, floorMs };
  if (s.expectMs > 0) {
    const limit = Math.max(floorMs, s.expectMs * BOUND_MULTIPLE);
    return s.sinceMs > limit ? { kind: 'bound', windowMs: limit, limitMs: limit, lengthened: false, ...base } : null;
  }
  const windowMs = s.windowMs ?? Math.max(floorMs, 4 * s.maxGapMs);
  // a step that knows its whole work (capMs: the size of the step x the rate on this machine) allows ONE tick to take as long as
  // that work bound allows (10 x): a single heavy element is an opaque call bounded by the size of what it works on, which cannot be
  // known before it is done, so by the step's whole size. Never shorter than two windows of the job's own gaps.
  let limitMs = 2 * windowMs, lengthened = false;
  if (s.capMs > 0) { const cap = s.capMs * BOUND_MULTIPLE; if (cap > limitMs) { limitMs = cap; lengthened = true; } }
  return s.sinceMs > limitMs ? { kind: 'silent', windowMs, limitMs, lengthened, ...base } : null;
}

const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 90_000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms / 6000) / 10} minutes`);
/** The words for a job ended as stuck: which step, how long with no progress (or which bound was passed, and its value),
 *  what was tried, the alternatives. what: who ("The geometry worker"); tried and next are the caller's. */
export function stuckMessage(i: StuckInfo, o: { what: string; tried?: string; next: string }): string {
  const at = i.total ? ` (${i.done ?? 0} of ${i.total})` : i.done ? ` (${i.done} done)` : '';
  const where = `${i.step}${at}`;
  const gap = i.maxGapMs > 0 ? `, each 4 times the longest gap between steps this job showed (${dur(i.maxGapMs)}), at least ${dur(i.floorMs)}` : `, the minimum of ${dur(i.floorMs)}: this job had shown no gap between steps yet`;
  const why = i.kind === 'bound'
    ? `one call that cannot report progress ran past its work bound of ${dur(i.limitMs)} (about ${dur(i.expectMs)} expected for this input at this machine's measured rate, times ${BOUND_MULTIPLE}); it had been silent for ${dur(i.silentMs)}`
    : i.kind === 'idle'
      ? `it used no processor time and wrote nothing for ${dur(i.silentMs)} (two windows of ${dur(i.windowMs)}), which is what a program does when it waits on a dialog nobody can see`
      : `no progress for ${dur(i.silentMs)} (two windows of ${dur(i.windowMs)}${gap}${i.lengthened ? `; lengthened to the step's work bound of ${dur(i.limitMs)}, because one piece of work may take as long as the size of the whole step allows` : ''})`;
  return `${o.what} was ended as stuck while ${where}: ${why}.${o.tried ? ` Tried: ${o.tried}.` : ''} Alternatives: ${o.next}.`;
}

/** The structured fields of an ended job, for the tool's error data (the same facts as the words): the step, the silence or the bound
 *  with its value, what was tried, the alternatives. */
export interface StuckData { step: string; kind: StuckInfo['kind']; silent_ms: number; window_ms?: number; windows?: number; bound_ms?: number; expected_ms?: number; longest_gap_ms?: number; done?: number; total?: number; tried?: string; alternatives: string }
export function stuckData(i: StuckInfo, o: { tried?: string; next: string }): StuckData {
  return {
    step: i.step, kind: i.kind, silent_ms: Math.round(i.silentMs),
    ...(i.kind === 'bound' ? { bound_ms: Math.round(i.limitMs), expected_ms: Math.round(i.expectMs) } : { window_ms: Math.round(i.windowMs), windows: 2, ...(i.maxGapMs > 0 ? { longest_gap_ms: Math.round(i.maxGapMs) } : {}) }),
    ...(i.done != null ? { done: i.done } : {}), ...(i.total ? { total: i.total } : {}), ...(o.tried ? { tried: o.tried } : {}), alternatives: o.next,
  };
}
/** An Error for a job ended as stuck: its message is stuckMessage, its data the structured fields (tools put them in the error's data). */
export class StuckError extends Error {
  readonly stuck: StuckData;
  constructor(i: StuckInfo, o: { what: string; tried?: string; next: string }, prefix = '', suffix = '') { super(`${prefix}${stuckMessage(i, o)}${suffix}`); this.stuck = stuckData(i, o); this.name = 'StuckError'; }
}

/** What a worker's heartbeat line says (heartbeat.mjs). */
export interface Beat { cpu: number; rss: number; done: number; total: number; step: string; expectMs: number; capMs: number; sinceMs: number; stepMs: number; maxGapMs: number }
const HB = '\u0001HB ';

/** Watch a worker process we wrote: its heartbeats (stdout lines from its own thread: the step, the time since its last tick
 *  measured there, the longest gap, the bound it declared) are the evidence, whatever the platform. Stuck by judge(): two
 *  silent windows (4 x the longest gap, never under floorMs), or an opaque call past BOUND_MULTIPLE x its expected time.
 *  Silence of the whole process (no heartbeat at all) counts as time since the last tick. The child must have stdout
 *  piped and the heartbeat environment (heartbeatEnv). onText gets what the worker printed besides heartbeats; onBeat
 *  each heartbeat (a parent that forwards a child's progress). */
export function heartbeatWatcher(child: ChildProcess, o: { floorMs: number; onStuck: (i: StuckInfo) => void; onText?: (text: string) => void; onBeat?: (b: Beat) => void; pollMs?: number }): () => void {
  let rest = '', last: { b: Beat; at: number } | null = null, done = false;
  const t0 = Date.now();
  child.stdout?.on('data', (d) => {
    const lines = (rest + String(d)).split('\n'); rest = lines.pop() ?? '';
    const text: string[] = [];
    for (const l of lines) {
      if (!l.startsWith(HB)) { text.push(l); continue; }
      try { const b = JSON.parse(l.slice(HB.length)) as Beat; last = { b, at: Date.now() }; o.onBeat?.(b); } catch { /* a cut line */ }
    }
    if (text.length) o.onText?.(text.join('\n') + '\n');
  });
  child.stdout?.on('end', () => { if (rest && !rest.startsWith(HB)) o.onText?.(rest); });
  const timer = setInterval(() => {
    if (done) return;
    const now = Date.now();
    const s: StepState = last
      ? { step: last.b.step, sinceMs: last.b.sinceMs + (now - last.at), maxGapMs: last.b.maxGapMs, expectMs: last.b.expectMs, capMs: last.b.capMs, done: last.b.done, total: last.b.total }
      : { step: 'starting', sinceMs: now - t0, maxGapMs: 0, expectMs: 0, capMs: 0 };
    const stuck = judge(s, o.floorMs);
    if (stuck) { done = true; clearInterval(timer); o.onStuck(stuck); }
  }, o.pollMs ?? Math.max(10, Math.min(1000, Math.floor(o.floorMs / 4))));
  timer.unref?.();
  return () => { done = true; clearInterval(timer); };
}
/** The environment that makes a worker send heartbeats (every P6CLONE_HEARTBEAT_MS, 5000), with this machine's speed factor
 *  (the start-up benchmark, once) and the job's own measured rates, which the worker's bounds are sized from. */
export const heartbeatEnv = (): Record<string, string> => ({ P6CLONE_HEARTBEAT_MS: String(Number(process.env.P6CLONE_HEARTBEAT_MS) || 5000), ...rateEnv() });

/** A watch on work whose ticks we see from here (frames drawn, tiles loaded, ffmpeg's frames): the same judge as the
 *  workers'. The first beat of a step is the baseline; the first unit completed after it ends an opaque estimate (expectMs)
 *  and is the first measured gap. A unit's gap is the time it took (a jump of several units counts as their mean). */
export interface UnitWatch {
  beat(done: number, total?: number): void;
  step(name: string, o?: { expectMs?: number; total?: number; windowMs?: number; capMs?: number }): void;
  state(): StepState;
  stop(): void;
}
export function unitWatch(o: { floorMs: number; onStuck: (i: StuckInfo) => void; pollMs?: number; step?: string; expectMs?: number; windowMs?: number }): UnitWatch {
  let name = o.step ?? 'starting', expect = o.expectMs ?? 0, window = o.windowMs, cap = 0, total = 0, doneN = 0, lastDone = -1, tickAt = Date.now(), maxGap = 0, stopped = false;
  const state = (): StepState => ({ step: name, sinceMs: Date.now() - tickAt, maxGapMs: maxGap, expectMs: expect, capMs: cap, done: doneN, total, ...(window ? { windowMs: window } : {}) });
  const timer = setInterval(() => {
    if (stopped) return;
    const stuck = judge(state(), o.floorMs);
    if (stuck) { stopped = true; clearInterval(timer); o.onStuck(stuck); }
  }, o.pollMs ?? Math.max(10, Math.min(1000, Math.floor(o.floorMs / 4))));
  timer.unref?.();
  return {
    beat(d, t) {
      if (t != null) total = t;
      if (d === lastDone || d < lastDone) return; // a tick counts only if done ADVANCED: the same count again is silence
      const now = Date.now();
      if (lastDone >= 0) { maxGap = Math.max(maxGap, (now - tickAt) / Math.max(1, d - lastDone)); expect = 0; }
      lastDone = d; doneN = d; tickAt = now;
    },
    step(n, s = {}) { name = n; expect = s.expectMs ?? 0; window = s.windowMs; cap = s.capMs ?? 0; total = s.total ?? 0; doneN = 0; lastDone = -1; tickAt = Date.now(); },
    state,
    stop() { stopped = true; clearInterval(timer); },
  };
}

/** A watch on a program we cannot see inside (Microsoft Project through COM): ended past its work bound (expectMs x
 *  BOUND_MULTIPLE, never under floorMs; output written resets the clock), or when neither its output grows nor it uses
 *  processor time for two windows of max(floorMs / 2, a quarter of the bound) (kind idle: waiting on a dialog). A program that
 *  reaches its bound after a window with no processor time is reported as idle too: that is what the bound found.
 *  cpu: the processor time (ms) of everything of the program. */
export function externalWatch(o: { step: string; floorMs: number; expectMs: number; output?: () => number | Promise<number>; cpu?: () => Promise<number | null>; onStuck: (i: StuckInfo) => void; pollMs?: number }): () => void {
  const bound = Math.max(o.floorMs, o.expectMs * BOUND_MULTIPLE), win = Math.max(o.floorMs / 2, bound / 4);
  const t0 = Date.now();
  let lastTick = t0, lastOut = -1, winStart = lastTick, winMoved = false, cpuThen: number | null = null, idle = 0, busy = false, done = false;
  const fire = (i: StuckInfo) => { done = true; clearInterval(timer); o.onStuck(i); };
  const timer = setInterval(async () => {
    if (done || busy) return;
    busy = true;
    try {
      const now = Date.now();
      const out = o.output ? await o.output() : 0;
      // output written resets the clock, but only up to the work bound: a save whose file keeps growing for ever is not alive
      if (out !== lastOut) { if (lastOut >= 0 && now - t0 <= bound) { lastTick = now; winMoved = true; } lastOut = out; }
      if (cpuThen == null && o.cpu) cpuThen = await o.cpu();
      if (now - winStart >= win) {
        const cpu = o.cpu ? await o.cpu() : null;
        const used = cpu != null && cpuThen != null && cpu - cpuThen > Math.max(50, 0.005 * win);
        idle = winMoved || used || cpu == null ? 0 : idle + 1;
        cpuThen = cpu; winStart = now; winMoved = false;
        if (idle >= 2) { fire({ kind: 'idle', step: o.step, silentMs: now - lastTick, windowMs: win, limitMs: 2 * win, maxGapMs: 0, expectMs: o.expectMs, floorMs: o.floorMs, lengthened: false }); return; }
      }
      const past = judge({ step: o.step, sinceMs: now - lastTick, maxGapMs: 0, expectMs: o.expectMs, capMs: 0 }, o.floorMs);
      if (past) fire(idle >= 1 ? { ...past, kind: 'idle', windowMs: win } : past);
    } finally { busy = false; }
  }, o.pollMs ?? Math.max(10, Math.min(2000, Math.floor(o.floorMs / 4))));
  timer.unref?.();
  return () => { done = true; clearInterval(timer); };
}
