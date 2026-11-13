// baseline_variance (core/analysis/baselineVariance.ts, registered in mcp/forensics.ts): the schedule as planned against the schedule as it stands, the slip classes, the critical-path overlay, the delay drivers,
// causal chains and the responsible party. The source's delayed fixture against the benchmark's own numbers (tests/fixtures/benchmark-golden.json: delayed.as_planned_vs_built, delay_analysis, baseline_compare) with every expected
// difference stated; scenarios built as P6 projects for the overlap, the newly critical and the responsible party; Tower-A (a baseline stored in the file) and an as_planned file by hand from their rows; the refusals; the list rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rows, type Db } from '../core/db.ts';
import { formatP6Date, parseP6Date } from '../core/dates.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { baselineVariance, DRIVER_MIN_DAYS, type BaselineVarianceResult } from '../core/analysis/baselineVariance.ts';
import { dcma14 } from '../core/analysis/dcma.ts';
import { checkSchedule } from '../core/analysis/checkSchedule.ts';
import { makeScope } from '../core/analysis/common.ts';
import * as F from '../core/analysis/forensic.ts';
import * as B from './benchmark-fixtures.ts';
import { sampleCopy, testRoots } from './helpers.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
testRoots();
const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'benchmark-golden.json'), 'utf8')).delayed;
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const openSample = async (name: string) => { const o = await call('open_file', { path: sampleCopy(name), lenient: true }); assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300)); return o.d.handle as string; };
const run = (db: Db, o: Parameters<typeof baselineVariance>[1] = {}): BaselineVarianceResult => { const r = baselineVariance(db, o); assert.ok(!('refused' in r), JSON.stringify(r)); return r as BaselineVarianceResult; };
const sample = (name: string) => { const db: Db = readXerFile(sampleCopy(name)).db; const p = rows(db, 'PROJECT').find((x) => !x._baseline_of)!; return { name, db, projId: p.proj_id }; };
const byId = <T extends { id: string }>(l: T[]) => Object.fromEntries(l.map((x) => [x.id, x]));

/** A project of the given tasks, scheduled; its baseline saved from that scheduled state (so the baseline carries float); then the durations changed and the project scheduled again at the same data date. */
function scenario(tasks: B.Source[], now: Record<string, number>, extra: Record<string, unknown>[] = []) {
  const b = B.project('SC', tasks, { start: '2026-01-05' });
  const ap = (ops: Record<string, unknown>[]) => { const r = applyOps(b.db, ops, { calendarDays: true }); if (!r.ok) throw new Error(JSON.stringify(r.error)); };
  const T = rows(b.db, 'TASK').filter((t) => t.proj_id === b.projId);
  ap([{ op: 'build_baseline', name: 'BL', assign_as: 'project', activities: T.map((t) => ({ activity: t.task_code, start: t.early_start_date, finish: t.early_end_date, duration_days: Number(t.target_drtn_hr_cnt) / 24 })) }]);
  ap([...Object.entries(now).map(([id, d]) => ({ op: 'update_activity', id, duration_days: d })), ...extra]);
  const r = scheduleProjects(b.db, [b.projId], { dataDate: parseP6Date('2026-01-05 00:00')! });
  assert.ok(r.ok);
  return b;
}

// ------------------------------------------------------------------------------------------------ against the source

test('the source\'s delayed fixture (T2 five days late): slip classes, project slip, drivers, causal scores, chains, BEI and the weighted % as the source gives them', () => {
  const b = B.delayed();
  const r = run(b.db);
  const ap = golden.as_planned_vs_built.data, da = golden.delay_analysis.data, bc = golden.baseline_compare.data;
  assert.equal(r.report, 'Baseline variance');
  assert.deepEqual(Object.keys(r).slice(0, 3), ['report', 'status', 'notes'], 'notes first');
  assert.equal(r.compared_with.kind, 'baseline');
  assert.equal(r.compared_with.name, 'BL');
  // slip classes: T1 on time, T2 and T3 minor slips (as_planned_vs_built.classification_counts)
  assert.deepEqual(r.slip_classes, ap.classification_counts);
  // per activity (variance rows): T1 0 / 0 / 0, T2 start 0 finish 5 duration 5
  const v = byId(r.variances), sv = Object.fromEntries(golden.variance.map((x: any) => [x.task_id, x]));
  for (const id of ['T1', 'T2']) assert.deepEqual([v[id].start_variance_days, v[id].finish_variance_days, v[id].duration_variance_days, v[id].slip_class], [sv[id].start_variance_days, sv[id].finish_variance_days, sv[id].duration_variance_days, sv[id].slip_class]);
  assert.deepEqual([v.T3.finish_variance_days, v.T3.slip_class], [sv.T3.finish_variance_days, sv.T3.slip_class]);
  assert.deepEqual(r.variances.map((x) => x.id), ['T2', 'T3', 'T1'], 'worst first (the source\'s worst_offenders order, with every activity listed)');
  // project slip: the source's critical_path_delay_days (windows: the net project slip) and, as its contemporaneous total, the sum of the critical drivers' days: both shown
  assert.equal(r.project_slip.result, 'assessed');
  assert.equal((r.project_slip as any).working_days, da.delay_summary.critical_path_delay_days);
  assert.deepEqual([(r.project_slip as any).reference_finish, (r.project_slip as any).current_finish], ['2026-02-05 00:00', '2026-02-10 00:00']);
  assert.equal(r.totals.project_slip_working_days, 5);
  assert.equal(r.totals.critical_drivers_delay_days, 10, 'T2 5 + T3 5: the source\'s contemporaneous total (it shows one of the two by methodology)');
  assert.equal(r.drivers_total, da.delay_summary.delayed_tasks_count);
  // drivers: T2 duration overrun, 5 days, critical, 1 successor, causal score 1.333, share 0.5; T3 5 days, 0 successors, 1
  const d = byId(r.drivers), sd = Object.fromEntries(da.delay_drivers.map((x: any) => [x.task_id, x]));
  for (const id of ['T2', 'T3']) {
    assert.equal(d[id].delay_days, sd[id].delay_days, id);
    assert.equal(d[id].on_critical_path, sd[id].on_critical_path, id);
    assert.equal(d[id].successors_reached, sd[id].successors_impacted, id);
    assert.equal(d[id].causal_score, sd[id].causal_score, id);
    assert.equal(d[id].share_of_driver_days, sd[id].contribution_to_total, id);
  }
  assert.equal(d.T2.variance_type, sd.T2.variance_type);
  assert.deepEqual(r.drivers.map((x) => x.id), da.delay_drivers.map((x: any) => x.task_id));
  // causal chains: T2 -> T3, T3
  assert.deepEqual(r.chains.map((c) => [c.root, c.path]), da.causal_chains.map((c: any) => [c.root_task_id, c.delay_propagation_path]));
  assert.deepEqual(r.chains.map((c) => c.delay_days), da.causal_chains.map((c: any) => c.cumulative_impact_days));
  // BEI (T1 due and complete: 1) and the duration-weighted percent complete (the source's schedule_performance_index 0.435)
  assert.deepEqual([(r.bei as any).value, (r.bei as any).completed, (r.bei as any).due], [bc.bei, bc.metrics.completed_tasks, bc.metrics.baseline_due_tasks]);
  assert.equal((r.duration_weighted_percent_complete as any).value, da.delay_summary.schedule_performance_index);
  assert.equal(golden.delay_analysis.status, 'fail');
  assert.equal(r.status, 'fail');
  assert.equal(DRIVER_MIN_DAYS, 1);
});

test('EXPECTED DIFFERENCES from the source on that fixture, each with its reason', () => {
  const r = run(B.delayed().db), d = byId(r.drivers), v = byId(r.variances), sv = Object.fromEntries(golden.variance.map((x: any) => [x.task_id, x]));
  // 1. T3: the source's fixture gives T3 no current start (variance null) and calls its delay a finish_delay; the clone schedules the project: T3 starts 31 Jan (baseline 26 Jan), 5 days late, same 10-day length
  assert.equal(sv.T3.start_variance_days, null);
  assert.deepEqual([v.T3.start_variance_days, v.T3.duration_variance_days], [5, 0]);
  assert.equal(golden.delay_analysis.data.delay_drivers[1].variance_type, 'finish_delay');
  assert.equal(d.T3.variance_type, 'start_delay');
  // 2. the critical path overlay: the source ran a CPM on each side (as planned T1 T2 T3, as built T1 T2 T3, newly none). The clone reads P6's stored float: the saved baseline of this fixture (build_baseline) carries no float, so what was
  //    critical in it cannot be told: not assessed, with the reason
  assert.equal(golden.as_planned_vs_built.data.critical_path_overlay.newly_critical.length, 0);
  assert.equal(r.critical_overlay.result, 'not_assessed');
  assert.match(r.notes.join(' '), /Critical overlay not assessed: the BL baseline carries no total float/i);
  assert.equal(r.overlay.length, 0);
  // with the baseline's float written as the scheduler would (0 on each activity): reference T1 T2 T3 critical, now T2 and T3 (T1 is finished: P6 keeps no float for finished work), nothing newly critical
  const b = B.delayed();
  const blId = rows(b.db, 'PROJECT').find((p) => p._baseline_of === b.projId)!.proj_id;
  for (const t of rows(b.db, 'TASK').filter((x) => x.proj_id === blId)) t.total_float_hr_cnt = '0';
  const o = run(b.db);
  assert.deepEqual(o.critical_overlay, { result: 'assessed', reference_critical_total: 3, current_critical_total: 2, newly_critical_total: 0, added_and_critical_total: 0, no_longer_critical_total: 0 });
  assert.deepEqual(o.overlay.map((x) => [x.id, x.critical_in_reference, x.critical_now]), [['T2', true, true], ['T3', true, true], ['T1', true, null]]);
  // 3. the source's status: asPlannedVsBuilt says warning (no class over 15 days), delayAnalysis fail (project slip over 0); the clone has one status, fail by either rule
  assert.equal(golden.as_planned_vs_built.status, 'warning');
  assert.equal(r.status, 'fail');
  // 4. not carried over: the methodology argument and name (it only picked which total is shown: both are shown), use_half_step (the AACE half-step is windows_analysis), the source's total_finish_variance_days (a sum of every
  //    activity's finish variance, ahead ones negative), worst_offenders (the list is sorted worst first), float_analysis, recommendations, processing_metadata, confidence and chain_confidence (constants 1.0), SPI(t) (Earned Schedule is in progress_curves)
  for (const k of ['methodology', 'use_half_step', 'total_finish_variance_days', 'worst_offenders', 'float_analysis', 'recommendations', 'processing_metadata', 'spi_t']) assert.equal(k in r, false, k);
  assert.equal(JSON.stringify(r).includes('half_step'), false, 'no method name the code does not perform');
  assert.equal((r as any).method, undefined, 'the methods and what is not assessed (concurrent delay) are in the tool description');
  // 5. the impacted milestone: the source says "(project finish)" when no milestone is reached; the clone says null (no milestone) and where the chain ends
  assert.deepEqual([r.chains[0].impacted_milestone, r.chains[0].ends_at], [null, 'T3']);
});

// ------------------------------------------------------------------------------------------------ scenarios

test('two critical drivers that overlap: each keeps its own type and own days, the party sums in full; the two totals side by side; no concurrency fact anywhere', () => {
  // A and B (15 days each, in parallel, baseline 10) then C (5): all critical, each 5 days late; the project finishes 5 days late
  const b = scenario([{ id: 'A', duration_days: 10 }, { id: 'B', duration_days: 10 }, { id: 'C', duration_days: 5, predecessors: ['A', 'B'] }], { A: 15, B: 15 }, [
    { op: 'add_code_type', name: 'Responsibility' }, { op: 'add_code_value', type: 'Responsibility', code: 'OWN', name: 'Owner' }, { op: 'add_code_value', type: 'Responsibility', code: 'CON', name: 'Contractor' },
    { op: 'assign_code', type: 'Responsibility', value: 'OWN', activity: 'A' }, { op: 'assign_code', type: 'Responsibility', value: 'CON', activity: 'B' }]);
  const r = run(b.db, { responsibilityCode: 'responsibility' });
  assert.deepEqual([r.totals.project_slip_working_days, r.totals.critical_drivers_delay_days], [5, 15], 'the slip is 5 days; the critical drivers delayed 15 days between them (A and B delay the same days)');
  assert.deepEqual(Object.keys(r.totals), ['project_slip_working_days', 'critical_drivers_delay_days', 'finished_drivers']);
  const d = byId(r.drivers);
  // no driver is reclassified: A and B keep their own type (their duration grew), C its own (it starts late)
  assert.deepEqual(r.drivers.map((x) => [x.id, x.delay_days, x.on_critical_path, x.variance_type]), [['A', 5, true, 'duration_overrun'], ['B', 5, true, 'duration_overrun'], ['C', 5, true, 'start_delay']]);
  assert.deepEqual([d.A.successors_reached, d.A.causal_score], [1, 1.333]);
  assert.deepEqual(r.chains.map((c) => [c.root, c.path]), [['A', ['A', 'C']], ['B', ['B', 'C']], ['C', ['C']]]);
  // the responsible party: A owner 5, B contractor 5, C no value 5, each in full; nothing is split
  const resp = r.responsibility as Extract<BaselineVarianceResult['responsibility'], { result: 'assessed' }>;
  assert.equal(resp.code_type, 'Responsibility');
  assert.deepEqual([...resp.parties].sort((x, y) => x.party.localeCompare(y.party)), [{ party: 'Contractor', drivers: 1, delay_days: 5 }, { party: 'no value', drivers: 1, delay_days: 5 }, { party: 'Owner', drivers: 1, delay_days: 5 }].sort((x, y) => x.party.localeCompare(y.party)));
  assert.equal(resp.parties.reduce((a, p) => a + p.delay_days, 0), 15, 'the parties together have every driver day, once, in full');
  assert.deepEqual(r.drivers.map((x) => x.responsible), ['Owner', 'Contractor', null]);
  assert.equal((r as any).method, undefined);

  // the facts that were removed are nowhere: not in a driver, a chain, the responsibility table, the totals, the answer, the method
  assert.equal(/concurrent_days|concurrent_with|of_which_concurrent|concurrent_overlaps|concurrent_delay/.test(JSON.stringify(r)), false);
});

test('one delay passed down a chain is not concurrent delay: X1 > X2 > X3 pushed 10 days by X1 shows each driver with its own days and nothing "concurrent"', () => {
  const b = scenario([{ id: 'X1', duration_days: 10 }, { id: 'X2', duration_days: 10, predecessors: ['X1'] }, { id: 'X3', duration_days: 10, predecessors: ['X2'] }], { X1: 20 });
  const r = run(b.db);
  assert.deepEqual(r.drivers.map((x) => [x.id, x.delay_days, x.on_critical_path]), [['X1', 10, true], ['X2', 10, true], ['X3', 10, true]]);
  assert.deepEqual([r.totals.project_slip_working_days, r.totals.critical_drivers_delay_days], [10, 30]);
  assert.equal(/concurren/.test(JSON.stringify({ ...r, method: [] })), false);
});

test('newly critical: a branch that had float in the baseline and is critical now (and the one that stopped being critical)', () => {
  // baseline: A 10 days (critical), B 5 days (5 days of float), C 5 after both. Now B is 12 days: B critical, A 2 days of float
  const b = scenario([{ id: 'A', duration_days: 10 }, { id: 'B', duration_days: 5 }, { id: 'C', duration_days: 5, predecessors: ['A', 'B'] }], { B: 12 });
  const r = run(b.db);
  assert.deepEqual(r.critical_overlay, { result: 'assessed', reference_critical_total: 2, current_critical_total: 2, newly_critical_total: 1, added_and_critical_total: 0, no_longer_critical_total: 1 });
  const o = byId(r.overlay);
  assert.deepEqual([o.B.critical_in_reference, o.B.critical_now, o.B.newly_critical], [false, true, true]);
  assert.deepEqual([o.A.critical_in_reference, o.A.critical_now, o.A.no_longer_critical], [true, false, true]);
  assert.equal(r.overlay[0].id, 'B', 'newly critical first');
  assert.deepEqual(r.drivers.map((x) => [x.id, x.delay_days, x.on_critical_path]), [['B', 7, true], ['C', 2, true]]);
  assert.equal((r.critical_overlay as any).newly_critical_total, 1);
  // a driver below one working day is not a driver; ahead of plan is a class of its own
  const e = scenario([{ id: 'A', duration_days: 10 }, { id: 'B', duration_days: 10 }], { B: 8 });
  const re = run(e.db);
  assert.deepEqual([re.slip_classes.ahead, re.slip_classes.on_time], [1, 1]);
  assert.equal(re.drivers_total, 0);
  assert.equal(re.status, 'pass');
  assert.equal(re.project_slip.result === 'assessed' ? (re.project_slip as any).working_days : null, 0);
});

test('each slip class, on the working days of the finish variance', () => {
  const lens = { A: 10, B: 10, C: 10, D: 10, E: 10, F: 10 };
  const b = scenario(Object.entries(lens).map(([id, duration_days]) => ({ id, duration_days })), { A: 5, B: 10, C: 13, D: 20, E: 35, F: 55 });
  const r = run(b.db), v = byId(r.variances);
  assert.deepEqual(Object.entries(v).map(([id, x]) => [id, x.finish_variance_days, x.slip_class]), [['A', -5, 'ahead'], ['B', 0, 'on_time'], ['C', 3, 'minor_slip'], ['D', 10, 'moderate_slip'], ['E', 25, 'major_slip'], ['F', 45, 'severe_slip']].sort((x, y) => (v[y[0] as string].finish_variance_days! - v[x[0] as string].finish_variance_days!)).map((x) => [x[0], x[1], x[2]]) as any);
  assert.deepEqual(r.slip_classes, { ahead: 1, on_time: 1, minor_slip: 1, moderate_slip: 1, major_slip: 1, severe_slip: 1 });
  assert.equal(r.status, 'fail');
});

test('BEI against another schedule counts completed tasks only among those the other schedule holds (not every completed task of the open project)', () => {
  // the open project has 10 tasks, T1 - T6 complete by the data date (20 Jan); the schedule as planned holds T1 - T4 only, all due by then (finish 7 Jan): 4 due, and of them 4 completed. Counting every completed task (6) against the 4 due read 1.5.
  const ids = Array.from({ length: 10 }, (_, i) => `T${i + 1}`);
  const cur = B.project('CUR', ids.map((id) => ({ id, duration_days: 2 })), { start: '2026-01-05', dataDate: '2026-01-20', schedule: false, ops: ids.slice(0, 6).map((id) => ({ op: 'update_activity', id, actual_start: '2026-01-05 00:00', actual_finish: '2026-01-07 00:00' })) });
  assert.ok(scheduleProjects(cur.db, [cur.projId], { dataDate: parseP6Date('2026-01-20 00:00')! }).ok);
  const plan = B.project('PLAN', ids.slice(0, 4).map((id) => ({ id, duration_days: 2 })), { start: '2026-01-05' });
  const r = run(cur.db, { asPlanned: { name: 'PLAN', db: plan.db, projId: plan.projId } });
  assert.deepEqual(r.bei, { result: 'assessed', value: 1, completed: 4, due: 4 });
  // one of the four not done: 3 of 4 (the two completed tasks the other schedule does not hold are not counted)
  const t4 = rows(cur.db, 'TASK').find((t) => t.task_code === 'T4')!;
  t4.act_end_date = ''; t4.status_code = 'TK_Active'; t4.remain_drtn_hr_cnt = '24';
  assert.deepEqual(run(cur.db, { asPlanned: { name: 'PLAN', db: plan.db, projId: plan.projId } }).bei, { result: 'assessed', value: 0.75, completed: 3, due: 4 });
});

test('dcma_14\'s BEI does not change: with a baseline saved from the same project every activity has its counterpart, so completed = every completed task (Tower-A, the one sample with a baseline: 1 of 2)', () => {
  const ids = ['T1', 'T2', 'T3', 'T4', 'T5'];
  const b = B.project('BE', ids.map((id) => ({ id, duration_days: 2 })), { start: '2026-01-05', dataDate: '2026-01-20', schedule: false });
  assert.ok(applyOps(b.db, [{ op: 'save_baseline', name: 'BL', assign_as: 'project' }, ...ids.slice(0, 3).map((id) => ({ op: 'update_activity', id, actual_start: '2026-01-05 00:00', actual_finish: '2026-01-07 00:00' }))], { calendarDays: true }).ok);
  assert.ok(scheduleProjects(b.db, [b.projId], { dataDate: parseP6Date('2026-01-20 00:00')! }).ok);
  const bei = dcma14(b.db, {}).checks.find((c) => c.id === 'bei')!;
  assert.deepEqual([bei.numerator, bei.denominator, bei.metric], [3, 5, 0.6], 'all 5 are due by 20 Jan, 3 completed: the count of every completed task');
  assert.deepEqual(run(b.db).bei, { result: 'assessed', value: 0.6, completed: 3, due: 5 }, 'baseline_variance says the same');
  const tw = dcma14(sample('Tower-A.xer').db, {}).checks.find((c) => c.id === 'bei')!;
  assert.deepEqual([tw.numerator, tw.denominator, tw.metric], [1, 2, 0.5]);
});

test('a baseline, one activity added after it and completed: dcma_14 and check_schedule keep their BEI (every completed task counts); only as_planned counts completed among matched activities', () => {
  // T1 - T4 are in the baseline (finish 7 Jan, due by 20 Jan); T1 and T2 are completed, and N is ADDED after the baseline and completed too.
  // By hand, as at dd15694: completed = every completed task = T1, T2, N = 3; due = the 4 baselined tasks; BEI = 3 / 4 = 0.75 (check_schedule, which counts a task finishing ON the date as not due, has the same 4 due: 0.75).
  const b = B.project('BA', ['T1', 'T2', 'T3', 'T4'].map((id) => ({ id, duration_days: 2 })), { start: '2026-01-05', dataDate: '2026-01-20', schedule: false });
  assert.ok(applyOps(b.db, [{ op: 'save_baseline', name: 'BL', assign_as: 'project' }, { op: 'add_activity', id: 'N', name: 'N', duration_days: 2, calendar: 'D7' },
    ...['T1', 'T2', 'N'].map((id) => ({ op: 'update_activity', id, actual_start: '2026-01-05 00:00', actual_finish: '2026-01-07 00:00' }))], { calendarDays: true }).ok);
  assert.ok(scheduleProjects(b.db, [b.projId], { dataDate: parseP6Date('2026-01-20 00:00')! }).ok);
  const d = dcma14(b.db, {}).checks.find((c) => c.id === 'bei')!;
  assert.deepEqual([d.numerator, d.denominator, d.metric], [3, 4, 0.75]);
  const cs = checkSchedule(b.db, {}).checks.find((c) => c.id === 'bei')!;
  assert.deepEqual([cs.numerator, cs.denominator, cs.metric], [3, 4, 0.75]);
  assert.deepEqual(run(b.db).bei, { result: 'assessed', value: 0.75, completed: 3, due: 4 });
});

test('the slip class is judged on the exact variance: an activity one minute behind its baseline shows 0 days and is a minor slip, not on time (one variance function, exact)', () => {
  const b = scenario([{ id: 'A', duration_days: 10 }, { id: 'B', duration_days: 10 }], {});
  const T = rows(b.db, 'TASK').find((t) => t.proj_id === b.projId && t.task_code === 'A')!;
  const later = formatP6Date(parseP6Date(T.reend_date || T.early_end_date)! + 1); // 1 minute later than the baseline's finish
  T.early_end_date = later; T.reend_date = later;
  const r = run(b.db), v = byId(r.variances);
  assert.deepEqual([v.A.finish_variance_days, v.A.slip_class, v.B.finish_variance_days, v.B.slip_class], [0, 'minor_slip', 0, 'on_time']);
  assert.equal(r.drivers_total, 0, 'a driver needs a working day');
  // the one function: the rows of the forensic helper are the rows baseline_variance lists, and schedule_index's drift averages the exact days
  const s = makeScope(b.db, { calendarDays: true }), pairs = F.baselinePairs(s);
  assert.ok(pairs.result === 'assessed');
  if (pairs.result === 'assessed') {
    assert.deepEqual(F.varianceRows(s, pairs).map((x) => [x.id, x.finish_variance_days, x.slip_class]), [['A', 0, 'minor_slip'], ['B', 0, 'on_time']]);
    const d = F.varianceDetail(s, pairs).find((x) => x.task.task_code === 'A')!;
    assert.equal(d.exact.finish, 1, 'exact working minutes');
    assert.equal(d.exact.day, 24 * 60);
  }
});

// ------------------------------------------------------------------------------------------------ real files

test('Tower-A (its baseline is stored in the file): counted from the rows', () => {
  // rows: the saved baseline TOWER-A-BL1 (project 11) holds A1010 (2 Mar 08:00 - 6 Mar 17:00, 40 h, Site 5-Day 8 h/day) and A1020 (7 Mar 07:00 - 14 Mar 18:00, 80 h, Night Shift 7-Day 10 h/day) with float 0, not assigned as the project baseline;
  // the project holds A1010 (complete: actual 2 - 6 Mar 17:00), A1020 (started 7 Mar 07:00, early finish 16 Mar 18:00, 40 %), A1030 and M1000 (finish 1 Apr 17:00), float 0 on all
  const tw = sample('Tower-A.xer'), r = run(tw.db);
  assert.equal(r.compared_with.name, 'TOWER-A-BL1');
  assert.match(r.compared_with.how, /the only baseline saved from this project/);
  assert.deepEqual(r.activities, { compared: 2, not_in_reference: 2, without_dates: 0 }, 'A1030 and M1000 are not in the baseline');
  const v = byId(r.variances);
  assert.deepEqual([v.A1010.finish_variance_days, v.A1010.slip_class], [0, 'on_time']);
  assert.deepEqual([v.A1020.start_variance_days, v.A1020.finish_variance_days, v.A1020.slip_class], [0, 2, 'minor_slip'], '14 -> 16 March on the 7-day calendar: two days');
  assert.deepEqual([v.A1030.finish_variance_days, v.A1030.slip_class], [null, null]);
  assert.deepEqual(r.slip_classes, { ahead: 0, on_time: 1, minor_slip: 1, moderate_slip: 0, major_slip: 0, severe_slip: 0 });
  // project slip: the latest current finish 1 Apr 17:00 less the baseline's latest finish 14 Mar 18:00: Mon 16 Mar - Wed 1 Apr on the 8-hour Mon-Fri project calendar = 5 + 5 + 3 = 13 working days
  assert.deepEqual(r.project_slip, { result: 'assessed', current_finish: '2026-04-01 17:00', reference_finish: '2026-03-14 18:00', working_days: 13 });
  // the one driver: A1020 (critical by its float 0; 2 days; duration longer by 2 days; the one activity after it, A1030, then M1000: 2 successors reached)
  assert.deepEqual(r.drivers.map((x) => [x.id, x.delay_days, x.on_critical_path, x.variance_type, x.successors_reached, x.causal_score]), [['A1020', 2, true, 'duration_overrun', 2, 1.5]], '(1 + 2 / 4 activities) x 1');
  assert.equal(r.totals.critical_drivers_delay_days, 2);
  assert.deepEqual(r.chains.map((c) => [c.root, c.path, c.impacted_milestone]), [['A1020', ['A1020', 'A1030', 'M1000'], 'M1000']]);
  assert.equal(r.chains[0].path_total, 3);
  // critical overlay: baseline A1010, A1020 critical (float 0, not complete in the baseline); now A1020, A1030, M1000 (A1010 is finished); none newly critical among the activities the baseline has
  assert.deepEqual(r.critical_overlay, { result: 'assessed', reference_critical_total: 2, current_critical_total: 3, newly_critical_total: 0, added_and_critical_total: 2, no_longer_critical_total: 0 });
  // A1030 and M1000 were added since the baseline and are critical now: not "newly critical" (they have no counterpart), listed apart
  assert.deepEqual(r.overlay.filter((x) => x.added_and_critical).map((x) => [x.id, x.critical_in_reference, x.critical_now, x.newly_critical]), [['A1030', null, true, false], ['M1000', null, true, false]]);
  assert.equal((r.critical_overlay as any).newly_critical_total, 0); assert.equal((r.critical_overlay as any).added_and_critical_total, 2);
  // BEI: baselined to finish by the data date (1 Apr 08:00): A1010 (6 Mar) and A1020 (14 Mar) = 2 due, 1 completed
  assert.deepEqual(r.bei, { result: 'assessed', value: 0.5, completed: 1, due: 2 });
  // duration-weighted % complete: A1010 5 d x 100 % + A1020 8 d x 40 % + A1030 10 d (its own 80 h: not in the baseline) x 0 + M1000 0 = 8.2 of 23 days
  assert.deepEqual(r.duration_weighted_percent_complete, { result: 'assessed', value: 0.357, earned_days: 8.2, planned_days: 23 });
  assert.equal(r.status, 'fail');
  // the responsible party: not given
  assert.equal(r.responsibility.result, 'not_assessed');

  // given: the activity code type Phase; A1020 carries the value Enabling (TASKACTV: task 1001, type 50, value 51 "Enabling")
  const p = run(tw.db, { responsibilityCode: 'phase' });
  assert.deepEqual((p.responsibility as any).parties, [{ party: 'Enabling', drivers: 1, delay_days: 2 }]);
  assert.equal('concurrent_days_split_equally' in (p.responsibility as object), false, 'no split of any kind');
  assert.equal(p.drivers[0].responsible, 'Enabling');
});

test('as_planned: another schedule (Tower-A as planned, Tower-A_edited as it stands), matched by Activity ID', () => {
  // as planned (Tower-A rows): A1010 actual finish 6 Mar 17:00; A1020 started 7 Mar 07:00, early finish 16 Mar 18:00; A1030 early finish 1 Apr 17:00; M1000 1 Apr 17:00
  // as it stands (Tower-A_edited rows): A1010 6 Mar 08:00; A1020 started 7 Mar 08:00, finish 6 Apr 08:00; A1030 1 Apr 08:00; M1000 2 Apr 08:00
  const asPlanned = sample('Tower-A.xer'), cur = sample('Tower-A_edited.xer');
  const r = run(cur.db, { asPlanned: { name: 'Tower-A', db: asPlanned.db, projId: asPlanned.projId } });
  assert.deepEqual([r.compared_with.kind, r.compared_with.name], ['as_planned', 'Tower-A']);
  assert.deepEqual(r.activities, { compared: 4, not_in_reference: 0, without_dates: 0 });
  const v = byId(r.variances);
  assert.deepEqual([v.A1010.finish_variance_days, v.A1010.slip_class], [-1, 'ahead'], 'Friday 17:00 -> 08:00 on the 8-hour calendar: one day');
  assert.deepEqual([v.A1020.finish_variance_days, v.A1020.slip_class], [20, 'major_slip'], '16 March 18:00 -> 6 April 08:00 on the 7-day calendar: 17 March .. 5 April, 20 days');
  assert.deepEqual([v.A1030.finish_variance_days, v.A1030.slip_class], [-1, 'ahead']);
  assert.deepEqual([v.M1000.finish_variance_days, v.M1000.slip_class], [0, 'on_time'], '17:00 -> 08:00 next morning holds no working time');
  assert.deepEqual(r.slip_classes, { ahead: 2, on_time: 1, minor_slip: 0, moderate_slip: 0, major_slip: 1, severe_slip: 0 });
  // project slip: latest finish 6 Apr 08:00 (A1020) less 1 Apr 17:00: Thu 2 and Fri 3 April = 2 working days
  assert.deepEqual(r.project_slip, { result: 'assessed', current_finish: '2026-04-06 08:00', reference_finish: '2026-04-01 17:00', working_days: 2 });
  assert.deepEqual(r.drivers.map((x) => [x.id, x.delay_days, x.variance_type]), [['A1020', 20, 'duration_overrun']]);
  assert.deepEqual(r.bei, { result: 'assessed', value: 0.5, completed: 1, due: 2 }, 'as planned, A1010 and A1020 were due by 1 April 08:00; A1010 is complete');
  assert.equal(r.critical_overlay.result, 'assessed');
  assert.equal(r.compared_with.how, 'a schedule of its own, matched by Activity ID, then by a unique name');
  // a schedule with several projects cannot be compared with one other schedule without saying which
  const two = structuredClone(cur.db);
  const extra = { ...rows(two, 'PROJECT').find((p) => !p._baseline_of)!, proj_id: '99', proj_short_name: 'OTHER' };
  two.tables.PROJECT.rows.push(extra);
  const x = baselineVariance(two, { asPlanned: { name: 'Tower-A', db: asPlanned.db, projId: asPlanned.projId } });
  assert.ok('refused' in x);
  assert.match((x as any).message, /as_planned is one schedule and this file has 2 projects/);
});

// ------------------------------------------------------------------------------------------------ the tool

test('baseline_variance through the server: arguments, refusals in words, responsibility_code, as_planned by path and by handle', async () => {
  const { toolsList } = await import('../mcp/server.ts');
  const t = (toolsList() as any[]).find((x) => x.name === 'baseline_variance');
  assert.ok(t, 'listed');
  assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['handle', 'export', 'export_name', 'project', 'baseline', 'as_planned', 'responsibility_code', 'caller', 'async']);
  assert.deepEqual(t._meta['whiq/files'], { read: ['as_planned.path'], opens: false });
  assert.match(t.description, /Concurrent delay is not assessed here: windows_analysis apportions delay between causes/);
  assert.equal(/concurrent_days|concurrent_with|of_which_concurrent/.test(t.description), false);
  assert.equal(JSON.stringify(t.inputSchema).includes('methodology'), false);
  // no baseline and no other schedule: refused, with the two ways
  const trial = await openSample('129 trial.xer');
  const none = await call('baseline_variance', { handle: trial });
  assert.equal(none.err, true);
  assert.equal(none.d.error.code, 'bad_input');
  // (129 trial names a project baseline that the file does not hold: said as that, not as "none assigned")
  assert.match(none.d.error.message, /^The project baseline of R29BT-modefied-10 is not in this file \(the file was exported without it\), and no other schedule was given\.$/);
  assert.match(JSON.stringify(none.d.error), /assign a baseline to the project .*or pass as_planned, another schedule as \{handle\} or \{path\}/);
  const bad = await call('baseline_variance', { handle: trial, baseline: 'bl2' });
  assert.equal(bad.err, true);
  assert.match(bad.d.error.message, /No baseline "bl2" for this project\./);
  const both = await call('baseline_variance', { handle: trial, baseline: 'project', as_planned: { path: sampleCopy('130 TRIAL.xer') } });
  assert.match(both.d.error.message, /Pass baseline or as_planned, not both/);
  for (const shape of [{}, { handle: 'a', path: 'b' }, 'x', []]) assert.match((await call('baseline_variance', { handle: trial, as_planned: shape })).d.error.message, /as_planned must be \{"handle": \.\.\.\} or \{"path": \.\.\.\}/);
  // responsibility_code: unknown -> the file's code types named; given -> the table
  const tw = await openSample('Tower-A.xer');
  const unk = await call('baseline_variance', { handle: tw, responsibility_code: 'Responsibilty' });
  assert.equal(unk.err, true);
  assert.match(unk.d.error.message, /No activity code type "Responsibilty" in this file\./);
  assert.match(JSON.stringify(unk.d.error), /The file's activity code types: Phase\./);
  const ok = await call('baseline_variance', { handle: tw, responsibility_code: 'Phase', bogus: 1 });
  assert.equal(ok.err, false, JSON.stringify(ok.d).slice(0, 300));
  assert.match(ok.d.notes.join(' '), /baseline_variance has no argument "bogus"/);
  assert.deepEqual(ok.d.responsibility.parties, [{ party: 'Enabling', drivers: 1, delay_days: 2 }]);
  assert.deepEqual(ok.d.exported.files.map((f: any) => f.path.replace(/^.*baseline_variance/, '')).sort(), ['-chains.csv', '-critical_overlay.csv', '-drivers.csv', '-variances.csv', '.json']);
  // as_planned by path and by handle give the same answer
  const cur = await openSample('Tower-A_edited.xer');
  const byPath = await call('baseline_variance', { handle: cur, as_planned: { path: sampleCopy('Tower-A.xer') } });
  assert.equal(byPath.err, false, JSON.stringify(byPath.d).slice(0, 300));
  const byHandle = await call('baseline_variance', { handle: cur, as_planned: { handle: tw } });
  assert.equal(byHandle.err, false, JSON.stringify(byHandle.d).slice(0, 300));
  for (const r of [byPath, byHandle]) { assert.deepEqual(r.d.slip_classes, { ahead: 2, on_time: 1, minor_slip: 0, moderate_slip: 0, major_slip: 0 + 1, severe_slip: 0 }); assert.equal(r.d.totals.project_slip_working_days, 2); }
});

test('the list rule on a real sample (31 buidings, 2,142 activities, against another real schedule as planned): 25 listed with the true totals, the whole lists in the result file', async () => {
  const h = await openSample('31 buidings.xer');
  const r = await call('baseline_variance', { handle: h, as_planned: { path: sampleCopy('baseline of jungle.xer') } });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  const db = readXerFile(sampleCopy('31 buidings.xer')).db, main = rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
  const acts = rows(db, 'TASK').filter((x) => x.proj_id === main && x.task_type !== 'TT_WBS');
  assert.equal(r.d.variances_total, acts.length, 'one variance row per activity that is not a WBS summary');
  assert.equal(r.d.variances.length, 25);
  assert.match(r.d.variances_note, new RegExp(`^25 of ${acts.length} shown; all ${acts.length} in .*baseline_variance-variances\\.csv\\.$`));
  const jungle = readXerFile(sampleCopy('baseline of jungle.xer')).db, jm = rows(jungle, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
  const codes = new Set(rows(jungle, 'TASK').filter((x) => x.proj_id === jm && x.task_type !== 'TT_WBS').map((x) => x.task_code));
  const matchedById = acts.filter((x) => codes.has(x.task_code)).length;
  const a = r.d.activities;
  assert.equal(a.compared + a.without_dates + a.not_in_reference, acts.length);
  assert.ok(a.compared + a.without_dates >= matchedById, 'every Activity ID in both is matched (a unique name matches more)');
  assert.equal(Object.values(r.d.slip_classes).reduce((x: number, y: any) => x + y, 0), a.compared, 'a class for every activity compared');
  assert.ok(r.d.drivers_total > 25, 'more drivers than the list holds');
  assert.equal(r.d.drivers.length, 25);
  assert.match(r.d.drivers_note, /^25 of \d+ shown; all \d+ in .*baseline_variance-drivers\.csv\.$/);
  const csv = (n: string) => r.d.exported.files.find((f: any) => f.path.endsWith(`-${n}.csv`));
  assert.equal(csv('variances').rows, acts.length);
  assert.equal(csv('drivers').rows, r.d.drivers_total);
  assert.equal(csv('chains').rows, r.d.chains_total);
  const whole = JSON.parse(readFileSync(r.d.exported.files.find((f: any) => f.path.endsWith('baseline_variance.json')).path, 'utf8'));
  assert.equal(whole.drivers.length, r.d.drivers_total);
  assert.equal(whole.variances.length, acts.length);
  // the listed variances are the worst first; the driver list is by delay, largest first
  const dd = r.d.drivers.map((x: any) => x.delay_days);
  assert.deepEqual(dd, [...dd].sort((x: number, y: number) => y - x));
  assert.ok(r.d.drivers.every((x: any) => x.delay_days >= 1));
  // the critical drivers' days beside the project slip: two figures, named for what they are
  assert.deepEqual(Object.keys(r.d.totals), ['project_slip_working_days', 'critical_drivers_delay_days', 'finished_drivers']);
});
