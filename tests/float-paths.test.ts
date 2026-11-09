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

test('paths between two activities: one function (core/schedule/floatPaths.ts) for float_paths and the Float paths panel; the panel’s call equals the tool’s between, and the tool’s refusal is as it was', async () => {
  const { pathsBetween, BETWEEN_NEEDS } = await import('../core/schedule/floatPaths.ts');
  const { sessions } = await import('../mcp/runtime.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const h = (await call('open_file', { path: join(import.meta.dirname, '..', 'Sample XERs', 'cairo festival city.xer') })).d.handle;
  const db = sessions.get(h)!.db, ids = rows(db, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id);
  for (const between of [{ from: 'A1000', to: 'A1010', max: 3 }, { from: 'A1000', to: 'A1010' }, { from: 'A1010', to: 'A1000' }]) {
    const tool = await call('float_paths', { handle: h, between });
    assert.equal(tool.err, false, JSON.stringify(tool.d).slice(0, 300));
    // the panel: the open projects (here all of them), the preference's hours per day (the tool's session has the same)
    assert.deepEqual(JSON.parse(JSON.stringify(pathsBetween(db, ids, between, 8))), tool.d.between, JSON.stringify(between));
  }
  assert.ok((await call('float_paths', { handle: h, between: { from: 'A1000', to: 'A1010' } })).d.between.paths.length >= 1);
  assert.equal(pathsBetween(db, ids, { from: 'A1000', to: 'NOPE' }, 8), null, 'not an activity of these projects');
  assert.equal(pathsBetween(db, ids, { from: '', to: 'A1010' }, 8), null);
  const bad = await call('float_paths', { handle: h, between: { from: 'A1000', to: 'NOPE' } });
  assert.equal(bad.d.error.code, 'bad_input');
  assert.equal(bad.d.error.message, BETWEEN_NEEDS);
  assert.equal(bad.d.error.message, 'between needs from and to Activity IDs of this project.');
  assert.equal(bad.d.error.hint, 'e.g. {"from": "A1000", "to": "A9000"}');
});

// pathsBetween on small networks built by hand: activities {id, hrs, float?}, relationships [pred, succ]
const net = (acts: [string, number, number?][], rels: [string, string][]) => ({ tables: {
  TASK: { fields: [], rows: acts.map(([id, h, f]) => ({ proj_id: 'P', task_id: id, task_code: id, remain_drtn_hr_cnt: String(h), target_drtn_hr_cnt: String(h), act_end_date: '', total_float_hr_cnt: f == null ? '' : String(f) })) },
  TASKPRED: { fields: [], rows: rels.map(([a, b]) => ({ pred_task_id: a, task_id: b })) },
} } as unknown as Db);
/** n two-way diamonds in a row: S -> (a_i | b_i) -> J1 -> ... -> J_n; the b branch is 1 h longer, so durations are distinct per count of b's. */
const ladder = (n: number) => {
  const acts: [string, number, number?][] = [['S', 8, 0]], rels: [string, string][] = [];
  let prev = 'S';
  for (let i = 1; i <= n; i++) { acts.push([`a${i}`, 8, 0], [`b${i}`, 16, 0], [`J${i}`, 8, 0]); rels.push([prev, `a${i}`], [prev, `b${i}`], [`a${i}`, `J${i}`], [`b${i}`, `J${i}`]); prev = `J${i}`; }
  return { db: net(acts, rels), last: prev };
};

test('pathsBetween: the longest paths come back, not the first found', async () => {
  const { pathsBetween } = await import('../core/schedule/floatPaths.ts');
  // the depth-first walk meets the short branches first (X1, X2 are listed before L1, L2 in the links)
  const db = net([['F', 8, 0], ['X1', 8, 0], ['X2', 16, 0], ['L1', 80, 0], ['L2', 40, 0], ['T', 8, 0]], [['F', 'X1'], ['F', 'X2'], ['F', 'L1'], ['F', 'L2'], ['X1', 'T'], ['X2', 'T'], ['L1', 'T'], ['L2', 'T']]);
  const r = pathsBetween(db, ['P'], { from: 'F', to: 'T', max: 2 }, 8) as any;
  assert.deepEqual(r.paths.map((p: any) => p.activities), [['F', 'L1', 'T'], ['F', 'L2', 'T']]);
  assert.deepEqual(r.paths.map((p: any) => p.duration_days), [12, 7]);
  assert.deepEqual([r.paths_total, r.truncated], [4, true]);
  assert.equal((pathsBetween(db, ['P'], { from: 'F', to: 'T' }, 8) as any).truncated, false);
});

test('pathsBetween: a ladder of 12 diamonds has 4096 paths; max picks the longest, a large max lists all', async () => {
  const { pathsBetween } = await import('../core/schedule/floatPaths.ts');
  const { db, last } = ladder(12);
  const r = pathsBetween(db, ['P'], { from: 'S', to: last, max: 25 }, 8) as any;
  assert.equal(r.paths_total, 4096);
  assert.equal(r.paths.length, 25);
  assert.equal(r.truncated, true);
  // 1 + 12 * 2 + 12 days at best (all b): 8 + 12 * (16 + 8) h = 296 h; then one a in place of one b: 288 h, 12 of them; then 280 h
  const days = r.paths.map((p: any) => p.duration_days);
  assert.deepEqual(days.slice(0, 1 + 12 + 12), [37, ...Array(12).fill(36), ...Array(12).fill(35)]);
  assert.equal(new Set(r.paths.map((p: any) => p.activities.join())).size, 25, 'distinct paths');
  const all = pathsBetween(db, ['P'], { from: 'S', to: last, max: 5000 }, 8) as any;
  assert.equal(all.paths.length, 4096);
  assert.equal(all.truncated, false);
  assert.equal(new Set(all.paths.map((p: any) => p.activities.join())).size, 4096);
  assert.deepEqual(all.paths.map((p: any) => p.duration_days), [...all.paths.map((p: any) => p.duration_days)].sort((x: number, y: number) => y - x));
});

test('pathsBetween: 80 diamonds (2^80 paths) answer at once with the exact count', async () => {
  const { pathsBetween } = await import('../core/schedule/floatPaths.ts');
  const { db, last } = ladder(80);
  const t0 = Date.now();
  const r = pathsBetween(db, ['P'], { from: 'S', to: last }, 8) as any;
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.paths_total, (2n ** 80n).toString());
  assert.equal(r.paths.length, 25);
  assert.equal(r.truncated, true);
  assert.equal(r.paths[0].duration_days, (8 + 80 * 24) / 8);
  assert.equal(r.paths[0].activities.length, 1 + 80 * 2);
});

test('pathsBetween: ties in duration at the cut are settled by the lowest float, as the final order says', async () => {
  const { pathsBetween } = await import('../core/schedule/floatPaths.ts');
  // F -> {A, B, C, D} -> T, all 8 h, so every path lasts the same; the floats of A..D are 40, 8, 24, 16 hours
  const db = net([['F', 8, 80], ['A', 8, 40], ['B', 8, 8], ['C', 8, 24], ['D', 8, 16], ['T', 8, 80]], ['A', 'B', 'C', 'D'].flatMap((x): [string, string][] => [['F', x], [x, 'T']]));
  const r = pathsBetween(db, ['P'], { from: 'F', to: 'T', max: 2 }, 8) as any;
  assert.deepEqual(r.paths.map((p: any) => p.activities[1]), ['B', 'D'], 'the two lowest floats, not the first two found');
  assert.deepEqual(r.paths.map((p: any) => p.min_float_days), [1, 2]);
  assert.deepEqual([r.paths_total, r.truncated], [4, true]);
  // the tie sits one activity before the end: tails of M tie, and the float is only known further along
  const db2 = net([['F', 8, 80], ['P1', 8, 40], ['P2', 8, 8], ['M', 8, 80], ['T', 8, 80]], [['F', 'P1'], ['F', 'P2'], ['P1', 'M'], ['P2', 'M'], ['M', 'T']]);
  const r2 = pathsBetween(db2, ['P'], { from: 'F', to: 'T', max: 1 }, 8) as any;
  assert.deepEqual(r2.paths[0].activities, ['F', 'P2', 'M', 'T']);
});

test('pathsBetween: two relationships between one pair of activities are one path', async () => {
  const { pathsBetween } = await import('../core/schedule/floatPaths.ts');
  const db = net([['F', 8], ['M', 8], ['T', 8]], [['F', 'M'], ['F', 'M'], ['M', 'T']]);
  const r = pathsBetween(db, ['P'], { from: 'F', to: 'T' }, 8) as any;
  assert.deepEqual([r.paths.length, r.paths_total, r.truncated], [1, 1, false]);
  assert.equal(r.paths[0].min_float_days, null);
});

test('pathsBetween: a loop between from and to is an error that names it; a loop elsewhere is not in the way', async () => {
  const { pathsBetween } = await import('../core/schedule/floatPaths.ts');
  const db = net([['F', 8], ['A', 8], ['B', 8], ['T', 8], ['Z', 8]], [['F', 'A'], ['A', 'B'], ['B', 'A'], ['B', 'T'], ['T', 'Z'], ['Z', 'T']]);
  const r = pathsBetween(db, ['P'], { from: 'F', to: 'T' }, 8) as any;
  assert.equal(r.error, 'The logic between F and T has a loop (A -> B -> A); the longest paths cannot be listed until it is broken.');
  // a loop that does not lie between from and to (T <-> Z, after the end) is not a loop of the paths
  assert.equal((pathsBetween(net([['F', 8], ['T', 8], ['Z', 8]], [['F', 'T'], ['T', 'Z'], ['Z', 'T']]), ['P'], { from: 'F', to: 'T' }, 8) as any).paths_total, 1);
  assert.deepEqual((pathsBetween(net([['F', 8]], []), ['P'], { from: 'F', to: 'F' }, 8) as any).paths.map((p: any) => p.activities), [['F']]);
  assert.deepEqual((pathsBetween(net([['F', 8], ['T', 8]], []), ['P'], { from: 'F', to: 'T' }, 8) as any).paths_total, 0);
});
