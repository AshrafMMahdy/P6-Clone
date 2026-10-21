// DCMA 14-Point Schedule Assessment (DCMA-EA PAM 200.1 metrics), with threshold profiles and per-check overrides.
// Populations follow DCMA: "tasks" are incomplete activities that are not WBS summary, LOE or milestones; leads, lags
// and relationship types count relationships. Durations and float are in working days of each activity's calendar.
// The Critical Path Test runs on a scratch copy (a journal that is rolled back); CPLI and BEI use a chosen baseline.
import { maxOf, minOf } from '../arrays.ts';
import { type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { record, rollback } from '../journal.ts';
import { isCritical } from '../project/ctx.ts';
import { p6num, scheduleProjects } from '../schedule/cpm.ts';
import { drivingPath } from './delay.ts';
import {
  baselineOf, baselineFinish, constraintsOf, DCMA_HARD, forecastFinish, isDone, isLoe, isMilestone, isWbs, makeScope, notAssessed,
  offender, passes, percentCheck, relOffender, type CheckResult, type Offender, type Scope, type Threshold,
} from './common.ts';

type Key = 'logic' | 'leads' | 'lags' | 'relationship_types' | 'hard_constraints' | 'high_float' | 'negative_float' | 'high_duration' | 'invalid_dates' | 'resources' | 'missed_tasks' | 'critical_path_test' | 'cpli' | 'bei';
type Profile = Record<Key, number | null>;

/** PAM 200.1 thresholds (percent of the population; FS share is a minimum; CPLI and BEI are ratios). */
const PAM: Profile = { logic: 5, leads: 0, lags: 5, relationship_types: 90, hard_constraints: 5, high_float: 5, negative_float: 0, high_duration: 5, invalid_dates: 0, resources: 0, missed_tasks: 5, critical_path_test: null, cpli: 0.95, bei: 0.95 };
export const DCMA_PROFILES: Record<string, { label: string; t: Profile }> = {
  pam200: { label: 'DCMA PAM 200.1 (default)', t: PAM },
  strict: { label: 'Strict', t: { ...PAM, logic: 2, lags: 3, hard_constraints: 2, high_float: 2, high_duration: 3, cpli: 1.05, bei: 0.98 } },
  relaxed: { label: 'Relaxed', t: { ...PAM, logic: 10, lags: 10, hard_constraints: 10, high_float: 10, high_duration: 10, bei: 0.85 } },
  gao: { label: 'GAO-16-89G', t: { ...PAM, logic: 0, relationship_types: 85 } },
  aace: { label: 'AACE RP 92R-19', t: { ...PAM, high_float: 10, resources: 15 } },
  nasa: { label: 'NASA NPR 7120', t: { ...PAM, logic: 2, hard_constraints: 3 } },
};
const NAMES: Record<Key, string> = {
  logic: '1. Logic', leads: '2. Leads', lags: '3. Lags', relationship_types: '4. Relationship types', hard_constraints: '5. Hard constraints',
  high_float: '6. High float', negative_float: '7. Negative float', high_duration: '8. High duration', invalid_dates: '9. Invalid dates',
  resources: '10. Resources', missed_tasks: '11. Missed tasks', critical_path_test: '12. Critical path test', cpli: '13. Critical path length index (CPLI)', bei: '14. Baseline execution index (BEI)',
};
const OPS: Record<Key, Threshold['op']> = { logic: '<=', leads: '<=', lags: '<=', relationship_types: '>=', hard_constraints: '<=', high_float: '<=', negative_float: '<=', high_duration: '<=', invalid_dates: '<=', resources: '<=', missed_tasks: '<=', critical_path_test: '=', cpli: '>=', bei: '>=' };

export interface DcmaOptions {
  projIds?: string[]; hoursPerDay?: number;
  profile?: string;
  /** threshold overrides by check id */
  thresholds?: Partial<Record<Key, number>>;
  /** project, bl1-bl3, or any saved baseline's name */
  baseline?: string;
  /** status date (default: each project's data date) */
  statusDate?: number | null;
  /** contract finish for CPLI (default: the project's Must Finish By date) */
  targetFinish?: number | null;
  /** days added in the critical path test (default 600) */
  cptSlipDays?: number;
  /** the activity the critical path test delays (default: the earliest critical activity) */
  cptActivity?: string;
  /** high float / high duration limit in working days (default 44); dynamic: max(20, 10% of the project's length) */
  limitDays?: number | 'dynamic';
  /** activities listed per check (default 100; 0 = all) */
  maxIds?: number;
  /** activity IDs exempt from the logic check (e.g. the project start and finish) */
  exempt?: string[];
}

export interface DcmaReport {
  report: 'DCMA 14-Point Assessment';
  profile: string; status_date: string | null;
  baseline: { which: string; name: string; how: string } | null;
  limit_days: number; tasks: number; relationships: number;
  summary: { passed: number; failed: number; not_assessed: number };
  checks: CheckResult[];
}

export function dcma14(db: Db, o: DcmaOptions = {}): DcmaReport {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, statusDate: o.statusDate, calendarDays: true });
  const prof = DCMA_PROFILES[o.profile ?? 'pam200'] ?? DCMA_PROFILES.pam200;
  const profName = DCMA_PROFILES[o.profile ?? 'pam200'] ? (o.profile ?? 'pam200') : 'pam200';
  const th = (k: Key): Threshold | null => {
    const ov = o.thresholds?.[k];
    if (ov != null) return { op: OPS[k], value: ov, source: 'override' };
    const v = prof.t[k];
    return v == null ? null : { op: OPS[k], value: v, source: prof.label };
  };
  const maxIds = o.maxIds ?? 100;
  const days = (t: Row, h: string | undefined) => (h === '' || h == null ? null : Number(h) / s.dh.task(t));
  const which = o.baseline ?? 'project';
  const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(db, p, which)]));
  const bl = (t: Row) => bls.get(t.proj_id)?.tasks.get(t.task_code);
  const anyBl = [...bls.values()].some(Boolean);

  // the tasks DCMA assesses: incomplete, not WBS summary, LOE or milestones
  const T = s.tasks.filter((t) => !isDone(t) && !isWbs(t) && !isLoe(t) && !isMilestone(t));
  const inT = new Set(T.map((t) => t.task_id));
  // the relationships of incomplete tasks
  const L = s.rels.filter((r) => inT.has(r.task_id) || inT.has(r.pred_task_id));

  // high float / high duration limit
  const projLen = (() => {
    const p = s.projs[0]; if (!p) return 0;
    const st = minOf(s.tasks.map((t) => parseP6Date(t.act_start_date || t.early_start_date || t.target_start_date) ?? Infinity));
    const fi = maxOf(s.tasks.map((t) => forecastFinish(t) ?? -Infinity));
    return Number.isFinite(st) && Number.isFinite(fi) ? s.workDays(s.projCal(p), st, fi) : 0;
  })();
  const limit = o.limitDays === 'dynamic' ? Math.max(20, Math.ceil(0.1 * projLen)) : o.limitDays ?? 44;

  const out: CheckResult[] = [];
  const exempt = new Set(o.exempt ?? []);
  const preds = (t: Row) => s.ctx.predsOf.get(t.task_id) ?? [], succs = (t: Row) => s.ctx.succsOf.get(t.task_id) ?? [];
  out.push(percentCheck('logic', NAMES.logic, T.filter((t) => !exempt.has(t.task_code) && (!preds(t).length || !succs(t).length)).map((t) => offender(t, s, !preds(t).length && !succs(t).length ? 'no predecessor, no successor' : !preds(t).length ? 'no predecessor' : 'no successor')), T.length, th('logic')!, maxIds, 'Incomplete tasks missing a predecessor or a successor.'));
  const lag = (r: Row) => Number(r.lag_hr_cnt || 0);
  out.push(percentCheck('leads', NAMES.leads, L.filter((r) => lag(r) < 0).map((r) => relOffender(r, s)), L.length, th('leads')!, maxIds, 'Relationships with a negative lag.'));
  out.push(percentCheck('lags', NAMES.lags, L.filter((r) => lag(r) > 0).map((r) => relOffender(r, s)), L.length, th('lags')!, maxIds, 'Relationships with a positive lag.'));
  {
    const fs = L.filter((r) => (r.pred_type || 'PR_FS') === 'PR_FS').length, t = th('relationship_types')!;
    const metric = L.length ? Math.round((1000 * fs) / L.length) / 10 : null;
    const other = L.filter((r) => (r.pred_type || 'PR_FS') !== 'PR_FS').map((r) => relOffender(r, s));
    out.push({ id: 'relationship_types', name: NAMES.relationship_types, unit: '%', metric, threshold: t, numerator: fs, denominator: L.length, result: !L.length || passes(metric!, t) ? 'pass' : 'fail', activities: maxIds ? other.slice(0, maxIds) : other, total_activities: other.length, note: 'Share of finish-to-start relationships; listed are the others.' });
  }
  out.push(percentCheck('hard_constraints', NAMES.hard_constraints, T.filter((t) => constraintsOf(t).some((c) => DCMA_HARD.has(c))).map((t) => offender(t, s, constraintsOf(t).join(', '))), T.length, th('hard_constraints')!, maxIds, 'Must Start/Finish On, Start/Finish No Later Than (P6: Start On, Finish On, On or Before, Mandatory).'));
  out.push(percentCheck('high_float', NAMES.high_float, T.filter((t) => (days(t, t.total_float_hr_cnt) ?? -Infinity) > limit).map((t) => offender(t, s, `${Math.round(days(t, t.total_float_hr_cnt)! * 10) / 10} d`)), T.length, th('high_float')!, maxIds, `Total float over ${limit} working days.`));
  out.push(percentCheck('negative_float', NAMES.negative_float, T.filter((t) => (days(t, t.total_float_hr_cnt) ?? 0) < 0).map((t) => offender(t, s, `${Math.round(days(t, t.total_float_hr_cnt)! * 10) / 10} d`)), T.length, th('negative_float')!, maxIds));
  {
    // baseline duration where the activity is in the baseline, else its original duration
    const dur = (t: Row) => { const b = bl(t); return b ? days(b, b.target_drtn_hr_cnt) : days(t, t.target_drtn_hr_cnt); };
    out.push(percentCheck('high_duration', NAMES.high_duration, T.filter((t) => (dur(t) ?? 0) > limit).map((t) => offender(t, s, `${Math.round(dur(t)! * 10) / 10} d`)), T.length, th('high_duration')!, maxIds, `Baseline duration (original duration when not in the baseline) over ${limit} working days.`));
  }
  {
    // actual dates after the status date, or forecast dates before it
    const pop = s.tasks.filter((t) => !isWbs(t));
    const bad: Offender[] = [];
    for (const t of pop) {
      const dd = s.dataDate(t.proj_id); if (dd == null) continue;
      const d = (v?: string) => parseP6Date(v);
      const aS = d(t.act_start_date), aF = d(t.act_end_date);
      if ((aS != null && aS > dd) || (aF != null && aF > dd)) { bad.push(offender(t, s, 'actual date after the status date')); continue; }
      if (isDone(t)) continue;
      const fS = t.act_start_date ? null : d(t.restart_date || t.early_start_date), fF = d(t.reend_date || t.early_end_date);
      if ((fS != null && fS < dd) || (fF != null && fF < dd)) bad.push(offender(t, s, 'forecast date before the status date'));
    }
    out.push(percentCheck('invalid_dates', NAMES.invalid_dates, bad, pop.length, th('invalid_dates')!, maxIds));
  }
  {
    const loaded = new Set([...s.db.tables.TASKRSRC?.rows ?? [], ...s.db.tables.PROJCOST?.rows ?? []].map((a) => a.task_id));
    out.push(percentCheck('resources', NAMES.resources, T.filter((t) => !loaded.has(t.task_id)).map((t) => offender(t, s)), T.length, th('resources')!, maxIds, 'Tasks with no resource or expense (hours or cost) loaded.'));
  }
  // missed tasks: of the tasks baselined to finish by the status date, those finishing (actually or forecast) after their baseline finish
  if (!anyBl) out.push(notAssessed('missed_tasks', NAMES.missed_tasks, '%', th('missed_tasks'), `No ${which === 'project' ? 'project' : which.toUpperCase()} baseline is assigned.`));
  else {
    const due = s.tasks.filter((t) => { const b = bl(t), dd = s.dataDate(t.proj_id); return b && !isWbs(t) && !isLoe(t) && !isMilestone(t) && dd != null && (baselineFinish(b) ?? Infinity) <= dd; });
    const missed = due.filter((t) => (forecastFinish(t) ?? -Infinity) > (baselineFinish(bl(t)) ?? Infinity)).map((t) => offender(t, s, `baseline ${formatP6Date(baselineFinish(bl(t))!).slice(0, 10)}`));
    out.push(due.length ? percentCheck('missed_tasks', NAMES.missed_tasks, missed, due.length, th('missed_tasks')!, maxIds, 'Tasks baselined to finish by the status date that finished (or will finish) after their baseline finish.') : notAssessed('missed_tasks', NAMES.missed_tasks, '%', th('missed_tasks'), 'No task was baselined to finish by the status date.'));
  }
  out.push(criticalPathTest(s, T, o.cptSlipDays ?? 600, o.cptActivity));
  out.push(cpli(s, o.targetFinish ?? null, bls, which, th('cpli')));
  // BEI: tasks completed over tasks baselined to finish by the status date
  if (!anyBl) out.push(notAssessed('bei', NAMES.bei, 'ratio', th('bei'), `No ${which === 'project' ? 'project' : which.toUpperCase()} baseline is assigned.`));
  else {
    const ok = (t: Row) => !isWbs(t) && !isLoe(t) && !isMilestone(t);
    const completed = s.tasks.filter((t) => ok(t) && isDone(t)).length;
    const dueList: Offender[] = []; let due = 0;
    for (const p of s.projs) {
      const b = bls.get(p.proj_id), dd = s.dataDate(p.proj_id);
      if (!b || dd == null) continue;
      const cur = new Map(s.tasks.filter((t) => t.proj_id === p.proj_id).map((t) => [t.task_code, t]));
      for (const bt of b.tasks.values()) if (ok(bt) && (baselineFinish(bt) ?? Infinity) <= dd) { due++; const c = cur.get(bt.task_code); if (!c || !isDone(c)) dueList.push({ id: bt.task_code, name: bt.task_name, value: c ? 'not completed' : 'not in the current schedule' }); }
    }
    const t = th('bei')!;
    if (!due) out.push({ ...notAssessed('bei', NAMES.bei, 'ratio', t, 'No task was baselined to finish by the status date.'), numerator: completed, denominator: 0 });
    else { const metric = Math.round((completed / due) * 1000) / 1000; out.push({ id: 'bei', name: NAMES.bei, unit: 'ratio', metric, threshold: t, numerator: completed, denominator: due, result: passes(metric, t) ? 'pass' : 'fail', activities: maxIds ? dueList.slice(0, maxIds) : dueList, total_activities: dueList.length, note: 'Tasks completed (including early) over tasks baselined to finish by the status date. Listed: due but not completed.' }); }
  }

  const dd = s.projs.map((p) => s.dataDate(p.proj_id)).find((x) => x != null) ?? null;
  const first = [...bls.values()].find(Boolean);
  return {
    report: 'DCMA 14-Point Assessment', profile: profName, status_date: dd != null ? formatP6Date(dd) : null,
    baseline: first ? { which, name: first.name, how: first.how } : null, limit_days: limit, tasks: T.length, relationships: L.length,
    summary: { passed: out.filter((c) => c.result === 'pass').length, failed: out.filter((c) => c.result === 'fail').length, not_assessed: out.filter((c) => c.result === 'not_assessed').length },
    checks: out,
  };
}

/** Project forecast finish (latest activity finish) of the scoped projects. */
function projectFinish(s: Scope): number | null {
  const f = maxOf(s.tasks.map((t) => forecastFinish(t) ?? -Infinity));
  return Number.isFinite(f) ? f : null;
}

/** DCMA check 12: delay one early critical task by a large amount and see the project finish move by exactly that. */
function criticalPathTest(s: Scope, T: Row[], slipDays: number, pick?: string): CheckResult {
  const name = NAMES.critical_path_test;
  const crit = T.filter((t) => isCritical(t, s.ctx)).sort((a, b) => (parseP6Date(a.restart_date || a.early_start_date) ?? 0) - (parseP6Date(b.restart_date || b.early_start_date) ?? 0));
  // nothing critical by float (a Must Finish By later than the forecast gives every task float): the first task on the
  // longest path, the chain that drives the project finish, is tested instead
  let viaLongest = false, heldBy: string | null = null;
  let test = pick ? T.find((t) => t.task_code === pick) : crit[0];
  if (!test && !pick) {
    const inT = new Set(T.map((t) => t.task_id));
    const end = s.tasks.filter((t) => !t.act_end_date && !isWbs(t) && !isLoe(t)).sort((a, b) => (forecastFinish(b) ?? 0) - (forecastFinish(a) ?? 0))[0];
    test = end ? drivingPath({ name: '', db: s.db, projId: end.proj_id }, end).find((t) => inT.has(t.task_id)) : undefined;
    viaLongest = !!test;
    // no logic drives the finish (a constraint on the last activity sets it): the task with the least float
    if (!test && T.length) { test = [...T].sort((a, b) => Number(a.total_float_hr_cnt || 0) - Number(b.total_float_hr_cnt || 0) || (parseP6Date(a.restart_date || a.early_start_date) ?? 0) - (parseP6Date(b.restart_date || b.early_start_date) ?? 0))[0]; heldBy = end?.cstr_type ? end.task_code : null; }
  }
  if (!test) return notAssessed('critical_path_test', name, 'days', null, pick ? `Activity ${pick} is not an incomplete task in scope.` : s.tasks.some((t) => t.early_start_date) ? 'No incomplete task drives the project finish (every remaining task is complete, a milestone, or level of effort).' : 'The project has no early dates: schedule it (F9) first.');
  const before = projectFinish(s);
  let after: number | null = null, ok = true, msg = '';
  // the delay in hours of the test activity's calendar; the finish shift is measured in the same working time
  const add = slipDays * s.dh.task(test);
  const j = record(s.db, (d) => {
    const t = d.tables.TASK.rows.find((x) => x.task_id === test.task_id)!;
    t.remain_drtn_hr_cnt = p6num(Number(t.remain_drtn_hr_cnt || 0) + add);
    if (!t.act_start_date) t.target_drtn_hr_cnt = p6num(Number(t.target_drtn_hr_cnt || 0) + add);
    const r = scheduleProjects(d, [...s.projIds], {});
    if (!r.ok) { ok = false; msg = r.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' '); return; }
    after = maxOf(d.tables.TASK.rows.filter((x) => s.projIds.has(x.proj_id)).map((x) => forecastFinish(x) ?? -Infinity));
  });
  rollback(j);
  if (!ok || before == null || after == null) return notAssessed('critical_path_test', name, 'days', null, `The test could not be scheduled: ${msg || 'no finish date'}.`);
  const movedHours = s.cal(test).workBetween(before, after) / 60;
  const moved = Math.round((movedHours / s.dh.task(test)) * 100) / 100;
  const pass = Math.abs(movedHours - add) <= s.dh.task(test); // within one day
  return {
    id: 'critical_path_test', name, unit: 'days', metric: moved, threshold: { op: '=', value: slipDays, source: 'DCMA (project finish must move by the delay added)' },
    numerator: null, denominator: null, result: pass ? 'pass' : 'fail', activities: [offender(test, s, `+${slipDays} d`)], total_activities: 1,
    note: (viaLongest ? `No task is critical by total float, so ${test.task_code}, the first task on the longest path, was tested. ` : !crit.length && !pick ? `No task is critical by total float and no logic drives the finish${heldBy ? ` (a constraint on ${heldBy} sets it)` : ''}, so ${test.task_code}, the task with the least float, was tested. ` : '') + (pass ? `Delaying ${test.task_code} by ${slipDays} working days moved the project finish by the same amount: the critical path is continuous.`
      : moved <= 0.01 ? `Delaying ${test.task_code} by ${slipDays} working days did not move the project finish: ${test.task_code} is critical by its float but not on the path that drives the finish (a constraint that makes float negative, or an open end), so the critical path is not continuous through it.`
      : movedHours > add ? `Delaying ${test.task_code} by ${slipDays} working days moved the project finish by ${moved}, more than the delay: calendars along the path (non-work periods, a different calendar on a successor or a lag) stretch it, so the finish does not follow the critical path day for day.`
      : `Delaying ${test.task_code} by ${slipDays} working days moved the project finish by only ${moved}: part of the delay is absorbed on the way (a constraint, a missing link, a lag, or start-to-start / finish-to-finish links that let successors start before it finishes).`),
    detail: { finish_before: formatP6Date(before), finish_after: formatP6Date(after) },
  };
}

/** DCMA check 13. Decision tree: a contract finish (given, or the project's Must Finish By) decides; a baseline
 *  finish is reported beside it, or decides when there is no contract finish; with neither the check is not assessed. */
function cpli(s: Scope, given: number | null, bls: Map<string, ReturnType<typeof baselineOf>>, which: string, th: Threshold | null): CheckResult {
  const name = NAMES.cpli;
  const p = s.projs[0];
  const dd = p ? s.dataDate(p.proj_id) : null, fin = projectFinish(s);
  if (!p || dd == null || fin == null) return notAssessed('cpli', name, 'ratio', th, 'The project has no data date or no forecast finish (schedule it first).');
  const cal = s.projCal(p);
  const cpl = s.workDays(cal, dd, fin);
  const contract = given ?? parseP6Date(p.plan_end_date) ?? null;
  const b = bls.get(p.proj_id);
  const blFin = b ? maxOf([...b.tasks.values()].map((t) => baselineFinish(t) ?? -Infinity)) : null;
  const one = (target: number) => { const tf = s.workDays(cal, fin, target); return { target: formatP6Date(target), total_float_days: tf, cpli: cpl > 0 ? Math.round(((cpl + tf) / cpl) * 1000) / 1000 : null }; };
  const vsContract = contract != null ? one(contract) : null, vsBaseline = blFin != null && Number.isFinite(blFin) ? one(blFin) : null;
  const primary = vsContract ?? vsBaseline;
  if (!primary) return notAssessed('cpli', name, 'ratio', th, 'No contract finish (Must Finish By, or target_finish) and no baseline: nothing to measure the float against.');
  if (cpl <= 0 || primary.cpli == null) return notAssessed('cpli', name, 'ratio', th, 'The remaining critical path length is zero (the project is complete at the status date).');
  return {
    id: 'cpli', name, unit: 'ratio', metric: primary.cpli, threshold: th, numerator: Math.round((cpl + primary.total_float_days) * 100) / 100, denominator: cpl,
    result: th && !passes(primary.cpli, th) ? 'fail' : 'pass', activities: [], total_activities: 0,
    note: `Measured against the ${vsContract ? (given != null ? 'contract finish given' : 'Must Finish By date (contract finish)') : `${which === 'project' ? 'project' : which.toUpperCase()} baseline finish`}. CPLI = (critical path length + total float) / critical path length, in working days from the status date.`,
    detail: { critical_path_length_days: cpl, forecast_finish: formatP6Date(fin), decided_by: vsContract ? 'contract' : 'baseline', against_contract: vsContract, against_baseline: vsBaseline },
  };
}
