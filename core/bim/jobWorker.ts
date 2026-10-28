// Work that reads input and builds something big (the IFC index, another tool's 4D file) runs in a process of its own, like the geometry
// worker, the Revit and the Navisworks readers: the MCP server never has to end itself over a stuck loop (it could only do so by
// ending EVERY project's session), and a stuck one ends only its worker and its call, with the reason (owner rule 2026-10-28: customer
// data survives). The worker is judged by its own heartbeat (heartbeat.mjs, liveness.ts heartbeatWatcher): ticks, windows of 4 x the
// longest gap, an opaque call's bound (10 x size x rate), a step's work bound.
// Protocol: the worker is started with the path of job.json ({ ..., dir }); it writes its result into dir and last a file named "done";
// a failure is a message on stderr and exit code 3.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { childV8Flags, heartbeatEnv, heartbeatWatcher, StuckError, workerFloorMs, type StuckInfo } from './liveness.ts';

/** The heap (MB) of a worker that holds a model's index: the memory budget plus headroom, never more than half the machine (at most 16 GB),
 *  nor less than 1 GB (as the Navisworks reader's, nwd.ts nwdHeapMb). */
export const indexHeapMb = (budgetMb: number = Number(process.env.P6CLONE_MEM_BUDGET_MB) || 3072, ramBytes: number = totalmem()): number =>
  Math.max(1024, Math.min(16384, Math.floor((ramBytes / 1048576) * 0.5), Math.ceil(budgetMb) + 512));

export interface WorkerJob { script: string; job: Record<string, unknown>; heapMb?: number; what: string; tried: string; next: string }

/** Run the worker on the job; when it has written "done", `after` reads the result from the job's folder (removed afterwards). A worker
 *  ended as stuck is a StuckError (step, silence or bound, tried, alternatives); any other failure is an Error with the worker's last line. */
export async function inWorker<T>(o: WorkerJob, after: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'p6clone-job-')), jobFile = join(dir, 'job.json');
  writeFileSync(jobFile, JSON.stringify({ ...o.job, dir }), { mode: 0o600 });
  try {
    let stuckErr: StuckError | null = null;
    const err = await new Promise<string | null>((done) => {
      const child = spawn(process.execPath, [...(o.heapMb ? [`--max-old-space-size=${o.heapMb}`] : []), ...childV8Flags(), o.script, jobFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...heartbeatEnv(), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
      let text = '', stuck: StuckInfo | null = null;
      child.stderr.on('data', (c) => { text = (text + c).slice(-4000); });
      const stop = heartbeatWatcher(child, { floorMs: workerFloorMs(), onStuck: (i) => { stuck = i; try { child.kill(); } catch { /* gone */ } } });
      child.on('error', (e) => { stop(); done(e.message); });
      // what it made is marked last: a worker that wrote "done" finished, even if the process then fell over on its way out
      child.on('close', (code, signal) => {
        stop();
        if (existsSync(join(dir, 'done'))) return done(null);
        if (stuck) { stuckErr = new StuckError(stuck, { what: o.what, tried: o.tried, next: o.next }); return done(stuckErr.message); }
        done(text.trim().split('\n').pop() || `${o.what} stopped (${signal ?? code})`);
      });
    });
    if (err) throw stuckErr ?? new Error(err);
    return await after(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
