// planning_horizon (core/analysis/planningHorizon.ts, registered in mcp/forensics.ts): the readiness of the work starting in the next 30 / 60 / 90 days against the benchmark's own numbers (tests/fixtures/benchmark-golden.json: the
// horizon fixture, a purpose-made schedule with dates), every expected difference stated with its reason, each not-assessed path, calendar days for the windows and working days for float and drift, the list rule, and the real samples
// (numbers verified by hand or counted independently from the file's rows, in the comments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rows } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { parseP6Date } from '../core/dates.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { planningHorizon, statusOf, WEIGHTS, type HorizonResult } from '../core/analysis/planningHorizon.ts';
import * as B from './benchmark-fixtures.ts';
import { sampleCopy, testRoots } from './helpers.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
testRoots();
const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'benchmark-golden.json'), 'utf8'));
const at = (d: string) => parseP6Date(`${d} 00:00`)!;
const all = (r: HorizonResult) => r.bands.flatMap((b) => b.activities);
const byId = (r: HorizonResult) => Object.fromEntries(all(r).map((a) => [a.id, a]));
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const openSample = async (name: string) => { const o = await call('open_file', { path: sampleCopy(name), lenient: true }); assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300)); return o.d.handle as string; };
const src = golden.horizon.planning_horizon_status_2026_01_05.data;
const srcTasks: Record<string, any> = Object.fromEntries(src.bands.flatMap((b: any) => b.tasks).map((t: any) => [t.task_id, t]));

// ------------------------------------------------------------------------------------------------ against the source

test('the horizon fixture: the same windows, the same activities, the same five dimension scores and issues (approvals aside) as the source', () => {
  const r = planningHorizon(B.horizon().db, {});
  assert.equal(r.result, 'assessed');
  assert.equal(r.status_date, '2026-01-05 00:00');
  const mine = byId(r);
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(srcTasks).sort(), 'P0 (complete) and K (100 days out) are in no window, in both');
  for (const [id, s] of Object.entries(srcTasks)) {
    const a = mine[id];
    assert.equal(a.days_until_start, s.days_until_start, `${id} days`);
    assert.equal(a.band, { '30-day': '0-30 days', '60-day': '31-60 days', '90-day': '61-90 days' }[src.bands.find((b: any) => b.tasks.some((t: any) => t.task_id === id)).band_name as string], `${id} window`);
    for (const d of ['logic', 'resources', 'float', 'forecast_stability'] as const) assert.equal(a.dimensions[d]!.score, s.prerequisites[d].score, `${id} ${d}`);
    assert.deepEqual(a.issues, [...s.prerequisites.logic.issues, ...s.prerequisites.resources.issues, ...s.prerequisites.float.issues, ...s.prerequisites.forecast_stability.issues], `${id} issues`);
    assert.equal(a.on_critical_path, s.on_critical_path, `${id} critical`);
    assert.equal(a.dimensions.approvals, undefined);
  }
  // window by window: counts, and the mean of every dimension but approvals
  src.bands.forEach((sb: any, i: number) => {
    const b = r.bands[i];
    assert.equal(b.activities_total, sb.tasks_in_band, sb.band_name);
    for (const d of ['logic', 'resources', 'float', 'forecast_stability'] as const) assert.equal(b.breakdown[d], sb.readiness_breakdown[d], `${sb.band_name} ${d}`);
    assert.equal((b.breakdown as Record<string, unknown>).approvals, undefined);
  });
  // the systemic issues (the same dimensions, the same activities) and the trend
  assert.deepEqual(r.systemic_issues.map((x) => x.issue), src.cross_band_insights.systemic_issues.map((x: any) => x.issue));
  for (const x of r.systemic_issues) assert.deepEqual(x.activities.map((a) => a.id).sort(), src.cross_band_insights.systemic_issues.find((y: any) => y.issue === x.issue).affected_tasks.sort(), x.issue);
  assert.equal(r.summary.readiness_trend, src.cross_band_insights.readiness_trend);
  // the risks, in the same order and with the same first issue
  src.bands.forEach((sb: any, i: number) => {
    assert.deepEqual(r.bands[i].risks.map((x) => x.id), sb.top_risks.map((x: any) => x.task_id), `${sb.band_name} risks`);
    assert.deepEqual(r.bands[i].risks.map((x) => x.risk), sb.top_risks.map((x: any) => x.risk_description));
    assert.deepEqual(r.bands[i].risks.map((x) => x.impact), sb.top_risks.map((x: any) => x.impact));
  });
});

test('EXPECTED DIFFERENCE: approvals are not assessed, so an activity\'s readiness is re-weighted over the other four dimensions (the source gives an activity with no approval requirement a free 100 x 0.20)', () => {
  const r = planningHorizon(B.horizon().db, {});
  for (const [id, s] of Object.entries(srcTasks)) {
    const a = byId(r)[id];
    assert.equal(s.prerequisites.approvals.score, 100, `${id}: the source's approvals`);
    // clone = (source - 0.20 x 100) / 0.80, to the source's rounding
    assert.ok(Math.abs(a.readiness_score - (s.readiness_score - 20) / 0.8) <= 0.1, `${id}: ${a.readiness_score} vs (${s.readiness_score} - 20) / 0.8`);
  }
  // by hand, F (30-day window): logic 70 (D is not complete), resources 0, float 3 / 5 x 100 = 60, stability 100 - (6 - 3) x 5 = 85: (0.25 x 70 + 0.30 x 0 + 0.10 x 60 + 0.15 x 85) / 0.80 = 36.25 / 0.80 = 45.3 (the source: 36.25 + 20 = 56.3)
  const f = byId(r).F;
  assert.equal(f.readiness_score, 45.3);
  assert.equal(srcTasks.F.readiness_score, 56.3);
  assert.equal(f.status, 'not_ready');
  assert.equal(srcTasks.F.readiness_status, 'at_risk');
  // A, the best activity: (0.25 x 100 + 0.30 x 100 + 0.10 x 0 + 0.15 x 100) / 0.80 = 70 / 0.80 = 87.5: mostly ready (the source: 90, ready)
  assert.equal(byId(r).A.readiness_score, 87.5);
  assert.equal(byId(r).A.status, 'mostly_ready');
  assert.equal(srcTasks.A.readiness_status, 'ready');
  // the file-wide reason, with the weight that is spread
  assert.deepEqual(Object.keys(r.bands[0].breakdown), ['logic', 'resources', 'float', 'forecast_stability']);
  assert.deepEqual(r.notes, []);
  // the window's score is the mean of its activities: 30-day (45.3, 46.6, 78.1, 78.1, 78.1, 87.5) = 69.0 (the source's 75.2)
  assert.equal(r.bands[0].readiness_score, 69);
  assert.equal(src.bands[0].band_readiness_score, 75.2);
  assert.equal(r.bands[0].status, 'at_risk');
  assert.equal(r.summary.activities_in_horizon, 10);
  assert.equal(src.analysis_summary.total_tasks_in_horizon, 10);
});

test('EXPECTED DIFFERENCE: an empty window has no score (the source gives it 100), and a horizon with nothing in it is not assessed (the source: 100)', () => {
  // cleanChain from 5 Jan: all four activities start within 23 days, so the 31-60 and 61-90 windows are empty
  const r = planningHorizon(B.cleanChain().db, {});
  assert.equal(r.result, 'assessed');
  for (const b of r.bands.slice(1)) { assert.equal(b.result, 'not_assessed'); assert.equal(b.readiness_score, null); assert.equal(b.status, null); assert.equal(b.activities_total, 0); assert.deepEqual(b.activities, []); assert.deepEqual(b.risks, []); }
  const empty = golden.withFloat.planning_horizon.data.bands[0];
  assert.equal(empty.tasks_in_band, 0);
  assert.equal(empty.band_readiness_score, 100, 'the source: an empty window scores 100');
  // nothing in any window: the whole analysis is not assessed, with the reason; the source: overall 100
  const none = planningHorizon(B.cleanChain().db, { statusDate: at('2025-06-01') });
  assert.equal(none.result, 'not_assessed');
  assert.equal(none.notes.length, 2);
  assert.equal(none.summary.readiness_score, null);
  assert.equal(none.summary.status, null);
  assert.equal(golden.withFloat.planning_horizon.data.analysis_summary.overall_readiness_score, 100);
  // the trend needs two windows with a score
  assert.equal(r.summary.readiness_trend, null);
});

test('the windows are fixed: 0-30, 31-60 and 61-90 calendar days from the anchor, ends included; the activity\'s own start (forecast, else planned) decides', () => {
  // one activity per day offset around each edge, on the 7-day calendar: A starts 5 Jan (day 0)... built as parallel activities with a start-on-or-after constraint
  const offs = [0, 30, 31, 60, 61, 90, 91];
  const tasks = offs.map((n, i) => ({ id: `T${i}`, duration_days: 2, constraint: { type: 'start_on_or_after', date: `${new Date(Date.UTC(2026, 0, 5 + n)).toISOString().slice(0, 10)} 00:00` } }));
  const r = planningHorizon(B.project('EDGE', tasks).db, {});
  assert.deepEqual(all(r).map((a) => [a.id, a.days_until_start, a.band]).sort(), [['T0', 0, '0-30 days'], ['T1', 30, '0-30 days'], ['T2', 31, '31-60 days'], ['T3', 60, '31-60 days'], ['T4', 61, '61-90 days'], ['T5', 90, '61-90 days']]);
  assert.deepEqual(r.bands.map((b) => b.window), [{ from_days: 0, to_days: 30 }, { from_days: 31, to_days: 60 }, { from_days: 61, to_days: 90 }]);
  // an activity that starts before the anchor, or is started or finished, is in no window
  const p = planningHorizon(B.horizon().db, { statusDate: at('2026-01-16') });
  assert.ok(!('A' in byId(p)) && !('B' in byId(p)) && !('C' in byId(p)), 'A, B and C start before 16 Jan');
  assert.equal(byId(p).D.days_until_start, 9);
});

test('calendar days for the windows, working days for float and drift (Monday to Friday, 8 hours)', () => {
  // WK starts Monday 2 March 2026. A: 5 days from the start (forecast finish Fri 6 Mar 17:00), planned finish Fri 27 Feb 17:00 = a week earlier: 7 calendar days, 5 working days.
  // B: starts Thursday 2 April = 31 calendar days after the anchor (22 working days): the 31-60 window, not the first.
  const db = { tables: {} } as B.Built['db'];
  const ok = applyOps(db, [{ op: 'add_project', id: 'WK', start: '2026-03-02' }, { op: 'add_activity', id: 'A', name: 'A', duration_days: 5 },
    { op: 'add_activity', id: 'B', name: 'B', duration_days: 3, constraint: { type: 'start_on_or_after', date: '2026-04-02 08:00' } }], { calendarDays: true });
  assert.ok(ok.ok, JSON.stringify(ok.error));
  const pid = rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
  assert.ok(scheduleProjects(db, [pid], { dataDate: at('2026-03-02') }).ok);
  // the baseline (assigned to the project) has A finishing Fri 27 Feb 17:00, a week before its forecast finish
  const bl = applyOps(db, [{ op: 'build_baseline', name: 'BL', assign_as: 'project', activities: [{ activity: 'A', start: '2026-02-23 08:00', finish: '2026-02-27 17:00', duration_days: 5 }, { activity: 'B', start: '2026-04-02 08:00', finish: '2026-04-06 17:00', duration_days: 3 }] }], { calendarDays: true });
  assert.ok(bl.ok, JSON.stringify(bl.error));
  const r = planningHorizon(db, {});
  const m = byId(r);
  assert.equal(m.A.band, '0-30 days');
  assert.equal(m.B.days_until_start, 31, 'calendar days');
  assert.equal(m.B.band, '31-60 days');
  // drift (against the baseline finish): Fri 27 Feb 17:00 to Fri 6 Mar 17:00 = 5 working days: 100 - (5 - 3) x 5 = 90 (7 calendar days would give 80)
  assert.equal(m.A.dimensions.forecast_stability!.score, 90);
  assert.deepEqual(m.A.dimensions.forecast_stability!.issues, ['Forecast drift 5d']);
  // float in working days of the activity's 8-hour calendar: a stored float of 24 hours is 3 working days (60), not 1
  rows(db, 'TASK').find((t) => t.task_code === 'A')!.total_float_hr_cnt = '24';
  const m2 = byId(planningHorizon(db, {}));
  assert.equal(m2.A.dimensions.float!.score, 60);
  assert.deepEqual(m2.A.dimensions.float!.issues, ['Low float (3d < 5d)']);
});

// ------------------------------------------------------------------------------------------------ not assessed

test('not assessed: no data date (no fall back to the earliest start or to 2000-01-01), no resources in the file, a milestone, no float, no planned finish, a loop', () => {
  // the sample with no data date: the source would anchor at the earliest start; the clone has no anchor and says so; with a status_date it works
  const aurora = readXerFile(sampleCopy('Aurora_Tower_Baseline.xer')).db;
  const none = planningHorizon(aurora, {});
  assert.equal(none.result, 'not_assessed');
  assert.deepEqual(none.notes, ['Not assessed: aurora_tower has no data date; pass status_date.']);
  assert.equal(none.status_date, null);
  assert.deepEqual(none.bands, []);
  assert.deepEqual(none.summary.projects_without_data_date, ['aurora_tower']);
  // no resources anywhere in the file: the resources dimension is not assessed for any activity (not 0 for all)
  const r = planningHorizon(B.cleanChain().db, {});
  // and no baseline: forecast stability has nothing to be compared with (the planned dates equal the early dates after a calculation, so they cannot stand in)
  assert.deepEqual(r.notes.length, 2);
  assert.match(r.notes.join(' '), /Resources not assessed: the file has no resource assignments\./);
  assert.match(r.notes.join(' '), /Forecast stability not assessed: no baseline is assigned to .+; assign one with edit assign_baseline, or pass baseline\./);
  // T1 by hand: logic 60 (no predecessor), float 0 (critical); resources and stability not assessed: (0.25 x 60 + 0.10 x 0) / (0.25 + 0.10) = 15 / 0.35 = 42.9
  assert.equal(byId(r).T1.readiness_score, 42.9);
  assert.equal(byId(r).T1.dimensions.resources, undefined);
  assert.equal(byId(r).T1.dimensions.forecast_stability, undefined);
  // a milestone in a file that has resources: nothing to resource (re-weighted over logic and float; the file has no baseline, so no stability): M: logic 70 (A not complete), float 0: (17.5 + 0) / 0.35 = 50
  const b = B.project('MS', [{ id: 'A', duration_days: 5, resources: ['R'] }, { id: 'M', duration_days: 0, predecessors: ['A'], task_type: 'milestone' }], { resources: [{ id: 'R', max_units_per_day: 1 }] });
  const m = byId(planningHorizon(b.db, {}));
  assert.deepEqual(m.M.not_assessed, ['resources']);
  assert.equal(m.M.readiness_score, 50);
  assert.equal(m.A.dimensions.resources!.score, 100);
  // no stored float: that dimension is not assessed for that activity alone
  const x = B.cleanChain();
  const t2 = rows(x.db, 'TASK').find((t) => t.task_code === 'T2')!;
  t2.total_float_hr_cnt = '';
  const xr = byId(planningHorizon(x.db, {}));
  assert.deepEqual(xr.T2.not_assessed, ['float']);
  // T2: logic 70 (T1 not complete) only: 70
  assert.equal(xr.T2.readiness_score, 70);
  assert.equal(xr.T1.dimensions.float!.score, 0, 'the others are unaffected');
  // a baseline in the file but an activity that is not in it (added since): forecast stability is not assessed for that activity alone, and its weight goes to the others
  const h = B.horizon();
  assert.ok(applyOps(h.db, [{ op: 'add_activity', id: 'NEW', name: 'NEW', duration_days: 3, calendar: 'D7' }, { op: 'add_relationship', pred: 'A', succ: 'NEW', type: 'FS' }], { calendarDays: true }).ok);
  assert.ok(scheduleProjects(h.db, [h.projId], { dataDate: at('2026-01-05') }).ok);
  const hr = byId(planningHorizon(h.db, {}));
  assert.deepEqual(hr.NEW.not_assessed.filter((n) => n === 'forecast_stability'), ['forecast_stability']);
  assert.equal(hr.NEW.dimensions.forecast_stability, undefined);
  assert.ok(hr.C.dimensions.forecast_stability!.score < 100, 'an activity that is in the baseline is assessed');
  // the dimension is not assessed file-wide only when no baseline exists; the named baseline that is not there is refused by the tool (below)
  assert.equal(planningHorizon(h.db, {}).notes.some((n) => /^Forecast stability not assessed: /.test(n)), false);
  // a loop: P6's float is not valid; the loop is named and the float dimension is left out (the logic dimension still reads the links)
  const c = B.withCycle();
  for (const t of rows(c.db, 'TASK').filter((t) => t.proj_id === c.projId)) { t.early_start_date = '2026-01-10 00:00'; t.early_end_date = '2026-01-14 00:00'; t.target_end_date = '2026-01-14 00:00'; t.total_float_hr_cnt = '0'; }
  const l = planningHorizon(c.db, { statusDate: at('2026-01-05') });
  assert.equal(l.loops.length, 1);
  assert.deepEqual(l.loops[0].activities.slice().sort(), ['X', 'Y', 'Z']);
  assert.match(l.notes.join(' '), /Float not assessed: [XYZ], [XYZ], [XYZ] are in a loop\./);
  assert.match(l.notes.join(' '), /Resources not assessed/);
  assert.equal(all(l).every((a) => a.dimensions.float === undefined), true);
});

test('forecast stability compares with the BASELINE finish: P6\'s planned finish equals the early finish after a calculation, so it never shows the drift the baseline shows', () => {
  const h = B.horizon(), T = (c: string) => rows(h.db, 'TASK').find((t) => t.proj_id === h.projId && t.task_code === c)!;
  // after the calculation the planned finish of every unstarted activity IS its early finish (this is what made the dimension read 100 on real files)
  for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) assert.equal(T(c).target_end_date, T(c).early_end_date, `${c}: planned finish = early finish`);
  const m = byId(planningHorizon(h.db, {}));
  // against the baseline: C 10 working days later (100 - (10 - 3) x 5 = 65), F and I 6 days later (85), the rest on the baseline (100)
  assert.deepEqual(['C', 'F', 'I', 'A', 'B'].map((c) => m[c].dimensions.forecast_stability!.score), [65, 85, 85, 100, 100]);
  assert.deepEqual(m.C.dimensions.forecast_stability!.issues, ['Forecast drift 10d']);
  // the drift comes from the baseline: the same project with the baseline taken away is not assessed for it, not 100
  const bl = rows(h.db, 'PROJECT').find((p) => p.proj_id === h.projId)!; bl.sum_base_proj_id = '';
  rows(h.db, 'PROJECT').filter((p) => p._baseline_of).forEach((p) => { p._baseline_of = 'x'; });
  const none = planningHorizon(h.db, {});
  assert.match(none.notes.join(' '), /Forecast stability not assessed/);
  assert.ok(all(none).every((a) => a.dimensions.forecast_stability === undefined));
});

test('work with an actual start (under way) is not work about to start: it is in no window; finished work neither', () => {
  const b = B.project('ST', [{ id: 'A', duration_days: 4 }, { id: 'B', duration_days: 3, predecessors: ['A'] }, { id: 'C', duration_days: 3 }], { start: '2026-01-05', dataDate: '2026-01-07', schedule: false,
    ops: [{ op: 'update_activity', id: 'A', actual_start: '2026-01-05 00:00', percent_complete: 50 }] });
  assert.ok(scheduleProjects(b.db, [b.projId], { dataDate: at('2026-01-07') }).ok);
  const r = planningHorizon(b.db, {});
  assert.deepEqual(Object.keys(byId(r)).sort(), ['B', 'C'], 'A has an actual start (its start, the actual one, is before the data date; the rule is "no actual start", not "start before the anchor")');
  // an activity that has an actual start dated AT or after the data date (the window it would have been counted in) is also left out
  rows(b.db, 'TASK').find((t) => t.task_code === 'C')!.act_start_date = '2026-01-07 00:00';
  assert.deepEqual(Object.keys(byId(planningHorizon(b.db, {}))).sort(), ['B']);
});

test('statuses and the systemic rule by the source\'s numbers', () => {
  assert.deepEqual([100, 90, 89.9, 75, 74.9, 50, 49.9, 0].map(statusOf), ['ready', 'ready', 'mostly_ready', 'mostly_ready', 'at_risk', 'at_risk', 'not_ready', 'not_ready']);
  assert.deepEqual(WEIGHTS, { logic: 0.25, resources: 0.3, float: 0.1, forecast_stability: 0.15 });
  assert.ok(Math.abs(Object.values(WEIGHTS).reduce((a, b) => a + b, 0) - 0.8) < 1e-9);
  // a dimension is a systemic gap at max(2, 30 %) of the activities it is assessed for: one weak activity of 4 is not (min 2); two of 4 is
  const mk = (weak: number) => B.project('SYS', Array.from({ length: 4 }, (_, i) => ({ id: `A${i}`, duration_days: 3, resources: i >= weak ? ['R'] : [] })), { resources: [{ id: 'R', max_units_per_day: 1 }] });
  assert.deepEqual(planningHorizon(mk(1).db, {}).systemic_issues.filter((x) => x.dimension === 'resources'), []);
  const two = planningHorizon(mk(2).db, {}).systemic_issues.find((x) => x.dimension === 'resources')!;
  assert.equal(two.issue, 'resources_gap');
  assert.equal(two.activities.length, 2);
  assert.equal(two.description, '2 near-term activities have weak resources readiness');
  assert.equal(two.action, 'Address resources for the listed near-term activities before they start');
});

// ------------------------------------------------------------------------------------------------ the real samples

/** The activities that start in each window counted straight from a file's rows: no actual start, not WBS summary or level of effort, start = early, else planned, calendar days from the data date. */
function rawBands(db: B.Built['db'], dd: number) {
  const out = [0, 0, 0];
  for (const t of rows(db, 'TASK')) {
    if (t.act_start_date || t.task_type === 'TT_WBS' || t.task_type === 'TT_LOE') continue; // (an activity with an actual start, finished or under way, is not work about to start)
    const s = parseP6Date(t.early_start_date || t.target_start_date);
    if (s == null) continue;
    const d = Math.floor(s / 1440) - Math.floor(dd / 1440);
    if (d >= 0 && d <= 30) out[0]++; else if (d >= 31 && d <= 60) out[1]++; else if (d >= 61 && d <= 90) out[2]++;
  }
  return out;
}

test('129 trial and Detailed Program (progress): the windows counted from the rows, the resources dimension from the assignments, the cut lists and notes', () => {
  for (const [name, dd] of [['129 trial.xer', '2010-10-31'], ['Detailed Program.xer', '2008-12-31']] as const) {
    const db = readXerFile(sampleCopy(name)).db;
    const r = planningHorizon(db, {});
    assert.equal(r.status_date, `${dd} 00:00`);
    assert.deepEqual(r.bands.map((b) => b.activities_total), rawBands(db, at(dd)), `${name}: activities per window counted from the rows`);
    // resources: an activity (not a milestone) in a window with no assignment or expense scores 0; counted from the rows
    const loaded = new Set([...rows(db, 'TASKRSRC'), ...rows(db, 'PROJCOST')].map((a) => a.task_id));
    const code = new Map(rows(db, 'TASK').map((t) => [t.task_code, t]));
    const inWindow = all(r).filter((a) => !['TT_Mile', 'TT_FinMile'].includes(code.get(a.id)!.task_type));
    assert.equal(inWindow.filter((a) => a.dimensions.resources!.score === 0).length, inWindow.filter((a) => !loaded.has(code.get(a.id)!.task_id)).length, name);
    // the mean of the band is the mean of its activities
    for (const b of r.bands) assert.equal(b.readiness_score, Math.round((b.activities.reduce((a, x) => a + x.readiness_score, 0) / b.activities.length) * 10) / 10, `${name} ${b.band}`);
    // the status of an activity follows its readiness, and a risk is an at-risk or not-ready one
    for (const a of all(r)) assert.equal(a.status, statusOf(a.readiness_score));
    for (const b of r.bands) assert.equal(b.risks.length, b.activities.filter((a) => a.status === 'at_risk' || a.status === 'not_ready').length);
    // worst first
    for (const b of r.bands) assert.deepEqual(b.activities.map((a) => a.readiness_score), [...b.activities.map((a) => a.readiness_score)].sort((x, y) => x - y));
    assert.equal(r.summary.activities_in_horizon, rawBands(db, at(dd)).reduce((a, b) => a + b, 0));
  }
  // Detailed Program: 102 of the activities in the windows have no resource, a systemic gap (102 >= 30 % of 231 - and every one is an activity with no resource, counted from the rows)
  const dp = planningHorizon(readXerFile(sampleCopy('Detailed Program.xer')).db, {});
  assert.equal(dp.systemic_issues.find((x) => x.dimension === 'resources')!.activities.length, 102);
});

test('Tower-A (a baseline in the file): the one activity in a window, by hand', () => {
  // data date 1 Apr 2026 08:00. A1030 (forecast start 19 Mar) lies before it, A1010 is complete, A1020 started: only the milestone M1000 (1 Apr 17:00, day 0) is in the first window.
  // M1000: logic 70 (its predecessor A1030 is not complete), resources not assessed (a milestone), float 0 (total float 0), stability not assessed (M1000 is not in the file's baseline: added since): (0.25 x 70 + 0.10 x 0) / 0.35 = 50 -> at risk
  const r = planningHorizon(readXerFile(sampleCopy('Tower-A.xer')).db, {});
  assert.equal(r.summary.activities_in_horizon, 1);
  const m = r.bands[0].activities[0];
  assert.equal(m.id, 'M1000');
  assert.equal(m.days_until_start, 0);
  assert.equal(m.readiness_score, 50);
  assert.equal(m.status, 'at_risk');
  assert.deepEqual(m.not_assessed, ['resources', 'forecast_stability']);
  assert.deepEqual(m.issues, ['Predecessor A1030 only 0% complete', 'Low float (0d < 5d)']);
  assert.equal(r.bands[0].risks[0].risk, 'Low float (0d < 5d)', 'the weakest dimension is float (0, against logic 70): its first issue');
  assert.equal(r.bands[0].risks[0].impact, 'critical', 'the milestone has no float');
});

test('Aurora_Tower_Baseline with a status_date (the file has no data date): counted from the rows', () => {
  const db = readXerFile(sampleCopy('Aurora_Tower_Baseline.xer')).db;
  const r = planningHorizon(db, { statusDate: at('2026-06-22') });
  assert.equal(r.result, 'assessed');
  assert.equal(r.status_date, '2026-06-22 00:00');
  assert.deepEqual(r.bands.map((b) => b.activities_total), rawBands(db, at('2026-06-22')));
  assert.match(r.notes.join(' '), /Resources not assessed.*Forecast stability not assessed/);
});

// ------------------------------------------------------------------------------------------------ the tool

test('planning_horizon through the server: read-only, status_date the only argument, 25 listed with the true total and the note, the whole list in the result file', async () => {
  const { toolsList } = await import('../mcp/server.ts');
  const t = (toolsList() as any[]).find((x) => x.name === 'planning_horizon');
  assert.ok(t, 'listed');
  assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['handle', 'export', 'export_name', 'project', 'status_date', 'baseline', 'caller', 'async']);
  const h = await openSample('129 trial.xer');
  const r = await call('planning_horizon', { handle: h, bogus: 1 });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.match(r.d.notes.join(' '), /planning_horizon has no argument "bogus"/);
  // baseline as dcma_14 takes it: refused when no project in scope has it, with the saved baselines named
  const nobl = await call('planning_horizon', { handle: h, baseline: 'project' });
  assert.equal(nobl.err, true);
  assert.match(nobl.d.error.message, /No baseline "project" for this project\./);
  assert.match(r.d.notes.join(' '), /Forecast stability not assessed: no baseline is assigned to/);
  assert.deepEqual(Object.keys(r.d).slice(0, 4), ['report', 'status_date', 'result', 'summary'], 'summary first');
  const b = r.d.bands[1];
  assert.equal(b.activities.length, 25);
  assert.equal(b.activities_total, 369);
  assert.match(b.activities_note, /^25 of 369 shown; all 369 in .*planning_horizon-activities\.csv\.$/);
  assert.equal(b.risks.length, 25);
  assert.equal(b.risks_total, 34, 'the file has no baseline: forecast stability is not assessed, its weight goes to the others, and more activities read at risk');
  const csv = r.d.exported.files.find((f: any) => f.path.endsWith('-activities.csv'));
  assert.equal(csv.rows, 783, '785 before the activities with an actual start were left out of the windows');
  const whole = JSON.parse(readFileSync(r.d.exported.files.find((f: any) => f.path.endsWith('planning_horizon.json')).path, 'utf8'));
  assert.equal(whole.bands[1].activities.length, 369);
  assert.equal(r.d.exported.files.find((f: any) => f.path.endsWith('-bands.csv')).rows, 3);
  assert.equal(r.d.method, undefined);
  // a status date is taken as dcma_14 takes it; one that is not a date is refused
  const early = await call('planning_horizon', { handle: h, status_date: '2010-12-01' });
  assert.equal(early.err, false);
  assert.equal(early.d.status_date, '2010-12-01 00:00');
  const bad = await call('planning_horizon', { handle: h, status_date: 'soon' });
  assert.equal(bad.err, true);
  assert.match(bad.d.error.message, /"soon" is not a date/);
  // the sample with no data date: answered as not assessed, with the reason (not an error)
  const au = await openSample('Aurora_Tower_Baseline.xer');
  const n = await call('planning_horizon', { handle: au });
  assert.equal(n.err, false);
  assert.equal(n.d.result, 'not_assessed');
  assert.match(n.d.notes.join(' '), /aurora_tower has no data date; pass status_date/);
});
