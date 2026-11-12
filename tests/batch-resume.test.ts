// 4L-13 (G9): evaluate_batch keeps each scenario as it finishes, in a file in the write root. A batch that stops answers that file's
// path as resume; a later call with resume schedules only the scenarios still missing, and best and the details of the best few are
// worked out over EVERY scenario, so the answer equals an uninterrupted batch's. A batch that finishes removes its file; a resume that
// is not this batch is refused and changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
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
// (the result folder is named by the project and the file it was opened from: the notes that name a file are compared without that folder name)
const same = (d: any) => { const { resumed_scenarios: _r, redone_scenarios: _d, redone_note: _n, exported: _x, ...rest } = d; return JSON.parse(JSON.stringify(rest).replace(/analysis[\\/][^\\/"]+[\\/]/g, 'analysis/-/')); };

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

// Review 4L-13 M1: the fingerprint was of the tables as laid out in memory (key order, field order, the EPS only in memory), so a batch
// on a project edited here, saved and opened again was refused as resume_mismatch. (A project made here has no file version, and an
// XER has one: the scheduler's rules for the version differ, so that project is edited after it was opened from its first save.)
test('a batch on a project edited here, saved and opened again, continues from its kept scenarios: the answer equals an uninterrupted batch', async () => {
  const built = await chain(60);
  const first = join(root, `built-${Math.random().toString(36).slice(2, 6)}.xer`), file = first.replace(/\.xer$/, '-edited.xer');
  assert.equal((await call('save', { ...built, path: first })).err, false);
  const a = (await call('open_file', { path: first })).d, h = { handle: a.handle as string, owner_key: a.owner_key as string };
  assert.equal((await call('edit', { ...h, operations: [{ op: 'update_activity', id: 'A3', name: 'A3 edited' }, { op: 'add_activity', id: 'X1', name: 'X1', duration_days: 2 }, { op: 'add_relationship', pred: 'A10', succ: 'X1' }] })).err, false);
  await call('schedule', h);
  assert.equal((await call('save', { ...h, path: file })).err, false);
  const part = (await stopped(h, 8)).d;
  assert.equal(part.partial, true); assert.ok(existsSync(part.resume), JSON.stringify(part).slice(0, 300));
  const o = (await call('open_file', { path: file })).d;
  const resumed = await call('evaluate_batch', { handle: o.handle, scenarios, top: 3, resume: part.resume });
  assert.equal(resumed.err, false, JSON.stringify(resumed.d).slice(0, 400));
  assert.equal(resumed.d.resumed_scenarios, part.scenarios_done);
  const full = (await call('evaluate_batch', { handle: o.handle, scenarios, top: 3 })).d;
  assert.deepEqual(same(resumed.d), same(full));
  assert.deepEqual(same(full), same((await call('evaluate_batch', { ...h, scenarios, top: 3 })).d), 'the project as edited here and as opened again are the same batch');
  for (const x of [built, h, { handle: o.handle }]) await call('close', { ...x, discard: true });
});

// Review 4L-13 L1 / L2: a kept scenario was checked only by its length and JSON, so one whose bytes changed in place (a power loss can
// leave old bytes of the right length) was taken in as it was and the answer was wrong without a warning. Each scenario now has a CRC32:
// a damaged one, and every one after it, is done again, and the answer says how many.
test('a kept scenario damaged in place is done again, with every one after it, and named', async () => {
  const h = await chain(60);
  const full = (await call('evaluate_batch', { ...h, scenarios, top: 3 })).d;
  const part = (await stopped(h, 12)).d;
  const done = part.scenarios_done as number;
  assert.ok(done >= 4, String(done));
  // the second scenario's finish changed in place, a digit for a digit: the same length, still JSON
  // (a unit: its length u32, its CRC32 u32, its bytes; in layout 1, before the CRC32, its length and its bytes)
  const b = readFileSync(part.resume), nl = b.indexOf(10), hd = JSON.parse(b.toString('utf8', 0, nl)).version === 1 ? 4 : 8;
  let at = nl + 1;
  at += hd + b.readUInt32LE(at);
  const len = b.readUInt32LE(at), text = b.toString('utf8', at + hd, at + hd + len);
  const m = /"finish":"\d{4}-\d\d-(\d)/.exec(text)!;
  const pos = at + hd + Buffer.byteLength(text.slice(0, m.index + m[0].length - 1));
  b[pos] = b[pos] === 0x31 ? 0x32 : 0x31; writeFileSync(part.resume, b);
  JSON.parse(b.toString('utf8', at + hd, at + hd + len)); // (still a scenario a JSON reader takes)
  const resumed = (await call('evaluate_batch', { ...h, scenarios, top: 3, resume: part.resume })).d;
  assert.equal(resumed.resumed_scenarios, 1);
  assert.equal(resumed.redone_scenarios, done - 1);
  assert.match(resumed.redone_note, /kept scenarios? did not check out/);
  assert.deepEqual(same(resumed), same(full));
  await call('close', { ...h, discard: true });
});

// Review 4L-13 M2: two runs could write one kept file (the same project open twice: the same fingerprint, the same file; or a resume
// started while a cancelled job is still in its last scenario). One run at a time on a kept file: a second is refused as run_busy.
test('a second batch on a kept file while one is working on it is refused as run_busy, naming the job', async () => {
  const built = await chain(60);
  const file = join(root, `busy-${Math.random().toString(36).slice(2, 6)}.xer`);
  assert.equal((await call('save', { ...built, path: file })).err, false);
  const A = (await call('open_file', { path: file })).d.handle as string, B = (await call('open_file', { path: file })).d.handle as string;
  const many = Array.from({ length: 3000 }, (_, i) => scenarios[i % N]).map((s, i) => ({ ...s, name: `m${i}` }));
  const job = (await call('evaluate_batch', { handle: A, scenarios: many, top: 3, async: true })).d.job_id;
  for (let k = 0; k < 2000; k++) { const v = (await call('job_status', { job_id: job })).d; if (v.status !== 'running' || Number(/scenario (\d+) of/.exec(String(v.progress ?? ''))?.[1]) > 3) break; await new Promise((r) => setTimeout(r, 2)); }
  const r = await call('evaluate_batch', { handle: B, scenarios: many, top: 3 });
  assert.equal(r.err, true, JSON.stringify(r.d).slice(0, 300));
  assert.equal(r.d.error.code, 'run_busy', JSON.stringify(r.d));
  assert.equal(r.d.error.job_id, job);
  await call('cancel_job', { job_id: job });
  let st: any;
  for (;;) { st = (await call('job_status', { job_id: job, wait_seconds: 2 })).d; if (st.status !== 'running') break; }
  assert.ok(st.result?.resume, JSON.stringify(st).slice(0, 300));
  for (const x of [built, { handle: A }, { handle: B }]) await call('close', { ...x, discard: true });
});
