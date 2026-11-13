// decm: the DCMA DECM schedule checks (guidelines 6, 8 and 10), shaped like dcma_14, on the open file's own tables. Ported from our copy of the Bellator Schedule Intelligence benchmark ("Bellatorsi API/src/endpoints/
// forensics/dcmaDecm.ts": 17 checks, each a percentage of a population, grouped by guideline). The clone reuses what it has: the logic, lag and hard-constraint checks, the invalid dates (split in three) and the
// critical path test are dcma_14's own functions (dcma.ts), called one by one (not the whole of dcma_14); the baseline is baselineOf; out-of-sequence progress is the review rule; retroactive actual dates are progressIntegrity (core/diff.ts) between consecutive updates. A check with no
// population is not assessed (the source "skips" it), and so is one the file cannot supply an input for (no baseline, no data date, no earlier update, no SLPP or planning-package activity type in P6), with the reason.
// The threshold values are the source's, carried over as they are (dcmaDecm.ts:53-58); they have NOT been checked against the DCMA DECM workbook. The profile (default | strict) is the only way to change them.
import { groupBy, rows, type Db, type Row } from '../db.ts';
import { baselineReason, loopNote, noDataDateReason, projectsText, notAssessed as notAssessedNote } from '../notes.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { reportedPercent } from '../cost/rollup.ts';
import { startedBeforeFsPredecessor } from '../query/review.ts';
import { compareSchedules, progressIntegrity } from '../diff.ts';
import { CPT_SLIP_DAYS, criticalPathTest, dcmaPopulations, hardConstraintsCheck, invalidDateFlags, lagsCheck, logicCheck } from './dcma.ts';
import type { Update } from './delay.ts';
import { baselineOf, baselineFinish, namesText, isLoe, isWbs, dateFields, checkNotes, makeScope, notAssessed, offender, passes, type CheckResult, type Offender, type Threshold } from './common.ts';
import { loopMessage, logicLoops, referenceStart, updateDate, updateView } from './forensic.ts';

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
  '06A505b': 'Completed missing actual finish', '06A506a': 'Actual start after status date', '06A506b': 'Actual finish after status date', '06A506c': 'Incomplete forecast before the data date',
  '08I101a': 'SLPP baseline duration integrity', '10A303a': 'PP baseline integrity',
};
/** The guideline of a check is the first two digits of its id; the names. dcmaDecm.ts:321-330. */
export const guidelineOf = (id: string) => parseInt(id.slice(0, 2), 10);
const GUIDELINES: Record<number, string> = { 6: 'Schedule (Guideline 6)', 8: 'Budgeting (Guideline 8)', 10: 'Accounting/Planning Package (Guideline 10)' };


export interface DecmCheck extends CheckResult { guideline: number }
export interface DecmOptions {
  projIds?: string[]; hoursPerDay?: number;
  /** default | strict */
  profile?: string;
  /** project, bl1-bl3, or any saved baseline's name */
  baseline?: string;
  statusDate?: number | null;
  /** the series of schedules the retroactive-actuals checks read: this project and the other updates, from loadUpdates (put in data-date order here); absent = no other update */
  updates?: Update[];
}
export interface DecmReport {
  report: 'DCMA DECM schedule checks';
  profile: string; status_date: string | null; baseline: { which: string; name: string; how: string } | null;
  /** the series the retroactive-actuals checks read, in the data-date order used (empty when no updates were given) */
  updates: { name: string; data_date: string | null; open_project: boolean }[];
  summary: { passed: number; failed: number; not_assessed: number; /** passed / (passed + failed); null when nothing was assessed */ compliance_ratio: number | null; overall: 'pass' | 'fail' | null };
  guidelines: { guideline: number; name: string; checks: string[]; passed: number; failed: number; not_assessed: number }[];
  checks: DecmCheck[];
  /** every sentence the checks and the data dates have to say, once */
  notes: string[];
}

export function decm(db: Db, o: DecmOptions = {}): DecmReport {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, statusDate: o.statusDate, calendarDays: true });
  const prof = DECM_PROFILES[o.profile ?? 'default'] ?? DECM_PROFILES.default;
  const profName = DECM_PROFILES[o.profile ?? 'default'] ? (o.profile ?? 'default') : 'default';
  const th = (id: DecmId): Threshold | null => {
    const v = prof.t[id];
    return v == null ? null : { op: '<=', value: v, source: prof.label };
  };
  const which = o.baseline ?? 'project';
  const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(db, p, which)]));
  const out: DecmCheck[] = [];
  const ordered = [...(o.updates ?? [])].sort((x, y) => (updateDate(x) ?? 0) - (updateDate(y) ?? 0));
  const add = (c: CheckResult) => out.push({ ...c, guideline: guidelineOf(c.id) });
  const na = (id: DecmId, reason: string) => add(reason.startsWith('Not assessed: ') ? { ...notAssessed(id, NAMES[id], '%', th(id), ''), note: reason } : notAssessed(id, NAMES[id], '%', th(id), reason));
  /** a percentage check: found of a population; an empty population is not assessed */
  const percent = (id: DecmId, found: Offender[], denominator: number, emptyNote: string) => {
    const t = th(id)!;
    if (!denominator) return na(id, emptyNote);
    // judged on the exact share, shown to two decimals: a threshold of 0 % is failed by one activity in any population (dcma_14 judges the same way now, common.ts percentCheck)
    const metric = Math.round((10000 * found.length) / denominator) / 100;
    add({ id, name: NAMES[id], unit: '%', metric, threshold: t, numerator: found.length, denominator, result: passes((100 * found.length) / denominator, t) ? 'pass' : 'fail', activities: found, total_activities: found.length });
  };

  // dcma_14's own checks, one by one with every activity listed (not the whole of dcma_14): its populations, logic, lag and hard-constraint checks, and below its critical path test and invalid dates rule
  const { T, L } = dcmaPopulations(s);
  const fromDcma = (id: DecmId, c: CheckResult, emptyNote: string) => percent(id, c.activities, c.denominator ?? 0, emptyNote);

  fromDcma('06A204b', logicCheck(s, T, th('06A204b')!, 0), 'there is no incomplete task');
  fromDcma('06A205a', lagsCheck(s, L, th('06A205a')!, 0), 'no incomplete task has a relationship');
  // 06A208a: WBS summary activities carrying logic
  {
    const W = s.tasks.filter(isWbs);
    const preds = (t: Row) => s.ctx.predsOf.get(t.task_id) ?? [], succs = (t: Row) => s.ctx.succsOf.get(t.task_id) ?? [];
    percent('06A208a', W.filter((t) => preds(t).length || succs(t).length).map((t) => offender(t, s)), W.length, 'the project has no WBS summary activity');
  }
  fromDcma('06A209a', hardConstraintsCheck(s, T, th('06A209a')!, 0), 'there is no incomplete task');
  // 06A210a: level of effort with a discrete successor
  {
    const L = s.tasks.filter(isLoe);
    const hit = L.filter((t) => (s.ctx.succsOf.get(t.task_id) ?? []).some((r) => { const x = s.ctx.taskById.get(r.task_id); return !!x && !isLoe(x) && !isWbs(x); }));
    percent('06A210a', hit.map((t) => offender(t, s)), L.length, 'the project has no level-of-effort activity');
  }
  // the activities that are neither WBS summary nor level of effort (the source's "discrete" tasks, dcmaDecm.ts:107)
  const discrete = s.tasks.filter((t) => !isWbs(t) && !isLoe(t));
  percent('06A212a', discrete.filter((t) => startedBeforeFsPredecessor(t, s.ctx)).map((t) => offender(t, s)), discrete.length, 'the project has no activity');
  // 06A401a: dcma_14 check 12; a loop fails it
  {
    const loops = logicLoops(s);
    // a loop cannot be scheduled, so the test is not run (it could only say that it could not)
    if (loops.length) add({ ...notAssessed('06A401a', NAMES['06A401a'], 'days', null, ''), id: '06A401a', name: NAMES['06A401a'], result: 'fail', metric: null, activities: loops.flat().map((code) => ({ id: code, name: [...s.tasks].find((t) => t.task_code === code)?.task_name ?? '' })), total_activities: loops.flat().length, note: loopNote(loops.flat()) });
    else { const c = criticalPathTest(s, T, CPT_SLIP_DAYS, undefined); add({ ...c, id: '06A401a', name: NAMES['06A401a'] }); }
  }
  // 06A501a: missing baseline dates (an activity not in the baseline, or in it with no start or no finish)
  {
    const inBl = discrete.filter((t) => bls.get(t.proj_id));
    if (!inBl.length) na('06A501a', baselineReason(projectsText(s.projs.map((p) => p.proj_short_name)), true, which));
    else percent('06A501a', inBl.filter((t) => { const b = bls.get(t.proj_id)!.tasks.get(t.task_code); return !b || referenceStart(b) == null || baselineFinish(b) == null; }).map((t) => offender(t, s)), inBl.length, 'the project has no activity');
    if (inBl.length && s.projs.some((p) => !bls.get(p.proj_id))) { const left = namesText(s.projs.filter((p) => !bls.get(p.proj_id)).map((p) => p.proj_short_name)); out[out.length - 1].note = notAssessedNote(`${NAMES['06A501a']} for ${left}`, baselineReason(left, true)); }
  }
  // 06A504a / 06A504b: an actual start / finish that differs from the one an earlier update held (progressIntegrity between consecutive updates, in data-date order)
  {
    // every update, this open project included, in data-date order (the order windows_analysis and change_tracking use)
    const chain = ordered;
    if (chain.length < 2) { const why = 'no earlier update was given; pass updates'; na('06A504a', why); na('06A504b', why); }
    else {
      const start = new Map<string, Offender>(), finish = new Map<string, Offender>();
      for (let i = 1; i < chain.length; i++) {
        const a = updateView(chain[i - 1]), b = updateView(chain[i]);
        const f = progressIntegrity(a, b, compareSchedules(a, b, s.hpd, true)).retroactive_actuals;
        for (const x of f) { const m = x.field === 'actual_start' ? start : x.field === 'actual_finish' ? finish : null; if (m && !m.has(x.id)) m.set(x.id, { id: x.id, name: x.name ?? '', value: `${chain[i - 1].name}: ${x.a || '(blank)'} -> ${chain[i].name}: ${x.b || '(blank)'}` }); }
      }
      const series = chain.map((u) => u.name).join(' -> ');
      percent('06A504a', [...start.values()], discrete.length, 'the project has no activity');
      percent('06A504b', [...finish.values()], discrete.length, 'the project has no activity');
    }
  }
  // 06A505a / 06A505b: progress with no actual start; complete with no actual finish
  {
    const asg = groupBy(db.tables.TASKRSRC?.rows ?? [], 'task_id');
    const p = (t: Row) => reportedPercent(t, asg.get(t.task_id) ?? []);
    percent('06A505a', discrete.filter((t) => !t.act_start_date && !t.act_end_date && ((p(t) > 0 && p(t) < 1) || t.status_code === 'TK_Active')).map((t) => offender(t, s)), discrete.length, 'the project has no activity');
    percent('06A505b', discrete.filter((t) => !t.act_end_date && (p(t) >= 1 || t.status_code === 'TK_Complete')).map((t) => offender(t, s)), discrete.length, 'the project has no activity');
  }
  // 06A506a / b / c: dcma_14 check 9 (dcma.ts invalidDateFlags, the one rule) split in three, over the activities of the projects that have a data date
  {
    const { with_data_date: pop, flagged } = invalidDateFlags(s);
    if (!pop.length) { const why = noDataDateReason(projectsText(s.projs.map((p) => p.proj_short_name))); na('06A506a', why); na('06A506b', why); na('06A506c', why); }
    else {
      const w = 'over all activities that are not WBS summaries, in projects with a data date.';
      percent('06A506a', flagged.filter((f) => f.actual_start_after).map((f) => offender(f.task, s, 'actual start after the status date')), pop.length, 'no activity has a data date');
      percent('06A506b', flagged.filter((f) => f.actual_finish_after).map((f) => offender(f.task, s, 'actual finish after the status date')), pop.length, 'no activity has a data date');
      percent('06A506c', flagged.filter((f) => f.forecast_before).map((f) => offender(f.task, s, 'forecast date before the status date')), pop.length, 'no activity has a data date');
    }
  }
  // 08I101a, 10A303a: P6 has no such activity types
  na('08I101a', 'P6 has no summary-level planning package (SLPP) activity type');
  na('10A303a', 'P6 has no planning-package activity type');

  const order = (c: DecmCheck) => DECM_IDS.indexOf(c.id as DecmId);
  out.sort((a, b) => order(a) - order(b));
  const passed = out.filter((c) => c.result === 'pass').length, failed = out.filter((c) => c.result === 'fail').length;
  const gs = [...new Set(out.map((c) => c.guideline))].sort((a, b) => a - b);
  const dd = s.projs.map((p) => s.dataDate(p.proj_id)).find((x) => x != null) ?? null;
  const first = [...bls.values()].find(Boolean);
  return {
    report: 'DCMA DECM schedule checks', profile: profName, status_date: dd != null ? formatP6Date(dd) : null, ...dateFields(s), baseline: first ? { which, name: first.name, how: first.how } : null, updates: ordered.map((u) => ({ name: u.name, data_date: updateDate(u) != null ? formatP6Date(updateDate(u)!) : null, open_project: !!u.open })),
    summary: { passed, failed, not_assessed: out.length - passed - failed, compliance_ratio: passed + failed ? Math.round((passed / (passed + failed)) * 1000) / 1000 : null, overall: passed + failed ? (failed ? 'fail' : 'pass') : null },
    guidelines: gs.map((g) => { const cs = out.filter((c) => c.guideline === g); return { guideline: g, name: GUIDELINES[g] ?? `Guideline ${g}`, checks: cs.map((c) => c.id), passed: cs.filter((c) => c.result === 'pass').length, failed: cs.filter((c) => c.result === 'fail').length, not_assessed: cs.filter((c) => c.result === 'not_assessed').length }; }),
    checks: out, notes: checkNotes(s, out),
  };
}
