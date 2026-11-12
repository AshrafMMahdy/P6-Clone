import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFormat, readRaw } from '../renderer/io.ts';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { computeFloatPaths, storedFloatPathOptions } from '../core/schedule/floatPaths.ts';
import { callTool, toolResult } from '../mcp/server.ts';
import { setRoots } from '../mcp/runtime.ts';

// the result files every analysis writes go to a temporary write root, never into the repository; the samples are read from the repository
setRoots(join(import.meta.dirname, '..'), mkdtempSync(join(tmpdir(), 'p6-float-')));

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
    const { paths_note: _n, ...shown } = tool.d.between; // (the note that says where all the paths are: the result file, written without being asked)
    assert.deepEqual(JSON.parse(JSON.stringify(pathsBetween(db, ids, between, 8))), shown, JSON.stringify(between));
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

test('pathsBetween: 80 diamonds (2^80 paths) answer with the exact count', async () => {
  const { pathsBetween } = await import('../core/schedule/floatPaths.ts');
  const { db, last } = ladder(80);
  const r = pathsBetween(db, ['P'], { from: 'S', to: last }, 8) as any; // (that it finishes at all is the proof: 2^80 paths are never walked)
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

test('pathsBetween: a chain of 20,000 activities is one path (the reach of "to" is a reverse search, not a fixpoint over every link again and again)', async () => {
  const { pathsBetween } = await import('../core/schedule/floatPaths.ts');
  const n = 20000;
  const db = net(Array.from({ length: n }, (_, i): [string, number, number?] => [`C${i}`, 8, 0]), Array.from({ length: n - 1 }, (_, i): [string, string] => [`C${i}`, `C${i + 1}`]));
  const r = pathsBetween(db, ['P'], { from: 'C0', to: `C${n - 1}` }, 8) as any;
  assert.deepEqual([r.paths.length, r.paths_total, r.truncated, r.paths[0].activities.length], [1, 1, false, n]);
  // links listed in reverse order (the worst order for a fixpoint) give the same
  const back = net(Array.from({ length: n }, (_, i): [string, number, number?] => [`C${i}`, 8, 0]), Array.from({ length: n - 1 }, (_, i): [string, string] => [`C${n - 2 - i}`, `C${n - 1 - i}`]));
  assert.equal((pathsBetween(back, ['P'], { from: 'C0', to: `C${n - 1}` }, 8) as any).paths[0].activities.length, n);
  // what cannot reach "to" is not between, even when it is reachable from "from"
  const side = net([['F', 8], ['X', 8], ['T', 8]], [['F', 'X'], ['F', 'T']]);
  assert.deepEqual((pathsBetween(side, ['P'], { from: 'F', to: 'T' }, 8) as any).paths.map((p: any) => p.activities), [['F', 'T']]);
});

test('pathsBetween: the paths kept by merging each successor’s best tails are the best paths there are (against every path of random networks, listed by brute force)', async () => {
  const { pathsBetween } = await import('../core/schedule/floatPaths.ts');
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let round = 0; round < 60; round++) {
    const n = 8 + Math.floor(rnd() * 4);
    // activities 0..n-1 in topological order; from = 0, to = n-1; durations from few values so that ties are common; float known for some
    const acts: [string, number, number?][] = Array.from({ length: n }, (_, i) => [`N${i}`, 8 * (1 + Math.floor(rnd() * 3)), rnd() < 0.3 ? undefined : 8 * Math.floor(rnd() * 4)]);
    const rels: [string, string][] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rnd() < 0.4) rels.push([`N${i}`, `N${j}`]);
    const db = net(acts, rels);
    const succ = (i: number) => rels.filter(([a]) => a === `N${i}`).map(([, b]) => Number(b.slice(1)));
    const all: { d: number; m: number }[] = [];
    const walk = (i: number, d: number, m: number) => { const [, h, f] = acts[i]; d += h; m = Math.min(m, f ?? Infinity); if (i === n - 1) { all.push({ d, m }); return; } for (const j of new Set(succ(i))) walk(j, d, m); };
    walk(0, 0, Infinity);
    for (const max of [1, 2, 3, 7, 1000]) {
      const r = pathsBetween(db, ['P'], { from: 'N0', to: `N${n - 1}`, max }, 8) as any;
      const want = all.sort((x, y) => y.d - x.d || x.m - y.m || 0).slice(0, max).map((p) => [Math.round((p.d / 8) * 10) / 10, p.m === Infinity ? null : Math.round((p.m / 8) * 10) / 10]);
      assert.deepEqual(r.paths.map((p: any) => [p.duration_days, p.min_float_days]), want, `round ${round} max ${max}`);
      assert.equal(r.paths_total, all.length);
    }
  }
});

test('float_paths between: max is a positive whole number (no 0 = all: paths_total says how many), refused as bad_input naming between.max before any work; a loop is answered as bad_input naming it', async () => {
  const { sessions } = await import('../mcp/runtime.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'FPB', start: '2026-03-02' })).d;
  const e = await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: [
    ...['F', 'A', 'B', 'T'].map((id) => ({ op: 'add_activity', id, name: id, duration_days: 2 })),
    { op: 'add_relationship', pred: 'F', succ: 'A' }, { op: 'add_relationship', pred: 'F', succ: 'B' }, { op: 'add_relationship', pred: 'A', succ: 'T' }, { op: 'add_relationship', pred: 'B', succ: 'T' }] });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const fp = (between: unknown) => call('float_paths', { handle: np.handle, between });
  assert.equal((await fp({ from: 'F', to: 'T' })).d.between.paths_total, 2);
  assert.equal((await fp({ from: 'F', to: 'T', max: 1 })).d.between.paths.length, 1);
  for (const max of [0, -1, 2.5, Number.NaN, Infinity, '5', true]) {
    const r = await fp({ from: 'F', to: 'T', max });
    assert.equal(r.d.error?.code, 'bad_input', `max ${String(max)}: ${JSON.stringify(r.d).slice(0, 200)}`);
    assert.match(r.d.error.message, /^between\.max must be a whole number of 1 or more/);
  }
  assert.equal((await fp('F')).d.error.code, 'bad_input');
  // a loop between from and to: the tool answers bad_input with the loop's activities (the project's own logic is not changed by the call)
  const db = sessions.get(np.handle)!.db, id = (c: string) => db.tables.TASK.rows.find((t) => t.task_code === c)!.task_id;
  const link = db.tables.TASKPRED.rows.find((r) => r.pred_task_id === id('F') && r.task_id === id('A'))!;
  db.tables.TASKPRED.rows.push({ ...link, task_pred_id: 'loop-1', pred_task_id: id('A'), task_id: id('F') });
  const loop = await fp({ from: 'F', to: 'T' });
  assert.equal(loop.d.error.code, 'bad_input');
  assert.match(loop.d.error.message, /^The logic between F and T has a loop \((F -> A -> F|A -> F -> A)\); the longest paths cannot be listed until it is broken\.$/);
});

test('float_paths between: a max that does not fit is refused up front, with what would fit, and what fits runs', async () => {
  const { config, sessions, usedMemory } = await import('../mcp/runtime.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'FPL', start: '2026-03-02' })).d;
  const n = 150, ops: Record<string, unknown>[] = [{ op: 'add_activity', id: 'S', name: 'S', duration_days: 1 }];
  let prev = 'S';
  for (let i = 1; i <= n; i++) { ops.push({ op: 'add_activity', id: `a${i}`, name: 'a', duration_days: 1 }, { op: 'add_activity', id: `b${i}`, name: 'b', duration_days: 2 }, { op: 'add_activity', id: `J${i}`, name: 'J', duration_days: 1 }, { op: 'add_relationship', pred: prev, succ: `a${i}` }, { op: 'add_relationship', pred: prev, succ: `b${i}` }, { op: 'add_relationship', pred: `a${i}`, succ: `J${i}` }, { op: 'add_relationship', pred: `b${i}`, succ: `J${i}` }); prev = `J${i}`; }
  const e = await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops });
  assert.equal(e.err, false, JSON.stringify(e.d).slice(0, 300));
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const acts = sessions.get(np.handle)!.db.tables.TASK.rows.length;
  const { workNeed, BETWEEN_BYTES_PER_TAIL } = await import('../mcp/workset.ts');
  const was = config.budgetBytes;
  const s = sessions.get(np.handle)!;
  const room = () => Math.round(0.5 * s.bytes) + 8 * acts * BETWEEN_BYTES_PER_TAIL + 1048576; // the call's own 0.5 x bytes, and the tails of 8 paths
  try {
    config.budgetBytes = usedMemory() + room();
    await call('float_paths', { handle: np.handle, between: { from: 'S', to: prev, max: 5000 } }); // (a refusal first moves the other, idle projects out: the room is measured after it)
    config.budgetBytes = usedMemory() + room();
    const free = () => config.budgetBytes - usedMemory();
    const need = (max: number) => workNeed('float_paths', { between: { from: 'S', to: prev, max } }, s, free)!;
    // a ladder of two ways per rung: from the third rung on, an activity has more than 1,001 paths to the end, so one more path asked is one more tail kept there
    assert.ok(need(1001).bytes - need(1000).bytes > 0.9 * acts * BETWEEN_BYTES_PER_TAIL && need(1001).bytes - need(1000).bytes <= acts * BETWEEN_BYTES_PER_TAIL, 'about the activities x the bytes per kept tail, per path asked');
    const big = await call('float_paths', { handle: np.handle, between: { from: 'S', to: prev, max: 5000 } });
    assert.equal(big.err, true);
    assert.equal(big.d.error.code, 'memory_budget', JSON.stringify(big.d.error).slice(0, 300));
    assert.match(big.d.error.message, /float_paths between/);
    const fit = Number(/at most ([\d,]+) paths \(between\.max\)/.exec(big.d.error.hint)?.[1].replace(/,/g, ''));
    assert.ok(fit >= 1 && fit < 5000, big.d.error.hint);
    assert.ok(need(fit).bytes <= free() && need(fit + 1).bytes > free() - 1, 'the number named is what fits');
    assert.match(big.d.error.hint, /paths_total says how many there are/);
    // what fits runs: the longest `fit` paths come back, paths_total counts them all (2^150 as text)
    const ok = await call('float_paths', { handle: np.handle, between: { from: 'S', to: prev, max: fit } });
    assert.equal(ok.err, false, JSON.stringify(ok.d).slice(0, 300));
    assert.ok(ok.d.between, JSON.stringify(ok.d).slice(0, 400));
    assert.equal(ok.d.between.paths.length, fit);
    assert.equal(ok.d.between.paths_total, (2n ** BigInt(n)).toString());
  } finally { config.budgetBytes = was; }
});

test('float_paths between: the reservation is the tails really kept (a chain with max 5,000 fits), and says so when the ends are not found', async () => {
  const { config, sessions, usedMemory } = await import('../mcp/runtime.ts');
  const { workNeed, BETWEEN_BYTES_PER_TAIL } = await import('../mcp/workset.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'FPC', start: '2026-03-02' })).d;
  const n = 5000, ops: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) ops.push({ op: 'add_activity', id: `c${i}`, name: 'c', duration_days: 1 });
  for (let i = 1; i < n; i++) ops.push({ op: 'add_relationship', pred: `c${i - 1}`, succ: `c${i}` });
  assert.equal((await call('edit', { handle: np.handle, owner_key: np.owner_key, operations: ops })).err, false);
  await call('schedule', { handle: np.handle, owner_key: np.owner_key });
  const s = sessions.get(np.handle)!, was = config.budgetBytes;
  const between = { from: 'c0', to: `c${n - 1}`, max: 5000 };
  try {
    const own = Math.round(0.5 * s.bytes);
    // the old formula (activities between x max x bytes per tail) needs 5,000 x 5,000 x 100 B = 2.4 GB; the chain keeps 1 tail an activity
    assert.ok(n * 5000 * BETWEEN_BYTES_PER_TAIL > 2e9);
    config.budgetBytes = usedMemory() + own + n * BETWEEN_BYTES_PER_TAIL + 2 * 1048576;
    const need = workNeed('float_paths', { between }, s, () => config.budgetBytes - usedMemory())!;
    assert.equal(need.bytes, own + n * BETWEEN_BYTES_PER_TAIL);
    assert.match(need.what, /5,000 activities between them/);
    const r = await call('float_paths', { handle: np.handle, between });
    assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
    assert.equal(r.d.between.paths_total, 1);
    // ends not found as one activity each: the project's activities bound it, and the words say so
    const lost = workNeed('float_paths', { between: { from: 'nope', to: 'c1', max: 7 } }, s, () => Infinity)!;
    assert.match(lost.what, /the ends were not found as one activity each: reserved for the project's 5,000 activities/);
    assert.equal(lost.bytes, own + n * 7 * BETWEEN_BYTES_PER_TAIL);
  } finally { config.budgetBytes = was; }
});

test('float_paths between: the reservation counts the activities between even with a baseline saved (its copies share the Activity IDs)', async () => {
  const { sessions } = await import('../mcp/runtime.ts');
  const { workNeed } = await import('../mcp/workset.ts');
  const call = async (name: string, args: Record<string, unknown>) => { const r = await callTool(name, args); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
  const np = (await call('new_project', { id: 'FPD', start: '2026-03-02' })).d;
  const h = { handle: np.handle, owner_key: np.owner_key };
  assert.equal((await call('edit', { ...h, operations: [{ op: 'add_activity', id: 'F', name: 'F', duration_days: 1 }, { op: 'add_activity', id: 'T', name: 'T', duration_days: 1 }, { op: 'add_relationship', pred: 'F', succ: 'T' }] })).err, false);
  await call('schedule', h);
  const s = sessions.get(np.handle)!, ask = { between: { from: 'F', to: 'T' } };
  assert.match(workNeed('float_paths', ask, s, () => Infinity)!.what, /\(2 activities between them\)/);
  assert.equal((await call('edit', { ...h, operations: [{ op: 'save_baseline', name: 'Plan', assign_as: 'project' }] })).err, false);
  assert.ok(s.db.tables.PROJECT.rows.some((p) => p._baseline_of));
  assert.match(workNeed('float_paths', ask, s, () => Infinity)!.what, /\(2 activities between them\)/);
  assert.match(workNeed('float_paths', { ...ask, project: 'FPD' }, s, () => Infinity)!.what, /\(2 activities between them\)/);
});
