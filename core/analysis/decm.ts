// decm: the DCMA DECM schedule checks (the 15 of guideline 6, Schedule), shaped like dcma_14, on the open file's own tables. Ported from our copy of the Bellator Schedule Intelligence benchmark ("Bellatorsi API/src/endpoints/
// forensics/dcmaDecm.ts": 17 checks, each a percentage of a population, grouped by guideline; its two checks of guidelines 8 and 10, 08I101a and 10A303a, judge summary-level planning packages and planning
// packages, activity types P6 does not have, so they could never be assessed on a P6 file and are not in the clone, and with them the grouping by guideline has gone: every check here is guideline 6). The clone reuses what it has: the logic, lag and hard-constraint checks, the invalid dates (split in three) and the
// critical path test are dcma_14's own functions (dcma.ts), called one by one (not the whole of dcma_14); the baseline is baselineOf; out-of-sequence progress is the review rule; retroactive actual dates are progressIntegrity (core/diff.ts) between consecutive updates. A check with no
// population is not assessed (the source "skips" it), and so is one the file cannot supply an input for (no baseline, no data date, no earlier update), with the reason.
// The thresholds and the three status-date checks (06A506a / b / c) are DCMA's published ones (item 26, 2026-11-28), not the source's: the source's default and strict
// values and its split of 06A506 (actual start, actual finish, forecast) were its own. 06A506c, riding the status date, compares the update before this one.
import { groupBy, rows, type Db, type Row } from '../db.ts';
import { baselineReason, loopNote, noDataDateReason, projectsText, notAssessed as notAssessedNote } from '../notes.ts';
import { formatP6Date, MIN_PER_DAY, parseP6Date } from '../dates.ts';
import { reportedPercent } from '../cost/rollup.ts';
import { startedBeforeFsPredecessor } from '../query/review.ts';
import { compareSchedules, progressIntegrity } from '../diff.ts';
import { CPT_SLIP_DAYS, criticalPathTest, dcmaPopulations, hardConstraintsCheck, invalidDateFlags, lagsCheck, logicCheck } from './dcma.ts';
import { matchActivities, type Update } from './delay.ts';
import { baselineOf, noBaselineReason, baselineFinish, namesText, isLoe, isWbs, dateFields, checkNotes, makeScope, notAssessed, offender, passes, type CheckResult, type Offender, type Threshold } from './common.ts';
import { loopMessage, logicLoops, referenceStart, updateDate, updateView } from './forensic.ts';

export type DecmId = '06A204b' | '06A205a' | '06A208a' | '06A209a' | '06A210a' | '06A212a' | '06A401a' | '06A501a' | '06A504a' | '06A504b' | '06A505a' | '06A505b' | '06A506a' | '06A506b' | '06A506c';
export const DECM_IDS: DecmId[] = ['06A204b', '06A205a', '06A208a', '06A209a', '06A210a', '06A212a', '06A401a', '06A501a', '06A504a', '06A504b', '06A505a', '06A505b', '06A506a', '06A506b', '06A506c'];

/** AGREED LIMIT (owner, 2026-11-28): the DCMA DECM thresholds, percent of the population allowed (06A401a has none: it is a test) — the pass / fail of each check — why: rule 7 of item 26,
 *  "analysis thresholds - agreed as long as it is visible" — necessary because they are DCMA's published values: the SSI DECM schedule tests table
 *  (ssitools.com/helpandsuport/DECM/help/ssi_decm_schedule_tests.htm), and Steelray's DECM pages for 06A209a (0), 06A504a (10 %) and 06A506c; DCMA's own
 *  workbook (dcma.mil/HQ/EVMS) refuses automated reading. Each check's threshold.source names it. */
const THRESHOLDS: Record<DecmId, number | null> = { '06A204b': 0, '06A205a': 10, '06A208a': 0, '06A209a': 0, '06A210a': 0, '06A212a': 1, '06A401a': null, '06A501a': 5, '06A504a': 10, '06A504b': 10, '06A505a': 5, '06A505b': 5, '06A506a': 5, '06A506b': 0, '06A506c': 1 };
export const DECM_THRESHOLD_SOURCE = 'DCMA DECM published threshold';
// AGREED LIMIT (owner, 2026-11-28): 5 calendar days — 06A506c: a forecast start this close after each update's status date rides it (DCMA's three working days, given as five calendar days: the same on every calendar) — why: rule 7 of item 26, "analysis thresholds - agreed as long as it is visible" (the check's detail.rides_when says it) — necessary because it is DCMA's published window (Steelray's 06A506c page).
const RIDE_START_DAYS = 5;
// AGREED LIMIT (owner, 2026-11-28): 2 days — 06A506c: a remaining duration within this of its value at the update before rides the status date (days of the activity's own calendar) — why: rule 7 of item 26, "analysis thresholds - agreed as long as it is visible" (the check's detail.rides_when says it) — necessary because it is DCMA's published window (Steelray's 06A506c page).
const RIDE_REMAINING_DAYS = 2;
/** The check names. dcmaDecm.ts:60-68. */
const NAMES: Record<DecmId, string> = {
  '06A204b': 'Dangling starts/finishes', '06A205a': 'Lags', '06A208a': 'Summary tasks with logic', '06A209a': 'Hard constraints', '06A210a': 'LOE with discrete successors', '06A212a': 'Out-of-sequence progress',
  '06A401a': 'Critical path validity', '06A501a': 'Missing baseline dates', '06A504a': 'Actual start retroactively changed', '06A504b': 'Actual finish retroactively changed', '06A505a': 'In-progress missing actual start',
  '06A505b': 'Completed missing actual finish', '06A506a': 'Actual dates after the status date', '06A506b': 'Forecast dates before the status date', '06A506c': 'Forecast riding the status date',
};


export type DecmCheck = CheckResult;
export interface DecmOptions {
  projIds?: string[]; hoursPerDay?: number;
  /** project, bl1-bl3, or any saved baseline's name */
  baseline?: string;
  statusDate?: number | null;
  /** the series of schedules the retroactive-actuals checks read: this project and the other updates, from loadUpdates (put in data-date order here); absent = no other update */
  updates?: Update[];
}
export interface DecmReport {
  report: 'DCMA DECM schedule checks';
  status_date: string | null; baseline: { which: string; name: string; how: string } | null;
  /** the series the retroactive-actuals and riding checks read, in the data-date order used (empty when no updates were given) */
  updates: { name: string; data_date: string | null; open_project: boolean }[];
  summary: { passed: number; failed: number; not_assessed: number; /** passed / (passed + failed); null when nothing was assessed */ compliance_ratio: number | null; overall: 'pass' | 'fail' | null };
  checks: DecmCheck[];
  /** every sentence the checks and the data dates have to say, once */
  notes: string[];
}

export function decm(db: Db, o: DecmOptions = {}): DecmReport {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, statusDate: o.statusDate, calendarDays: true });
  const th = (id: DecmId): Threshold | null => {
    const v = THRESHOLDS[id];
    return v == null ? null : { op: '<=', value: v, source: DECM_THRESHOLD_SOURCE };
  };
  const which = o.baseline ?? 'project';
  const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(db, p, which)]));
  const out: DecmCheck[] = [];
  const ordered = [...(o.updates ?? [])].sort((x, y) => (updateDate(x) ?? 0) - (updateDate(y) ?? 0));
  const add = (c: CheckResult) => out.push(c);
  const na = (id: DecmId, reason: string) => add(reason.startsWith('Not assessed: ') ? { ...notAssessed(id, NAMES[id], '%', th(id), ''), note: reason } : notAssessed(id, NAMES[id], '%', th(id), reason));
  /** a percentage check: found of a population; an empty population is not assessed */
  const percent = (id: DecmId, found: Offender[], denominator: number, emptyNote: string, detail?: Record<string, unknown>) => {
    const t = th(id)!;
    if (!denominator) return na(id, emptyNote);
    // judged on the exact share, shown to two decimals: a threshold of 0 % is failed by one activity in any population (dcma_14 judges the same way now, common.ts percentCheck)
    const metric = Math.round((10000 * found.length) / denominator) / 100;
    add({ id, name: NAMES[id], unit: '%', metric, threshold: t, numerator: found.length, denominator, result: passes((100 * found.length) / denominator, t) ? 'pass' : 'fail', activities: found, total_activities: found.length, ...(detail ? { detail } : {}) });
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
    if (!inBl.length) na('06A501a', noBaselineReason(s.db, s.projs, true, which));
    else percent('06A501a', inBl.filter((t) => { const b = bls.get(t.proj_id)!.tasks.get(t.task_code); return !b || referenceStart(b) == null || baselineFinish(b) == null; }).map((t) => offender(t, s)), inBl.length, 'the project has no activity');
    if (inBl.length && s.projs.some((p) => !bls.get(p.proj_id))) { const without = s.projs.filter((p) => !bls.get(p.proj_id)), left = namesText(without.map((p) => p.proj_short_name)); out[out.length - 1].note = notAssessedNote(`${NAMES['06A501a']} for ${left}`, noBaselineReason(s.db, without, true, which)); }
  }
  // 06A504a / 06A504b: an actual start / finish that differs from the one an earlier update held (progressIntegrity between consecutive updates, in data-date order)
  {
    // every update, this open project included, in data-date order (the order windows_analysis and change_tracking use)
    const chain = ordered;
    if (chain.length < 2) { const why = 'no earlier update was given; pass updates'; na('06A504a', why); na('06A504b', why); }
    else {
      // DCMA's population: the activities that had an actual start (finish) in the earlier update of a pair
      const start = new Map<string, Offender>(), finish = new Map<string, Offender>(), hadStart = new Set<string>(), hadFinish = new Set<string>();
      for (let i = 1; i < chain.length; i++) {
        const a = updateView(chain[i - 1]), b = updateView(chain[i]);
        for (const t of rows(a, 'TASK')) { if (isWbs(t) || isLoe(t)) continue; if (t.act_start_date) hadStart.add(t.task_code); if (t.act_end_date) hadFinish.add(t.task_code); }
        const f = progressIntegrity(a, b, compareSchedules(a, b, s.hpd, true)).retroactive_actuals;
        for (const x of f) { const m = x.field === 'actual_start' ? start : x.field === 'actual_finish' ? finish : null; if (m && !m.has(x.id)) m.set(x.id, { id: x.id, name: x.name ?? '', value: `${chain[i - 1].name}: ${x.a || '(blank)'} -> ${chain[i].name}: ${x.b || '(blank)'}` }); }
      }
      const series = chain.map((u) => u.name).join(' -> ');
      percent('06A504a', [...start.values()], hadStart.size, 'no activity had an actual start in an earlier update');
      percent('06A504b', [...finish.values()], hadFinish.size, 'no activity had an actual finish in an earlier update');
    }
  }
  // 06A505a / 06A505b: progress with no actual start; complete with no actual finish
  {
    const asg = groupBy(db.tables.TASKRSRC?.rows ?? [], 'task_id');
    const p = (t: Row) => reportedPercent(t, asg.get(t.task_id) ?? []);
    percent('06A505a', discrete.filter((t) => !t.act_start_date && !t.act_end_date && ((p(t) > 0 && p(t) < 1) || t.status_code === 'TK_Active')).map((t) => offender(t, s)), discrete.length, 'the project has no activity');
    percent('06A505b', discrete.filter((t) => !t.act_end_date && (p(t) >= 1 || t.status_code === 'TK_Complete')).map((t) => offender(t, s)), discrete.length, 'the project has no activity');
  }
  // 06A506a / b: dcma_14 check 9 (dcma.ts invalidDateFlags, the one rule) split in two as DCMA does, over the activities of the projects that have a data date; 06A506c compares the update before
  {
    const { with_data_date: pop, flagged } = invalidDateFlags(s);
    if (!pop.length) { const why = noDataDateReason(projectsText(s.projs.map((p) => p.proj_short_name))); na('06A506a', why); na('06A506b', why); na('06A506c', why); }
    else {
      const actual = (f: (typeof flagged)[number]) => (f.actual_start_after && f.actual_finish_after ? 'actual start and finish after the status date' : f.actual_start_after ? 'actual start after the status date' : 'actual finish after the status date');
      percent('06A506a', flagged.filter((f) => f.actual_start_after || f.actual_finish_after).map((f) => offender(f.task, s, actual(f))), pop.length, 'no activity has a data date');
      percent('06A506b', flagged.filter((f) => f.forecast_before).map((f) => offender(f.task, s, 'forecast date before the status date')), pop.length, 'no activity has a data date');
      ride(pop);
    }
  }
  // 06A506c: an incomplete activity whose forecast rides the status date over two updates: not started in both, its forecast start within five calendar days of each update's status date;
  // or under way in both, its remaining duration within two days of what it was. The update before this one is the one before it in data-date order.
  function ride(pop: Row[]) {
    const at = ordered.findIndex((u) => u.db === db && s.projs.some((p) => p.proj_id === u.projId));
    if (ordered.length < 2) return na('06A506c', 'no earlier update was given; pass updates');
    if (at < 0) return na('06A506c', 'this project is not among the updates given; pass it with them');
    if (at === 0) return na('06A506c', `this project (${ordered[0].name}) has the earliest data date of the updates given; pass the update before it`);
    const prev = ordered[at - 1], ddPrev = updateDate(prev);
    if (ddPrev == null) return na('06A506c', `${prev.name}, the update before this one, has no data date`);
    if (!s.projs.some((p) => (s.dataDate(p.proj_id) ?? -Infinity) > ddPrev)) return na('06A506c', `${prev.name}, the update before this one, has the same status date or a later one; nothing can have ridden it`);
    const open = pop.filter((t) => !t.act_end_date && !isLoe(t));
    const before = new Map([...matchActivities(rows(updateView(prev), 'TASK').filter((t) => !isWbs(t)), open)].map(([a, b]) => [b, a]));
    const days = (min: number) => `${Math.round((min / MIN_PER_DAY) * 10) / 10} d`, hrs = (t: Row) => Number(t.remain_drtn_hr_cnt || 0), inDays = (h: number, t: Row) => Math.round((h / s.dh.task(t)) * 10) / 10;
    const pop2 = open.filter((t) => before.has(t)), hit: Offender[] = [];
    for (const t of pop2) {
      const p = before.get(t)!, dd = s.dataDate(t.proj_id)!;
      if (p.act_end_date || dd <= ddPrev) continue;
      if (!t.act_start_date && !p.act_start_date) {
        const fS = parseP6Date(t.restart_date || t.early_start_date), pS = parseP6Date(p.restart_date || p.early_start_date);
        const near = (f: number | null, d: number) => f != null && f >= d && f - d <= RIDE_START_DAYS * MIN_PER_DAY;
        if (near(fS, dd) && near(pS, ddPrev)) hit.push(offender(t, s, `forecast start ${days(pS! - ddPrev)} after the status date at ${prev.name}, ${days(fS! - dd)} after it now`));
      } else if (t.act_start_date && p.act_start_date && Math.abs(hrs(t) - hrs(p)) <= RIDE_REMAINING_DAYS * s.dh.task(t)) {
        // (days of the activity's own calendar, at both updates: the same activity)
        hit.push(offender(t, s, `remaining duration ${inDays(hrs(p), t)} d at ${prev.name}, ${inDays(hrs(t), t)} d now`));
      }
    }
    percent('06A506c', hit, pop2.length, `no incomplete activity is also in ${prev.name}`, {
      rides_when: `not started at both updates with its forecast start within ${RIDE_START_DAYS} calendar days after each update's status date, or under way at both with its remaining duration within ${RIDE_REMAINING_DAYS} days (of its own calendar) of its value at ${prev.name}`,
    });
  }

  const order = (c: DecmCheck) => DECM_IDS.indexOf(c.id as DecmId);
  out.sort((a, b) => order(a) - order(b));
  const passed = out.filter((c) => c.result === 'pass').length, failed = out.filter((c) => c.result === 'fail').length;
  const dd = s.projs.map((p) => s.dataDate(p.proj_id)).find((x) => x != null) ?? null;
  const first = [...bls.values()].find(Boolean);
  return {
    report: 'DCMA DECM schedule checks', status_date: dd != null ? formatP6Date(dd) : null, ...dateFields(s), baseline: first ? { which, name: first.name, how: first.how } : null, updates: ordered.map((u) => ({ name: u.name, data_date: updateDate(u) != null ? formatP6Date(updateDate(u)!) : null, open_project: !!u.open })),
    summary: { passed, failed, not_assessed: out.length - passed - failed, compliance_ratio: passed + failed ? Math.round((passed / (passed + failed)) * 1000) / 1000 : null, overall: passed + failed ? (failed ? 'fail' : 'pass') : null },
    checks: out, notes: checkNotes(s, out),
  };
}
