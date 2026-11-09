// Schedule analysis tools of the MCP server (kept apart from server.ts so the two grow without stepping on each other):
// P6 Check Schedule and DCMA 14-point; later lint, float paths, curves, what-ifs, crashing and delay analysis.
import { progressCurves, resourceHistograms } from '../core/analysis/curves.ts';
import { BETWEEN_NEEDS, computeFloatPaths, pathsBetween, writeFloatPaths } from '../core/schedule/floatPaths.ts';
import type { Db } from '../core/db.ts';
import { checkSchedule, P6_CHECKS } from '../core/analysis/checkSchedule.ts';
import { dcma14, DCMA_PROFILES } from '../core/analysis/dcma.ts';
import { analysisReportHtml } from '../core/analysis/report.ts';
import { cutLintCheck, DEFAULT_LINT_THRESHOLDS, lintSchedule, LINT_CHECKS, resolveLintThresholds } from '../core/analysis/lint.ts';
import { evaluateBatch, type RowStore } from '../core/analysis/batch.ts';
import { claimHere, keptPlace, keepWords, ScenarioFile, type Claim } from './keptRuns.ts';
import { crashOptionsOf, crashSchedule } from '../core/analysis/crash.ts';
import { optimizeSchedule } from '../core/analysis/hrm.ts';
import { nodeInfer, ReasonerUnavailable } from '../core/analysis/hrmRuntime.ts';
import { levelResources } from '../core/level/level.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { nowStamp } from '../core/report/reports.ts';
import { formatP6Date } from '../core/dates.ts';
import { estimateBytes, fail, getSession, pathArg, reserveMemory, type Session } from './runtime.ts';
import { cutWindow, tiaBaseline, timeImpact, windowsAnalysis, type Update } from '../core/analysis/delay.ts';
import { exportAfterChange, exportDoc, exportProp, exportResult, firstOf, type Table } from './export.ts';
import type { CheckResult } from '../core/analysis/common.ts';
import { baselineOf, type Tick } from '../core/analysis/common.ts';
import { detectFormat, readRaw } from '../renderer/io.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
const headOf = (p: string): Uint8Array => { const fd = openSync(p, 'r'); try { const b = Buffer.alloc(4000); return new Uint8Array(b.subarray(0, readSync(fd, b, 0, 4000, 0))); } finally { closeSync(fd); } };
const sizeOf = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
import { rows } from '../core/db.ts';

/** What the server lends these tools. */
export interface AnalysisHelpers {
  projectIds: (db: Db, id: unknown) => string[];
  allIds: (db: Db) => string[];
  dd: (v: unknown) => number | null;
  writeOut: (path: string, data: string | Uint8Array) => void;
  /** writeOut for a file made piece by piece (the pieces go to the file as they come). */
  writeOutWith: (path: string, make: (put: (piece: string | Uint8Array) => void) => void) => void;
  /** run fn as one undoable change of this caller */
  apply: <T>(label: string, fn: (db: Db) => T) => T;
  /** apply for work that ticks between its steps */
  applyAsync: <T>(label: string, fn: (db: Db) => Promise<T>) => Promise<T>;
  /** progress, a yield to the event loop, and the call's cancellation, between units of long work */
  tick: Tick;
  /** a finished row of the answer, sent out as it is done (in a compute worker: kept if the worker is ended); absent elsewhere */
  keep?: (row: unknown) => void;
  /** the id of the job this call runs as, when it is one (a second call that finds the work busy names it) */
  job?: () => string | undefined;
  /** in a compute worker: how a run claims its kept file (on the server's main thread); elsewhere absent (claimed here) */
  claim?: Claim;
}

// read-only for the project: an optional report path writes an HTML file and nothing else
const ro = { readOnlyHint: true, openWorldHint: false };
// read the project; write a file only when path is given
const writesFile = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const project = { type: 'string', description: 'Project ID (default: every project in the file)' };
const maxIds = { type: 'number', description: 'activities listed per check (default 100; 0 = all); total_activities says how many there are' };
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
  { name: 'check_schedule', annotations: ro, description: `P6's Tools > Check Schedule Report: ${P6_CHECKS.length} checks with P6's own populations and default targets (${P6_CHECKS.map((c) => c.id).join(', ')}). Each check answers metric, threshold {op, value, source}, result pass|fail|not_assessed, numerator/denominator and the activities (or relationships) it found. Thresholds in hours use the hours per day (44 days x 8 h = 352 h). Late activities and BEI need the project baseline. targets overrides a check's target (percent; ratio for bei).` + exportDoc('check_schedule', ['checks', 'failing_activities', 'projects']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, checks: { type: 'array', items: { type: 'string' } }, targets: { type: 'object' }, threshold_days: { type: 'number', description: 'long lag / large float / large duration limit in days (default 44)' }, max_ids: maxIds, path: reportPath } }) },
  { name: 'dcma_14', annotations: ro, description: `DCMA 14-Point Assessment (PAM 200.1): logic, leads, lags, relationship types, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI, BEI. Tasks = incomplete activities that are not WBS summary, LOE or milestones; leads, lags and types count relationships; days are working days of each activity's calendar. Each check answers metric, threshold {op, value, source}, result, numerator/denominator and the activities it found. profile: ${Object.entries(DCMA_PROFILES).map(([k, v]) => `${k} (${v.label})`).join(', ')}; thresholds overrides single checks. baseline: project (default), bl1, bl2, bl3 (missed tasks, BEI, high duration). The critical path test adds cpt_slip_days (600) to the earliest critical task (or cpt_activity) on a scratch copy and passes when the finish moves by exactly that. CPLI: against target_finish, else the project's Must Finish By (contract), else the baseline finish; the other is reported beside it; with neither it is not assessed. limit_days: 44 or "dynamic" (max(20, 10% of the project length)).` + exportDoc('dcma_14', ['checks', 'failing_activities']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, profile: { type: 'string' }, thresholds: { type: 'object' }, baseline: { type: 'string' }, status_date: { type: 'string' }, target_finish: { type: 'string' }, cpt_slip_days: { type: 'number' }, cpt_activity: { type: 'string' }, limit_days: {}, exempt: { type: 'array', items: { type: 'string' } }, max_ids: maxIds, path: reportPath } }) },
  { name: 'lint', annotations: ro, description: `Schedule lint: problems P6 schedules without complaint, each with the activities it hits and, where there is one, the fix as edit operations (pass them to edit). Checks: dangling_start (no FS/SS predecessor drives the start), dangling_finish (the finish drives no FS/FF successor), fs_overlap (leads that should be SS + lag, SS lags as long as the predecessor that are really FS, and "ladders" of look-alike activities chained FS that could overlap; ladder fixes carry saves_days, found by scheduling the fix on a scratch copy), empty_wbs, milestone_duration (milestones with a duration, zero-duration tasks), constraints (every type), loe_on_critical, lag_calendar. profile: platform adds White Hat IQ's graded network metrics with score and grade: ${['connectivity', 'start_anchored', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse'].join(', ')}. Each check: band pass|warn|fail, severity, activities, fixes and applied (the thresholds it was judged by). thresholds overrides any of them per call (an organisation's own, e.g. from its wiki): ${Object.keys(DEFAULT_LINT_THRESHOLDS).join(', ')}, each as in the answer's thresholds (the platform's LintConfig names, camelCase or snake_case, are read too); the answer gives every threshold applied and which were overridden. simulate: false skips the days-saved runs.` + exportDoc('lint', ['checks', 'findings', 'fixes']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, profile: { type: 'string', description: 'p6 (default) or platform' }, checks: { type: 'array', items: { type: 'string' } }, thresholds: { type: 'object', description: 'overrides, e.g. {"criticality": {"pass": [0.1, 0.3]}, "ladder": {"min_group_size": 4}, "dangling_start": {"max": 2}, "fs_overlap": {"max_lead_days": 1}, "weights": {"criticality": 20}}' }, simulate: { type: 'boolean' }, max_ids: maxIds, path: reportPath } }) },
  { name: 'float_paths', annotations: writesFile, description: 'P6 multiple float paths (Schedule Options > Advanced): path 1 ends at the end activity (end_activity, default the open end with the latest finish) following the most critical links back (method free_float, the default: relationship free float, so path 1 is the longest path; total_float: relationship total float, then forward along the most critical successors, as Oracle describes); each next path is the unassigned chain with the most critical link into the paths found; each activity belongs to one path; completed work and activities not leading to the end activity get none. Answers paths [{path, float_hours, activities [{id, name, order, total_float_hours}]}], near_critical (incomplete activities with 0 < total float <= near_critical_days, default 10), and with between {from, to} up to between.max (default 25) logic paths between two activities (each with its duration and lowest float). write: true also fills the Float Path and Float Path Order columns (one undoable change); to have every F9 fill them, set_schedule_options float_paths: true.' + exportDoc('float_paths', ['paths', 'near_critical', 'between (empty without between)']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, count: { type: 'number', description: 'paths to calculate (default 10)' }, end_activity: { type: 'string' }, method: { type: 'string', description: 'free_float (default) or total_float' }, near_critical_days: { type: 'number' }, between: { type: 'object', description: '{from, to, max?}' }, write: { type: 'boolean' } } }) },
  { name: 'progress_curves', annotations: ro, description: 'S-curves as the P6 Activity Usage Profile/Spreadsheet: per week or month, planned value (baseline budget along the baseline dates; current budget and planned dates without a baseline), earned value and actual cost up to the data date (spread evenly from the actual start; stored financial periods from the XER, P6 Store Period Performance, take precedence), remaining along the remaining early and late dates, cumulative values, per-period and cumulative SPI and CPI; totals BAC, PV, EV, AC, ETC, EAC, VAC, SPI, CPI, TCPI at the data date. units: cost (default) or hours (resource units). CPI is null when no actual is recorded (never assumed 1).' + exportDoc('progress_curves', ['periods', 'totals']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, period: { type: 'string', description: 'week or month (default)' }, units: { type: 'string', description: 'cost (default) or hours' }, from: { type: 'string' }, to: { type: 'string' } } }) },
  { name: 'resource_histogram', annotations: ro, description: 'Resource Usage Profile per resource and period: budgeted (planned dates), actual, remaining early (with P6 resource curves) and remaining late units (hours; cost: true for cost), the limit (max units/time over working time), over-allocation and available units, the peak, and severity of over-allocation (minor, moderate at 1.5x the limit, critical at 2x).' + exportDoc('resource_histogram', ['resources', 'periods (every resource)']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, resources: { type: 'array', items: { type: 'string' } }, period: { type: 'string', description: 'week (default) or month' }, cost: { type: 'boolean' }, threshold: { type: 'number', description: 'over-allocated when demand > limit x threshold (default 1)' }, detail: { type: 'boolean', description: 'periods for every resource (default: the 10 most over-allocated when there are more than 10)' } } }) },
  { name: 'evaluate_batch', annotations: ro, description: 'Many what-ifs in one call: the project is scheduled once as it is, then each scenario (a list of edit operations, as edit takes them) on a copy that is thrown away, so nothing changes. One row per scenario: ok or error, finish, finish_delta_days (working days on the project calendar; negative = earlier), critical count, became_critical and no_longer_critical, negative_float count, cost (at completion) and cost_delta; the best `top` (default 3; earliest finish, then cheapest) also list the activities whose dates moved (the first 200; changed_total says how many). best names the best scenario. Each scenario is kept as it finishes, in a file in the write root (evaluate_batch-<fingerprint>.parts/scenarios.ndjson). A batch that stops (cancelled, its worker ended, or a scenario that could not be kept) answers the rows done, marked partial, with resume: the path of that file; to continue, call evaluate_batch again with the same arguments and resume: that path, exactly as given (it is never searched for): only the scenarios still missing are scheduled, and best and the details of the best few are worked out over every scenario, so the answer is the one an uninterrupted batch gives (resumed_scenarios says how many came from the file; redone_scenarios how many kept ones did not check out, damaged as a power loss can leave a file or after a damaged one, and were done again). A resume whose project, scenarios or arguments differ is refused with resume_mismatch, removing nothing. A batch whose kept file another evaluate_batch call in this server is still working on (a cancelled job answers before it has stopped; the same project open under two handles) is refused as run_busy, naming that job when it is one. A call without resume starts over; a batch that finishes removes its file and names its folder in parts_removed (so a copy of it elsewhere can go too).' + exportDoc('evaluate_batch', ['scenarios', 'dates_moved (every scenario)']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, scenarios: { type: 'array', description: '[{name, overrides: [edit operations]}], any number', items: { type: 'object' } }, top: { type: 'number' }, resume: { type: 'string', description: 'the resume path a stopped evaluate_batch answered (its kept scenarios), to do only the scenarios still missing; same arguments as that call' } }, required: ['scenarios'] }) },
  { name: 'crash_schedule', annotations: writesFile, description: 'Least-cost crashing (Kelley-Walker): each step shortens the cheapest cut set, the activities that together shorten every path driving the finish at once (a shared activity competes with the sum of one activity per parallel path), by the smaller of their crash room, the float of the next near-critical path and what is still needed, then reschedules. Working days on the calendar of each activity; only remaining work is crashed; completed, milestones, LOE and locked activities are not. Crash data per activity: {id, min_days, cost_per_day} or {id, crash_days (remaining duration when fully crashed), crash_cost (extra cost to get there)}; without it every remaining activity may lose default_max_pct (30) % of its remaining duration at 1 per day. Goal: target_finish (date), target_days (working days to gain), or neither with indirect_cost_per_day / ld_per_day to stop at the least total cost. Answers stop SUCCESS | PLATEAU | EXHAUSTED | CAP | ALREADY_MET with a note, every step {activities [{id, days, cost}], days_gained, cost, finish, cumulative_direct_cost, total_cost (direct less indirect and liquidated damages saved)}, the duration changes and the edit ops. apply: true makes the changes and reschedules (one undoable change).' + exportDoc('crash_schedule', ['steps', 'step_activities', 'changes']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, target_finish: { type: 'string' }, target_days: { type: 'number' }, activities: { type: 'array', items: { type: 'object' } }, default_max_pct: { type: 'number' }, indirect_cost_per_day: { type: 'number' }, ld_per_day: { type: 'number' }, locked: { type: 'array', items: { type: 'string' } }, max_steps: { type: 'number', description: 'default 100' }, apply: { type: 'boolean' } } }) },
  { name: 'optimize_schedule', annotations: writesFile, description: 'The White Hat IQ schedule reasoner (a trained model, embedded; runs locally): picks each remaining activity’s mode (normal, or crashed when crash data is given) and a placement priority so the resource-limited schedule finishes soonest, sampling `samples` trajectories around the model’s answer (default 200, 64 above 120 activities; `seed` makes it repeatable). Resources need a Max Units/Time limit to be leveled. The proposal is checked with the P6 leveler: answers cpm_finish (no leveling), p6_leveled_finish (P6 default leveling), reasoner_finish (its modes and priority through the same leveler), better_than_p6_leveler, crash changes and cost, and the priority order (the first 100; priority_total says how many). objective min_crash_cost runs crash_schedule instead (give target_finish or target_days). apply: true makes the crash changes, reschedules and levels in the proposed order (one undoable change; like P6 leveling, the next F9 without leveling drops the leveled dates). Up to 3000 remaining activities.' + exportDoc('optimize_schedule', ['activities (CPM, P6-leveled and reasoner start and finish of every activity, and the reasoner\u2019s shift in working days)', 'priority (the whole order)', 'changes']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, objective: { type: 'string', description: 'makespan (default) or min_crash_cost' }, samples: { type: 'number' }, seed: { type: 'number' }, activities: { type: 'array', description: 'crash data [{id, crash_days, crash_cost} | {id, min_days, cost_per_day}]', items: { type: 'object' } }, target_finish: { type: 'string' }, target_days: { type: 'number' }, apply: { type: 'boolean' } } }) },
  { name: 'windows_analysis', annotations: ro, description: 'Windows delay analysis (AACE 29R-03 MIP 3.3 contemporaneous; method half_step = MIP 3.4): the updates are put in data-date order (this handle is the latest unless include_current is false) and each window compares one update with the next: finish before and after and the slip in working days (on the first update\u2019s project calendar, so windows add up to total_slip_days), the driving path at the window\u2019s start, the activities on it that lost time with causes (started late, duration revised, logic revised, progressed slower than planned, deleted), and activities added. half_step re-runs the earlier update with only the later one\u2019s progress at its data date and splits the slip into progress_days and revision_days. Activities match by Activity ID, then by a unique name. updates: [{handle} | {path} | {baseline: project|bl1|bl2|bl3|<saved baseline name>} | {data_date, progress: [edit ops]} (the previous update, or the current project after a stored baseline, with this progress, scheduled at data_date)]. milestone measures a key milestone instead of completion.' + exportDoc('windows_analysis', ['windows', 'driving_path', 'lost_time', 'added']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, updates: { type: 'array', items: { type: 'object' } }, include_current: { type: 'boolean' }, current_name: { type: 'string', description: 'the name this handle\u2019s state is given as the last update (default "current")' }, method: { type: 'string', description: 'contemporaneous (default) or half_step' }, milestone: { type: 'string' }, max_ids: { type: 'number', description: 'activities listed per window in driving_path, lost_time and added (default 50; 0 = all); driving_path_total, lost_time_total and added_total say how many there are' } }, required: ['updates'] }) },
  { name: 'tia', annotations: writesFile, description: 'Time impact analysis (AACE 52R-06): the fragnet (edit ops: add_activity, add_relationship, update_activity\u2026) is inserted in a copy of the project and both are scheduled at the same data date (data_date, default the project\u2019s). Answers unimpacted_finish, impacted_finish, delay_days (working days, project calendar), fragnet_on_critical_path, fragnet_path (the fragnet activities and what they drive to the finish), became_critical / no_longer_critical; baseline (project, bl1-bl3 or the name of any saved baseline) adds the impacted variance to that baseline\u2019s finish. milestone measures a key milestone. The project is unchanged unless keep: true, which adds the impacted schedule as a new project copy (<Project ID>-TIA, one undoable change).' + exportDoc('tia', ['summary', 'fragnet_path', 'critical_changes']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, project, fragnet: { type: 'array', items: { type: 'object' } }, data_date: { type: 'string' }, milestone: { type: 'string' }, baseline: { type: 'string' }, keep: { type: 'boolean' } }, required: ['fragnet'] }) },
];

export const ANALYSIS_NAMES = new Set(['check_schedule', 'dcma_14', 'lint', 'float_paths', 'progress_curves', 'resource_histogram', 'evaluate_batch', 'crash_schedule', 'optimize_schedule', 'windows_analysis', 'tia']);

/** Run an analysis tool; undefined when the name is not one of them. */
export async function runAnalysis(name: string, a: Record<string, any>, s: Session, h: AnalysisHelpers): Promise<unknown> {
  if (!ANALYSIS_NAMES.has(name)) return undefined;
  const projIds = a.project != null && a.project !== '' ? h.projectIds(s.db, a.project) : h.allIds(s.db);
  const maxIds = a.max_ids != null ? Math.max(0, Math.floor(Number(a.max_ids))) : undefined;
  /** The answer, and with export the full result and its tables written (the answer names them in exported). changed: the tool has
   *  changed the project already (apply, keep, write), so a failure to write the export is said beside the result (export_error). */
  const exported = <T extends object>(answer: T, full: unknown, tables: Table[], changed = false) => {
    if (a.export == null) return answer;
    const make = () => exportResult(name, a.export, full, tables, h.writeOutWith);
    return { ...answer, ...(changed ? exportAfterChange(make) : { exported: make() }) };
  };
  const withReport = <T extends { report: string; checks: unknown[]; summary: Record<string, number> }>(r: T) => {
    if (!a.path) return r;
    const path = pathArg(a.path, 'path', 'write');
    h.writeOut(path, analysisReportHtml(r as never, nowStamp()));
    return { ...r, saved: path };
  };
  /** A report of checks, worked out with every activity listed (max_ids 0): the answer lists max_ids of them per check (default 100;
   *  total_activities says how many there are) and is the one the HTML report shows; the export has them all. */
  const checked = <C extends CheckResult & { fixes?: unknown[] }, T extends { report: string; checks: C[]; summary: Record<string, number> }>(full: T, columns: string[], found: string, extra: Table[] = [], cut: (c: C, max: number) => C = (c, max) => ({ ...c, activities: firstOf(c.activities, max) })) => {
    const max = maxIds ?? 100;
    const answer = withReport({ ...full, checks: full.checks.map((c) => cut(c, max)) });
    return exported(answer, full, [
      { name: 'checks', columns, rows: full.checks.map(({ activities: _a, fixes: _f, ...c }) => (c.threshold == null ? (({ threshold: _t, ...x }) => x)(c) : c)) },
      { name: found, columns: ['check', 'id', 'name', 'project', 'value'], rows: full.checks.flatMap((c) => c.activities.map((x) => ({ check: c.id, ...x }))) },
      ...extra,
    ]);
  };
  const CHECK_COLUMNS = ['id', 'name', 'result', 'metric', 'unit', 'threshold_op', 'threshold_value', 'threshold_source', 'numerator', 'denominator', 'total_activities', 'note'];
  switch (name) {
    case 'check_schedule': {
      const unknown = (a.checks ?? []).filter((c: string) => !P6_CHECKS.some((x) => x.id === c));
      if (unknown.length) fail('bad_input', `Unknown check(s): ${unknown.join(', ')}.`, `Checks: ${P6_CHECKS.map((c) => c.id).join(', ')}.`);
      const r = checkSchedule(s.db, { projIds, hoursPerDay: s.hpd, checks: a.checks, targets: a.targets, thresholdHours: a.threshold_days != null ? Number(a.threshold_days) * s.hpd : undefined, maxIds: 0 });
      return checked(r, CHECK_COLUMNS, 'failing_activities', [{ name: 'projects', columns: ['id', 'name', 'data_date', 'activities', 'completed', 'relationships', 'missing_baseline_activities'], rows: r.projects }]);
    }
    case 'dcma_14': {
      if (a.profile != null && !DCMA_PROFILES[a.profile]) fail('bad_input', `Unknown profile "${a.profile}".`, `Profiles: ${Object.keys(DCMA_PROFILES).join(', ')}.`);
      if (a.baseline != null && !projIds.some((id) => baselineOf(s.db, s.db.tables.PROJECT.rows.find((p) => p.proj_id === id)!, String(a.baseline)))) fail('bad_input', `No baseline "${a.baseline}" for this project.`, `Use project, bl1, bl2, bl3 or a saved baseline's name: ${savedBaselines(s.db, projIds).join(', ') || 'none saved'}.`);
      const limit = a.limit_days === 'dynamic' ? 'dynamic' : a.limit_days != null ? Number(a.limit_days) : undefined;
      return checked(dcma14(s.db, { projIds, hoursPerDay: s.hpd, profile: a.profile, thresholds: a.thresholds, baseline: a.baseline, statusDate: h.dd(a.status_date), targetFinish: h.dd(a.target_finish), cptSlipDays: a.cpt_slip_days != null ? Number(a.cpt_slip_days) : undefined, cptActivity: a.cpt_activity, limitDays: limit, exempt: a.exempt, maxIds: 0 }), CHECK_COLUMNS, 'failing_activities');
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
      const near = tasks.map((t) => ({ t, d: Number(t.total_float_hr_cnt) / s.hpd })).filter((x) => x.d > 0 && x.d <= nearDays).sort((x, y) => x.d - y.d).map((x) => ({ id: x.t.task_code, name: x.t.task_name, total_float_days: Math.round(x.d * 10) / 10 }));
      const answer = { end: r.end, method: r.method, paths: r.paths, near_critical: near, ...(a.between ? { between: pathsBetween(s.db, projIds, a.between, s.hpd) ?? fail('bad_input', BETWEEN_NEEDS, 'e.g. {"from": "A1000", "to": "A9000"}') } : {}), ...(a.write ? { written: true } : {}) };
      return exported(answer, answer, [
        { name: 'paths', columns: ['path', 'float_hours', 'order', 'id', 'name', 'total_float_hours'], rows: r.paths.flatMap((p) => p.activities.map((x) => ({ path: p.path, float_hours: p.float_hours, ...x }))) },
        { name: 'near_critical', columns: ['id', 'name', 'total_float_days'], rows: near },
        { name: 'between', columns: ['path', 'duration_days', 'min_float_days', 'activities'], rows: (answer.between?.paths ?? []).map((p, i) => ({ path: i + 1, ...p })) },
      ], !!a.write);
    }
    case 'progress_curves': {
      const period = a.period ?? 'month', units = a.units ?? 'cost';
      if (period !== 'week' && period !== 'month') fail('bad_input', 'period must be week or month.', 'Use week or month.');
      if (units !== 'cost' && units !== 'hours') fail('bad_input', 'units must be cost or hours.', 'Use cost or hours.');
      const r = progressCurves(s.db, projIds, { period, units, from: h.dd(a.from) ?? undefined, to: h.dd(a.to) ?? undefined });
      return exported(r, r, [
        { name: 'periods', columns: ['start', 'end', 'pv', 'ev', 'ac', 'remaining_early', 'remaining_late', 'cum_pv', 'cum_ev', 'cum_ac', 'cum_forecast_early', 'cum_forecast_late', 'spi', 'cpi', 'cum_spi', 'cum_cpi'], rows: r.periods },
        { name: 'totals', columns: ['units', 'data_date', 'bac', 'pv', 'ev', 'ac', 'etc', 'eac', 'vac', 'spi', 'cpi', 'tcpi'], rows: [{ units: r.units, data_date: r.data_date, ...r.totals }] },
      ]);
    }
    case 'resource_histogram': {
      const period = a.period ?? 'week';
      if (period !== 'week' && period !== 'month') fail('bad_input', 'period must be week or month.', 'Use week or month.');
      const r = resourceHistograms(s.db, projIds, { resources: a.resources, period, cost: a.cost === true, threshold: a.threshold != null ? Number(a.threshold) : undefined });
      if (a.resources?.length && !r.resources.length) fail('bad_input', `No assignments for ${a.resources.join(', ')}.`, 'Use resource IDs that are assigned in this project (list_dictionaries or resource_summary).');
      // the export: every resource with its periods
      const out = <T extends object>(answer: T) => exported(answer, r, [
        { name: 'resources', columns: ['resource', 'name', 'units', 'peak_start', 'peak_demand', 'peak_limit', 'over_allocated_periods', 'severity', 'periods_total'], rows: r.resources.map(({ periods: _p, ...x }) => x) },
        { name: 'periods', columns: ['resource', 'start', 'end', 'budgeted', 'actual', 'remaining_early', 'remaining_late', 'limit', 'over_allocated', 'available'], rows: r.resources.flatMap((x) => x.periods.map((p) => ({ resource: x.resource, ...p }))) },
      ]);
      // many resources: every resource's summary, periods for the 10 most over-allocated (or all with detail: true)
      if (a.resources?.length || a.detail === true || r.resources.length <= 10) return out(r);
      const rank = [...r.resources].sort((x, y) => y.over_allocated_periods - x.over_allocated_periods || (y.peak?.demand ?? 0) - (x.peak?.demand ?? 0));
      const top = new Set(rank.slice(0, 10).map((x) => x.resource));
      return out({ ...r, resources: r.resources.map((x) => (top.has(x.resource) ? x : { ...x, periods: undefined })), note: `Periods are shown for the 10 most over-allocated of ${r.resources.length} resources; pass resources: [IDs] or detail: true for others.` });
    }
    case 'evaluate_batch': {
      if (!Array.isArray(a.scenarios) || !a.scenarios.length) fail('bad_input', 'scenarios must be a non-empty list.', 'e.g. [{"name": "A shorter", "overrides": [{"op": "update_activity", "id": "A1000", "duration_days": 5}]}]');
      if (a.resume != null && (typeof a.resume !== 'string' || !a.resume.trim())) fail('bad_input', 'resume must be the path a stopped evaluate_batch answered.', 'Pass that path exactly as given, or leave resume out to start over.');
      // every scenario is kept as it finishes (keptRuns.ts); in a compute worker the file's path goes out first, so the answer of a
      // worker that was ended names it
      // (one run at a time on a kept file: a second is refused as run_busy, naming the job that holds it)
      const store = new ScenarioFile(a.resume ?? null, h.claim ?? claimHere(h.job ?? (() => undefined)), h.keep ? (path) => h.keep!({ resume: path }) : undefined);
      // with export, the kept file (every activity each scenario moved: the batch holds only what the answer shows) is read for the
      // export before it goes: a finished batch's finish, which removes it, waits until the export is written
      let finishAsked = false;
      const batchStore: RowStore = a.export == null ? store : { open: (x) => store.open(x), resumeAt: (n) => store.resumeAt(n), add: (k) => store.add(k), stop: (d) => store.stop(d), finish: () => { finishAsked = true; return undefined; } };
      let r: Awaited<ReturnType<typeof evaluateBatch>>, files: ReturnType<typeof exportResult> | undefined, finished: string | undefined;
      try {
        r = await evaluateBatch(s.db, projIds, a.scenarios.map((x: any, i: number) => ({ name: String(x?.name ?? `scenario ${i + 1}`), overrides: Array.isArray(x?.overrides) ? x.overrides : [] })), { hoursPerDay: s.hpd, top: a.top != null ? Number(a.top) : undefined, tick: h.tick, onRow: h.keep, store: batchStore });
        if (r.ok && a.export != null) {
          const rows = r.scenarios;
          // each scenario as answered, with every activity whose dates it moved, read from the kept file as it is written
          const whole = function* () {
            let i = 0;
            for (const k of store.scenarios()) {
              if (k.i !== i || i >= rows.length) break;
              yield { ...rows[i], ...(k.changed ? { changed: k.changed, changed_total: k.changed.length } : {}) };
              i++;
            }
            if (i !== rows.length) fail('export_failed', `The export of evaluate_batch could not be written: its kept file holds ${i} of the ${rows.length} scenarios done.`, 'Call evaluate_batch again (the batch itself is answered without export).');
          };
          const { kept, resumed: _r, redone: _d, keptNote: _k, ...rest } = r;
          files = exportResult(name, a.export, { ...rest, ...(kept ? { resume: kept } : {}), scenarios: whole }, [
            { name: 'scenarios', columns: ['name', 'ok', 'error', 'finish', 'finish_delta_days', 'critical', 'became_critical', 'no_longer_critical', 'negative_float', 'cost', 'cost_delta', 'dates_moved'], rows: function* () { for (const { changed: _c, changed_total: n, ...x } of whole()) yield { ...x, dates_moved: n ?? null }; } },
            { name: 'dates_moved', columns: ['scenario', 'id', 'start_before', 'start_after', 'finish_before', 'finish_after'], rows: function* () { for (const x of whole()) for (const c of x.changed ?? []) yield { scenario: x.name, id: c.id, start_before: c.start[0], start_after: c.start[1], finish_before: c.finish[0], finish_after: c.finish[1] }; } },
          ], h.writeOutWith);
        }
      } finally { if (finishAsked) finished = store.finish(); store.release(); }
      if (!r.ok) return fail(r.error.code, r.error.message, 'Fix the schedule errors first (schedule shows them).');
      const { kept, resumed, redone, ...rest } = r;
      const keptNote = rest.keptNote ?? finished;
      delete rest.keptNote;
      const answer = { ...rest, ...(kept ? { resume: kept, note: `Partial: ${rest.scenarios_done} of ${rest.scenarios_requested} scenarios were done${rest.error ? ` (it stopped: ${rest.error})` : ''}, and they are kept in ${kept}: ${keepWords('evaluate_batch', kept, 'scenarios')} best and the details of the best few are then worked out over every scenario.` } : {}), ...(resumed ? { resumed_scenarios: resumed } : {}),
        // kept scenarios that did not check out (a power loss can leave zeros or old bytes), with every one after them: done again, said
        ...(redone ? { redone_scenarios: redone, redone_note: `${redone} kept scenario${redone === 1 ? '' : 's'} did not check out (damaged, as a power loss can leave a file, or after a damaged one) and ${redone === 1 ? 'was' : 'were'} done again.` } : {}), ...(keptNote ? { note: keptNote } : {}),
        // a finished batch removed its kept file: named, so a copy of it elsewhere (the platform's mirror of the outputs) goes too
        ...(!rest.partial && !keptNote && store.path ? { parts_removed: keptPlace(store.path) } : {}) };
      return files ? { ...answer, exported: files } : answer;
    }
    case 'crash_schedule': {
      // (an LOB plan's activities are locked: crashOptionsOf, as the Crashing panel calls it)
      const r = await crashSchedule(s.db, projIds, { ...crashOptionsOf(s.db, a, s.hpd), tick: h.tick });
      if (!r.ok) return fail(r.error.code, r.error.message, r.error.code === 'bad_input' ? 'e.g. {"target_days": 10} or {"target_finish": "2026-12-31"}' : 'Fix the schedule errors first (schedule shows them).');
      if (a.apply && r.ops.length) h.apply('Crash schedule', (d) => { const x = applyOps(d, r.ops, { hoursPerDay: s.hpd, calendarDays: true }); if (!x.ok) fail('bad_input', x.error!.message, ''); reschedule(d, projIds); });
      const answer = { ...r, ...(a.apply ? { applied: r.ops.length > 0 } : {}) };
      return exported(answer, answer, [
        { name: 'steps', columns: ['step', 'days_gained', 'cost', 'finish', 'cumulative_direct_cost', 'total_cost', 'activities'], rows: r.steps.map((x) => ({ ...x, activities: x.activities.map((y) => y.id) })) },
        { name: 'step_activities', columns: ['step', 'id', 'days', 'cost'], rows: r.steps.flatMap((x) => x.activities.map((y) => ({ step: x.step, ...y }))) },
        { name: 'changes', columns: ['id', 'remaining_days_from', 'remaining_days_to'], rows: r.changes },
      ], !!(a.apply && r.ops.length));
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
      const { order, dates, ...answer } = r;
      if (a.apply) h.apply('Optimize schedule (reasoner)', (d) => { ops(d, r.ops); reschedule(d, projIds); if (r.leveled_activities) { levelResources(d, projIds, { first: order }); syncAssignmentDates(d); } });
      const out = { objective, ...answer, ...(a.apply ? { applied: true } : {}) };
      if (a.export == null) return out;
      // the export: the whole placement order, and every activity's dates under CPM, P6's leveling and the reasoner's proposal
      const iso = (v: number | null) => (v != null ? formatP6Date(v) : null);
      const code = new Map(dates.map((x) => [x.taskId, x]));
      const priority = order.map((id, i) => ({ rank: i + 1, id: code.get(id)!.code, name: code.get(id)!.name }));
      const activities = dates.map((x) => ({ id: x.code, name: x.name, cpm_start: iso(x.cpm[0]), cpm_finish: iso(x.cpm[1]), p6_leveled_start: iso(x.p6[0]), p6_leveled_finish: iso(x.p6[1]), reasoner_start: iso(x.reasoner[0]), reasoner_finish: iso(x.reasoner[1]), start_delta_days: x.startDeltaDays, finish_delta_days: x.finishDeltaDays }));
      return exported(out, { ...out, priority: priority.map((x) => x.id), activity_dates: activities }, [
        { name: 'activities', columns: ['id', 'name', 'cpm_start', 'cpm_finish', 'p6_leveled_start', 'p6_leveled_finish', 'reasoner_start', 'reasoner_finish', 'start_delta_days', 'finish_delta_days'], rows: activities },
        { name: 'priority', columns: ['rank', 'id', 'name'], rows: priority },
        { name: 'changes', columns: ['id', 'from_days', 'to_days', 'cost'], rows: r.changes },
      ], !!a.apply);
    }
    case 'windows_analysis': {
      if (!Array.isArray(a.updates) || !a.updates.length) fail('bad_input', 'updates must list the other updates.', 'e.g. [{"path": "Update 1.xer"}, {"handle": "..."}] or [{"baseline": "project"}]');
      if (a.method != null && a.method !== 'contemporaneous' && a.method !== 'half_step') fail('bad_input', `Unknown method "${a.method}".`, 'Use contemporaneous or half_step.');
      const mainProj = (db: Db) => rows(db, 'PROJECT').find((p) => !p._baseline_of && (a.project == null || p.proj_short_name === a.project)) ?? fail('bad_input', a.project ? `No project "${a.project}".` : 'The file has no project.', 'Pass project.');
      const updates: Update[] = [];
      const cur = mainProj(s.db);
      // each update read from a file, or built as a copy, is held for this call: counted in the memory budget (C14)
      const releases: (() => void)[] = [];
      try {
      for (const [i, u] of (a.updates as Record<string, unknown>[]).entries()) {
        if (u?.handle) { const o = getSession(u.handle); updates.push({ name: String(u.name ?? o.path ?? u.handle), db: o.db, projId: mainProj(o.db).proj_id }); }
        else if (u?.path) { const p = pathArg(u.path); releases.push(reserveMemory(estimateBytes(sizeOf(p)), `Reading update ${i + 1} (${basename(p)}) for windows_analysis`, 'open the updates with open_file and pass their handles when there is room')); let db: Db; try { db = detectFormat(p, headOf(p)) === 'xer' ? readXerFile(p).db : (() => { const b = new Uint8Array(readFileSync(p)); return readRaw(b, detectFormat(p, b)).db; })(); } catch (e) { if (e instanceof Error && /^E[A-Z]+$/.test(String((e as { code?: unknown }).code ?? ''))) return fail('file_unreadable', `Cannot read ${p}.`, 'Check the path.'); return fail('bad_input', `Cannot read update ${i + 1} (${basename(p)}): ${(e as Error).message}`, 'Give an XER, P6 XML or Microsoft Project XML (.xml) file, or open it with open_file and pass its handle.'); } updates.push({ name: String(u.name ?? p), db, projId: mainProj(db).proj_id }); }
        else if (u?.baseline) { const bl = baselineOf(s.db, cur, String(u.baseline) as 'project') ?? fail('bad_input', `The project has no ${u.baseline} baseline in this file.`, `Use project, bl1, bl2, bl3 or a saved baseline's name: ${savedBaselines(s.db, [cur.proj_id]).join(', ') || 'none saved'}.`); updates.push({ name: String(u.name ?? bl.name), db: s.db, projId: bl.projId }); }
        else if (u?.data_date && Array.isArray(u.progress)) {
          // built from the last update that is a schedule of its own (a stored baseline is a snapshot, not edited), else the current project
          const prev = [...updates].reverse().find((x) => x.db !== s.db || x.projId === cur.proj_id) ?? { name: 'current', db: s.db, projId: cur.proj_id };
          releases.push(reserveMemory(s.bytes, `Building update ${i + 1} (a copy of the project) for windows_analysis`, 'pass fewer progress updates, or save them as files and open them'));
          const db = structuredClone(prev.db) as Db, dd = h.dd(u.data_date) ?? fail('bad_input', `updates[${i}].data_date is not a date.`, 'YYYY-MM-DD');
          const r = applyOps(db, u.progress, { hoursPerDay: s.hpd, calendarDays: true });
          if (!r.ok) fail('bad_input', `updates[${i}] operation ${r.error!.index + 1}: ${r.error!.message}`, '');
          if (!scheduleProjects(db, [prev.projId], { dataDate: dd }).ok) fail('schedule_failed', `updates[${i}] cannot be scheduled.`, '');
          updates.push({ name: String(u.name ?? `update at ${String(u.data_date)}`), db, projId: prev.projId });
        } else fail('bad_input', `updates[${i}] needs handle, path, baseline, or data_date with progress.`, '');
      }
      // the last state's name in the answer and the files (the platform names its progress-log states)
      if (a.include_current !== false) updates.push({ name: a.current_name != null ? String(a.current_name) : 'current', db: s.db, projId: cur.proj_id });
      // worked out with every activity listed: the answer lists max_ids of them per window (default 50; 0 = all), the export all
      const r = await windowsAnalysis(updates, { milestone: a.milestone, method: a.method, hoursPerDay: s.hpd, maxIds: 0, tick: h.tick });
      if (!r.ok) return fail(r.error.code, r.error.message, 'Check the milestone and the updates.');
      const W = r.windows as (Record<string, unknown> & { window: number; driving_path: string[]; lost_time: Record<string, unknown>[]; added: string[] })[];
      return exported({ ...r, windows: W.map((w) => cutWindow(w, maxIds ?? 50)) }, r, [
        { name: 'windows', columns: ['window', 'from', 'to', 'data_date_from', 'data_date_to', 'finish_from', 'finish_to', 'slip_days', 'driving_path_total', 'lost_time_total', 'added_total', 'half_step_finish', 'half_step_progress_days', 'half_step_revision_days'], rows: W.map(({ driving_path: _d, lost_time: _l, added: _a, ...w }) => w) },
        { name: 'driving_path', columns: ['window', 'order', 'id'], rows: W.flatMap((w) => w.driving_path.map((id, i) => ({ window: w.window, order: i + 1, id }))) },
        { name: 'lost_time', columns: ['window', 'id', 'name', 'now', 'lost_days', 'finish_from', 'finish_to', 'causes'], rows: W.flatMap((w) => w.lost_time.map((x) => ({ window: w.window, ...x }))) },
        { name: 'added', columns: ['window', 'id'], rows: W.flatMap((w) => w.added.map((id) => ({ window: w.window, id }))) },
      ]);
      } finally { for (const r of releases) r(); }
    }
    case 'tia': {
      if (!Array.isArray(a.fragnet) || !a.fragnet.length) fail('bad_input', 'fragnet must list edit operations.', 'e.g. [{"op": "add_activity", "id": "X1", "name": "Design change", "duration_days": 10}, {"op": "add_relationship", "pred": "A1000", "succ": "X1"}]');
      const cur = rows(s.db, 'PROJECT').find((p) => p.proj_id === projIds[0])!;
      let baseline: { name: string; finish: number | null; how: string } | undefined;
      if (a.baseline) {
        const bl = baselineOf(s.db, cur, String(a.baseline) as 'project') ?? fail('bad_input', `The project has no ${a.baseline} baseline in this file.`, `Use project, bl1, bl2, bl3 or a saved baseline's name: ${savedBaselines(s.db, [cur.proj_id]).join(', ') || 'none saved'}.`);
        baseline = tiaBaseline(bl, a.milestone, h.dd); // (as the TIA panel works it out)
      }
      const dd = a.data_date != null ? h.dd(a.data_date) ?? fail('bad_input', 'data_date is not a date.', 'YYYY-MM-DD') : undefined;
      const r = timeImpact(s.db, [projIds[0]], a.fragnet, { dataDate: dd, milestone: a.milestone, hoursPerDay: s.hpd, baseline });
      if (!r.ok) return fail(r.error.code, r.error.message, 'Fix the fragnet operations (Activity IDs of this project).');
      const tiaOut = <T extends object>(answer: T, kept = false) => exported(answer, answer, [
        { name: 'summary', columns: ['measured', 'data_date', 'unimpacted_finish', 'impacted_finish', 'delay_days', 'fragnet_on_critical_path', 'baseline', 'baseline_finish', 'variance_to_baseline_days'], rows: [(({ ok: _o, fragnet_path: _p, became_critical: _b, no_longer_critical: _n, ...x }) => x)(r)] },
        { name: 'fragnet_path', columns: ['order', 'id'], rows: r.fragnet_path.map((id, i) => ({ order: i + 1, id })) },
        { name: 'critical_changes', columns: ['id', 'change'], rows: [...r.became_critical.map((id) => ({ id, change: 'became_critical' })), ...r.no_longer_critical.map((id) => ({ id, change: 'no_longer_critical' }))] },
      ], kept);
      if (!a.keep) return tiaOut(r);
      let id = `${cur.proj_short_name}-TIA`;
      for (let k = 2; rows(s.db, 'PROJECT').some((p) => p.proj_short_name.toLowerCase() === id.toLowerCase()); k++) id = `${cur.proj_short_name}-TIA${k}`;
      h.apply(`TIA ${id}`, (d) => {
        const x = applyOps(d, [{ op: 'copy_project', from: cur.proj_short_name, id, keep_progress: true }, ...a.fragnet.map((op: Record<string, unknown>) => ({ ...op, project: id, pred_project: undefined, succ_project: undefined }))], { hoursPerDay: s.hpd, calendarDays: true });
        if (!x.ok) fail('bad_input', x.error!.message, '');
        const copy = rows(d, 'PROJECT').find((p) => p.proj_short_name === id)!;
        reschedule(d, [copy.proj_id], dd != null ? { dataDate: dd } : {});
      });
      return tiaOut({ ...r, kept_as: id }, true);
    }
    case 'lint': {
      if (a.profile != null && a.profile !== 'p6' && a.profile !== 'platform') fail('bad_input', `Unknown profile "${a.profile}".`, 'Use p6 or platform.');
      const unknown = (a.checks ?? []).filter((c: string) => !(LINT_CHECKS as readonly string[]).includes(c));
      if (unknown.length) fail('bad_input', `Unknown check(s): ${unknown.join(', ')}.`, `Checks: ${LINT_CHECKS.join(', ')}.`);
      try { resolveLintThresholds(a.thresholds); } catch (e) { fail('bad_input', (e as Error).message, 'e.g. {"criticality": {"pass": [0.1, 0.3]}}; the answer of a call without thresholds lists them all.'); }
      const r = lintSchedule(s.db, { projIds, hoursPerDay: s.hpd, profile: a.profile, checks: a.checks, simulate: a.simulate !== false, maxIds: 0, thresholds: a.thresholds });
      return checked(r as typeof r & { summary: Record<string, number> }, ['id', 'name', 'severity', 'band', 'result', 'metric', 'unit', 'numerator', 'denominator', 'total_activities', 'weight', 'note'], 'findings',
        [{ name: 'fixes', columns: ['check', 'activities', 'fix', 'saves_days', 'ops'], rows: r.checks.flatMap((c) => (c.fixes ?? []).map((f) => ({ check: c.id, ...f }))) }], cutLintCheck);
    }
  }
  return undefined;
}

