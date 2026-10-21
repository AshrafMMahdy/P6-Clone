// Tools > Check Schedule Report, as P6 Professional does it: 14 checks, each with P6's own population and default target, the
// activities (or relationships) each one finds, and a summary. Thresholds in hours use the admin hours per day
// (44 days x 8 h = 352 h by default), as P6 does.
// Default targets are P6 Professional's (Tools > Check Schedule Report, versions 22 to 25). Oracle's Professional help lists
// the checks without numbers; the numbers are the Professional dialog's, as walkthroughs of it record them (Taradigm,
// P6 Professional 23; p6consulting), and Oracle's help for the same report agrees on the 352 h values and the targets.
// Large Float is < 1 % (Oracle and p6consulting; one walkthrough says < 5 %), BEI > 0.95 as the dialog shows it. EPPM's extra Dangling Start/Finish checks are not in P6 Professional: the
// lint extension has them.
import { rows, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import {
  baselineOf, baselineFinish, constraintsOf, isDone, isLoe, isMilestone, isStarted, isWbs, makeScope, notAssessed, offender,
  P6_HARD, P6_SOFT, pct, percentCheck, relOffender, START_CONSTRAINTS, passes, type CheckResult, type Offender, type Threshold,
} from './common.ts';

const SRC = 'P6 Professional default (Check Schedule Report)';
export const P6_CHECKS: { id: string; name: string; th: Threshold }[] = [
  { id: 'logic', name: 'Logic (missing predecessors or successors)', th: { op: '<', value: 5, source: SRC } },
  { id: 'negative_lags', name: 'Negative lags', th: { op: '<', value: 1, source: SRC } },
  { id: 'lags', name: 'Lags', th: { op: '<', value: 5, source: SRC } },
  { id: 'long_lags', name: 'Long lags', th: { op: '<', value: 5, source: SRC } },
  { id: 'relationship_types', name: 'Relationship types (finish to start)', th: { op: '>', value: 90, source: SRC } },
  { id: 'hard_constraints', name: 'Hard constraints', th: { op: '<', value: 1, source: SRC } },
  { id: 'soft_constraints', name: 'Soft constraints', th: { op: '<', value: 5, source: SRC } },
  { id: 'large_float', name: 'Large float', th: { op: '<', value: 1, source: SRC } },
  { id: 'negative_float', name: 'Negative float', th: { op: '<', value: 1, source: SRC } },
  { id: 'large_durations', name: 'Large durations', th: { op: '<', value: 5, source: SRC } },
  { id: 'invalid_progress_dates', name: 'Invalid progress dates', th: { op: '<', value: 1, source: SRC } },
  { id: 'resource_cost', name: 'Resource/Cost (no resources or expenses)', th: { op: '<', value: 1, source: SRC } },
  { id: 'late_activities', name: 'Late activities', th: { op: '<', value: 5, source: SRC } },
  { id: 'bei', name: 'Baseline Execution Index (BEI)', th: { op: '>', value: 0.95, source: SRC } },
];

export interface CheckScheduleOptions {
  projIds?: string[]; hoursPerDay?: number;
  /** which checks to run (default all) */
  checks?: string[];
  /** target overrides by check id (percent, or ratio for bei) */
  targets?: Record<string, number>;
  /** the long lag / large float / large duration threshold in hours (default 44 days x hours per day) */
  thresholdHours?: number;
  /** activities listed per check (default 100; 0 = all) */
  maxIds?: number;
}

export interface CheckScheduleReport {
  report: 'Check Schedule';
  projects: { id: string; name: string; data_date: string | null; activities: number; completed: number; relationships: number; missing_baseline_activities: number | null }[];
  threshold_hours: number;
  summary: { checked: number; failed: number; passed: number; not_assessed: number };
  checks: CheckResult[];
}

export function checkSchedule(db: Db, o: CheckScheduleOptions = {}): CheckScheduleReport {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, calendarDays: false });
  const maxIds = o.maxIds ?? 100, thH = o.thresholdHours ?? 44 * s.hpd;
  const want = new Set(o.checks?.length ? o.checks : P6_CHECKS.map((c) => c.id));
  const th = (id: string): Threshold => { const d = P6_CHECKS.find((c) => c.id === id)!.th; return o.targets?.[id] != null ? { ...d, value: o.targets[id], source: 'override' } : d; };
  const name = (id: string) => P6_CHECKS.find((c) => c.id === id)!.name;
  const out: CheckResult[] = [];
  const add = (id: string, f: () => CheckResult) => { if (want.has(id)) out.push(f()); };
  const preds = (t: Row) => s.ctx.predsOf.get(t.task_id) ?? [];
  const succs = (t: Row) => s.ctx.succsOf.get(t.task_id) ?? [];
  const task = (id: string) => s.ctx.taskById.get(id);

  // Relationships: completed and WBS summary activities are not examined; started activities and start milestones need
  // no predecessor, finish milestones no successor.
  const relPop = s.tasks.filter((t) => !isDone(t) && !isWbs(t));
  add('logic', () => percentCheck('logic', name('logic'), relPop.filter((t) => {
    const needPred = !isStarted(t) && t.task_type !== 'TT_Mile', needSucc = t.task_type !== 'TT_FinMile';
    return (needPred && !preds(t).length) || (needSucc && !succs(t).length);
  }).map((t) => offender(t, s, !preds(t).length && !succs(t).length ? 'no predecessor, no successor' : !preds(t).length ? 'no predecessor' : 'no successor')), relPop.length, th('logic'), maxIds));

  // Lags and relationship types: relationships between two completed activities are not examined.
  const links = s.rels.filter((r) => { const a = task(r.pred_task_id), b = task(r.task_id); return !(a && b && isDone(a) && isDone(b)); });
  const lagOf = (r: Row) => Number(r.lag_hr_cnt || 0);
  add('negative_lags', () => percentCheck('negative_lags', name('negative_lags'), links.filter((r) => lagOf(r) < 0).map((r) => relOffender(r, s)), links.length, th('negative_lags'), maxIds));
  add('lags', () => percentCheck('lags', name('lags'), links.filter((r) => lagOf(r) > 0).map((r) => relOffender(r, s)), links.length, th('lags'), maxIds));
  add('long_lags', () => percentCheck('long_lags', name('long_lags'), links.filter((r) => lagOf(r) > thH).map((r) => relOffender(r, s)), links.length, th('long_lags'), maxIds, `Lags over ${thH} hours.`));
  add('relationship_types', () => {
    const fs = links.filter((r) => (r.pred_type || 'PR_FS') === 'PR_FS').length;
    const metric = pct(fs, links.length), t = th('relationship_types');
    const other = links.filter((r) => (r.pred_type || 'PR_FS') !== 'PR_FS').map((r) => relOffender(r, s));
    return { id: 'relationship_types', name: name('relationship_types'), unit: '%', metric, threshold: t, numerator: fs, denominator: links.length, result: !links.length || passes(metric!, t) ? 'pass' : 'fail', activities: maxIds ? other.slice(0, maxIds) : other, total_activities: other.length, note: 'The listed relationships are the ones that are not finish to start.' };
  });

  // Constraints: completed, WBS summary and LOE activities are not examined, nor start constraints on started activities.
  const cPop = s.tasks.filter((t) => !isDone(t) && !isWbs(t) && !isLoe(t));
  const live = (t: Row) => constraintsOf(t).filter((c) => !(isStarted(t) && START_CONSTRAINTS.has(c)));
  add('hard_constraints', () => percentCheck('hard_constraints', name('hard_constraints'), cPop.filter((t) => live(t).some((c) => P6_HARD.has(c))).map((t) => offender(t, s, live(t).join(', '))), cPop.length, th('hard_constraints'), maxIds, 'Mandatory Start and Mandatory Finish.'));
  add('soft_constraints', () => percentCheck('soft_constraints', name('soft_constraints'), cPop.filter((t) => live(t).some((c) => P6_SOFT.has(c))).map((t) => offender(t, s, live(t).join(', '))), cPop.length, th('soft_constraints'), maxIds, 'Start/Finish On, On or Before, On or After, As Late As Possible.'));

  // Float and durations: completed, WBS summary and LOE activities are not examined.
  const tf = (t: Row) => (t.total_float_hr_cnt === '' || t.total_float_hr_cnt == null ? null : Number(t.total_float_hr_cnt));
  add('large_float', () => percentCheck('large_float', name('large_float'), cPop.filter((t) => (tf(t) ?? -Infinity) > thH).map((t) => offender(t, s, `${tf(t)} h`)), cPop.length, th('large_float'), maxIds, `Total float over ${thH} hours.`));
  add('negative_float', () => percentCheck('negative_float', name('negative_float'), cPop.filter((t) => (tf(t) ?? 0) < 0).map((t) => offender(t, s, `${tf(t)} h`)), cPop.length, th('negative_float'), maxIds));
  add('large_durations', () => percentCheck('large_durations', name('large_durations'), cPop.filter((t) => Number(t.remain_drtn_hr_cnt || 0) > thH).map((t) => offender(t, s, `${Number(t.remain_drtn_hr_cnt)} h`)), cPop.length, th('large_durations'), maxIds, `Remaining duration over ${thH} hours.`));

  // Invalid progress dates: not started with a start or remaining start before the data date; in progress with a
  // remaining start before it or an actual start after it; completed with an actual finish after it.
  add('invalid_progress_dates', () => {
    const pop = s.tasks.filter((t) => !isWbs(t));
    const bad: Offender[] = [];
    for (const t of pop) {
      const dd = s.dataDate(t.proj_id);
      if (dd == null) continue;
      const d = (v?: string) => parseP6Date(v);
      const before = (v?: string) => { const x = d(v); return x != null && x < dd; }, after = (v?: string) => { const x = d(v); return x != null && x > dd; };
      if (isDone(t)) { if (after(t.act_end_date)) bad.push(offender(t, s, 'actual finish after the data date')); }
      else if (t.act_start_date) { if (after(t.act_start_date)) bad.push(offender(t, s, 'actual start after the data date')); else if (before(t.restart_date)) bad.push(offender(t, s, 'remaining start before the data date')); }
      else if (before(t.early_start_date || t.target_start_date) || before(t.restart_date)) bad.push(offender(t, s, 'start before the data date'));
    }
    return percentCheck('invalid_progress_dates', name('invalid_progress_dates'), bad, pop.length, th('invalid_progress_dates'), maxIds);
  });

  // Resource/Cost: an activity passes with at least one resource or expense; milestones, WBS summary and LOE are not examined.
  add('resource_cost', () => {
    const withRes = new Set([...rows(db, 'TASKRSRC').map((a) => a.task_id), ...rows(db, 'PROJCOST').map((c) => c.task_id)]);
    const pop = s.tasks.filter((t) => !isMilestone(t) && !isWbs(t) && !isLoe(t));
    return percentCheck('resource_cost', name('resource_cost'), pop.filter((t) => !withRes.has(t.task_id)).map((t) => offender(t, s)), pop.length, th('resource_cost'), maxIds);
  });

  // Late activities and BEI need the project baseline.
  const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(db, p, 'project')]));
  const anyBaseline = [...bls.values()].some(Boolean);
  add('late_activities', () => {
    if (!anyBaseline) return notAssessed('late_activities', name('late_activities'), '%', th('late_activities'), 'No project baseline is assigned (Project > Assign Baselines).');
    const pop = s.tasks.filter((t) => !isDone(t) && !isWbs(t) && !isLoe(t));
    const late = pop.filter((t) => {
      const b = bls.get(t.proj_id)?.tasks.get(t.task_code);
      if (!b) return true; // no baseline counterpart: fails, as in P6
      const f = parseP6Date(t.reend_date || t.early_end_date), bf = baselineFinish(b);
      return f != null && bf != null && f > bf;
    }).map((t) => offender(t, s, bls.get(t.proj_id)?.tasks.get(t.task_code) ? 'finishes after its baseline' : 'not in the baseline'));
    return percentCheck('late_activities', name('late_activities'), late, pop.length, th('late_activities'), maxIds);
  });
  add('bei', () => {
    if (!anyBaseline) return notAssessed('bei', name('bei'), 'ratio', th('bei'), 'No project baseline is assigned (Project > Assign Baselines).');
    const ok = (t: Row) => !isMilestone(t) && !isWbs(t) && !isLoe(t);
    const done = s.tasks.filter((t) => ok(t) && isDone(t)).length;
    const due: Offender[] = [];
    for (const p of s.projs) {
      const b = bls.get(p.proj_id), dd = s.dataDate(p.proj_id);
      if (!b || dd == null) continue;
      const byCode = new Map(s.tasks.filter((t) => t.proj_id === p.proj_id).map((t) => [t.task_code, t]));
      for (const bt of b.tasks.values()) if (ok(bt) && (baselineFinish(bt) ?? Infinity) < dd) {
        const cur = byCode.get(bt.task_code);
        if (!cur || !isDone(cur)) due.push({ id: bt.task_code, name: bt.task_name, value: 'baselined to finish before the data date, not completed' });
      }
    }
    const dueN = s.projs.reduce((n, p) => { const b = bls.get(p.proj_id), dd = s.dataDate(p.proj_id); return n + (b && dd != null ? [...b.tasks.values()].filter((bt) => ok(bt) && (baselineFinish(bt) ?? Infinity) < dd).length : 0); }, 0);
    if (!dueN) return { ...notAssessed('bei', name('bei'), 'ratio', th('bei'), 'No baseline activity was due to finish before the data date.'), numerator: done, denominator: 0 };
    const metric = Math.round((done / dueN) * 1000) / 1000;
    return { id: 'bei', name: name('bei'), unit: 'ratio', metric, threshold: th('bei'), numerator: done, denominator: dueN, result: passes(metric, th('bei')) ? 'pass' : 'fail', activities: maxIds ? due.slice(0, maxIds) : due, total_activities: due.length, note: 'Completed activities over baseline activities due to finish before the data date (milestones, WBS summary and LOE excluded). Listed: due but not completed.' };
  });

  const order = new Map(P6_CHECKS.map((c, i) => [c.id, i]));
  out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    report: 'Check Schedule',
    projects: s.projs.map((p) => {
      const ts = s.tasks.filter((t) => t.proj_id === p.proj_id), b = bls.get(p.proj_id);
      return { id: p.proj_short_name, name: s.ctx.wbs.get(rows(db, 'PROJWBS').find((w) => w.proj_id === p.proj_id && w.proj_node_flag === 'Y')?.wbs_id ?? '')?.wbs_name ?? p.proj_short_name, data_date: p.last_recalc_date?.slice(0, 16) || null, activities: ts.length, completed: ts.filter(isDone).length, relationships: s.rels.filter((r) => r.proj_id === p.proj_id).length, missing_baseline_activities: b ? ts.filter((t) => !b.tasks.has(t.task_code)).length : null };
    }),
    threshold_hours: thH,
    summary: { checked: out.length, failed: out.filter((c) => c.result === 'fail').length, passed: out.filter((c) => c.result === 'pass').length, not_assessed: out.filter((c) => c.result === 'not_assessed').length },
    checks: out,
  };
}
