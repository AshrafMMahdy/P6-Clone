// Schedule analysis tools of the MCP server (kept apart from server.ts so the two grow without stepping on each other):
// P6 Check Schedule and DCMA 14-point; later lint, float paths, curves, what-ifs, crashing and delay analysis.
import { dayHours } from '../core/project/units.ts';
import { cancelledAfter, noLimitNote } from '../core/notes.ts';
import { CurvesRefused, progressCurves, resourceHistograms } from '../core/analysis/curves.ts';
import { BETWEEN_NEEDS, computeFloatPaths, pathsBetween, writeFloatPaths } from '../core/schedule/floatPaths.ts';
import type { Db, Row } from '../core/db.ts';
import { checkSchedule, P6_CHECKS } from '../core/analysis/checkSchedule.ts';
import { dcma14, DCMA_PROFILES } from '../core/analysis/dcma.ts';
import { analysisReportHtml } from '../core/analysis/report.ts';
import { LISTED, namesText } from '../core/analysis/common.ts';
import { cutLintCheck, DEFAULT_LINT_THRESHOLDS, lintScheduleTicked, LINT_CHECKS, resolveLintThresholds } from '../core/analysis/lint.ts';
import { evaluateBatch, type RowStore } from '../core/analysis/batch.ts';
import { claimHere, keptPlace, keepWords, ScenarioFile, type Claim } from './keptRuns.ts';
import { crashOptionsOf, crashSchedule } from '../core/analysis/crash.ts';
import { optimizeSchedule } from '../core/analysis/hrm.ts';
import { reasonerRefusal, whiqFieldClash, writeWhiqFields, type FieldData } from '../core/analysis/whiq-fields.ts';
import { nodeInfer, ReasonerUnavailable } from '../core/analysis/hrmRuntime.ts';
import { levelResources } from '../core/level/level.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { nowStamp } from '../core/report/reports.ts';
import { formatP6Date } from '../core/dates.ts';
import { config, countArg, estimateBytes, fail, getSession, pathArg, readCause, reserveMemory, type Session } from './runtime.ts';
import { between as betweenMax } from './workset.ts';
import { cutWindow, tiaBaseline, timeImpact, windowsAnalysis, type Update } from '../core/analysis/delay.ts';
import { exportAfterChange, exportDoc, exportNameProp, exportOf, exportProp, exportResult, firstOf, type Table } from './export.ts';
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
const reportPath = { type: 'string', description: 'also write the report as HTML to this path' };

/** F9 inside an applied change, as the schedule tool does it: assignment dates follow, and a failure refuses the change. */
/** The between answer, or the tool's error: BETWEEN_NEEDS for a missing activity, the loop's activities for a loop in the logic. */
function betweenOrFail(r: ReturnType<typeof pathsBetween>) {
  if (r === null) return fail('bad_input', BETWEEN_NEEDS, 'e.g. {"from": "A1000", "to": "A9000"}');
  return 'error' in r ? fail('bad_input', r.error) : r;
}

function reschedule(d: Db, projIds: string[], over: Parameters<typeof scheduleProjects>[2] = {}) {
  const r = scheduleProjects(d, projIds, over);
  if (!r.ok) fail('schedule_failed', `The changed schedule cannot be scheduled: ${r.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' ') || 'see schedule'}`, 'Nothing was changed.');
  syncAssignmentDates(d);
}

/** The names of the baselines saved from these projects (any number; BL1-BL3 are only the assigned ones). */
export const savedBaselines = (db: Db, projIds: string[]) => rows(db, 'PROJECT').filter((p) => projIds.includes(p._baseline_of ?? '')).map((p) => p.proj_short_name);

/** The answer, and with export the full result and its tables written (the answer names them in exported). changed: the tool has
 *  changed the project already (apply, keep, write), so a failure to write the export is said beside the result (export_error).
 *  The same for every analysis tool, forensics.ts' too. */
export const resultExporter = (name: string, a: Record<string, any>, h: Pick<AnalysisHelpers, 'writeOutWith'>, asTool?: string) => <T extends object>(answer: T, full: unknown, tables: Table[], changed = false) => {
  if (a.export == null) return answer;
  // files are named by the tool the caller called (optimize_schedule's crashing: its own), and a stopped run's answer is written as -partial
  const make = () => exportResult(name, a.export, full, tables, h.writeOutWith, exportOf(a, { as: asTool, partial: (answer as { partial?: unknown }).partial === true }));
  return { ...answer, ...(changed ? exportAfterChange(make) : { exported: make() }) };
};

/** The updates a series-taking tool reads: updates: [{baseline: project|bl1|bl2|bl3|<saved baseline name>} | {path} | {handle} | {data_date, progress: [edit ops]}] (windows_analysis;
 *  the same shapes for every tool that takes a series), each as the project of its own schedule, in the order given (the analysis puts them in data-date order), and with includeCurrent
 *  this handle's project as the last one (named currentName, default "current"). Each update read from a file, or built as a copy, is held for the call: counted in the memory
 *  budget (C14), and release() gives it back (the caller calls it when the call ends; a refusal in here has given back what was held). tool names the caller in the memory refusals. */
export function loadUpdates(a: Record<string, any>, s: Session, h: Pick<AnalysisHelpers, 'dd'>, o: { tool: string; includeCurrent: boolean; currentName?: unknown }): { updates: Update[]; release: () => void } {
  requireUpdates(a);
  // the project of a schedule in the series. The open file's: the top-level project, else the file's only project. Each update's (a file read for the series, or an as_planned file): the project of its own entry
  // ({path | handle, project}), else its only project; a file with several projects and no project of its own is refused naming its Project IDs, because a series compares ONE project, never the first of them silently
  // (P6 updates usually change the Project ID, so a project named for the open file is no help for an update). A baseline stored in the file as a project of its own (_baseline_of) is not a second project (the project list
  // of every tool leaves them out).
  const mainProj = (db: Db, what: string, entry: Record<string, unknown> | null, asPlanned = false) => {
    const mains = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
    const ids = namesText(mains.map((p) => p.proj_short_name));
    const want = entry ? entry.project : a.project;
    if (want != null) return mains.find((p) => p.proj_short_name === want) ?? fail('bad_input', `No project "${String(want)}"${entry ? ` in ${what}` : ''}.`, `Its Project IDs: ${ids || 'none'}.${entry ? ` Pass project in ${asPlanned ? 'as_planned' : 'that update entry'} with one of them.` : ' Pass project with one of them.'}`);
    if (mains.length > 1) {
      if (!entry) fail('bad_input', `${what} has ${mains.length} projects (${ids}) and a series compares one project.`, `Pass project: ${ids} (one of them: the open file's project). An update that has several projects takes project in its own entry: {"path": "...", "project": "<ID>"}.`);
      fail('bad_input', asPlanned ? `${what} has ${mains.length} projects (${ids}) and the comparison needs one.` : `${what} has ${mains.length} projects (${ids}) and a series compares one project.`, asPlanned ? 'Add project to as_planned: {"path": "...", "project": "<ID>"} (one of them).' : 'Add project to THAT update entry: {"path": "...", "project": "<ID>"} (one of them; the top-level project is the open file\'s).');
    }
    return mains[0] ?? fail('bad_input', `${what} has no project.`, entry ? `Check the file${asPlanned ? '' : ' of that update'}.` : 'Pass project.');
  };
  // baseline_variance's as_planned is one schedule given beside the baseline options: it is not "Update 1" of "a series"
  const asPlanned = o.tool === 'baseline_variance', label = (i: number, name: string) => (asPlanned ? `The as_planned file ${name}` : `Update ${i + 1} (${name})`);
  const updates: Update[] = [];
  let curProj: Row | undefined;
  const current = () => (curProj ??= mainProj(s.db, 'This file', null));
  const releases: (() => void)[] = [];
  const release = () => { for (const r of releases) r(); };
  try {
    if (o.includeCurrent) current(); // (this project is in the series: a file with several projects is refused before the others are read)
    for (const [i, u] of (a.updates as Record<string, unknown>[]).entries()) {
      if (u?.handle) { const o = getSession(u.handle); updates.push({ name: String(u.name ?? o.path ?? u.handle), db: o.db, projId: mainProj(o.db, label(i, String(u.name ?? o.path ?? u.handle)), u, asPlanned).proj_id }); }
      else if (u?.path) { const p = pathArg(u.path); releases.push(reserveMemory(estimateBytes(sizeOf(p)), `Reading ${asPlanned ? 'the as_planned file' : `update ${i + 1}`} (${basename(p)}) for ${o.tool}`, asPlanned ? 'open the file with open_file and pass its handle when there is room' : 'open the updates with open_file and pass their handles when there is room')); let db: Db; try { db = detectFormat(p, headOf(p)) === 'xer' ? readXerFile(p).db : (() => { const b = new Uint8Array(readFileSync(p)); return readRaw(b, detectFormat(p, b)).db; })(); } catch (e) { if (e instanceof Error && /^E[A-Z]+$/.test(String((e as { code?: unknown }).code ?? ''))) return fail('file_unreadable', `Cannot read ${p}.`, 'Check the path.', { data: readCause(e) }); return fail('bad_input', `Cannot read ${asPlanned ? 'the as_planned file' : `update ${i + 1}`} (${basename(p)}): ${(e as Error).message}`, 'Give an XER, P6 XML or Microsoft Project XML (.xml) file, or open it with open_file and pass its handle.'); } updates.push({ name: String(u.name ?? p), db, projId: mainProj(db, label(i, basename(p)), u, asPlanned).proj_id }); }
      else if (u?.baseline) { const cur = current(), bl = baselineOf(s.db, cur, String(u.baseline) as 'project') ?? fail('bad_input', `The project has no ${u.baseline} baseline in this file.`, `Use project, bl1, bl2, bl3 or a saved baseline's name: ${savedBaselines(s.db, [cur.proj_id]).join(', ') || 'none saved'}.`); updates.push({ name: String(u.name ?? bl.name), db: s.db, projId: bl.projId }); }
      else if (u?.data_date && Array.isArray(u.progress)) {
        // built from the last update that is a schedule of its own (a stored baseline is a snapshot, not edited), else the current project
        const cur = current(), prev = [...updates].reverse().find((x) => x.db !== s.db || x.projId === cur.proj_id) ?? { name: 'current', db: s.db, projId: cur.proj_id };
        releases.push(reserveMemory(s.bytes, `Building update ${i + 1} (a copy of the project) for ${o.tool}`, 'pass fewer progress updates, or save them as files and open them'));
        const db = structuredClone(prev.db) as Db, dd = h.dd(u.data_date) ?? fail('bad_input', `updates[${i}].data_date is not a date.`, 'YYYY-MM-DD');
        const r = applyOps(db, u.progress, { hoursPerDay: s.hpd, calendarDays: true });
        if (!r.ok) fail('bad_input', `updates[${i}] operation ${r.error!.index + 1}: ${r.error!.message}`, '');
        if (!scheduleProjects(db, [prev.projId], { dataDate: dd }).ok) fail('schedule_failed', `updates[${i}] cannot be scheduled.`, '');
        updates.push({ name: String(u.name ?? `update at ${String(u.data_date)}`), db, projId: prev.projId });
      } else fail('bad_input', `updates[${i}] needs handle, path, baseline, or data_date with progress.`, '');
    }
    // the last state's name in the answer and the files (the platform names its progress-log states)
    if (o.includeCurrent) updates.push({ name: o.currentName != null ? String(o.currentName) : 'current', db: s.db, projId: current().proj_id, open: true });
    return { updates, release };
  } catch (e) { release(); throw e; }
}

/** updates must be a list with at least one update (every tool that takes a series refuses it the same way). */
export function requireUpdates(a: Record<string, any>): void {
  if (!Array.isArray(a.updates) || !a.updates.length) fail('bad_input', 'updates must list the other updates.', 'e.g. [{"path": "Update 1.xer"}, {"handle": "..."}] or [{"baseline": "project"}]');
}

export const ANALYSIS_TOOLS = (withHandle: (s: Record<string, unknown>) => Record<string, unknown>) => [
  { name: 'check_schedule', annotations: ro, description: `P6's Tools > Check Schedule Report: ${P6_CHECKS.length} checks with P6's own populations and default targets (${P6_CHECKS.map((c) => c.id).join(', ')}). Each check answers metric, threshold {op, value, source}, result pass|fail|not_assessed, numerator/denominator and the activities (or relationships) it found. What each counts, as a share of its population: logic (open activities that are not WBS summaries: no predecessor unless started or a start milestone, no successor unless a finish milestone); negative_lags, lags, long_lags (relationships not between two completed activities: lag below 0, above 0, above the limit); relationship_types (the share that is finish to start; must be above the target); hard_constraints, soft_constraints (open activities, no WBS summary or LOE; start constraints of started activities are not counted); large_float (total float above the limit), negative_float (below 0), large_durations (remaining duration above the limit) over the same population; invalid_progress_dates (activities whose actual or forecast dates contradict the data date); resource_cost (activities with no resource or expense; no milestones, WBS summaries or LOE); late_activities (open activities forecast to finish after their baseline finish, or not in the baseline); bei (baseline activities due before the data date that are complete, over those due). The limit for float, lag and duration is 44 days x the hours per day (44 x 8 = 352 h). Late activities and BEI need the project baseline. targets overrides a check's target (percent; ratio for bei).` + exportDoc('check_schedule', ['checks', 'failing_activities', 'projects']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, checks: { type: 'array', items: { type: 'string' } }, targets: { type: 'object' }, threshold_days: { type: 'number', description: 'long lag / large float / large duration limit in days (default 44)' }, path: reportPath } }) },
  { name: 'dcma_14', annotations: ro, description: `DCMA 14-Point Assessment (PAM 200.1): logic, leads, lags, relationship types, hard constraints, high float, negative float, high duration, invalid dates, resources, missed tasks, critical path test, CPLI, BEI. Tasks = incomplete activities that are not WBS summary, LOE or milestones; leads, lags and types count relationships (those of incomplete tasks); days are working days of each activity's calendar. What each counts: logic (tasks missing a predecessor or a successor; exempt lists Activity IDs left out); leads (lag below 0); lags (lag above 0); relationship_types (the share that is finish to start); hard_constraints (Start On, Finish On, Start On or Before, Finish On or Before, Mandatory Start, Mandatory Finish); high_float (total float above limit_days); negative_float; high_duration (baseline duration, else original, above limit_days); invalid_dates (an actual date after the data date, or an unfinished forecast date before it); resources (tasks with no resource or expense); missed_tasks (tasks baselined to finish by the data date that finish, actually or forecast, after their baseline finish); critical_path_test, cpli, bei as below. Each check answers metric, threshold {op, value, source}, result, numerator/denominator and the activities it found. profile: ${Object.entries(DCMA_PROFILES).map(([k, v]) => `${k} (${v.label})`).join(', ')}; thresholds overrides single checks. baseline: project (default), bl1, bl2, bl3 (missed tasks, BEI, high duration). The critical path test adds cpt_slip_days (600) to the earliest critical task (or cpt_activity) on a scratch copy and passes when the finish moves by exactly that. CPLI: against target_finish, else the project's Must Finish By (contract), else the baseline finish; the other is reported beside it; with neither it is not assessed. limit_days: 44 or "dynamic" (max(20, 10% of the project length)).` + exportDoc('dcma_14', ['checks', 'failing_activities']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, profile: { type: 'string' }, thresholds: { type: 'object' }, baseline: { type: 'string' }, status_date: { type: 'string' }, target_finish: { type: 'string' }, cpt_slip_days: { type: 'number' }, cpt_activity: { type: 'string' }, limit_days: {}, exempt: { type: 'array', items: { type: 'string' } }, path: reportPath } }) },
  { name: 'lint', annotations: ro, description: `Schedule lint: problems P6 schedules without complaint, each with the activities it hits and, where there is one, the fix as edit operations (pass them to edit). Checks: dangling_start (no FS/SS predecessor drives the start), dangling_finish (the finish drives no FS/FF successor), fs_overlap (leads that should be SS + lag, SS lags as long as the predecessor that are really FS, and "ladders" of look-alike activities chained FS that could overlap; ladder fixes carry saves_days, found by scheduling the fix on a scratch copy), empty_wbs, milestone_duration (milestones with a duration, zero-duration tasks), constraints (every type), loe_on_critical, lag_calendar. profile: platform adds White Hat IQ's graded network metrics with score and grade: ${['connectivity', 'start_anchored', 'serialization', 'criticality', 'single_file', 'longest_chain', 'non_fs_share', 'edges_per_activity', 'redundant_links', 'ss_abuse'].join(', ')}. Each check: band pass|warn|fail, severity, activities, fixes and applied (the thresholds it was judged by). thresholds overrides any of them per call (an organisation's own, e.g. from its wiki): ${Object.keys(DEFAULT_LINT_THRESHOLDS).join(', ')}, each as in the answer's thresholds (the platform's LintConfig names, camelCase or snake_case, are read too); the answer gives every threshold applied and which were overridden. simulate: false skips the days-saved runs: by default every critical ladder is simulated (one schedule of its fix on a scratch copy each, which a cancellation stops, and progress counts); with thresholds ladder.max_targets N, only the first N critical ladders, the largest by number of activities first, are simulated and listed.` + exportDoc('lint', ['checks', 'findings', 'fixes']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, profile: { type: 'string', description: 'p6 (default) or platform' }, checks: { type: 'array', items: { type: 'string' } }, thresholds: { type: 'object', description: 'overrides, e.g. {"criticality": {"pass": [0.1, 0.3]}, "ladder": {"min_group_size": 4}, "dangling_start": {"max": 2}, "fs_overlap": {"max_lead_days": 1}, "weights": {"criticality": 20}}' }, simulate: { type: 'boolean' }, path: reportPath } }) },
  { name: 'float_paths', annotations: writesFile, description: 'P6 multiple float paths (Schedule Options > Advanced): path 1 ends at the end activity (end_activity, default the open end with the latest finish) following the most critical links back (method free_float, the default: relationship free float, so path 1 is the longest path; total_float: relationship total float, then forward along the most critical successors, as Oracle describes); each next path is the unassigned chain with the most critical link into the paths found; each activity belongs to one path; completed work and activities not leading to the end activity get none. Answers paths [{path, float_days (the smallest total float of the path\u2019s activities, in days of each activity\u2019s calendar), activities [{id, name, order, total_float_days}]}], near_critical (incomplete activities with 0 < total float <= near_critical_days, default 10), and with between {from, to} the longest between.max (default 25) logic paths between two activities, longest first (each with its duration and lowest float; paths of equal duration are ordered by lowest float, on exact hours, a path with no float value last), and paths_total, every path there is between them (a decimal string when it is beyond 2^53); truncated is true when paths_total is more than the paths listed. A loop in the logic between the two activities is answered as an error naming the activities of one loop. write: true also fills the Float Path and Float Path Order columns (one undoable change); to have every F9 fill them, set_schedule_options float_paths: true.' + exportDoc('float_paths', ['paths', 'near_critical', 'between (empty without between)']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, count: { type: 'number', description: 'paths to calculate (default 10)' }, end_activity: { type: 'string' }, method: { type: 'string', description: 'free_float (default) or total_float' }, near_critical_days: { type: 'number' }, between: { type: 'object', description: '{from, to, max?}: max a positive whole number (default 25); memory decides: a max that does not fit is refused up front, saying how many paths fit (paths_total says how many there are)' }, write: { type: 'boolean' } } }) },
  { name: 'progress_curves', annotations: ro, description: 'S-curves as the P6 Activity Usage Profile/Spreadsheet: per week or month, planned value (baseline budget along the baseline dates; current budget and planned dates without a baseline), earned value and actual cost up to the data date (spread evenly from the actual start; stored financial periods from the XER, P6 Store Period Performance, take precedence), remaining along the remaining early and late dates, cumulative values, per-period and cumulative SPI and CPI; totals BAC, PV, EV, AC, ETC, EAC, VAC, SPI, CPI, TCPI at the data date. units: cost (default), hours (resource units) or duration (planned value = each activity\'s baseline duration, else planned duration, spread evenly over its baseline dates, else planned dates, on its own calendar; earned = that duration x its % complete, by its own percent complete type; actual = working time since its actual start; in working days; level of effort has none: the basis for a schedule with neither costs nor resource units, which has no planned value in cost or hours). CPI is null when no actual is recorded (never assumed 1). The totals also carry Earned Schedule (Lipke), worked out on the same planned-value curve: es = the time at which the cumulative planned value equals the earned value now (found in the period where the curve passes it and interpolated inside it), at = the actual time from the planned start to the data date, pd = the planned duration, spi_t = es / at (schedule performance in TIME), sv_t = es - at (negative = behind), all in the curve\'s period (weeks or months), and es_date, es_days, at_days, sv_t_days as a date and working days of the project calendar. Unlike cost-based SPI, which returns to 1 when everything has been earned, SPI(t) stays meaningful to the end of a project: a project finished late ends with spi_t = pd / at, below 1. They are null, with the reason in es_note, when the planned value is 0, the project has no data date, there are no planned dates, from/to cut the curve, or the data date is not after the planned start (never 1 by default). Projects with different data dates have no single date to measure at: when the projects in scope have different data dates the call is refused (naming each Project ID with its data date) and the next step is project: <ID>, one project at a time; projects that share one data date are one curve. On units: duration, basis_note says what bac, ac, ev, etc, eac, vac, cpi and tcpi mean there (sums of working days; cpi is the earned duration per working day spent).' + exportDoc('progress_curves', ['periods', 'totals']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, period: { type: 'string', description: 'week or month (default)' }, units: { type: 'string', description: 'cost (default), hours (resource units) or duration (planned durations: no costs or resources needed)' }, from: { type: 'string' }, to: { type: 'string' } } }) },
  { name: 'resource_histogram', annotations: ro, description: 'Resource Usage Profile per resource and period: budgeted (planned dates), actual, remaining early (with P6 resource curves) and remaining late units (hours; cost: true for cost), the limit (max units/time over working time), over-allocation and available units, the peak, and severity of over-allocation (minor, moderate at 1.5x the limit, critical at 2x). The answer is a summary: the 25 worst resources (by severity, then over-allocated periods, then resource ID; resources_order_note says so), each with its peak, limit, over-allocated periods, severity and periods_total (resources_total says how many resources there are, resources_note where all of them are); the per-period series of every resource is in the result file only (the table periods; periods_note names the file and its columns).' + exportDoc('resource_histogram', ['resources', 'periods (every resource)']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, resources: { type: 'array', items: { type: 'string' } }, period: { type: 'string', description: 'week (default) or month' }, cost: { type: 'boolean' }, threshold: { type: 'number', description: 'over-allocated when demand > limit x threshold (default 1)' } } }) },
  { name: 'evaluate_batch', annotations: ro, description: 'Many what-ifs in one call: the project is scheduled once as it is, then each scenario (a list of edit operations, as edit takes them) on a copy that is thrown away, so nothing changes. One row per scenario: ok or error, finish, finish_delta_days (working days on the project calendar; negative = earlier), critical count, became_critical and no_longer_critical, negative_float count, cost (at completion) and cost_delta; the best `top` (default 3; earliest finish, then cheapest) also list the activities whose dates moved (the first 200; changed_total says how many). best names the best scenario. Each scenario is kept as it finishes, in a file in the write root (evaluate_batch-<fingerprint>.parts/scenarios.ndjson). A batch that stops (cancelled, its worker ended, or a scenario that could not be kept) answers the rows done, marked partial, with resume: the path of that file; to continue, call evaluate_batch again with the same arguments and resume: that path, exactly as given (it is never searched for): only the scenarios still missing are scheduled, and best and the details of the best few are worked out over every scenario, so the answer is the one an uninterrupted batch gives (resumed_scenarios says how many came from the file; redone_scenarios how many kept ones did not check out, damaged as a power loss can leave a file or after a damaged one, and were done again). A resume whose project, scenarios or arguments differ is refused with resume_mismatch, removing nothing. A batch whose kept file another evaluate_batch call in this server is still working on (a cancelled job answers before it has stopped; the same project open under two handles) is refused as run_busy, naming that job when it is one. A call without resume starts over; a batch that finishes removes its file and names its folder in parts_removed (so a copy of it elsewhere can go too).' + exportDoc('evaluate_batch', ['scenarios', 'dates_moved (every scenario)']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, scenarios: { type: 'array', description: '[{name, overrides: [edit operations]}], any number', items: { type: 'object' } }, top: { type: 'number' }, resume: { type: 'string', description: 'the resume path a stopped evaluate_batch answered (its kept scenarios), to do only the scenarios still missing; same arguments as that call' } }, required: ['scenarios'] }) },
  { name: 'crash_schedule', annotations: writesFile, description: 'Least-cost crashing (Kelley-Walker): each step shortens the cheapest cut set, the activities that together shorten every path driving the finish at once (a shared activity competes with the sum of one activity per parallel path), by the smaller of their crash room, the float of the next near-critical path and what is still needed, then reschedules. Working days on the calendar of each activity; only remaining work is crashed; completed, milestones, LOE and locked activities are not. Crash data per activity: {id, min_days, cost_per_day} or {id, crash_days (remaining duration when fully crashed), crash_cost (extra cost to get there)}; without it every remaining activity may lose default_max_pct (30) % of its remaining duration at 1 per day. Goal: target_finish (date), target_days (working days to gain), or neither with indirect_cost_per_day / ld_per_day to stop at the least total cost. Answers stop SUCCESS | PLATEAU | EXHAUSTED | CAP | ALREADY_MET | CANCELLED with a note, every step {activities [{id, days, cost}], days_gained, cost, finish, cumulative_direct_cost, total_cost (direct less indirect and liquidated damages saved)}, the duration changes and the edit ops. apply: true makes the changes and reschedules (one undoable change), and in that same change writes beside each activity whose duration it changed the user-defined fields, there for P6\u2019s columns, by the same run rule as optimize_schedule apply (so the two can be applied to one project in any order): the run\u2019s duration becomes the activity\u2019s current one (for an activity under way, its remaining duration), and the number it replaces is kept in "WHIQ original duration (d)" when the activity has none yet (the original never changes once set), else in "WHIQ run <N> duration (d)", N being the run before this one; a project\u2019s first apply is run 1 and declares no numbered field, a later one (by crash_schedule or optimize_schedule) is run 2, 3 and so on and declares its run field whether or not any cell is filled; in a file with several projects the run number is the file\u2019s, so a project\u2019s run can skip numbers. "WHIQ duration change (d)" is the current duration minus the original, and "WHIQ change note" says what was crashed, from what to what, at what cost (the latest run\u2019s); an activity this run does not change moves nothing, and an activity under way keeps its change value until a run changes it. Crashing gives no leveling order, so the "WHIQ leveling rank" an earlier optimize_schedule run wrote stays as it is. fields_written lists each field with its activities and kept_from_earlier (how many activities still hold a value from an earlier run); a field of the project with one of these labels but another data type refuses the apply before anything changes (field_type_clash: rename or remove that field with edit, or apply the ops by edit without them). A call cancelled (notifications/cancelled, cancel_job) after its first step answers the steps done, with stop CANCELLED, partial: true and steps_done, their changes and ops, and says so in the note; it applies nothing even with apply: true (the ops are for edit). Progress counts the steps, with no total unless max_steps is given.' + exportDoc('crash_schedule', ['steps', 'step_activities', 'changes']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, target_finish: { type: 'string' }, target_days: { type: 'number' }, activities: { type: 'array', items: { type: 'object' } }, default_max_pct: { type: 'number' }, indirect_cost_per_day: { type: 'number' }, ld_per_day: { type: 'number' }, locked: { type: 'array', items: { type: 'string' } }, max_steps: { type: 'number', description: 'a whole number: stop after this many steps (stop CAP); without it the crashing runs to its natural end: the target reached, no path left to shorten (EXHAUSTED) or a plateau' }, apply: { type: 'boolean' }, field_data: { type: 'boolean', description: 'for the desktop screens: the answer also carries field_data, what an apply writes beside the changed activities' } } }) },
  { name: 'optimize_schedule', annotations: writesFile, description: 'The White Hat IQ schedule reasoner (a trained model, embedded; runs locally). It plans work that has not started. If any activity has an actual start or finish, a status other than not started, or percent complete above 0, or the data date is after the project\u2019s planned start, it is refused before anything runs (schedule_in_progress), with or without apply and for either objective. To shorten the remaining work of a schedule in progress use crash_schedule; to level resources use level_resources, which takes work in progress. It picks each activity’s mode (normal, or crashed when crash data is given) and a placement priority so the resource-limited schedule finishes soonest, in three parts, the best placement of all kept (shortest makespan, then lowest crash cost): (1) the starting placements: the model’s own answer, the four classic priority rules (LFT, MTS, GRPW, SPT) each with every activity in its normal mode and with every activity in its shortest mode, and the plain earliest-start order with no resource limit (nine placements; the trajectories count includes them); (2) `samples` trajectories sampled around the model’s answer (default 200, 64 above 120 activities; `seed` makes it repeatable); (3) with crash data, a final pass over the modes: for each activity that has crash data it tries the other mode with the best order and keeps a strict improvement, and repeats until a whole pass changes nothing (no limit on the passes; mode_trials and mode_passes say how much it did; a cancel stops it and the best so far is the answer, marked partial, nothing applied). Without crash data (activities: [{id, crash_days, crash_cost}]) no activity has a second mode, so it only chooses the best order, and `note` says so. best_from says what won: model, sampled, the rule with its modes, earliest start (no resource limit), or mode pass. Resources need a Max Units/Time limit to be leveled. A schedule of any size: past 512 activities the model reads it 512 at a time, in order of earliest start (model_windows says how many windows), and the placement is always of the whole schedule. over_limit_activities: activities that need more of a resource than its limit allows on any day (no order can level them: correct the limit or the assignment first). The proposal is checked with the P6 leveler: answers cpm_finish (no leveling), p6_leveled_finish (P6 default leveling), reasoner_finish (its modes and priority through the same leveler), better_than_p6_leveler, crash changes and cost, and the priority order (the first max_priority, default 100, 0 = all; priority_total says how many; each entry is the Activity ID, or {id, project} when the run covers more than one project, because an Activity ID can be in several), and biggest_changes: the activities whose dates differ between cpm and the reasoner, each {id, name, cpm_start, cpm_finish, reasoner_start, reasoner_finish, start_delta_days, finish_delta_days}, largest finish shift first then largest start shift (the first max_changes, default 25, 0 = all; biggest_changes_total says how many changed). After apply, review biggest_changes (before and after dates, largest first) and changes (the crashed durations) and judge whether they are realistic; undo takes the apply back. better_than_p6_leveler: false means P6\'s own leveling finishes sooner. What is guaranteed and what is measured: inside the search the proposal is never worse than the best of its starting placements (sgs_makespan_days, the reasoner\u2019s own placement), but reasoner_finish is measured by running the P6 leveler with the proposed order, a different scheduler, so it can finish later than that placement says and is not guaranteed to beat any starting placement. A call cancelled after the search keeps the proposal and answers it partial (stopped: cancelled), naming in partial_note what was not run (the comparison with P6\u2019s leveling, the leveling in the proposed order), whose fields are then absent; it applies nothing, even with apply: true (the ops are for edit). objective min_crash_cost runs crash_schedule instead (give target_finish or target_days). apply: true makes the crash changes, reschedules and levels in the proposed order, all in one undoable change (undo takes everything back, including a field the apply added). The numbers of the run become the activities\u2019 durations. The numbers they replace are kept in custom fields, there for P6\u2019s columns. The first apply on a project (it has no "WHIQ original duration (d)" field) keeps the old duration of each activity it changes in "WHIQ original duration (d)". A later apply is run 2, 3 and so on. It keeps the old duration of each activity it changes in "WHIQ run <N> duration (d)", N being the run before it, or in "WHIQ original duration (d)" for an activity changed for the first time. The original never changes once set. The run field is added even when no activity has a value in it. An activity a run does not change moves nothing: its cell stays empty, and it keeps its duration and its note. "WHIQ duration change (d)" is the current duration minus the original, on every activity that has an original. "WHIQ change note" is the latest run\u2019s. "WHIQ leveling rank" is the place in the order the leveler was given (1 = placed first); a rank the latest run does not give is removed. A project that already has these fields from an earlier apply (by optimize_schedule or crash_schedule, which share this rule) simply continues: its next apply is run 2. In a file with several projects the run number is the file\u2019s, so a project\u2019s run can skip numbers, and "WHIQ run N duration (d)" holds the duration an activity had before the file\u2019s run N+1 was applied to it; a project with saved baselines is one project. fields_written lists each field with its activities and kept_from_earlier (values still held from earlier runs). A field of the project with one of these labels but another data type refuses the apply before anything changes (field_type_clash: rename or remove that field with edit, or apply the ops by edit without them). Like P6 leveling, the next F9 without leveling drops the leveled dates.' + exportDoc('optimize_schedule', ['activities (CPM, P6-leveled and reasoner start and finish of every activity, and the reasoner\u2019s shift in working days)', 'priority (the whole order)', 'changes', 'biggest_changes (every activity that changed)']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, max_changes: { type: 'number', description: 'activities listed in biggest_changes (default 25; 0 = all)' }, max_priority: { type: 'number', description: 'activities listed in priority, the placement order (default 100; 0 = all; priority_total says how many there are)' }, objective: { type: 'string', description: 'makespan (default) or min_crash_cost' }, samples: { type: 'number' }, seed: { type: 'number' }, activities: { type: 'array', description: 'crash data [{id, crash_days, crash_cost} | {id, min_days, cost_per_day}]', items: { type: 'object' } }, target_finish: { type: 'string' }, target_days: { type: 'number' }, apply: { type: 'boolean' }, field_data: { type: 'boolean', description: 'for the desktop screens: the answer also carries field_data, what an apply writes beside the changed activities (the screen applies it as apply: true does)' } } }) },
  { name: 'windows_analysis', annotations: ro, description: 'Windows delay analysis (AACE 29R-03 MIP 3.3 contemporaneous; method half_step = MIP 3.4): every update, this handle included unless include_current is false, is put in data-date order (this handle is the last only when its data date is the latest) and each window compares one update with the next: finish before and after and the slip in working days (on the first update\u2019s project calendar, so windows add up to total_slip_days), the driving path at the window\u2019s start, the activities on it that lost time, each with its causes, named by this rule: duration revised (the target duration changed and the activity is not finished), logic revised (its predecessors changed), started late (not started at the earlier update, planned to start before the later data date, and started after that plan or still not started), deleted (not in the later update); where none of these applies and the finish still moved, progressed slower than planned when the activity was under way and its remaining duration fell by less than the working time between the data dates, else "no single cause identified" (its duration, logic and start are unchanged). Activities added are listed. half_step re-runs the earlier update with only the later one\u2019s progress at its data date and splits the slip into progress_days and revision_days. Activities match by Activity ID, then by a unique name. updates: [{handle} | {path} | {baseline: project|bl1|bl2|bl3|<saved baseline name>} | {data_date, progress: [edit ops]} (the previous update, or the current project after a stored baseline, with this progress, scheduled at data_date)]. milestone measures a key milestone instead of completion. A file with several projects needs project (the open file\u2019s project); a {handle} or {path} update with several projects takes project in its own entry, {path | handle, project}, else it is refused naming that file\u2019s Project IDs.' + exportDoc('windows_analysis', ['windows', 'driving_path', 'lost_time', 'added']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, updates: { type: 'array', items: { type: 'object' }, description: 'the other updates; a {handle} or {path} update with several projects takes project (its Project ID)' }, include_current: { type: 'boolean' }, current_name: { type: 'string', description: 'the name this handle\u2019s state is given as the last update (default "current")' }, method: { type: 'string', description: 'contemporaneous (default) or half_step' }, milestone: { type: 'string' }}, required: ['updates'] }) },
  { name: 'tia', annotations: writesFile, description: 'Time impact analysis (AACE 52R-06): the fragnet (edit ops: add_activity, add_relationship, update_activity\u2026) is inserted in a copy of the project and both are scheduled at the same data date (data_date, default the project\u2019s). Answers unimpacted_finish, impacted_finish, delay_days (working days, project calendar), fragnet_on_critical_path, fragnet_path (the fragnet activities and what they drive to the finish), became_critical / no_longer_critical; baseline (project, bl1-bl3 or the name of any saved baseline) adds the impacted variance to that baseline\u2019s finish. milestone measures a key milestone. The project is unchanged unless keep: true, which adds the impacted schedule as a new project copy (<Project ID>-TIA, one undoable change).' + exportDoc('tia', ['summary', 'fragnet_path', 'critical_changes']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, fragnet: { type: 'array', items: { type: 'object' } }, data_date: { type: 'string' }, milestone: { type: 'string' }, baseline: { type: 'string' }, keep: { type: 'boolean' } }, required: ['fragnet'] }) },
];

export const ANALYSIS_NAMES = new Set(['check_schedule', 'dcma_14', 'lint', 'float_paths', 'progress_curves', 'resource_histogram', 'evaluate_batch', 'crash_schedule', 'optimize_schedule', 'windows_analysis', 'tia']);

/** Run an analysis tool; undefined when the name is not one of them. */
export async function runAnalysis(name: string, a: Record<string, any>, s: Session, h: AnalysisHelpers, asTool?: string): Promise<unknown> {
  if (!ANALYSIS_NAMES.has(name)) return undefined;
  const projIds = a.project != null && a.project !== '' ? h.projectIds(s.db, a.project) : h.allIds(s.db);
  const exported = resultExporter(name, a, h, asTool);
  const withReport = <T extends { report: string; checks: unknown[]; summary: Record<string, number> }>(r: T, forReport: unknown = r) => {
    if (!a.path) return r;
    const path = pathArg(a.path, 'path', 'write');
    h.writeOut(path, analysisReportHtml(forReport as never, nowStamp()));
    return { ...r, saved: path };
  };
  /** A report of checks, worked out with every activity listed: the answer lists LISTED (25) of them per check (total_activities
   *  says how many there are) and is the one the HTML report shows; the export has them all. */
  const checked = <C extends CheckResult & { fixes?: unknown[] }, T extends { report: string; checks: C[]; summary: Record<string, number> }>(full: T, columns: string[], found: string, extra: Table[] = [], cut: (c: C, max: number) => C = (c, max) => ({ ...c, activities: firstOf(c.activities, max) })) => {
    // (the desktop screens, config.screens, which only the app's own process sets, list everything: 0 = all)
    const max = config.screens ? 0 : LISTED;
    // (a check's note is its not-assessed reason, said once in `notes`; the desktop screens and the HTML report show it beside the check)
    const cutChecks = full.checks.map((c) => cut(c, max));
    const answer = withReport({ ...full, checks: config.screens ? cutChecks : cutChecks.map((x) => { const { note: _n, ...rest } = x as typeof x & { note?: string }; return rest as typeof x; }) }, { ...full, checks: cutChecks });
    return exported(answer, full, [
      { name: 'checks', columns, rows: full.checks.map(({ activities: _a, fixes: _f, ...c }) => (c.threshold == null ? (({ threshold: _t, ...x }) => x)(c) : c)) },
      { name: found, columns: ['check', 'id', 'name', 'project', 'value'], rows: full.checks.flatMap((c) => c.activities.map((x) => ({ check: c.id, ...x }))) },
      ...extra,
    ]);
  };
  const fieldClash = (db: Db, o: { changes: unknown[]; ranks?: unknown[]; projIds?: string[] }, more = '') => { const c = whiqFieldClash(db, o); if (c) fail('field_type_clash', c.message, c.hint + more); };
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
      const maxPaths = a.between != null ? betweenMax(a.between) : undefined; // refused, before any work, when it is not a positive whole number
      const opts = { count: countArg(a.count, 'count') ?? 10, endActivity: a.end_activity, method: method as 'free_float' | 'total_float' };
      const r = computeFloatPaths(s.db, projIds, opts);
      if (a.write) h.apply('Float paths', (d) => writeFloatPaths(d, projIds, computeFloatPaths(d, projIds, opts).assign));
      const nearDays = a.near_critical_days != null ? Number(a.near_critical_days) : 10;
      const tasks = (s.db.tables.TASK?.rows ?? []).filter((t) => projIds.includes(t.proj_id) && !t.act_end_date && t.task_type !== 'TT_WBS' && t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null);
      const near = tasks.map((t) => ({ t, d: Number(t.total_float_hr_cnt) / s.hpd })).filter((x) => x.d > 0 && x.d <= nearDays).sort((x, y) => x.d - y.d).map((x) => ({ id: x.t.task_code, name: x.t.task_name, total_float_days: Math.round(x.d * 10) / 10 }));
      // float in days of each activity's own calendar, like every other answer (the core result keeps hours for the desktop panel that reads them)
      const dhx = dayHours(s.db, s.hpd, true), byCode = new Map((s.db.tables.TASK?.rows ?? []).filter((t) => projIds.includes(t.proj_id)).map((t) => [t.task_code, t]));
      const inDays = (id: string, h: number | null) => (h == null ? null : Math.round((h / dhx.task(byCode.get(id))) * 100) / 100);
      const pathsDays = r.paths.map((p) => { const acts = p.activities.map((x) => ({ id: x.id, name: x.name, order: x.order, total_float_days: inDays(x.id, x.total_float_hours) })); const fl = acts.map((x) => x.total_float_days).filter((x): x is number => x != null); return { path: p.path, float_days: fl.length ? Math.min(...fl) : null, activities: acts }; });
      const answer = { end: r.end, method: r.method, paths: pathsDays, near_critical: near, ...(a.between != null ? { between: betweenOrFail(pathsBetween(s.db, projIds, { ...a.between, max: maxPaths }, s.hpd)) } : {}), ...(a.write ? { written: true } : {}) };
      return exported(answer, answer, [
        { name: 'paths', columns: ['path', 'float_days', 'order', 'id', 'name', 'total_float_days'], rows: pathsDays.flatMap((p) => p.activities.map((x) => ({ path: p.path, float_days: p.float_days, ...x }))) },
        { name: 'near_critical', columns: ['id', 'name', 'total_float_days'], rows: near },
        { name: 'between', columns: ['path', 'duration_days', 'min_float_days', 'activities'], rows: (answer.between?.paths ?? []).map((p, i) => ({ path: i + 1, ...p })) },
      ], !!a.write);
    }
    case 'progress_curves': {
      const period = a.period ?? 'month', units = a.units ?? 'cost';
      if (period !== 'week' && period !== 'month') fail('bad_input', 'period must be week or month.', 'Use week or month.');
      if (units !== 'cost' && units !== 'hours' && units !== 'duration') fail('bad_input', 'units must be cost, hours or duration.', 'Use cost, hours or duration (duration needs neither costs nor resource units).');
      let r: ReturnType<typeof progressCurves>;
      try { r = progressCurves(s.db, projIds, { period, units, from: h.dd(a.from) ?? undefined, to: h.dd(a.to) ?? undefined }); } catch (e) { if (e instanceof CurvesRefused) return fail('bad_input', e.message, e.next); throw e; }
      return exported(r, r, [
        { name: 'periods', columns: ['start', 'end', 'pv', 'ev', 'ac', 'remaining_early', 'remaining_late', 'cum_pv', 'cum_ev', 'cum_ac', 'cum_forecast_early', 'cum_forecast_late', 'spi', 'cpi', 'cum_spi', 'cum_cpi'], rows: r.periods },
        { name: 'totals', columns: ['units', 'data_date', 'bac', 'pv', 'ev', 'ac', 'etc', 'eac', 'vac', 'spi', 'cpi', 'tcpi', 'es', 'at', 'pd', 'spi_t', 'sv_t', 'es_date', 'es_days', 'at_days', 'sv_t_days', 'es_note'], rows: [{ units: r.units, data_date: r.data_date, ...r.totals }] },
      ]);
    }
    case 'resource_histogram': {
      const period = a.period ?? 'week';
      if (period !== 'week' && period !== 'month') fail('bad_input', 'period must be week or month.', 'Use week or month.');
      const r = resourceHistograms(s.db, projIds, { resources: a.resources, period, cost: a.cost === true, threshold: a.threshold != null ? Number(a.threshold) : undefined });
      if (a.resources?.length && !r.resources.length) fail('bad_input', `No assignments for ${a.resources.join(', ')}.`, 'Use resource IDs that are assigned in this project (list_dictionaries or resource_summary).');
      // the export: every resource with its periods
      const PERIOD_COLUMNS = ['resource', 'start', 'end', 'budgeted', 'actual', 'remaining_early', 'remaining_late', 'limit', 'over_allocated', 'available'];
      const out = <T extends object>(answer: T) => exported(answer, r, [
        { name: 'resources', columns: ['resource', 'name', 'units', 'peak_start', 'peak_demand', 'peak_limit', 'over_allocated_periods', 'severity', 'periods_total'], rows: r.resources.map(({ periods: _p, ...x }) => x) },
        { name: 'periods', columns: PERIOD_COLUMNS, rows: r.resources.flatMap((x) => x.periods.map((p) => ({ resource: x.resource, ...p }))) },
      ]);
      // large by nature (resources x periods): the answer lists the LISTED most over-allocated resources with their summary figures (resources_total says how many there are);
      // the per-period series of EVERY resource is in the result file only (the notes say so). The order: severity first, then over-allocated periods, then resource ID.
      const SEVERITY_RANK = { critical: 3, moderate: 2, minor: 1, none: 0 } as const;
      const rank = [...r.resources].sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] || y.over_allocated_periods - x.over_allocated_periods || (x.resource < y.resource ? -1 : x.resource > y.resource ? 1 : 0));
      const unlimited = r.resources.filter((x) => !x.limit_set).map((x) => x.resource).sort();
      const notes: string[] = [...(unlimited.length ? [noLimitNote(unlimited)] : [])];
      const done = out({ report: r.report, period: r.period, resources: rank.slice(0, LISTED).map(({ periods: _p, ...x }) => x), resources_total: r.resources.length }) as { exported?: { files: { path: string }[]; error?: string } };
      const file = done.exported?.files.find((f) => f.path.endsWith('-periods.csv'))?.path;
      if (!r.resources.length) return { ...done, notes: [`No resource is assigned in ${projIds.length === 1 ? 'the open project' : 'the open projects'}: there is nothing to chart.`] };
      notes.push(file ? `Per-period figures not shown; all ${r.resources.length} ${r.resources.length === 1 ? 'resource' : 'resources'} in ${file}.` : `Per-period figures not shown, and the file that holds them could not be written; call again with export set to a folder inside the write root.`);
      return { ...done, notes };
    }
    case 'evaluate_batch': {
      if (!Array.isArray(a.scenarios) || !a.scenarios.length) fail('bad_input', 'scenarios must be a non-empty list.', 'e.g. [{"name": "A shorter", "overrides": [{"op": "update_activity", "id": "A1000", "duration_days": 5}]}]');
      // a scenario is {name, overrides: [edit operations]}: anything else would run as "no change" and answer ok, so it is refused, naming the scenario
      // (an empty overrides list is the scenario "as it stands" and stays allowed)
      a.scenarios.forEach((x: unknown, i: number) => {
        if (x && typeof x === 'object' && !Array.isArray(x) && Array.isArray((x as { overrides?: unknown }).overrides)) return;
        const got = Array.isArray(x) ? 'a bare list' : x && typeof x === 'object' ? `an object with the keys ${Object.keys(x).map((k) => `"${k}"`).join(', ') || '(none)'}, ${'overrides' in x ? '"overrides" is not a list' : 'no "overrides" list'}` : `${x === null ? 'null' : typeof x} ${JSON.stringify(x)}`;
        fail('bad_input', `scenarios[${i}] (scenario ${i + 1}) is not a scenario: received ${got}. A scenario is an object {"name": "...", "overrides": [edit operations]}.`, 'e.g. [{"name": "A shorter", "overrides": [{"op": "update_activity", "id": "A1000", "duration_days": 5}]}]. An empty overrides list is the project as it stands. Nothing was run.');
      });
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
        r = await evaluateBatch(s.db, projIds, a.scenarios.map((x: any, i: number) => ({ name: String(x?.name ?? `scenario ${i + 1}`), overrides: x.overrides })), { hoursPerDay: s.hpd, top: a.top != null ? Number(a.top) : undefined, tick: h.tick, onRow: h.keep, store: batchStore });
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
          ], h.writeOutWith, exportOf(a, { partial: r.partial === true }));
        }
      } finally { if (finishAsked) finished = store.finish(); store.release(); }
      if (!r.ok) return fail(r.error.code, r.error.message, 'Fix the schedule errors first (schedule shows them).');
      const { kept, resumed, redone, ...rest } = r;
      const keptNote = rest.keptNote ?? finished;
      delete rest.keptNote;
      const answer = { ...rest, ...(kept ? { resume: kept, note: rest.error ? `Stopped after ${rest.scenarios_done} of ${rest.scenarios_requested} scenarios (${String(rest.error).replace(/\.$/, '')}): the result covers those only.` : cancelledAfter(rest.scenarios_done as number, rest.scenarios_requested as number, 'scenarios', false) } : {}), ...(resumed ? { resumed_scenarios: resumed } : {}),
        // kept scenarios that did not check out (a power loss can leave zeros or old bytes), with every one after them: done again, said
        ...(redone ? { redone_scenarios: redone } : {}), ...(redone || keptNote ? { notes: [...(redone ? [`${redone} kept scenario${redone === 1 ? '' : 's'} did not check out (damaged) and ${redone === 1 ? 'was' : 'were'} run again.`] : []), ...(keptNote ? [keptNote] : [])] } : {}),
        // a finished batch removed its kept file: named, so a copy of it elsewhere (the platform's mirror of the outputs) goes too
        ...(!rest.partial && !keptNote && store.path ? { parts_removed: keptPlace(store.path) } : {}) };
      return files ? { ...answer, exported: files } : answer;
    }
    case 'crash_schedule': {
      // (an LOB plan's activities are locked: crashOptionsOf, as the Crashing panel calls it)
      const run = await crashSchedule(s.db, projIds, { ...crashOptionsOf(s.db, a, s.hpd), maxSteps: countArg(a.max_steps, 'max_steps'), tick: h.tick });
      if (!run.ok) return fail(run.error.code, run.error.message, run.error.code === 'bad_input' ? 'e.g. {"target_days": 10} or {"target_finish": "2026-12-31"}' : 'Fix the schedule errors first (schedule shows them).');
      const { field_changes: fieldChanges, ...runAnswer } = run; // (for the fields an apply writes: not part of the answer)
      let r = runAnswer;
      // one checkpoint just before the change is made: a cancel that came after the last step still cancels the call, and a cancelled call never changes the project
      if (a.apply && r.stop !== 'CANCELLED' && r.ops.length) {
        try { await h.tick(r.steps.length, 0, `${r.steps.length} steps done; making the changes`); }
        catch (e) { if ((e as { code?: unknown })?.code !== 'cancelled') throw e; r = { ...r, stop: 'CANCELLED', partial: true, stopped: 'cancelled', steps_done: r.steps.length, notes: [...r.notes, cancelledAfter(r.steps.length, null, r.steps.length === 1 ? 'step' : 'steps', false)] }; }
      }
      // a run that was cancelled changes nothing, apply or not: its steps are the answer, with the edit operations to apply by edit
      const cancelled = r.stop === 'CANCELLED', apply = !!a.apply && !cancelled;
      // a field of the project with one of the WHIQ labels and another data type would fail the apply half way: refused first, nothing changed
      if (apply && r.ops.length) fieldClash(s.db, { changes: fieldChanges, projIds });
      // the same undoable change writes beside each activity it changed what it did (WHIQ fields: P6 columns), by the one run rule (whiq-fields.ts); crashing gives no ranks
      const crashFieldData: FieldData = { changes: fieldChanges, who: 'Crashed (least cost)' };
      let fields: { name: string; activities: number; kept_from_earlier: number }[] = [];
      if (apply && r.ops.length) h.apply('Crash schedule', (d) => {
        const x = applyOps(d, r.ops, { hoursPerDay: s.hpd, calendarDays: true }); if (!x.ok) fail('bad_input', x.error!.message, '');
        fields = writeWhiqFields(d, crashFieldData, { hoursPerDay: s.hpd, calendarDays: true, projIds }); reschedule(d, projIds);
      });
      // field_data: true (the desktop screens): what an apply needs to write the same fields (writeWhiqFields), for a run that can be applied
      const answer = { ...r, ...(a.field_data === true && !cancelled ? { field_data: crashFieldData } : {}), ...(a.apply ? { applied: apply && r.ops.length > 0 } : {}), ...(fields.length ? { fields_written: fields } : {}), ...(cancelled && a.apply ? { notes: [...r.notes, 'Not applied: a cancelled run changes nothing in the project; the ops are the changes of the steps done.'] } : {}) };
      return exported(answer, answer, [
        { name: 'steps', columns: ['step', 'days_gained', 'cost', 'finish', 'cumulative_direct_cost', 'total_cost', 'activities'], rows: r.steps.map((x) => ({ ...x, activities: x.activities.map((y) => y.id) })) },
        { name: 'step_activities', columns: ['step', 'id', 'days', 'cost'], rows: r.steps.flatMap((x) => x.activities.map((y) => ({ step: x.step, ...y }))) },
        { name: 'changes', columns: ['id', 'remaining_days_from', 'remaining_days_to'], rows: r.changes },
      ], !!(apply && r.ops.length));
    }
    case 'optimize_schedule': {
      const objective = a.objective ?? 'makespan';
      if (objective !== 'makespan' && objective !== 'min_crash_cost') fail('bad_input', `Unknown objective "${objective}".`, 'Use makespan or min_crash_cost.');
      const maxChanges = countArg(a.max_changes, 'max_changes') ?? 25; // 0 = all; refused here, before the reasoner runs
      const maxPriority = countArg(a.max_priority, 'max_priority'); // the same: 0 = all, absent = 100 (hrm.ts)
      // the reasoner plans work that has not started only: a schedule in progress is refused here, before anything runs (either objective, with or without apply)
      const inProgress = reasonerRefusal(s.db, projIds);
      if (inProgress) fail(inProgress.code, inProgress.message, inProgress.hint);
      if (objective === 'min_crash_cost') return runAnalysis('crash_schedule', a, s, h, 'optimize_schedule').then((r) => ({ objective, ...(r as object) }));
      const samples = countArg(a.samples, 'samples'); // only where it is used: min_crash_cost (above) does not sample
      const ops = (d: Db, list: unknown[]) => { const x = applyOps(d, list, { hoursPerDay: s.hpd, calendarDays: true }); if (!x.ok) fail('bad_input', x.error!.message, ''); };
      let r;
      try { r = await optimizeSchedule(s.db, projIds, { samples, seed: a.seed != null ? Number(a.seed) : undefined, activities: a.activities, hoursPerDay: s.hpd, tick: h.tick, maxPriority }, nodeInfer, ops); }
      catch (e) { if (e instanceof ReasonerUnavailable) return fail('reasoner_unavailable', e.message, 'Use level_resources (P6 leveling) or crash_schedule meanwhile.'); throw e; }
      if (!r.ok) return fail(r.error.code, r.error.message, r.error.code === 'reasoner_failed' ? 'Use level_resources (P6 leveling) or crash_schedule meanwhile.' : 'Give resources a Max Units/Time limit (add_resource max_units_per_hour) or pass crash data in activities.');
      const { order, dates, biggest_changes, priority_rows: priorityRows, field_changes: fieldChanges, field_ranks: fieldRanks, ...answer } = r;
      // a cancelled run changes nothing, apply or not (as crash_schedule): the proposal is the answer, with the edit operations to apply by edit
      let stopped = r.partial === true, lateCancel: { partial: true; stopped: 'cancelled'; late: true } | undefined;
      // one checkpoint just before the change is made (as crash_schedule): a cancel that came after the last tick still cancels the call,
      // and a cancelled call never changes the project
      if (a.apply && !stopped) {
        try { await h.tick(1, 1, 'the proposal is made; making the changes'); }
        catch (e) { if ((e as { code?: unknown })?.code !== 'cancelled') throw e; stopped = true; lateCancel = { partial: true, stopped: 'cancelled', late: true }; }
      }
      // (a field of the project with a WHIQ label and another data type would fail the apply half way: refused first, nothing changed)
      if (a.apply && !stopped) fieldClash(s.db, { changes: fieldChanges, ranks: fieldRanks, projIds }, ' (ops hold the crash changes only, not the leveling in the proposed order)');
      const optimizeFieldData: FieldData = { changes: fieldChanges, ranks: fieldRanks, who: 'Crashed by the schedule reasoner' };
      let fields: { name: string; activities: number; kept_from_earlier: number }[] = [];
      if (a.apply && !stopped) h.apply('Optimize schedule (reasoner)', (d) => {
        ops(d, r.ops);
        // beside each activity: what the run changed and the order the leveler is given (WHIQ fields: P6 columns), in this same change
        fields = writeWhiqFields(d, optimizeFieldData, { hoursPerDay: s.hpd, calendarDays: true, projIds });
        reschedule(d, projIds); if (r.leveled_activities) { levelResources(d, projIds, { first: order }); syncAssignmentDates(d); }
      });
      const out = { objective, ...answer, ...(lateCancel ? { partial: true, stopped: 'cancelled', notes: [...((answer as { notes?: string[] }).notes ?? []), 'Cancelled after the leveling in the proposed order, before the changes were made: nothing was applied.'] } : {}), ...(a.field_data === true && !stopped ? { field_data: optimizeFieldData } : {}), ...(biggest_changes ? { biggest_changes: firstOf(biggest_changes, maxChanges) } : {}), ...(a.apply ? { applied: !stopped } : {}), ...(fields.length ? { fields_written: fields } : {}) };
      if (a.export == null) return out;
      // the export: the whole placement order, and every activity's dates under CPM, P6's leveling and the reasoner's proposal
      const iso = (v: number | null) => (v != null ? formatP6Date(v) : null);
      const priority = priorityRows.map((x, i) => ({ rank: i + 1, ...x }));
      const activities = dates.map((x) => ({ id: x.code, name: x.name, cpm_start: iso(x.cpm[0]), cpm_finish: iso(x.cpm[1]), p6_leveled_start: iso(x.p6[0]), p6_leveled_finish: iso(x.p6[1]), reasoner_start: iso(x.reasoner[0]), reasoner_finish: iso(x.reasoner[1]), start_delta_days: x.startDeltaDays, finish_delta_days: x.finishDeltaDays }));
      return exported(out, { ...out, ...(biggest_changes ? { biggest_changes } : {}), priority: priority.map((x) => ('project' in x ? { id: x.id, project: x.project } : x.id)), activity_dates: activities }, [
        { name: 'activities', columns: ['id', 'name', 'cpm_start', 'cpm_finish', 'p6_leveled_start', 'p6_leveled_finish', 'reasoner_start', 'reasoner_finish', 'start_delta_days', 'finish_delta_days'], rows: activities },
        { name: 'priority', columns: ['rank', 'id', ...(projIds.length > 1 ? ['project'] : []), 'name'], rows: priority },
        { name: 'changes', columns: ['id', 'from_days', 'to_days', 'cost'], rows: r.changes },
        { name: 'biggest_changes', columns: ['id', 'name', 'cpm_start', 'cpm_finish', 'reasoner_start', 'reasoner_finish', 'start_delta_days', 'finish_delta_days'], rows: biggest_changes ?? [] },
      ], !!a.apply);
    }
    case 'windows_analysis': {
      requireUpdates(a);
      if (a.method != null && a.method !== 'contemporaneous' && a.method !== 'half_step') fail('bad_input', `Unknown method "${a.method}".`, 'Use contemporaneous or half_step.');
      const { updates, release } = loadUpdates(a, s, h, { tool: 'windows_analysis', includeCurrent: a.include_current !== false, currentName: a.current_name });
      try {
      // worked out with every activity listed: the answer lists 25 of them per window (LISTED), the export all
      const r = await windowsAnalysis(updates, { milestone: a.milestone, method: a.method, hoursPerDay: s.hpd, maxIds: 0, tick: h.tick });
      if (!r.ok) return fail(r.error.code, r.error.message, 'Check the milestone and the updates.');
      const W = r.windows as (Record<string, unknown> & { window: number; driving_path: string[]; lost_time: Record<string, unknown>[]; added: string[] })[];
      return exported({ ...r, windows: W.map((w) => cutWindow(w, LISTED)) }, r, [
        { name: 'windows', columns: ['window', 'from', 'to', 'data_date_from', 'data_date_to', 'finish_from', 'finish_to', 'slip_days', 'driving_path_total', 'lost_time_total', 'added_total', 'half_step_finish', 'half_step_progress_days', 'half_step_revision_days'], rows: W.map(({ driving_path: _d, lost_time: _l, added: _a, ...w }) => w) },
        { name: 'driving_path', columns: ['window', 'order', 'id'], rows: W.flatMap((w) => w.driving_path.map((id, i) => ({ window: w.window, order: i + 1, id }))) },
        { name: 'lost_time', columns: ['window', 'id', 'name', 'now', 'lost_days', 'finish_from', 'finish_to', 'causes'], rows: W.flatMap((w) => w.lost_time.map((x) => ({ window: w.window, ...x }))) },
        { name: 'added', columns: ['window', 'id'], rows: W.flatMap((w) => w.added.map((id) => ({ window: w.window, id }))) },
      ]);
      } finally { release(); }
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
      const r = await lintScheduleTicked(s.db, { projIds, hoursPerDay: s.hpd, profile: a.profile, checks: a.checks, simulate: a.simulate !== false, maxIds: 0, thresholds: a.thresholds }, h.tick);
      return checked(r as typeof r & { summary: Record<string, number> }, ['id', 'name', 'severity', 'band', 'result', 'metric', 'unit', 'numerator', 'denominator', 'total_activities', 'weight', 'note'], 'findings',
        [{ name: 'fixes', columns: ['check', 'activities', 'fix', 'saves_days', 'ops'], rows: r.checks.flatMap((c) => (c.fixes ?? []).map((f) => ({ check: c.id, ...f }))) }], cutLintCheck);
    }
  }
  return undefined;
}

