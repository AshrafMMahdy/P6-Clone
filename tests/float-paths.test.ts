import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectFormat, readRaw } from '../renderer/io.ts';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { computeFloatPaths, storedFloatPathOptions } from '../core/schedule/floatPaths.ts';
import { callTool, toolResult } from '../mcp/server.ts';

const open = (f: string) => { const p = join(import.meta.dirname, '..', 'Sample XERs', f); const b = new Uint8Array(readFileSync(p)); return readRaw(b, detectFormat(p, b)).db; };

test('float paths match real P6 output (Oracle sample project, free float method)', () => {
  const db = open('cairo alex-road.xer');
  const pid = rows(db, 'PROJECT')[0].proj_id;
  const stored = new Map(rows(db, 'TASK').map((t) => [t.task_code, [t.float_path, t.float_path_order]]));
  const o = storedFloatPathOptions(db, pid)!;
  assert.deepEqual([o.method, o.count], ['free_float', 50]);
  const r = computeFloatPaths(db, [pid], o);
  // P6 5.0 numbered the paths 11, 21, 22; current P6 numbers them 1, 2, 3
  const p6 = { 11: 1, 21: 2, 22: 3 } as Record<string, number>;
  for (const t of rows(db, 'TASK')) {
    const [fp, fo] = stored.get(t.task_code)!;
    const want = fp ? [p6[fp], Number(fo)] : null;
    const a = r.assign.get(t.task_id);
    assert.deepEqual(a ? [a.path, a.order] : null, want, t.task_code);
  }
  assert.equal(r.paths[0].activities.length, 9);
  assert.equal(r.paths[1].float_hours, 40);
});

test('F9 fills Float Path and Float Path Order when the option is on; total float method; end activity', () => {
  const db: Db = { tables: {} };
  const ok = (ops: unknown[]) => { const x = applyOps(db, ops); assert.ok(x.ok, JSON.stringify(x.error)); };
  ok([
    { op: 'add_project', id: 'FP', start: '2026-03-02' },
    { op: 'add_activity', id: 'S', name: 'Start', type: 'start_milestone' },
    { op: 'add_activity', id: 'A', name: 'Long', duration_days: 10 },
    { op: 'add_activity', id: 'B', name: 'Short', duration_days: 4 },
    { op: 'add_activity', id: 'C', name: 'Shorter', duration_days: 2 },
    { op: 'add_activity', id: 'M', name: 'Mid milestone', type: 'finish_milestone' },
    { op: 'add_activity', id: 'H', name: 'Finish', type: 'finish_milestone' },
    { op: 'add_relationship', pred: 'S', succ: 'A' }, { op: 'add_relationship', pred: 'S', succ: 'B' }, { op: 'add_relationship', pred: 'S', succ: 'C' },
    { op: 'add_relationship', pred: 'A', succ: 'H' }, { op: 'add_relationship', pred: 'B', succ: 'H' }, { op: 'add_relationship', pred: 'C', succ: 'M' }, { op: 'add_relationship', pred: 'M', succ: 'H' },
    { op: 'set_schedule_options', float_paths: true, float_path_method: 'total_float', float_paths_count: 5 },
  ]);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  assert.ok(scheduleProjects(db, [pid]).ok);
  const fp = (c: string) => { const t = rows(db, 'TASK').find((x) => x.task_code === c)!; return [t.float_path, t.float_path_order]; };
  assert.deepEqual([fp('S'), fp('A'), fp('H')], [['1', '1'], ['1', '2'], ['1', '3']], 'path 1 is the longest chain S -> A -> H');
  assert.deepEqual(fp('B'), ['2', '1'], 'B (6 d float) is path 2');
  assert.deepEqual([fp('C'), fp('M')], [['3', '1'], ['3', '2']], 'C -> M (8 d float) is path 3');
  // paths ending with M only cover what leads to M
  const r = computeFloatPaths(db, [pid], { endActivity: 'M' });
  assert.deepEqual(r.paths.map((p) => p.activities.map((a) => a.id)), [['S', 'C', 'M']]);
  // the option round-trips through SCHEDOPTIONS with P6's field names
  const so = rows(db, 'SCHEDOPTIONS')[0];
  assert.deepEqual([so.enable_multiple_longest_path_calc, so.use_total_float_multiple_longest_paths, so.max_multiple_longest_path], ['Y', 'Y', '5']);
});

test('MCP float_paths: paths, near-critical, paths between two activities, write', async () => {
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const h = (await call('open_file', { path: join(import.meta.dirname, '..', 'Sample XERs', 'cairo festival city.xer') })).d.handle;
  const r = await call('float_paths', { handle: h, count: 5, between: { from: 'A1000', to: 'A1010', max: 3 } });
  assert.equal(r.err, false, JSON.stringify(r.d));
  assert.ok(r.d.paths.length >= 1 && r.d.paths[0].path === 1);
  assert.ok(Array.isArray(r.d.near_critical));
  assert.ok(r.d.between.paths.length >= 1 && r.d.between.paths.length <= 3);
  const w = await call('float_paths', { handle: h, write: true });
  assert.equal(w.d.written, true);
  assert.equal(w.d.unsaved_changes, true);
  assert.equal((await call('float_paths', { handle: h, method: 'nope' })).d.error.code, 'bad_input');
});
