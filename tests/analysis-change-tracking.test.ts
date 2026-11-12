// change_tracking (core/analysis/changeTracking.ts, registered in mcp/forensics.ts): what changed between a series of updates. The source's gaming fixture (history + current) against the benchmark's own numbers
// (tests/fixtures/benchmark-golden.json, gaming.change_tracking) with every expected difference stated; each of the six categories and its materiality; the modes; a pair with no baseline; a real series
// (Tower-A and its saved variants: verified from the files' rows, in the comments); the refusals; the list rule and the result files on a real pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rows, type Db } from '../core/db.ts';
import { formatP6Date, parseP6Date } from '../core/dates.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { changeTracking, CATEGORIES, DATE_MATERIAL_DAYS, PROGRESS_MATERIAL_POINTS } from '../core/analysis/changeTracking.ts';
import * as B from './benchmark-fixtures.ts';
import { sampleCopy, testRoots } from './helpers.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
testRoots();
const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'benchmark-golden.json'), 'utf8'));
const src = golden.gaming.change_tracking.data;
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const openSample = async (name: string) => { const o = await call('open_file', { path: sampleCopy(name), lenient: true }); assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300)); return o.d.handle as string; };
const upd = (name: string, b: B.Built) => ({ name, db: b.db, projId: b.projId });
const copyOf = (b: B.Built): B.Built => ({ ...b, db: structuredClone(b.db) });
const task = (b: B.Built, code: string) => rows(b.db, 'TASK').find((t) => t.proj_id === b.projId && t.task_code === code)!;
const shift = (v: string, hours: number) => formatP6Date(parseP6Date(v)! + hours * 60);
const gamingSeries = () => { const g = B.gaming(); return [...g.history.map((h) => upd(h.snapshot_date, h.build)), upd('current', g.current)]; };
const cat = (r: ReturnType<typeof changeTracking>, k: string, period?: number): any => (period ? r.periods[period - 1].categories : r.categories)[k as keyof typeof r.categories];

// ------------------------------------------------------------------------------------------------ against the source

test('the source\'s gaming fixture (two saved updates and the current schedule): the same actual-date change, retroactive flag, percent changes and decrease as the source', () => {
  const r = changeTracking({ updates: gamingSeries() });
  assert.equal(r.report, 'Change tracking');
  assert.equal(r.mode, 'all_periods');
  assert.deepEqual(r.updates.map((u) => u.name), ['2026-01-15', '2026-01-22', 'current'], 'three updates in data-date order (the current schedule is the latest)');
  assert.deepEqual(r.updates.map((u) => u.data_date!.slice(0, 10)), src.comparison_summary.snapshot_dates);
  assert.equal(r.periods.length, 2);
  // actual dates: T1's actual start 5 -> 7 January, seen at the 22 January update (source: 1 change, material)
  const sa = src.changes_by_category.actual_changes;
  const act = r.changes.filter((c) => c.category === 'actual_dates');
  assert.equal(act.length, sa.total_changes);
  assert.deepEqual([act[0].id, act[0].field, String(act[0].from).slice(0, 10), String(act[0].to).slice(0, 10), act[0].to_update, act[0].material], [sa.changes[0].task_id, sa.changes[0].field, sa.changes[0].from, sa.changes[0].to, sa.changes[0].snapshot_of_change, sa.changes[0].is_material]);
  assert.deepEqual(cat(r, 'actual_dates'), { result: 'assessed', total: 1, material: 1, not_material: 0 });
  // the retroactive flag (DECM 06A504a, severity high): the same activity, dates and update
  const v = sa.dcma_decm_violations[0];
  assert.equal(r.retroactive_actuals.length, 1);
  assert.deepEqual([r.retroactive_actuals[0].id, r.retroactive_actuals[0].field, String(r.retroactive_actuals[0].from).slice(0, 10), String(r.retroactive_actuals[0].to).slice(0, 10), r.retroactive_actuals[0].to_update], [v.task_id, 'actual_start', v.original_date, v.changed_date, v.snapshot_of_change]);
  const retro = r.flags.find((f) => f.flag === 'retroactive_actual_dates')!;
  assert.equal(retro.severity, src.trends.identified_patterns[0].severity);
  assert.equal(retro.activities_total, src.trends.identified_patterns[0].affected_tasks.length);
  // percent complete: T1 80 -> 60 and T2 20 -> 25, both material (>= 5 points), one decrease (T1, -20 points)
  const sp = src.changes_by_category.progress_changes;
  const pc = r.changes.filter((c) => c.category === 'progress');
  assert.deepEqual(pc.map((c) => [c.id, c.from, c.to, c.material, c.to_update]), sp.changes.map((c: any) => [c.task_id, c.from, c.to, c.is_material, c.snapshot_of_change]));
  assert.equal(cat(r, 'progress').total, sp.total_changes);
  assert.equal(cat(r, 'progress').material, sp.material_changes);
  assert.equal(r.progress_decreases.length, sp.anomalies.length);
  assert.deepEqual([r.progress_decreases[0].id, r.progress_decreases[0].from, r.progress_decreases[0].to], [sp.anomalies[0].task_id, sp.anomalies[0].previous_pct, sp.anomalies[0].current_pct]);
  assert.equal(pc[0].change, sp.anomalies[0].delta_pct);
  const dec = r.flags.find((f) => f.flag === 'progress_decreases')!;
  assert.equal(dec.severity, src.trends.identified_patterns[1].severity);
  assert.deepEqual(r.flags.map((f) => f.flag), ['retroactive_actual_dates', 'progress_decreases'], 'the source raised exactly these two patterns (no baseline revision, no status regression)');
  // logic and resources: none in both
  assert.equal(cat(r, 'logic').total, src.changes_by_category.logic_changes.total_changes);
  assert.equal(cat(r, 'resources').total, src.changes_by_category.resource_changes.total_changes);
  assert.equal(golden.gaming.change_tracking.status, 'fail');
  assert.equal(r.status, 'fail', 'status fail in both');
});

test('EXPECTED DIFFERENCES from the source on that fixture, each with its reason', () => {
  const g = B.gaming(), ups = [...g.history.map((h) => upd(h.snapshot_date, h.build)), upd('current', g.current)];
  const r = changeTracking({ updates: ups });
  // 1. forecast dates: the source's fixture carries no forecast dates (0 forecast changes); in the clone each update is a scheduled project (F9 at its own data date), so the forecast dates move:
  //    period 1 (15 -> 22 Jan): T1 finish and T2 start and finish; period 2 (22 -> 29 Jan): the same three. 6 changes, each read straight from the two builds' early dates.
  assert.equal(src.changes_by_category.forecast_changes.total_changes, 0);
  const fc = r.changes.filter((c) => c.category === 'forecast_dates');
  assert.equal(fc.length, 6);
  assert.deepEqual(fc.map((c) => [c.period, c.id, c.field]), [[1, 'T1', 'forecast_finish'], [1, 'T2', 'forecast_start'], [1, 'T2', 'forecast_finish'], [2, 'T1', 'forecast_finish'], [2, 'T2', 'forecast_start'], [2, 'T2', 'forecast_finish']]);
  const byName = new Map(ups.map((u) => [u.name, u]));
  for (const c of fc) {
    const col = c.field === 'forecast_start' ? 'early_start_date' : 'early_end_date';
    const a = rows(byName.get(c.from_update)!.db, 'TASK').find((t) => t.task_code === c.id)!, b = rows(byName.get(c.to_update)!.db, 'TASK').find((t) => t.task_code === c.id)!;
    assert.equal(c.from, a[col], `${c.id} ${c.field} before`);
    assert.equal(c.to, b[col], `${c.id} ${c.field} after`);
    assert.equal(c.change, (parseP6Date(b[col])! - parseP6Date(a[col])!) / 1440, '7-day 24-hour calendar: a working day is a calendar day');
    assert.equal(c.material, true);
  }
  // 2. baseline dates: the source's fixture has none and reports 0 changes; the clone has no baseline in any update, so the category is not assessed (not 0), with the reason
  assert.equal(src.changes_by_category.baseline_changes.total_changes, 0);
  assert.equal(cat(r, 'baseline_dates').result, 'not_assessed');
  assert.match(cat(r, 'baseline_dates').note, /Neither 2026-01-15 nor 2026-01-22 carries a project baseline/);
  assert.equal(r.status, 'fail');
  // 3. totals: the source counts 3 (1 actual + 2 percent); the clone 9 (the same 3 and the 6 forecast changes)
  assert.equal(src.comparison_summary.total_changes_detected, 3);
  assert.deepEqual(r.totals, { changes: 9, material: 9, not_material: 0 });
  // 4. not carried over: compliance_tags and risk_indicators (constant text restating the patterns), the unused options (change_categories, include_impact_analysis, include_trends, specific_dates)
  assert.equal('compliance_tags' in r, false);
  assert.equal('risk_indicators' in r, false);
});

// ------------------------------------------------------------------------------------------------ the six categories and their materiality

test('date changes: the working days of the activity\'s calendar, material from 1 day, a smaller change counted and not material; percent changes material from 5 points', () => {
  assert.equal(DATE_MATERIAL_DAYS, 1);
  assert.equal(PROGRESS_MATERIAL_POINTS, 5);
  const a = B.cleanChain(), b = copyOf(a);
  // forecast finish T2 +12 h (half a day on the 24-hour calendar), T3 +24 h (exactly one day: material), T1 +23 h 59 min is below one day
  task(b, 'T2').early_end_date = shift(task(a, 'T2').early_end_date, 12);
  task(b, 'T3').early_end_date = shift(task(a, 'T3').early_end_date, 24);
  task(b, 'T1').early_end_date = shift(task(a, 'T1').early_end_date, 23.9833333);
  const r = changeTracking({ updates: [upd('a', a), upd('b', b)] });
  const f = Object.fromEntries(r.changes.filter((c) => c.category === 'forecast_dates' && c.field === 'forecast_finish').map((c) => [c.id, c]));
  assert.deepEqual([f.T2.change, f.T2.material], [0.5, false]);
  assert.deepEqual([f.T3.change, f.T3.material], [1, true], 'exactly one working day is material');
  assert.equal(f.T1.material, false, 'judged on the exact days, not on the rounded 1.0');
  assert.deepEqual(cat(r, 'forecast_dates'), { result: 'assessed', total: 3, material: 1, not_material: 2 });
  assert.equal(r.totals.not_material >= 2, true);
  // percent: T1 20 -> 24 (4 points: counted, not material), T2 20 -> 25 (5: material), T3 50 -> 40 (a decrease of 10: material)
  const c = B.cleanChain(), d = copyOf(c);
  for (const [x, [from, to]] of Object.entries({ T1: [20, 24], T2: [20, 25], T3: [50, 40] })) { B.setPhysicalPercent(c, x, from); B.setPhysicalPercent(d, x, to); }
  const p = changeTracking({ updates: [upd('c', c), upd('d', d)] });
  const pc = Object.fromEntries(p.changes.filter((x) => x.category === 'progress').map((x) => [x.id, x]));
  assert.deepEqual([pc.T1.change, pc.T1.material, pc.T1.basis], [4, false, 'physical']);
  assert.deepEqual([pc.T2.change, pc.T2.material], [5, true]);
  assert.deepEqual([pc.T3.change, pc.T3.material], [-10, true]);
  assert.deepEqual(cat(p, 'progress'), { result: 'assessed', total: 3, material: 2, not_material: 1, decreased: 1 });
  assert.deepEqual(p.progress_decreases.map((x) => [x.id, x.from, x.to]), [['T3', 50, 40]]);
});

test('logic: a relationship added, removed, kept with another type, kept with another lag: each one change, all material', () => {
  const tasks = (v: 'a' | 'b'): B.Source[] => [
    { id: 'T1', duration_days: 5 }, { id: 'T2', duration_days: 5 },
    { id: 'T3', duration_days: 5, predecessors: v === 'a' ? ['T1'] : ['T1', 'T2'] },            // T2 -> T3 added
    { id: 'T4', duration_days: 5, predecessors: v === 'a' ? ['T1', 'T2'] : ['T1'] },            // T2 -> T4 removed
    { id: 'T5', duration_days: 5, predecessors: [v === 'a' ? 'T1:FS' : 'T1:SS'] },              // type FS -> SS (one change, not a removal and an addition)
    { id: 'T6', duration_days: 5, predecessors: [v === 'a' ? 'T2:FS' : 'T2:FS+2'] },            // lag 0 -> 2
  ];
  const r = changeTracking({ updates: [upd('a', B.project('LG', tasks('a'))), upd('b', B.project('LG', tasks('b')))] });
  const l = Object.fromEntries(r.logic_changes.map((x) => [x.id, x]));
  assert.equal(r.logic_changes.length, 4);
  assert.deepEqual([l.T3.change, l.T3.predecessor, l.T3.from, l.T3.to], ['added', 'T2', null, 'FS']);
  assert.deepEqual([l.T4.change, l.T4.predecessor, l.T4.from, l.T4.to], ['removed', 'T2', 'FS', null]);
  assert.deepEqual([l.T5.change, l.T5.predecessor, l.T5.from, l.T5.to], ['type_changed', 'T1', 'FS', 'SS']);
  assert.deepEqual([l.T6.change, l.T6.from, l.T6.to], ['lag_changed', 'FS', 'FS +2d']);
  assert.deepEqual(cat(r, 'logic'), { result: 'assessed', total: 4, material: 4, not_material: 0, added: 1, removed: 1, type_changed: 1, lag_changed: 1 });
  // the relationships of an activity that only one update has are not tracked (the source skips an activity the earlier update lacks); it is counted
  const more = B.project('LG', [...tasks('b'), { id: 'T7', duration_days: 1, predecessors: ['T6'] }]);
  const r2 = changeTracking({ updates: [upd('a', B.project('LG', tasks('a'))), upd('b', more)] });
  assert.equal(r2.logic_changes.length, 4);
  assert.equal(r2.periods[0].activities_added, 1);
  assert.equal(r2.periods[0].activities_deleted, 0);
});

test('resources: an assignment added to or removed from an activity (by the resource\'s name), all material; a changed quantity is not a change', () => {
  const res = [{ id: 'R1', max_units_per_day: 1 }, { id: 'R2', max_units_per_day: 1 }];
  const mk = (t1: string[], t2: string[]) => B.project('RS', [{ id: 'T1', duration_days: 5, resources: t1 }, { id: 'T2', duration_days: 5, resources: t2 }, { id: 'T3', duration_days: 5 }], { resources: res });
  const a = mk(['R1'], []), b = mk(['R2'], ['R1']);
  const r = changeTracking({ updates: [upd('a', a), upd('b', b)] });
  assert.deepEqual(r.resource_changes.map((x) => [x.id, x.resource, x.change, x.material]).sort(), [['T1', 'R1', 'removed', true], ['T1', 'R2', 'added', true], ['T2', 'R1', 'added', true]]);
  assert.deepEqual(cat(r, 'resources'), { result: 'assessed', total: 3, material: 3, not_material: 0, added: 2, removed: 1 });
  const same = copyOf(a);
  for (const x of rows(same.db, 'TASKRSRC')) x.target_qty = String(Number(x.target_qty) + 10);
  assert.equal(changeTracking({ updates: [upd('a', a), upd('same', same)] }).resource_changes.length, 0);
});

test('baseline dates: the baseline each update carries; a revision is flagged and fails; one below a working day is counted and not material; a pair where an update has none is not assessed', () => {
  const a = B.delayed(), b = copyOf(a);
  const blId = rows(b.db, 'PROJECT').find((p) => p._baseline_of === b.projId)!.proj_id;
  const blTask = (code: string) => rows(b.db, 'TASK').find((t) => t.proj_id === blId && t.task_code === code)!;
  const blOf = (code: string) => rows(a.db, 'TASK').find((t) => t.proj_id === blId && t.task_code === code)!;
  const move = (code: string, col: string, hours: number) => { const t = blTask(code); t[col] = shift(blOf(code)[col], hours); };
  // T2's baseline finish moves 5 days later; T3's baseline start 12 h (below a day)
  for (const col of ['early_end_date', 'target_end_date']) move('T2', col, 5 * 24);
  for (const col of ['early_start_date', 'target_start_date']) move('T3', col, 12);
  const r = changeTracking({ updates: [upd('a', a), upd('b', b)] });
  const bc = r.changes.filter((c) => c.category === 'baseline_dates');
  assert.deepEqual(bc.map((c) => [c.id, c.field, c.change, c.material]), [['T2', 'baseline_finish', 5, true], ['T3', 'baseline_start', 0.5, false]]);
  assert.deepEqual(cat(r, 'baseline_dates'), { result: 'assessed', total: 2, material: 1, not_material: 1 });
  const flag = r.flags.find((f) => f.flag === 'baseline_dates_revised')!;
  assert.deepEqual([flag.count, flag.activities_total, flag.severity], [1, 1, 'high']);
  assert.equal(r.status, 'fail');
  // only an immaterial change: warning is not reached either (a baseline change that is not material is no revision; the date changes are not material: status pass if nothing is material)
  const c = copyOf(a);
  for (const col of ['early_start_date', 'target_start_date']) { const t = rows(c.db, 'TASK').find((x) => x.proj_id === blId && x.task_code === 'T3')!; t[col] = shift(blOf('T3')[col], 12); }
  const r2 = changeTracking({ updates: [upd('a', a), upd('c', c)] });
  assert.equal(r2.status, 'pass');
  assert.equal(r2.flags.length, 0);
  assert.deepEqual(r2.totals, { changes: 1, material: 0, not_material: 1 });
  // a pair where one update has no baseline: not assessed, with the reason, and the other categories are
  const bare = B.cleanChain();
  const n = changeTracking({ updates: [upd('bare', bare), upd('delayed', a)] });
  assert.equal(cat(n, 'baseline_dates').result, 'not_assessed');
  assert.match(cat(n, 'baseline_dates').note, /^bare does not carry a project baseline/);
  assert.equal(cat(n, 'actual_dates').result, 'assessed');
  assert.equal(n.categories.baseline_dates.result, 'not_assessed');
  // a series where only one of its pairs has baselines: the overall category adds the pairs it could and names the other
  const three = changeTracking({ updates: [upd('bare', bare), upd('a', a), upd('b', b)] });
  assert.equal(three.periods[0].categories.baseline_dates.result, 'not_assessed');
  assert.equal(three.periods[1].categories.baseline_dates.result, 'assessed');
  assert.equal((three.categories.baseline_dates as any).total, 2);
  assert.match((three.categories.baseline_dates as any).note, /not assessed in period 1: bare does not carry a project baseline/);
});

test('the modes, the data-date order and the status rule', () => {
  const ups = gamingSeries();
  const all = changeTracking({ updates: ups, mode: 'all_periods' }), latest = changeTracking({ updates: ups, mode: 'latest' });
  assert.equal(all.periods.length, 2);
  assert.equal(latest.periods.length, 1);
  assert.deepEqual(latest.updates.map((u) => u.name), ['2026-01-22', 'current']);
  assert.deepEqual(latest.periods[0].categories, all.periods[1].categories, 'latest is the last pair of all_periods');
  assert.equal(latest.flags.length, 0, 'the retroactive change and the decrease were between the first two updates');
  assert.equal(latest.status, 'warning', 'forecast changes are material, nothing was gamed');
  // updates handed in the wrong order are put in data-date order
  const shuffled = changeTracking({ updates: [ups[2], ups[0], ups[1]] });
  assert.deepEqual(shuffled.updates.map((u) => u.name), all.updates.map((u) => u.name));
  assert.deepEqual(shuffled.categories, all.categories);
  // nothing changed: pass
  const same = B.cleanChain();
  const none = changeTracking({ updates: [upd('x', same), upd('y', copyOf(same))] });
  assert.equal(none.status, 'pass');
  assert.deepEqual(none.totals, { changes: 0, material: 0, not_material: 0 });
  assert.deepEqual(CATEGORIES, ['baseline_dates', 'actual_dates', 'forecast_dates', 'logic', 'resources', 'progress']);
});

// ------------------------------------------------------------------------------------------------ a real series

const sample = (name: string) => { const db: Db = readXerFile(sampleCopy(name)).db; const p = rows(db, 'PROJECT').find((x) => !x._baseline_of)!; return { name, db, projId: p.proj_id }; };

test('Tower-A -> Tower-A_edited -> Tower-A_costloaded -> tower_a_schedule: counted from the files\' rows', () => {
  // The four files are the same project at the same data date (1 April 2026 08:00 in each); they are not later updates of one another by data date (the order given is kept, ties sort stably), they are the same
  // schedule saved after edits. Tower-A_edited differs from Tower-A in the rows below; costloaded and tower_a_schedule carry the same activity, relationship and assignment rows as Tower-A_edited (cost fields apart).
  const ups = ['Tower-A.xer', 'Tower-A_edited.xer', 'Tower-A_costloaded.xer', 'tower_a_schedule.xer'].map(sample);
  assert.deepEqual(ups.map((u) => rows(u.db, 'PROJECT').find((p) => p.proj_id === u.projId)!.last_recalc_date), Array(4).fill('2026-04-01 08:00'));
  const r = changeTracking({ updates: ups });
  assert.equal(r.periods.length, 3);
  const p1 = r.changes.filter((c) => c.period === 1), key = (c: (typeof p1)[number]) => `${c.category} ${c.id} ${c.field}`;
  // Tower-A (rows): A1010 act finish 2026-03-06 17:00; A1020 act start 2026-03-07 07:00, early finish 2026-03-16 18:00; A1030 early finish 2026-04-01 17:00; M1000 early 2026-04-01 17:00.
  // Tower-A_edited (rows): 2026-03-06 08:00; 2026-03-07 08:00 and 2026-04-06 08:00; 2026-04-01 08:00; 2026-04-02 08:00. Baseline (BL1): A1010 finish 03-06 17:00 -> 08:00; A1020 start 03-07 07:00 -> 08:00 and finish 03-14 18:00 -> 08:00.
  assert.deepEqual(p1.map((c) => [key(c), c.from, c.to]), [
    ['baseline_dates A1010 baseline_finish', '2026-03-06 17:00', '2026-03-06 08:00'],
    ['baseline_dates A1020 baseline_start', '2026-03-07 07:00', '2026-03-07 08:00'],
    ['baseline_dates A1020 baseline_finish', '2026-03-14 18:00', '2026-03-14 08:00'],
    ['actual_dates A1010 actual_finish', '2026-03-06 17:00', '2026-03-06 08:00'],
    ['actual_dates A1020 actual_start', '2026-03-07 07:00', '2026-03-07 08:00'],
    ['forecast_dates A1020 forecast_finish', '2026-03-16 18:00', '2026-04-06 08:00'],
    ['forecast_dates A1030 forecast_finish', '2026-04-01 17:00', '2026-04-01 08:00'],
    ['forecast_dates M1000 forecast_start', '2026-04-01 17:00', '2026-04-02 08:00'],
    ['forecast_dates M1000 forecast_finish', '2026-04-01 17:00', '2026-04-02 08:00'],
  ]);
  const ch = Object.fromEntries(p1.map((c) => [key(c), c]));
  // working days: A1010 and A1030 finish on a Friday / Wednesday of the 8-hour Site 5-Day calendar, 17:00 -> 08:00 = the one 8-hour day; A1020 (7-day calendar) forecast finish 16 March 18:00 -> 6 April 08:00 = the 20 days 17 March .. 5 April;
  // M1000 17:00 -> 08:00 the next morning and A1020's start 07:00 -> 08:00 hold no working time
  assert.deepEqual([ch['actual_dates A1010 actual_finish'].change, ch['actual_dates A1010 actual_finish'].material], [-1, true]);
  assert.deepEqual([ch['forecast_dates A1030 forecast_finish'].change, ch['forecast_dates A1030 forecast_finish'].material], [-1, true]);
  assert.deepEqual([ch['forecast_dates A1020 forecast_finish'].change, ch['forecast_dates A1020 forecast_finish'].material], [20, true]);
  for (const k of ['forecast_dates M1000 forecast_start', 'forecast_dates M1000 forecast_finish', 'actual_dates A1020 actual_start']) assert.deepEqual([ch[k].change, ch[k].material], [0, false], k);
  assert.deepEqual(r.periods[0].categories.logic, { result: 'assessed', total: 0, material: 0, not_material: 0, added: 0, removed: 0, type_changed: 0, lag_changed: 0 }, 'the same three relationships (SS lag 20 h) in both');
  assert.equal((r.periods[0].categories.resources as any).total, 0, 'the same resources (PILE, RIG, C35) under renumbered ids');
  assert.equal((r.periods[0].categories.progress as any).total, 0, 'the same % complete (A1020 40 %: 60 of 100 h left)');
  assert.deepEqual(r.retroactive_actuals.map((x) => [x.id, x.field]), [['A1010', 'actual_finish'], ['A1020', 'actual_start']]);
  assert.equal(r.status, 'fail');
  // the next two pairs: the same rows
  for (const k of [2, 3]) { assert.equal(r.changes.filter((c) => c.period === k).length, 0, `period ${k}`); assert.equal(r.periods[k - 1].categories.baseline_dates.result, 'assessed'); }
  assert.equal(r.flags.find((f) => f.flag === 'baseline_dates_revised')!.count, 2, 'the baseline finish of A1010 and of A1020 (a day each); the start of A1020 holds no working time');
});

test('a baseline taken as an update: the project\'s own baseline copy as the earlier update (no baseline of its own: baseline dates not assessed)', () => {
  const tw = sample('Tower-A.xer');
  const bl = rows(tw.db, 'PROJECT').find((p) => p._baseline_of === tw.projId)!;
  const r = changeTracking({ updates: [{ name: 'baseline', db: tw.db, projId: bl.proj_id }, { name: 'current', db: tw.db, projId: tw.projId }] });
  assert.equal(r.periods.length, 1);
  assert.equal(cat(r, 'baseline_dates').result, 'not_assessed');
  // A1020 started 7 March and is 40 % in the current schedule, not started in the baseline: an actual start that appears, and a 0 -> 40 % change (rows: baseline TK_NotStart, current TK_Active 60 of 100 h left)
  assert.deepEqual(r.changes.filter((c) => c.category === 'actual_dates').map((c) => [c.id, c.field, c.from, c.to, c.material]), [['A1010', 'actual_start', null, '2026-03-02 08:00', true], ['A1010', 'actual_finish', null, '2026-03-06 17:00', true], ['A1020', 'actual_start', null, '2026-03-07 07:00', true]]);
  assert.deepEqual(r.changes.filter((c) => c.category === 'progress').map((c) => [c.id, c.from, c.to]), [['A1010', 0, 100], ['A1020', 0, 40]]);
  assert.equal(r.retroactive_actuals.length, 0, 'no actual date existed before: not a retroactive change');
});

// ------------------------------------------------------------------------------------------------ the tool

test('change_tracking through the server: read-only, mode and updates, refusals, the list rule and the result files on a real pair', async () => {
  const { toolsList } = await import('../mcp/server.ts');
  const t = (toolsList() as any[]).find((x) => x.name === 'change_tracking');
  assert.ok(t, 'listed');
  assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['handle', 'export', 'export_name', 'project', 'mode', 'updates', 'caller', 'async']);
  assert.deepEqual(t.inputSchema.properties.mode.enum, ['latest', 'all_periods']);
  assert.deepEqual(t.inputSchema.required.filter((k: string) => k !== 'handle'), ['updates']);
  const h = await openSample('129 trial.xer');
  // refusals: no updates, a mode that is not one, an update that is nothing, a handle that is not open, the same as windows_analysis
  const none = await call('change_tracking', { handle: h });
  assert.equal(none.err, true);
  assert.equal(none.d.error.code, 'bad_input');
  assert.match(none.d.error.message, /updates must list the other updates/);
  assert.match((await call('windows_analysis', { handle: h })).d.error.message, /updates must list the other updates/);
  const mode = await call('change_tracking', { handle: h, mode: 'specific_dates', updates: [{ baseline: 'project' }] });
  assert.equal(mode.err, true);
  assert.match(mode.d.error.message, /mode "specific_dates" is not an accepted value\. mode is one of: latest, all_periods/);
  const empty = await call('change_tracking', { handle: h, updates: [{}] });
  assert.equal(empty.err, true);
  assert.match(empty.d.error.message, /updates\[0\] needs handle, path, baseline, or data_date with progress/);
  const noBl = await call('change_tracking', { handle: h, updates: [{ baseline: 'bl3' }] });
  assert.equal(noBl.err, true);
  assert.equal(noBl.d.error.code, 'bad_input');
  // a real pair: 129 trial (the open file) and 130 TRIAL (by path), put in data-date order (2010-10-31 and 2010-11-10)
  const r = await call('change_tracking', { handle: h, updates: [{ path: sampleCopy('130 TRIAL.xer') }], bogus: 1 });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.match(r.d.arguments_not_used.join(' '), /change_tracking has no argument "bogus"/);
  assert.deepEqual(Object.keys(r.d).slice(0, 3), ['report', 'status', 'summary'], 'summary first');
  // counted independently from the two files' rows: the activities in both (by Activity ID), the relationships and assignments among them
  const A = readXerFile(sampleCopy('129 trial.xer')).db, Bf = readXerFile(sampleCopy('130 TRIAL.xer')).db;
  const main = (d: Db) => rows(d, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
  const tasksOf = (d: Db) => new Map(rows(d, 'TASK').filter((x) => x.proj_id === main(d)).map((x) => [x.task_id, x.task_code]));
  const ta = tasksOf(A), tb = tasksOf(Bf), codesA = new Set(ta.values()), codesB = new Set(tb.values());
  const both = new Set([...codesA].filter((c) => codesB.has(c)));
  assert.equal(r.d.periods[0].activities_added + r.d.periods[0].activities_deleted, codesA.size + codesB.size - 2 * both.size);
  const rels = (d: Db, ids: Map<string, string>) => new Set(rows(d, 'TASKPRED').filter((x) => ids.has(x.task_id)).map((x) => `${ids.get(x.pred_task_id) ?? '#'} -> ${ids.get(x.task_id)} ${x.pred_type}`));
  const dd = (d: Db) => rows(d, 'PROJECT').find((p) => p.proj_id === main(d))!.last_recalc_date;
  const [early, late] = dd(A) <= dd(Bf) ? [[A, ta], [Bf, tb]] as const : [[Bf, tb], [A, ta]] as const;
  assert.deepEqual(r.d.updates.map((u: any) => u.data_date.slice(0, 10)), [dd(early[0] as Db).slice(0, 10), dd(late[0] as Db).slice(0, 10)]);
  const e = rels(early[0] as Db, early[1] as Map<string, string>), l = rels(late[0] as Db, late[1] as Map<string, string>);
  const keyOf = (k: string) => { const m = /^(.*) -> (.*) (PR_\w+)$/.exec(k)!; return { pred: m[1], succ: m[2], type: m[3] }; };
  const inBoth = (k: string) => both.has(keyOf(k).succ);
  const added = [...l].filter((k) => !e.has(k) && inBoth(k)), removed = [...e].filter((k) => !l.has(k) && inBoth(k));
  // a changed type on the same pair is one change, not a removal and an addition; a lag change on the same key is one more
  const pairKey = (k: string) => { const x = keyOf(k); return `${x.pred}>${x.succ}`; };
  const typeChanged = added.filter((k) => removed.some((q) => pairKey(q) === pairKey(k)) && added.filter((z) => pairKey(z) === pairKey(k)).length === 1 && removed.filter((z) => pairKey(z) === pairKey(k)).length === 1);
  const lagChanges = (() => { const lag = (d: Db, ids: Map<string, string>) => new Map(rows(d, 'TASKPRED').filter((x) => ids.has(x.task_id)).map((x) => [`${ids.get(x.pred_task_id) ?? '#'} -> ${ids.get(x.task_id)} ${x.pred_type}`, x.lag_hr_cnt])); const a = lag(early[0] as Db, early[1] as Map<string, string>), b = lag(late[0] as Db, late[1] as Map<string, string>); return [...b].filter(([k, v]) => a.has(k) && inBoth(k) && a.get(k) !== v).length; })();
  const logicTotal = added.length + removed.length - typeChanged.length + lagChanges;
  assert.ok(logicTotal > 0);
  assert.equal(r.d.categories.logic.total, logicTotal, 'logic changes counted from the two files\' relationship rows');
  const asg = (d: Db, ids: Map<string, string>) => { const rs = new Map(rows(d, 'RSRC').map((x) => [x.rsrc_id, x.rsrc_short_name])); return new Set(rows(d, 'TASKRSRC').filter((x) => ids.has(x.task_id) && x.rsrc_id).map((x) => `${ids.get(x.task_id)}|${rs.get(x.rsrc_id)}`)); };
  const aa = asg(early[0] as Db, early[1] as Map<string, string>), ab = asg(late[0] as Db, late[1] as Map<string, string>);
  const resTotal = [...ab].filter((k) => !aa.has(k) && both.has(k.split('|')[0])).length + [...aa].filter((k) => !ab.has(k) && both.has(k.split('|')[0])).length;
  assert.ok(resTotal > 25, 'more than a list holds');
  assert.equal(r.d.categories.resources.total, resTotal, 'resource changes counted from the two files\' assignment rows');
  assert.equal(r.d.resource_changes_total, resTotal);
  assert.equal(r.d.resource_changes.length, 25);
  assert.match(r.d.resource_changes_note, new RegExp(`^25 of ${resTotal} shown; all ${resTotal} in .*change_tracking-resource_changes\\.csv$`));
  const csv = r.d.exported.files.find((f: any) => f.path.endsWith('-resource_changes.csv'));
  assert.equal(csv.rows, resTotal);
  const whole = JSON.parse(readFileSync(r.d.exported.files.find((f: any) => f.path.endsWith('change_tracking.json')).path, 'utf8'));
  assert.equal(whole.resource_changes.length, resTotal);
  assert.equal(whole.logic_changes.length, logicTotal);
  assert.deepEqual(r.d.exported.files.map((f: any) => f.path.replace(/^.*change_tracking/, '')).sort(), ['-changes.csv', '-logic_changes.csv', '-progress_decreases.csv', '-resource_changes.csv', '-retroactive_actuals.csv', '-status_regressions.csv', '.json']);
  assert.match(r.d.method.join(' '), /1 working day .* \(the source: 1 calendar day/);
  // the series by handle and in latest mode: the same file as an update (a copy), nothing changed
  const twin = await openSample('Tower-A.xer');
  const h2 = await call('open_file', { path: sampleCopy('Tower-A_edited.xer'), lenient: true });
  const lat = await call('change_tracking', { handle: twin, mode: 'latest', updates: [{ handle: h2.d.handle }, { baseline: 'project' }] });
  assert.equal(lat.err, false, JSON.stringify(lat.d).slice(0, 300));
  assert.equal(lat.d.mode, 'latest');
  assert.equal(lat.d.periods.length, 1);
  assert.equal(lat.d.updates.length, 2);
});

// ------------------------------------------------------------------------------------------------ the open project in the series

test('every update, the open project included, is ordered by data date: the open project is not always the latest, and the answer says the order and which one it is', async () => {
  const ups = gamingSeries();
  // the open project is the 22 January update; "current" (29 January) is another update, handed in first
  const open = { ...ups[1], name: 'open', open: true };
  const r = changeTracking({ updates: [ups[2], open, ups[0]] });
  assert.deepEqual(r.updates, [{ name: '2026-01-15', data_date: '2026-01-15 00:00', open_project: false }, { name: 'open', data_date: '2026-01-22 00:00', open_project: true }, { name: 'current', data_date: '2026-01-29 00:00', open_project: false }]);
  assert.match(r.method.join(' '), /every update, this open project included, is ordered by its data date \(so the open project is the last only when its data date is the latest\)/);
  // latest = the last pair in DATA-DATE order, whichever one the open project is
  const latest = changeTracking({ updates: [ups[2], open, ups[0]], mode: 'latest' });
  assert.deepEqual(latest.updates.map((u) => [u.name, u.open_project]), [['open', true], ['current', false]]);
  assert.deepEqual([latest.periods[0].from, latest.periods[0].to], ['open', 'current']);
  // through the server: 129 trial is open (data date 31 October 2010) and 130 TRIAL (10 November) is the other update: the open project comes FIRST
  const h = await openSample('129 trial.xer');
  const s = await call('change_tracking', { handle: h, updates: [{ path: sampleCopy('130 TRIAL.xer') }] });
  assert.equal(s.err, false, JSON.stringify(s.d).slice(0, 300));
  assert.deepEqual(s.d.updates.map((u: any) => [u.data_date.slice(0, 10), u.open_project]), [['2010-10-31', true], ['2010-11-10', false]]);
  // and the descriptions no longer say the open project is the latest (change_tracking, decm; windows_analysis says it is last only when its data date is)
  const { toolsList } = await import('../mcp/server.ts');
  const tools = Object.fromEntries((toolsList() as any[]).map((t) => [t.name, t]));
  for (const n of ['change_tracking', 'decm']) assert.doesNotMatch(tools[n].description + JSON.stringify(tools[n].inputSchema), /(project|handle) is the (LATEST|latest|last) update|this project is the (last|latest)/, n);
  assert.match(tools.windows_analysis.description, /every update, this handle included unless include_current is false, is put in data-date order \(this handle is the last only when its data date is the latest\)/);
  assert.match(tools.change_tracking.description, /every update, this open project included, is put in data-date order \(the open project is the last only when its data date is the latest; the answer's updates lists the order used and marks the open project\)/);
});

test('a series on a file with several projects is refused, naming the Project IDs and "pass project" (change_tracking, decm 06A504, windows_analysis); a baseline stored in the file is not a second project', async () => {
  const db = readXerFile(sampleCopy('Enppi.xer')).db;
  const ids = rows(db, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_short_name);
  assert.ok(ids.length > 1);
  const h = await openSample('Enppi.xer');
  for (const [tool, args] of [['change_tracking', { updates: [{ path: sampleCopy('Enppi.xer') }] }], ['decm', { updates: [{ path: sampleCopy('Enppi.xer') }] }], ['windows_analysis', { updates: [{ path: sampleCopy('Enppi.xer') }] }]] as const) {
    const r = await call(tool, { handle: h, ...args });
    assert.equal(r.err, true, tool);
    assert.equal(r.d.error.code, 'bad_input', tool);
    assert.match(r.d.error.message, new RegExp(`^This file has ${ids.length} projects \\(${ids.join(', ')}\\) and a series compares one project\\.`), tool);
    assert.match(JSON.stringify(r.d.error), new RegExp(`Pass project: ${ids.join(', ')}`), tool);
  }
  // the update file with several projects is refused the same way (the open file has one project: Tower-A)
  const tw = await openSample('Tower-A.xer');
  const other = await call('change_tracking', { handle: tw, updates: [{ path: sampleCopy('Enppi.xer' ) }] });
  assert.equal(other.err, true);
  assert.match(other.d.error.message, new RegExp(`^Update 1 \\(Enppi\\.xer\\) has ${ids.length} projects`));
  // with project given the series runs (the project is looked for in every schedule of the series)
  const ok = await call('change_tracking', { handle: h, project: ids[0], updates: [{ path: sampleCopy('Enppi.xer') }] });
  assert.equal(ok.err, false, JSON.stringify(ok.d).slice(0, 300));
  assert.equal(ok.d.totals.changes, 0, 'the project against itself');
  const win = await call('windows_analysis', { handle: h, project: ids[0], updates: [{ path: sampleCopy('Enppi.xer') }] });
  assert.equal(win.err, false, JSON.stringify(win.d).slice(0, 300));
  // a project that is not there
  const none = await call('change_tracking', { handle: h, project: 'NOPE', updates: [{ path: sampleCopy('Enppi.xer') }] });
  assert.match(none.d.error.message, /No project "NOPE"\./);
  // Tower-A holds a baseline as a project of its own in the file (_baseline_of): that is not a second project, so a series with the baseline still runs without project
  assert.equal(rows(readXerFile(sampleCopy('Tower-A.xer')).db, 'PROJECT').length > 1, true, 'the baseline copy is a row of PROJECT');
  for (const tool of ['change_tracking', 'windows_analysis', 'decm']) assert.equal((await call(tool, { handle: tw, updates: [{ baseline: 'project' }] })).err, false, tool);
  // baseline_variance's as_planned file with several projects: refused, with its own next step
  const bv = await call('baseline_variance', { handle: tw, as_planned: { path: sampleCopy('Enppi.xer') } });
  assert.equal(bv.err, true);
  assert.match(bv.d.error.message, new RegExp(`has ${ids.length} projects`));
  assert.match(JSON.stringify(bv.d.error), /as_planned must be a schedule with one project/);
});
