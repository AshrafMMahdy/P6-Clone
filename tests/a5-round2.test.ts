// A5 round 3(b): Excel import replaces an edited relationship type, the desktop keeps Microsoft Project's one link per
// pair, monte_carlo's run-only inputs (G-6), level_resources options and dry run (G-7), set_predecessors, evaluate
// and compare mode computed (G-8).
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callTool, toolResult } from '../mcp/server.ts';
import { applyOps } from '../core/project/ops.ts';
import { addRelationship, checkRelationship } from '../core/project/edit.ts';
import { exportSheets, planImport } from '../core/excel/p6sheets.ts';
import { rows, type Db } from '../core/db.ts';

const call = async (name: string, args: Record<string, unknown>, progress?: (d: number, t: number, m: string) => void) => { const r = await callTool(name, args, undefined, undefined, progress); return toolResult(r.out, r.isError).structuredContent as any; };
afterEach(async () => { for (const h of (await call('list_open', {})).open) await call('close', { handle: h.handle, discard: true }); });
const dir = mkdtempSync(join(tmpdir(), 'p6a5b-'));
const two = (): Db => { const db: Db = { tables: {} }; assert.equal(applyOps(db, [{ op: 'add_project', id: 'P', start: '2026-03-02' }, { op: 'add_activity', id: 'A', name: 'A', duration_days: 5 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 5 }, { op: 'add_relationship', pred: 'A', succ: 'B' }]).ok, true); return db; };
const bare = (ops: Record<string, unknown>[]) => ops.map(({ project: _p, ...o }) => o);
const id = (db: Db, c: string) => rows(db, 'TASK').find((t) => t.task_code === c)!.task_id;

test('Excel import: a row whose type was edited replaces that relationship; a new row adds one; a file\'s own SS + FF pair is kept as is', () => {
  const db = two();
  const sheets = exportSheets(db, [rows(db, 'PROJECT')[0].proj_id], 8, true);
  const tp = sheets.find((s) => s.name === 'TASKPRED')!;
  tp.rows[2][tp.rows[0].indexOf('pred_type')] = 'SS';
  const plan = planImport(db, sheets, 'P', 8, true);
  assert.deepEqual(bare(plan.ops), [{ op: 'update_relationship', pred: 'A', succ: 'B', type: 'FS', new_type: 'SS', lag_days: 0 }]);
  assert.equal(applyOps(db, plan.ops).ok, true);
  assert.deepEqual(rows(db, 'TASKPRED').map((r) => r.pred_type), ['PR_SS']);
  // an FF row added beside it: a new link; then the sheet of the pair (SS + FF) re-imports as nothing to change
  tp.rows.push([...tp.rows[2]]);
  tp.rows[3][tp.rows[0].indexOf('pred_type')] = 'FF';
  const add = planImport(db, sheets, 'P', 8, true);
  assert.deepEqual(bare(add.ops), [{ op: 'add_relationship', pred: 'A', succ: 'B', type: 'FF', lag_days: 0 }]);
  assert.equal(applyOps(db, add.ops).ok, true);
  assert.deepEqual(planImport(db, exportSheets(db, [rows(db, 'PROJECT')[0].proj_id], 8, true), 'P', 8, true).ops, []);
  // two edited types on a pair that held two: both replaced, none added
  const both = exportSheets(db, [rows(db, 'PROJECT')[0].proj_id], 8, true), bp = both.find((s) => s.name === 'TASKPRED')!;
  bp.rows[2][bp.rows[0].indexOf('pred_type')] = 'FS'; bp.rows[3][bp.rows[0].indexOf('pred_type')] = 'SF';
  assert.deepEqual(planImport(db, both, 'P', 8, true).ops.map((o) => o.op), ['update_relationship', 'update_relationship']);
});

test('Microsoft Project files keep one relationship per pair, by the same rule in edits and in the desktop\'s own relationship commands', () => {
  const p6 = two(), msp = two();
  msp.tables.PROJECT.rows[0]._msp_source = 'Y'; // as an MSPDI / MPX import marks its project
  assert.equal(checkRelationship(p6, id(p6, 'A'), id(p6, 'B'), 'PR_SS'), undefined);
  assert.match(checkRelationship(msp, id(msp, 'A'), id(msp, 'B'), 'PR_SS')!, /Microsoft Project keeps one relationship per pair/);
  assert.match(addRelationship(msp, id(msp, 'A'), id(msp, 'B'), 'PR_SS') as string, /one relationship per pair/);
  assert.equal(rows(msp, 'TASKPRED').length, 1);
  // the desktop assistant and Excel import go through applyOps: the same rule, from the project
  const r = applyOps(msp, [{ op: 'add_relationship', pred: 'A', succ: 'B', type: 'SS' }]);
  assert.match(r.warnings![0], /Microsoft Project keeps one per pair/);
  assert.match(applyOps(msp, [{ op: 'set_predecessors', activity: 'B', links: [{ pred: 'A' }, { pred: 'A', type: 'SS' }] }]).error!.message, /listed twice \(Microsoft Project keeps one relationship per pair\)/);
});

test('G-6 monte_carlo: inline events (activity and project-level delay), ratio samplers, re_anchor, deadline, working days with sigma marks, progress', async () => {
  const h = (await call('new_project', { id: 'MC', start: '2026-03-02' })).handle;
  await call('edit', { handle: h, operations: [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 10 }, { op: 'add_activity', id: 'B', name: 'B', duration_days: 10 }, { op: 'add_relationship', pred: 'A', succ: 'B' }] });
  await call('schedule', { handle: h });
  const mc = (args: Record<string, unknown>, progress?: (d: number, t: number, m: string) => void) => call('monte_carlo', { handle: h, iterations: 200, seed: 7, ...args }, progress);
  // a certain project-level delay of 5 days: every finish 5 working days later; 3 days on B when it happens
  const ev = await mc({ events: [{ name: 'Permit', probability: 1, delay_days: 5 }, { name: 'Rework', probability_pct: 100, delay_days: 3, activities: ['B'] }] });
  assert.deepEqual([ev.working_days.deterministic, ev.working_days.min, ev.working_days.max], [20, 28, 28]);
  assert.deepEqual(ev.events.map((e: any) => [e.name, e.triggered_pct]), [['Permit', 100], ['Rework', 100]]);
  // samplers: a fixed normal ratio of 1.5 (std 0) makes 30 days; the empirical sampler draws only its ratios
  assert.equal((await mc({ sampler: { type: 'ratio_normal', mean: 1.5, std: 0 } })).working_days.mean, 30);
  const clamp = await mc({ sampler: { type: 'ratio_normal', mean: 1.12, std: 0.28, min_ratio: 1, max_ratio: 1.3 } });
  assert.ok(clamp.working_days.min >= 20 && clamp.working_days.max <= 26, JSON.stringify(clamp.working_days));
  const emp = await mc({ sampler: { type: 'ratio_empirical', ratios: [1, 2], weight: [1, 0] } });
  assert.deepEqual([emp.working_days.min, emp.working_days.max], [20, 20]);
  // re_anchor: an estimate of 10 / 12 / 20 days (mean 14) rescaled to mean 10
  await call('edit', { handle: h, operations: [{ op: 'set_estimates', activity: 'A', min_days: 10, most_likely_days: 12, max_days: 20 }] });
  const raw = await mc({}), re = await mc({ re_anchor: true });
  assert.ok(Math.abs(raw.working_days.mean - 24) < 0.6 && Math.abs(re.working_days.mean - 20) < 0.5, `${raw.working_days.mean} ${re.working_days.mean}`);
  // deadline, sigma marks, progress
  let calls = 0, lastDone = 0;
  const d = await mc({ deadline: '2026-04-01', iterations: 300 }, (done) => { calls++; lastDone = done; });
  assert.ok(d.deadline.probability_pct > 0 && d.deadline.probability_pct < 100, JSON.stringify(d.deadline));
  assert.deepEqual(d.working_days.sigma.map((x: any) => x.k), [-3, -2, -1, 0, 1, 2, 3]);
  assert.equal(d.working_days.sigma[3].days, d.working_days.mean);
  assert.ok(calls >= 1 && lastDone === 300);
  assert.equal((await mc({ sampler: { type: 'beta' } })).error.code, 'bad_input');
  assert.equal((await mc({ events: [{ name: 'x', probability: 2, delay_days: 1 }] })).error.code, 'bad_input');
  assert.equal((await call('get_activity', { handle: h, activity_id: 'A' })).orig_days, 10, 'the project is not changed');
});

test('G-6 monte_carlo stops at a cancellation', async () => {
  const h = (await call('new_project', { id: 'MX', start: '2026-03-02' })).handle;
  await call('edit', { handle: h, operations: [{ op: 'add_activity', id: 'A', name: 'A', duration_days: 10 }, { op: 'set_estimates', activity: 'A', min_days: 8, max_days: 14 }] });
  const abort = new AbortController();
  const p = callTool('monte_carlo', { handle: h, iterations: 20000, seed: 1 }, undefined, abort.signal, (done) => { if (done > 50) abort.abort(); });
  const r = await p;
  assert.equal(r.isError, true);
  assert.equal((toolResult(r.out, r.isError).structuredContent as any).error.code, 'cancelled');
});

async function crew() {
  const h = (await call('new_project', { id: 'LV', start: '2026-03-02' })).handle;
  await call('edit', { handle: h, operations: [
    ...['A', 'B', 'C', 'D'].map((x) => ({ op: 'add_activity', id: x, name: x, duration_days: x === 'D' ? 3 : 5 })),
    { op: 'add_relationship', pred: 'A', succ: 'B' }, { op: 'add_relationship', pred: 'B', succ: 'C' }, { op: 'add_relationship', pred: 'A', succ: 'D' },
    { op: 'add_resource', id: 'CREW', max_units_per_hour: 1 }, { op: 'add_resource', id: 'CRANE', max_units_per_hour: 1 },
    { op: 'assign_resource', activity: 'B', resource: 'CREW', units_per_day: 8 }, { op: 'assign_resource', activity: 'D', resource: 'CREW', units_per_day: 8 },
  ] });
  await call('schedule', { handle: h });
  return h;
}

test('G-7 level_resources: dry_run answers leveled dates and peaks without a change; priority_by, activity_priority, resources, over_allocation_pct', async () => {
  const h = await crew();
  const changesBefore = (await call('list_open', {})).open.find((x: any) => x.handle === h).changes;
  const dry = await call('level_resources', { handle: h, dry_run: true });
  assert.deepEqual([dry.dry_run, dry.delayed, dry.moved], [true, 1, [{ id: 'D', from: '2026-03-09 08:00', start: '2026-03-16 08:00', finish: '2026-03-18 17:00' }]]);
  assert.deepEqual(dry.peaks, [{ resource: 'CREW', peak: 8, limit: 8, day: '2026-03-09', overallocated: false }]);
  assert.equal((await call('get_activity', { handle: h, activity_id: 'D' })).start, '2026-03-09 08:00', 'nothing committed');
  assert.equal((await call('list_open', {})).open.find((x: any) => x.handle === h).changes, changesBefore, 'no undo entry');
  // D first: B (and C after it) wait instead
  assert.deepEqual((await call('level_resources', { handle: h, dry_run: true, activity_priority: ['D'] })).moved.map((m: any) => m.id), ['B', 'C']);
  assert.deepEqual((await call('level_resources', { handle: h, dry_run: true, priority_by: 'total_float' })).moved.map((m: any) => m.id), ['D']);
  // 100 % overallocation allowed: nothing to move; only CRANE leveled: nothing to move
  assert.equal((await call('level_resources', { handle: h, dry_run: true, over_allocation_pct: 100 })).delayed, 0);
  assert.equal((await call('level_resources', { handle: h, dry_run: true, resources: ['CRANE'] })).delayed, 0);
  assert.equal((await call('level_resources', { handle: h, dry_run: true, priority_by: 'colour' })).error.code, 'bad_input');
  assert.equal((await call('level_resources', { handle: h, resources: ['NOPE'] })).error.code, 'bad_input');
  // committed: an undoable change
  const real = await call('level_resources', { handle: h });
  assert.equal(real.delayed, 1);
  assert.equal((await call('get_activity', { handle: h, activity_id: 'D' })).start, '2026-03-16 08:00');
});

test('G-8 set_predecessors replaces every predecessor in one step; a loop or a duplicate in the list refuses the edit', () => {
  const db = two();
  assert.equal(applyOps(db, [{ op: 'add_activity', id: 'C', name: 'C', duration_days: 2 }, { op: 'add_relationship', pred: 'B', succ: 'C' }]).ok, true);
  const r = applyOps(db, [{ op: 'set_predecessors', activity: 'C', links: [{ pred: 'A', type: 'SS', lag_days: 1 }, { pred: 'B', type: 'FF' }] }]);
  assert.deepEqual(r.results, [{ activity: 'C', predecessors: ['A SS', 'B FF'], removed: 1 }]);
  const preds = () => rows(db, 'TASKPRED').filter((x) => x.task_id === id(db, 'C')).map((x) => `${rows(db, 'TASK').find((t) => t.task_id === x.pred_task_id)!.task_code} ${x.pred_type} ${x.lag_hr_cnt}`).sort();
  assert.deepEqual(preds(), ['A PR_SS 8', 'B PR_FF 0']);
  assert.match(applyOps(db, [{ op: 'set_predecessors', activity: 'A', links: [{ pred: 'C' }] }]).error!.message, /would create a loop/);
  assert.match(applyOps(db, [{ op: 'set_predecessors', activity: 'C', links: [{ pred: 'A' }, { pred: 'A' }] }]).error!.message, /listed twice/);
  assert.deepEqual(preds(), ['A PR_SS 8', 'B PR_FF 0'], 'refused: as it was');
  assert.deepEqual(applyOps(db, [{ op: 'set_predecessors', activity: 'C', links: [] }]).results, [{ activity: 'C', predecessors: [], removed: 2 }]);
});

test('G-8 evaluate: a what-if on a scratch state (no undo entry, nothing kept) with its own data date; compare mode computed', async () => {
  const h = await crew();
  const open = async () => (await call('list_open', {})).open.find((x: any) => x.handle === h);
  const before = await open();
  const ev = await call('evaluate', { handle: h, overrides: [{ op: 'update_activity', id: 'D', duration_days: 12 }] });
  assert.deepEqual([ev.ok, ev.base_finish, ev.finish, ev.finish_delta_days, ev.became_critical, ev.no_longer_critical], [true, '2026-03-20 17:00', '2026-03-24 17:00', 2, ['D'], ['B', 'C']]);
  assert.deepEqual(ev.critical.sort(), ['A', 'D']);
  assert.deepEqual(ev.changed.find((c: any) => c.id === 'D').orig_days, [3, 12]);
  const after = await open();
  assert.deepEqual([after.changes, after.unsaved_changes], [before.changes, before.unsaved_changes]);
  assert.equal((await call('get_activity', { handle: h, activity_id: 'D' })).orig_days, 3);
  // a data date for this call: the not-started work moves to it
  const later = await call('evaluate', { handle: h, data_date: '2026-03-09' });
  assert.deepEqual([later.data_date, later.finish_delta_days, later.changed_total], ['2026-03-09 00:00', 0, 0]);
  assert.equal((await call('evaluate', { handle: h, overrides: [{ op: 'update_activity', id: 'NOPE', name: 'x' }] })).error.code, 'op_failed');
  // compare computed: against the same project with D longer, saved as a file
  const path = join(dir, 'longer.xer');
  const ed = await call('edit', { handle: h, operations: [{ op: 'update_activity', id: 'D', duration_days: 12 }] });
  assert.equal(ed.ok, true);
  await call('schedule', { handle: h });
  await call('save', { handle: h, path });
  await call('undo', { handle: h }); await call('undo', { handle: h });
  const cmp = await call('compare', { handle: h, path, mode: 'computed' });
  assert.deepEqual([cmp.mode, cmp.became_critical, cmp.no_longer_critical], ['computed', ['D'], ['B', 'C']]);
  assert.deepEqual(cmp.changes.find((c: any) => c.id === 'D'), { id: 'D', duration_delta_days: 9, remaining_delta_days: 9, finish_shift_days: 9, total_float_delta_days: -7, became_critical: true });
  assert.equal(cmp.changes.some((c: any) => c.id === 'A'), false, 'A computes the same');
});
