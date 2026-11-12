// The shared helpers of the benchmark-derived analyses (core/analysis/forensic.ts) against the source's own numbers (tests/fixtures/benchmark-golden.json, frozen from the Bellator copy's compute functions on its
// test fixtures; how: its _how), on the fixtures rebuilt as P6 projects (tests/benchmark-fixtures.ts: 7-day 24-hour calendar, so working days = the source's days). Where the clone's truer inputs give the same number, the
// test says equal; where they differ, the test states the difference and its reason. Then the update loader (mcp/analysis.ts loadUpdates) and the registration of the forensic tools (mcp/forensics.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rows } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { parseP6Date } from '../core/dates.ts';
import { makeScope } from '../core/analysis/common.ts';
import { lintScheduleTicked } from '../core/analysis/lint.ts';
import * as F from '../core/analysis/forensic.ts';
import * as B from './benchmark-fixtures.ts';
import { config, getSession, setRoots, ToolError, usedMemory } from '../mcp/runtime.ts';
import { loadUpdates } from '../mcp/analysis.ts';
import { FORENSIC_REGISTRY, forensicFiles, forensicNames, forensicReadsHandles, forensicTools, registerForensicTools, runForensics, type ForensicTool } from '../mcp/forensics.ts';
import { RESULT_FILE_TOOLS } from '../mcp/export.ts';
import { WORK } from '../mcp/workset.ts';
import { LISTED } from '../core/analysis/common.ts';

process.env.P6CLONE_COMPUTE_WORKERS = '0';
const root = mkdtempSync(join(tmpdir(), 'p6-forensic-'));
setRoots(null, root);

// the throwaway tool of the registration test, in the registry BEFORE the server module loads (the server lists the registry's tools when it loads)
const probe: ForensicTool = {
  name: 'forensic_probe', description: 'A probe of the registration wiring.', properties: { n: { type: 'number' }, mode: { type: 'string', enum: ['a', 'b'] } }, tables: ['rows (every row)'], readsFiles: ['updates[].path'], readsHandles: true,
  work: { per: 0.25, label: 'forensic_probe', hint: 'close other projects first' },
  run: (c) => {
    const all = Array.from({ length: Number(c.a.n ?? 60) }, (_, i) => ({ i, project: c.projIds.length }));
    return c.exported({ total: all.length, listed: c.listed, rows: c.first(all) }, { rows: all }, [{ name: 'rows', columns: ['i', 'project'], rows: all }]);
  },
};
FORENSIC_REGISTRY.push(probe);
registerForensicTools();

const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'benchmark-golden.json'), 'utf8'));
const G = (fixture: string, section: string) => golden[fixture][section];
const scopeOf = (b: B.Built, o: { statusDate?: number | null } = {}) => makeScope(b.db, { calendarDays: true, ...o });
const assessed = <T extends { result: string }>(x: T): Extract<T, { result: 'assessed' }> => { assert.equal(x.result, 'assessed', JSON.stringify(x)); return x as never; };
const ids = (l: { id: string }[]) => l.map((x) => x.id);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------------------------------------ the fixtures hold what the source says

/** The source's status of a score where higher is better (logicAudit.ts:180, progressAudit.ts:216: >= 90 pass, >= 70 warning, else fail). The clone has no use for it (no tool answers this status), so it lives here, to check the source's own statuses. */
const scoreStatus = (score: number): 'pass' | 'warning' | 'fail' => (score >= 90 ? 'pass' : score >= 70 ? 'warning' : 'fail');

test('fixtures: the P6 projects schedule to the source\'s CPM (7-day 24-hour calendar: working days = days), the loop is refused', () => {
  for (const [name, build] of [['cleanChain', B.cleanChain], ['withFloat', B.withFloat], ['withLogicIssues', B.withLogicIssues], ['overAllocated', B.overAllocated]] as const) {
    const b = build(), cpm = G(name, 'cpm');
    const finish = Math.max(...rows(b.db, 'TASK').filter((t) => t.proj_id === b.projId).map((t) => parseP6Date(t.early_end_date)!)) - parseP6Date('2026-01-05 00:00')!;
    assert.equal(finish / 1440, cpm.project_duration_days, `${name}: project duration`);
    for (const t of rows(b.db, 'TASK').filter((x) => x.proj_id === b.projId)) assert.equal(Number(t.total_float_hr_cnt) / 24, cpm.tasks[t.task_code].total_float, `${name} ${t.task_code}: total float`);
  }
  // the loop (source: its CPM reports it in cpm.cycles and goes on with best-effort timings): P6 refuses to schedule one, so the clone's answer is the refusal that names the loop, not numbers to compare
  assert.ok(G('withCycle', 'cpm').cycles.length > 0);
  const c = B.withCycle();
  const r = scheduleProjects(c.db, [c.projId], {});
  assert.equal(r.ok, false);
  assert.match(r.findings.map((f) => f.message).join(' '), /loop/i);
  assert.throws(() => B.project('LOOP', [{ id: 'X', duration_days: 1, predecessors: ['Y'] }, { id: 'Y', duration_days: 1, predecessors: ['X'] }]), /loop/i, 'an edit that closes a loop is refused');
});

// ------------------------------------------------------------------------------------------------ float figures

test('float figures: the source\'s counts and shares where the inputs coincide', () => {
  for (const [name, b] of [['cleanChain', B.cleanChain()], ['withFloat', B.withFloat()], ['withLogicIssues', B.withLogicIssues()], ['overAllocated', B.overAllocated()], ['gamingCurrent', B.gaming().current]] as const) {
    const f = assessed(F.floatFigures(scopeOf(b))), g = G(name, 'float_metrics');
    assert.equal(f.activities, g.total_tasks, name);
    assert.equal(f.critical, g.critical_count, `${name} critical`);
    assert.equal(f.negative_float, g.negative_float_count, `${name} negative`);
    assert.equal(f.near_critical, g.near_critical_count, `${name} near-critical`);
    assert.equal(f.critical_share, r3(g.critical_path_density), `${name} density`);
    assert.equal(f.erosion_share, r3(g.float_erosion_rate), `${name} erosion`);
  }
  // withLogicIssues: ORPHAN has 5 days of float = the near-critical limit (<= 5): near-critical in both
  assert.equal(assessed(F.floatFigures(scopeOf(B.withLogicIssues()))).near_critical, 1);
  // withFloat: C has 7 days of float: not near-critical (the limit is 5 working days)
  assert.equal(assessed(F.floatFigures(scopeOf(B.withFloat()))).near_critical, 0);
});

test('float figures: expected differences - finished work has no float to count; P6 float, not the source\'s CPM', () => {
  // delayed: the source runs its CPM over all three tasks (3 critical of 3); T1 is complete in the P6 file (no float), so the clone counts the two activities that still have float
  const f = assessed(F.floatFigures(scopeOf(B.delayed())));
  assert.equal(G('delayed', 'float_metrics').total_tasks, 3);
  assert.equal(f.activities, 2);
  assert.equal(f.critical, 2);
  // negative float: a constraint in the past makes P6's float negative (the source's simple CPM has no constraint dates)
  const n = B.project('NEG', [{ id: 'A', duration_days: 5 }, { id: 'B', duration_days: 5, predecessors: ['A'], constraint: { type: 'finish_on_or_before', date: '2026-01-08 00:00' } }]);
  const ff = assessed(F.floatFigures(scopeOf(n)));
  assert.equal(ff.negative_float, 2);
  assert.equal(ff.critical, 2, 'negative float is critical');
  // near-critical = not critical, 0 < float <= 5 working days; the limit can be given
  const w = scopeOf(B.withFloat());
  assert.equal(assessed(F.floatFigures(w, 7)).near_critical, 1);
  assert.equal(assessed(F.floatFigures(w, 6.99)).near_critical, 0);
});

test('float figures: not assessed without a stored float, or when everything is complete', () => {
  const c = B.withCycle(); // never scheduled: no total float
  const r = F.floatFigures(scopeOf(c));
  assert.equal(r.result, 'not_assessed');
  assert.match((r as { note: string }).note, /schedule the project/i);
  const done = B.project('DONE', [{ id: 'A', duration_days: 2 }], { ops: [{ op: 'update_activity', id: 'A', actual_start: '2026-01-05 00:00', actual_finish: '2026-01-07 00:00' }] });
  const d = F.floatFigures(scopeOf(done));
  assert.equal(d.result, 'not_assessed');
  assert.match((d as { note: string }).note, /no incomplete activity/i);
});

// ------------------------------------------------------------------------------------------------ logic figures

const sameLogic = (name: string, b: B.Built, g = G(name, 'logic_audit').data) => {
  const l = assessed(F.logicFigures(scopeOf(b)));
  assert.deepEqual(ids(l.open_starts), g.checks.open_starts, `${name} open starts`);
  assert.deepEqual(ids(l.open_finishes), g.checks.open_finishes, `${name} open finishes`);
  assert.deepEqual(ids(l.missing_logic), g.checks.missing_logic, `${name} missing logic`);
  assert.deepEqual(ids(l.leads), g.checks.leads, `${name} leads`);
  assert.deepEqual(ids(l.lags), g.checks.lags, `${name} lags`);
  assert.deepEqual(ids(l.hard_constraints), g.checks.hard_constraints, `${name} hard constraints`);
  assert.deepEqual(ids(l.redundant_links), g.checks.redundant_relationships.map((r: any) => `${r.predecessor} -> ${r.successor}`), `${name} redundant`);
  assert.equal(l.considered, g.summary.considered_tasks, `${name} considered`);
  assert.equal(l.relationships, g.summary.total_relationships, `${name} relationships`);
  assert.equal(l.fs_share, g.summary.fs_ratio, `${name} FS share`);
  assert.equal(l.open_ends, g.summary.open_ends_count, `${name} open ends`);
  return l;
};

test('logic figures: open ends, leads, lags, hard constraints, redundant links, link mix and the score equal the source\'s on every fixture the clone can hold', () => {
  for (const [name, b] of [['cleanChain', B.cleanChain()], ['withFloat', B.withFloat()], ['withLogicIssues', B.withLogicIssues()], ['delayed', B.delayed()], ['overAllocated', B.overAllocated()], ['logicVariety', B.logicVariety()]] as const) {
    const l = sameLogic(name, b);
    const g = G(name, 'logic_audit');
    assert.deepEqual(ids(l.out_of_sequence), g.data.checks.out_of_sequence, `${name} out of sequence`);
    assert.equal(l.score, g.data.logic_score, `${name} score`);
    assert.equal(l.grade, g.data.grade, `${name} grade`);
    assert.equal(scoreStatus(l.score), g.status, `${name} status`);
  }
});

test('logic figures: logicVariety - a lag, a lead, SS and FF, two hard constraints, a redundant link of any type (the lint check stays FS only)', () => {
  const b = B.logicVariety(), l = assessed(F.logicFigures(scopeOf(b)));
  assert.deepEqual([l.fs, l.ss, l.ff, l.sf], [6, 2, 1, 0]);
  assert.deepEqual(ids(l.leads), ['D']);
  assert.deepEqual(ids(l.lags), ['C']);
  assert.deepEqual(ids(l.hard_constraints), ['B', 'E'], 'Start On and Finish On or Before are hard; Start On or After on A is not');
  assert.deepEqual(ids(l.redundant_links), ['S -> D', 'D -> F'], 'S -> D is an SS link reached through S -> A -> B -> D');
  // lint's own redundant check (FS links reached through FS paths, lag 0) finds only D -> F
  return lintScheduleTicked(b.db, { projIds: [b.projId], profile: 'platform', checks: ['redundant_links'], simulate: false, maxIds: 0 }, async () => {}).then((r) => {
    const c = r.checks.find((x) => x.id === 'redundant_links')!;
    assert.equal(c.total_activities, 1);
    assert.equal(c.activities[0].id, 'D -> F');
  });
});

test('logic figures: out-of-sequence progress follows the review rule (a start while a finish-to-start predecessor is open)', () => {
  // gamingStarted: T2 has an actual start while T1 is 60%: out of sequence in the source and here, score 0 in both
  sameLogic('gamingStarted', B.gamingStarted(), G('gaming', 'logic_audit_t2_started').data);
  const l = assessed(F.logicFigures(scopeOf(B.gamingStarted())));
  assert.deepEqual(ids(l.out_of_sequence), ['T2']);
  assert.equal(l.score, G('gaming', 'logic_audit_t2_started').data.logic_score);
  // expected difference: the source's gamingCurrent has T2 at 25% (so "progressed"); in the P6 file T2 has no actual start, so it has not started and is not out of sequence (the progress audit reports the missing start instead)
  assert.deepEqual(G('gamingCurrent', 'logic_audit').data.checks.out_of_sequence, ['T2']);
  const c = assessed(F.logicFigures(scopeOf(B.gaming().current)));
  assert.deepEqual(ids(c.out_of_sequence), []);
  // the same rule as review: a started successor of an unfinished FS predecessor; an SS predecessor is not a breach
  const ss = B.project('SS', [{ id: 'A', duration_days: 5 }, { id: 'B', duration_days: 5, predecessors: ['A:SS'] }], { dataDate: '2026-01-07', ops: [{ op: 'update_activity', id: 'B', actual_start: '2026-01-06 00:00' }] });
  assert.deepEqual(ids(assessed(F.logicFigures(scopeOf(ss))).out_of_sequence), []);
});

test('logic figures: the loop - the helpers terminate on it (the clone reports the loop when it schedules, see the fixture test)', () => {
  const l = assessed(F.logicFigures(scopeOf(B.withCycle())));
  assert.equal(l.open_ends, 0);
  assert.equal(l.relationships, 3);
  assert.ok(F.redundantLinks(rows(B.withCycle().db, 'TASKPRED')).length >= 0);
});

test('logic figures: not assessed with nothing to assess; the FS share of no relationships is not 1', () => {
  const none = B.project('NONE', []);
  assert.equal(F.logicFigures(scopeOf(none)).result, 'not_assessed');
  const alone = assessed(F.logicFigures(scopeOf(B.project('ALONE', [{ id: 'A', duration_days: 1 }]))));
  assert.equal(alone.relationships, 0);
  assert.equal(alone.fs_share, null, 'the source answers 1 here');
  assert.deepEqual(ids(alone.missing_logic), ['A']);
});

// ------------------------------------------------------------------------------------------------ progress anomalies

test('progress anomalies: the source\'s score where the P6 file reads the same', () => {
  for (const [name, fixture, b] of [['cleanChain', 'cleanChain', B.cleanChain()], ['delayed', 'delayed', B.delayed()]] as const) {
    const p = assessed(F.progressAnomalies(scopeOf(b))), g = G(fixture, 'progress_audit_status_2026_01_20').data;
    assert.equal(p.examined, g.audit_metadata.tasks_examined, `${name} examined (milestones excluded)`);
    assert.equal(p.anomalies.length, g.summary.total, name);
    assert.equal(p.integrity_score, g.integrity_score, name);
    assert.equal(p.grade, g.grade, name);
  }
  // gamingStarted = the source's variant with T2 started: out of sequence only, high 0.7 over 2 activities = 65
  const s = assessed(F.progressAnomalies(scopeOf(B.gamingStarted()))), g = G('gaming', 'progress_audit_t2_started_status_2026_01_29');
  assert.deepEqual(s.anomalies.map((a) => [a.rule, a.id, a.severity, a.predecessor]), g.data.anomalies.map((a: any) => [a.type, a.task_id, a.severity, a.predecessor_id]));
  assert.equal(s.integrity_score, g.data.integrity_score);
  assert.equal(scoreStatus(s.integrity_score), g.status);
});

test('progress anomalies: progress with no actual start reads the raw %; the out-of-sequence part of the source\'s gamingCurrent needs a start', () => {
  // the source: T2 at 25% with no actual start = missing_actual_start (medium 0.4) + out_of_sequence (high 0.7) -> 45. In the P6 file the second does not apply (T2 has not started: the review rule): 1 - 0.4/2 = 80.
  const g = G('gaming', 'progress_audit_status_2026_01_29').data;
  assert.deepEqual(g.anomalies.map((a: any) => a.type), ['missing_actual_start', 'out_of_sequence']);
  assert.equal(g.integrity_score, 45);
  const p = assessed(F.progressAnomalies(scopeOf(B.gaming().current)));
  assert.deepEqual(p.anomalies.map((a) => [a.rule, a.id, a.severity]), [['missing_actual_start', 'T2', 'medium']]);
  assert.equal(p.integrity_score, 80);
  // percentComplete reads 0 without a start (the cost rollups), the raw % is the file's own
  const t2 = rows(B.gaming().current.db, 'TASK').find((t) => t.task_code === 'T2')!;
  assert.equal(t2.phys_complete_pct, '25');
});

test('progress anomalies: each rule alone, with its severity and the score by hand', () => {
  // a 5-activity project at data date 2026-01-20; examined = 5 (the milestone is not examined), the score is 100 * (1 - sum of weights / 5)
  const mk = () => B.project('RULES', [
    { id: 'A', duration_days: 5 }, { id: 'B', duration_days: 5, predecessors: ['A'] }, { id: 'C', duration_days: 5 }, { id: 'D', duration_days: 5 }, { id: 'E', duration_days: 5 }, { id: 'M', duration_days: 0, task_type: 'milestone', predecessors: ['E'] }], { dataDate: '2026-01-20' });
  const T = (b: B.Built, code: string) => rows(b.db, 'TASK').find((t) => t.proj_id === b.projId && t.task_code === code)!;
  const b = mk();
  T(b, 'A').act_start_date = '2026-01-25 00:00'; // 001: an actual start after the data date (high 0.7)
  T(b, 'C').act_start_date = '2026-01-10 00:00'; T(b, 'C').act_end_date = '2026-01-09 00:00'; // 002: finish before start (critical 1.0); also 001? no: both before the data date
  T(b, 'D').complete_pct_type = 'CP_Phys'; T(b, 'D').phys_complete_pct = '30'; // 003: progress with no actual start (medium 0.4)
  T(b, 'E').act_start_date = '2026-01-12 00:00'; // started, then: 005: unfinished work with a forecast finish before the data date (medium 0.4)
  T(b, 'E').reend_date = '2026-01-15 00:00';
  T(b, 'B').act_start_date = '2026-01-18 00:00'; // 004: started while A (FS) has not finished (high 0.7)
  const p = assessed(F.progressAnomalies(scopeOf(b)));
  const by = (rule: string) => p.anomalies.filter((a) => a.rule === rule).map((a) => a.id);
  assert.deepEqual(by('future_actuals'), ['A']);
  assert.deepEqual(by('invalid_sequence'), ['C']);
  assert.deepEqual(by('missing_actual_start'), ['D']);
  assert.deepEqual(by('out_of_sequence'), ['B']);
  assert.deepEqual(by('forecast_in_past'), ['E']);
  assert.equal(p.examined, 5);
  assert.deepEqual(p.by_severity, { critical: 1, high: 2, medium: 2, low: 0 });
  assert.equal(p.integrity_score, F.gradeOf(0) && Math.round(100 * (1 - (1.0 + 0.7 * 2 + 0.4 * 2) / 5) * 10) / 10, '(1.0 + 1.4 + 0.8) / 5 = 0.64 -> 36');
  assert.equal(p.integrity_score, 36);
  assert.equal(p.grade, 'F');
  // a completed activity is not unfinished work: its dates are not forecasts
  T(b, 'E').act_end_date = '2026-01-14 00:00';
  assert.deepEqual(assessed(F.progressAnomalies(scopeOf(b))).anomalies.filter((a) => a.rule === 'forecast_in_past'), []);
});

test('progress anomalies: not assessed without a data date; a status date makes it assessable', () => {
  const b = B.cleanChain();
  for (const p of rows(b.db, 'PROJECT')) p.last_recalc_date = '';
  const r = F.progressAnomalies(scopeOf(b));
  assert.equal(r.result, 'not_assessed');
  assert.match((r as { note: string }).note, /No data date in CLEAN/);
  const ok = assessed(F.progressAnomalies(scopeOf(b, { statusDate: parseP6Date('2026-01-05 00:00') })));
  assert.equal(ok.integrity_score, 100);
  assert.deepEqual(ok.projects_without_data_date, []);
  // a scope of two projects, one without a data date: the one with is examined, the other is named
  const two = B.cleanChain();
  applyOps(two.db, [{ op: 'add_project', id: 'NODD', start: '2026-02-02' }, { op: 'add_activity', id: 'Z', name: 'Z', duration_days: 3, project: 'NODD' }]);
  rows(two.db, 'PROJECT').find((p) => p.proj_short_name === 'NODD')!.last_recalc_date = '';
  const t = assessed(F.progressAnomalies(makeScope(two.db, { calendarDays: true })));
  assert.deepEqual(t.projects_without_data_date, ['NODD']);
  assert.equal(t.examined, 3);
});

// ------------------------------------------------------------------------------------------------ variance

test('variance: finish variance and slip class equal the source\'s; the clone has the start and duration the source\'s typed numbers leave out', () => {
  const b = B.delayed(), s = scopeOf(b);
  const bp = assessed(F.baselinePairs(s));
  assert.equal(bp.name, 'BL');
  const v = Object.fromEntries(F.varianceRows(s, bp).map((x) => [x.id, x]));
  const g = Object.fromEntries((G('delayed', 'variance') as any[]).map((x) => [x.task_id, x]));
  const slip: Record<string, string> = { on_time: 'on_time', minor_slip: 'minor_slip' };
  for (const id of ['T1', 'T2', 'T3']) {
    assert.equal(v[id].finish_variance_days, g[id].finish_variance_days, `${id} finish variance`);
    assert.equal(v[id].slip_class, slip[g[id].slip_class], `${id} slip class`);
  }
  for (const id of ['T1', 'T2']) { assert.equal(v[id].start_variance_days, g[id].start_variance_days, `${id} start`); assert.equal(v[id].duration_variance_days, g[id].duration_variance_days, `${id} duration`); }
  // T3: the source has no forecast start for it (null); P6 always has one (the early start after T2: 31 Jan against the baseline 26 Jan = +5), and so a duration (10 d against 10 d = 0)
  assert.equal(g.T3.start_variance_days, null);
  assert.equal(g.T3.duration_variance_days, null);
  assert.equal(v.T3.start_variance_days, 5);
  assert.equal(v.T3.duration_variance_days, 0);
  assert.equal(v.T2.current_finish, '2026-01-31 00:00');
  assert.equal(v.T2.reference_finish, '2026-01-26 00:00');
});

test('variance: the slip classes (< 0 ahead, 0 on time, <= 5, <= 15, <= 30, more)', () => {
  assert.deepEqual([-1, 0, 0.5, 5, 5.01, 15, 15.5, 30, 30.01, 400].map(F.slipClassOf), ['ahead', 'on_time', 'minor_slip', 'minor_slip', 'moderate_slip', 'moderate_slip', 'major_slip', 'major_slip', 'severe_slip', 'severe_slip']);
});

test('variance: working days on the activity\'s calendar (Monday to Friday, 8 hours): a finish pushed over a weekend is 1 working day, not 3', () => {
  const db = { tables: {} } as B.Built['db'];
  const r = applyOps(db, [
    { op: 'add_project', id: 'WK', start: '2026-03-02' }, { op: 'add_activity', id: 'A', name: 'A', duration_days: 5 },
    { op: 'build_baseline', name: 'BL', assign_as: 'project', activities: [{ activity: 'A', start: '2026-03-02 08:00', finish: '2026-03-06 17:00', duration_days: 5 }] },
    { op: 'add_activity', id: 'N', name: 'New', duration_days: 2 }, { op: 'update_activity', id: 'A', duration_days: 6 }], { calendarDays: true });
  assert.ok(r.ok, JSON.stringify(r.error));
  const pid = rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
  assert.ok(scheduleProjects(db, [pid], {}).ok);
  const s = makeScope(db, { calendarDays: true }), bp = assessed(F.baselinePairs(s)), v = Object.fromEntries(F.varianceRows(s, bp).map((x) => [x.id, x]));
  assert.equal(v.A.reference_finish, '2026-03-06 17:00');
  assert.equal(v.A.current_finish, '2026-03-09 17:00');
  assert.equal(v.A.finish_variance_days, 1, 'Friday 17:00 to Monday 17:00 = 1 working day (3 calendar days)');
  assert.equal(v.A.duration_variance_days, 1);
  assert.equal(v.A.slip_class, 'minor_slip');
  // an activity added after the baseline has no counterpart: no variance, no class
  assert.equal(v.N.finish_variance_days, null);
  assert.equal(v.N.slip_class, null);
  assert.equal(v.N.reference_finish, null);
});

test('variance: against another schedule (an as-planned schedule, an earlier update), matched by Activity ID; not assessed without a baseline', () => {
  const plan = B.cleanChain(), now = B.cleanChain();
  applyOps(now.db, [{ op: 'update_activity', id: 'T2', duration_days: 14 }], { calendarDays: true });
  assert.ok(scheduleProjects(now.db, [now.projId], {}).ok);
  const s = scopeOf(now);
  const sp = assessed(F.schedulePairs(s, { name: 'As planned', db: plan.db, projId: plan.projId }));
  const v = Object.fromEntries(F.varianceRows(s, sp).map((x) => [x.id, x]));
  assert.equal(v.T1.finish_variance_days, 0);
  assert.equal(v.T2.finish_variance_days, 4);
  assert.equal(v.T3.start_variance_days, 4);
  assert.equal(v.M1.finish_variance_days, 4);
  assert.equal(v.T2.duration_variance_days, 4);
  // no baseline in the file: not assessed, with the reason (as dcma_14 words it)
  const nb = F.baselinePairs(scopeOf(B.cleanChain()));
  assert.equal(nb.result, 'not_assessed');
  assert.match((nb as { note: string }).note, /No project baseline is assigned/);
  assert.equal(F.baselinePairs(s, 'bl2').result, 'not_assessed');
});

// ------------------------------------------------------------------------------------------------ the grade and band tables

test('grades and bands: the source\'s tables, against the numbers it produced', () => {
  for (const f of ['cleanChain', 'withFloat', 'withLogicIssues', 'delayed', 'overAllocated', 'logicVariety']) {
    const a = G(f, 'logic_audit');
    assert.equal(F.gradeOf(a.data.logic_score), a.data.grade, f);
    assert.equal(scoreStatus(a.data.logic_score), a.status, f);
  }
  for (const f of ['cleanChain', 'withFloat', 'withLogicIssues', 'delayed', 'gamingCurrent', 'overAllocated']) {
    const r = G(f, 'risk_index_status'), idx = r.data.schedule_risk_index;
    assert.equal(F.riskLevelOf(idx.score), idx.risk_level, `${f} level`);
    assert.equal(F.riskGradeOf(idx.score), idx.grade, `${f} grade`);
    assert.equal(F.riskStatusOf(idx.score), r.status, `${f} status`);
    const ra = G(f, 'resource_analysis');
    assert.equal(F.riskStatusOf(100 - ra.score), ra.status, `${f} resource status`);
  }
  assert.deepEqual([95, 90, 89.9, 80, 79.9, 70, 69.9, 60, 59.9, 0].map(F.gradeOf), ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']);
  assert.equal(F.gradeOf(null), null);
  assert.equal(F.gradeOf(NaN), null);
  assert.deepEqual([0, 19.9, 20, 39.9, 40, 59.9, 60, 79.9, 80, 100].map(F.riskLevelOf), ['low', 'low', 'moderate', 'moderate', 'elevated', 'elevated', 'high', 'high', 'critical', 'critical']);
  assert.deepEqual([[89.9, 'warning'], [90, 'pass'], [69.9, 'fail'], [70, 'warning']].map(([v]) => scoreStatus(v as number)), ['warning', 'pass', 'fail', 'warning']);
  assert.deepEqual([19.9, 20, 49.9, 50].map(F.riskStatusOf), ['pass', 'warning', 'warning', 'fail']);
});

// ------------------------------------------------------------------------------------------------ the update loader

const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const open = async (b: B.Built) => {
  const dir = mkdtempSync(join(root, 'u-'));
  const path = await B.saveXer(b, dir, `${b.id}.xer`);
  const o = await call('open_file', { path });
  assert.equal(o.err, false, JSON.stringify(o.d).slice(0, 300));
  return { handle: o.d.handle as string, path };
};
const helpers = { dd: (v: unknown) => (typeof v === 'string' ? parseP6Date(v.length <= 10 ? `${v} 00:00` : v) : null) };
const refusal = (f: () => unknown) => { try { f(); } catch (e) { assert.ok(e instanceof ToolError); return { code: e.code, message: e.message }; } assert.fail('not refused'); };

test('loadUpdates: handles, files, baselines and progress updates in the order given, the current project last; refusals; memory given back', async () => {
  const cur = await open(B.delayed()), other = await open(B.cleanChain());
  const s = getSession(cur.handle);
  const before = usedMemory();
  const l = loadUpdates({ updates: [{ handle: other.handle, name: 'Other' }, { path: other.path }, { baseline: 'project' }, { data_date: '2026-01-25', name: 'Progress', progress: [{ op: 'update_activity', id: 'T2', remaining_days: 4 }] }], project: undefined }, s, helpers, { tool: 'windows_analysis', includeCurrent: true });
  assert.deepEqual(l.updates.map((u) => u.name), ['Other', other.path, 'BL', 'Progress', 'current']);
  assert.equal(l.updates[0].db, getSession(other.handle).db);
  assert.equal(l.updates.at(-1)!.db, s.db);
  assert.ok(usedMemory() > before, 'the file read and the copy built are held');
  l.release();
  assert.equal(usedMemory(), before, 'and given back');
  assert.deepEqual(loadUpdates({ updates: [{ baseline: 'project' }], current_name: 'x' }, s, helpers, { tool: 't', includeCurrent: false }).updates.map((u) => u.name), ['BL']);
  assert.equal(loadUpdates({ updates: [{ baseline: 'project' }] }, s, helpers, { tool: 't', includeCurrent: true, currentName: 'Now' }).updates.at(-1)!.name, 'Now');
  // the refusals (what windows_analysis has always said)
  assert.equal(refusal(() => loadUpdates({ updates: [] }, s, helpers, { tool: 't', includeCurrent: true })).message, 'updates must list the other updates.');
  assert.equal(refusal(() => loadUpdates({}, s, helpers, { tool: 't', includeCurrent: true })).code, 'bad_input');
  assert.match(refusal(() => loadUpdates({ updates: [{ baseline: 'bl3' }] }, s, helpers, { tool: 't', includeCurrent: true })).message, /The project has no bl3 baseline in this file\./);
  assert.match(refusal(() => loadUpdates({ updates: [{ nothing: 1 }] }, s, helpers, { tool: 't', includeCurrent: true })).message, /updates\[0\] needs handle, path, baseline, or data_date with progress\./);
  assert.match(refusal(() => loadUpdates({ updates: [{ data_date: 'x', progress: [] }] }, s, helpers, { tool: 't', includeCurrent: true })).message, /updates\[0\]\.data_date is not a date\./);
  assert.match(refusal(() => loadUpdates({ updates: [{ data_date: '2026-01-25', progress: [{ op: 'update_activity', id: 'NOPE', duration_days: 1 }] }] }, s, helpers, { tool: 't', includeCurrent: true })).message, /updates\[0\] operation 1:/);
  assert.match(refusal(() => loadUpdates({ updates: [{ baseline: 'project' }], project: 'NOPE' }, s, helpers, { tool: 't', includeCurrent: true })).message, /No project "NOPE"\./);
  // a refusal part-way gives back what the earlier updates held
  assert.equal(usedMemory(), before);
  const half = () => loadUpdates({ updates: [{ path: other.path }, { nothing: 1 }] }, s, helpers, { tool: 't', includeCurrent: true });
  refusal(half);
  assert.equal(usedMemory(), before, 'a refusal after a file was read releases it');
});

// ------------------------------------------------------------------------------------------------ the registration of the forensic tools

test('registration: one entry in the registry gives a tool its definition, files, handles, work and result files; the runner finds it by name', () => {
  const defs = forensicTools([probe], (s) => ({ ...s, withHandle: true }));
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'forensic_probe');
  assert.deepEqual(defs[0].annotations, { readOnlyHint: true, openWorldHint: false });
  assert.match(defs[0].description, /^A probe of the registration wiring\. The whole result is written to files every time/);
  assert.match(defs[0].description, /forensic_probe\.json/);
  assert.match(defs[0].description, /forensic_probe-rows\.csv/);
  assert.deepEqual(Object.keys((defs[0].inputSchema as any).properties), ['export', 'export_name', 'project', 'n', 'mode']);
  assert.deepEqual(forensicFiles([probe]), { forensic_probe: { read: ['updates[].path'], opens: false } });
  assert.deepEqual([...forensicNames([probe])], ['forensic_probe']);
  assert.equal(forensicReadsHandles('forensic_probe', [probe]), true);
  assert.equal(forensicReadsHandles('lint', [probe]), false);
  assert.ok(RESULT_FILE_TOOLS.has('forensic_probe'), 'its result is written to files every time');
  assert.equal(WORK.forensic_probe.per, 0.25);
  return runForensics('lint', {}, {} as never, {} as never, [probe]).then((r) => assert.equal(r, undefined, 'not its tool: undefined, the server tries the next group'));
});

test('registration, end to end through the server: listed read-only, run on a project, whole result in files by default, 25 listed, arguments_not_used, enum checked, no handle refused', async () => {
  const { toolsList } = await import('../mcp/server.ts');
  const t = (toolsList() as any[]).find((x) => x.name === 'forensic_probe');
  assert.ok(t, 'the registry\'s tool is in the server\'s list');
  assert.equal(t.annotations.readOnlyHint, true);
  assert.deepEqual(t._meta, { 'whiq/files': { read: ['updates[].path'], opens: false } });
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['handle', 'export', 'export_name', 'project', 'n', 'mode', 'caller', 'async']);
  const h = await open(B.cleanChain());
  const r = await call('forensic_probe', { handle: h.handle, n: 60, bogus: 1 });
  assert.equal(r.err, false, JSON.stringify(r.d).slice(0, 300));
  assert.equal(r.d.total, 60);
  assert.equal(r.d.listed, LISTED);
  assert.equal(r.d.rows.length, LISTED, 'the clone\'s list rule');
  assert.equal(r.d.arguments_not_used.length, 1);
  assert.match(r.d.arguments_not_used[0], /^forensic_probe has no argument "bogus": it was not used and the call ran without it\. Its arguments are: handle, export, export_name, project, n, mode, caller, async\.$/);
  // the whole result without being asked, in the default result folder (analysis/<project>/<tool>)
  assert.ok(r.d.exported.folder.replace(/\\/g, '/').endsWith('analysis/CLEAN__CLEAN/forensic_probe') || /analysis\/CLEAN/.test(r.d.exported.folder.replace(/\\/g, '/')), r.d.exported.folder);
  const csv = r.d.exported.files.find((f: any) => f.path.endsWith('-rows.csv'));
  assert.equal(csv.rows, 60, 'the file has every row');
  assert.ok(existsSync(csv.path));
  assert.equal(JSON.parse(readFileSync(r.d.exported.files.find((f: any) => f.path.endsWith('forensic_probe.json')).path, 'utf8')).rows.length, 60);
  // the screens' rule (config.screens: 0 = all) is the analysis tools' too
  config.screens = true;
  try { assert.equal((await call('forensic_probe', { handle: h.handle, n: 60 })).d.rows.length, 60); } finally { config.screens = false; }
  // the server's own checks of a tool's arguments apply (an enum value), and an unknown handle is refused
  const bad = await call('forensic_probe', { handle: h.handle, mode: 'z' });
  assert.equal(bad.err, true);
  assert.match(bad.d.error.message, /mode "z" is not an accepted value\. mode is one of: a, b\./);
  assert.equal((await call('forensic_probe', { handle: 'nope' })).err, true);
  // an explicit export folder is held to the write root
  assert.equal((await call('forensic_probe', { handle: h.handle, export: '/etc/forensic' })).err, true);
});

test('the five benchmark tools have a measured memory entry (workset.ts WORK): each reserves per x the project\'s bytes before it runs', async () => {
  const { workNeed, WORK } = await import('../mcp/workset.ts');
  const s = { db: { tables: { TASK: { rows: [] }, PROJECT: { rows: [] } } }, bytes: 20 * 1048576 } as never;
  const per: Record<string, number> = { schedule_index: 1.7, planning_horizon: 1.2, decm: 2.8, change_tracking: 2.3, baseline_variance: 2.1 };
  for (const [tool, p] of Object.entries(per)) {
    assert.equal(WORK[tool].per, p, tool);
    const need = workNeed(tool, {}, s, () => Infinity)!;
    assert.equal(need.bytes, Math.round(p * 20 * 1048576), tool);
    assert.match(need.what, new RegExp(`^${tool} on this project`));
  }
});
