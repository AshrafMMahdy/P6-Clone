// The figures the Bellator Schedule Intelligence analyses stand on, worked out on this clone's own tables (the analyses are the clone's own,
// like DCMA): float counts, logic figures with the logic-audit score, progress anomalies with the integrity score, per-activity variance with
// the slip classes, and the grade and band tables. Each is ported from the function named in its comment (our TypeScript copy of the benchmark,
// "Bellatorsi API/src/..."), reading the real thing: P6's stored total float and critical flag (no second CPM), working days on each
// activity's calendar, the project's baselines, actual dates and data date. Every number carried over from the source says where it is
// (file:line); none is a choice of this clone. Where the source falls back to an invented value (no data date -> the earliest start,
// a ratio of 1 for an empty population, a divisor of 1 for no activities) the helper answers `not_assessed` with the reason instead.
import { groupBy, rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { isCritical } from '../project/ctx.ts';
import { percentComplete, reportedPercent } from '../cost/rollup.ts';
import { startedBeforeFsPredecessor } from '../query/review.ts';
import { findLoops } from '../xer/validate.ts';
import { baselineOf, baselineFinish, constraintsOf, DCMA_HARD, forecastFinish, isDone, isLoe, isMilestone, isWbs, offender, type Offender, type Scope } from './common.ts';
import { matchActivities, type Update } from './delay.ts';

/** What a figure answers: its numbers, or that it could not be worked out and why (as a dcma_14 check does: result not_assessed with a note). */
export type Assessed<T> = ({ result: 'assessed' } & T) | { result: 'not_assessed'; note: string };
const notAssessed = (note: string): { result: 'not_assessed'; note: string } => ({ result: 'not_assessed', note });
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const share = (n: number, d: number) => (d ? r3(n / d) : null);

// ---------------------------------------------------------------------------------------------------------------------------------
// The grade and band tables the analyses share

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
/** Score -> letter grade, null for no score. Bellatorsi API/src/types/enums.ts:61-66 (>= 90 A, 80 B, 70 C, 60 D, else F); null for null/NaN: endpoints/forensics/_shared.ts:19-22. */
export const gradeOf = (score: number | null | undefined): Grade | null => (score == null || Number.isNaN(score) ? null : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F');
/** Risk (0 = none) -> letter grade, inverted: lower risk, better grade. endpoints/forensics/_shared.ts:28-31. */
export const riskGradeOf = (risk: number): Grade | null => gradeOf(100 - risk);
/** Risk score -> level. endpoints/forensics/scheduleRiskIndex.ts:65-71 (< 20 low, < 40 moderate, < 60 elevated, < 80 high, else critical). */
export const riskLevelOf = (risk: number): 'low' | 'moderate' | 'elevated' | 'high' | 'critical' => (risk < 20 ? 'low' : risk < 40 ? 'moderate' : risk < 60 ? 'elevated' : risk < 80 ? 'high' : 'critical');
/** A score where higher is better (logic score, integrity score) -> pass / warning / fail. logicAudit.ts:180 and progressAudit.ts:216 (>= 90 pass, >= 70 warning). */
export const scoreStatusOf = (score: number): 'pass' | 'warning' | 'fail' => (score >= 90 ? 'pass' : score >= 70 ? 'warning' : 'fail');
/** A risk where lower is better (schedule risk index, resource risk) -> pass / warning / fail. scheduleRiskIndex.ts:247 and resourceAnalysis.ts:320 (< 20 pass, < 50 warning). */
export const riskStatusOf = (risk: number): 'pass' | 'warning' | 'fail' => (risk < 20 ? 'pass' : risk < 50 ? 'warning' : 'fail');

// ---------------------------------------------------------------------------------------------------------------------------------
// Float figures (source core/float.ts:20-56 computeFloatMetrics)

/** Total float, in working days, up to which an activity that is not critical is near-critical. Bellatorsi API/src/core/float.ts:25 (also scheduleRiskIndex.ts:75). */
export const NEAR_CRITICAL_DAYS = 5;

export interface FloatFigures {
  /** the activities counted: incomplete, not WBS summary, not level of effort, with a stored total float */
  activities: number;
  critical: number; negative_float: number; near_critical: number;
  /** each as a fraction of the activities counted (0-1); critical_share is the source's critical_path_density (float.ts:48) */
  critical_share: number; negative_float_share: number; near_critical_share: number;
  /** (critical + near-critical) / activities: the source's float_erosion_rate (float.ts:54) */
  erosion_share: number;
  near_critical_days: number;
}

/** Counts and shares of critical, negative-float and near-critical activities, from P6's stored total float (in working days of each activity's calendar) and its critical flag
 *  (ctx.isCritical: the project's own rule, total float within its critical-float limit, or the longest path). Negative = total float below 0; near-critical = not critical and
 *  0 < float <= nearCriticalDays (float.ts:37-40). The source counts every task of its input; the clone counts incomplete work only (a finished activity has no float to count) and leaves out
 *  WBS summaries and level of effort, whose float is not their own. */
export function floatFigures(s: Scope, nearCriticalDays = NEAR_CRITICAL_DAYS): Assessed<FloatFigures> {
  const open = s.tasks.filter((t) => !isWbs(t) && !isLoe(t) && !isDone(t));
  const T = open.filter((t) => t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null);
  if (!T.length) return notAssessed(open.length ? 'No incomplete activity carries a total float: schedule the project (F9) first.' : 'The project has no incomplete activity.');
  let critical = 0, negative = 0, near = 0;
  for (const t of T) {
    const days = Number(t.total_float_hr_cnt) / s.dh.task(t);
    const crit = isCritical(t, s.ctx);
    if (crit) critical++;
    if (days < 0) negative++;
    if (!crit && days > 0 && days <= nearCriticalDays) near++;
  }
  return { result: 'assessed', activities: T.length, critical, negative_float: negative, near_critical: near, critical_share: r3(critical / T.length), negative_float_share: r3(negative / T.length), near_critical_share: r3(near / T.length), erosion_share: r3((critical + near) / T.length), near_critical_days: nearCriticalDays };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Logic figures (source core/logicMetrics.ts computeLogicMetrics, endpoints/forensics/logicAudit.ts computeLogicAuditCore)

/** The logic-audit score's weights per issue: open ends 1.0, leads 0.8, lags 0.3, hard constraints 0.6, out-of-sequence progress 1.0, redundant links 0.4. logicAudit.ts:87-92. */
export const LOGIC_WEIGHTS = { open_ends: 1.0, leads: 0.8, lags: 0.3, hard_constraints: 0.6, out_of_sequence: 1.0, redundant_links: 0.4 } as const;

export interface LogicFigures {
  /** the activities assessed: every activity but WBS summaries and level of effort (logicMetrics.ts:73, :85-87) */
  considered: number;
  /** relationships whose successor is in scope, by type (logicMetrics.ts:56-65) */
  relationships: number; fs: number; ss: number; ff: number; sf: number;
  /** finish-to-start share of the relationships (0-1); null when there are none (the source says 1: not carried over) */
  fs_share: number | null;
  /** no predecessor / no successor; milestones are exempt as the source's are (logicMetrics.ts:77-79) */
  open_starts: Offender[]; open_finishes: Offender[]; missing_logic: Offender[];
  /** open ends = activities with no predecessor or no successor, counted once (logicAudit.ts:82) */
  open_ends: number;
  /** activities with a negative-lag / positive-lag predecessor link (logicMetrics.ts:54-55) */
  leads: Offender[]; lags: Offender[];
  /** activities with a hard constraint (the DCMA set: Start/Finish On, On or Before, Mandatory; logicMetrics.ts:80-82, with the clone's DCMA_HARD) */
  hard_constraints: Offender[];
  /** started while a finish-to-start predecessor has not finished (logicAudit.ts:64-78; the rule of review.ts) */
  out_of_sequence: Offender[];
  /** links also implied by a path of two or more steps, of any relationship type (logicAudit.ts:195-232) */
  redundant_links: Offender[];
  /** 0-100 and its grade (logicAudit.ts:86-94, enums.ts:61-66) */
  score: number; grade: Grade;
}

/** An edge a -> b that is also reachable from a through a path of two or more steps, whatever the relationship types (source rule, logicAudit.ts:195-232: the walk starts from the
 *  other successors of a and looks for b). Exact: only an activity with another successor and a successor with another predecessor can have one, so only those are walked. */
export function redundantLinks(rels: Row[]): Row[] {
  const out = new Map<string, Row[]>(), inDeg = new Map<string, number>();
  for (const r of rels) { (out.get(r.pred_task_id) ?? out.set(r.pred_task_id, []).get(r.pred_task_id)!).push(r); inDeg.set(r.task_id, (inDeg.get(r.task_id) ?? 0) + 1); }
  const found: Row[] = [];
  for (const [from, links] of out) {
    if (links.length < 2) continue;
    for (const r of links) {
      if ((inDeg.get(r.task_id) ?? 0) < 2) continue;
      const seen = new Set<string>(), stack = links.filter((x) => x.task_id !== r.task_id).map((x) => x.task_id);
      let reached = false;
      while (stack.length) {
        const v = stack.pop()!;
        if (v === r.task_id) { reached = true; break; }
        if (seen.has(v)) continue;
        seen.add(v);
        for (const x of out.get(v) ?? []) stack.push(x.task_id);
      }
      if (reached) found.push(r);
    }
  }
  return found;
}

/** Open ends, leads, lags, hard constraints, out-of-sequence progress, redundant links and the link mix, with the logic-audit score. */
export function logicFigures(s: Scope): Assessed<LogicFigures> {
  const scoped = new Set(s.tasks.map((t) => t.task_id));
  const considered = s.tasks.filter((t) => !isWbs(t) && !isLoe(t));
  if (!considered.length) return notAssessed('The project has no activity to assess (WBS summaries and level of effort are not assessed).');
  const preds = (t: Row) => s.ctx.predsOf.get(t.task_id) ?? [], succs = (t: Row) => s.ctx.succsOf.get(t.task_id) ?? [];
  const lag = (r: Row) => Number(r.lag_hr_cnt || 0);
  const mine = s.rels.filter((r) => scoped.has(r.task_id));
  const type = (r: Row) => r.pred_type || 'PR_FS';
  const count = (ty: string) => mine.filter((r) => type(r) === ty).length;
  const openStarts: Offender[] = [], openFinishes: Offender[] = [], missing: Offender[] = [], hard: Offender[] = [];
  for (const t of considered) {
    const noPred = !preds(t).length, noSucc = !succs(t).length, mile = isMilestone(t);
    if (noPred && !mile) openStarts.push(offender(t, s));
    if (noSucc && !mile) openFinishes.push(offender(t, s));
    if (noPred && noSucc && !mile) missing.push(offender(t, s));
    if (constraintsOf(t).some((c) => DCMA_HARD.has(c))) hard.push(offender(t, s, constraintsOf(t).join(', ')));
  }
  const leads = s.tasks.filter((t) => preds(t).some((r) => lag(r) < 0)).map((t) => offender(t, s));
  const lags = s.tasks.filter((t) => preds(t).some((r) => lag(r) > 0)).map((t) => offender(t, s));
  const oos = s.tasks.filter((t) => !isWbs(t) && startedBeforeFsPredecessor(t, s.ctx)).map((t) => offender(t, s));
  const redundant = redundantLinks(s.rels.filter((r) => scoped.has(r.task_id) && scoped.has(r.pred_task_id))).map((r): Offender => {
    const p = s.ctx.taskById.get(r.pred_task_id), t = s.ctx.taskById.get(r.task_id);
    return { id: `${p?.task_code} -> ${t?.task_code}`, name: `${type(r).slice(3)}, also reached through other links`, value: 'redundant' };
  });
  const openEnds = new Set([...openStarts, ...openFinishes].map((o) => `${o.project ?? ''}|${o.id}`)).size;
  const W = LOGIC_WEIGHTS;
  const density = (openEnds * W.open_ends + leads.length * W.leads + lags.length * W.lags + hard.length * W.hard_constraints + oos.length * W.out_of_sequence + redundant.length * W.redundant_links) / considered.length;
  const score = r1(Math.max(0, 100 * (1 - density)));
  return {
    result: 'assessed', considered: considered.length,
    relationships: mine.length, fs: count('PR_FS'), ss: count('PR_SS'), ff: count('PR_FF'), sf: count('PR_SF'), fs_share: share(count('PR_FS'), mine.length),
    open_starts: openStarts, open_finishes: openFinishes, missing_logic: missing, open_ends: openEnds,
    leads, lags, hard_constraints: hard, out_of_sequence: oos, redundant_links: redundant, score, grade: gradeOf(score)!,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Progress anomalies (source endpoints/forensics/progressAudit.ts, rules PROGRESS-001..005)

export type ProgressRule = 'future_actuals' | 'invalid_sequence' | 'missing_actual_start' | 'out_of_sequence' | 'forecast_in_past';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
/** Severity weights of the integrity score. progressAudit.ts:49. */
export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 1.0, high: 0.7, medium: 0.4, low: 0.2 };
/** The rules and their severities: 001 future actuals high (progressAudit.ts:76-80), 002 finish before start critical (:89-93), 003 progress with no actual start medium (:102-106), 004 out of sequence high (:115-122),
 *  005 forecast in the past medium (:135-140). PROGRESS-005's second test (forecast finish before an actual finish of unfinished work, :147-151, severity low) cannot occur in a P6 file (an activity with an
 *  actual finish is complete, and its finish is the actual one): it is not carried over. */
export const PROGRESS_RULES: Record<ProgressRule, { code: string; severity: Severity }> = {
  future_actuals: { code: 'PROGRESS-001', severity: 'high' }, invalid_sequence: { code: 'PROGRESS-002', severity: 'critical' }, missing_actual_start: { code: 'PROGRESS-003', severity: 'medium' },
  out_of_sequence: { code: 'PROGRESS-004', severity: 'high' }, forecast_in_past: { code: 'PROGRESS-005', severity: 'medium' },
};

export interface ProgressAnomaly { rule: ProgressRule; severity: Severity; id: string; name: string; project?: string; message: string; predecessor?: string }
export interface ProgressFigures {
  /** the activities examined: every activity but WBS summaries and milestones (progressAudit.ts:67 excludes milestones), in a project with a data date */
  examined: number;
  anomalies: ProgressAnomaly[];
  by_severity: Record<Severity, number>; by_rule: Record<ProgressRule, number>;
  /** 0-100 (progressAudit.ts:163-169) and its grade */
  integrity_score: number; grade: Grade;
  /** projects left out for want of a data date (give a status_date to examine them) */
  projects_without_data_date: string[];
}

/** The progress anomalies against each project's data date (or the status date the scope was made with). A project with no data date is not examined: the source cannot tell what is "future" without one
 *  and falls back to ignoring the rules that need it (its status date is required; the risk index skips the whole sub-metric), so a scope with none at all is not assessed. */
export function progressAnomalies(s: Scope): Assessed<ProgressFigures> {
  const noDate = s.projs.filter((p) => s.dataDate(p.proj_id) == null);
  const pool = s.tasks.filter((t) => !isWbs(t) && !isMilestone(t) && s.dataDate(t.proj_id) != null);
  const asg = groupBy(s.db.tables.TASKRSRC?.rows ?? [], 'task_id');
  const without = noDate.map((p) => p.proj_short_name);
  if (!pool.length) return notAssessed(noDate.length ? `No data date in ${without.join(', ')}: give a status_date.` : 'The project has no activity to examine (WBS summaries and milestones are not examined).');
  const out: ProgressAnomaly[] = [];
  const add = (rule: ProgressRule, t: Row, message: string, predecessor?: string) => out.push({ rule, severity: PROGRESS_RULES[rule].severity, id: t.task_code, name: t.task_name, ...(s.projs.length > 1 ? { project: s.ctx.proj.get(t.proj_id)?.proj_short_name } : {}), message, ...(predecessor ? { predecessor } : {}) });
  for (const t of pool) {
    const dd = s.dataDate(t.proj_id)!;
    const as = parseP6Date(t.act_start_date), af = parseP6Date(t.act_end_date);
    const p = reportedPercent(t, asg.get(t.task_id) ?? []);
    if ((as != null && as > dd) || (af != null && af > dd)) add('future_actuals', t, 'An actual date is after the data date.');
    if (as != null && af != null && af < as) add('invalid_sequence', t, 'The actual finish is before the actual start.');
    if (p > 0 && as == null) add('missing_actual_start', t, `The activity is ${Math.round(p * 100)}% complete but has no actual start.`);
    if (startedBeforeFsPredecessor(t, s.ctx)) {
      const pred = s.ctx.taskById.get((s.ctx.predsOf.get(t.task_id) ?? []).find((r) => r.pred_type === 'PR_FS' && s.ctx.taskById.get(r.pred_task_id) && !s.ctx.taskById.get(r.pred_task_id)!.act_end_date)!.pred_task_id);
      add('out_of_sequence', t, `Started while the finish-to-start predecessor ${pred?.task_code} has not finished.`, pred?.task_code);
    }
    if (percentComplete(t, asg.get(t.task_id) ?? []) < 1) {
      // a started activity's start is its actual start; only the finish is a forecast (the dcma_14 invalid-dates rule)
      const fs = t.act_start_date ? null : parseP6Date(t.restart_date || t.early_start_date), ff = parseP6Date(t.reend_date || t.early_end_date);
      if ((fs != null && fs < dd) || (ff != null && ff < dd)) add('forecast_in_past', t, 'A forecast date of unfinished work is before the data date.');
    }
  }
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 }, byRule = { future_actuals: 0, invalid_sequence: 0, missing_actual_start: 0, out_of_sequence: 0, forecast_in_past: 0 };
  let penalty = 0;
  for (const a of out) { bySeverity[a.severity]++; byRule[a.rule]++; penalty += SEVERITY_WEIGHT[a.severity]; }
  const score = r1(Math.max(0, 100 * (1 - penalty / pool.length)));
  return { result: 'assessed', examined: pool.length, anomalies: out, by_severity: bySeverity, by_rule: byRule, integrity_score: score, grade: gradeOf(score)!, projects_without_data_date: without };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Per-activity variance and the slip classes (source core/variance.ts)

export type SlipClass = 'ahead' | 'on_time' | 'minor_slip' | 'moderate_slip' | 'major_slip' | 'severe_slip';
/** A finish variance in working days, positive = late: < 0 ahead, 0 on time, up to 5 minor, up to 15 moderate, up to 30 major, more severe. variance.ts:19-26. */
export const slipClassOf = (days: number): SlipClass => (days < 0 ? 'ahead' : days === 0 ? 'on_time' : days <= 5 ? 'minor_slip' : days <= 15 ? 'moderate_slip' : days <= 30 ? 'major_slip' : 'severe_slip');

export interface ActivityVariance {
  id: string; name: string; project?: string;
  reference_start: string | null; reference_finish: string | null; current_start: string | null; current_finish: string | null;
  /** working days on the activity's calendar, positive = later / longer than the reference; null when either date is missing or the activity has no counterpart */
  start_variance_days: number | null; finish_variance_days: number | null; duration_variance_days: number | null;
  slip_class: SlipClass | null;
}

const stamp = (m: number | null) => (m == null ? null : formatP6Date(m));
/** The activity's current start: actual, else forecast (early), else planned (variance.ts:45 currentStart). */
export const currentStart = (t: Row) => parseP6Date(t.act_start_date || t.early_start_date || t.target_start_date);
/** A reference (baseline or as-planned) activity's start: its actual start, else early, else planned (the start counterpart of common.ts baselineFinish). */
export const referenceStart = (b: Row | undefined) => (b ? parseP6Date(b.act_start_date || b.early_start_date || b.target_start_date) : null);

/** One activity against its reference counterpart: start, finish and duration variance in working days of the activity's calendar (variance.ts:50-76 computeTaskVariance, in calendar days there). Current =
 *  actual, else forecast (forecastFinish), else planned; reference = baselineFinish and referenceStart. Duration = start to finish in working days on both sides. */
export function activityVariance(s: Scope, t: Row, ref: Row | undefined): ActivityVariance {
  const base = { id: t.task_code, name: t.task_name, ...(s.projs.length > 1 ? { project: s.ctx.proj.get(t.proj_id)?.proj_short_name } : {}) };
  const rs = referenceStart(ref), rf = ref ? baselineFinish(ref) : null, cs = currentStart(t), cf = forecastFinish(t);
  const cal = s.cal(t), wd = (a: number | null, b: number | null) => (a != null && b != null ? s.workDays(cal, a, b) : null);
  const sv = wd(rs, cs), fv = wd(rf, cf), rd = wd(rs, rf), cd = wd(cs, cf);
  return { ...base, reference_start: stamp(rs), reference_finish: stamp(rf), current_start: stamp(cs), current_finish: stamp(cf), start_variance_days: sv, finish_variance_days: fv, duration_variance_days: rd != null && cd != null ? Math.round((cd - rd) * 100) / 100 : null, slip_class: fv != null ? slipClassOf(fv) : null };
}

export interface ReferencePairs {
  /** what the activities are compared with */
  name: string; how: string;
  /** every activity in scope but WBS summaries, with its counterpart (undefined: not in the reference: an activity added since) */
  pairs: Map<Row, Row | undefined>;
  /** projects that have no such reference (their activities have no counterpart) */
  projects_without: string[];
}

/** The activities paired with their baseline's (project baseline, bl1-bl3 or a saved baseline's name; by Activity ID, as dcma_14 pairs them). Not assessed when no project has it. */
export function baselinePairs(s: Scope, which = 'project'): Assessed<ReferencePairs> {
  const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(s.db, p, which)]));
  const first = [...bls.values()].find(Boolean);
  if (!first) return notAssessed(`No ${which === 'project' ? 'project' : which.toUpperCase()} baseline is assigned.`);
  const pairs = new Map<Row, Row | undefined>(s.tasks.filter((t) => !isWbs(t)).map((t) => [t, bls.get(t.proj_id)?.tasks.get(t.task_code)]));
  return { result: 'assessed', name: first.name, how: first.how, pairs, projects_without: s.projs.filter((p) => !bls.get(p.proj_id)).map((p) => p.proj_short_name) };
}

/** The activities paired with another schedule's (an as-planned schedule, an earlier update): by Activity ID, then by a name unique on both sides (delay.ts matchActivities). */
export function schedulePairs(s: Scope, other: { name: string; db: Scope['db']; projId: string }): Assessed<ReferencePairs> {
  const theirs = (other.db.tables.TASK?.rows ?? []).filter((t) => t.proj_id === other.projId && !isWbs(t));
  if (!theirs.length) return notAssessed(`${other.name} has no activity.`);
  const mine = s.tasks.filter((t) => !isWbs(t));
  const m = matchActivities(mine, theirs);
  return { result: 'assessed', name: other.name, how: 'a schedule of its own, matched by Activity ID, then by a unique name', pairs: new Map(mine.map((t) => [t, m.get(t)])), projects_without: [] };
}

/** The variance of every paired activity (rows in the order of the pairs). */
export const varianceRows = (s: Scope, ref: ReferencePairs): ActivityVariance[] => [...ref.pairs].map(([t, b]) => activityVariance(s, t, b));

// ---------------------------------------------------------------------------------------------------------------------------------
// Loops, and the clone's one BEI (shared by schedule_index, decm and planning_horizon)

/** The loops in the logic of the scope: the groups of two or more activities that lead back to themselves, found as the scheduler finds them (cpm.ts loopsOf: relationships between activities that are neither WBS summary
 *  nor level of effort), each as the Activity IDs in it. A schedule with a loop has no valid float and cannot be calculated (P6: "Circular relationship (loop) detected"). */
export function logicLoops(s: Scope): string[][] {
  const main = new Set(s.tasks.filter((t) => !isWbs(t) && !isLoe(t)).map((t) => t.task_id));
  const succ = new Map<string, string[]>();
  for (const r of s.rels) if (main.has(r.pred_task_id) && main.has(r.task_id)) (succ.get(r.pred_task_id) ?? succ.set(r.pred_task_id, []).get(r.pred_task_id)!).push(r.task_id);
  return findLoops(succ).map((l) => l.map((id) => s.ctx.taskById.get(id)?.task_code ?? id));
}
/** A loop as the scheduler words it (cpm.ts: "Loop: A → B → C → A"). */
export const loopMessage = (loop: string[]): string => `Loop: ${loop.join(' → ')} → ${loop[0]}`;

export interface BeiFigures { value: number; /** value before rounding: what a threshold is judged on */ exact: number; completed: number; due: number; not_completed: Offender[] }
export type BeiResult = ({ result: 'assessed' } & BeiFigures) | { result: 'not_assessed'; /** why: no baseline, no data date, or nothing baselined to finish by the date */ reason: 'no_baseline' | 'no_data_date' | 'none_due'; note: string; /** the tasks completed, counted all the same */ completed?: number };
/** The Baseline Execution Index, the clone's ONE definition (dcma_14 check 14, check_schedule's bei, schedule_index, decm, baseline_variance): tasks (not WBS summary, level of effort or milestones) completed, early ones included,
 *  over the tasks baselined to finish by the data date. Not assessed when no project has the baseline, or nothing was due (never 1). `value` is shown (three decimals), `exact` is what a threshold is judged on.
 *  `before`: a task baselined to finish ON the data date is not yet due (check_schedule's rule, "before the data date"); default: due on or before it (dcma_14's rule). */
export function beiFigures(s: Scope, bls: Map<string, ReturnType<typeof baselineOf>>, which = 'project', o: { before?: boolean } = {}): BeiResult {
  if (![...bls.values()].some(Boolean)) return { result: 'not_assessed', reason: 'no_baseline', note: `No ${which === 'project' ? 'project' : which.toUpperCase()} baseline is assigned.` };
  const ok = (t: Row) => !isWbs(t) && !isLoe(t) && !isMilestone(t);
  const completed = s.tasks.filter((t) => ok(t) && isDone(t)).length;
  const dueList: Offender[] = []; let due = 0;
  for (const p of s.projs) {
    const b = bls.get(p.proj_id), dd = s.dataDate(p.proj_id);
    if (!b || dd == null) continue;
    const cur = new Map(s.tasks.filter((t) => t.proj_id === p.proj_id).map((t) => [t.task_code, t]));
    for (const bt of b.tasks.values()) {
      const f = baselineFinish(bt) ?? Infinity;
      if (ok(bt) && (o.before ? f < dd : f <= dd)) { due++; const c = cur.get(bt.task_code); if (!c || !isDone(c)) dueList.push({ id: bt.task_code, name: bt.task_name, value: c ? 'not completed' : 'not in the current schedule' }); }
    }
  }
  if (!due) { const none = s.projs.every((p) => s.dataDate(p.proj_id) == null); return { result: 'not_assessed', reason: none ? 'no_data_date' : 'none_due', note: none ? 'The project has no data date: give a status_date.' : 'No task was baselined to finish by the data date.', completed }; }
  return { result: 'assessed', value: r3(completed / due), exact: completed / due, completed, due, not_completed: dueList };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A series of updates (decm, change_tracking)

/** The data date of an update's project (else its planned start). */
export const updateDate = (u: Update) => { const p = rows(u.db, 'PROJECT').find((x) => x.proj_id === u.projId); return parseP6Date(p?.last_recalc_date || p?.plan_start_date) ?? null; };
/** An update as a database of its one project, as compareSchedules reads a file (a baseline copy held in the same database as the project is such an update: its rows are shown as a project of their own). */
export function updateView(u: Update): Db {
  const main = rows(u.db, 'PROJECT').filter((p) => !p._baseline_of);
  if (main.length === 1 && main[0].proj_id === u.projId) return u.db;
  const p = rows(u.db, 'PROJECT').find((x) => x.proj_id === u.projId)!;
  const { _baseline_of: _b, ...row } = p;
  const tasks = rows(u.db, 'TASK').filter((t) => t.proj_id === u.projId), ids = new Set(tasks.map((t) => t.task_id));
  const T = u.db.tables;
  return { tables: { ...T, PROJECT: { ...T.PROJECT, rows: [row] }, TASK: { ...T.TASK, rows: tasks }, TASKPRED: { ...T.TASKPRED, rows: rows(u.db, 'TASKPRED').filter((r) => ids.has(r.task_id)) }, TASKRSRC: { ...T.TASKRSRC, rows: rows(u.db, 'TASKRSRC').filter((r) => ids.has(r.task_id)) }, PROJWBS: { ...T.PROJWBS, rows: rows(u.db, 'PROJWBS').filter((w) => w.proj_id === u.projId) } } as Db['tables'] };
}

