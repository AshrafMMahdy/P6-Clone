// Liveness instead of time limits (owner rule 2026-10-27: no arbitrary time limits). A long job (a render, a Revit
// conversion) runs as long as it shows life: a unit of progress arrives (a frame, a tile, bytes written), or its
// process tree keeps using the processor. It is declared stuck only after MISSED windows in a row, a window being
// sized from the time one unit of progress was measured to take (with a floor the caller states). The processor time
// comes from the worker itself (heartbeat.mjs: process.cpuUsage, any platform), or is read from outside (treeCpuMs:
// /proc, PowerShell / wmic / tasklist, ps); where neither works, progress alone counts.
import { execFile, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

/** Summed processor time (ms) of a process and its descendants from a table of [pid, parent pid, ms] rows. */
export function sumTree(rows: Array<[number, number, number]>, pid: number): number {
  const mine = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const [p, pp] of rows) if (!mine.has(p) && mine.has(pp)) { mine.add(p); grew = true; } }
  return rows.filter(([p]) => mine.has(p)).reduce((n, [, , ms]) => n + ms, 0);
}
/** Windows: PowerShell's CIM table (Win32_Process: kernel and user time in 100 ns), or wmic's CSV of the same columns. */
export function parseWindowsCpu(csv: string): Array<[number, number, number]> {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = (lines.shift() ?? '').split(',').map((h) => h.replace(/"/g, '').trim().toLowerCase());
  const col = (n: string) => head.indexOf(n.toLowerCase());
  const [ip, ipp, ik, iu] = [col('ProcessId'), col('ParentProcessId'), col('KernelModeTime'), col('UserModeTime')];
  if ([ip, ipp, ik, iu].some((i) => i < 0)) return [];
  return lines.map((l) => l.split(',').map((c) => c.replace(/"/g, '').trim())).map((c): [number, number, number] => [Number(c[ip]), Number(c[ipp]), (Number(c[ik]) + Number(c[iu])) / 10_000]).filter((r) => r.every(Number.isFinite));
}
/** macOS / BSD: `ps -A -o pid=,ppid=,cputime=` ("[[dd-]hh:]mm:ss[.ff]"). */
export function parsePsCpu(text: string): Array<[number, number, number]> {
  const secs = (t: string) => { const [d, rest] = t.includes('-') ? t.split('-') : ['0', t]; return rest.split(':').reduce((n, x) => n * 60 + Number(x), 0) + Number(d) * 86400; };
  return text.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 3).map((c): [number, number, number] => [Number(c[0]), Number(c[1]), secs(c[2]) * 1000]).filter((r) => r.every(Number.isFinite));
}
const run = (cmd: string, args: string[]) => new Promise<string | null>((done) => {
  try { execFile(cmd, args, { windowsHide: true, timeout: 20_000, maxBuffer: 16 << 20 }, (e, out) => done(e ? null : String(out))); } catch { done(null); }
});
/** The processor time (ms) used so far by a process and all its descendants (a browser's renderer and graphics processes,
 *  say), read from outside the process; null where no way works (then only progress counts). Linux: /proc (ticks of
 *  10 ms). Windows: PowerShell, then wmic, then tasklist (the process itself only). macOS: ps. A worker we wrote reports
 *  its own instead (heartbeat.mjs), which needs none of this. */
export async function treeCpuMs(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'linux') {
      const rows: Array<[number, number, number]> = [];
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        let stat: string;
        try { stat = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; } // gone since the listing
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // after "pid (comm) ": field 3 (state) is f[0]
        rows.push([Number(name), Number(f[1]), (Number(f[11]) + Number(f[12])) * 10]); // ppid; utime, stime
      }
      return sumTree(rows, pid);
    }
    if (process.platform === 'win32') {
      const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Csv -NoTypeInformation']);
      let rows = ps ? parseWindowsCpu(ps) : [];
      if (!rows.length) { const w = await run('wmic', ['process', 'get', 'ProcessId,ParentProcessId,KernelModeTime,UserModeTime', '/format:csv']); rows = w ? parseWindowsCpu(w) : []; }
      if (rows.length) return sumTree(rows, pid);
      const t = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/V']); // "CPU Time" as h:mm:ss, the process alone
      const m = t && /"(\d+):(\d\d):(\d\d)"/.exec(t);
      return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
    }
    const ps = await run('ps', ['-A', '-o', 'pid=,ppid=,cputime=']);
    return ps ? sumTree(parsePsCpu(ps), pid) : null;
  } catch { return null; }
}

export interface LivenessOptions {
  /** The shortest a window may be: what a start, a garbage collection or a flush may take without it meaning anything. */
  floorMs: number;
  /** The window now: the caller's multiple of the measured time of one unit of progress (never below floorMs). */
  windowMs?: () => number;
  /** Changes whenever the job has moved on (a count of frames or tiles, a file's size). */
  progress: () => number;
  /** The processor time (ms) of the job so far, if it can be had: changes while the job works. */
  cpu?: () => number | null | undefined | Promise<number | null | undefined>;
  /** Called once, with the time it was silent (ms), when the job is stuck. */
  onStuck: (silentMs: number) => void;
  /** Missed windows in a row before it is stuck (2). */
  windows?: number;
  /** How often the clock is looked at (ms). */
  pollMs?: number;
}

/** Watch a job: a window passes with neither progress nor processor time (at least 2 % of one core) = one missed; two in
 *  a row = stuck. Returns the function that stops the watch. */
export function watchLiveness(o: LivenessOptions): () => void {
  const need = o.windows ?? 2, length = () => Math.max(o.floorMs, o.windowMs?.() ?? 0);
  let start = Date.now(), seen = o.progress(), cpuThen: number | null = null, missed = 0, done = false, busy = false;
  const read = async () => { try { return (await o.cpu?.()) ?? null; } catch { return null; } };
  void read().then((c) => { cpuThen ??= c; });
  const timer = setInterval(async () => {
    const win = length(), now = Date.now();
    if (done || busy || now - start < win) return;
    busy = true;
    try {
      const cpu = await read(), prog = o.progress();
      if (done) return;
      const moved = prog !== seen || (cpu != null && cpuThen != null && cpu - cpuThen >= 0.02 * win);
      missed = moved ? 0 : missed + 1;
      start = Date.now(); seen = prog; cpuThen = cpu;
      if (missed >= need) { done = true; clearInterval(timer); o.onStuck(win * need); }
    } finally { busy = false; }
  }, o.pollMs ?? Math.max(10, Math.min(1000, Math.floor(o.floorMs / 4))));
  timer.unref?.();
  return () => { done = true; clearInterval(timer); };
}

/** What a worker's heartbeat line says (heartbeat.mjs). */
export interface Beat { cpu: number; rss: number; progress: number }
const HB = '\u0001HB ';

/** Watch a worker process we wrote: its heartbeats (stdout lines from its own thread, with its own processor time and
 *  progress counter) are the evidence of life, whatever the platform. Stuck = two windows in a row with no progress and
 *  no processor time reported (silence counts as neither), a window being 4 times the slowest gap between two
 *  progress steps seen, never under floorMs. The child must have stdout piped and P6CLONE_HEARTBEAT_MS in its
 *  environment (heartbeatEnv). onText gets what the worker printed besides heartbeats. */
export function heartbeatWatcher(child: ChildProcess, o: { floorMs: number; onStuck: (silentMs: number) => void; onText?: (text: string) => void; pollMs?: number }): () => void {
  let rest = '', last: Beat | null = null, beats = 0, lastStep = Date.now(), slowest = 0;
  child.stdout?.on('data', (d) => {
    const lines = (rest + String(d)).split('\n'); rest = lines.pop() ?? '';
    const text: string[] = [];
    for (const l of lines) {
      if (!l.startsWith(HB)) { text.push(l); continue; }
      try {
        const b = JSON.parse(l.slice(HB.length)) as Beat, now = Date.now();
        if (!last || b.progress !== last.progress) { if (last) slowest = Math.max(slowest, now - lastStep); lastStep = now; }
        last = b; beats++;
      } catch { /* a cut line */ }
    }
    if (text.length) o.onText?.(text.join('\n') + '\n');
  });
  child.stdout?.on('end', () => { if (rest && !rest.startsWith(HB)) o.onText?.(rest); });
  return watchLiveness({ floorMs: o.floorMs, windowMs: () => 4 * slowest, progress: () => (last ? last.progress : -1), cpu: () => last?.cpu ?? null, onStuck: o.onStuck, ...(o.pollMs ? { pollMs: o.pollMs } : {}) });
}
/** The environment that makes a worker send heartbeats (every P6CLONE_HEARTBEAT_MS, 5000). */
export const heartbeatEnv = (): Record<string, string> => ({ P6CLONE_HEARTBEAT_MS: String(Number(process.env.P6CLONE_HEARTBEAT_MS) || 5000) });
/** The shortest window for a worker (ms): 2 minutes, because a quiet start, one huge synchronous call (WebAssembly) or a
 *  garbage collection can pass without a progress step or much processor time reported between two heartbeats; two
 *  such windows in a row (4 minutes) with nothing at all is not that. P6CLONE_WORKER_FLOOR_MS (the environment only:
 *  tests) shortens it. */
export const workerFloorMs = () => Number(process.env.P6CLONE_WORKER_FLOOR_MS) || 120_000;
