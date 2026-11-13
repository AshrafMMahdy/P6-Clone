// 4L-13 (G8): a Monte Carlo run keeps each iteration as it finishes, in a file in the write root. A run that stops (an iteration
// fails, it is cancelled, its worker or its process is ended) answers that file's path as resume; a later call with resume runs only
// the iterations still missing, and with the same seed its answer EQUALS an uninterrupted run's, every statistic. A run that finishes
// removes its file; a resume that is not this run (other arguments, another seed, nothing there) is refused and changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMonteCarlo, testHooks, type MonteCarloOptions } from '../core/risk/montecarlo.ts';
import { parseP6Date } from '../core/dates.ts';
import { addRisk, linkActivity } from '../core/risk/register.ts';
import { claimHere, IterationFile } from '../mcp/keptRuns.ts';
const here = claimHere(() => undefined); // (a run's claim of its kept file, as the server's main thread makes it)
import { config, getSession, setRoots, usedMemory } from '../mcp/runtime.ts';

const root = mkdtempSync(join(tmpdir(), 'p6-mc-resume-'));
setRoots(null, root);
process.env.P6CLONE_COMPUTE_WORKERS = '0'; // the test hooks live in this process (one test below starts its own servers)

const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
/** A chain of activities with a milestone at its end, two register risks on it. */
const project = async (n: number) => {
  const np = (await call('new_project', { id: `MCR${Math.random().toString(36).slice(2, 6)}`, start: '2026-03-02' })).d;
  const ops: unknown[] = [];
  for (let i = 0; i < n; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `A${i}`, duration_days: 3 + (i % 4) }, ...(i ? [{ op: 'add_relationship', pred: `A${i - 1}`, succ: `A${i}` }] : []));
  ops.push({ op: 'add_activity', id: 'M1', name: 'Done', type: 'finish_milestone' }, { op: 'add_relationship', pred: `A${n - 1}`, succ: 'M1' });
  const e = await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const db = getSession(np.handle).db;
  const task = (code: string) => db.tables.TASK.rows.find((t) => t.task_code === code)!.task_id;
  const projId = db.tables.PROJECT.rows[0].proj_id;
  linkActivity(db, addRisk(db, projId, { pre_prob: 'M', pre_sched_impact_hr_cnt: '40' }).proj_risk_id, task('A3'));
  linkActivity(db, addRisk(db, projId, { pre_prob: 'L', pre_sched_impact_hr_cnt: '24' }).proj_risk_id, task(`A${n - 2}`));
  return { handle: np.handle as string, owner_key: np.owner_key as string };
};
const est = { min_pct: 80, max_pct: 140 };
const mcArgs = (h: { handle: string }, extra: Record<string, unknown> = {}) => ({ ...h, iterations: 120, seed: 11, default_estimates: est, events: [{ name: 'Late permit', probability: 0.3, delay_days: 4 }, { name: 'Crane', probability: 0.2, delay_days: 2, activities: ['A5'] }], deadline: '2026-07-01', ...extra });
/** The answer without what may differ between two equal runs (time taken, how much came from a file). */
const same = (d: any) => { const { elapsed_seconds: _e, resumed_iterations: _r, redone_iterations: _d, redone_note: _n, exported: _x, ...rest } = d; return JSON.parse(JSON.stringify(rest).replace(/analysis[\\/][^\\/"]+[\\/]/g, 'analysis/-/')); }; // (the notes name the result folder, which carries the project's and the file's names)
const keptFiles = () => readdirSync(root).filter((f) => f.startsWith('monte_carlo-'));

test('a run that failed part-way is continued from its kept iterations: the answer equals an uninterrupted run (same seed)', async () => {
  const h = await project(30);
  const full = (await call('monte_carlo', mcArgs(h))).d;
  assert.equal(full.partial, undefined);
  assert.deepEqual(keptFiles(), [], 'a finished run removes its kept file');
  assert.match(full.parts_removed, /monte_carlo-[0-9a-f]{12}-s11\.parts$/, 'and names it (a mirror of the outputs removes its copy)');
  testHooks.failAt = 47;
  let part;
  try { part = (await call('monte_carlo', mcArgs(h))).d; } finally { testHooks.failAt = null; }
  assert.equal(part.partial, true); assert.equal(part.iterations_done, 47);
  assert.ok(typeof part.resume === 'string' && existsSync(part.resume), JSON.stringify(part).slice(0, 400));
  assert.match(part.note, /to continue, call monte_carlo again with the same arguments and resume/);
  const resumed = (await call('monte_carlo', mcArgs(h, { resume: part.resume }))).d;
  assert.equal(resumed.resumed_iterations, 47);
  assert.equal(resumed.partial, undefined);
  assert.deepEqual(same(resumed), same(full));
  assert.equal(existsSync(part.resume), false, 'the finished run removed its kept file');
  await call('close', { ...h, discard: true });
});

test('core: every statistic of a run stopped twice and continued twice equals the uninterrupted run, a damaged tail is made again', async () => {
  const h = await project(25);
  const db = getSession(h.handle).db;
  const { defaultEstimates } = await import('../core/risk/montecarlo.ts');
  const ids = [db.tables.PROJECT.rows[0].proj_id];
  defaultEstimates(db, ids, 85, 130, 'betapert');
  const task = (code: string) => db.tables.TASK.rows.find((t) => t.task_code === code)!.task_id;
  const o = (store?: IterationFile): MonteCarloOptions => ({ iterations: 90, seed: 3, deadline: Date.UTC(2026, 5, 1) / 60000, sampler: { type: 'ratio_normal', scope: 'unestimated' }, events: [{ name: 'e', p: 0.4, taskHours: [[task('A2'), 16]], projectHours: 8 }], ...(store ? { store } : {}) });
  const strip = (r: any) => { const { elapsedMs: _e, resumed: _r, ...rest } = r; return rest; };
  const ref = await runMonteCarlo(db, ids, o());
  // (every kind of statistic a record carries is exercised: register risks and an event that fire, a milestone, sensitivities)
  assert.ok(ref.risks.length === 2 && ref.risks.every((r) => r.triggeredPct > 0), JSON.stringify(ref.risks));
  assert.ok(ref.events[0].triggeredPct > 0 && ref.milestones.length === 1 && ref.sensitivity.length > 10 && ref.probDeadline != null);
  testHooks.failAt = 20;
  const a = await runMonteCarlo(db, ids, o(new IterationFile(null, here))).finally(() => { testHooks.failAt = null; });
  assert.equal(a.iterations, 20);
  const file = a.partial!.kept!;
  // a kill while the next iteration was being written: its bytes are cut short at the end of the file
  const whole = statSync(file).size;
  testHooks.failAt = 55;
  const b = await runMonteCarlo(db, ids, o(new IterationFile(file, here))).finally(() => { testHooks.failAt = null; });
  assert.equal(b.resumed, 20); assert.equal(b.iterations, 55); assert.equal(b.partial!.kept, file);
  assert.ok(statSync(file).size > whole);
  truncateSync(file, statSync(file).size - 7); // the 55th iteration is not whole any more
  const c = await runMonteCarlo(db, ids, o(new IterationFile(file, here)));
  assert.equal(c.resumed, 54);
  assert.deepEqual(strip(c), strip(ref));
  assert.equal(existsSync(file), false);
  await call('close', { ...h, discard: true });
});

test('a resume that is not this run is refused and nothing kept is touched; a wrong path says there is nothing there', async () => {
  const h = await project(20);
  testHooks.failAt = 10;
  const part = (await call('monte_carlo', mcArgs(h)).finally(() => { testHooks.failAt = null; })).d;
  const size = statSync(part.resume).size;
  for (const extra of [{ iterations: 130 }, { seed: 12 }, { deadline: '2026-08-01' }]) {
    const r = await call('monte_carlo', mcArgs(h, { ...extra, resume: part.resume }));
    assert.equal(r.err, true); assert.equal(r.d.error.code, 'resume_mismatch', JSON.stringify(r.d));
    assert.equal(statSync(part.resume).size, size);
  }
  // no seed given: the kept run's seed is used
  const { seed: _s, ...noSeed } = mcArgs(h);
  const ok = (await call('monte_carlo', { ...noSeed, resume: part.resume })).d;
  assert.equal(ok.seed, 11); assert.equal(ok.resumed_iterations, 10);
  const gone = await call('monte_carlo', mcArgs(h, { resume: part.resume }));
  assert.equal(gone.err, true); assert.equal(gone.d.error.code, 'resume_unreadable');
  assert.match(gone.d.error.hint, /without resume/);
  await call('close', { ...h, discard: true });
});

/** A server in its own process with this write root. */
function server(writeRoot: string) {
  const p = spawn(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts'), '--automation-write-root', writeRoot], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, P6CLONE_COMPUTE_WORKERS: '' } });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.on('data', (d) => { buf += d; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch { /* not json */ } } });
  const rpc = (method: string, params: unknown) => new Promise<any>((res) => { const i = ++id; waiting.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const c = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).result.structuredContent;
  return { p, rpc, c };
}

test('the kept file survives the process: a server killed mid-run, a new server continues from the file (in a compute worker)', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-mc-proc-'));
  copyFileSync(join(import.meta.dirname, 'fixtures', 'seed-aurora.xer'), join(dir, 'a.xer'));
  const args = { iterations: 400, seed: 5, default_estimates: est };
  const live: ReturnType<typeof server>[] = [];
  const start = () => { const x = server(dir); live.push(x); return x; };
  try {
    // the uninterrupted run
    const s0 = start();
    await s0.rpc('initialize', {});
    const o0 = await s0.c('open_file', { path: join(dir, 'a.xer') });
    const full = await s0.c('monte_carlo', { handle: o0.handle, ...args });
    assert.equal(full.iterations, 400, JSON.stringify(full).slice(0, 300));
    s0.p.kill();
    // a run cancelled (the answer names the file), then its server killed outright
    const s1 = start();
    await s1.rpc('initialize', {});
    const o1 = await s1.c('open_file', { path: join(dir, 'a.xer') });
    const job = await s1.c('monte_carlo', { handle: o1.handle, ...args, async: true });
    for (let k = 0; k < 600; k++) { const v = await s1.c('job_status', { job_id: job.job_id }); if (/^(\d{2,}) of/.test(String(v.progress ?? ''))) break; await new Promise((r) => setTimeout(r, 50)); }
    await s1.c('cancel_job', { job_id: job.job_id });
    let st: any;
    for (let k = 0; k < 60; k++) { st = await s1.c('job_status', { job_id: job.job_id, wait_seconds: 2 }); if (st.status !== 'running') break; }
    assert.equal(st.status, 'cancelled', JSON.stringify(st).slice(0, 300));
    const resume = st.result.resume as string;
    assert.ok(resume && existsSync(resume), JSON.stringify(st.result).slice(0, 300));
    const doneThen = st.result.iterations_done as number;
    assert.ok(doneThen >= 10 && doneThen < 400, String(doneThen));
    s1.p.kill('SIGKILL');
    // a new process: the same file opened again, continued from the kept iterations
    const s2 = start();
    await s2.rpc('initialize', {});
    const o2 = await s2.c('open_file', { path: join(dir, 'a.xer') });
    const resumed = await s2.c('monte_carlo', { handle: o2.handle, ...args, resume });
    s2.p.kill();
    assert.equal(resumed.resumed_iterations, doneThen);
    assert.deepEqual(same(resumed), same(full));
    assert.equal(existsSync(resume), false);
  } finally { for (const x of live) x.p.kill('SIGKILL'); }
});

// Review 4L-13 M1: the fingerprint was of the tables as laid out in memory (key order, field order, a table only in memory), so a run on
// a project built here, saved and opened again was refused as resume_mismatch: its kept work was lost after any stop.
test('a run on a project built here, saved and opened again, continues from its kept iterations: the answer equals an uninterrupted run', async () => {
  const h = await project(15);
  const file = join(root, `built-${Math.random().toString(36).slice(2, 6)}.xer`);
  const sv = await call('save', { ...h, path: file });
  assert.equal(sv.err, false, JSON.stringify(sv.d).slice(0, 300));
  const args = { iterations: 60, seed: 4, default_estimates: est, events: [{ name: 'Late permit', probability: 0.3, delay_days: 4 }] };
  testHooks.failAt = 20;
  const part = (await call('monte_carlo', { ...h, ...args }).finally(() => { testHooks.failAt = null; })).d;
  assert.equal(part.iterations_done, 20); assert.ok(part.resume, JSON.stringify(part).slice(0, 300));
  const o = (await call('open_file', { path: file })).d;
  const resumed = await call('monte_carlo', { handle: o.handle, ...args, resume: part.resume });
  assert.equal(resumed.err, false, JSON.stringify(resumed.d).slice(0, 400));
  assert.equal(resumed.d.resumed_iterations, 20);
  const full = (await call('monte_carlo', { handle: o.handle, ...args })).d;
  assert.deepEqual(same(resumed.d), same(full));
  assert.deepEqual(same(full), same((await call('monte_carlo', { ...h, ...args })).d), 'the project as built and as opened again are the same run');
  await call('close', { ...h, discard: true }); await call('close', { handle: o.handle, discard: true });
});

// Review 4L-13 M3: a record held every estimable activity's duration (8 bytes each per iteration: 60 MB for 5,000 activities x 1,000
// iterations). It now holds only the durations that vary; the others (no estimate, a fixed or zero-width one) are worked out again
// exactly, so a resumed run still equals an uninterrupted one.
test('a record keeps only the durations that vary, and a resumed run still equals an uninterrupted one exactly', async () => {
  const h = await project(120);
  const db = getSession(h.handle).db;
  const { setEstimate, remainingHours } = await import('../core/risk/montecarlo.ts');
  const ids = [db.tables.PROJECT.rows[0].proj_id];
  const T = db.tables.TASK.rows, task = (code: string) => T.find((t) => t.task_code === code)!;
  // estimates that vary (A10-A14), one fixed away from the remaining duration (A20: kept, it changes the schedule), fixed and
  // zero-width ones at it (A21, A22: not kept); the rest have none
  for (let i = 10; i < 15; i++) { const hr = remainingHours(task(`A${i}`)); setEstimate(db, task(`A${i}`).task_id, { min: hr * 0.8, ml: hr, max: hr * 1.5, dist: i % 2 ? 'betapert' : 'triangle' }); }
  setEstimate(db, task('A20').task_id, { ml: remainingHours(task('A20')) + 8, dist: 'none' });
  setEstimate(db, task('A21').task_id, { dist: 'none' });
  setEstimate(db, task('A22').task_id, { min: remainingHours(task('A22')), max: remainingHours(task('A22')) });
  const o = (store?: IterationFile): MonteCarloOptions => ({ iterations: 40, seed: 9, events: [{ name: 'e', p: 0.5, taskHours: [[task('A30').task_id, 16]], projectHours: 0 }], ...(store ? { store } : {}) });
  const strip = (r: any) => { const { elapsedMs: _e, resumed: _r, ...rest } = r; return rest; };
  const ref = await runMonteCarlo(db, ids, o());
  // what varies: A10-A14, A20, the two register risks' activities (A3, A118) and the event's (A30)
  const varying = 5 + 1 + 2 + 1, n = T.filter((t) => ids.includes(t.proj_id)).length, estimable = n - 1;
  testHooks.failAt = 20;
  const a = await runMonteCarlo(db, ids, o(new IterationFile(null, here))).finally(() => { testHooks.failAt = null; });
  const file = a.partial!.kept!;
  const at20 = statSync(file).size;
  testHooks.failAt = 30;
  await runMonteCarlo(db, ids, o(new IterationFile(file, here))).finally(() => { testHooks.failAt = null; });
  const per = (statSync(file).size - at20) / 10; // (iterations 21-30 set no anchor: the first iteration set them all; a unit is framed by its length and CRC32)
  const bits = (m: number) => Math.ceil(m / 8);
  assert.equal(per, 8 + 4 + 8 + 8 * varying + 4 * n + bits(n) + bits(2) + bits(1) + 4, `${per} bytes an iteration (each estimable duration kept: ${8 * estimable} for them)`);
  const c = await runMonteCarlo(db, ids, o(new IterationFile(file, here)));
  assert.equal(c.resumed, 30);
  assert.deepEqual(strip(c), strip(ref));
  await call('close', { ...h, discard: true });
});

/** Where each kept unit's bytes are in a kept file: after the head line, each unit is its length (u32), its CRC32 (u32) and its bytes
 *  (in layout 1, before the CRC32, its length and its bytes): at, where the unit starts; data, where its bytes start. */
const unitsOf = (file: string) => {
  const b = readFileSync(file), nl = b.indexOf(10), hd = JSON.parse(b.toString('utf8', 0, nl)).version === 1 ? 4 : 8, out: { at: number; data: number; len: number }[] = [];
  for (let at = nl + 1; at + hd <= b.length;) { const len = b.readUInt32LE(at); if (!len || at + hd + len > b.length) break; out.push({ at, data: at + hd, len }); at += hd + len; }
  return out;
};
// Review 4L-13 L1 / L2: a unit was checked only by its length, so one that a power loss left as zeros (or old bytes) of the right length
// was taken in as it was: the answer was wrong without a warning. Now each unit has a CRC32: a damaged one, and every one after it, is
// run again, and the answer says how many.
test('a kept iteration damaged in place (zeros of the right length, or a stretch of zeros) is run again, with every one after it, and named', async () => {
  const h = await project(25);
  const full = (await call('monte_carlo', mcArgs(h))).d;
  const stop = async (at: number) => { testHooks.failAt = at; try { return (await call('monte_carlo', mcArgs(h))).d; } finally { testHooks.failAt = null; } };
  // the bytes of the 11th iteration zeroed, its length and CRC32 left
  const a = await stop(30);
  const u = unitsOf(a.resume);
  assert.equal(u.length, 30);
  const b = readFileSync(a.resume); b.fill(0, u[10].data, u[10].data + u[10].len); writeFileSync(a.resume, b);
  const ra = (await call('monte_carlo', mcArgs(h, { resume: a.resume }))).d;
  assert.equal(ra.resumed_iterations, 10);
  assert.equal(ra.redone_iterations, 20);
  assert.match(ra.redone_note, /20 kept iterations did not check out/);
  assert.deepEqual(same(ra), same(full));
  // a stretch of zeros from the 26th on (the file's length was written, its data was not)
  const c = await stop(30);
  const v = unitsOf(c.resume), bc = readFileSync(c.resume);
  bc.fill(0, v[25].at); writeFileSync(c.resume, bc);
  const rc = (await call('monte_carlo', mcArgs(h, { resume: c.resume }))).d;
  assert.equal(rc.resumed_iterations, 25);
  assert.equal(rc.redone_iterations, 1, 'a stretch of zeros counts once');
  assert.deepEqual(same(rc), same(full));
  // a unit cut short at the end (a kill) was never kept: made again, not named
  const d = await stop(30);
  truncateSync(d.resume, statSync(d.resume).size - 3);
  const rd = (await call('monte_carlo', mcArgs(h, { resume: d.resume }))).d;
  assert.equal(rd.resumed_iterations, 29); assert.equal(rd.redone_iterations, undefined);
  assert.deepEqual(same(rd), same(full));
  await call('close', { ...h, discard: true });
});

// Review 4L-13 M2: two runs could write one kept file: the same project open twice (two handles: the same fingerprint, the same file),
// or a resume started while a cancelled job (it answers before it has stopped) is still in its last iteration. One run at a time on a
// kept file now: a second is refused as run_busy, naming the job that holds it.
test('a second run on a kept file while one is working on it is refused as run_busy, naming the job; once that ends it goes on', async () => {
  const h = await project(30);
  const file = join(root, `busy-${Math.random().toString(36).slice(2, 6)}.xer`);
  assert.equal((await call('save', { ...h, path: file })).err, false);
  const A = (await call('open_file', { path: file })).d.handle as string, B = (await call('open_file', { path: file })).d.handle as string;
  const args = (handle: string, extra: Record<string, unknown> = {}) => ({ handle, iterations: 20000, seed: 11, default_estimates: est, ...extra });
  testHooks.failAt = 20;
  const part = (await call('monte_carlo', args(A)).finally(() => { testHooks.failAt = null; })).d;
  const size = statSync(part.resume).size;
  const job = (await call('monte_carlo', args(A, { resume: part.resume, async: true }))).d.job_id;
  for (let k = 0; k < 400; k++) { const v = (await call('job_status', { job_id: job })).d; if (Number(/^(\d+) of/.exec(String(v.progress ?? ''))?.[1]) > 20 || v.status !== 'running') break; await new Promise((r) => setTimeout(r, 10)); }
  for (const again of [args(B, { resume: part.resume }), args(B)]) { // a resume of it, and a fresh call of the same name (the other handle)
    const r = await call('monte_carlo', again);
    assert.equal(r.err, true, JSON.stringify(r.d).slice(0, 300));
    assert.equal(r.d.error.code, 'run_busy', JSON.stringify(r.d));
    assert.equal(r.d.error.job_id, job);
    assert.match(r.d.error.reason, new RegExp(`job ${job}`));
  }
  await call('cancel_job', { job_id: job });
  let st: any;
  for (let k = 0; k < 60; k++) { st = (await call('job_status', { job_id: job, wait_seconds: 2 })).d; if (st.status !== 'running') break; }
  assert.equal(st.status, 'cancelled');
  assert.ok(statSync(part.resume).size > size);
  // once it has ended the file is free: the run goes on from what both kept (cancelled again: 20,000 iterations are not waited for)
  const later = (await call('monte_carlo', args(B, { resume: part.resume, async: true }))).d.job_id;
  for (let k = 0; k < 400; k++) { const v = (await call('job_status', { job_id: later })).d; if (v.status !== 'running' || /of/.test(String(v.progress ?? ''))) break; await new Promise((r) => setTimeout(r, 10)); }
  await call('cancel_job', { job_id: later });
  for (let k = 0; k < 60; k++) { st = (await call('job_status', { job_id: later, wait_seconds: 2 })).d; if (st.status !== 'running') break; }
  assert.equal(st.status, 'cancelled', JSON.stringify(st).slice(0, 300));
  assert.ok(st.result.resumed_iterations > 20, JSON.stringify(st.result).slice(0, 300));
  for (const x of [h, { handle: A }, { handle: B }]) await call('close', { ...x, discard: true });
});

test('…the same in compute workers: the claim is held on the server\'s main thread', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6-mc-busy-'));
  copyFileSync(join(import.meta.dirname, 'fixtures', 'seed-aurora.xer'), join(dir, 'a.xer'));
  const s = server(dir);
  try {
    await s.rpc('initialize', {});
    const o1 = await s.c('open_file', { path: join(dir, 'a.xer') }), o2 = await s.c('open_file', { path: join(dir, 'a.xer') });
    const args = { iterations: 2000, seed: 5, default_estimates: est };
    const job = (await s.c('monte_carlo', { handle: o1.handle, ...args, async: true })).job_id;
    for (let k = 0; k < 600; k++) { const v = await s.c('job_status', { job_id: job }); if (/^(\d{2,}) of/.test(String(v.progress ?? ''))) break; await new Promise((r) => setTimeout(r, 50)); }
    const r = await s.rpc('tools/call', { name: 'monte_carlo', arguments: { handle: o2.handle, ...args } });
    const err = r.result.structuredContent.error;
    assert.equal(err?.code, 'run_busy', JSON.stringify(r.result).slice(0, 600));
    assert.equal(err.job_id, job);
    await s.c('cancel_job', { job_id: job });
    let st: any;
    for (let k = 0; k < 60; k++) { st = await s.c('job_status', { job_id: job, wait_seconds: 2 }); if (st.status !== 'running') break; }
    // once it has ended (its worker answered) the claim is given back: the other handle continues the run
    const again = await s.c('monte_carlo', { handle: o2.handle, ...args, resume: st.result.resume });
    assert.equal(again.resumed_iterations, st.result.iterations_done, JSON.stringify(again).slice(0, 300));
  } finally { s.p.kill('SIGKILL'); }
});

test('monte_carlo counts the activities critical in every run and in at least one run from the full list, not the 25 rows listed', async () => {
  const h = await project(40);
  const a = { ...h, iterations: 20, seed: 3, default_estimates: est };
  const r = (await call('monte_carlo', a)).d;
  const all = JSON.parse(readFileSync(r.exported.files[0].path, 'utf8')).criticality; // the file holds every activity
  const every = all.filter((x: any) => x.critical_pct === 100).length, any = all.filter((x: any) => x.critical_pct > 0).length;
  assert.ok(any > 0 && any <= r.criticality_total && all.length === r.criticality_total);
  assert.equal(r.criticality.length, 25);
  assert.equal(r.critical_in_every_run, every); assert.equal(r.critical_in_any_run, any);
});

test('monte_carlo has no list size, bars or whole-day arguments: 25 per list, 20 bars, 2,000 iterations by default, no bound on iterations; the arguments of old are reported as not used', async () => {
  const h = await project(40);
  const a = { ...h, iterations: 20, seed: 3, default_estimates: est };
  const dflt = (await call('monte_carlo', a)).d;
  assert.equal(dflt.criticality.length, 25);
  assert.ok(dflt.criticality_total > 25);
  assert.equal(dflt.histogram.length, 20, 'the chart is always 20 bars');
  // top, buckets and histogram are gone: the call runs without them and says so
  const old = (await call('monte_carlo', { ...a, top: 0, buckets: 250, histogram: 'days' })).d;
  assert.equal(old.criticality.length, 25); assert.equal(old.histogram.length, 20);
  assert.deepEqual(old.notes.map((x: string) => /^monte_carlo has no argument "(\w+)": it was not used and the call ran without it\. Its arguments are: /.exec(x)?.[1]), ['top', 'buckets', 'histogram']);
  // the bars run from the earliest to the latest simulated finish, equal in width
  const w = (b: any) => parseP6Date(b.end)! - parseP6Date(b.start)!;
  assert.ok(dflt.histogram.every((b: any) => Math.abs(w(b) - w(dflt.histogram[0])) <= 1));
  assert.equal(dflt.histogram[0].start, dflt.finish.min); assert.equal(dflt.histogram.at(-1).end, dflt.finish.max);
  assert.equal((await call('monte_carlo', { ...a, iterations: 3 })).d.error?.code, 'bad_input');
  const none = (await call('monte_carlo', { ...h, seed: 3, default_estimates: est })).d;
  assert.equal(none.iterations, 2000, 'no iterations given: 2,000');
  const many = (await call('monte_carlo', { ...h, iterations: 20100, seed: 3, default_estimates: est })).d;
  assert.equal(many.iterations, 20100, 'iterations above 20,000 all run');
  assert.equal(many.partial, undefined);
  // (the up-front reservation of what is asked is proved in the test below: a request that cannot fit is refused before any iteration)
});

test('monte_carlo: a count that is not a whole number is refused as bad_input naming it, and a request that cannot fit (iterations, with the result files) is refused in words before any iteration, losing and writing nothing', async () => {
  const h = await project(40);
  const a = { ...h, iterations: 20, seed: 3, default_estimates: est };
  const kept0 = keptFiles(); // (earlier tests leave their stopped runs here)
  // L1: iterations is a whole number; absent is the default
  for (const [arg, bad] of [['iterations', [-5, 10.5, Number.NaN, Infinity, '100']]] as const) {
    for (const v of bad) {
      const r = await call('monte_carlo', { ...a, [arg]: v });
      assert.equal(r.err, true, `${arg} ${String(v)}`);
      assert.equal(r.d.error.code, 'bad_input', `${arg} ${String(v)}: ${JSON.stringify(r.d.error).slice(0, 200)}`);
      assert.match(r.d.error.message, new RegExp(`^${arg} must be a whole number`), r.d.error.message);
    }
  }
  assert.deepEqual(keptFiles(), kept0, 'a refused call ran nothing');

  // a stopped run's kept file is not removed by a refusal, and a refusal writes nothing
  testHooks.failAt = 6;
  let stopped;
  try { stopped = (await call('monte_carlo', { ...a, iterations: 12 })).d; } finally { testHooks.failAt = null; }
  assert.equal(stopped.partial, true); assert.ok(existsSync(stopped.resume));
  const before = keptFiles(), outDir = join(root, 'mc-refused-export');
  const was = config.budgetBytes;
  config.budgetBytes = usedMemory() + 300 * 1048576;
  try {
    // (a refusal first moves the other, idle projects out: one call does that, then the room is measured)
    await call('monte_carlo', { ...a, iterations: 1e12 });
    config.budgetBytes = usedMemory() + 300 * 1048576;
    const free = () => config.budgetBytes - usedMemory();
    const refused = async (extra: Record<string, unknown>) => {
      const r = await call('monte_carlo', { ...a, ...extra });
      assert.equal(r.err, true, JSON.stringify(extra));
      assert.equal(r.d.error.code, 'memory_budget', JSON.stringify(r.d.error).slice(0, 300));
      assert.deepEqual(keptFiles(), before, 'nothing was started, removed or kept');
      assert.equal(existsSync(outDir), false, 'nothing was exported');
      return r.d.error;
    };
    const { workNeed } = await import('../mcp/workset.ts');
    const s = getSession(h.handle);
    const need = (args: Record<string, unknown>) => workNeed('monte_carlo', { iterations: 20, ...args }, s, free)!;
    assert.ok(existsSync(stopped.resume), 'the stopped run is still resumable');
    // M4: iterations that cannot fit, with and without the export, are refused; the hint is what fits (the per-iteration costs beside the activities')
    const perIt = (x: Record<string, unknown>) => (need({ iterations: 2000, ...x }).bytes - need({ iterations: 1000, ...x }).bytes) / 1000;
    const n = s.db.tables.TASK.rows.length;
    assert.ok(perIt({}) > n * 12 + 30 + 90, `an iteration costs more than ${n} activities x 12 B and its result-file rows: ${perIt({})}`);
    for (const extra of [{}, { export: outDir }]) {
      const e = await refused({ iterations: 1e9, ...extra });
      const fit = Number(/at most ([\d,]+) iterations \(iterations\)/.exec(e.hint)?.[1].replace(/,/g, ''));
      assert.ok(fit >= 10 && fit < 1e9, e.hint);
      assert.ok(need({ iterations: fit, ...extra }).bytes <= free(), `${fit} iterations fit${'export' in extra ? ' with the export' : ''}`);
      assert.ok(need({ iterations: fit + 1, ...extra }).bytes > free() - 1, 'and one more does not');
    }
    // a run asked within what is free still runs (the reservation does not refuse what fits)
    assert.equal((await call('monte_carlo', { ...a, iterations: 50 })).d.histogram.length, 20);
  } finally { config.budgetBytes = was; }
});
