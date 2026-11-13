// schedule_index (core/analysis/scheduleIndex.ts, registered in mcp/forensics.ts): the health score and the risk index against the benchmark's own numbers (tests/fixtures/benchmark-golden.json) on the fixtures rebuilt as P6
// projects (tests/benchmark-fixtures.ts; 7-day 24-hour calendar, so a working day = the source's day), every expected difference stated with its reason, each not-assessed path, the list rule, and the real samples (numbers verified by
// hand from the file's own rows, written in the comments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rows } from '../core/db.ts';
import { parseP6Date } from '../core/dates.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { CPT_SLIP_DAYS, dcma14 } from '../core/analysis/dcma.ts';
import { decm } from '../core/analysis/decm.ts';
import { makeScope, baselineOf, namesText } from '../core/analysis/common.ts';
import * as F from '../core/analysis/forensic.ts';
import { scheduleIndex, logicFindings, shapeScheduleIndex } from '../core/analysis/scheduleIndex.ts';
import * as B from './benchmark-fixtures.ts';
import { sampleCopy, testRoots } from './helpers.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
testRoots();
const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'benchmark-golden.json'), 'utf8'));
const G = (fixture: string, section: string) => golden[fixture][section];
const at = (d: string) => parseP6Date(`${d} 00:00`)!;
const score = (r: ReturnType<typeof scheduleIndex>, k: keyof ReturnType<typeof scheduleIndex>['risk']['sub_metrics']) => r.risk.sub_metrics[k].score;
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const openSample = async (name: string) => { const o = await call('open_file', { path: sampleCopy(name), lenient: true }); assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300)); return o.d.handle as string; };
const numbers = (l: string[]) => l.map((x) => x.match(/\d+/)![0]);

const FIXTURES = [['cleanChain', B.cleanChain], ['withFloat', B.withFloat], ['withLogicIssues', B.withLogicIssues], ['delayed', B.delayed], ['overAllocated', B.overAllocated], ['gamingCurrent', () => B.gaming().current]] as const;

// ------------------------------------------------------------------------------------------------ health

test('health: the source\'s score and breakdown on every fixture (equal: the sub-formulas and weights are the source\'s)', () => {
  for (const [name, build] of FIXTURES) {
    const r = scheduleIndex(build().db, {}), g = G(name, 'health_score');
    assert.equal(r.health.result, 'assessed', name);
    assert.equal(r.health.score, g.score, `${name} score`);
    const b = r.health.breakdown!;
    assert.deepEqual([b.density.score, b.float_erosion.score, b.structural.score, b.relationship.score], [g.breakdown.density_score, g.breakdown.float_erosion_score, g.breakdown.structural_score, g.breakdown.relationship_score], `${name} breakdown`);
    // the signals: the same facts (the numbers in them); the source's "No major issues" line is not a signal and is not carried over
    assert.deepEqual(numbers(r.health.top_signals!), g.top_signals[0].startsWith('No major') ? [] : numbers(g.top_signals), `${name} signals`);
  }
  // by hand, cleanChain: 4 activities all critical (density 100 x (1 - (1 - 0.2) / 0.8) = 0), no erosion (100), 1 open end of 4 (75), all FS (100): 0.35 x 100 + 0.15 x 75 + 0.10 x 100 = 56.25 -> 56.3
  assert.equal(scheduleIndex(B.cleanChain().db, {}).health.score, 56.3);
});

test('health: a schedule with a loop has no score; the loop is named the way the scheduler names it (the source scores it with its confidence capped)', () => {
  const r = scheduleIndex(B.withCycle().db, {});
  assert.ok(G('withCycle', 'cpm').cycles.length > 0, 'the source finds the loop and goes on');
  assert.equal(r.health.result, 'not_assessed');
  assert.equal(r.health.score, undefined);
  assert.match(r.health.note!, /^[XYZ], [XYZ], [XYZ] are in a loop$/);
  assert.equal(r.loops.length, 1);
  assert.deepEqual([...r.loops[0].activities].sort(), ['X', 'Y', 'Z']);
  // P6's stored float is not valid with a loop: the float sub-metric is not assessed, and the answer says why
  assert.equal(r.risk.sub_metrics.float.active, false);
  assert.match(r.risk.sub_metrics.float.reason!, /loop/);
  // and so is the WHOLE risk index (it used to read risk 0, grade A, "low", "pass" on a schedule that cannot be calculated): not assessed, naming the loop, no score, no grade, nothing to rank
  assert.equal(r.risk.result, 'not_assessed');
  assert.equal(r.risk.score, undefined);
  assert.equal(r.risk.grade, undefined);
  assert.equal(r.risk.level, undefined);
  assert.equal(r.risk.status, undefined);
  assert.equal(r.risk.note, 'the logic has a loop');
  assert.equal(r.risk.assessed_sub_metrics, 0);
  assert.deepEqual(r.risk.drivers, []);
  assert.ok(Object.values(r.risk.sub_metrics).every((m) => !m.active && m.score === null && /loop/.test(m.reason!)));
  assert.deepEqual(r.risk.left_out.map((l) => l.sub_metric), ['float', 'logic', 'baseline_drift', 'progress_integrity', 'resource']);
});

test('health: parts the file cannot supply are left out with the reason and the score is re-weighted (no relationships: the source says FS share 1)', () => {
  const b = B.project('SOLO', [{ id: 'A', duration_days: 3 }]);
  const r = scheduleIndex(b.db, {});
  assert.equal(r.health.breakdown!.relationship.assessed, false);
  assert.match(r.health.breakdown!.relationship.reason!, /no relationships/);
  assert.deepEqual(r.health.left_out!.map((l) => l.part), ['relationship']);
  // density 100 x (1 - (1 - 0.2) / 0.8) = 0, erosion 100, structural: the one activity is an open start and an open finish, 100 x (1 - 1/1) = 0; over weights 0.40 + 0.35 + 0.15: (0 + 35 + 0) / 0.90 = 38.9
  assert.equal(r.health.score, 38.9);
  // nothing assessable at all: no activity to count
  const empty = B.project('EMPTY', []);
  assert.equal(scheduleIndex(empty.db, {}).health.result, 'not_assessed');
});

test('health: connected share = activities with a link / activities (the source\'s confidence is 0.5 + 0.5 x this)', () => {
  assert.equal(scheduleIndex(B.withLogicIssues().db, {}).health.connected_share, 0.667, 'ORPHAN has no link');
  assert.equal(scheduleIndex(B.cleanChain().db, {}).health.connected_share, 1);
});

// ------------------------------------------------------------------------------------------------ risk sub-metrics against the source

test('risk: float, logic and baseline drift equal the source\'s on every fixture', () => {
  for (const [name, build] of FIXTURES) {
    const b = build();
    const r = scheduleIndex(b.db, {}), src = G(name, 'risk_index_status').data.sub_metrics;
    assert.equal(score(r, 'float'), src.float_risk.score, `${name} float`);
    assert.equal(score(r, 'logic'), src.logic_risk.score, `${name} logic`);
    if (src.baseline_drift_risk.active) assert.equal(score(r, 'baseline_drift'), src.baseline_drift_risk.score, `${name} drift`);
    else assert.equal(r.risk.sub_metrics.baseline_drift.active, false, `${name}: no baseline, inactive in both`);
  }
  // delayed by hand (baseline T1 5-12 Jan, T2 12-26 Jan, T3 26 Jan - 5 Feb; now 12 Jan, 31 Jan, 10 Feb): finish variances 0, 5, 5 -> average 3.33 x 2 = 6.67; BEI: only T1 was due by 20 Jan and it is complete -> 1, no term;
  // critical-path delay: 10 Feb less 5 Feb = 5 days: 6.67 + 0 + 5 = 11.67 -> 11.7
  const d = scheduleIndex(B.delayed().db, {});
  assert.equal(score(d, 'baseline_drift'), 11.7);
  const parts = Object.fromEntries(d.risk.sub_metrics.baseline_drift.parts.map((p) => [p.part, p.value]));
  assert.deepEqual(parts, { average_finish_variance_days: 3.33, bei: 1, critical_path_delay_days: 5 });
  assert.equal(d.baseline?.name, 'BL');
});

test('risk: the resource sub-metric equals the source\'s 65 on overAllocated (Crew over its limit, on critical activities)', () => {
  const r = scheduleIndex(B.overAllocated().db, {});
  assert.equal(G('overAllocated', 'risk_index_status').data.sub_metrics.resource_risk.score, 65);
  assert.equal(score(r, 'resource'), 65);
  // 50 (1 of 1 limited resources over-allocated) + 35 x 0 (every work activity has a resource) + 15 (the over-allocated resource is on a critical activity)
  assert.deepEqual(r.risk.sub_metrics.resource.parts.map((p) => [p.part, p.value]), [['over_allocated_share', 1], ['coverage_gap', 0], ['critical_path_conflict', 1]]);
  assert.equal(r.resources.over_allocated![0].resource, 'Crew');
});

test('risk: EXPECTED DIFFERENCES from the source\'s numbers, each with its reason', () => {
  // 1. no resource in the file: the source scores the resource sub-metric (0 or its coverage part, with capacity 1 for any name); the clone has nothing to assess and says so, so its composite is over fewer sub-metrics
  const d = scheduleIndex(B.delayed().db, {}), src = G('delayed', 'risk_index_status').data.schedule_risk_index;
  assert.equal(d.risk.sub_metrics.resource.active, false);
  assert.match(d.risk.sub_metrics.resource.reason!, /no resource is assigned to an activity/);
  // (0.30 x 20 + 0.25 x 66.7 + 0.20 x 11.7 + 0.15 x 0) / (0.30 + 0.25 + 0.20 + 0.15) = 25 / 0.9 = 27.8 by hand; the source: the same four plus its resource 0 over weight 1.0 = 25
  assert.equal(d.risk.score, 27.8);
  assert.equal(src.score, 25);
  assert.equal(d.risk.assessed_sub_metrics, 4);
  assert.deepEqual(d.risk.left_out.map((l) => l.sub_metric), ['resource']);
  // 2. the data date: the source skips progress integrity without a status_date argument; the clone has the file's own data date (the project was scheduled at it), so the sub-metric is assessed (cleanChain: 4 activities,
  //    none progressed, nothing in the future or past of 5 Jan: 0 anomalies)
  const c = scheduleIndex(B.cleanChain().db, {});
  assert.equal(c.risk.sub_metrics.progress_integrity.active, true);
  assert.equal(score(c, 'progress_integrity'), 0);
  assert.equal(G('cleanChain', 'risk_index').data.sub_metrics.progress_integrity_risk.active, false, 'the source: no status_date, skipped');
  // 3. a status date later than the file's own schedule: the forecast dates of work not yet done lie before it (a stale schedule), which the clone flags (progress rule 005); the source's fixture has no forecast dates.
  //    cleanChain at 20 Jan: T1 starts 5 Jan and T2 10 Jan, both before 20 Jan and not done: 2 medium anomalies (0.4 each) over 3 activities examined (M1 is a milestone): 100 x (1 - 0.8/3) = 73.3 -> risk 26.7
  const late = scheduleIndex(B.cleanChain().db, { statusDate: at('2026-01-20') });
  assert.equal(score(late, 'progress_integrity'), 26.7);
  assert.equal(G('cleanChain', 'risk_index_status').data.sub_metrics.progress_integrity_risk.score, 0);
  // 4. the fixtures withLogicIssues and gamingCurrent: the source's fixtures carry resources (a resource R; Crew), the clone's rebuilds carry none for these: resource not assessed instead of the source's 65 / 35
  assert.equal(scheduleIndex(B.withLogicIssues().db, {}).risk.sub_metrics.resource.active, false);
  assert.equal(G('withLogicIssues', 'risk_index_status').data.sub_metrics.resource_risk.score, 65);
});

test('risk: grade, level and status by the source\'s bands; drivers ranked by weight x score; recommendations one per driver', () => {
  const r = scheduleIndex(B.delayed().db, {});
  assert.equal(r.risk.grade, F.riskGradeOf(27.8));
  assert.equal(r.risk.level, 'moderate');
  assert.equal(r.risk.status, 'warning');
  // contributions over the active weights 0.90: logic 0.25 x 66.7 / 0.9 = 18.5, float 0.3 x 20 / 0.9 = 6.7, drift 0.2 x 11.7 / 0.9 = 2.6 (progress integrity 0: not a driver)
  assert.deepEqual(r.risk.drivers.map((d) => [d.rank, d.sub_metric, d.contribution, d.severity]), [[1, 'logic', 18.5, 'high'], [2, 'float', 6.7, 'low'], [3, 'baseline_drift', 2.6, 'low']]);
  // the source's recommendations: priority = severity, expected reduction = half the contribution, logic cites DCMA, the others AACE
  assert.deepEqual(r.risk.recommendations.map((x) => [x.target_sub_metric, x.priority, x.expected_score_reduction, x.standards_citation]), [['logic', 'high', 9.3, 'DCMA-PAM-200.1'], ['float', 'low', 3.4, 'AACE-RP-27R-03'], ['baseline_drift', 'low', 1.3, 'AACE-RP-27R-03']]);
  const srcDrivers = G('delayed', 'risk_index_status').data.risk_drivers.map((d: any) => d.driver_type);
  assert.deepEqual(srcDrivers, ['logic_risk', 'float_risk', 'baseline_drift_risk'], 'the source ranks them the same way');
});

test('health judges the relationship score and the signals on the EXACT shares: 899 finish-to-start of 999 relationships (0.8999) raise the signal, though it rounds to 0.9', () => {
  // a chain of 1000 activities; every 10th link (from the 6th) is start-to-start: 100 of the 999 relationships, so the finish-to-start share is 899 / 999 = 0.89990, which a 3-decimal rounding turns into 0.9 (not under 0.9)
  const tasks = Array.from({ length: 1000 }, (_, i) => ({ id: `A${i}`, duration_days: 1, ...(i ? { predecessors: [i % 10 === 5 ? `A${i - 1}:SS` : `A${i - 1}`] } : {}) }));
  const r = scheduleIndex(B.project('SHARE', tasks).db, {});
  const l = r.logic as Extract<typeof r.logic, { result: 'assessed' }>;
  assert.deepEqual([l.fs, l.relationships, l.fs_share], [899, 999, 0.9], 'shown rounded: 0.9');
  assert.ok(r.health.top_signals!.some((x) => x === 'Only 89.99% Finish-to-Start relationships'), 'judged on 899 / 999 < 0.9, not on the rounded 0.9; and shown with the decimals that keep the text from reading as the 90 % limit');
  // a share whose whole percent is under the limit is shown as before (the whole percent)
  const lower = scheduleIndex(B.project('SHARE2', Array.from({ length: 1000 }, (_, i) => ({ id: `A${i}`, duration_days: 1, ...(i ? { predecessors: [i % 5 === 3 ? `A${i - 1}:SS` : `A${i - 1}`] } : {}) }))).db, {});
  const ll = lower.logic as Extract<typeof lower.logic, { result: 'assessed' }>;
  assert.ok(lower.health.top_signals!.some((x) => x === `Only ${Math.round((ll.fs / ll.relationships) * 100)}% Finish-to-Start relationships`), lower.health.top_signals!.join(' | '));
  assert.equal(r.health.breakdown!.relationship.score, Math.round((899 / 999 / 0.9) * 1000) / 10);
});

test('schedule_index on a file of several projects shows each project\'s data date, and no single one when they differ', () => {
  // Enppi: several projects (the sample); the first project's date used to stand for all
  const db = readXerFile(sampleCopy('Enppi.xer')).db;
  const mains = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
  assert.ok(mains.length > 1);
  const r = scheduleIndex(db, {});
  assert.deepEqual(r.status_dates!.map((d) => d.project), mains.map((p) => p.proj_short_name));
  const dates = new Set(mains.map((p) => p.last_recalc_date));
  assert.equal(dates.size > 1, true, 'the projects have different data dates');
  assert.equal(r.status_date, null, 'no single date');
  for (const p of mains) assert.equal(r.status_dates!.find((d) => d.project === p.proj_short_name)!.status_date, p.last_recalc_date.slice(0, 16));
  // one project: the one date, as before, and no list
  const one = scheduleIndex(db, { projIds: [mains[0].proj_id] });
  assert.equal(one.status_dates, undefined);
  assert.equal(one.status_date, mains[0].last_recalc_date.slice(0, 16));
  // projects with the same date (a status date given): the one date
  assert.equal(scheduleIndex(db, { statusDate: at('2012-01-01') }).status_date, '2012-01-01 00:00');
});

// ------------------------------------------------------------------------------------------------ not assessed paths

test('not assessed: no baseline, no data date, no resources, nothing due, and the composite re-weighted over what is assessed', () => {
  // no baseline
  const a = scheduleIndex(B.cleanChain().db, {});
  assert.equal(a.risk.sub_metrics.baseline_drift.active, false);
  assert.equal(a.risk.sub_metrics.baseline_drift.score, null);
  assert.equal(a.risk.sub_metrics.baseline_drift.reason, 'no baseline is assigned to CLEAN; assign one with edit assign_baseline, or pass baseline');
  assert.equal(a.baseline, null);
  // a baseline that is not there is named in the reason the way dcma_14 words it
  assert.equal(scheduleIndex(B.delayed().db, { baseline: 'bl2' }).risk.sub_metrics.baseline_drift.reason, 'no BL2 baseline is assigned to DELAYED; assign one with edit assign_baseline, or pass baseline');
  // no data date (the sample): progress integrity and BEI cannot be assessed; with a status date they can
  const aurora = readXerFile(sampleCopy('Aurora_Tower_Baseline.xer')).db;
  const noDate = scheduleIndex(aurora, {});
  assert.equal(noDate.status_date, null);
  assert.equal(noDate.risk.sub_metrics.progress_integrity.active, false);
  assert.match(noDate.risk.sub_metrics.progress_integrity.reason!, /^aurora_tower has no data date; pass status_date$/);
  assert.equal(noDate.risk.sub_metrics.resource.active, false);
  assert.deepEqual(noDate.risk.left_out.map((l) => l.sub_metric), ['baseline_drift', 'progress_integrity', 'resource']);
  assert.equal(noDate.risk.assessed_sub_metrics, 2);
  // the composite over the two assessed: (0.30 x float + 0.25 x logic) / 0.55
  const f = score(noDate, 'float')!, l = score(noDate, 'logic')!;
  assert.equal(noDate.risk.score, Math.round(((0.3 * f + 0.25 * l) / 0.55) * 10) / 10);
  const dated = scheduleIndex(aurora, { statusDate: at('2025-06-01') });
  assert.equal(dated.risk.sub_metrics.progress_integrity.active, true);
  assert.equal(dated.status_date, '2025-06-01 00:00');
  // baseline there, nothing due by the data date: the BEI part is not assessed (never 1) and left out of the sum, the others stay
  const early = scheduleIndex(B.delayed().db, { statusDate: at('2026-01-06') });
  const bei = early.risk.sub_metrics.baseline_drift.parts.find((p) => p.part === 'bei')!;
  assert.equal(bei.assessed, false);
  assert.equal(bei.value, null);
  assert.equal(bei.note, 'no task was baselined to finish by the data date; the drift score counts the finish variance and the critical-path delay only');
  assert.equal(score(early, 'baseline_drift'), 11.7, 'the variance and delay parts stand: 6.67 + 5');
  assert.equal(early.risk.sub_metrics.baseline_drift.summary, 'Average finish variance 3.3 d, critical-path delay 5 d');
  assert.equal(early.risk.sub_metrics.baseline_drift.parts.filter((p) => p.assessed).map((p) => p.part).join(), 'average_finish_variance_days,critical_path_delay_days');
  assert.equal(/not taken as/.test(JSON.stringify(early.risk.sub_metrics.baseline_drift)), false);
  // nothing assessable: not assessed, with every reason
  const none = scheduleIndex(B.project('BARE', []).db, {});
  assert.equal(none.risk.result, 'not_assessed');
  assert.equal(none.risk.note, 'no sub-metric could be assessed');
});

test('resource: no limit set = left out of over-allocation (as the histogram leaves it); the coverage gap is dcma_14 check 10\'s population; re-weighted over the parts assessed', () => {
  const tasks = (limit: number) => B.project('LIM', [{ id: 'A', duration_days: 10, resources: ['Crew'] }, { id: 'B', duration_days: 10, resources: ['Crew'] }, { id: 'C', duration_days: 5, predecessors: ['A', 'B'] }], { resources: [{ id: 'Crew', max_units_per_day: limit }] });
  const none = scheduleIndex(tasks(0).db, {}).risk.sub_metrics.resource;
  assert.deepEqual(none.parts.map((p) => [p.part, p.assessed, p.value]), [['over_allocated_share', false, null], ['coverage_gap', true, 0.333], ['critical_path_conflict', false, null]]);
  assert.equal(none.parts[0].note, 'no resource is judged for over-allocation');
  // only the coverage part is assessed: 35 x 0.333 / 35 x 100 = 33.3 (C has no resource)
  assert.equal(none.score, 33.3);
  // with a limit the same file: 50 + 35 x 0.333 + 15 over 100 = 76.7
  assert.equal(scheduleIndex(tasks(1).db, {}).risk.sub_metrics.resource.score, 76.7);
  const row = scheduleIndex(tasks(0).db, {}).resources.resources![0];
  assert.equal(row.limit_set, false);
  assert.equal(row.over_allocated, false);
});

// ------------------------------------------------------------------------------------------------ one BEI, one resource population

test('the BEI is the clone\'s one BEI: equal to dcma_14\'s on a baseline file and on the delayed fixture; the coverage gap equals dcma_14 check 10', () => {
  for (const [name, db] of [['Tower-A', readXerFile(sampleCopy('Tower-A.xer')).db], ['delayed', B.delayed().db]] as const) {
    const s = makeScope(db, { calendarDays: true });
    const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(db, p, 'project')]));
    const mine = F.beiFigures(s, bls), theirs = dcma14(db, { maxIds: 0 }).checks.find((c) => c.id === 'bei')!;
    assert.equal(mine.result === 'assessed' ? mine.value : null, theirs.metric, `${name} value`);
    assert.equal(mine.result === 'assessed' ? mine.completed : null, theirs.numerator, `${name} completed`);
    assert.equal(mine.result === 'assessed' ? mine.due : null, theirs.denominator, `${name} due`);
  }
  // no baseline / nothing due: not assessed in both
  const clean = B.cleanChain().db;
  assert.equal(F.beiFigures(makeScope(clean, { calendarDays: true }), new Map()).result, 'not_assessed');
  assert.equal(dcma14(clean, {}).checks.find((c) => c.id === 'bei')!.result, 'not_assessed');
  const trial = readXerFile(sampleCopy('129 trial.xer')).db;
  const r = scheduleIndex(trial, {});
  const check10 = dcma14(trial, { maxIds: 0 }).checks.find((c) => c.id === 'resources')!;
  assert.equal(r.resources.unresourced!.length, check10.numerator);
  assert.equal(r.resources.work_activities, check10.denominator);
});

// ------------------------------------------------------------------------------------------------ logic findings

test('logic findings: the source\'s four findings with its severities; lags and hard constraints count in the score and have no finding (the source has none)', () => {
  const v = B.logicVariety();
  const l = F.logicFigures(makeScope(v.db, { calendarDays: true }));
  assert.equal(l.result, 'assessed');
  const f = logicFindings(l);
  assert.deepEqual(f.map((x) => [x.code, x.severity, x.standard]), [['LOGIC_OPEN_ENDS', 'medium', 'DCMA Check #1'], ['LOGIC_LEADS', 'high', 'DCMA Check #2'], ['LOGIC_REDUNDANT_RELATIONSHIPS', 'low', null]].filter(([c]) => f.some((x) => x.code === c)));
  const src = G('logicVariety', 'logic_audit');
  assert.deepEqual(src.findings.map((x: any) => x.code).filter((c: string) => c !== 'LOGIC_OUT_OF_SEQUENCE'), f.map((x) => x.code));
  // open ends are high when over 5% of the activities (the source's rule): 2 of 3 activities
  const w = F.logicFigures(makeScope(B.withLogicIssues().db, { calendarDays: true }));
  assert.equal(logicFindings(w).find((x) => x.code === 'LOGIC_OPEN_ENDS')!.severity, 'high');
  assert.deepEqual(logicFindings({ result: 'not_assessed', note: 'x' }), []);
});

// ------------------------------------------------------------------------------------------------ the real samples

test('Tower-A (a baseline in the file): every sub-metric by hand from the file\'s rows', () => {
  // TOWER-A: A1010 complete 2-6 Mar, A1020 started 7 Mar (40 %), A1030 not started, M1000 a finish milestone; data date 1 Apr 2026 08:00; links A1010 -> A1020 FS, A1020 -> A1030 SS +20 h, A1030 -> M1000 FS; resources on A1020 and A1030
  const db = readXerFile(sampleCopy('Tower-A.xer')).db;
  const r = scheduleIndex(db, { baseline: 'TOWER-A-BL1' }); // (saved in the file, not assigned: named)
  assert.equal(r.status_date, '2026-04-01 08:00');
  assert.equal(r.baseline!.name, 'TOWER-A-BL1');
  // float: 3 incomplete activities (A1020, A1030, M1000), all with total float 0 = critical: 100 x 0.2 x 1 = 20
  assert.equal(score(r, 'float'), 20);
  // logic: considered 4 (the milestone counts, the WBS and LOE would not); open ends: A1010 has no predecessor (1); lags: A1030 has an SS +20 h link (1); density (1 x 1.0 + 1 x 0.3) / 4 = 0.325 -> score 67.5 -> risk 32.5
  assert.equal(score(r, 'logic'), 32.5);
  // drift: the baseline holds A1010 (finish 6 Mar) and A1020 (finish 14 Mar). Variances: A1010 0; A1020 forecast finish 16 Mar 18:00 vs 14 Mar 18:00 on its 7-day calendar: 2 -> average 1 x 2 = 2.
  // BEI: both were baselined to finish by 1 Apr, 1 is complete: 0.5 -> 0.5 x 40 = 20. Delay: latest finish 1 Apr 17:00 less latest baseline finish 14 Mar 18:00 = 13 working days of the project calendar (16-20, 23-27 Mar, 30 Mar - 1 Apr), capped at 30
  assert.deepEqual(r.risk.sub_metrics.baseline_drift.parts.map((p) => p.value), [1, 0.5, 13]);
  assert.equal(score(r, 'baseline_drift'), 35);
  // progress: 3 activities examined (A1010, A1020, A1030; the milestone is not); A1020 (started: its forecast finish 16 Mar) and A1030 (forecast start 19 Mar) are before the data date: 2 medium x 0.4 / 3 -> 73.3 -> 26.7
  assert.equal(score(r, 'progress_integrity'), 26.7);
  assert.equal(r.progress.result === 'assessed' ? r.progress.anomalies.length : -1, 2);
  // resource: PILE, C35 and RIG all have limits and none is over-allocated; both work activities (A1020, A1030) have a resource: 0
  assert.equal(score(r, 'resource'), 0);
  // composite: 0.30 x 20 + 0.25 x 32.5 + 0.20 x 35 + 0.15 x 26.7 + 0.10 x 0 = 6 + 8.125 + 7 + 4.005 = 25.13 -> 25.1; all five assessed
  assert.equal(r.risk.score, 25.1);
  assert.equal(r.risk.assessed_sub_metrics, 5);
  assert.equal(r.risk.left_out.length, 0);
  // health: density 0 (3 of 3 critical), erosion 100, structural 100 x (1 - 1/4) = 75, relationship: 2 FS of 3 links = 0.667 / 0.9 = 74.1: 35 + 11.25 + 7.41 = 53.66 -> 53.7
  assert.equal(r.health.score, 53.7);
});

test('129 trial and Detailed Program (progress, no baseline in the file): counts verified from the rows, the sub-metrics assessed and left out as the file allows', () => {
  for (const name of ['129 trial.xer', 'Detailed Program.xer']) {
    const db = readXerFile(sampleCopy(name)).db;
    const r = scheduleIndex(db, {});
    // the file has no baseline project: drift not assessed with the reason (Detailed Program names none; 129 trial names one, 909, that the file does not hold)
    const p0 = rows(db, 'PROJECT')[0];
    assert.equal(!!p0.sum_base_proj_id, name === '129 trial.xer', name);
    assert.equal(r.risk.sub_metrics.baseline_drift.active, false, name);
    assert.equal(r.risk.sub_metrics.baseline_drift.reason, p0.sum_base_proj_id ? `the project baseline of ${p0.proj_short_name} is not in this file (the file was exported without it); export the file with its baselines, or pass baseline to name one that is in it` : `no baseline is assigned to ${p0.proj_short_name}; assign one with edit assign_baseline, or pass baseline`, name);
    // float counts from the rows: incomplete activities that are not WBS summary or level of effort, with a stored float
    const T = rows(db, 'TASK').filter((t) => !t.act_end_date && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE' && t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null);
    const neg = T.filter((t) => Number(t.total_float_hr_cnt) < 0).length;
    const fl = r.risk.sub_metrics.float.parts;
    assert.equal(fl[0].value, Math.round((neg / T.length) * 1000) / 1000, `${name} negative-float share = ${neg} of ${T.length}`);
    // progress integrity assessed at the file's data date
    assert.equal(r.risk.sub_metrics.progress_integrity.active, true, name);
    assert.equal(r.status_date, name === '129 trial.xer' ? '2010-10-31 00:00' : '2008-12-31 00:00');
    assert.equal(r.risk.assessed_sub_metrics, 4);
    // the composite is over the active weights only
    const act = Object.values(r.risk.sub_metrics).filter((m) => m.active);
    assert.equal(r.risk.score, Math.round((act.reduce((a, m) => a + m.weight * m.score!, 0) / act.reduce((a, m) => a + m.weight, 0)) * 10) / 10, name);
  }
  // Detailed Program: resources assigned but none has a limit: over-allocation and the critical conflict are left out, the coverage part stands (171 of 502 work activities have no resource, counted from the rows)
  const dp = readXerFile(sampleCopy('Detailed Program.xer')).db;
  const r = scheduleIndex(dp, {});
  const res = r.risk.sub_metrics.resource;
  assert.deepEqual(res.parts.map((p) => p.assessed), [false, true, false]);
  const loaded = new Set([...rows(dp, 'TASKRSRC'), ...rows(dp, 'PROJCOST')].map((a) => a.task_id));
  const work = rows(dp, 'TASK').filter((t) => !t.act_end_date && !['TT_WBS', 'TT_LOE', 'TT_Mile', 'TT_FinMile'].includes(t.task_type));
  assert.equal(r.resources.unresourced!.length, work.filter((t) => !loaded.has(t.task_id)).length);
  assert.equal(r.resources.work_activities, work.length);
});

// ------------------------------------------------------------------------------------------------ the tool

test('schedule_index through the server: read-only, summary first, 25 listed with the true total and the note, the whole list in the result file; an unknown argument named; bad arguments refused', async () => {
  const { toolsList } = await import('../mcp/server.ts');
  const t = (toolsList() as any[]).find((x) => x.name === 'schedule_index');
  assert.ok(t, 'listed');
  assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['handle', 'export', 'export_name', 'project', 'status_date', 'baseline', 'caller', 'async']);
  const h = await openSample('129 trial.xer');
  const r = await call('schedule_index', { handle: h, bogus: 1 });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.ok(r.d.notes.some((n: string) => /^schedule_index has no argument "bogus"; the call ran without it\./.test(n)), JSON.stringify(r.d.notes));
  assert.equal(r.d.arguments_not_used, undefined);
  assert.deepEqual(Object.keys(r.d).slice(0, 3), ['report', 'summary', 'health'], 'summary first');
  assert.equal(r.d.summary.risk.sub_metrics_assessed, '4 of 5');
  assert.equal(r.d.summary.risk.left_out[0], 'baseline_drift', 'the summary names what was left out; its reason is said once, in notes');
  assert.equal(r.d.risk.left_out[0], 'baseline_drift');
  assert.equal(r.d.progress_anomalies.length, 25);
  assert.equal(r.d.progress_anomalies_total, 81);
  assert.match(r.d.progress_anomalies_note, /^25 of 81 shown; all 81 in .*schedule_index-progress_anomalies\.csv\.$/);
  assert.equal(r.d.resources.length, 25);
  assert.equal(r.d.resources_total, 277);
  const csv = r.d.exported.files.find((f: any) => f.path.endsWith('-progress_anomalies.csv'));
  assert.equal(csv.rows, 81);
  const whole = JSON.parse(readFileSync(r.d.exported.files.find((f: any) => f.path.endsWith('schedule_index.json')).path, 'utf8'));
  assert.equal(whole.progress_anomalies.length, 81);
  assert.equal(whole.resources.length, 277);
  assert.deepEqual(r.d.exported.files.map((f: any) => f.path.split('schedule_index').pop()).sort(), ['-drivers.csv', '-logic_findings.csv', '-progress_anomalies.csv', '-resources.csv', '-sub_metrics.csv', '-unresourced_activities.csv', '.json']);
  assert.ok(existsSync(csv.path));
  // the weights are in the tool description, not in the answer
  assert.equal(r.d.method, undefined);
  for (const w of [/float 0\.30/, /logic 0\.25/, /baseline drift 0\.20/, /progress integrity 0\.15/, /resource 0\.10/, /0\.40 critical-path density/, /0\.35 float erosion/, /0\.15 structural/, /0\.10 relationship/]) assert.match(t.description, w);
  // refusals: a baseline the file does not have, a date that is not one
  const bad = await call('schedule_index', { handle: h, baseline: 'bl3' });
  assert.equal(bad.err, true);
  assert.match(bad.d.error.message, /No baseline "bl3" for this project\./);
  const nodate = await call('schedule_index', { handle: h, status_date: 'soon' });
  assert.equal(nodate.err, true);
  assert.match(nodate.d.error.message, /"soon" is not a date/);
  // a baseline in the file and a status date are taken as dcma_14 takes them
  const tw = await openSample('Tower-A.xer');
  const t1 = await call('schedule_index', { handle: tw, status_date: '2026-03-10', baseline: 'TOWER-A-BL1' });
  assert.equal(t1.err, false, JSON.stringify(t1.d).slice(0, 300));
  assert.equal(t1.d.summary.status_date, '2026-03-10 00:00');
  assert.equal(t1.d.summary.baseline.name, 'TOWER-A-BL1');
});

test('schedule_index: a mid-size mock of the list rule on a fixture (fewer than 25 rows are all listed, no note)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'si-'));
  const path = await B.saveXer(B.overAllocated(), dir, 'over.xer');
  const o = await call('open_file', { path });
  const r = await call('schedule_index', { handle: o.d.handle });
  assert.equal(r.err, false);
  assert.equal(r.d.resources.length, 1);
  assert.equal('resources_note' in r.d, false);
  assert.equal(r.d.risk.sub_metrics.resource.score, 65);
});

test('the lists in the answer and in the sentences follow the list rule: status_dates and project names by 25, the total, and a note where cut', () => {
  const r = scheduleIndex(B.delayed().db, {});
  const many = { ...r, status_dates: Array.from({ length: 30 }, (_, i) => ({ project: `P${i}`, status_date: '2026-01-01 00:00' })) };
  const { answer, whole } = shapeScheduleIndex(many, (l) => l.slice(0, 25));
  assert.equal(answer.summary.status_dates!.length, 25);
  assert.equal(answer.summary.status_dates_total, 30);
  assert.equal((answer.summary as any).status_dates_note, undefined, 'the cut note is put beside the list with the result file named, by the server');
  assert.equal(whole.summary.status_dates!.length, 30, 'the result file holds every project');
  assert.equal(whole.summary.status_dates_total, 30);
  // within the rule: whole, with the total and no note
  const few = shapeScheduleIndex({ ...r, status_dates: many.status_dates.slice(0, 3) }, (l) => l.slice(0, 25));
  assert.deepEqual([few.answer.summary.status_dates!.length, few.answer.summary.status_dates_total, 'status_dates_note' in few.answer.summary], [3, 3, false]);
  // the names in a sentence
  const names = Array.from({ length: 30 }, (_, i) => `P${i}`);
  assert.equal(namesText(names), `${names.slice(0, 25).join(', ')} and 5 more (30 in total)`);
  assert.equal(namesText(names.slice(0, 25)), names.slice(0, 25).join(', '));
  assert.equal(namesText(['A', 'B']), 'A, B');
});

test('decm runs dcma_14\'s critical path test with the one shared constant (CPT_SLIP_DAYS = 600)', async () => {
  assert.equal(CPT_SLIP_DAYS, 600);
  const b = B.cleanChain();
  const d = dcma14(b.db, { projIds: [b.projId] }).checks.find((c) => c.id === 'critical_path_test')!;
  const k = decm(b.db, { projIds: [b.projId] }).checks.find((c) => c.id === '06A401a')!;
  assert.deepEqual([k.result, k.metric, k.numerator, k.denominator], [d.result, d.metric, d.numerator, d.denominator]);
});
