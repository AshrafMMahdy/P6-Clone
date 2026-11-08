// 4L-13 (G9): evaluate_batch keeps each scenario as it finishes, in a file in the write root. A batch that stops answers that file's
// path as resume; a later call with resume schedules only the scenarios still missing, and best and the details of the best few are
// worked out over EVERY scenario, so the answer equals an uninterrupted batch's. A batch that finishes removes its file; a resume that
// is not this batch is refused and changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setRoots } from '../mcp/runtime.ts';

const root = mkdtempSync(join(tmpdir(), 'p6-batch-resume-'));
setRoots(null, root);
process.env.P6CLONE_COMPUTE_WORKERS = '0';

const call = async (name: string, args: Record<string, unknown>, progress?: (d: number, t: number, m: string) => void, signal?: AbortSignal) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args, undefined, signal, progress);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const chain = async (n: number) => {
  const np = (await call('new_project', { id: `BR${Math.random().toString(36).slice(2, 6)}`, start: '2026-03-02' })).d;
  const ops: unknown[] = [];
  for (let i = 0; i < n; i++) ops.push({ op: 'add_activity', id: `A${i}`, name: `A${i}`, duration_days: 5 }, ...(i ? [{ op: 'add_relationship', pred: `A${i - 1}`, succ: `A${i}` }] : []));
  await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  return { handle: np.handle as string, owner_key: np.owner_key as string };
};
// the best scenario is early (it is kept by the stopped batch), the next best ones are the last two (done by the resume)
const N = 300;
const scenarios = Array.from({ length: N }, (_, i) => ({ name: `s${i}`, overrides: [{ op: 'update_activity', id: `A${i % 60}`, duration_days: i === 1 ? 1 : i >= N - 2 ? 2 : 4 + (i % 3) }] }));
const same = (d: any) => { const { resumed_scenarios: _r, ...rest } = d; return rest; };

/** A batch (a job) cancelled once it has started scenario `at` or later. */
const stopped = async (h: object, at: number) => {
  const job = (await call('evaluate_batch', { ...h, scenarios, top: 3, async: true })).d.job_id;
  for (let k = 0; k < 2000; k++) { const v = (await call('job_status', { job_id: job })).d; const m = /scenario (\d+) of/.exec(String(v.progress ?? '')); if (v.status !== 'running' || (m && Number(m[1]) > at)) break; await new Promise((r) => setTimeout(r, 2)); }
  await call('cancel_job', { job_id: job });
  for (;;) { const v = (await call('job_status', { job_id: job, wait_seconds: 2 })).d; if (v.status !== 'running') return { err: false, d: v.result ?? v }; }
};

test('a batch cancelled part-way is continued from its kept scenarios: the answer (best, the best few and what they moved) equals an uninterrupted batch', async () => {
  const h = await chain(60);
  const full = (await call('evaluate_batch', { ...h, scenarios, top: 3 })).d;
  assert.equal(full.best, 's1');
  assert.deepEqual(full.scenarios.filter((s: any) => s.changed).map((s: any) => s.name).sort(), ['s1', `s${N - 2}`, `s${N - 1}`]);
  assert.deepEqual(readdirSync(root).filter((f) => f.startsWith('evaluate_batch-')), [], 'a finished batch removes its file');
  assert.match(full.parts_removed, /evaluate_batch-[0-9a-f]{12}\.parts$/, 'and names it (a mirror of the outputs removes its copy)');
  const part = (await stopped(h, 8)).d;
  assert.equal(part.partial, true); assert.equal(part.stopped, 'cancelled');
  assert.ok(part.scenarios_done >= 2 && part.scenarios_done < N - 2, String(part.scenarios_done));
  assert.ok(existsSync(part.resume), JSON.stringify(part).slice(0, 300));
  assert.match(part.note, /to continue, call evaluate_batch again with the same arguments and resume/);
  const resumed = (await call('evaluate_batch', { ...h, scenarios, top: 3, resume: part.resume })).d;
  assert.equal(resumed.resumed_scenarios, part.scenarios_done);
  assert.deepEqual(same(resumed), same(full));
  assert.equal(existsSync(part.resume), false);
  await call('close', { ...h, discard: true });
});

test('a damaged last scenario is done again; a resume of other scenarios or arguments is refused and touches nothing', async () => {
  const h = await chain(60);
  const full = (await call('evaluate_batch', { ...h, scenarios, top: 3 })).d;
  const part = (await stopped(h, 10)).d;
  assert.ok(part.scenarios_done >= 2 && part.scenarios_done < N, String(part.scenarios_done));
  const size = statSync(part.resume).size;
  for (const extra of [{ top: 2 }, { scenarios: scenarios.slice(1) }]) {
    const r = await call('evaluate_batch', { ...h, scenarios, top: 3, ...extra, resume: part.resume });
    assert.equal(r.err, true); assert.equal(r.d.error.code, 'resume_mismatch', JSON.stringify(r.d));
    assert.equal(statSync(part.resume).size, size);
  }
  truncateSync(part.resume, size - 5); // a kill while the last kept scenario was being written
  const resumed = (await call('evaluate_batch', { ...h, scenarios, top: 3, resume: part.resume })).d;
  assert.equal(resumed.resumed_scenarios, part.scenarios_done - 1);
  assert.deepEqual(same(resumed), same(full));
  const gone = await call('evaluate_batch', { ...h, scenarios, top: 3, resume: part.resume });
  assert.equal(gone.err, true); assert.equal(gone.d.error.code, 'resume_unreadable');
  await call('close', { ...h, discard: true });
});
