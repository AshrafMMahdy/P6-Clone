// decm (core/analysis/decm.ts, registered in mcp/forensics.ts): the 17 DECM checks against the benchmark's own numbers (tests/fixtures/benchmark-golden.json) on the fixtures rebuilt as P6 projects (tests/benchmark-fixtures.ts), every
// expected difference stated with its reason, each not-assessed path, the profiles and overrides, the series of updates, the list rule, and the real samples (numbers verified by hand from the file's own rows, in the comments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rows } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { parseP6Date } from '../core/dates.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { dcma14 } from '../core/analysis/dcma.ts';
import { decm, DECM_IDS, DECM_PROFILES } from '../core/analysis/decm.ts';
import * as B from './benchmark-fixtures.ts';
import { sampleCopy, testRoots } from './helpers.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
testRoots();
const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'benchmark-golden.json'), 'utf8'));
const at = (d: string) => parseP6Date(`${d} 00:00`)!;
const srcChecks = (fixture: string, section: string): Record<string, any> => Object.fromEntries((Object.values(golden[fixture][section].data.checks_by_guideline) as any[]).flatMap((g) => g.checks).map((c: any) => [c.check_id, c]));
const by = (r: ReturnType<typeof decm>) => Object.fromEntries(r.checks.map((c) => [c.id, c]));
const ids = (c: { activities: { id: string }[] }) => c.activities.map((a) => a.id);
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const openSample = async (name: string) => { const o = await call('open_file', { path: sampleCopy(name), lenient: true }); assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300)); return o.d.handle as string; };
const FIXTURES = [['cleanChain', B.cleanChain], ['withFloat', B.withFloat], ['withLogicIssues', B.withLogicIssues], ['delayed', B.delayed], ['overAllocated', B.overAllocated], ['gamingCurrent', () => B.gaming().current]] as const;

// ------------------------------------------------------------------------------------------------ against the source

test('the 17 checks, grouped by guideline, in the source\'s order with its names; the answer says passed, failed, not assessed', () => {
  const r = decm(B.delayed().db, {});
  assert.deepEqual(r.checks.map((c) => c.id), DECM_IDS);
  assert.equal(DECM_IDS.length, 17);
  assert.deepEqual(r.guidelines.map((g) => [g.guideline, g.name, g.checks.length]), [[6, 'Schedule (Guideline 6)', 15], [8, 'Budgeting (Guideline 8)', 1], [10, 'Accounting/Planning Package (Guideline 10)', 1]]);
  assert.equal(r.summary.passed + r.summary.failed + r.summary.not_assessed, 17);
  const names = Object.fromEntries(Object.values(golden.delayed.decm.data.checks_by_guideline).flatMap((g: any) => g.checks).map((c: any) => [c.check_id, c.check_name]));
  // 06A506c is named for the clone's rule (a forecast date BEFORE the data date: remaining work starts ON it in P6); the source's name says on/before the status date
  for (const c of r.checks) assert.equal(c.name, c.id === '06A506c' ? 'Incomplete forecast before the data date' : names[c.id], c.id);
  assert.equal(names['06A506c'], 'Incomplete forecast on/before status date');
  assert.equal(r.report, 'DCMA DECM schedule checks');
  assert.equal(r.profile, 'default');
});

test('the source\'s results where the clone\'s inputs coincide: lags, out-of-sequence (a started activity), progress with no start, actuals after the status date, hard constraints, dangling activities', () => {
  // logicVariety at 20 Jan: the lag (C: SS+2 from A) and the two hard constraints (B Start On, E Finish On or Before; A's Start On or After is not hard) are the source's findings
  const lv = by(decm(B.logicVariety().db, { statusDate: at('2026-01-20') })), sv = srcChecks('logicVariety', 'decm_status_2026_01_20');
  assert.equal(lv['06A205a'].result, sv['06A205a'].status);
  assert.equal(lv['06A205a'].numerator, sv['06A205a'].violation_count);
  assert.equal(lv['06A205a'].denominator, sv['06A205a'].total_items, '9 relationships in both: no task is complete, so the clone\'s population (relationships of incomplete tasks) is the source\'s (all)');
  assert.deepEqual(ids(lv['06A209a']), sv['06A209a'].evidence);
  assert.equal(lv['06A209a'].result, 'fail');
  assert.equal(lv['06A209a'].metric, 40, '2 of the 5 incomplete tasks (the milestones are not in dcma\'s population)');
  assert.equal(sv['06A209a'].total_items, 7, 'the source counts every non-summary task, the milestones too');
  // gamingCurrent with T2 started (the source's variant, gaming.decm_t2_started): T2 started while T1 (60 %) is not finished
  const g = by(decm(B.gamingStarted().db, { statusDate: at('2026-01-29') })), sg = srcChecks('gaming', 'decm_t2_started_status_2026_01_29');
  assert.equal(g['06A212a'].result, 'fail');
  assert.deepEqual(ids(g['06A212a']), sg['06A212a'].evidence);
  assert.equal(`${g['06A212a'].numerator}/${g['06A212a'].denominator}`, `${sg['06A212a'].violation_count}/${sg['06A212a'].total_items}`);
  for (const id of ['06A204b', '06A205a', '06A209a', '06A505a', '06A505b', '06A506a', '06A506b', '06A506c']) assert.equal(g[id].result, sg[id].status, `gaming ${id}`);
  // gamingCurrent as it is (T2 25 % with no actual start): the source's progress with no start is the clone's too (06A505a fails in both), but the source also calls it out-of-sequence (it reads the percent); the clone's rule needs an actual start
  const gc = by(decm(B.gaming().current.db, { statusDate: at('2026-01-29') })), sc = srcChecks('gamingCurrent', 'decm');
  assert.equal(gc['06A505a'].result, 'fail');
  assert.equal(sc['06A505a'].status, 'fail');
  assert.deepEqual(ids(gc['06A505a']), ['T2']);
  assert.equal(sc['06A212a'].status, 'fail');
  assert.equal(gc['06A212a'].result, 'pass', 'DIFFERENCE: a started activity is out of sequence (the review rule the clone has), progress with no actual start is 06A505a');
  // every fixture: the ids of the dangling activities, hard constraints and lag agree (06A205a / 06A209a / 06A204b) wherever the source flags something
  for (const [name, build] of FIXTURES) {
    const c = by(decm(build().db, { statusDate: at('2026-01-20') })), s = srcChecks(name, 'decm');
    for (const id of ['06A205a', '06A209a', '06A505a', '06A505b', '06A506a', '06A506b']) assert.equal(c[id].result, s[id].status, `${name} ${id}`);
    assert.equal(c['06A204b'].result, s['06A204b'].status, `${name} 06A204b`);
    assert.equal(c['06A401a'].result, s['06A401a'].status, `${name} 06A401a: a valid continuous critical path in both`);
  }
});

test('EXPECTED DIFFERENCES from the source\'s results, each with its reason', () => {
  // 1. population: dcma_14's tasks are the incomplete ones that are not milestones; the source counts every non-summary, non-LOE task (complete ones and milestones included).
  //    delayed: T1 is complete, so the clone's 06A204b population is T2 and T3 (the source: T1, T2, T3), and T3 (no successor) is the one dangling task (the source flags the complete T1 as a dangling start too)
  const d = by(decm(B.delayed().db, { statusDate: at('2026-01-20') })), sd = srcChecks('delayed', 'decm');
  assert.deepEqual([d['06A204b'].numerator, d['06A204b'].denominator], [1, 2]);
  assert.deepEqual(ids(d['06A204b']), ['T3']);
  assert.deepEqual([sd['06A204b'].violation_count, sd['06A204b'].total_items], [2, 3]);
  // 2. no baseline in the file: the source counts every activity as missing its baseline dates (cleanChain: 4 of 4 fail); the clone has no baseline to look in, so it is not assessed, with the reason (a project with a baseline is judged: delayed 0 of 3 in both)
  const c = by(decm(B.cleanChain().db, { statusDate: at('2026-01-20') }));
  assert.equal(c['06A501a'].result, 'not_assessed');
  assert.match(c['06A501a'].note!, /^Missing baseline dates not assessed: no baseline is assigned to .+; assign one with edit assign_baseline, or pass baseline\.$/);
  assert.equal(srcChecks('cleanChain', 'decm')['06A501a'].status, 'fail');
  assert.equal(d['06A501a'].result, 'pass');
  assert.deepEqual([d['06A501a'].numerator, d['06A501a'].denominator], [0, 3]);
  assert.equal(sd['06A501a'].status, 'pass');
  // 3. the source's fixtures carry no forecast dates, so its 06A506c never finds anything; the clone has the real forecast dates, and a status date later than the file's own schedule makes the forecast of unfinished work lie before it.
  //    cleanChain, scheduled at 5 Jan and judged at 20 Jan: T1 (starts 5 Jan) and T2 (10 Jan) are not yet started and forecast to start before 20 Jan; T3 starts on 20 Jan (not before)
  assert.equal(c['06A506c'].result, 'fail');
  assert.deepEqual(ids(c['06A506c']), ['T1', 'T2']);
  assert.equal(srcChecks('cleanChain', 'decm')['06A506c'].status, 'pass');
  // judged at the file's own data date there is nothing to find
  const own = by(decm(B.cleanChain().db, {}));
  assert.equal(own['06A506c'].result, 'pass');
  assert.equal(own['06A506c'].numerator, 0);
  // 4. a loop: the source scores the critical path of its best-effort CPM; the clone's check fails and names the loop (P6 cannot schedule it)
  const loop = by(decm(B.withCycle().db, {}));
  assert.equal(loop['06A401a'].result, 'fail');
  assert.match(loop['06A401a'].note!, /^Loop: [XYZ], [XYZ], [XYZ] are in a loop\.$/);
  assert.deepEqual(ids(loop['06A401a']).sort(), ['X', 'Y', 'Z']);
  assert.equal(srcChecks('withCycle', 'decm')['06A401a'].status, 'fail', 'the source also fails it: cycles > 0');
});

// ------------------------------------------------------------------------------------------------ the new checks

test('06A208a, 06A210a, 06A505a/b: WBS summaries with logic, level of effort with a discrete successor, under way with no start, complete with no finish', () => {
  const b = B.project('NEW', [{ id: 'A', duration_days: 5 }, { id: 'B', duration_days: 5, predecessors: ['A'] }, { id: 'C', duration_days: 5, predecessors: ['B'] }], { ops: [
    { op: 'add_activity', id: 'S1', name: 'Summary with logic', type: 'wbs_summary', duration_days: 0 }, { op: 'add_activity', id: 'S2', name: 'Summary without', type: 'wbs_summary', duration_days: 0 },
    { op: 'add_relationship', pred: 'S1', succ: 'C' },
    { op: 'add_activity', id: 'L1', name: 'LOE feeding C', type: 'loe', duration_days: 5 }, { op: 'add_activity', id: 'L2', name: 'LOE feeding an LOE', type: 'loe', duration_days: 5 }, { op: 'add_activity', id: 'L3', name: 'LOE feeding a summary', type: 'loe', duration_days: 5 }, { op: 'add_activity', id: 'L4', name: 'LOE alone', type: 'loe', duration_days: 5 },
    { op: 'add_relationship', pred: 'L1', succ: 'C' }, { op: 'add_relationship', pred: 'L2', succ: 'L4' }, { op: 'add_relationship', pred: 'L3', succ: 'S2' },
  ] });
  const r = by(decm(b.db, {}));
  // 06A208a: S1 has a successor (C), S2 has a predecessor (L3): both carry logic here; the population is the 2 WBS summaries
  assert.deepEqual(ids(r['06A208a']).sort(), ['S1', 'S2']);
  assert.deepEqual([r['06A208a'].numerator, r['06A208a'].denominator], [2, 2]);
  assert.equal(r['06A208a'].result, 'fail');
  // 06A210a: L1 -> C (a task) is the one level-of-effort activity with a discrete successor; L2 -> an LOE, L3 -> a WBS summary and L4 have none: 1 of 4
  assert.deepEqual(ids(r['06A210a']), ['L1']);
  assert.deepEqual([r['06A210a'].numerator, r['06A210a'].denominator], [1, 4]);
  assert.equal(r['06A210a'].metric, 25);
  // neither population: not assessed with the reason
  const plain = by(decm(B.cleanChain().db, {}));
  assert.equal(plain['06A208a'].result, 'not_assessed');
  assert.match(plain['06A208a'].note!, /no WBS summary activity/);
  assert.match(plain['06A210a'].note!, /no level-of-effort activity/);
  // 06A505a/b: a file can carry progress with no actual start (and 100 % with no actual finish), which the edit operations refuse: written onto the rows
  const p = B.project('PROG', [{ id: 'A', duration_days: 5 }, { id: 'B', duration_days: 5, predecessors: ['A'] }, { id: 'C', duration_days: 5, predecessors: ['B'] }, { id: 'D', duration_days: 5, predecessors: ['C'] }]);
  B.setPhysicalPercent(p, 'A', 40);   // under way, no actual start
  B.setPhysicalPercent(p, 'B', 100);  // complete, no actual finish
  rows(p.db, 'TASK').find((t) => t.task_code === 'C')!.status_code = 'TK_Active'; // status Started, no actual start, 0 %
  const q = by(decm(p.db, {}));
  assert.deepEqual(ids(q['06A505a']), ['A', 'C']);
  assert.deepEqual([q['06A505a'].numerator, q['06A505a'].denominator], [2, 4]);
  assert.deepEqual(ids(q['06A505b']), ['B']);
  assert.equal(q['06A505b'].result, 'fail');
  assert.equal(q['06A505b'].metric, 25);
});

test('06A501a: an activity not in the baseline, or in it with no start or no finish, over the activities of projects that have the baseline', () => {
  // delayed has all three in its baseline; add an activity after the baseline (D) and blank the baseline finish of T2
  const b = B.delayed();
  assert.ok(applyOps(b.db, [{ op: 'add_activity', id: 'D', name: 'Added later', duration_days: 3 }], { calendarDays: true }).ok);
  const bl = rows(b.db, 'PROJECT').find((p) => p._baseline_of)!;
  const t2 = rows(b.db, 'TASK').find((t) => t.proj_id === bl.proj_id && t.task_code === 'T2')!;
  t2.target_end_date = ''; t2.early_end_date = ''; t2.act_end_date = '';
  const r = by(decm(b.db, {}));
  assert.deepEqual(ids(r['06A501a']).sort(), ['D', 'T2']);
  assert.deepEqual([r['06A501a'].numerator, r['06A501a'].denominator], [2, 4]);
  // the baseline argument is read as dcma_14 reads it: one that does not exist is not assessed
  assert.match(by(decm(b.db, { baseline: 'bl3' }))['06A501a'].note!, /not assessed: no BL3 baseline is assigned to/);
});

test('06A504a/b: an actual start / finish that differs from the one an earlier update held, over consecutive updates in data-date order', () => {
  const { history, current } = B.gaming();
  const upd = [...history.map((h) => ({ name: h.snapshot_date, db: h.build.db, projId: h.build.projId })), { name: 'current', db: current.db, projId: current.projId }];
  const r = by(decm(current.db, { statusDate: at('2026-01-29'), updates: upd }));
  const s = srcChecks('gaming', 'decm_history_status_2026_01_29');
  // T1's actual start was 5 Jan in the 15 Jan update and 7 Jan afterwards: retroactively changed (the source: T1, from the first start it saw)
  assert.deepEqual(ids(r['06A504a']), ['T1']);
  assert.deepEqual(s['06A504a'].evidence, ['T1']);
  assert.deepEqual([r['06A504a'].numerator, r['06A504a'].denominator], [1, 2]);
  assert.equal(r['06A504a'].result, 'fail');
  assert.match(String(r['06A504a'].activities[0].value), /2026-01-15: 2026-01-05 00:00 -> 2026-01-22: 2026-01-07 00:00/);
  assert.equal(r['06A504b'].result, 'pass');
  assert.equal(s['06A504b'].status, 'pass');
  // handed in a different order, the updates are read in data-date order
  const shuffled = by(decm(current.db, { statusDate: at('2026-01-29'), updates: [upd[2], upd[0], upd[1]] }));
  assert.deepEqual(ids(shuffled['06A504a']), ['T1']);
  // no earlier update: not assessed, with the reason (one update alone is not a series)
  const none = by(decm(current.db, { statusDate: at('2026-01-29') }));
  assert.equal(none['06A504a'].result, 'not_assessed');
  assert.match(none['06A504a'].note!, /no earlier update was given; pass updates/);
  assert.equal(by(decm(current.db, { updates: [upd[2]] }))['06A504b'].result, 'not_assessed');
  // a baseline saved from the project held in the same database is an update of its own (its rows are viewed as a project): a baseline saved after T1 started, then T1's actual start corrected
  const b = B.project('RETRO', [{ id: 'T1', duration_days: 5 }, { id: 'T2', duration_days: 5, predecessors: ['T1'] }], { dataDate: '2026-01-12', schedule: false,
    ops: [{ op: 'update_activity', id: 'T1', actual_start: '2026-01-05 00:00' }, { op: 'save_baseline', name: 'Held', assign_as: 'project' }, { op: 'update_activity', id: 'T1', actual_start: '2026-01-06 00:00' }] });
  const held = rows(b.db, 'PROJECT').find((p) => p._baseline_of)!;
  const viaBaseline = by(decm(b.db, { updates: [{ name: 'Held', db: b.db, projId: held.proj_id }, { name: 'current', db: b.db, projId: b.projId }] }));
  assert.deepEqual(ids(viaBaseline['06A504a']), ['T1']);
});

test('the series is ordered by data date with the OPEN project in it: the open project is not always the latest, and the answer says the order used and which one it is', () => {
  const { history, current } = B.gaming();
  // the open project is the 22 Jan update; the 15 Jan update and the 29 Jan one (the "current" of the fixture) are the other updates
  const open = { name: 'open', db: history[1].build.db, projId: history[1].build.projId, open: true };
  const upd = [{ name: 'latest', db: current.db, projId: current.projId }, open, { name: 'first', db: history[0].build.db, projId: history[0].build.projId }];
  const r = decm(open.db, { statusDate: at('2026-01-29'), updates: upd });
  assert.deepEqual(r.updates, [{ name: 'first', data_date: '2026-01-15 00:00', open_project: false }, { name: 'open', data_date: '2026-01-22 00:00', open_project: true }, { name: 'latest', data_date: '2026-01-29 00:00', open_project: false }]);
  // the same checks as when the open project is last: T1's actual start was 5 Jan, then 7 Jan
  assert.deepEqual(ids(by(r)['06A504a']), ['T1']);
  assert.match(String(by(r)['06A504a'].activities[0].value), /^first: 2026-01-05 00:00 -> open: 2026-01-07 00:00$|^first: .* -> /);
  // no updates given: an empty list
  assert.deepEqual(decm(current.db, {}).updates, []);
  assert.deepEqual(r.updates.map((u) => u.open_project).filter(Boolean).length, 1);
});

test('06A506c is "before the data date": a forecast ON the data date is not flagged, one before is (the forecast START of unstarted work counts too); the method note lists both differences from the source, and the populations of 06A204b / 06A205a / 06A209a', () => {
  const b = B.project('DD', [{ id: 'A', duration_days: 3 }, { id: 'B', duration_days: 3 }, { id: 'C', duration_days: 3 }], { start: '2026-01-05', dataDate: '2026-01-10' });
  const T = Object.fromEntries(rows(b.db, 'TASK').filter((t) => t.proj_id === b.projId).map((t) => [t.task_code, t]));
  // A: forecast start 5 Jan (before the data date 10 Jan), finish 12 Jan; B: starts ON 10 Jan; C: starts 11 Jan
  Object.assign(T.A, { early_start_date: '2026-01-05 00:00', restart_date: '2026-01-05 00:00', early_end_date: '2026-01-12 00:00', reend_date: '2026-01-12 00:00' });
  Object.assign(T.B, { early_start_date: '2026-01-10 00:00', restart_date: '2026-01-10 00:00', early_end_date: '2026-01-10 00:00', reend_date: '2026-01-10 00:00' });
  Object.assign(T.C, { early_start_date: '2026-01-11 00:00', restart_date: '2026-01-11 00:00', early_end_date: '2026-01-12 00:00', reend_date: '2026-01-12 00:00' });
  const r = decm(b.db, {}), c = by(r)['06A506c'];
  assert.equal(c.name, 'Incomplete forecast before the data date');
  assert.deepEqual(ids(c), ['A'], 'A starts before the data date (its finish is later: the source, testing the finish only, would not flag it); B, ON the date in start and finish, is not before it');






});

test('06A401a: a loop fails it and names the loop; otherwise it is dcma_14\'s critical path test, unchanged', () => {
  const b = B.cleanChain();
  const r = by(decm(b.db, {})), t = dcma14(b.db, {}).checks.find((c) => c.id === 'critical_path_test')!;
  assert.equal(r['06A401a'].result, t.result);
  assert.equal(r['06A401a'].metric, t.metric);
  assert.deepEqual(r['06A401a'].threshold, t.threshold);
  assert.equal(r['06A401a'].note, undefined);
});

// ------------------------------------------------------------------------------------------------ not assessed

test('not assessed, with the reason: SLPP and planning packages (P6 has no such types), no data date, no baseline, no earlier update, empty populations', () => {
  const r = by(decm(B.cleanChain().db, {}));
  assert.equal(r['08I101a'].result, 'not_assessed');
  assert.match(r['08I101a'].note!, /P6 has no summary-level planning package \(SLPP\) activity type/);
  assert.match(r['10A303a'].note!, /P6 has no planning-package activity type/);
  for (const id of ['08I101a', '10A303a', '06A501a', '06A504a', '06A504b', '06A208a', '06A210a']) { assert.equal(r[id].result, 'not_assessed', id); assert.equal(r[id].metric, null, id); assert.equal(r[id].denominator, null, id); }
  // no data date (the sample): the three status-date checks are not assessed; with a status_date they are
  const aurora = readXerFile(sampleCopy('Aurora_Tower_Baseline.xer')).db;
  const n = by(decm(aurora, {}));
  for (const id of ['06A506a', '06A506b', '06A506c']) { assert.equal(n[id].result, 'not_assessed', id); assert.match(n[id].note!, /^(Actual start after status date|Actual finish after status date|.+) not assessed: aurora_tower has no data date; pass status_date\.$/, id); }
  const w = by(decm(aurora, { statusDate: at('2025-06-01') }));
  for (const id of ['06A506a', '06A506b', '06A506c']) assert.notEqual(w[id].result, 'not_assessed', id);
  assert.equal(decm(aurora, {}).status_date, null);
  // the summary counts them
  const sum = decm(aurora, {}).summary;
  assert.equal(sum.passed + sum.failed + sum.not_assessed, 17);
  assert.ok(sum.not_assessed >= 7);
  // nothing assessed at all: no ratio, no overall
  const none = decm(B.project('BARE', []).db, {});
  assert.equal(none.summary.compliance_ratio, null);
  assert.equal(none.summary.overall, null);
});

test('a threshold of 0 % is failed by one activity in any population (dcma_14 rounds the share to one decimal first, and passes one in 2000)', () => {
  const trial = readXerFile(sampleCopy('129 trial.xer')).db;
  const c = by(decm(trial, {}))['06A505b'];
  // BTAB1193 is started with no remaining duration (100 % by its duration) and no actual finish: 1 of 2068 = 0.05 %
  assert.deepEqual([c.numerator, c.denominator], [1, 2068]);
  assert.equal(c.metric, 0.05);
  assert.equal(c.result, 'fail');
  assert.deepEqual(ids(c), ['BTAB1193']);
});

// ------------------------------------------------------------------------------------------------ profiles and thresholds

test('profiles: default and strict differ in three thresholds; the profile is the only way to change them; the answer says where each came from', () => {
  assert.deepEqual(Object.keys(DECM_PROFILES), ['default', 'strict']);
  // 25 tasks in a chain, one with a hard constraint (4 %): passes the default 5 %, fails strict 2 %; the same one lag in 25 relationships
  const tasks = Array.from({ length: 25 }, (_, i) => ({ id: `A${i + 1}`, duration_days: 2, predecessors: i ? [`A${i}${i === 5 ? ':FS+1' : ''}`] : [], ...(i === 3 ? { constraint: { type: 'start_on', date: '2026-02-01 00:00' } } : {}) }));
  const b = B.project('PROF', tasks);
  const d = by(decm(b.db, {})), s = by(decm(b.db, { profile: 'strict' }));
  assert.equal(d['06A209a'].metric, 4);
  assert.equal(d['06A209a'].result, 'pass');
  assert.deepEqual(d['06A209a'].threshold, { op: '<=', value: 5, source: DECM_PROFILES.default.label });
  assert.equal(s['06A209a'].result, 'fail');
  assert.equal(s['06A209a'].threshold!.value, 2);
  // 1 lag in 24 relationships = 4.2 %: default 5 passes, strict 2 fails
  assert.equal(d['06A205a'].result, 'pass');
  assert.equal(s['06A205a'].result, 'fail');
  // the other thresholds are 0 % in both, and 06A506c is 10 % / 5 %
  assert.equal(d['06A506c'].threshold!.value, 10);
  assert.equal(s['06A506c'].threshold!.value, 5);
  assert.equal(d['06A204b'].threshold!.value, 0);
  assert.equal(s['06A204b'].threshold!.value, 0);
  assert.equal(d['06A401a'].threshold!.op, '=', 'the critical path test keeps dcma_14\'s own threshold');
  // no override by check id: a thresholds option is not part of the options at all (the agent picks default or strict)
  assert.deepEqual(by(decm(b.db, { profile: 'strict', ...({ thresholds: { '06A209a': 10 } } as object) }))['06A209a'].threshold, { op: '<=', value: 2, source: DECM_PROFILES.strict.label }, 'a thresholds value is ignored: the strict profile stands');
  assert.equal(decm(b.db, { profile: 'strict' }).profile, 'strict');
  // the method note says the values are the source's and unchecked against the DCMA workbook
  assert.equal((decm(b.db, {}) as any).method, undefined);
});

// ------------------------------------------------------------------------------------------------ the real samples

test('129 trial and Detailed Program (progress, no baseline): every figure counted from the file\'s rows', () => {
  for (const [name, lag, oos, start, finish] of [['129 trial.xer', '535/3841', '78/2068', '2/2068', '1/2068'], ['Detailed Program.xer', '226/731', '3/621', '1/621', '1/621']] as const) {
    const db = readXerFile(sampleCopy(name)).db;
    const r = by(decm(db, {}));
    const P = rows(db, 'PROJECT')[0], dd = parseP6Date(P.last_recalc_date)!;
    const T = rows(db, 'TASK'), byId = new Map(T.map((t) => [t.task_id, t]));
    // 06A205a: relationships touching an incomplete task that is not a WBS summary, LOE or milestone (dcma_14's population), those with a lag above 0
    const inc = new Set(T.filter((t) => !t.act_end_date && !['TT_WBS', 'TT_LOE', 'TT_Mile', 'TT_FinMile'].includes(t.task_type)).map((t) => t.task_id));
    const R = rows(db, 'TASKPRED').filter((x) => inc.has(x.task_id) || inc.has(x.pred_task_id));
    assert.equal(`${R.filter((x) => Number(x.lag_hr_cnt) > 0).length}/${R.length}`, lag, `${name} counted from the rows`);
    assert.equal(`${r['06A205a'].numerator}/${r['06A205a'].denominator}`, lag, name);
    // 06A212a: activities (not WBS summary or LOE) with an actual start and a finish-to-start predecessor that has no actual finish
    const discrete = T.filter((t) => t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE');
    const oosRows = discrete.filter((t) => t.act_start_date && rows(db, 'TASKPRED').some((x) => x.task_id === t.task_id && x.pred_type === 'PR_FS' && byId.get(x.pred_task_id) && !byId.get(x.pred_task_id)!.act_end_date));
    assert.equal(`${oosRows.length}/${discrete.length}`, oos, `${name} counted from the rows`);
    assert.equal(`${r['06A212a'].numerator}/${r['06A212a'].denominator}`, oos, name);
    // 06A506a/b: actual start / finish after the data date, over the activities that are not WBS summaries
    const nonWbs = T.filter((t) => t.task_type !== 'TT_WBS');
    assert.equal(`${nonWbs.filter((t) => t.act_start_date && parseP6Date(t.act_start_date)! > dd).length}/${nonWbs.length}`, start);
    assert.equal(`${nonWbs.filter((t) => t.act_end_date && parseP6Date(t.act_end_date)! > dd).length}/${nonWbs.length}`, finish);
    assert.equal(`${r['06A506a'].numerator}/${r['06A506a'].denominator}`, start, name);
    assert.equal(`${r['06A506b'].numerator}/${r['06A506b'].denominator}`, finish, name);
    // no baseline in these files
    assert.equal(r['06A501a'].result, 'not_assessed', name);
    assert.equal(r['06A504a'].result, 'not_assessed', name);
    assert.equal(decm(db, {}).status_date, name === '129 trial.xer' ? '2010-10-31 00:00' : '2008-12-31 00:00');
    assert.equal(r['06A401a'].result, dcma14(db, {}).checks.find((c) => c.id === 'critical_path_test')!.result, `${name}: the same test as dcma_14 check 12`);
  }
});

test('Tower-A (a baseline in the file) and the series Tower-A -> Tower-A_edited: by hand from the files\' rows', () => {
  const tw = readXerFile(sampleCopy('Tower-A.xer')).db;
  const r = by(decm(tw, {}));
  // data date 1 Apr 2026 08:00. Baseline TOWER-A-BL1 holds A1010 and A1020 only: of the 4 activities (A1010, A1020, A1030, M1000) A1030 and the milestone are not in it: 2 of 4
  assert.deepEqual(ids(r['06A501a']).sort(), ['A1030', 'M1000']);
  assert.deepEqual([r['06A501a'].numerator, r['06A501a'].denominator], [2, 4]);
  // the one relationship with a lag is A1020 -> A1030 SS + 20 h: 1 of the 3
  assert.deepEqual([r['06A205a'].numerator, r['06A205a'].denominator], [1, 3]);
  // forecast before the data date: A1020 (started, forecast finish 16 Mar) and A1030 (forecast start 19 Mar), 2 of 4 (A1010 is complete, the milestone forecasts 1 Apr 17:00)
  assert.deepEqual(ids(r['06A506c']).sort(), ['A1020', 'A1030']);
  assert.equal(r['06A506c'].result, 'fail');
  // the series: Tower-A (earlier) -> Tower-A_edited (current). Comparing the two files' rows: A1010's actual finish 6 Mar 17:00 -> 08:00 and A1020's actual start 7 Mar 07:00 -> 08:00 are the only changed actuals
  const edited = readXerFile(sampleCopy('Tower-A_edited.xer')).db;
  const earlier = { name: 'Tower-A', db: tw, projId: rows(tw, 'PROJECT').find((p) => !p._baseline_of)!.proj_id };
  const cur = { name: 'current', db: edited, projId: rows(edited, 'PROJECT').find((p) => !p._baseline_of)!.proj_id };
  const s = by(decm(edited, { updates: [earlier, cur] }));
  assert.deepEqual(ids(s['06A504a']), ['A1020']);
  assert.deepEqual(ids(s['06A504b']), ['A1010']);
  assert.deepEqual([s['06A504a'].numerator, s['06A504a'].denominator], [1, 4]);
  assert.equal(s['06A504a'].metric, 25);
  assert.equal(s['06A504a'].result, 'fail');
  assert.match(String(s['06A504b'].activities[0].value), /Tower-A: 2026-03-06 17:00 -> current: 2026-03-06 08:00/);
});

// ------------------------------------------------------------------------------------------------ the tool

test('decm through the server: read-only, summary first, 25 activities per check with the true total and the note, the whole list in the result file; arguments refused or named', async () => {
  const { toolsList } = await import('../mcp/server.ts');
  const t = (toolsList() as any[]).find((x) => x.name === 'decm');
  assert.ok(t, 'listed');
  assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['handle', 'export', 'export_name', 'project', 'profile', 'baseline', 'status_date', 'updates', 'caller', 'async']);
  assert.deepEqual(t._meta, { 'whiq/files': { read: ['updates[].path'], opens: false } });
  assert.match(t.description, /have NOT been checked against the DCMA DECM workbook/);
  assert.doesNotMatch(t.description, /thresholds overrides/);
  assert.match(t.description, /the profile is the only way to change the thresholds/);
  assert.match(t.description, /all put in data-date order/);
  assert.doesNotMatch(t.description + JSON.stringify(t.inputSchema), /this project is the (last|latest)/);
  const h = await openSample('129 trial.xer');
  const r = await call('decm', { handle: h, bogus: 1 });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 400));
  assert.match(r.d.notes.join(' '), /decm has no argument "bogus"; the call ran without it/);
  assert.deepEqual(Object.keys(r.d).slice(0, 4), ['report', 'profile', 'status_date', 'baseline'], 'the headline first');
  assert.equal(r.d.summary.passed + r.d.summary.failed + r.d.summary.not_assessed, 17);
  const lags = r.d.checks.find((c: any) => c.id === '06A205a');
  assert.equal(lags.activities.length, 25);
  assert.equal(lags.total_activities, 535);
  assert.match(lags.activities_note, /^25 of 535 shown; all 535 in .*decm-failing_activities\.csv\.$/);
  const csv = r.d.exported.files.find((f: any) => f.path.endsWith('-failing_activities.csv'));
  assert.ok(csv.rows >= 535);
  assert.equal(JSON.parse(readFileSync(r.d.exported.files.find((f: any) => f.path.endsWith('decm.json')).path, 'utf8')).checks.find((c: any) => c.id === '06A205a').activities.length, 535);
  // refusals
  for (const [args, msg] of [[{ profile: 'nope' }, /Unknown profile "nope"\./], [{ baseline: 'bl3' }, /No baseline "bl3" for this project/], [{ updates: [] }, /updates must list the other updates\./]] as const) {
    const bad = await call('decm', { handle: h, ...args });
    assert.equal(bad.err, true, JSON.stringify(args));
    assert.match(bad.d.error.message, msg);
  }
  // the series through the tool: files and a handle, the open project last
  const cur = await openSample('Tower-A_edited.xer'), earlier = await openSample('Tower-A.xer');
  const viaPath = await call('decm', { handle: cur, updates: [{ path: sampleCopy('Tower-A.xer') }] });
  assert.equal(viaPath.err, false, JSON.stringify(viaPath.d).slice(0, 300));
  assert.equal(viaPath.d.checks.find((c: any) => c.id === '06A504a').result, 'fail');
  const viaHandle = await call('decm', { handle: cur, updates: [{ handle: earlier, name: 'first' }] });
  assert.equal(viaHandle.err, false);
  assert.match(viaHandle.d.checks.find((c: any) => c.id === '06A504b').activities[0].value, /^first: /);
  // the profile is used; a thresholds argument is not one (reported as not used)
  const strict = await call('decm', { handle: cur, profile: 'strict', thresholds: { '06A205a': 50 } });
  assert.match(strict.d.notes.join(' '), /decm has no argument "thresholds"/);
  const lag = strict.d.checks.find((c: any) => c.id === '06A205a');
  assert.deepEqual(lag.threshold, { op: '<=', value: 2, source: DECM_PROFILES.strict.label });
  assert.equal(strict.d.profile, 'strict');
  assert.equal(strict.d.checks.find((c: any) => c.id === '06A209a').threshold.source, DECM_PROFILES.strict.label);
  // a few activities fit: no note
  const dir = mkdtempSync(join(tmpdir(), 'decm-'));
  const small = await call('open_file', { path: await B.saveXer(B.logicVariety(), dir, 'v.xer') });
  const sr = await call('decm', { handle: small.d.handle, status_date: '2026-01-20' });
  assert.equal(sr.err, false);
  assert.equal('activities_note' in sr.d.checks.find((c: any) => c.id === '06A209a'), false);
});
