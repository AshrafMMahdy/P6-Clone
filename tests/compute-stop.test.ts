// How a cancelled worker call ends (mcp/compute.ts offload). Monte Carlo and evaluate_batch are asked to stop and answer with what
// they finished; they are ended only when frozen (no progress, no processor time of their thread). Two holes the blind review of 4L-13 found:
//  - a cancel that lands before the job was sent to its worker left the call running for ever (the stop was posted to a worker
//    that had no job, and nothing else settled it);
//  - a silence seen BEFORE the cancel (a slow start) latched, so a later cancel ended a worker that was working again and its
//    finished iterations were lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const chain = async (n: number) => {
  const np = (await call('new_project', { id: 'STOP', start: '2026-03-02' })).d;
  const ops: unknown[] = [];
  for (let i = 0; i < n; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `A${i}`, duration_days: 3 }, ...(i ? [{ op: 'add_relationship', pred: `A${i - 1}`, succ: `A${i}` }] : []));
  await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  return { handle: np.handle as string, owner_key: np.owner_key as string };
};
const est = { min_pct: 90, max_pct: 125 };
const waitJob = async (id: string) => { for (; ;) { const v = (await call('job_status', { job_id: id, wait_seconds: 2 })).d; if (v.status !== 'running') return v; } };

test('a Monte Carlo cancelled before its worker got the job ends at once, not after a window', { timeout: 60_000 }, async () => {
  const was = process.env.P6CLONE_COMPUTE_WORKERS;
  process.env.P6CLONE_COMPUTE_WORKERS = '2';
  try {
    const h = await chain(40);
    const mc = async () => (await call('monte_carlo', { ...h, iterations: 200000, default_estimates: est, async: true })).d.job_id as string;
    // two jobs hold both workers; the third waits for one
    const a = await mc(), b = await mc();
    for (let k = 0; k < 300; k++) { const s = await Promise.all([a, b].map(async (j) => String((await call('job_status', { job_id: j })).d.progress ?? ''))); if (s.every((p) => /\d/.test(p))) break; await new Promise((r) => setTimeout(r, 20)); }
    const c = await mc();
    await call('cancel_job', { job_id: c }); // cancelled while it waits
    const t0 = Date.now();
    await call('cancel_job', { job_id: a }); await call('cancel_job', { job_id: b });
    const v = await waitJob(c);
    assert.equal(v.status, 'cancelled', JSON.stringify(v).slice(0, 300));
    assert.ok(Date.now() - t0 < 20_000, `ended ${Date.now() - t0} ms after a worker was free (the silence floor is 120 s)`);
    await waitJob(a); await waitJob(b);
    // the project and the workers still serve the next call
    const r = await call('monte_carlo', { ...h, iterations: 20, seed: 1, default_estimates: est });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    await call('close', { ...h, discard: true });
  } finally { if (was == null) delete process.env.P6CLONE_COMPUTE_WORKERS; else process.env.P6CLONE_COMPUTE_WORKERS = was; }
});

test('a silence before the cancel does not latch: a worker ticking again is still asked to stop and keeps its work', { timeout: 120_000 }, async () => {
  // a window of 50 ms: the worker's start-up (copying the project) is already a window with no progress before its first tick
  const was = process.env.P6CLONE_LIVENESS_WINDOW_MS;
  process.env.P6CLONE_LIVENESS_WINDOW_MS = '50';
  try {
    const h = await chain(60);
    const job = (await call('monte_carlo', { ...h, iterations: 20000, default_estimates: est, async: true })).d.job_id;
    for (let k = 0; k < 300; k++) { const v = (await call('job_status', { job_id: job })).d; if (/\d+ of 20000|iteration/i.test(String(v.progress ?? ''))) break; await new Promise((r) => setTimeout(r, 20)); }
    await new Promise((r) => setTimeout(r, 800));
    await call('cancel_job', { job_id: job });
    const v = await waitJob(job);
    assert.equal(v.status, 'cancelled', JSON.stringify(v).slice(0, 300));
    assert.equal(v.result?.partial, true, 'the finished iterations were kept: ' + JSON.stringify(v).slice(0, 300));
    assert.ok(v.result.iterations_done >= 1);
    await call('close', { ...h, discard: true });
  } finally { if (was == null) delete process.env.P6CLONE_LIVENESS_WINDOW_MS; else process.env.P6CLONE_LIVENESS_WINDOW_MS = was; }
});
