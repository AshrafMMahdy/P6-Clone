// schedule_index: the schedule health score and the schedule risk index, from the same figures, on the open file's own tables (the analyses are the clone's own, like DCMA). Ported from our copy of the Bellator
// Schedule Intelligence benchmark ("Bellatorsi API/src/endpoints/tier1/healthScore.ts" and "endpoints/forensics/scheduleRiskIndex.ts", with logicAudit.ts, progressAudit.ts and resourceAnalysis.ts behind them): the source's method
// numbers are carried over as they are, each with its file:line; what the clone does differently is P6's stored float and critical flag (no second CPM), working days on each activity's calendar, the real baselines, actual dates and
// data date, the clone's one BEI, and the real resource limits. Where a P6 file does not carry an input, the part is `not assessed` with the reason (never an invented 100, 1 or 0); a composite is re-weighted over the parts that
// are assessed (scheduleRiskIndex.ts:194-198) and the answer says which parts were left out and why.
import { groupBy, rows } from '../db.ts';
import { formatP6Date } from '../dates.ts';
import { isCritical } from '../project/ctx.ts';
import { resourceHistograms } from './curves.ts';
import { baselineOf, exactPct, namesText, pct, forecastFinish, isDone, isLoe, isMilestone, isWbs, makeScope, offender, baselineFinish, type Offender, type Scope } from './common.ts';
import * as F from './forensic.ts';

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

export interface Part { part: string; value: number | boolean | null; assessed: boolean; /** the weight of this part inside its score, where the score is a weighted sum */ weight?: number; note?: string }
export interface SubMetric { sub_metric: SubKey; weight: number; active: boolean; score: number | null; summary: string; /** why it is inactive */ reason?: string; parts: Part[] }

// ---------------------------------------------------------------------------------------------------------------------------------
// The method numbers (each: the source file and line it is carried over from)

/** Health weights: critical-path density 0.40, float erosion 0.35, structural integrity 0.15, relationship quality 0.10. healthScore.ts:39. */
export const HEALTH_WEIGHTS = { density: 0.4, float_erosion: 0.35, structural: 0.15, relationship: 0.1 } as const;
/** Risk weights: float 0.30, logic 0.25, baseline drift 0.20, progress integrity 0.15, resource 0.10. scheduleRiskIndex.ts:26. */
export const RISK_WEIGHTS = { float: 0.3, logic: 0.25, baseline_drift: 0.2, progress_integrity: 0.15, resource: 0.1 } as const;
export type SubKey = keyof typeof RISK_WEIGHTS;
/** Float risk = 100 x (0.5 x negative-float share + 0.3 x near-critical share + 0.2 x critical share), at most 100. scheduleRiskIndex.ts:87. */
const FLOAT_RISK = { negative: 0.5, near_critical: 0.3, critical: 0.2 } as const;
/** Baseline drift risk = at most 100 of: 2 x average finish variance (days, not below 0) + 40 x (1 - BEI, BEI at most 1) + critical-path delay (days, at most 30). scheduleRiskIndex.ts:149. */
const DRIFT = { variance_factor: 2, bei_factor: 40, delay_cap: 30 } as const;
/** Resource risk = 50 x share of limited resources over-allocated + 35 x share of work activities with no resource + 15 if an over-allocated resource is on a critical activity. resourceAnalysis.ts:258-261. */
const RESOURCE = { over_allocated: 0.5, coverage_gap: 0.35, critical_conflict: 0.15 } as const;
/** Driver severity: score >= 60 high, >= 30 medium, else low. scheduleRiskIndex.ts:212. */
const severityOf = (score: number) => (score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low');
/** The recommendation's expected reduction is half the driver's contribution (scheduleRiskIndex.ts:225); the standard it cites: logic -> DCMA-PAM-200.1, every other AACE-RP-27R-03 (:226; the citations are the source's, not checked here). */
const REDUCTION = 0.5;

export const HEALTH_METHOD = [
  'health score = 0.40 x density + 0.35 x float erosion + 0.15 x structural + 0.10 x relationship, over the parts assessed (healthScore.ts:39, :78-82)',
  'density score = 100 x (1 - max(0, critical share - 0.2) / 0.8) (healthScore.ts:65)',
  'float erosion score = 100 x (1 - 2 x (negative-float + 0.5 x near-critical) / activities) (healthScore.ts:68-69)',
  'structural score = 100 x (1 - open ends / activities); relationship score = FS share / 0.9 x 100, at most 100 (healthScore.ts:73, :76)',
  'near-critical = not critical, 0 < total float <= 5 working days (float.ts:25); a signal is raised for a negative-float activity, critical share over 50%, an open end, FS share under 90% (healthScore.ts:90-96)',
];
export const RISK_METHOD = [
  'risk index = sum of weight x score over the sub-metrics assessed / sum of their weights: float 0.30, logic 0.25, baseline drift 0.20, progress integrity 0.15, resource 0.10 (scheduleRiskIndex.ts:26, :194-197)',
  'float risk = 100 x (0.5 x negative-float share + 0.3 x near-critical share + 0.2 x critical share), at most 100 (:87)',
  'logic risk = 100 - the logic-audit score; progress integrity risk = 100 - the integrity score (:103, :165); logic-audit score = 100 x (1 - (open ends x 1.0 + leads x 0.8 + lags x 0.3 + hard constraints x 0.6 + out-of-sequence x 1.0 + redundant links x 0.4) / activities) (logicAudit.ts:86-94); integrity score = 100 x (1 - sum of severity weights (critical 1.0, high 0.7, medium 0.4, low 0.2) / activities examined) (progressAudit.ts:49, :163-169)',
  'baseline drift risk = at most 100 of: 2 x average finish variance (working days, not below 0) + 40 x (1 - BEI, at most 1) + critical-path delay (latest finish minus latest baseline finish, working days, at most 30) (:149)',
  'a part of the baseline drift that cannot be assessed (the BEI when no task was due, the delay when a side has no finish) adds nothing to the sum, as the source adds nothing for an absent one, and the answer says which parts the drift score counts (it is not an invented BEI of 1)',
  'a schedule with a loop cannot be calculated and its stored float is not valid: the whole risk index is not assessed and names the loop (as health gives no score)',
  'resource risk = 50 x over-allocated share of the resources that have a limit + 35 x share of work activities with no resource + 15 when an over-allocated resource is assigned to a critical activity, over the parts assessed (resourceAnalysis.ts:255-261)',
  'grade: 100 - risk >= 90 A, 80 B, 70 C, 60 D, else F (enums.ts:61-66); level: risk < 20 low, < 40 moderate, < 60 elevated, < 80 high, else critical (:65-71); status: < 20 pass, < 50 warning, else fail (:247)',
  'progress rule 005 (forecast in the past) differs from the source in one way: the source tests a forecast date ON OR BEFORE the status date (progressAudit.ts:136), the clone tests BEFORE the data date (in P6 remaining work starts ON the data date, so a date equal to it is not in the past; the rule dcma_14 check 9 already uses); a started activity\u2019s start is its actual start, so only its finish is a forecast',
  'driver severity: score >= 60 high, >= 30 medium, else low (:212); recommendation expected reduction = 0.5 x the driver’s contribution (:225)',
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Health

export interface HealthPart { score: number | null; weight: number; assessed: boolean; reason?: string }
export interface Health {
  result: 'assessed' | 'not_assessed'; note?: string;
  score?: number; grade?: F.Grade | null;
  breakdown?: Record<keyof typeof HEALTH_WEIGHTS, HealthPart>;
  top_signals?: string[];
  /** the share of the activities that have at least one link (the source's confidence is 0.5 + 0.5 x this, healthScore.ts:85-86) */
  connected_share?: number | null;
  left_out?: { part: string; reason: string }[];
}

function health(float: ReturnType<typeof F.floatFigures>, logic: ReturnType<typeof F.logicFigures>, loops: string[][]): Health {
  // a P6 schedule with a loop cannot be calculated: no score (the source goes on with a best-effort CPM and caps its confidence, healthScore.ts:87)
  if (loops.length) return { result: 'not_assessed', note: `The logic has ${loops.length === 1 ? 'a loop' : `${loops.length} loops`}, so the schedule cannot be calculated and has no health score (P6: "Circular relationship (loop) detected"): ${loops.map(F.loopMessage).join('; ')}.` };
  const gone = (note: string) => ({ score: null, weight: 0, assessed: false, reason: note });
  const b = {} as Record<keyof typeof HEALTH_WEIGHTS, HealthPart>;
  const W = HEALTH_WEIGHTS;
  if (float.result === 'assessed') {
    const total = float.activities, d = float.critical / total;
    b.density = { score: r1(clamp(100 * (1 - Math.max(0, d - 0.2) / 0.8))), weight: W.density, assessed: true };
    b.float_erosion = { score: r1(clamp(100 * (1 - 2 * ((float.negative_float * 1.0 + float.near_critical * 0.5) / total)))), weight: W.float_erosion, assessed: true };
  } else { b.density = { ...gone(float.note), weight: W.density }; b.float_erosion = { ...gone(float.note), weight: W.float_erosion }; }
  if (logic.result === 'assessed') {
    b.structural = { score: r1(clamp(100 * (1 - logic.open_ends / logic.considered))), weight: W.structural, assessed: true };
    // judged on the exact share (fs / relationships); the rounded fs_share is for display
    b.relationship = logic.relationships ? { score: r1(clamp(((logic.fs / logic.relationships) / 0.9) * 100)), weight: W.relationship, assessed: true } : { ...gone('The activities have no relationships (the source gives an FS share of 1 then; not carried over).'), weight: W.relationship };
  } else { b.structural = { ...gone(logic.note), weight: W.structural }; b.relationship = { ...gone(logic.note), weight: W.relationship }; }
  const on = (Object.keys(b) as (keyof typeof W)[]).filter((k) => b[k].assessed);
  const left = (Object.keys(b) as (keyof typeof W)[]).filter((k) => !b[k].assessed).map((k) => ({ part: k, reason: b[k].reason! }));
  if (!on.length) return { result: 'not_assessed', note: `No part of the health score could be assessed: ${left.map((l) => `${l.part}: ${l.reason}`).join(' ')}`, breakdown: b, left_out: left };
  const wsum = on.reduce((a, k) => a + b[k].weight, 0);
  const score = r1(on.reduce((a, k) => a + b[k].weight * b[k].score!, 0) / wsum);
  const signals: string[] = [];
  if (float.result === 'assessed') {
    if (float.negative_float > 0) signals.push(`${float.negative_float} activit${float.negative_float === 1 ? 'y' : 'ies'} with negative float`);
    if (float.critical / float.activities > 0.5) signals.push(`High critical-path density (${Math.round(float.critical_share * 100)}%)`);
  }
  if (logic.result === 'assessed') {
    if (logic.open_ends > 0) signals.push(`${logic.open_ends} open end${logic.open_ends === 1 ? '' : 's'} / missing logic`);
    if (logic.relationships && logic.fs / logic.relationships < 0.9) signals.push(`Only ${shownBelow(logic.fs, logic.relationships, 90)}% Finish-to-Start relationships`);
  }
  return { result: 'assessed', score, grade: F.gradeOf(score), breakdown: b, top_signals: signals, connected_share: logic.result === 'assessed' ? r3((logic.considered - logic.missing_logic.length) / logic.considered) : null, ...(left.length ? { left_out: left } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Risk sub-metrics

const sub = (key: SubKey, o: Omit<SubMetric, 'sub_metric' | 'weight'>): SubMetric => ({ sub_metric: key, weight: RISK_WEIGHTS[key], ...o });
const inactive = (key: SubKey, reason: string, parts: Part[] = []): SubMetric => sub(key, { active: false, score: null, summary: `Not assessed: ${reason}`, reason, parts });

function floatRisk(float: ReturnType<typeof F.floatFigures>, loops: string[][]): SubMetric {
  if (loops.length) return inactive('float', 'The logic has a loop, so P6’s stored float is not valid (a schedule with a loop cannot be calculated).');
  if (float.result !== 'assessed') return inactive('float', float.note);
  const n = float.activities, neg = float.negative_float / n, near = float.near_critical / n, crit = float.critical / n;
  const score = r1(Math.min(100, 100 * (FLOAT_RISK.negative * neg + FLOAT_RISK.near_critical * near + FLOAT_RISK.critical * crit)));
  return sub('float', { active: true, score, summary: `${float.negative_float} negative-float, ${float.near_critical} near-critical activit${float.near_critical === 1 ? 'y' : 'ies'}, ${float.critical} critical of ${n}`, parts: [
    { part: 'negative_float_share', value: r3(neg), assessed: true, weight: FLOAT_RISK.negative }, { part: 'near_critical_share', value: r3(near), assessed: true, weight: FLOAT_RISK.near_critical }, { part: 'critical_share', value: r3(crit), assessed: true, weight: FLOAT_RISK.critical }] });
}

function logicRisk(logic: ReturnType<typeof F.logicFigures>): SubMetric {
  if (logic.result !== 'assessed') return inactive('logic', logic.note);
  const score = r1(100 - logic.score);
  return sub('logic', { active: true, score, summary: `Logic score ${logic.score}/100 (${logic.grade})`, parts: [
    { part: 'logic_score', value: logic.score, assessed: true }, { part: 'open_ends', value: logic.open_ends, assessed: true }, { part: 'leads', value: logic.leads.length, assessed: true }, { part: 'lags', value: logic.lags.length, assessed: true },
    { part: 'hard_constraints', value: logic.hard_constraints.length, assessed: true }, { part: 'out_of_sequence', value: logic.out_of_sequence.length, assessed: true }, { part: 'redundant_links', value: logic.redundant_links.length, assessed: true }] });
}

function driftRisk(s: Scope, which: string, bls: Map<string, ReturnType<typeof baselineOf>>, pairs: ReturnType<typeof F.baselinePairs>): { metric: SubMetric; baseline: { which: string; name: string; how: string } | null } {
  if (pairs.result !== 'assessed') return { metric: inactive('baseline_drift', pairs.note), baseline: null };
  const baseline = { which, name: pairs.name, how: pairs.how };
  // the exact finish variances, in working days (the rounded days of the variance rows are for display)
  const vars = F.varianceDetail(s, pairs).map((v) => (v.exact.finish == null ? null : v.exact.finish / v.exact.day)).filter((v): v is number => v != null);
  if (!vars.length) return { metric: inactive('baseline_drift', 'No activity is in both the schedule and its baseline with finish dates on both sides.'), baseline };
  const avg = vars.reduce((a, b) => a + b, 0) / vars.length;
  // the critical-path delay: the latest current finish less the latest baseline finish (working days of the first project's calendar, as dcma_14 reads the project length)
  const latest = (xs: (number | null)[]) => xs.reduce<number | null>((m, x) => (x != null && (m == null || x > m) ? x : m), null);
  const baseLatest = latest([...bls.values()].flatMap((b) => (b ? [...b.tasks.values()].filter((t) => !isWbs(t)).map(baselineFinish) : []))), curLatest = latest(s.tasks.filter((t) => !isWbs(t)).map(forecastFinish));
  const delay = baseLatest != null && curLatest != null && s.projs[0] ? Math.max(0, s.workDays(s.projCal(s.projs[0]), baseLatest, curLatest)) : null;
  const bei = F.beiFigures(s, bls, which);
  const parts: Part[] = [
    { part: 'average_finish_variance_days', value: r2(avg), assessed: true, weight: DRIFT.variance_factor, note: `${vars.length} activities with both finishes` },
    bei.result === 'assessed' ? { part: 'bei', value: bei.value, assessed: true, weight: DRIFT.bei_factor, note: `${bei.completed} of ${bei.due} tasks due by the data date completed` } : { part: 'bei', value: null, assessed: false, note: bei.note },
    delay != null ? { part: 'critical_path_delay_days', value: delay, assessed: true, weight: DRIFT.delay_cap } : { part: 'critical_path_delay_days', value: null, assessed: false, note: 'No latest finish on one side.' },
  ];
  // a part that cannot be assessed is left out of the sum (it adds nothing), and the answer says so; it is not given a value
  const raw = Math.min(100, Math.max(0, avg * DRIFT.variance_factor) + (bei.result === 'assessed' ? (1 - Math.min(1, bei.value)) * DRIFT.bei_factor : 0) + (delay != null ? Math.min(DRIFT.delay_cap, delay) : 0));
  const out = parts.filter((p) => !p.assessed), label: Record<string, string> = { average_finish_variance_days: 'the finish variance', bei: 'the BEI', critical_path_delay_days: 'the critical-path delay' };
  // each part left out adds 0 to the sum, which is the same arithmetic as a part at its best value: say that plainly
  const asBest: Record<string, string> = { average_finish_variance_days: 'a finish variance of 0 days', bei: 'a BEI of 1', critical_path_delay_days: 'a critical-path delay of 0 days' };
  const counted = `the drift score therefore counts ${parts.filter((p) => p.assessed).map((p) => label[p.part]).join(' and ')} only: ${out.map((p) => `${label[p.part]} part adds nothing to the score (the same as ${asBest[p.part]})`).join('; ')}`;
  for (const p of out) p.note = `${p.note} Not assessed: ${counted}.`;
  return { baseline, metric: sub('baseline_drift', { active: true, score: r1(raw), parts,
    summary: `Average finish variance ${r1(avg)} d${bei.result === 'assessed' ? `, BEI ${bei.value}` : ''}${delay != null ? `, critical-path delay ${delay} d` : ''}${out.length ? `; ${out.map((p) => `${label[p.part]} not assessed (${bei.result !== 'assessed' && p.part === 'bei' ? bei.note : p.note})`).join('; ')}; ${counted}` : ''}` }) };
}

/** A share as a percent for display where the exact share is below a limit: the display helper's figure (pct, one decimal), with as many more decimals as it takes for the text never to read as the limit itself (89.96 % is not "90 %" under a 90 % rule). */
function shownBelow(n: number, d: number, limit: number): number {
  let v = pct(n, d)!;
  for (let dec = 2; v >= limit; dec++) v = Number(exactPct(n, d).toFixed(dec));
  return v;
}

function integrityRisk(prog: ReturnType<typeof F.progressAnomalies>): SubMetric {
  if (prog.result !== 'assessed') return inactive('progress_integrity', prog.note);
  const parts: Part[] = [{ part: 'integrity_score', value: prog.integrity_score, assessed: true }, { part: 'anomalies', value: prog.anomalies.length, assessed: true }, ...(['critical', 'high', 'medium', 'low'] as const).map((k) => ({ part: `${k}_anomalies`, value: prog.by_severity[k], assessed: true }))];
  return sub('progress_integrity', { active: true, score: r1(100 - prog.integrity_score), parts,
    summary: `${prog.anomalies.length} progress anomal${prog.anomalies.length === 1 ? 'y' : 'ies'} in ${prog.examined} activities examined${prog.projects_without_data_date.length ? `; not examined (no data date): ${namesText(prog.projects_without_data_date)}` : ''}` });
}

export interface ResourceRow { resource: string; name: string; limit_set: boolean; over_allocated: boolean; severity: string; over_allocated_periods: number; periods_total: number; peak_demand: number | null; peak_limit: number | null; on_critical_activity: boolean }
export interface ResourceFigures { resources: ResourceRow[]; limited: number; over_allocated: ResourceRow[]; work_activities: number; unresourced: Offender[] }

/** The resource part: over-allocation from the clone's resource histogram (weekly periods, its real limits; a resource with no limit set is left out of over-allocation, as the histogram leaves it), the coverage gap on dcma_14 check 10's
 *  population and loading rule (an incomplete task that is not WBS summary, level of effort or a milestone, with no resource or expense loaded), and whether an over-allocated resource is on a critical activity. */
function resourceRisk(s: Scope): { metric: SubMetric; figures: ResourceFigures | null } {
  const asg = rows(s.db, 'TASKRSRC').filter((a) => a.rsrc_id && s.projIds.has(a.proj_id || s.ctx.taskById.get(a.task_id)?.proj_id || ''));
  if (!asg.length) return { metric: inactive('resource', 'The file has no resource assignments.'), figures: null };
  const T = s.tasks.filter((t) => !isDone(t) && !isWbs(t) && !isLoe(t) && !isMilestone(t));
  const loaded = new Set([...asg, ...rows(s.db, 'PROJCOST').filter((c) => s.projIds.has(c.proj_id || s.ctx.taskById.get(c.task_id)?.proj_id || ''))].map((a) => a.task_id));
  const unresourced = T.filter((t) => !loaded.has(t.task_id)).map((t) => offender(t, s));
  const hist = resourceHistograms(s.db, [...s.projIds], { period: 'week' });
  const idsByName = groupBy(rows(s.db, 'RSRC'), 'rsrc_short_name');
  const criticalRsrc = new Set(asg.filter((a) => { const t = s.ctx.taskById.get(a.task_id); return t && !isWbs(t) && !isLoe(t) && isCritical(t, s.ctx); }).map((a) => a.rsrc_id));
  const resRows: ResourceRow[] = hist.resources.map((h) => {
    const limitSet = h.periods.some((p) => p.limit != null && p.limit > 0);
    return { resource: h.resource, name: h.name, limit_set: limitSet, over_allocated: limitSet && h.severity !== 'none', severity: h.severity, over_allocated_periods: limitSet ? h.over_allocated_periods : 0, periods_total: h.periods_total, peak_demand: h.peak?.demand ?? null, peak_limit: h.peak?.limit ?? null,
      on_critical_activity: (idsByName.get(h.resource) ?? []).some((r) => criticalRsrc.has(r.rsrc_id)) };
  });
  const limited = resRows.filter((r) => r.limit_set), over = resRows.filter((r) => r.over_allocated);
  const parts: Part[] = [];
  let num = 0, den = 0;
  const add = (part: string, weight: number, value: number | null, note: string) => { parts.push({ part, value: value == null ? null : r3(value), assessed: value != null, weight, note }); if (value != null) { num += weight * value; den += weight; } };
  add('over_allocated_share', RESOURCE.over_allocated, limited.length ? over.length / limited.length : null, limited.length ? `${over.length} of ${limited.length} resources with a limit over-allocated` : 'No resource has a limit set (Max Units/Time), so none can be over-allocated.');
  add('coverage_gap', RESOURCE.coverage_gap, T.length ? unresourced.length / T.length : null, T.length ? `${unresourced.length} of ${T.length} work activities have no resource or expense loaded` : 'No incomplete work activity.');
  add('critical_path_conflict', RESOURCE.critical_conflict, limited.length ? (over.some((r) => r.on_critical_activity) ? 1 : 0) : null, limited.length ? `${over.filter((r) => r.on_critical_activity).length} over-allocated resource(s) assigned to a critical activity` : 'No resource has a limit set.');
  const figures: ResourceFigures = { resources: resRows, limited: limited.length, over_allocated: over, work_activities: T.length, unresourced };
  if (!den) return { metric: inactive('resource', 'Neither the over-allocation nor the coverage could be assessed (no resource limit set and no incomplete work activity).', parts), figures };
  const score = r1(Math.min(100, (100 * num) / den));
  return { figures, metric: sub('resource', { active: true, score, parts, summary: `${over.length} over-allocated resource${over.length === 1 ? '' : 's'} of ${limited.length} with a limit; ${unresourced.length} of ${T.length} work activities without a resource${parts.some((p) => !p.assessed) ? `; left out: ${parts.filter((p) => !p.assessed).map((p) => `${p.part} (${p.note})`).join('; ')}` : ''}` }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The whole answer

export interface ScheduleIndexOptions { projIds?: string[]; hoursPerDay?: number; /** default: each project's data date */ statusDate?: number | null; /** project (default), bl1-bl3 or a saved baseline's name */ baseline?: string }

export interface Driver { rank: number; sub_metric: SubKey; description: string; score: number; weight: number; /** weight / sum of the active weights x score */ contribution: number; severity: 'high' | 'medium' | 'low' }
export interface Recommendation { priority: 'high' | 'medium' | 'low'; action: string; target_sub_metric: SubKey; expected_score_reduction: number; standards_citation: string }
export interface Risk {
  result: 'assessed' | 'not_assessed'; note?: string;
  score?: number; grade?: F.Grade | null; level?: ReturnType<typeof F.riskLevelOf>; status?: 'pass' | 'warning' | 'fail';
  sub_metrics: Record<SubKey, SubMetric>; assessed_sub_metrics: number;
  left_out: { sub_metric: SubKey; reason: string }[];
  drivers: Driver[]; recommendations: Recommendation[];
}

export interface ScheduleIndexResult {
  report: 'Schedule index';
  /** the data date (or status date) of the projects; null when the projects in scope have different ones (status_dates then says each) */
  status_date: string | null;
  /** each project's data date, given when the scope has more than one project */
  status_dates?: { project: string; status_date: string | null }[];
  baseline: { which: string; name: string; how: string } | null;
  /** the loops found in the logic (a schedule with a loop has no health score and no valid float) */
  loops: { activities: string[]; message: string }[];
  health: Health; risk: Risk;
  logic: F.Assessed<F.LogicFigures>; progress: F.Assessed<F.ProgressFigures>; resources: { result: 'assessed' | 'not_assessed'; note?: string } & Partial<ResourceFigures>;
  method: { health: string[]; risk: string[]; note: string };
}

export function scheduleIndex(db: Parameters<typeof makeScope>[0], o: ScheduleIndexOptions = {}): ScheduleIndexResult {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, statusDate: o.statusDate, calendarDays: true });
  const which = o.baseline ?? 'project';
  const loops = F.logicLoops(s);
  const float = F.floatFigures(s), logic = F.logicFigures(s), prog = F.progressAnomalies(s);
  const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(s.db, p, which)]));
  const drift = driftRisk(s, which, bls, F.baselinePairs(s, which));
  const res = resourceRisk(s);
  const subs: Record<SubKey, SubMetric> = { float: floatRisk(float, loops), logic: logicRisk(logic), baseline_drift: drift.metric, progress_integrity: integrityRisk(prog), resource: res.metric };
  // a schedule with a loop cannot be calculated: its stored float is not valid, so no part of the risk index stands (as health gives no score); every sub-metric says so
  if (loops.length) for (const k of Object.keys(subs) as SubKey[]) subs[k] = inactive(k, `The logic has ${loops.length === 1 ? 'a loop' : `${loops.length} loops`}, so the schedule cannot be calculated and its stored float is not valid (P6: "Circular relationship (loop) detected"): ${loops.map(F.loopMessage).join('; ')}. Remove the loop (break one relationship of it), schedule the project (F9) and run this again.`);
  const keys = Object.keys(subs) as SubKey[], active = keys.filter((k) => subs[k].active);
  const left = keys.filter((k) => !subs[k].active).map((k) => ({ sub_metric: k, reason: subs[k].reason! }));
  let risk: Risk;
  if (!active.length) risk = { result: 'not_assessed', note: loops.length ? `The risk index is not assessed: ${left[0].reason}` : `No sub-metric could be assessed: ${left.map((l) => `${l.sub_metric}: ${l.reason}`).join(' ')}`, sub_metrics: subs, assessed_sub_metrics: 0, left_out: left, drivers: [], recommendations: [] };
  else {
    const wsum = active.reduce((a, k) => a + subs[k].weight, 0);
    const score = r1(active.reduce((a, k) => a + subs[k].weight * subs[k].score!, 0) / wsum);
    const drivers: Driver[] = [...active].filter((k) => subs[k].score! > 0).sort((a, b) => subs[b].score! * subs[b].weight - subs[a].score! * subs[a].weight)
      .map((k, i) => ({ rank: i + 1, sub_metric: k, description: subs[k].summary, score: subs[k].score!, weight: subs[k].weight, contribution: r1((subs[k].weight / wsum) * subs[k].score!), severity: severityOf(subs[k].score!) }));
    const recommendations: Recommendation[] = drivers.map((d) => ({ priority: d.severity, action: `Reduce ${d.sub_metric.replace(/_/g, ' ')} risk: ${d.description}`, target_sub_metric: d.sub_metric, expected_score_reduction: r1(d.contribution * REDUCTION), standards_citation: d.sub_metric === 'logic' ? 'DCMA-PAM-200.1' : 'AACE-RP-27R-03' }));
    risk = { result: 'assessed', score, grade: F.riskGradeOf(score), level: F.riskLevelOf(score), status: F.riskStatusOf(score), sub_metrics: subs, assessed_sub_metrics: active.length, left_out: left, drivers, recommendations };
  }
  const dates = s.projs.map((p) => ({ project: p.proj_short_name, status_date: s.dataDate(p.proj_id) != null ? formatP6Date(s.dataDate(p.proj_id)!) : null }));
  const same = new Set(dates.map((d) => d.status_date)).size <= 1;
  return {
    report: 'Schedule index', status_date: same ? dates[0]?.status_date ?? null : null, ...(dates.length > 1 ? { status_dates: dates } : {}), baseline: drift.baseline,
    loops: loops.map((l) => ({ activities: l, message: F.loopMessage(l) })),
    health: health(float, logic, loops), risk, logic, progress: prog,
    resources: res.figures ? { result: 'assessed', ...res.figures } : { result: 'not_assessed', note: subs.resource.reason },
    method: { health: HEALTH_METHOD, risk: RISK_METHOD, note: 'The method numbers are the source’s (the Bellator benchmark copy), carried over as they are; they are not yet checked against a published standard.' },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The answer and its tables

export interface LogicFinding { code: string; severity: 'high' | 'medium' | 'low'; title: string; description: string; standard: string | null; activities: Offender[] }
/** The logic-audit findings of the source (logicAudit.ts:120-168): open ends (high when over 5% of the activities, else medium; DCMA check 1), leads (high; DCMA check 2), out-of-sequence progress (high; DECM 06A212a), redundant links (low).
 *  Lags and hard constraints count in the score but the source raises no finding for them: neither does this. */
export function logicFindings(l: F.Assessed<F.LogicFigures>): LogicFinding[] {
  if (l.result !== 'assessed') return [];
  const out: LogicFinding[] = [];
  const ends = [...new Map([...l.open_starts, ...l.open_finishes].map((o) => [`${o.project ?? ''}|${o.id}`, o])).values()];
  if (l.open_ends > 0) out.push({ code: 'LOGIC_OPEN_ENDS', severity: l.open_ends > l.considered * 0.05 ? 'high' : 'medium', title: 'Open-ended activities', description: `${l.open_ends} activit${l.open_ends === 1 ? 'y lacks' : 'ies lack'} a predecessor or a successor`, standard: 'DCMA Check #1', activities: ends });
  if (l.leads.length) out.push({ code: 'LOGIC_LEADS', severity: 'high', title: 'Negative lag (leads)', description: `${l.leads.length} activit${l.leads.length === 1 ? 'y uses' : 'ies use'} leads`, standard: 'DCMA Check #2', activities: l.leads });
  if (l.out_of_sequence.length) out.push({ code: 'LOGIC_OUT_OF_SEQUENCE', severity: 'high', title: 'Out-of-sequence progress', description: `${l.out_of_sequence.length} activit${l.out_of_sequence.length === 1 ? 'y has' : 'ies have'} started while a finish-to-start predecessor has not finished`, standard: 'DCMA DECM 06A212a', activities: l.out_of_sequence });
  if (l.redundant_links.length) out.push({ code: 'LOGIC_REDUNDANT_RELATIONSHIPS', severity: 'low', title: 'Redundant relationships', description: `${l.redundant_links.length} relationship${l.redundant_links.length === 1 ? ' is' : 's are'} also implied by a longer path`, standard: null, activities: l.redundant_links });
  return out;
}

const parts = (m: SubMetric) => m.parts.map((p) => `${p.part}=${p.assessed ? p.value : 'not assessed'}`).join('; ');

/** The answer (every list cut by `first`, the true total beside it), the whole result and the tables, in the order the answer reads: summary first. */
export function shapeScheduleIndex(r: ScheduleIndexResult, first: <T>(l: T[]) => T[]) {
  const findings = logicFindings(r.logic);
  const anomalies = r.progress.result === 'assessed' ? r.progress.anomalies : [];
  const resourceRows = (r.resources.resources ?? []).slice().sort((a, b) => Number(b.over_allocated) - Number(a.over_allocated) || b.over_allocated_periods - a.over_allocated_periods || (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
  const unresourced = r.resources.unresourced ?? [];
  const risk = r.risk;
  const { drivers: _drivers, recommendations: _recs, ...riskRest } = risk;
  const summary = {
    status_date: r.status_date, ...(r.status_dates ? { status_dates: r.status_dates, status_dates_total: r.status_dates.length } : {}), baseline: r.baseline,
    health: r.health.result === 'assessed' ? { score: r.health.score, grade: r.health.grade } : { result: 'not_assessed', note: r.health.note },
    risk: risk.result === 'assessed' ? { score: risk.score, grade: risk.grade, level: risk.level, status: risk.status, sub_metrics_assessed: `${risk.assessed_sub_metrics} of 5`, left_out: risk.left_out } : { result: 'not_assessed', note: risk.note },
    loops: r.loops.length,
  };
  const loopsNote = r.loops.length ? { loops: r.loops } : {};
  const subTable = (Object.values(risk.sub_metrics) as SubMetric[]).map((m) => ({ sub_metric: m.sub_metric, weight: m.weight, active: m.active, score: m.score, summary: m.summary, reason: m.reason ?? '', parts: parts(m) }));
  const driverRows = risk.drivers.map((d, i) => ({ ...d, action: risk.recommendations[i].action, expected_score_reduction: risk.recommendations[i].expected_score_reduction, standards_citation: risk.recommendations[i].standards_citation }));
  const whole = {
    report: r.report, summary, ...loopsNote, health: r.health, risk: riskRest,
    drivers: driverRows, drivers_total: driverRows.length, recommendations: risk.recommendations, recommendations_total: risk.recommendations.length,
    logic_findings: findings.map((f) => ({ ...f, activities_total: f.activities.length })),
    progress_summary: r.progress.result === 'assessed' ? { result: 'assessed', examined: r.progress.examined, integrity_score: r.progress.integrity_score, grade: r.progress.grade, by_severity: r.progress.by_severity, by_rule: r.progress.by_rule, projects_without_data_date: r.progress.projects_without_data_date } : r.progress,
    progress_anomalies: anomalies, progress_anomalies_total: anomalies.length,
    resource_summary: r.resources.result === 'assessed' ? { result: 'assessed', resources: resourceRows.length, with_limit: r.resources.limited, over_allocated: r.resources.over_allocated!.length, work_activities: r.resources.work_activities, without_resource: unresourced.length } : r.resources,
    resources: resourceRows, resources_total: resourceRows.length, unresourced_activities: unresourced, unresourced_activities_total: unresourced.length,
    method: r.method,
  };
  // each project's data date by the list rule: the first of them, the true total and a note where it is cut (the whole list is in the result file)
  const cutDates = r.status_dates && r.status_dates.length > first(r.status_dates).length ? { status_dates: first(r.status_dates), status_dates_note: `The first ${first(r.status_dates).length} of ${r.status_dates.length} projects; the data date of every project is in the result file.` } : {};
  const answer = {
    ...whole,
    summary: { ...summary, ...cutDates },
    // the sub-metric breakdown of the risk stays whole (five entries); the lists are cut to the clone's rule
    drivers: first(whole.drivers), recommendations: first(whole.recommendations),
    logic_findings: whole.logic_findings.map((f) => ({ ...f, activities: first(f.activities) })),
    progress_anomalies: first(anomalies), resources: first(resourceRows), unresourced_activities: first(unresourced),
  };
  const tables = [
    { name: 'sub_metrics', columns: ['sub_metric', 'weight', 'active', 'score', 'summary', 'reason', 'parts'], rows: subTable },
    { name: 'drivers', columns: ['rank', 'sub_metric', 'score', 'weight', 'contribution', 'severity', 'description', 'action', 'expected_score_reduction', 'standards_citation'], rows: driverRows },
    { name: 'logic_findings', columns: ['finding', 'severity', 'standard', 'id', 'name', 'project', 'value'], rows: findings.flatMap((f) => f.activities.map((a) => ({ finding: f.code, severity: f.severity, standard: f.standard ?? '', ...a }))) },
    { name: 'progress_anomalies', columns: ['rule', 'severity', 'id', 'name', 'project', 'message', 'predecessor'], rows: anomalies },
    { name: 'resources', columns: ['resource', 'name', 'limit_set', 'over_allocated', 'severity', 'over_allocated_periods', 'periods_total', 'peak_demand', 'peak_limit', 'on_critical_activity'], rows: resourceRows },
  ];
  return { answer, whole, tables };
}
