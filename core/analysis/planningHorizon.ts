// planning_horizon: how ready is the work that starts in the next 30, 60 and 90 days. Ported from our copy of the Bellator Schedule Intelligence benchmark ("Bellatorsi API/src/endpoints/forensics/planningHorizon.ts"), on the open
// file's own tables: the anchor is the data date (or a status date), an activity's start is its forecast start (else planned), P6's stored total float and critical flag, working days on the activity's calendar for float and forecast
// drift, resources from the file's real assignments. The source's numbers (weights, sub-rules, statuses) are carried over as they are, each with its file:line. What the clone does not invent: a file with no data date has no anchor
// (the source falls back to the earliest start, or to 2000-01-01); a P6 file has no approval field, so readiness is judged on logic, resources, float and forecast stability only; an empty window has
// no score (the source gives it 100).
import { groupBy, rows } from '../db.ts';
import { dataDateGaps } from './common.ts';
import { baselineReason, cap, loopNote, namesText, noDataDateNotAssessed, notAssessed, projectsText, tidyNotes } from '../notes.ts';
import { formatP6Date } from '../dates.ts';
import { reportedPercent } from '../cost/rollup.ts';
import { isCritical } from '../project/ctx.ts';
import { baselineFinish, baselineOf, forecastFinish, isDone, isLoe, isMilestone, isWbs, makeScope } from './common.ts';
import { currentStart, logicLoops } from './forensic.ts';

const r1 = (v: number) => Math.round(v * 10) / 10;
const DAY = 1440;

export type Dim = 'logic' | 'resources' | 'float' | 'forecast_stability';
/** The dimension weights: logic 0.25, resources 0.30, float 0.10, forecast stability 0.15 (a score is the weighted mean over the dimensions assessed for the activity, so only the proportions matter; the source's approvals dimension, 0.20, was never assessed on a P6 file and is gone). planningHorizon.ts:36. */
export const WEIGHTS: Record<Dim, number> = { logic: 0.25, resources: 0.3, float: 0.1, forecast_stability: 0.15 };
const DIMS = Object.keys(WEIGHTS) as Dim[];
/** The windows: 0-30, 31-60 and 61-90 calendar days after the anchor (the source's 30 / 60 / 90 day bands, :92-96, :137-141). */
export const BANDS = [{ name: '0-30 days', from: 0, to: 30 }, { name: '31-60 days', from: 31, to: 60 }, { name: '61-90 days', from: 61, to: 90 }] as const;
/** Float below 5 working days costs readiness (score = float / 5 x 100; negative float 0). planningHorizon.ts:90, :285-291. */
const MIN_FLOAT_DAYS = 5;
/** Forecast drift over 3 working days costs 5 points a day (score = 100 - (drift - 3) x 5, at least 0). planningHorizon.ts:91, :297-303. */
const MAX_DRIFT_DAYS = 3, DRIFT_PENALTY = 5;
/** Logic: no predecessor 60; a finish-to-start predecessor not complete 70. planningHorizon.ts:248-257. */
const LOGIC_NO_PRED = 60, LOGIC_PRED_OPEN = 70;
/** An activity or a dimension below 50 is weak; a dimension is a systemic gap when at least max(2, 30 %) of the activities have it weak. planningHorizon.ts:182-183. */
const WEAK = 50, SYSTEMIC_MIN = 2, SYSTEMIC_SHARE = 0.3;
/** Readiness status: >= 90 ready, >= 75 mostly ready, >= 50 at risk, else not ready. planningHorizon.ts:79-84. */
export type Status = 'ready' | 'mostly_ready' | 'at_risk' | 'not_ready';
export const statusOf = (score: number): Status => (score >= 90 ? 'ready' : score >= 75 ? 'mostly_ready' : score >= 50 ? 'at_risk' : 'not_ready');
/** The overall result: >= 85 pass, >= 65 warning, else fail. planningHorizon.ts:222. */
const overallOf = (score: number): 'pass' | 'warning' | 'fail' => (score >= 85 ? 'pass' : score >= 65 ? 'warning' : 'fail');
/** The trend across windows: the last scored window more than 5 above the first improving, more than 5 below degrading, else stable. planningHorizon.ts:330-337. */
const TREND = 5;


export interface DimScore { score: number; issues: string[] }
export interface HorizonActivity {
  id: string; name: string; project?: string; band: string;
  start: string; days_until_start: number; duration_days: number; on_critical_path: boolean;
  readiness_score: number; status: Status;
  /** the dimensions assessed for this activity */
  dimensions: Partial<Record<Dim, DimScore>>;
  /** the dimensions that could not be assessed for this activity alone (the reason is in the notes; the file-wide ones are said there too) */
  not_assessed: Dim[];
  issues: string[];
  /** the weakest dimension's first issue, for an at-risk or not-ready activity */
  risk?: string;
  /** its place among the window's risks (1 = lowest readiness) */
  risk_rank?: number;
}
export interface HorizonBand {
  band: string; window: { from_days: number; to_days: number };
  result: 'assessed' | 'not_assessed';
  activities_total: number; ready: number; at_risk: number;
  readiness_score: number | null; status: Status | null;
  breakdown: Record<Dim, number | null>;
  activities: HorizonActivity[];
  risks: { rank: number; id: string; project?: string; risk: string; days_until_start: number; readiness_score: number; impact: 'critical' | 'medium' }[];
}
export interface SystemicIssue { issue: string; dimension: Dim; description: string; action: string; activities: { id: string; name: string; project?: string; score: number }[] }
export interface HorizonResult {
  report: 'Planning horizon';
  status_date: string | null;
  result: 'assessed' | 'not_assessed';
  /** what was left out or replaced (a data date, a dimension that could not be assessed), each sentence once */
  notes: string[];
  summary: { activities_in_horizon: number; at_risk: number; readiness_score: number | null; status: 'pass' | 'warning' | 'fail' | null; readiness_trend: string | null; projects_without_data_date: string[] };
  loops: { activities: string[] }[];
  bands: HorizonBand[];
  systemic_issues: SystemicIssue[];
}

export function planningHorizon(db: Parameters<typeof makeScope>[0], o: { projIds?: string[]; hoursPerDay?: number; statusDate?: number | null; /** project (default), bl1-bl3 or a saved baseline's name */ baseline?: string } = {}): HorizonResult {
  const s = makeScope(db, { projIds: o.projIds, hoursPerDay: o.hoursPerDay, statusDate: o.statusDate, calendarDays: true });
  const noDate = s.projs.filter((p) => s.dataDate(p.proj_id) == null).map((p) => p.proj_short_name);
  const dd = s.projs.map((p) => s.dataDate(p.proj_id)).find((x) => x != null) ?? null;
  const ddNotes = s.dateNotes(false);
  const base = { report: 'Planning horizon' as const, status_date: dd != null ? formatP6Date(dd) : null };
  const empty = { activities_in_horizon: 0, at_risk: 0, readiness_score: null, status: null, readiness_trend: null, projects_without_data_date: noDate };
  const loops = logicLoops(s).map((l) => ({ activities: l }));
  // no anchor, no analysis (the source falls back to the earliest start, or to 2000-01-01)
  if (noDate.length === s.projs.length) {
    return { ...base, result: 'not_assessed', notes: tidyNotes(dataDateGaps(s.projs, 'planning horizon', 'status_date')), summary: empty, loops, bands: [], systemic_issues: [] };
  }
  // file-wide inputs
  const asgRows = rows(s.db, 'TASKRSRC').filter((a) => a.rsrc_id && s.projIds.has(a.proj_id || s.ctx.taskById.get(a.task_id)?.proj_id || ''));
  const cost = rows(s.db, 'PROJCOST').filter((c) => s.projIds.has(c.proj_id || s.ctx.taskById.get(c.task_id)?.proj_id || ''));
  const loaded = new Set([...asgRows, ...cost].map((a) => a.task_id));
  const hasResources = asgRows.length > 0;
  const asg = groupBy(rows(s.db, 'TASKRSRC'), 'task_id');
  const which = o.baseline ?? 'project';
  const bls = new Map(s.projs.map((p) => [p.proj_id, baselineOf(s.db, p, which)]));
  const anyBaseline = [...bls.values()].some(Boolean);
  const global: { dimension: Dim; weight: number; reason: string }[] = [
    ...(!hasResources ? [{ dimension: 'resources' as Dim, weight: WEIGHTS.resources, reason: 'the file has no resource assignments' }] : []),
    ...(!anyBaseline ? [{ dimension: 'forecast_stability' as Dim, weight: WEIGHTS.forecast_stability, reason: baselineReason(namesText(s.projs.map((p) => p.proj_short_name)), true, which) }] : []),
    ...(loops.length ? [{ dimension: 'float' as Dim, weight: WEIGHTS.float, reason: loopNote(loops.flatMap((l) => l.activities)).replace(/^Loop: /, '').replace(/\.$/, '') }] : []),
  ];
  const off = new Set(global.map((g) => g.dimension));

  const acts: HorizonActivity[] = [], naAll: { id: string; dimension: Dim; reason: string }[] = [];
  for (const t of s.tasks) {
    // work with an actual start (finished or under way) is not work about to start
    if (isWbs(t) || isLoe(t) || t.act_start_date || isDone(t)) continue;
    const anchor = s.dataDate(t.proj_id), start = currentStart(t);
    if (anchor == null || start == null) continue;
    const days = Math.floor(start / DAY) - Math.floor(anchor / DAY); // calendar days: a look-ahead window is calendar time
    const band = BANDS.find((b) => days >= b.from && days <= b.to);
    if (!band) continue;
    const dims: Partial<Record<Dim, DimScore>> = {}, na: { dimension: Dim; reason: string }[] = [];
    // logic (planningHorizon.ts:245-258)
    {
      const preds = (s.ctx.predsOf.get(t.task_id) ?? []).filter((r) => s.ctx.taskById.has(r.pred_task_id));
      const issues: string[] = [];
      let score = 100;
      if (!preds.length) { score = LOGIC_NO_PRED; issues.push('No predecessor logic'); }
      for (const r of preds) {
        const p = s.ctx.taskById.get(r.pred_task_id)!;
        if ((r.pred_type || 'PR_FS') === 'PR_FS' && !isDone(p)) { score = Math.min(score, LOGIC_PRED_OPEN); issues.push(`Predecessor ${p.task_code} only ${Math.round(reportedPercent(p, asg.get(p.task_id) ?? []) * 100)}% complete`); }
      }
      dims.logic = { score, issues };
    }
    // resources (:260-262): an incomplete work activity with a resource or an expense loaded; a milestone carries no work to resource
    if (!off.has('resources')) {
      if (isMilestone(t)) na.push({ dimension: 'resources', reason: '' });
      else { const has = loaded.has(t.task_id); dims.resources = { score: has ? 100 : 0, issues: has ? [] : ['No resources assigned'] }; }
    }
    // float (:281-291), working days of the activity's calendar
    if (!off.has('float')) {
      if (t.total_float_hr_cnt === '' || t.total_float_hr_cnt == null) na.push({ dimension: 'float', reason: 'no stored total float; run schedule first' });
      else {
        const tf = Math.round((Number(t.total_float_hr_cnt) / s.dh.task(t)) * 100) / 100, issues: string[] = [];
        let score = 100;
        if (tf < 0) { score = 0; issues.push(`Negative float (${tf}d)`); } else if (tf < MIN_FLOAT_DAYS) { score = r1((tf / MIN_FLOAT_DAYS) * 100); issues.push(`Low float (${tf}d < ${MIN_FLOAT_DAYS}d)`); }
        dims.float = { score, issues };
      }
    }
    // forecast stability (:293-304): forecast finish against the baseline finish, working days of the activity's calendar
    if (!off.has('forecast_stability')) {
      const bl = bls.get(t.proj_id), bt = bl?.tasks.get(t.task_code), fc = forecastFinish(t), pl = baselineFinish(bt);
      if (!bl) na.push({ dimension: 'forecast_stability', reason: baselineReason(s.ctx.proj.get(t.proj_id)?.proj_short_name ?? '', true, which) });
      else if (!bt) na.push({ dimension: 'forecast_stability', reason: `not in the ${bl.name} baseline (added since)` });
      else if (fc == null || pl == null) na.push({ dimension: 'forecast_stability', reason: fc == null ? 'no forecast finish' : 'no baseline finish' });
      else {
        const drift = Math.abs(s.workDays(s.cal(t), pl, fc)), issues: string[] = [];
        let score = 100;
        if (drift > MAX_DRIFT_DAYS) { score = Math.max(0, r1(100 - (drift - MAX_DRIFT_DAYS) * DRIFT_PENALTY)); issues.push(`Forecast drift ${Math.round(drift)}d`); }
        dims.forecast_stability = { score, issues };
      }
    }
    for (const x of na) naAll.push({ id: t.task_code, ...x });
    const used = DIMS.filter((d) => dims[d]);
    const readiness = r1(used.reduce((a, d) => a + WEIGHTS[d] * dims[d]!.score, 0) / used.reduce((a, d) => a + WEIGHTS[d], 0));
    const weakest = used.reduce<Dim | null>((m, d) => (m == null || dims[d]!.score < dims[m]!.score ? d : m), null)!;
    const status = statusOf(readiness);
    acts.push({
      id: t.task_code, name: t.task_name, ...(s.projs.length > 1 ? { project: s.ctx.proj.get(t.proj_id)?.proj_short_name } : {}), band: band.name,
      start: formatP6Date(start), days_until_start: days, duration_days: Math.round((Number(t.remain_drtn_hr_cnt || t.target_drtn_hr_cnt || 0) / s.dh.task(t)) * 100) / 100, on_critical_path: isCritical(t, s.ctx),
      readiness_score: readiness, status, dimensions: dims, not_assessed: na.map((x) => x.dimension), issues: used.flatMap((d) => dims[d]!.issues),
      ...(status === 'at_risk' || status === 'not_ready' ? { risk: dims[weakest]!.issues[0] ?? `Weak ${weakest} readiness` } : {}),
    });
  }
  // worst first: the lists the answer cuts then show the activities that need attention
  acts.sort((a, b) => a.readiness_score - b.readiness_score || a.days_until_start - b.days_until_start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const mean = (xs: number[]) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const bands: HorizonBand[] = BANDS.map((b) => {
    const list = acts.filter((a) => a.band === b.name);
    const risky = list.filter((a) => a.status === 'at_risk' || a.status === 'not_ready');
    risky.forEach((a, i) => { a.risk_rank = i + 1; });
    const score = mean(list.map((a) => a.readiness_score));
    return {
      band: b.name, window: { from_days: b.from, to_days: b.to },
      result: list.length ? 'assessed' as const : 'not_assessed' as const,
      activities_total: list.length, ready: list.filter((a) => a.status === 'ready').length, at_risk: risky.length,
      readiness_score: score, status: score == null ? null : statusOf(score),
      breakdown: Object.fromEntries(DIMS.map((d) => [d, mean(list.filter((a) => a.dimensions[d]).map((a) => a.dimensions[d]!.score))])) as Record<Dim, number | null>,
      activities: list,
      risks: risky.map((a) => ({ rank: a.risk_rank!, id: a.id, ...(a.project ? { project: a.project } : {}), risk: a.risk!, days_until_start: a.days_until_start, readiness_score: a.readiness_score, impact: a.on_critical_path ? 'critical' as const : 'medium' as const })),
    };
  });
  // systemic issues (:179-190): a dimension weak across many of the activities it is assessed for
  const systemic: SystemicIssue[] = [];
  for (const d of DIMS) {
    const of = acts.filter((a) => a.dimensions[d]), weak = of.filter((a) => a.dimensions[d]!.score < WEAK);
    if (weak.length >= Math.max(SYSTEMIC_MIN, of.length * SYSTEMIC_SHARE)) systemic.push({ issue: `${d}_gap`, dimension: d, description: `${weak.length} near-term activit${weak.length === 1 ? 'y has' : 'ies have'} weak ${d.replace(/_/g, ' ')} readiness`, action: `Address ${d.replace(/_/g, ' ')} for the listed near-term activities before they start`, activities: weak.map((a) => ({ id: a.id, name: a.name, ...(a.project ? { project: a.project } : {}), score: a.dimensions[d]!.score })) });
  }
  const scored = bands.filter((b) => b.readiness_score != null);
  const trend = scored.length < 2 ? null : scored[scored.length - 1].readiness_score! > scored[0].readiness_score! + TREND ? 'improving_further_out' : scored[scored.length - 1].readiness_score! < scored[0].readiness_score! - TREND ? 'degrading_further_out' : 'stable';
  const overall = mean(acts.map((a) => a.readiness_score));
  const summary = {
    activities_in_horizon: acts.length, at_risk: acts.filter((a) => a.status === 'at_risk' || a.status === 'not_ready').length, readiness_score: overall, status: overall == null ? null : overallOf(overall),
    readiness_trend: trend, projects_without_data_date: noDate,
  };
  // what could not be assessed: for the whole file (said as one), and per activity (by dimension and reason, the activities named)
  const per = new Map<string, string[]>();
  for (const x of naAll) if (x.reason) { const k = `${x.dimension}|${x.reason}`; (per.get(k) ?? per.set(k, []).get(k)!).push(x.id); }
  const notes = tidyNotes([...ddNotes, ...global.map((g) => notAssessed(g.dimension.replace(/_/g, ' '), g.reason)), ...[...per].map(([k, ids]) => { const [dim, reason] = k.split('|'); return `${cap(dim.replace(/_/g, ' '))} not assessed for ${namesText(ids)}: ${reason}.`; })]);
  if (!acts.length) return { ...base, result: 'not_assessed', notes, summary, loops, bands, systemic_issues: [] };
  return { ...base, result: 'assessed', notes, summary, loops, bands, systemic_issues: systemic };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The answer and its tables

/** The answer (the lists cut by `first`, the true total beside each), the whole result and the tables. */
export function shapeHorizon(r: HorizonResult, first: <T>(l: T[]) => T[]) {
  const answer = {
    ...r,
    bands: r.bands.map((b) => ({ ...b, activities: first(b.activities), risks: first(b.risks), risks_total: b.risks.length })),
    systemic_issues: r.systemic_issues.map((x) => ({ ...x, activities: first(x.activities), activities_total: x.activities.length })),
  };
  const whole = { ...r, bands: r.bands.map((b) => ({ ...b, risks_total: b.risks.length })), systemic_issues: r.systemic_issues.map((x) => ({ ...x, activities_total: x.activities.length })) };
  const tables = [
    { name: 'risks', columns: ['band', 'rank', 'id', 'project', 'risk', 'days_until_start', 'readiness_score', 'impact'], rows: r.bands.flatMap((b) => b.risks.map((x) => ({ band: b.band, ...x, project: x.project ?? '' }))) },
    { name: 'bands', columns: ['band', 'from_days', 'to_days', 'result', 'activities_total', 'ready', 'at_risk', 'readiness_score', 'status', 'logic', 'resources', 'float', 'forecast_stability'],
      rows: r.bands.map((b) => ({ band: b.band, from_days: b.window.from_days, to_days: b.window.to_days, result: b.result, activities_total: b.activities_total, ready: b.ready, at_risk: b.at_risk, readiness_score: b.readiness_score, status: b.status, ...b.breakdown })) },
    { name: 'activities', columns: ['band', 'id', 'name', 'project', 'start', 'days_until_start', 'duration_days', 'on_critical_path', 'readiness_score', 'status', 'logic', 'resources', 'float', 'forecast_stability', 'issues', 'not_assessed', 'risk_rank'],
      rows: r.bands.flatMap((b) => b.activities.map((a) => ({ band: a.band, id: a.id, name: a.name, project: a.project ?? '', start: a.start, days_until_start: a.days_until_start, duration_days: a.duration_days, on_critical_path: a.on_critical_path, readiness_score: a.readiness_score, status: a.status,
        logic: a.dimensions.logic?.score ?? null, resources: a.dimensions.resources?.score ?? null, float: a.dimensions.float?.score ?? null, forecast_stability: a.dimensions.forecast_stability?.score ?? null, issues: a.issues.join('; '), not_assessed: a.not_assessed.join('; '), risk_rank: a.risk_rank ?? null }))) },
    { name: 'systemic_activities', columns: ['issue', 'dimension', 'id', 'name', 'project', 'score'], rows: r.systemic_issues.flatMap((x) => x.activities.map((a) => ({ issue: x.issue, dimension: x.dimension, id: a.id, name: a.name, project: a.project ?? '', score: a.score }))) },
  ];
  return { answer, whole, tables };
}
