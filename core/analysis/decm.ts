// decm: the DCMA DECM schedule checks (guidelines 6, 8 and 10), shaped like dcma_14, on the open file's own tables. Ported from our copy of the Bellator Schedule Intelligence benchmark ("Bellatorsi API/src/endpoints/
// forensics/dcmaDecm.ts": 17 checks, each a percentage of a population, grouped by guideline). The clone reuses what it has: the logic, lag and hard-constraint populations, the invalid dates (split in three) and the
// critical path test are dcma_14's; the baseline is baselineOf; out-of-sequence progress is the review rule; retroactive actual dates are progressIntegrity (core/diff.ts) between consecutive updates. A check with no
// population is not assessed (the source "skips" it), and so is one the file cannot supply an input for (no baseline, no data date, no earlier update, no SLPP or planning-package activity type in P6), with the reason.
// The threshold values are the source's, carried over as they are (dcmaDecm.ts:53-58); they have NOT been checked against the DCMA DECM workbook.
import { groupBy, rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { reportedPercent } from '../cost/rollup.ts';
import { startedBeforeFsPredecessor } from '../query/review.ts';
import { compareSchedules, progressIntegrity } from '../diff.ts';
import { dcma14, invalidDateFlags } from './dcma.ts';
import type { Update } from './delay.ts';
import { baselineOf, baselineFinish, isLoe, isWbs, makeScope, notAssessed, offender, passes, type CheckResult, type Offender, type Threshold } from './common.ts';
import { loopMessage, logicLoops, referenceStart } from './forensic.ts';

export type DecmId = '06A204b' | '06A205a' | '06A208a' | '06A209a' | '06A210a' | '06A212a' | '06A401a' | '06A501a' | '06A504a' | '06A504b' | '06A505a' | '06A505b' | '06A506a' | '06A506b' | '06A506c' | '08I101a' | '10A303a';
export const DECM_IDS: DecmId[] = ['06A204b', '06A205a', '06A208a', '06A209a', '06A210a', '06A212a', '06A401a', '06A501a', '06A504a', '06A504b', '06A505a', '06A505b', '06A506a', '06A506b', '06A506c', '08I101a', '10A303a'];
type Profile = Record<DecmId, number | null>;

/** The default thresholds, percent of the population allowed: 06A205a 5, 06A209a 5, 06A506c 10, every other 0 (06A401a has none: it is a test). dcmaDecm.ts:53-57. */
const DEFAULTS: Profile = { '06A204b': 0, '06A205a': 5, '06A208a': 0, '06A209a': 5, '06A210a': 0, '06A212a': 0, '06A401a': null, '06A501a': 0, '06A504a': 0, '06A504b': 0, '06A505a': 0, '06A505b': 0, '06A506a': 0, '06A506b': 0, '06A506c': 10, '08I101a': 0, '10A303a': 0 };
/** The strict profile differs from the default in three: 06A205a 2, 06A209a 2, 06A506c 5. dcmaDecm.ts:58. */
export const DECM_PROFILES: Record<string, { label: string; t: Profile }> = {
  default: { label: 'DECM default (Bellator benchmark values, not checked against the DCMA DECM workbook)', t: DEFAULTS },
  strict: { label: 'DECM strict (Bellator benchmark values, not checked against the DCMA DECM workbook)', t: { ...DEFAULTS, '06A205a': 2, '06A209a': 2, '06A506c': 5 } },
};
/** The check names. dcmaDecm.ts:60-68. */
const NAMES: Record<DecmId, string> = {
  '06A204b': 'Dangling starts/finishes', '06A205a': 'Lags', '06A208a': 'Summary tasks with logic', '06A209a': 'Hard constraints', '06A210a': 'LOE with discrete successors', '06A212a': 'Out-of-sequence progress',
  '06A401a': 'Critical path validity', '06A501a': 'Missing baseline dates', '06A504a': 'Actual start retroactively changed', '06A504b': 'Actual finish retroactively changed', '06A505a': 'In-progress missing actual start',
  '06A505b': 'Completed missing actual finish', '06A506a': 'Actual start after status date', '06A506b': 'Actual finish after status date', '06A506c': 'Incomplete forecast on/before status date',
  '08I101a': 'SLPP baseline duration integrity', '10A303a': 'PP baseline integrity',
};
/** The guideline of a check is the first two digits of its id; the names. dcmaDecm.ts:321-330. */
export const guidelineOf = (id: string) => parseInt(id.slice(0, 2), 10);
const GUIDELINES: Record<number, string> = { 6: 'Schedule (Guideline 6)', 8: 'Budgeting (Guideline 8)', 10: 'Accounting/Planning Package (Guideline 10)' };

export const DECM_METHOD = [
  'each check = the share (%) of its population that breaks the rule, judged on the exact share (shown to two decimals) and passing when it is at or under its threshold; a check with an empty population is not assessed (the source skips it, dcmaDecm.ts:266-271)',
  'thresholds (default): 06A205a lags 5 %, 06A209a hard constraints 5 %, 06A506c forecast on or before the status date 10 %, every other percentage check 0 % (dcmaDecm.ts:53-57); strict: 06A205a 2 %, 06A209a 2 %, 06A506c 5 % (:58). These values are the source’s and have not been checked against the DCMA DECM workbook.',
  'compliance ratio = checks passed / checks assessed (dcmaDecm.ts:223-224); overall fail when any check fails',
  'populations: 06A204b, 06A205a, 06A209a as dcma_14 checks 1, 3 and 5 (incomplete tasks; relationships of incomplete tasks); 06A506a/b/c are dcma_14 check 9 split in three (every activity that is not a WBS summary, in a project with a data date); 06A401a is dcma_14 check 12 (the critical path test; a loop fails it)',
  '06A208a: WBS summary activities with a relationship; 06A210a: level-of-effort activities with a successor that is neither level of effort nor a WBS summary; 06A212a, 06A501a, 06A504a/b, 06A505a/b: activities that are neither WBS summary nor level of effort',
];

export interface DecmCheck extends CheckResult { guideline: number }
export interface DecmOptions {
  projIds?: string[]; hoursPerDay?: number;
  /** default | strict */
  profile?: string;
  /** threshold overrides by check id (percent of the population) */
  thresholds?: Partial<Record<DecmId, number>>;
  /** project, bl1-bl3, or any saved baseline's name */
  baseline?: string;
  statusDate?: number | null;
  /** the series of schedules the retroactive-actuals checks read: the earlier updates and this project (last), from loadUpdates; absent = no earlier update */
  updates?: Update[];
}
export interface DecmReport {
  report: 'DCMA DECM schedule checks';
  profile: string; status_date: string | null; baseline: { which: string; name: string; how: string } | null;
  summary: { passed: number; failed: number; not_assessed: number; /** passed / (passed + failed); null when nothing was assessed */ compliance_ratio: number | null; overall: 'pass' | 'fail' | null };
  guidelines: { guideline: number; name: string; checks: string[]; passed: number; failed: number; not_assessed: number }[];
  checks: DecmCheck[];
  method: string[];
}

const dateOf = (u: Update) => { const p = rows(u.db, 'PROJECT').find((x) => x.proj_id === u.projId); return parseP6Date(p?.last_recalc_date || p?.plan_start_date) ?? null; };
/** An update as a database of its one project, as compareSchedules reads a file (a baseline copy held in the same database as the project is such an update: its rows are shown as a project of their own). */
function viewOf(u: Update): Db {
  const main = rows(u.db, 'PROJECT').filter((p) => !p._baseline_of);
  if (main.length === 1 && main[0].proj_id === u.projId) return u.db;
  const p = rows(u.db, 'PROJECT').find((x) => x.proj_id === u.projId)!;
  const { _baseline_of: _b, ...row } = p;
  const tasks = rows(u.db, 'TASK').filter((t) => t.proj_id === u.projId), ids = new Set(tasks.map((t) => t.task_id));
  const T = u.db.tables;
  return { tables: { ...T, PROJECT: { ...T.PROJECT, rows: [row] }, TASK: { ...T.TASK, rows: tasks }, TASKPRED: { ...T.TASKPRED, rows: rows(u.db, 'TASKPRED').filter((r) => ids.has(r.task_id)) }, TASKRSRC: { ...T.TASKRSRC, rows: rows(u.db, 'TASKRSRC').filter((r) => ids.has(r.task_id)) }, PROJWBS: { ...T.PROJWBS, rows: rows(u.db, 'PROJWBS').filter((w) => w.proj_id === u.projId) } } as Db['tables'] };
}

export function decm(db: Db, o: DecmOptions = {}): DecmReport {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, statusDate: o.statusDate, calendarDays: true });
  const prof = DECM_PROFILES[o.profile ?? 'default'] ?? DECM_PROFILES.default;
  const profName = DECM_PROFILES[o.profile ?? 'default'] ? (o.profile ?? 'default') : 'default';
  const th = (id: DecmId): Threshold | null => {
    const ov = o.thresholds?.[id];
    if (ov != null) return { op: '<=', value: ov, source: 'override' };
    const v = prof.t[id];
    return v == null ? null : { op: '<=', value: v, source: prof.label };
  };
  const which = o.baseline ?? 'project';
  const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(db, p, which)]));
  const out: DecmCheck[] = [];
  const add = (c: CheckResult) => out.push({ ...c, guideline: guidelineOf(c.id) });
  const na = (id: DecmId, note: string) => add(notAssessed(id, NAMES[id], '%', th(id), note));
  /** a percentage check: found of a population; an empty population is not assessed */
  const percent = (id: DecmId, found: Offender[], denominator: number, note: string, emptyNote: string) => {
    const t = th(id)!;
    if (!denominator) return na(id, emptyNote);
    // judged on the exact share, shown to two decimals: a threshold of 0 % is failed by one activity in any population (dcma_14 judges the same way now, common.ts percentCheck)
    const metric = Math.round((10000 * found.length) / denominator) / 100;
    add({ id, name: NAMES[id], unit: '%', metric, threshold: t, numerator: found.length, denominator, result: passes((100 * found.length) / denominator, t) ? 'pass' : 'fail', activities: found, total_activities: found.length, note });
  };

  // dcma_14 once, every activity listed: its logic, lag and hard-constraint populations and its critical path test are reused as they are
  const dcma = dcma14(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, statusDate: o.statusDate, baseline: o.baseline, maxIds: 0 });
  const D = (id: string) => dcma.checks.find((c) => c.id === id)!;
  const fromDcma = (id: DecmId, c: CheckResult, note: string, emptyNote: string) => percent(id, c.activities, c.denominator ?? 0, note, emptyNote);

  fromDcma('06A204b', D('logic'), 'Incomplete tasks (not WBS summary, level of effort or milestones) with no predecessor or no successor: dcma_14 check 1.', 'No incomplete task.');
  fromDcma('06A205a', D('lags'), 'Relationships (of incomplete tasks) with a positive lag, over those relationships: dcma_14 check 3.', 'No relationship of an incomplete task.');
  // 06A208a: WBS summary activities carrying logic
  {
    const W = s.tasks.filter(isWbs);
    const preds = (t: Row) => s.ctx.predsOf.get(t.task_id) ?? [], succs = (t: Row) => s.ctx.succsOf.get(t.task_id) ?? [];
    percent('06A208a', W.filter((t) => preds(t).length || succs(t).length).map((t) => offender(t, s)), W.length, 'WBS summary activities with a predecessor or a successor, over all WBS summary activities.', 'The project has no WBS summary activity.');
  }
  fromDcma('06A209a', D('hard_constraints'), 'Incomplete tasks with a hard constraint (Start/Finish On, On or Before, Mandatory): dcma_14 check 5.', 'No incomplete task.');
  // 06A210a: level of effort with a discrete successor
  {
    const L = s.tasks.filter(isLoe);
    const hit = L.filter((t) => (s.ctx.succsOf.get(t.task_id) ?? []).some((r) => { const x = s.ctx.taskById.get(r.task_id); return !!x && !isLoe(x) && !isWbs(x); }));
    percent('06A210a', hit.map((t) => offender(t, s)), L.length, 'Level-of-effort activities with a successor that is neither level of effort nor a WBS summary, over all level-of-effort activities.', 'The project has no level-of-effort activity.');
  }
  // the activities that are neither WBS summary nor level of effort (the source's "discrete" tasks, dcmaDecm.ts:107)
  const discrete = s.tasks.filter((t) => !isWbs(t) && !isLoe(t));
  percent('06A212a', discrete.filter((t) => startedBeforeFsPredecessor(t, s.ctx)).map((t) => offender(t, s)), discrete.length, 'Activities started while a finish-to-start predecessor has not finished, over all activities that are neither WBS summary nor level of effort.', 'The project has no activity.');
  // 06A401a: dcma_14 check 12; a loop fails it
  {
    const loops = logicLoops(s), c = D('critical_path_test');
    if (loops.length) add({ ...c, id: '06A401a', name: NAMES['06A401a'], result: 'fail', metric: null, activities: loops.flat().map((code) => ({ id: code, name: [...s.tasks].find((t) => t.task_code === code)?.task_name ?? '' })), total_activities: loops.flat().length, note: `The logic has ${loops.length === 1 ? 'a loop' : `${loops.length} loops`}, so there is no valid critical path (P6: "Circular relationship (loop) detected"): ${loops.map(loopMessage).join('; ')}.` });
    else add({ ...c, id: '06A401a', name: NAMES['06A401a'], note: `dcma_14 check 12, the critical path test. ${c.note ?? ''}`.trim() });
  }
  // 06A501a: missing baseline dates (an activity not in the baseline, or in it with no start or no finish)
  {
    const inBl = discrete.filter((t) => bls.get(t.proj_id));
    if (!inBl.length) na('06A501a', `No ${which === 'project' ? 'project' : which.toUpperCase()} baseline is assigned.`);
    else percent('06A501a', inBl.filter((t) => { const b = bls.get(t.proj_id)!.tasks.get(t.task_code); return !b || referenceStart(b) == null || baselineFinish(b) == null; }).map((t) => offender(t, s)), inBl.length,
      `Activities that are not in the ${bls.get(inBl[0].proj_id)!.name} baseline, or are in it without a start or a finish date, over all activities that are neither WBS summary nor level of effort${s.projs.some((p) => !bls.get(p.proj_id)) ? ` (projects with no such baseline are not assessed: ${s.projs.filter((p) => !bls.get(p.proj_id)).map((p) => p.proj_short_name).join(', ')})` : ''}.`, 'No activity.');
  }
  // 06A504a / 06A504b: an actual start / finish that differs from the one an earlier update held (progressIntegrity between consecutive updates, in data-date order)
  {
    const chain = [...(o.updates ?? [])].sort((x, y) => (dateOf(x) ?? 0) - (dateOf(y) ?? 0));
    if (chain.length < 2) { const why = 'No earlier update was given: pass updates (the earlier schedules, as windows_analysis takes them).'; na('06A504a', why); na('06A504b', why); }
    else {
      const start = new Map<string, Offender>(), finish = new Map<string, Offender>();
      for (let i = 1; i < chain.length; i++) {
        const a = viewOf(chain[i - 1]), b = viewOf(chain[i]);
        const f = progressIntegrity(a, b, compareSchedules(a, b, s.hpd, true)).retroactive_actuals;
        for (const x of f) { const m = x.field === 'actual_start' ? start : x.field === 'actual_finish' ? finish : null; if (m && !m.has(x.id)) m.set(x.id, { id: x.id, name: x.name ?? '', value: `${chain[i - 1].name}: ${x.a || '(blank)'} -> ${chain[i].name}: ${x.b || '(blank)'}` }); }
      }
      const series = chain.map((u) => u.name).join(' -> ');
      percent('06A504a', [...start.values()], discrete.length, `Activities whose actual start differs from the one an earlier update held (${series}), over the activities of this project that are neither WBS summary nor level of effort.`, 'No activity.');
      percent('06A504b', [...finish.values()], discrete.length, `Activities whose actual finish differs from the one an earlier update held (${series}), over the activities of this project that are neither WBS summary nor level of effort.`, 'No activity.');
    }
  }
  // 06A505a / 06A505b: progress with no actual start; complete with no actual finish
  {
    const asg = groupBy(db.tables.TASKRSRC?.rows ?? [], 'task_id');
    const p = (t: Row) => reportedPercent(t, asg.get(t.task_id) ?? []);
    percent('06A505a', discrete.filter((t) => !t.act_start_date && !t.act_end_date && ((p(t) > 0 && p(t) < 1) || t.status_code === 'TK_Active')).map((t) => offender(t, s)), discrete.length, 'Activities under way (a % complete above 0 and below 100, or the status Started) with no actual start, over all activities that are neither WBS summary nor level of effort.', 'No activity.');
    percent('06A505b', discrete.filter((t) => !t.act_end_date && (p(t) >= 1 || t.status_code === 'TK_Complete')).map((t) => offender(t, s)), discrete.length, 'Activities complete (100 %, or the status Completed) with no actual finish, over all activities that are neither WBS summary nor level of effort.', 'No activity.');
  }
  // 06A506a / b / c: dcma_14 check 9 (dcma.ts invalidDateFlags, the one rule) split in three, over the activities of the projects that have a data date
  {
    const { with_data_date: pop, flagged } = invalidDateFlags(s);
    if (!pop.length) { const why = `No data date in ${s.projs.map((p) => p.proj_short_name).join(', ')}: give a status_date.`; na('06A506a', why); na('06A506b', why); na('06A506c', why); }
    else {
      const w = 'over all activities that are not WBS summaries, in projects with a data date.';
      percent('06A506a', flagged.filter((f) => f.actual_start_after).map((f) => offender(f.task, s, 'actual start after the status date')), pop.length, `Activities with an actual start after the status date, ${w}`, '');
      percent('06A506b', flagged.filter((f) => f.actual_finish_after).map((f) => offender(f.task, s, 'actual finish after the status date')), pop.length, `Activities with an actual finish after the status date, ${w}`, '');
      percent('06A506c', flagged.filter((f) => f.forecast_before).map((f) => offender(f.task, s, 'forecast date before the status date')), pop.length, `Incomplete activities with a forecast start (not yet started) or finish before the status date, ${w}`, '');
    }
  }
  // 08I101a, 10A303a: P6 has no such activity types
  na('08I101a', 'P6 has no summary-level planning package (SLPP) activity type: there is nothing to assess.');
  na('10A303a', 'P6 has no planning-package activity type: there is nothing to assess.');

  const order = (c: DecmCheck) => DECM_IDS.indexOf(c.id as DecmId);
  out.sort((a, b) => order(a) - order(b));
  const passed = out.filter((c) => c.result === 'pass').length, failed = out.filter((c) => c.result === 'fail').length;
  const gs = [...new Set(out.map((c) => c.guideline))].sort((a, b) => a - b);
  const dd = s.projs.map((p) => s.dataDate(p.proj_id)).find((x) => x != null) ?? null;
  const first = [...bls.values()].find(Boolean);
  return {
    report: 'DCMA DECM schedule checks', profile: profName, status_date: dd != null ? formatP6Date(dd) : null, baseline: first ? { which, name: first.name, how: first.how } : null,
    summary: { passed, failed, not_assessed: out.length - passed - failed, compliance_ratio: passed + failed ? Math.round((passed / (passed + failed)) * 1000) / 1000 : null, overall: passed + failed ? (failed ? 'fail' : 'pass') : null },
    guidelines: gs.map((g) => { const cs = out.filter((c) => c.guideline === g); return { guideline: g, name: GUIDELINES[g] ?? `Guideline ${g}`, checks: cs.map((c) => c.id), passed: cs.filter((c) => c.result === 'pass').length, failed: cs.filter((c) => c.result === 'fail').length, not_assessed: cs.filter((c) => c.result === 'not_assessed').length }; }),
    checks: out, method: DECM_METHOD,
  };
}
