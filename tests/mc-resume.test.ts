// 4L-13 (G8): a Monte Carlo run keeps each iteration as it finishes, in a file in the write root. A run that stops (an iteration
// fails, it is cancelled, its worker or its process is ended) answers that file's path as resume; a later call with resume runs only
// the iterations still missing, and with the same seed its answer EQUALS an uninterrupted run's, every statistic. A run that finishes
// removes its file; a resume that is not this run (other arguments, another seed, nothing there) is refused and changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, statSync, truncateSync } from 'node:fs';
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
const same = (d: any) => { const { elapsed_seconds: _e, resumed_iterations: _r, ...rest } = d; return rest; };
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
