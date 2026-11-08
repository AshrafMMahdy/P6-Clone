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
import { addRisk, linkActivity } from '../core/risk/register.ts';
import { IterationFile } from '../mcp/keptRuns.ts';
import { getSession, setRoots } from '../mcp/runtime.ts';

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
const same = (d: any) => { const { elapsed_seconds: _e, resumed_iterations: _r, redone_iterations: _d, redone_note: _n, ...rest } = d; return rest; };
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
  const a = await runMonteCarlo(db, ids, o(new IterationFile(null))).finally(() => { testHooks.failAt = null; });
  assert.equal(a.iterations, 20);
  const file = a.partial!.kept!;
  // a kill while the next iteration was being written: its bytes are cut short at the end of the file
  const whole = statSync(file).size;
  testHooks.failAt = 55;
  const b = await runMonteCarlo(db, ids, o(new IterationFile(file))).finally(() => { testHooks.failAt = null; });
  assert.equal(b.resumed, 20); assert.equal(b.iterations, 55); assert.equal(b.partial!.kept, file);
  assert.ok(statSync(file).size > whole);
  truncateSync(file, statSync(file).size - 7); // the 55th iteration is not whole any more
  const c = await runMonteCarlo(db, ids, o(new IterationFile(file)));
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
  const a = await runMonteCarlo(db, ids, o(new IterationFile(null))).finally(() => { testHooks.failAt = null; });
  const file = a.partial!.kept!;
  const at20 = statSync(file).size;
  testHooks.failAt = 30;
  await runMonteCarlo(db, ids, o(new IterationFile(file))).finally(() => { testHooks.failAt = null; });
  const per = (statSync(file).size - at20) / 10; // (iterations 21-30 set no anchor: the first iteration set them all; a unit is framed by its length and CRC32)
  const bits = (m: number) => Math.ceil(m / 8);
  assert.equal(per, 8 + 4 + 8 + 8 * varying + 4 * n + bits(n) + bits(2) + bits(1) + 4, `${per} bytes an iteration (each estimable duration kept: ${8 * estimable} for them)`);
  const c = await runMonteCarlo(db, ids, o(new IterationFile(file)));
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
