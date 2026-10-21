// Schedule analysis tools of the MCP server (kept apart from server.ts so the two grow without stepping on each other):
// P6 Check Schedule and DCMA 14-point; later lint, float paths, curves, what-ifs, crashing and delay analysis.
import { progressCurves, resourceHistograms } from '../core/analysis/curves.ts';
import { computeFloatPaths, writeFloatPaths } from '../core/schedule/floatPaths.ts';
import type { Db } from '../core/db.ts';
import { checkSchedule, P6_CHECKS } from '../core/analysis/checkSchedule.ts';
import { dcma14, DCMA_PROFILES } from '../core/analysis/dcma.ts';
import { analysisReportHtml } from '../core/analysis/report.ts';
import { DEFAULT_LINT_THRESHOLDS, lintSchedule, LINT_CHECKS, resolveLintThresholds } from '../core/analysis/lint.ts';
import { evaluateBatch } from '../core/analysis/batch.ts';
import { crashSchedule } from '../core/analysis/crash.ts';
import { optimizeSchedule } from '../core/analysis/hrm.ts';
import { nodeInfer, ReasonerUnavailable } from '../core/analysis/hrmRuntime.ts';
import { levelResources } from '../core/level/level.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { nowStamp } from '../core/report/reports.ts';
import { lobActivityCodes } from '../core/lob/view.ts';
import { fail, getSession, pathArg, type Session } from './runtime.ts';
import { timeImpact, windowsAnalysis, type Update } from '../core/analysis/delay.ts';
import { baselineOf, type Tick } from '../core/analysis/common.ts';
import { detectFormat, readRaw } from '../renderer/io.ts';
import { readFileSync } from 'node:fs';
import { rows } from '../core/db.ts';

/** What the server lends these tools. */
export interface AnalysisHelpers {
  projectIds: (db: Db, id: unknown) => string[];
  allIds: (db: Db) => string[];
  dd: (v: unknown) => number | null;
  writeOut: (path: string, data: string | Uint8Array) => void;
  /** run fn as one undoable change of this caller */
  apply: <T>(label: string, fn: (db: Db) => T) => T;
  /** progress, a yield to the event loop, and the call's cancellation, between units of long work */
  tick: Tick;
}

// read-only for the project: an optional report path writes an HTML file and nothing else
const ro = { readOnlyHint: true, openWorldHint: false };
// read the project; write a file only when path is given
const writesFile = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const project = { type: 'string', description: 'Project ID (default: every project in the file)' };
const maxIds = { type: 'number', description: 'activities listed per check (default 100; 0 = all)' };
const reportPath = { type: 'string', description: 'also write the report as HTML to this path' };

/** F9 inside an applied change, as the schedule tool does it: assignment dates follow, and a failure refuses the change. */
function reschedule(d: Db, projIds: string[], over: Parameters<typeof scheduleProjects>[2] = {}) {
  const r = scheduleProjects(d, projIds, over);
  if (!r.ok) fail('schedule_failed', `The changed schedule cannot be scheduled: ${r.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' ') || 'see schedule'}`, 'Nothing was changed.');
  syncAssignmentDates(d);
}

/** The names of the baselines saved from these projects (any number; BL1-BL3 are only the assigned ones). */
const savedBaselines = (db: Db, projIds: string[]) => rows(db, 'PROJECT').filter((p) => projIds.includes(p._baseline_of ?? '')).map((p) => p.proj_short_name);

export const ANALYSIS_TOOLS = (withHandle: (s: Record<string, unknown>) => Record<string, unknown>) => [
  { name: 'check_schedule', annotations: ro, description: `P6's Tools > Check Schedule Report: ${P6_CHECKS.length} checks with P6's own populations and default targets (${P6_CHECKS.map((c) => c.id).join(', ')}). Each check answers metric, threshold {op, value, source}, result pass|fail|not_assessed, numerator/denominator and the activities (or relationships) it found. Thresholds in hours use the hours per day (44 days x 8 h = 352 h). Late activities and BEI need the project baseline. targets overrides a check's target (percent; ratio for bei).`, inputSchema: withHandle({ type: 'object', properties: { project, checks: { type: 'array', items: { type: 'string' } }, targets: { type: 'object' }, threshold_days: { type: 'number', description: 'long lag / large float / large duration limit in days (default 44)' }, max_ids: maxIds, path: reportPath } }) },
  { name: 'dcma_14', annotations: ro, description: `DCMA 14-Point Assessment (PAM 200.1): logic, leads, lags, relationship types, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI, BEI. Tasks = incomplete activities that are not WBS summary, LOE or milestones; leads, lags and types count relationships; days are working days of each activity's calendar. Each check answers metric, threshold {op, value, source}, result, numerator/denominator and the activities it found. profile: ${Object.entries(DCMA_PROFILES).map(([k, v]) => `${k} (${v.label})`).join(', ')}; thresholds overrides single checks. baseline: project (default), bl1, bl2, bl3 (missed tasks, BEI, high duration). The critical path test adds cpt_slip_days (600) to the earliest critical task (or cpt_activity) on a scratch copy and passes when the finish moves by exactly that. CPLI: against target_finish, else the project's Must Finish By (contract), else the baseline finish; the other is reported beside it; with neither it is not assessed. limit_days: 44 or "dynamic" (max(20, 10% of the project length)).`, inputSchema: withHandle({ type: 'object', properties: { project, profile: { type: 'string' }, thresholds: { type: 'object' }, baseline: { type: 'string' }, status_date: { type: 'string' }, target_finish: { type: 'string' }, cpt_slip_days: { type: 'number' }, cpt_activity: { type: 'string' }, limit_days: {}, exempt: { type: 'array', items: { type: 'string' } }, max_ids: maxIds, path: reportPath } }) },
  { name: 'lint', annotations: ro, description: `Schedule lint: problems P6 schedules without complaint, each with the activities it hits and, where there is one, the fix as edit operations (pass them to edit). Checks: dangling_start (no FS/SS predecessor drives the start), dangling_finish (the finish drives no FS/FF successor), fs_overlap (leads that should be SS + lag, SS lags as long as the predecessor that are really FS, and "ladders" of look-alike activities chained FS that could overlap; ladder fixes carry saves_days, found by scheduling the fix on a scratch copy), empty_wbs, milestone_duration (milestones with a duration, zero-duration tasks), constraints (every type), loe_on_critical, lag_calendar. profile: platform adds White Hat IQ's graded network metrics with score and grade: ${['connectivity', 'start_anchored', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse'].join(', ')}. Each check: band pass|warn|fail, severity, activities, fixes and applied (the thresholds it was judged by). thresholds overrides any of them per call (an organisation's own, e.g. from its wiki): ${Object.keys(DEFAULT_LINT_THRESHOLDS).join(', ')}, each as in the answer's thresholds (the platform's LintConfig names, camelCase or snake_case, are read too); the answer gives every threshold applied and which were overridden. simulate: false skips the days-saved runs.`, inputSchema: withHandle({ type: 'object', properties: { project, profile: { type: 'string', description: 'p6 (default) or platform' }, checks: { type: 'array', items: { type: 'string' } }, thresholds: { type: 'object', description: 'overrides, e.g. {"criticality": {"pass": [0.1, 0.3]}, "ladder": {"min_group_size": 4}, "dangling_start": {"max": 2}, "fs_overlap": {"max_lead_days": 1}, "weights": {"criticality": 20}}' }, simulate: { type: 'boolean' }, max_ids: maxIds, path: reportPath } }) },
  { name: 'float_paths', annotations: writesFile, description: 'P6 multiple float paths (Schedule Options > Advanced): path 1 ends at the end activity (end_activity, default the open end with the latest finish) following the most critical links back (method free_float, the default: relationship free float, so path 1 is the longest path; total_float: relationship total float, then forward along the most critical successors, as Oracle describes); each next path is the unassigned chain with the most critical link into the paths found; each activity belongs to one path; completed work and activities not leading to the end activity get none. Answers paths [{path, float_hours, activities [{id, name, order, total_float_hours}]}], near_critical (incomplete activities with 0 < total float <= near_critical_days, default 10), and with between {from, to} up to 25 logic paths between two activities (each with its duration and lowest float). write: true also fills the Float Path and Float Path Order columns (one undoable change); to have every F9 fill them, set_schedule_options float_paths: true.', inputSchema: withHandle({ type: 'object', properties: { project, count: { type: 'number', description: 'paths to calculate (default 10)' }, end_activity: { type: 'string' }, method: { type: 'string', description: 'free_float (default) or total_float' }, near_critical_days: { type: 'number' }, between: { type: 'object', description: '{from, to, max?}' }, write: { type: 'boolean' } } }) },
  { name: 'progress_curves', annotations: ro, description: 'S-curves as the P6 Activity Usage Profile/Spreadsheet: per week or month, planned value (baseline budget along the baseline dates; current budget and planned dates without a baseline), earned value and actual cost up to the data date (spread evenly from the actual start; stored financial periods from the XER, P6 Store Period Performance, take precedence), remaining along the remaining early and late dates, cumulative values, per-period and cumulative SPI and CPI; totals BAC, PV, EV, AC, ETC, EAC, VAC, SPI, CPI, TCPI at the data date. units: cost (default) or hours (resource units). CPI is null when no actual is recorded (never assumed 1).', inputSchema: withHandle({ type: 'object', properties: { project, period: { type: 'string', description: 'week or month (default)' }, units: { type: 'string', description: 'cost (default) or hours' }, from: { type: 'string' }, to: { type: 'string' } } }) },
  { name: 'resource_histogram', annotations: ro, description: 'Resource Usage Profile per resource and period: budgeted (planned dates), actual, remaining early (with P6 resource curves) and remaining late units (hours; cost: true for cost), the limit (max units/time over working time), over-allocation and available units, the peak, and severity of over-allocation (minor, moderate at 1.5x the limit, critical at 2x).', inputSchema: withHandle({ type: 'object', properties: { project, resources: { type: 'array', items: { type: 'string' } }, period: { type: 'string', description: 'week (default) or month' }, cost: { type: 'boolean' }, threshold: { type: 'number', description: 'over-allocated when demand > limit x threshold (default 1)' }, detail: { type: 'boolean', description: 'periods for every resource (default: the 10 most over-allocated when there are more than 10)' } } }) },
  { name: 'evaluate_batch', annotations: ro, description: 'Many what-ifs in one call: the project is scheduled once as it is, then each scenario (a list of edit operations, as edit takes them) on a copy that is thrown away, so nothing changes. One row per scenario: ok or error, finish, finish_delta_days (working days on the project calendar; negative = earlier), critical count, became_critical and no_longer_critical, negative_float count, cost (at completion) and cost_delta; the best `top` (default 3; earliest finish, then cheapest) also list the activities whose dates moved. best names the best scenario.', inputSchema: withHandle({ type: 'object', properties: { project, scenarios: { type: 'array', description: '[{name, overrides: [edit operations]}], up to 200', items: { type: 'object' } }, top: { type: 'number' } }, required: ['scenarios'] }) },
  { name: 'crash_schedule', annotations: writesFile, description: 'Least-cost crashing (Kelley-Walker): each step shortens the cheapest cut set, the activities that together shorten every path driving the finish at once (a shared activity competes with the sum of one activity per parallel path), by the smaller of their crash room, the float of the next near-critical path and what is still needed, then reschedules. Working days on the calendar of each activity; only remaining work is crashed; completed, milestones, LOE and locked activities are not. Crash data per activity: {id, min_days, cost_per_day} or {id, crash_days (remaining duration when fully crashed), crash_cost (extra cost to get there)}; without it every remaining activity may lose default_max_pct (30) % of its remaining duration at 1 per day. Goal: target_finish (date), target_days (working days to gain), or neither with indirect_cost_per_day / ld_per_day to stop at the least total cost. Answers stop SUCCESS | PLATEAU | EXHAUSTED | CAP | ALREADY_MET with a note, every step {activities [{id, days, cost}], days_gained, cost, finish, cumulative_direct_cost, total_cost (direct less indirect and liquidated damages saved)}, the duration changes and the edit ops. apply: true makes the changes and reschedules (one undoable change).', inputSchema: withHandle({ type: 'object', properties: { project, target_finish: { type: 'string' }, target_days: { type: 'number' }, activities: { type: 'array', items: { type: 'object' } }, default_max_pct: { type: 'number' }, indirect_cost_per_day: { type: 'number' }, ld_per_day: { type: 'number' }, locked: { type: 'array', items: { type: 'string' } }, max_steps: { type: 'number', description: 'default 100' }, apply: { type: 'boolean' } } }) },
  { name: 'optimize_schedule', annotations: writesFile, description: 'The White Hat IQ schedule reasoner (a trained model, embedded; runs locally): picks each remaining activity’s mode (normal, or crashed when crash data is given) and a placement priority so the resource-limited schedule finishes soonest, sampling `samples` trajectories around the model’s answer (default 200, 64 above 120 activities; `seed` makes it repeatable). Resources need a Max Units/Time limit to be leveled. The proposal is checked with the P6 leveler: answers cpm_finish (no leveling), p6_leveled_finish (P6 default leveling), reasoner_finish (its modes and priority through the same leveler), better_than_p6_leveler, crash changes and cost, and the priority order. objective min_crash_cost runs crash_schedule instead (give target_finish or target_days). apply: true makes the crash changes, reschedules and levels in the proposed order (one undoable change; like P6 leveling, the next F9 without leveling drops the leveled dates). Up to 3000 remaining activities.', inputSchema: withHandle({ type: 'object', properties: { project, objective: { type: 'string', description: 'makespan (default) or min_crash_cost' }, samples: { type: 'number' }, seed: { type: 'number' }, activities: { type: 'array', description: 'crash data [{id, crash_days, crash_cost} | {id, min_days, cost_per_day}]', items: { type: 'object' } }, target_finish: { type: 'string' }, target_days: { type: 'number' }, apply: { type: 'boolean' } } }) },
  { name: 'windows_analysis', annotations: ro, description: 'Windows delay analysis (AACE 29R-03 MIP 3.3 contemporaneous; method half_step = MIP 3.4): the updates are put in data-date order (this handle is the latest unless include_current is false) and each window compares one update with the next: finish before and after and the slip in working days (on the first update\u2019s project calendar, so windows add up to total_slip_days), the driving path at the window\u2019s start, the activities on it that lost time with causes (started late, duration revised, logic revised, progressed slower than planned, deleted), and activities added. half_step re-runs the earlier update with only the later one\u2019s progress at its data date and splits the slip into progress_days and revision_days. Activities match by Activity ID, then by a unique name. updates: [{handle} | {path} | {baseline: project|bl1|bl2|bl3|<saved baseline name>} | {data_date, progress: [edit ops]} (the previous update, or the current project after a stored baseline, with this progress, scheduled at data_date)]. milestone measures a key milestone instead of completion.', inputSchema: withHandle({ type: 'object', properties: { project, updates: { type: 'array', items: { type: 'object' } }, include_current: { type: 'boolean' }, method: { type: 'string', description: 'contemporaneous (default) or half_step' }, milestone: { type: 'string' }, max_ids: maxIds }, required: ['updates'] }) },
  { name: 'tia', annotations: writesFile, description: 'Time impact analysis (AACE 52R-06): the fragnet (edit ops: add_activity, add_relationship, update_activity\u2026) is inserted in a copy of the project and both are scheduled at the same data date (data_date, default the project\u2019s). Answers unimpacted_finish, impacted_finish, delay_days (working days, project calendar), fragnet_on_critical_path, fragnet_path (the fragnet activities and what they drive to the finish), became_critical / no_longer_critical; baseline (project, bl1-bl3 or the name of any saved baseline) adds the impacted variance to that baseline\u2019s finish. milestone measures a key milestone. The project is unchanged unless keep: true, which adds the impacted schedule as a new project copy (<Project ID>-TIA, one undoable change).', inputSchema: withHandle({ type: 'object', properties: { project, fragnet: { type: 'array', items: { type: 'object' } }, data_date: { type: 'string' }, milestone: { type: 'string' }, baseline: { type: 'string' }, keep: { type: 'boolean' } }, required: ['fragnet'] }) },
];

export const ANALYSIS_NAMES = new Set(['check_schedule', 'dcma_14', 'lint', 'float_paths', 'progress_curves', 'resource_histogram', 'evaluate_batch', 'crash_schedule', 'optimize_schedule', 'windows_analysis', 'tia']);

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
      if (a.baseline != null && !projIds.some((id) => baselineOf(s.db, s.db.tables.PROJECT.rows.find((p) => p.proj_id === id)!, String(a.baseline)))) fail('bad_input', `No baseline "${a.baseline}" for this project.`, `Use project, bl1, bl2, bl3 or a saved baseline's name: ${savedBaselines(s.db, projIds).join(', ') || 'none saved'}.`);
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
    case 'evaluate_batch': {
      if (!Array.isArray(a.scenarios) || !a.scenarios.length) fail('bad_input', 'scenarios must be a non-empty list.', 'e.g. [{"name": "A shorter", "overrides": [{"op": "update_activity", "id": "A1000", "duration_days": 5}]}]');
      if (a.scenarios.length > 200) fail('bad_input', `${a.scenarios.length} scenarios; at most 200 per call.`, 'Split them over several calls.');
      const r = await evaluateBatch(s.db, projIds, a.scenarios.map((x: any, i: number) => ({ name: String(x?.name ?? `scenario ${i + 1}`), overrides: Array.isArray(x?.overrides) ? x.overrides : [] })), { hoursPerDay: s.hpd, top: a.top != null ? Number(a.top) : undefined, tick: h.tick });
      if (!r.ok) return fail(r.error.code, r.error.message, 'Fix the schedule errors first (schedule shows them).');
      return r;
    }
    case 'crash_schedule': {
      // an LOB plan's activities are crashed through the plan (lob_edit set_crew / set_duration), never directly
      const r = await crashSchedule(s.db, projIds, { targetFinish: a.target_finish, targetDays: a.target_days != null ? Number(a.target_days) : undefined, activities: a.activities, defaultMaxPct: a.default_max_pct != null ? Number(a.default_max_pct) : undefined, indirectPerDay: a.indirect_cost_per_day != null ? Number(a.indirect_cost_per_day) : undefined, ldPerDay: a.ld_per_day != null ? Number(a.ld_per_day) : undefined, locked: [...(Array.isArray(a.locked) ? a.locked : []), ...lobActivityCodes(s.db)], maxSteps: a.max_steps != null ? Number(a.max_steps) : undefined, hoursPerDay: s.hpd, tick: h.tick });
      if (!r.ok) return fail(r.error.code, r.error.message, r.error.code === 'bad_input' ? 'e.g. {"target_days": 10} or {"target_finish": "2026-12-31"}' : 'Fix the schedule errors first (schedule shows them).');
      if (a.apply && r.ops.length) h.apply('Crash schedule', (d) => { const x = applyOps(d, r.ops, { hoursPerDay: s.hpd, calendarDays: true }); if (!x.ok) fail('bad_input', x.error!.message, ''); reschedule(d, projIds); });
      return { ...r, ...(a.apply ? { applied: r.ops.length > 0 } : {}) };
    }
    case 'optimize_schedule': {
      const objective = a.objective ?? 'makespan';
      if (objective !== 'makespan' && objective !== 'min_crash_cost') fail('bad_input', `Unknown objective "${objective}".`, 'Use makespan or min_crash_cost.');
      if (objective === 'min_crash_cost') return runAnalysis('crash_schedule', a, s, h).then((r) => ({ objective, ...(r as object) }));
      const ops = (d: Db, list: unknown[]) => { const x = applyOps(d, list, { hoursPerDay: s.hpd, calendarDays: true }); if (!x.ok) fail('bad_input', x.error!.message, ''); };
      let r;
      try { r = await optimizeSchedule(s.db, projIds, { samples: a.samples != null ? Math.max(0, Math.floor(Number(a.samples))) : undefined, seed: a.seed != null ? Number(a.seed) : undefined, activities: a.activities, hoursPerDay: s.hpd, tick: h.tick }, nodeInfer, ops); }
      catch (e) { if (e instanceof ReasonerUnavailable) return fail('reasoner_unavailable', e.message, 'Use level_resources (P6 leveling) or crash_schedule meanwhile.'); throw e; }
      if (!r.ok) return fail(r.error.code, r.error.message, r.error.code === 'too_large' ? 'Pass project to optimise one project.' : 'Give resources a Max Units/Time limit (add_resource max_units_per_hour) or pass crash data in activities.');
      const { order, ...answer } = r;
      if (a.apply) h.apply('Optimize schedule (reasoner)', (d) => { ops(d, r.ops); reschedule(d, projIds); if (r.leveled_activities) { levelResources(d, projIds, { first: order }); syncAssignmentDates(d); } });
      return { objective, ...answer, ...(a.apply ? { applied: true } : {}) };
    }
    case 'windows_analysis': {
      if (!Array.isArray(a.updates) || !a.updates.length) fail('bad_input', 'updates must list the other updates.', 'e.g. [{"path": "Update 1.xer"}, {"handle": "..."}] or [{"baseline": "project"}]');
      if (a.method != null && a.method !== 'contemporaneous' && a.method !== 'half_step') fail('bad_input', `Unknown method "${a.method}".`, 'Use contemporaneous or half_step.');
      const mainProj = (db: Db) => rows(db, 'PROJECT').find((p) => !p._baseline_of && (a.project == null || p.proj_short_name === a.project)) ?? fail('bad_input', a.project ? `No project "${a.project}".` : 'The file has no project.', 'Pass project.');
      const updates: Update[] = [];
      const cur = mainProj(s.db);
      for (const [i, u] of (a.updates as Record<string, unknown>[]).entries()) {
        if (u?.handle) { const o = getSession(u.handle); updates.push({ name: String(u.name ?? o.path ?? u.handle), db: o.db, projId: mainProj(o.db).proj_id }); }
        else if (u?.path) { const p = pathArg(u.path); let b: Uint8Array; try { b = new Uint8Array(readFileSync(p)); } catch { return fail('file_unreadable', `Cannot read ${p}.`, 'Check the path.'); } const db = readRaw(b, detectFormat(p, b)).db; updates.push({ name: String(u.name ?? p), db, projId: mainProj(db).proj_id }); }
        else if (u?.baseline) { const bl = baselineOf(s.db, cur, String(u.baseline) as 'project') ?? fail('bad_input', `The project has no ${u.baseline} baseline in this file.`, `Use project, bl1, bl2, bl3 or a saved baseline's name: ${savedBaselines(s.db, [cur.proj_id]).join(', ') || 'none saved'}.`); updates.push({ name: String(u.name ?? bl.name), db: s.db, projId: bl.projId }); }
        else if (u?.data_date && Array.isArray(u.progress)) {
          // built from the last update that is a schedule of its own (a stored baseline is a snapshot, not edited), else the current project
          const prev = [...updates].reverse().find((x) => x.db !== s.db || x.projId === cur.proj_id) ?? { name: 'current', db: s.db, projId: cur.proj_id };
          const db = structuredClone(prev.db) as Db, dd = h.dd(u.data_date) ?? fail('bad_input', `updates[${i}].data_date is not a date.`, 'YYYY-MM-DD');
          const r = applyOps(db, u.progress, { hoursPerDay: s.hpd, calendarDays: true });
          if (!r.ok) fail('bad_input', `updates[${i}] operation ${r.error!.index + 1}: ${r.error!.message}`, '');
          if (!scheduleProjects(db, [prev.projId], { dataDate: dd }).ok) fail('schedule_failed', `updates[${i}] cannot be scheduled.`, '');
          updates.push({ name: String(u.name ?? `update at ${String(u.data_date)}`), db, projId: prev.projId });
        } else fail('bad_input', `updates[${i}] needs handle, path, baseline, or data_date with progress.`, '');
      }
      if (a.include_current !== false) updates.push({ name: 'current', db: s.db, projId: cur.proj_id });
      const r = await windowsAnalysis(updates, { milestone: a.milestone, method: a.method, hoursPerDay: s.hpd, maxIds: maxIds ?? undefined, tick: h.tick });
      if (!r.ok) return fail(r.error.code, r.error.message, 'Check the milestone and the updates.');
      return r;
    }
    case 'tia': {
      if (!Array.isArray(a.fragnet) || !a.fragnet.length) fail('bad_input', 'fragnet must list edit operations.', 'e.g. [{"op": "add_activity", "id": "X1", "name": "Design change", "duration_days": 10}, {"op": "add_relationship", "pred": "A1000", "succ": "X1"}]');
      const cur = rows(s.db, 'PROJECT').find((p) => p.proj_id === projIds[0])!;
      let baseline: { name: string; finish: number | null; how: string } | undefined;
      if (a.baseline) {
        const bl = baselineOf(s.db, cur, String(a.baseline) as 'project') ?? fail('bad_input', `The project has no ${a.baseline} baseline in this file.`, `Use project, bl1, bl2, bl3 or a saved baseline's name: ${savedBaselines(s.db, [cur.proj_id]).join(', ') || 'none saved'}.`);
        let f: number | null = null;
        for (const t of bl.tasks.values()) { const v = h.dd(t.act_end_date || t.early_end_date || t.target_end_date); if (v != null && (f == null || v > f)) f = v; }
        if (a.milestone) { const m = bl.tasks.get(a.milestone); f = m ? h.dd(m.act_end_date || m.early_end_date || m.target_end_date) : null; }
        baseline = { name: bl.name, finish: f, how: bl.how };
      }
      const dd = a.data_date != null ? h.dd(a.data_date) ?? fail('bad_input', 'data_date is not a date.', 'YYYY-MM-DD') : undefined;
      const r = timeImpact(s.db, [projIds[0]], a.fragnet, { dataDate: dd, milestone: a.milestone, hoursPerDay: s.hpd, baseline });
      if (!r.ok) return fail(r.error.code, r.error.message, 'Fix the fragnet operations (Activity IDs of this project).');
      if (!a.keep) return r;
      let id = `${cur.proj_short_name}-TIA`;
      for (let k = 2; rows(s.db, 'PROJECT').some((p) => p.proj_short_name.toLowerCase() === id.toLowerCase()); k++) id = `${cur.proj_short_name}-TIA${k}`;
      h.apply(`TIA ${id}`, (d) => {
        const x = applyOps(d, [{ op: 'copy_project', from: cur.proj_short_name, id, keep_progress: true }, ...a.fragnet.map((op: Record<string, unknown>) => ({ ...op, project: id, pred_project: undefined, succ_project: undefined }))], { hoursPerDay: s.hpd, calendarDays: true });
        if (!x.ok) fail('bad_input', x.error!.message, '');
        const copy = rows(d, 'PROJECT').find((p) => p.proj_short_name === id)!;
        reschedule(d, [copy.proj_id], dd != null ? { dataDate: dd } : {});
      });
      return { ...r, kept_as: id };
    }
    case 'lint': {
      if (a.profile != null && a.profile !== 'p6' && a.profile !== 'platform') fail('bad_input', `Unknown profile "${a.profile}".`, 'Use p6 or platform.');
      const unknown = (a.checks ?? []).filter((c: string) => !(LINT_CHECKS as readonly string[]).includes(c));
      if (unknown.length) fail('bad_input', `Unknown check(s): ${unknown.join(', ')}.`, `Checks: ${LINT_CHECKS.join(', ')}.`);
      try { resolveLintThresholds(a.thresholds); } catch (e) { fail('bad_input', (e as Error).message, 'e.g. {"criticality": {"pass": [0.1, 0.3]}}; the answer of a call without thresholds lists them all.'); }
      return withReport(lintSchedule(s.db, { projIds, hoursPerDay: s.hpd, profile: a.profile, checks: a.checks, simulate: a.simulate !== false, maxIds, thresholds: a.thresholds }) as never);
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
