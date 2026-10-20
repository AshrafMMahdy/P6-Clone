// Schedule analysis tools of the MCP server (kept apart from server.ts so the two grow without stepping on each other):
// P6 Check Schedule and DCMA 14-point; later lint, float paths, curves, what-ifs, crashing and delay analysis.
import { progressCurves, resourceHistograms } from '../core/analysis/curves.ts';
import { computeFloatPaths, writeFloatPaths } from '../core/schedule/floatPaths.ts';
import type { Db } from '../core/db.ts';
import { checkSchedule, P6_CHECKS } from '../core/analysis/checkSchedule.ts';
import { dcma14, DCMA_PROFILES } from '../core/analysis/dcma.ts';
import { analysisReportHtml } from '../core/analysis/report.ts';
import { lintSchedule, LINT_CHECKS } from '../core/analysis/lint.ts';
import { nowStamp } from '../core/report/reports.ts';
import { fail, pathArg, type Session } from './runtime.ts';

/** What the server lends these tools. */
export interface AnalysisHelpers {
  projectIds: (db: Db, id: unknown) => string[];
  allIds: (db: Db) => string[];
  dd: (v: unknown) => number | null;
  writeOut: (path: string, data: string | Uint8Array) => void;
  /** run fn as one undoable change of this caller */
  apply: <T>(label: string, fn: (db: Db) => T) => T;
}

const ro = { readOnlyHint: true, openWorldHint: false };
// read the project; write a file only when path is given
const writesFile = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const project = { type: 'string', description: 'Project ID (default: every project in the file)' };
const maxIds = { type: 'number', description: 'activities listed per check (default 100; 0 = all)' };
const reportPath = { type: 'string', description: 'also write the report as HTML to this path' };

export const ANALYSIS_TOOLS = (withHandle: (s: Record<string, unknown>) => Record<string, unknown>) => [
  { name: 'check_schedule', annotations: writesFile, description: `P6's Tools > Check Schedule Report: ${P6_CHECKS.length} checks with P6's own populations and default targets (${P6_CHECKS.map((c) => c.id).join(', ')}). Each check answers metric, threshold {op, value, source}, result pass|fail|not_assessed, numerator/denominator and the activities (or relationships) it found. Thresholds in hours use the hours per day (44 days x 8 h = 352 h). Late activities and BEI need the project baseline. targets overrides a check's target (percent; ratio for bei).`, inputSchema: withHandle({ type: 'object', properties: { project, checks: { type: 'array', items: { type: 'string' } }, targets: { type: 'object' }, threshold_days: { type: 'number', description: 'long lag / large float / large duration limit in days (default 44)' }, max_ids: maxIds, path: reportPath } }) },
  { name: 'dcma_14', annotations: writesFile, description: `DCMA 14-Point Assessment (PAM 200.1): logic, leads, lags, relationship types, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI, BEI. Tasks = incomplete activities that are not WBS summary, LOE or milestones; leads, lags and types count relationships; days are working days of each activity's calendar. Each check answers metric, threshold {op, value, source}, result, numerator/denominator and the activities it found. profile: ${Object.entries(DCMA_PROFILES).map(([k, v]) => `${k} (${v.label})`).join(', ')}; thresholds overrides single checks. baseline: project (default), bl1, bl2, bl3 (missed tasks, BEI, high duration). The critical path test adds cpt_slip_days (600) to the earliest critical task (or cpt_activity) on a scratch copy and passes when the finish moves by exactly that. CPLI: against target_finish, else the project's Must Finish By (contract), else the baseline finish; the other is reported beside it; with neither it is not assessed. limit_days: 44 or "dynamic" (max(20, 10% of the project length)).`, inputSchema: withHandle({ type: 'object', properties: { project, profile: { type: 'string' }, thresholds: { type: 'object' }, baseline: { type: 'string' }, status_date: { type: 'string' }, target_finish: { type: 'string' }, cpt_slip_days: { type: 'number' }, cpt_activity: { type: 'string' }, limit_days: {}, exempt: { type: 'array', items: { type: 'string' } }, max_ids: maxIds, path: reportPath } }) },
  { name: 'lint', annotations: writesFile, description: `Schedule lint: problems P6 schedules without complaint, each with the activities it hits and, where there is one, the fix as edit operations (pass them to edit). Checks: dangling_start (no FS/SS predecessor drives the start), dangling_finish (the finish drives no FS/FF successor), fs_overlap (leads that should be SS + lag, SS lags as long as the predecessor that are really FS, and "ladders" of look-alike activities chained FS that could overlap; ladder fixes carry saves_days, found by scheduling the fix on a scratch copy), empty_wbs, milestone_duration (milestones with a duration, zero-duration tasks), constraints (every type), loe_on_critical, lag_calendar. profile: platform adds White Hat IQ's graded network metrics with score and grade: ${['connectivity', 'start_anchored', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse'].join(', ')}. Each check: band pass|warn|fail, severity, activities, fixes. simulate: false skips the days-saved runs.`, inputSchema: withHandle({ type: 'object', properties: { project, profile: { type: 'string', description: 'p6 (default) or platform' }, checks: { type: 'array', items: { type: 'string' } }, simulate: { type: 'boolean' }, max_ids: maxIds, path: reportPath } }) },
  { name: 'float_paths', annotations: writesFile, description: 'P6 multiple float paths (Schedule Options > Advanced): path 1 ends at the end activity (end_activity, default the open end with the latest finish) following the most critical links back (method free_float, the default: relationship free float, so path 1 is the longest path; total_float: relationship total float, then forward along the most critical successors, as Oracle describes); each next path is the unassigned chain with the most critical link into the paths found; each activity belongs to one path; completed work and activities not leading to the end activity get none. Answers paths [{path, float_hours, activities [{id, name, order, total_float_hours}]}], near_critical (incomplete activities with 0 < total float <= near_critical_days, default 10), and with between {from, to} up to 25 logic paths between two activities (each with its duration and lowest float). write: true also fills the Float Path and Float Path Order columns (one undoable change); to have every F9 fill them, set_schedule_options float_paths: true.', inputSchema: withHandle({ type: 'object', properties: { project, count: { type: 'number', description: 'paths to calculate (default 10)' }, end_activity: { type: 'string' }, method: { type: 'string', description: 'free_float (default) or total_float' }, near_critical_days: { type: 'number' }, between: { type: 'object', description: '{from, to, max?}' }, write: { type: 'boolean' } } }) },
  { name: 'progress_curves', annotations: ro, description: 'S-curves as the P6 Activity Usage Profile/Spreadsheet: per week or month, planned value (baseline budget along the baseline dates; current budget and planned dates without a baseline), earned value and actual cost up to the data date (spread evenly from the actual start; stored financial periods from the XER, P6 Store Period Performance, take precedence), remaining along the remaining early and late dates, cumulative values, per-period and cumulative SPI and CPI; totals BAC, PV, EV, AC, ETC, EAC, VAC, SPI, CPI, TCPI at the data date. units: cost (default) or hours (resource units). CPI is null when no actual is recorded (never assumed 1).', inputSchema: withHandle({ type: 'object', properties: { project, period: { type: 'string', description: 'week or month (default)' }, units: { type: 'string', description: 'cost (default) or hours' }, from: { type: 'string' }, to: { type: 'string' } } }) },
  { name: 'resource_histogram', annotations: ro, description: 'Resource Usage Profile per resource and period: budgeted (planned dates), actual, remaining early (with P6 resource curves) and remaining late units (hours; cost: true for cost), the limit (max units/time over working time), over-allocation and available units, the peak, and severity of over-allocation (minor, moderate at 1.5x the limit, critical at 2x).', inputSchema: withHandle({ type: 'object', properties: { project, resources: { type: 'array', items: { type: 'string' } }, period: { type: 'string', description: 'week (default) or month' }, cost: { type: 'boolean' }, threshold: { type: 'number', description: 'over-allocated when demand > limit x threshold (default 1)' }, detail: { type: 'boolean', description: 'periods for every resource (default: the 10 most over-allocated when there are more than 10)' } } }) },
];

export const ANALYSIS_NAMES = new Set(['check_schedule', 'dcma_14', 'lint', 'float_paths', 'progress_curves', 'resource_histogram']);

/** Run an analysis tool; undefined when the name is not one of them. */
export async function runAnalysis(name: string, a: Record<string, any>, s: Session, h: AnalysisHelpers): Promise<unknown> {
  if (!ANALYSIS_NAMES.has(name)) return undefined;
  const projIds = a.project != null && a.project !== '' ? h.projectIds(s.db, a.project) : h.allIds(s.db);
  const maxIds = a.max_ids != null ? Math.max(0, Math.floor(Number(a.max_ids))) : undefined;
  const withReport = <T extends { report: string; checks: unknown[]; summary: Record<string, number> }>(r: T) => {
    if (!a.path) return r;
    const path = pathArg(a.path, 'path', 'write');
    h.writeOut(path, analysisReportHtml(r as never, nowStamp()));
    return { ...r, saved: path };
  };
  switch (name) {
    case 'check_schedule': {
      const unknown = (a.checks ?? []).filter((c: string) => !P6_CHECKS.some((x) => x.id === c));
      if (unknown.length) fail('bad_input', `Unknown check(s): ${unknown.join(', ')}.`, `Checks: ${P6_CHECKS.map((c) => c.id).join(', ')}.`);
      return withReport(checkSchedule(s.db, { projIds, hoursPerDay: s.hpd, checks: a.checks, targets: a.targets, thresholdHours: a.threshold_days != null ? Number(a.threshold_days) * s.hpd : undefined, maxIds }));
    }
    case 'dcma_14': {
      if (a.profile != null && !DCMA_PROFILES[a.profile]) fail('bad_input', `Unknown profile "${a.profile}".`, `Profiles: ${Object.keys(DCMA_PROFILES).join(', ')}.`);
      if (a.baseline != null && !['project', 'bl1', 'bl2', 'bl3'].includes(a.baseline)) fail('bad_input', `Unknown baseline "${a.baseline}".`, 'Use project, bl1, bl2 or bl3.');
      const limit = a.limit_days === 'dynamic' ? 'dynamic' : a.limit_days != null ? Number(a.limit_days) : undefined;
      return withReport(dcma14(s.db, { projIds, hoursPerDay: s.hpd, profile: a.profile, thresholds: a.thresholds, baseline: a.baseline, statusDate: h.dd(a.status_date), targetFinish: h.dd(a.target_finish), cptSlipDays: a.cpt_slip_days != null ? Number(a.cpt_slip_days) : undefined, cptActivity: a.cpt_activity, limitDays: limit, exempt: a.exempt, maxIds }));
    }
    case 'float_paths': {
      const method = a.method == null ? 'free_float' : String(a.method);
      if (method !== 'free_float' && method !== 'total_float') fail('bad_input', `Unknown method "${a.method}".`, 'Use free_float or total_float.');
      if (a.end_activity && !(s.db.tables.TASK?.rows ?? []).some((t) => t.task_code === a.end_activity && projIds.includes(t.proj_id))) fail('bad_input', `No activity "${a.end_activity}".`, 'Give the Activity ID of the activity the paths end with.');
      const opts = { count: a.count != null ? Number(a.count) : 10, endActivity: a.end_activity, method: method as 'free_float' | 'total_float' };
      const r = computeFloatPaths(s.db, projIds, opts);
      if (a.write) h.apply('Float paths', (d) => writeFloatPaths(d, projIds, computeFloatPaths(d, projIds, opts).assign));
      const nearDays = a.near_critical_days != null ? Number(a.near_critical_days) : 10;
      const tasks = (s.db.tables.TASK?.rows ?? []).filter((t) => projIds.includes(t.proj_id) && !t.act_end_date && t.task_type !== 'TT_WBS' && t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null);
      const near = tasks.map((t) => ({ t, d: Number(t.total_float_hr_cnt) / s.hpd })).filter((x) => x.d > 0 && x.d <= nearDays).sort((x, y) => x.d - y.d).slice(0, 200).map((x) => ({ id: x.t.task_code, name: x.t.task_name, total_float_days: Math.round(x.d * 10) / 10 }));
      return { end: r.end, method: r.method, paths: r.paths, near_critical: near, ...(a.between ? { between: pathsBetween(s.db, projIds, a.between, s.hpd) } : {}), ...(a.write ? { written: true } : {}) };
    }
    case 'progress_curves': {
      const period = a.period ?? 'month', units = a.units ?? 'cost';
      if (period !== 'week' && period !== 'month') fail('bad_input', 'period must be week or month.', 'Use week or month.');
      if (units !== 'cost' && units !== 'hours') fail('bad_input', 'units must be cost or hours.', 'Use cost or hours.');
      return progressCurves(s.db, projIds, { period, units, from: h.dd(a.from) ?? undefined, to: h.dd(a.to) ?? undefined });
    }
    case 'resource_histogram': {
      const period = a.period ?? 'week';
      if (period !== 'week' && period !== 'month') fail('bad_input', 'period must be week or month.', 'Use week or month.');
      const r = resourceHistograms(s.db, projIds, { resources: a.resources, period, cost: a.cost === true, threshold: a.threshold != null ? Number(a.threshold) : undefined });
      if (a.resources?.length && !r.resources.length) fail('bad_input', `No assignments for ${a.resources.join(', ')}.`, 'Use resource IDs that are assigned in this project (list_dictionaries or resource_summary).');
      // many resources: every resource's summary, periods for the 10 most over-allocated (or all with detail: true)
      if (a.resources?.length || a.detail === true || r.resources.length <= 10) return r;
      const rank = [...r.resources].sort((x, y) => y.over_allocated_periods - x.over_allocated_periods || (y.peak?.demand ?? 0) - (x.peak?.demand ?? 0));
      const top = new Set(rank.slice(0, 10).map((x) => x.resource));
      return { ...r, resources: r.resources.map((x) => (top.has(x.resource) ? x : { ...x, periods: undefined })), note: `Periods are shown for the 10 most over-allocated of ${r.resources.length} resources; pass resources: [IDs] or detail: true for others.` };
    }
    case 'lint': {
      if (a.profile != null && a.profile !== 'p6' && a.profile !== 'platform') fail('bad_input', `Unknown profile "${a.profile}".`, 'Use p6 or platform.');
      const unknown = (a.checks ?? []).filter((c: string) => !(LINT_CHECKS as readonly string[]).includes(c));
      if (unknown.length) fail('bad_input', `Unknown check(s): ${unknown.join(', ')}.`, `Checks: ${LINT_CHECKS.join(', ')}.`);
      return withReport(lintSchedule(s.db, { projIds, hoursPerDay: s.hpd, profile: a.profile, checks: a.checks, simulate: a.simulate !== false, maxIds }) as never);
    }
  }
  return undefined;
}

/** Every logic path from one activity to another (the platform's analyse_paths), capped: duration (days, summed) and the
 *  lowest total float on each, longest first. */
function pathsBetween(db: Db, projIds: string[], b: { from?: string; to?: string; max?: number }, hpd: number) {
  const T = (db.tables.TASK?.rows ?? []).filter((t) => projIds.includes(t.proj_id));
  const byCode = new Map(T.map((t) => [t.task_code, t])), byId = new Map(T.map((t) => [t.task_id, t]));
  const from = byCode.get(String(b.from ?? '')), to = byCode.get(String(b.to ?? ''));
  if (!from || !to) return fail('bad_input', 'between needs from and to Activity IDs of this project.', 'e.g. {"from": "A1000", "to": "A9000"}');
  const succ = new Map<string, string[]>();
  for (const r of db.tables.TASKPRED?.rows ?? []) if (byId.has(r.pred_task_id) && byId.has(r.task_id)) succ.set(r.pred_task_id, [...(succ.get(r.pred_task_id) ?? []), r.task_id]);
  // only activities that can reach "to" are walked, so the search does not wander
  const reach = new Set<string>([to.task_id]);
  for (let grew = true; grew;) { grew = false; for (const [p, ss] of succ) if (!reach.has(p) && ss.some((x) => reach.has(x))) { reach.add(p); grew = true; } }
  const max = Math.min(100, Number(b.max) || 25), out: string[][] = [];
  let steps = 0, truncated = false;
  const walk = (id: string, path: string[]) => {
    if (out.length >= max || ++steps > 200000) { truncated = true; return; }
    if (id === to.task_id) { out.push([...path, id]); return; }
    for (const n of succ.get(id) ?? []) if (reach.has(n) && !path.includes(n)) walk(n, [...path, id]);
  };
  if (reach.has(from.task_id)) walk(from.task_id, []);
  const dur = (t: Record<string, string>) => Number((t.act_end_date ? t.target_drtn_hr_cnt : t.remain_drtn_hr_cnt) || 0) / hpd;
  const rowsOut = out.map((p) => { const ts = p.map((id) => byId.get(id)!); const fl = ts.map((t) => t.total_float_hr_cnt).filter((x) => x !== '' && x != null).map(Number); return { activities: ts.map((t) => t.task_code), duration_days: Math.round(ts.reduce((a, t) => a + dur(t), 0) * 10) / 10, min_float_days: fl.length ? Math.round((Math.min(...fl) / hpd) * 10) / 10 : null }; })
    .sort((x, y) => y.duration_days - x.duration_days || (x.min_float_days ?? 0) - (y.min_float_days ?? 0));
  return { from: from.task_code, to: to.task_code, paths: rowsOut, truncated };
}
