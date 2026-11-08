// WHIQ handoff 4L-13 part 2: evaluate_batch and monte_carlo keep their finished work when they fail or are cancelled.
// A failed scenario is its own row; a cancelled batch returns the rows done; a cancelled or failing Monte Carlo returns the
// statistics of the iterations done, marked partial. A partial answer is a normal answer (not an error); a job that ends this way
// says how it ended (cancelled / failed) and keeps its result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testHooks as mcHooks } from '../core/risk/montecarlo.ts';
import { testHooks as batchHooks } from '../core/analysis/batch.ts';
import { setRoots } from '../mcp/runtime.ts';

// a stopped run keeps its work in the write root (4L-13): the test's own temp folder, not the folder the tests run in
setRoots(null, tmpdir());

const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const env = (vars: Record<string, string | undefined>) => {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(was)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
};
const chain = async (n: number) => {
  const np = (await call('new_project', { id: 'PART', start: '2026-03-02' })).d;
  const ops: unknown[] = [];
  for (let i = 0; i < n; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `A${i}`, duration_days: 3 }, ...(i ? [{ op: 'add_relationship', pred: `A${i - 1}`, succ: `A${i}` }] : []));
  await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  return { handle: np.handle as string, owner_key: np.owner_key as string };
};
const est = { min_pct: 90, max_pct: 125 };
const waitJob = async (id: string) => { for (; ;) { const v = (await call('job_status', { job_id: id, wait_seconds: 2 })).d; if (v.status !== 'running') return v; } };
const batchOf = (n: number, acts: number) => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, overrides: [{ op: 'update_activity', id: `A${i % acts}`, duration_days: 1 + (i % 5) }] }));

test('evaluate_batch: a scenario that throws is an ok:false row, the others still come back', async () => {
  const restore = env({ P6CLONE_COMPUTE_WORKERS: '0' }); // (the test hook lives in this process)
  const h = await chain(20);
  const scenarios = batchOf(4, 20);
  batchHooks.failScenario = 2;
  try {
    const r = await call('evaluate_batch', { ...h, scenarios });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.equal(r.d.scenarios.length, 4);
    assert.deepEqual(r.d.scenarios.map((x: any) => x.ok), [true, true, false, true]);
    assert.match(r.d.scenarios[2].error, /test failure/);
    assert.equal(r.d.partial, undefined, 'a failed scenario is a row, not a partial run');
    assert.ok(r.d.best);
  } finally { batchHooks.failScenario = null; restore(); }
  const after = await call('evaluate_batch', { ...h, scenarios: scenarios.slice(0, 1) });
  assert.equal(after.d.scenarios[0].ok, true, 'the project was put back after the failed scenario');
  await call('close', { ...h, discard: true });
});

test('evaluate_batch cancelled mid-way (inline, no worker) returns the rows done, marked partial', async () => {
  const restore = env({ P6CLONE_COMPUTE_WORKERS: '0' });
  try {
    const h = await chain(60);
    const job = (await call('evaluate_batch', { ...h, scenarios: batchOf(300, 60), async: true })).d.job_id;
    for (let k = 0; k < 200; k++) { const v = (await call('job_status', { job_id: job })).d; if (/scenario ([5-9]|\d{2,}) of/.test(String(v.progress ?? ''))) break; await new Promise((r) => setTimeout(r, 10)); }
    await call('cancel_job', { job_id: job });
    const v = await waitJob(job);
    assert.equal(v.status, 'cancelled', JSON.stringify(v).slice(0, 300));
    const r = v.result;
    assert.equal(r.partial, true); assert.equal(r.stopped, 'cancelled');
    assert.equal(r.scenarios_requested, 300);
    assert.equal(r.scenarios.length, r.scenarios_done);
    assert.ok(r.scenarios_done >= 1 && r.scenarios_done < 300, String(r.scenarios_done));
    assert.ok(r.scenarios.every((x: any) => x.ok));
    assert.equal(r.ok, true);
    await call('close', { ...h, discard: true });
  } finally { restore(); }
});

test('evaluate_batch cancelled while it runs in a worker returns the rows done', { timeout: 120_000 }, async () => {
  const h = await chain(60);
  const job = (await call('evaluate_batch', { ...h, scenarios: batchOf(3000, 60), async: true })).d.job_id;
  await new Promise((r) => setTimeout(r, 400));
  const t = Date.now();
  await call('cancel_job', { job_id: job });
  const v = await waitJob(job);
  assert.ok(Date.now() - t < 10_000, `ended in ${Date.now() - t} ms`);
  assert.equal(v.status, 'cancelled', JSON.stringify(v).slice(0, 300));
  assert.equal(v.result.partial, true);
  assert.ok(v.result.scenarios_done >= 1 && v.result.scenarios_done < 3000, String(v.result.scenarios_done));
  assert.equal(v.result.scenarios.length, v.result.scenarios_done);
  await call('close', { ...h, discard: true });
});

test('monte_carlo cancelled in a worker returns the statistics of the iterations done, with the count', { timeout: 120_000 }, async () => {
  const h = await chain(60);
  const job = (await call('monte_carlo', { ...h, iterations: 20000, default_estimates: est, async: true })).d.job_id;
  await new Promise((r) => setTimeout(r, 1500));
  await call('cancel_job', { job_id: job });
  const v = await waitJob(job);
  assert.equal(v.status, 'cancelled', JSON.stringify(v).slice(0, 300));
  const r = v.result;
  assert.equal(r.partial, true); assert.equal(r.stopped, 'cancelled');
  assert.equal(r.iterations_requested, 20000);
  assert.equal(r.iterations, r.iterations_done);
  assert.ok(r.iterations_done >= 1 && r.iterations_done < 20000, String(r.iterations_done));
  assert.ok(r.finish.P50 && r.finish.P80 && r.histogram.length);
  assert.match(r.note, /Partial/);
  // a job that kept its work is a normal answer to job_status, not an error
  const again = await call('job_status', { job_id: job });
  assert.equal(again.err, false);
  await call('close', { ...h, discard: true });
});

test('monte_carlo failing after some iterations returns the iterations done, marked partial with the error', async () => {
  const restore = env({ P6CLONE_COMPUTE_WORKERS: '0' });
  mcHooks.failAt = 60;
  try {
    const h = await chain(30);
    const r = await call('monte_carlo', { ...h, iterations: 100, seed: 5, default_estimates: est });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.equal(r.d.partial, true); assert.equal(r.d.stopped, 'failed');
    assert.equal(r.d.iterations_done, 60); assert.equal(r.d.iterations, 60); assert.equal(r.d.iterations_requested, 100);
    assert.match(r.d.error, /test failure/);
    mcHooks.failAt = null;
    const full = await call('monte_carlo', { ...h, iterations: 100, seed: 5, default_estimates: est });
    assert.equal(full.d.partial, undefined); assert.equal(full.d.iterations, 100);
    // any finished iteration gives a partial; none is an error, as it was
    mcHooks.failAt = 1;
    const one = await call('monte_carlo', { ...h, iterations: 100, seed: 5, default_estimates: est });
    assert.equal(one.err, false); assert.equal(one.d.partial, true); assert.equal(one.d.iterations_done, 1);
    mcHooks.failAt = 0;
    const none = await call('monte_carlo', { ...h, iterations: 100, seed: 5, default_estimates: est });
    assert.equal(none.err, true);
    // as a job: status failed, result kept
    mcHooks.failAt = 40;
    const job = (await call('monte_carlo', { ...h, iterations: 100, seed: 5, default_estimates: est, async: true })).d.job_id;
    const v = await waitJob(job);
    assert.equal(v.status, 'failed'); assert.equal(v.result.iterations_done, 40); assert.match(v.error.reason, /test failure/);
    await call('close', { ...h, discard: true });
  } finally { mcHooks.failAt = null; restore(); }
});

test('monte_carlo failing inside an iteration’s accounting: the partial statistics cover exactly the iterations done', async () => {
  const restore = env({ P6CLONE_COMPUTE_WORKERS: '0' });
  try {
    const h = await chain(30);
    mcHooks.failAccountingAt = 30;
    const part = await call('monte_carlo', { ...h, iterations: 100, seed: 9, default_estimates: est });
    mcHooks.failAccountingAt = null;
    assert.equal(part.err, false); assert.equal(part.d.partial, true); assert.equal(part.d.stopped, 'failed'); assert.equal(part.d.iterations_done, 30);
    assert.match(part.d.error, /accounting/);
    // the same seed run for 30 iterations: identical statistics (nothing of the failed iteration is in them)
    const ref = await call('monte_carlo', { ...h, iterations: 30, seed: 9, default_estimates: est });
    const pick = (d: any) => JSON.stringify({ f: d.finish, c: d.criticality, s: d.sensitivity, w: d.working_days, hist: d.histogram, m: d.milestones });
    assert.equal(pick(part.d), pick(ref.d));
    await call('close', { ...h, discard: true });
  } finally { mcHooks.failAccountingAt = null; restore(); }
});

test('the job end pulse says cancelled when the job returns a partial result (no result in the pulse)', { timeout: 180_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'p6-partial-'));
  const p = spawn(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts'), '--automation-write-root', cwd], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  const notes: any[] = [];
  p.stdout.on('data', (d) => { buf += d; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.method === 'notifications/job') notes.push(m.params); else { waiting.get(m.id)?.(m); waiting.delete(m.id); } } catch { /* not json */ } } });
  const rpc = (method: string, params: unknown) => new Promise<any>((res) => { const i = ++id; waiting.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const c = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).result.structuredContent;
  try {
    await rpc('initialize', {});
    const np = await c('new_project', { id: 'PULSE', start: '2026-03-02' });
    const ops: unknown[] = [];
    for (let i = 0; i < 60; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `A${i}`, duration_days: 5 }, ...(i ? [{ op: 'add_relationship', pred: `A${i - 1}`, succ: `A${i}` }] : []));
    await c('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
    await c('schedule', { handle: np.handle, owner_key: np.owner_key });
    for (const [tool, args] of [['monte_carlo', { iterations: 20000, default_estimates: est }], ['evaluate_batch', { scenarios: batchOf(4000, 60) }]] as const) {
      const job = await c(tool, { handle: np.handle, ...args, async: true });
      await new Promise((r) => setTimeout(r, 1500));
      await c('cancel_job', { job_id: job.job_id });
      const t0 = Date.now();
      while (!notes.some((n) => n.job_id === job.job_id && n.status !== 'running') && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 100));
      const end = notes.filter((n) => n.job_id === job.job_id && n.status !== 'running');
      assert.equal(end.length, 1, `${tool}: ${JSON.stringify(notes).slice(0, 400)}`);
      assert.equal(end[0].status, 'cancelled', tool);
      assert.equal(end[0].result, undefined, 'the end pulse carries no result');
      const st = await c('job_status', { job_id: job.job_id });
      assert.equal(st.status, 'cancelled'); assert.equal(st.result.partial, true, tool);
    }
  } finally { p.kill(); }
});

test('real sample: a Monte Carlo cancelled on a big schedule returns partial statistics', { timeout: 600_000 }, async (t) => {
  const { sampleCopy } = await import('./helpers.ts');
  let path: string;
  try { path = sampleCopy('Copy of JWM - Baseline Programme Rev 05A.xer'); } catch { t.skip('sample not present'); return; }
  const o = await call('open_file', { path });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 200));
  const h = { handle: o.d.handle, owner_key: o.d.owner_key };
  const job = (await call('monte_carlo', { ...h, iterations: 1000, default_estimates: est, async: true })).d.job_id;
  await new Promise((r) => setTimeout(r, 20_000));
  const t0 = Date.now();
  await call('cancel_job', { job_id: job });
  const v = await waitJob(job);
  console.log(`JWM cancelled Monte Carlo: status ${v.status}, ${v.result?.iterations_done}/${v.result?.iterations_requested} iterations, answered ${Date.now() - t0} ms after cancel`);
  assert.equal(v.status, 'cancelled', JSON.stringify(v).slice(0, 300));
  assert.equal(v.result.partial, true);
  assert.ok(v.result.iterations_done >= 1 && v.result.iterations_done < 1000);
  await call('close', { ...h, discard: true });
});
