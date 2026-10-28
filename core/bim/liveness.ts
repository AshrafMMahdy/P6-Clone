// Liveness instead of time limits (owner rule 2026-10-27: no arbitrary time limits). A long job (a render, a Revit
// conversion) runs as long as it shows life: a unit of progress arrives (a frame, a tile, bytes written), or its
// process tree keeps using the processor. It is declared stuck only after MISSED windows in a row, a window being
// sized from the time one unit of progress was measured to take (with a floor the caller states). Where the processor
// time of a process cannot be read (anything but Linux, where /proc has it), progress alone counts.
import { readdirSync, readFileSync } from 'node:fs';

/** The processor time (ms) used so far by a process and all its descendants (a browser's renderer and graphics
 *  processes, say); null where it cannot be read. Linux: /proc, ticks of 10 ms (USER_HZ is 100 on every Linux build). */
export function treeCpuMs(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const parent = new Map<number, number>(), cpu = new Map<number, number>();
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try { stat = readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; } // gone since the listing
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // after "pid (comm) ": field 3 (state) is f[0]
      parent.set(Number(name), Number(f[1])); cpu.set(Number(name), (Number(f[11]) + Number(f[12])) * 10); // utime, stime
    }
    const mine = new Set([pid]);
    for (let grew = true; grew;) { grew = false; for (const [p, pp] of parent) if (!mine.has(p) && mine.has(pp)) { mine.add(p); grew = true; } }
    let sum = 0; for (const p of mine) sum += cpu.get(p) ?? 0;
    return sum;
  } catch { return null; }
}

export interface LivenessOptions {
  /** The shortest a window may be: what a start, a garbage collection or a flush may take without it meaning anything. */
  floorMs: number;
  /** The window now: the caller's multiple of the measured time of one unit of progress (never below floorMs). */
  windowMs?: () => number;
  /** Changes whenever the job has moved on (a count of frames or tiles, a file's size). */
  progress: () => number;
  /** The process whose tree is watched for processor time. */
  pid: () => number | undefined;
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
  let start = Date.now(), seen = o.progress(), cpuThen: number | null = (() => { const p = o.pid(); return p ? treeCpuMs(p) : null; })(), missed = 0, done = false;
  const timer = setInterval(() => {
    const win = length(), now = Date.now();
    if (done || now - start < win) return;
    const p = o.pid(), cpu = p ? treeCpuMs(p) : null, prog = o.progress();
    const moved = prog !== seen || (cpu != null && cpuThen != null && cpu - cpuThen >= 0.02 * win);
    missed = moved ? 0 : missed + 1;
    start = now; seen = prog; cpuThen = cpu;
    if (missed >= need) { done = true; clearInterval(timer); o.onStuck(win * need); }
  }, o.pollMs ?? Math.max(10, Math.min(1000, Math.floor(o.floorMs / 4))));
  timer.unref?.();
  return () => { done = true; clearInterval(timer); };
}
