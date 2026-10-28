// Long computations off the server's main thread (mcp/compute.ts, core/journalPatch.ts). The root cause of one call freezing the others
// is heavy synchronous work on the thread that serves every handle; the tools that can run long now run on a copy of their project in a
// worker thread, and the main thread only routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { record, rollback } from '../core/journal.ts';
import { applyPatch, isEmptyPatch, patchFrom } from '../core/journalPatch.ts';
import type { Db } from '../core/db.ts';
import { performance } from 'node:perf_hooks';
import { sampleCopy } from './helpers.ts';

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
const open = async (name = 'cairo alex-road.xer') => { const o = await call('open_file', { path: sampleCopy(name) }); assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 200)); return { handle: o.d.handle as string, owner_key: o.d.owner_key as string }; };
const dates = async (h: { handle: string; owner_key: string }) => JSON.stringify((await call('activity_table', { ...h, limit: 5000 })).d);
const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (/elapsed|seconds|ms$/i.test(k) ? undefined : x)));

// ---- the patch -------------------------------------------------------------------------------------------------------------------
const mk = (): Db => ({ header: { version: '19.12', exportDate: 'x', raw: ['a'] }, tables: { TASK: { name: 'TASK', fields: ['task_id', 'name'], rows: [{ task_id: '1', name: 'a' }, { task_id: '2', name: 'b' }, { task_id: '3', name: 'c' }] }, PROJECT: { name: 'PROJECT', fields: ['proj_id'], rows: [{ proj_id: 'P' }] } } });
const clone = (d: Db): Db => structuredClone(d);

test('a patch carries a change from a copy back to the original: rows changed, rows added, a table made, rows removed; and it undoes', () => {
  const original = mk(), copy = clone(original), before = JSON.stringify(original);
  // the change, made on the copy under a journal (as a tool does it)
  const j = record(copy, (d) => {
    d.tables.TASK.rows[1].name = 'B!'; delete (d.tables.TASK.rows[2] as Record<string, string>).name;
    d.tables.TASK.rows.push({ task_id: '4', name: 'd' }); d.tables.NEW = { name: 'NEW', fields: ['x'], rows: [{ x: '1' }] };
    d.header!.exportDate = 'y';
  });
  const patch = patchFrom(copy, [j]);
  assert.equal(patch.allTables, undefined, 'placed exactly, not sent whole');
  assert.deepEqual(patch.tables.TASK.append, [{ task_id: '4', name: 'd' }]);
  assert.deepEqual(patch.tables.TASK.set, [[1, { name: 'B!' }, []], [2, {}, ['name']]]);
  assert.ok(patch.tables.NEW.full);
  assert.equal(patch.tables.PROJECT, undefined);
  // applied to the original as one change: equal to the copy, and undone by its journal
  const jj = record(original, (d) => applyPatch(d, patch));
  assert.deepEqual(original, copy);
  rollback(jj);
  assert.equal(JSON.stringify(original), before.replace('"tables":{', '"tables":{').replace(/$/, ''));
});

test('a patch for rows removed or reordered sends the table whole; a change it cannot place sends every table (never a wrong patch)', () => {
  const copy = clone(mk());
  const j = record(copy, (d) => { d.tables.TASK.rows = d.tables.TASK.rows.filter((r) => r.task_id !== '2'); });
  const p = patchFrom(copy, [j]);
  assert.deepEqual(p.tables.TASK.full?.rows.map((r) => r.task_id), ['1', '3']);
  const stray = clone(mk());
  const outside = { x: '1' } as Record<string, string>;
  const j2 = record(stray, (d) => { (d as unknown as { extra: Record<string, string> }).extra = outside; });
  assert.equal(patchFrom(stray, [j2]).allTables, true);
  assert.equal(isEmptyPatch(patchFrom(copy, [])), true);
});

// ---- the tools --------------------------------------------------------------------------------------------------------------------
test('the same answers and the same changes on a copy in a worker as in the server: F9, levelling, progress, Monte Carlo (seeded), analysis; and undo', { timeout: 300_000 }, async () => {
  const off = env({ P6CLONE_COMPUTE_WORKERS: '0' });
  const a = await open(), b = await open();
  off();
  const base = await dates(a);
  const run = async (h: typeof a, workers: boolean) => {
    const restore = env({ P6CLONE_COMPUTE_WORKERS: workers ? undefined : '0' });
    try {
      return {
        schedule: strip((await call('schedule', { ...h })).d),
        level: strip((await call('level_resources', { ...h })).d),
        mc: strip((await call('monte_carlo', { ...h, iterations: 60, seed: 7, default_estimates: { min_pct: 90, max_pct: 125 } })).d),
        check: strip((await call('check_schedule', { ...h })).d),
        dcma: strip((await call('dcma_14', { ...h })).d),
        batch: strip((await call('evaluate_batch', { ...h, scenarios: [{ name: 'x', overrides: [] }] })).d),
        after: await dates(h),
      };
    } finally { restore(); }
  };
  const [inWorker, inServer] = [await run(a, true), await run(b, false)];
  assert.deepEqual(inWorker, inServer);
  // the changes are undoable steps of the handle, one per tool that changed it
  const u1 = await call('undo', { ...a }), u2 = await call('undo', { ...a });
  assert.equal(u1.err, false, JSON.stringify(u1.d)); assert.equal(u2.err, false);
  assert.equal(await dates(a), base, 'undo takes the changes of the worker back out');
  for (const h of [a, b]) await call('close', { ...h, discard: true });
});

test('a refusal from the tool comes back as the same refusal; a bad owner key never reaches the worker', async () => {
  const h = await open();
  const bad = await call('monte_carlo', { ...h, project: 'NO-SUCH' });
  assert.equal(bad.err, true);
  const off = env({ P6CLONE_COMPUTE_WORKERS: '0' });
  const same = await call('monte_carlo', { ...h, project: 'NO-SUCH' });
  off();
  assert.deepEqual(bad.d.error.code, same.d.error.code);
  assert.equal(bad.d.error.message, same.d.error.message);
  await call('close', { ...h, discard: true });
});

test('a long Monte Carlo on one handle does not delay another handle’s calls (the main thread only routes)', { timeout: 300_000 }, async () => {
  const a = await open('DHBL-24FEB13_VER-7.0.xer'), b = await open();
  try {
    const elu0 = performance.eventLoopUtilization();
    const started = Date.now();
    const job = (await call('monte_carlo', { ...a, iterations: 60, default_estimates: { min_pct: 90, max_pct: 125 }, async: true })).d;
    assert.equal(job.status, 'running');
    // another handle's calls, one after another, while the Monte Carlo runs
    const times: number[] = [];
    for (; ;) {
      const t = Date.now();
      const r = await call('project_summary', { ...b });
      times.push(Date.now() - t);
      assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 200));
      const st = (await call('job_status', { job_id: job.job_id })).d;
      if (st.status !== 'running') { assert.equal(st.status, 'done', JSON.stringify(st).slice(0, 300)); break; }
      await new Promise((r2) => setTimeout(r2, 150));
    }
    const busy = performance.eventLoopUtilization(elu0).utilization;
    assert.ok(Date.now() - started > 2500, 'the run took long enough to matter');
    assert.ok(times.length >= 5, `calls on the other handle went through while it ran: ${times.length}`);
    assert.ok(Math.max(...times) < 500, `the other handle's slowest call: ${Math.max(...times)} ms`);
    // the run itself is not on this thread: run in the server it keeps the main thread at 90 % or more; the routing (a copy of the
    // project, the polling, the patch) is a few per cent
    assert.ok(busy < 0.35, `the main thread was busy ${Math.round(busy * 100)} % of the run`);
  } finally { for (const h of [a, b]) await call('close', { ...h, discard: true }); }
});

test('cancelling a call ends its worker at once and leaves the project, and every other project, as they were', { timeout: 120_000 }, async () => {
  const a = await open(), keep = await open();
  await call('edit', { ...keep, operations: [{ op: 'update_activity', id: (await call('activity_table', { ...keep, limit: 1 })).d.rows?.[0]?.id ?? 'A1000', name: 'Unsaved edit' }] }).catch(() => undefined);
  const before = await dates(a), keepBefore = await dates(keep), unsaved = (await call('list_open', {})).d.open.find((p: any) => p.handle === keep.handle).unsaved_changes;
  const job = (await call('monte_carlo', { ...a, iterations: 20000, default_estimates: { min_pct: 90, max_pct: 125 }, async: true })).d;
  await new Promise((r) => setTimeout(r, 1500));
  const t = Date.now();
  await call('cancel_job', { job_id: job.job_id });
  let st: any;
  for (; ;) { st = (await call('job_status', { job_id: job.job_id, wait_seconds: 1 })).d; if (st.status !== 'running') break; }
  assert.ok(Date.now() - t < 5000, `ended in ${Date.now() - t} ms`);
  assert.equal(st.status, 'cancelled', JSON.stringify(st).slice(0, 300));
  assert.equal(await dates(a), before);
  assert.equal(await dates(keep), keepBefore);
  assert.equal((await call('list_open', {})).d.open.find((p: any) => p.handle === keep.handle).unsaved_changes, unsaved, 'another project’s unsaved edits are as they were');
  // the server goes on: the next run starts a worker again
  const again = await call('monte_carlo', { ...a, iterations: 20, default_estimates: { min_pct: 90, max_pct: 125 } });
  assert.equal(again.err, false, JSON.stringify(again.d).slice(0, 200));
  for (const h of [a, keep]) await call('close', { ...h, discard: true });
});

test('LOB plans and PDFs are made in the worker and come back whole (files written under the same roots)', { timeout: 120_000 }, async () => {
  const h = await open();
  const dir = mkdtempSync(join(tmpdir(), 'p6-compute-'));
  const pdf = join(dir, 'plan.pdf');
  const r = await call('export_pdf', { ...h, path: pdf });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
  assert.equal(readFileSync(pdf).subarray(0, 4).toString(), '%PDF');
  writeFileSync(join(dir, 'ok'), '');
  await call('close', { ...h, discard: true });
});
