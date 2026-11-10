#!/usr/bin/env node
// P6 Clone MCP server: a headless Primavera P6 for AI agents, shared by many agents without dead stops.
// Projects stay open in memory between calls, every change is undoable (per caller), nothing reaches disk until
// `save`, and every failure comes back with a code and a next step. Same engine as the desktop app and the CLI.
//   stdio (one agent):  node mcp/server.ts            (or the bundled dist-cli/p6clone-mcp.cjs)
//   HTTP (many agents): node mcp/server.ts --http --root <storage dir> [--port 8765] [--host 127.0.0.1] [--token T]
//   Either: [--automation-read-root DIR] [--automation-write-root DIR] fence reads and writes like the craft forks.
//   On stdin EOF, SIGTERM or SIGINT every project with unsaved changes is saved as <name>.recovered-<stamp>.xer in the
//   write root (else the storage root, else the project's folder) before the process exits.
//   Environment: P6CLONE_ROOT, P6CLONE_TOKEN, P6CLONE_PORT, P6CLONE_MAX_HANDLES, P6CLONE_MEM_BUDGET_MB,
//   P6CLONE_IDLE_MINUTES. Run Node with --max-old-space-size above the memory budget for very large files.
import { minOf } from '../core/arrays.ts';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isMainThread, workerData } from 'node:worker_threads';
import { p6Refusals } from '../core/project/integrity.ts';
import { ensureCwd, safeCwd } from '../core/cwd.ts';
import { RUN_HERE, answerReasoner, offload, reasonerState, startComputeWorker } from './compute.ts';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectFormat, exportFile, importChecks, readRaw, type Format } from '../renderer/io.ts';
import { NEW_XER_NOTE, NEW_XER_VERSION, writeXer, writeXerTo } from '../core/xer/write.ts';
import { detectEncoding, type TextEncodingName } from '../core/encoding.ts';
import { repairKeys } from '../core/xer/repair.ts';
import { REFUSED_ACTUALS, repairToValid, unidentified } from '../core/xer/repair-valid.ts';
import { mspDateChanges, mspUntouched } from '../core/msp/keep.ts';
import { p6xmlLossNotes, p6xmlLosses, writeP6Xml, writeP6XmlTo } from '../core/xml/p6xml.ts';
import { writeMspdiTo } from '../core/msp/mspdi.ts';
import { monteCarloCounts, readPeak, workNeed } from './workset.ts';
import { readXerFile } from '../core/xer/parseFile.ts';
import type { ParseMeta } from '../core/xer/parse.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';
import { updateProgress } from '../core/progress/update.ts';
import { transferProgress, PARTS, type MatchBy, type TransferSpec } from '../core/progress/transfer.ts';
import { importIntoDb, REMOVABLE, type ImportPlan, type ProjectAction } from '../core/xer/import.ts';
import { levelResources } from '../core/level/level.ts';
import { applyOps, expandSelects, OP_GUIDE } from '../core/project/ops.ts';
import { makeCtx } from '../core/project/ctx.ts';
import { TOOLS as LOOKUPS, runTool } from '../core/query/tools.ts';
import { listTables, projectFilter, readTable } from '../core/query/rawtable.ts';
import { mppToMspdi, MppReaderMissing } from '../core/msp/mpp.ts';
import { StuckError, watchReport } from '../core/bim/liveness.ts';
import { parseMspdi } from '../core/msp/mspdi.ts';
import { activityTable, linkTable, TABLE_GUIDE } from '../core/query/table.ts';
import { computeSchedule, COMPUTE_GUIDE } from '../core/query/compute.ts';
import { compareComputed, evaluate } from '../core/query/evaluate.ts';
import { parseScheduleOptions, SCHEDULE_OPTIONS_GUIDE } from '../core/schedule/options.ts';
import { reviewSchedule } from '../core/query/review.ts';
import { ANALYSIS_TOOLS, runAnalysis } from './analysis.ts';
import { discardKeptMeshing, FOURD_FILES, FOURD_NAMES, FOURD_TOOLS, load4dSidecar, runFourD, save4dSidecar } from './fourd.ts';
import { LOB_FILES, LOB_NAMES, LOB_TOOLS, lobSidecars, lobSidecarText, readLobSidecar, runLob, scheduleWithLob } from './lob.ts';
import { lobGuard } from '../core/lob/view.ts';
import { loadLobModels } from '../core/lob/store.ts';
import { scheduleLogReport } from '../core/analysis/scheduleLog.ts';
import { baselineOf } from '../core/analysis/common.ts';
import { reasonerModelPath, reasonerStatus } from '../core/analysis/hrmRuntime.ts';
import { record, rollback, rollbackRunning } from '../core/journal.ts';
import { parseP6Date, formatP6Date } from '../core/dates.ts';
import { findingCount, worst, type Finding } from '../core/findings.ts';
import { addField, type Db, type Row } from '../core/db.ts';
import { findUnicodeFont } from '../renderer/print/system-font.ts';
import { compareSchedules } from '../core/diff.ts';
import { printPages, printableColumns } from '../renderer/print/schedule.ts';
import { pagesToHtml, pagesToPdfParts } from '../renderer/print/output.ts';
import { PRINT_GUIDE } from '../renderer/print/layout.ts';
import { readXlsx, writeXlsx } from '../core/excel/xlsx.ts';
import { applyImport, exportSheets, planImport, SHEET_TITLES, SHEETS, templateColumns } from '../core/excel/p6sheets.ts';
import { listReports, parseSpec, runReport, runSpec } from '../renderer/reports/engine.ts';
import { reportHtml, reportPages, reportText, reportXlsx } from '../renderer/reports/output.ts';
import { nowStamp } from '../core/report/reports.ts';
import { defaultEstimates, runMonteCarlo, type MonteCarloOptions, type Sampler } from '../core/risk/montecarlo.ts';
import { claimHere, keptPlace, IterationFile, keepWords, type Claim } from './keptRuns.ts';
import { exportAfterChange, exportDoc, exportFolder, exportName, exportNameProp, exportProp, exportResult, noteCuts } from './export.ts';
import { dayHours } from '../core/project/units.ts';
import {
  MEASURE_FILE_BYTES, heapNow, releaseIfGrown, retainedBytes, ToolError, fail, config, setRoot, setRoots, writeBase, unsavedEvicted, isDirty, pathArg, countArg, createSession, estimateBytes, getSession, closeSession, forgetEvicted, requireOwner,
  exclusive, change, changeAsync, followJob, dropLast, regrow, undo, redo, startJob, jobView, getJob, noteSilence, askWake, sweepIdle, sweepJobs, status, sessions, adoptRecovery, checkpointAll, scheduleCheckpoint, evictedList, recoveryStatus, reserveMemory, freeMemory, type Session,
} from './runtime.ts';

const VERSION = '2.0.0';
const prefsOf = (s: Session) => ({ hoursPerDay: s.hpd, dateFormat: 'dd-MMM-yy' as const, showTime: false, durationDecimals: 0, calendarDays: true });

// ---------------------------------------------------------------- tool list
const handleProp = { handle: { type: 'string', description: 'The handle returned by open_file or new_project' } };
const common = { caller: { type: 'string', description: 'Who is calling (set by the bridge); undo and redo act on your own changes' }, async: { type: 'boolean', description: 'Run as a job and return a job_id at once (job_status gives the result)' } };
const ownerProp = { owner_key: { type: 'string', description: 'The owner key returned when the project was opened' } };
const withHandle = (schema: Record<string, unknown>, owner = false) => ({ ...schema, properties: { ...handleProp, ...(owner ? ownerProp : {}), ...((schema.properties as object) ?? {}), ...common }, required: ['handle', ...(((schema.required as string[]) ?? []))] });
const ro = { readOnlyHint: true, openWorldHint: false };
const edit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const ERRORS_DOC = ' Errors come back as {error: {code, reason, next_step, retry_after_ms?}} (also message, hint, retry_after in seconds): follow next_step (e.g. busy -> retry, unknown_handle -> open_file again). Answers of tools that can change a project carry unsaved_changes.';

const TOOLS = [
  { name: 'open_file', annotations: edit, description: 'Open an XER, P6 XML, Microsoft Project XML, MPX or Microsoft Project .mpp file (read without Microsoft Project, through MPXJ) and get a handle (for editing) and an owner_key (for save, close and undoing others\' changes). Returns P6 import diagnostics and a project summary. A file P6 would reject is refused (error p6_would_reject, with the fatal findings) unless lenient: true, which opens it anyway when its data could be read (the answer to the refusal says what P6 refuses, by kind and count, and how to carry on; the lenient answer says in file_as_given that the original is one P6 would refuse, and the user is to be told) and repairs what it safely can (a misspelled key column with unique ids is renamed; empty, missing or repeated ids nothing points at get fresh ones): diagnostics.repaired lists each repair, diagnostics.not_repaired what was left, and still_rejected says whether a save would still be refused by P6. Nothing is written until save. Large files can take a while: pass async: true to get a job_id.' + ERRORS_DOC, inputSchema: { type: 'object', properties: { path: { type: 'string' }, hours_per_day: { type: 'number' }, lenient: { type: 'boolean', description: 'open a file P6 would reject, to repair it' }, encoding: { type: 'string', description: 'XER/MPX text encoding (default: recognised automatically): windows-1252, windows-1256 (Arabic), windows-1251, windows-1253, windows-1255, windows-1250, windows-1254, gbk, big5, shift_jis, utf-8' }, ...common }, required: ['path'] } },
  { name: 'new_project', annotations: edit, description: 'Start a new, empty project in memory (WBS root, default calendar, P6 schedule options); returns handle and owner_key.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Project ID' }, name: { type: 'string' }, start: { type: 'string', description: 'Planned start YYYY-MM-DD' }, must_finish_by: { type: 'string', description: 'Must finish by (YYYY-MM-DD): late dates and float are measured to it' }, hours_per_day: { type: 'number' }, ...common }, required: ['id', 'start'] } },
  { name: 'compute_schedule', annotations: ro, description: `Compute a schedule from a description, with no handle and nothing kept: P6's F9 (calendars, constraints, milestones, progress, retained logic and the other schedule options) on the activities and links given. Takes: ${COMPUTE_GUIDE}.`, inputSchema: { type: 'object', properties: { start: { type: 'string' }, data_date: { type: 'string' }, must_finish_by: { type: 'string' }, hours_per_day: { type: 'number' }, calendar: { type: 'string' }, calendars: { type: 'array', items: { type: 'object' } }, activities: { type: 'array', items: { type: 'object' } }, relationships: { type: 'array', items: { type: 'object' } }, options: { type: 'object' }, break_loops: { type: 'boolean' }, offset: { type: 'number' }, limit: { type: 'number' }, names: { type: 'boolean' }, ...common }, required: ['start', 'activities'] } },
  { name: 'list_open', annotations: ro, description: 'Projects open in memory, and projects moved out of memory to recovery files (they come back on their next call).', inputSchema: { type: 'object', properties: {} } },
  { name: 'server_status', annotations: ro, description: 'Memory use and budget, limits, open projects (busy, idle, unsaved), projects moved out, running jobs, and reasoner: whether the schedule reasoner (optimize_schedule) loaded, its model and runtime, or why not (checked in the background: the first call after the server starts may say checking: true, loaded: null).', inputSchema: { type: 'object', properties: {} } },
  { name: 'job_status', annotations: ro, description: 'Result of a job started with async: true (or one that outlived the call time). wait_seconds (max 20) waits for it to finish.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, wait_seconds: { type: 'number' }, wake_after_s: { type: 'number', description: 'wake me (a no_progress pulse) if the job still shows no progress after this many seconds — counted from now or its next progress; the job is never stopped by it' } }, required: ['job_id'] } },
  { name: 'cancel_job', annotations: edit, description: 'Stop a running job (Monte Carlo, evaluate_batch, crash_schedule and optimize_schedule (in its final pass over the modes) stop at their next step and return what they finished, marked partial; open_file, save and schedule stop between their phases, keeping or writing nothing; other work finishes its current step). MCP notifications/cancelled stops a running call the same way.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
  { name: 'edit', annotations: edit, description: `Change the project with a list of operations, applied as ONE transaction: if any fails nothing changes and the error names it. Undo with undo.\n${OP_GUIDE}`, inputSchema: withHandle({ type: 'object', properties: { operations: { type: 'array', items: { type: 'object' } } }, required: ['operations'] }) },
  { name: 'activity_table', annotations: ro, description: `Every activity's computed fields as one compact table (columns, then one array per activity, in table order), paged with offset and limit (no cap on limit; default all, next_offset for the next page). Columns: ${TABLE_GUIDE}; names: true adds name after id. of: assignments gives every resource assignment instead (project, activity, resource, role, budgeted / remaining / actual units, units_per_day, budgeted / remaining / actual cost), of: codes every activity code assignment (project, activity, code_type, code, description), paged the same way.`, inputSchema: withHandle({ type: 'object', properties: { project: { type: 'string', description: 'Project ID (default: every project in the file)' }, offset: { type: 'number' }, limit: { type: 'number' }, names: { type: 'boolean' }, of: { type: 'string', enum: ['activities', 'assignments', 'codes'] } } }) },
  { name: 'list_tables', annotations: ro, description: 'Every table the open file holds (the XER tables: PROJECT, PROJWBS, TASK, TASKPRED, CALENDAR, RSRC, ROLES, TASKRSRC, ACTVTYPE, ACTVCODE, TASKACTV, UDFTYPE, UDFVALUE, TASKMEMO, WBSMEMO, TASKPROC (steps), PROJCOST (expenses), EPS (PROJWBS of the EPS), OBS, ACCOUNT, RSRCRATE, SCHEDOPTIONS ... whatever the file has; a P6 XML object the clone has no table for as XML:<Element>; the clone’s own data as CLONE:<TABLE>: saved FILTER, REPORT, PORTFOLIO, TSLINE timesheet lines, RISKEST risk estimates), each with its columns and row count (of the project asked for, where the table has proj_id). Read any of them with read_table.', inputSchema: withHandle({ type: 'object', properties: { project: { type: 'string', description: 'Project ID, or a baseline’s (default: every project and baseline)' } } }) },
  { name: 'read_table', annotations: ro, description: 'Read any table of the open file as it is: every row, every column the file has, nothing summarised (list_tables names them). Answers columns, then one array per row, paged with offset and limit (default 1000, no cap; next_offset while more remain). Columns are the file’s own fields (XER names: dates "YYYY-MM-DD HH:MM", durations and lags in hours, as P6 writes them), then what a P6 XML file carries beyond them (xml:<Tag>) and a Microsoft Project file’s own elements (msp:<Name>: notes, baselines, custom fields, timephased data... as written); the clone’s own fields beside the file’s as clone:<field> (a project’s clone:eps_id, a baseline’s clone:baseline_of...); CALENDAR rows also give work_week (each day’s shifts) and exceptions ([{date, work}], work [] = non-work day) decoded from clndr_data. Baselines are projects: read their rows with project = the baseline’s Project ID. columns: only those columns.', inputSchema: withHandle({ type: 'object', properties: { table: { type: 'string' }, project: { type: 'string', description: 'Project ID, or a baseline’s (default: every row)' }, offset: { type: 'number' }, limit: { type: 'number', description: 'rows per page (default 1000, no cap)' }, columns: { type: 'array', items: { type: 'string' } } }, required: ['table'] }) },
  { name: 'schedule', annotations: edit, description: 'Schedule (F9) like P6: CPM with calendars, constraints, retained logic. Returns the finish date, the full schedule log as data (log: statistics, errors, warnings and exceptions, each section with its activities: loops, no predecessors, no successors, out of sequence, actuals after the data date, milestones with invalid relationships, critical activities, unsatisfied constraints and relationships, external dates, negative float; log_max_ids caps each section (default 100, 0 = all), log: false leaves it out), and loops ([[activity IDs]] of each loop; [] when none). break_loops: true schedules a network with loops by leaving out the links that close them (returned in broken_links; the links stay in the project); without it a loop fails the schedule, as in P6. options overrides the project\'s schedule options for this run only (set_schedule_options writes them): ' + SCHEDULE_OPTIONS_GUIDE + '. A project opened from Microsoft Project XML in which nothing that drives the dates changed keeps Microsoft Project\'s dates (kept_msp_dates); otherwise msp_dates_changed lists the dates the schedule replaced. data_date moves the data date of every project in the file first, or with project of that project only (the others schedule on their own data dates).', inputSchema: withHandle({ type: 'object', properties: { data_date: { type: 'string' }, project: { type: 'string', description: 'Project ID: data_date applies to this project only' }, break_loops: { type: 'boolean' }, options: { type: 'object' }, log: { type: 'boolean' }, log_max_ids: { type: 'number' } } }) },
  { name: 'update_progress', annotations: edit, description: 'Tools > Update Progress: move the data date and statuse activities from their planned dates, then reschedule. If scheduling fails nothing is kept.', inputSchema: withHandle({ type: 'object', properties: { data_date: { type: 'string' } }, required: ['data_date'] }) },
  { name: 'import_file', annotations: edit, description: 'File > Import into this open file, like P6\'s Import wizard: a project from a file (path: XER, P6 XML, Microsoft Project XML, MPX or .mpp) or another open project (other_handle). action: new (a new project; a Project ID already used gets -1, -2…), replace (Replace Existing Project: project\'s content becomes the file\'s; activities of the same Activity ID keep their identity, so relationships from other projects to them survive; the ones that cannot are reported), update (Update Existing Project: activities matched by Activity ID, WBS by code path, relationships by predecessor, successor and type, assignments by activity, resource and role, code and UDF values, notes, steps and expenses by their activity and name; matched objects are updated or kept per data type, new ones inserted, what the file lacks is kept unless remove_missing), add_into (Add Into Existing Project: the file\'s project becomes a WBS node of project, under wbs (a WBS code, default its top); an Activity ID already used gets -1). project: the target Project ID (replace, update, add_into). from_project: the Project ID in the file (default: its only project; new: every project in it). data (update): per data type — activities, wbs, relationships, assignments, activity_code_assignments, udf_values, notebooks, steps, expenses, issues, project_calendars, project_code_types, or a P6 table name — update (default), keep, skip (Do Not Import) or remove_missing (activities, relationships and assignments: also removes what the file lacks). dictionaries: per type — calendars, resources, roles, cost_accounts, activity_codes, udfs, obs, currencies, units, notebook_topics, expense_categories, resource_curves, project_codes, resource_codes, financial_periods, resource_rates, role_rates, or a table name — keep (default: a row of the same name is used as it is), update, insert (a copy) or skip (Do Not Import: a match is used, the rest is left out with what needs it). dry_run: true answers the counts and findings without changing anything. Answers projects, counts per table {inserted, updated, kept, removed, skipped} and findings (IMPORT_ID_RENAMED, IMPORT_LINK_DROPPED, IMPORT_EPS_MATCHED, IMPORT_UNRESOLVED). One undoable change. A baseline cannot be the target.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, other_handle: { type: 'string' }, action: { type: 'string', enum: ['new', 'replace', 'update', 'add_into'] }, project: { type: 'string' }, from_project: { type: 'string' }, wbs: { type: 'string' }, data: { type: 'object' }, dictionaries: { type: 'object' }, dry_run: { type: 'boolean' } }, required: ['action'] }) },
  { name: 'transfer_progress', annotations: edit, description: 'Transfer progress from another schedule (a subcontractor\'s update: path or other_handle) onto this project\'s activities in one step, without importing their activities. match: activity_id (default), name, code (code_type: the activity code type whose value on this project\'s activities names theirs: their Activity ID, or the value of their from_code_type), udf (udf / from_udf likewise), or pairs [{from, to}] (their Activity ID -> this project\'s). One activity here may stand for several of theirs (a package summary): it takes the earliest actual start, the latest actual finish once all of them are finished, physical % weighted by their original durations, and the remaining duration until the last of them finishes (on its own calendar, from their data date); one of theirs may feed several here. Parts: dates (actual start / finish), percent (physical %), remaining (remaining duration), expected (expected finish), suspend (suspend / resume), units (actual and remaining labor and nonlabor units), assignments (matched by resource and role ID: units, dates; costs recomputed from this project\'s own rates unless costs: "copy"; add_assignments: true assigns a resource this project has but the activity lacks), expenses (by expense item name: actual and remaining cost), steps (by step name); include: {part: false} leaves a part out. data_date: "from" (theirs) or a date moves this project\'s data date. project / from_project: Project IDs (default: the only project; theirs: every project in the file). dry_run: true answers the changes without making them. Answers matched, updated, changed_fields (how many activities each field changed on), changes [{id, from, changed {field: [before, after]}}] (the first max_changes, default 100; truncated and next_offset say there are more, offset pages a dry_run), unmatched_from (their activities nothing here matched; the first 100, unmatched_from_count all), ambiguous (a name that matches more than one activity), assignments / expenses / steps {updated, added, unmatched (first 100), unmatched_count} and warnings (e.g. actual dates after the data date). One undoable change; schedule afterwards to see the effect.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, other_handle: { type: 'string' }, match: { type: 'string', enum: ['activity_id', 'name', 'code', 'udf', 'pairs'] }, code_type: { type: 'string' }, from_code_type: { type: 'string' }, udf: { type: 'string' }, from_udf: { type: 'string' }, pairs: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } }, include: { type: 'object' }, costs: { type: 'string', enum: ['recompute', 'copy'] }, add_assignments: { type: 'boolean' }, data_date: { type: 'string' }, project: { type: 'string' }, from_project: { type: 'string' }, dry_run: { type: 'boolean' }, max_changes: { type: 'number', description: 'changes listed (default 100)' }, offset: { type: 'number', description: 'changes to skip (the next_offset of a dry_run)' } } }) },
  { name: 'level_resources', annotations: edit, description: 'Tools > Level Resources (resources with a Max Units/Time limit): activities are delayed until each leveled resource has room. within_float: only within total float. over_allocation_pct: allowed overallocation (e.g. 10). priority_by: early_start (default), total_float or priority. resources: [resource IDs] to level (default: all with a limit). activity_priority: [activity IDs] placed first, in that order, once their predecessors are placed. dry_run: true answers the leveled dates (moved) and per-resource peaks without changing the project (no undo entry). Answers delayed, moved [{id, from, start, finish}], peaks [{resource, peak, limit, day, overallocated}] (unit-hours in the peak day) and the report.' + exportDoc('level_resources', ['moved', 'peaks']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, within_float: { type: 'boolean' }, over_allocation_pct: { type: 'number' }, priority_by: { type: 'string' }, resources: { type: 'array', items: { type: 'string' } }, activity_priority: { type: 'array', items: { type: 'string' } }, dry_run: { type: 'boolean' } } }) },
  { name: 'monte_carlo', annotations: ro, description: 'Schedule risk analysis (Monte Carlo) like Primavera Risk Analysis: samples each activity\'s remaining duration from its three-point estimate (set with the set_estimates edit operation; default_estimates applies min/max percentages to activities without one, for this run only) and risk events from the risk register, schedules every iteration. Returns finish percentiles P10-P90, mean, std dev, chance of meeting the deterministic finish, a histogram (buckets) and cumulative (the S-curve: finish and cum_pct, one point for each finish date, thinned past 200), milestone percentiles, activity criticality index (each row also has milestone, deterministic_finish, mean_finish, p50_finish, p80_finish, sensitivity and min, mean and max remaining hours: the columns of the criticality table of an export), sensitivity ranking and risk-event impact, and the finishes in working days from the data date (working_days, with sigma marks: mean - 3 to + 3 standard deviations as days and dates). events: risk events for this run only, each {name, probability (0-1) or probability_pct, delay_days or delay_hours, activities?: [IDs]}: when it happens the delay is added to each activity named (days of its calendar), or with no activities to the project finish (a project-level delay, project calendar). sampler: a duration ratio per activity and iteration, {type: ratio_normal, mean, std, min_ratio, max_ratio} (default 1.12, 0.28, 0.3, 4) or {type: ratio_empirical, ratios: [..], weight (0-1, default 0.66), normal?: {mean, std, min_ratio, max_ratio}}: with probability weight a ratio drawn uniformly from ratios (only when there are at least 10), else from the normal (the platform\'s slippage sampler; seeded), with scope all (default: instead of three-point estimates) or unestimated. re_anchor: true rescales each three-point estimate so its mean is the remaining duration. deadline (date): the chance of finishing by it. The project is not changed. Big projects: pass async: true (job_status shows the iterations done); notifications/cancelled or cancel_job stops it, and a progressToken gets notifications/progress. Each iteration is kept as it finishes, in a file in the write root (monte_carlo-<fingerprint>-s<seed>.parts/iterations.p6mc: the generator\'s position and everything the statistics need). A run that stops (cancelled, an iteration failed, its worker ended) answers the statistics of the iterations done, marked partial, with resume: the path of that file; to continue, call monte_carlo again with the same arguments and resume: that path, exactly as given (it is never searched for): only the remaining iterations run and the answer is the one an uninterrupted run with that seed gives (resumed_iterations says how many came from the file; redone_iterations how many kept ones did not check out, damaged as a power loss can leave a file or after a damaged one, and were run again). Without a seed the stopped run\'s seed is used. If the schedule, its estimates or risks, or an argument differ from the kept run, the call is refused with resume_mismatch; nothing kept is removed by a refusal. A run whose kept file another monte_carlo call in this server is still working on (a cancelled job answers before it has stopped; the same project open under two handles) is refused as run_busy, naming that job when it is one. A call without resume starts over (it replaces a kept file of the same name). A run that finishes removes its file and names its folder in parts_removed (so a copy of it elsewhere can go too).' + exportDoc('monte_carlo', ['iterations (iteration, finish, finish_days from the data date, each milestone\u2019s finish: the values the statistics come from, a resumed run\u2019s kept iterations too)', 'histogram (whole days)', 'percentiles (the engine\u2019s own P10-P90, mean, min, max, std, deterministic and the chances)', 'sigma', 'criticality (every activity)', 'sensitivity', 'milestones', 'risk_events', 'events']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, iterations: { type: 'number', description: 'a whole number, default 1000, at least 10; no upper bound (memory decides, with the histogram buckets and the export: a run that does not fit is refused up front, before any iteration, saying how many iterations fit)' }, resume: { type: 'string', description: 'the resume path a stopped monte_carlo answered (its kept iterations), to run only the iterations still missing; same arguments as that call' }, events: { type: 'array', items: { type: 'object' } }, sampler: { type: 'object' }, re_anchor: { type: 'boolean' }, deadline: { type: 'string' }, seed: { type: 'number', description: 'same seed, same result' }, risk_events: { type: 'string', description: 'pre (default), post or off' }, project: { type: 'string' }, default_estimates: { type: 'object', description: '{min_pct: 90, max_pct: 125, dist: triangle|uniform|betapert} for activities without an estimate' }, buckets: { type: 'number', description: 'histogram buckets, a whole number (default 20, at least 5; memory decides: a histogram that does not fit is refused up front, saying how many buckets fit)' }, histogram: { type: 'string', description: '"days": the histogram in whole-day bins (a bin of 1 day or more, at most 40 bins, as the Risks window draws it) instead of `buckets` equal bins; leave out for buckets' }, top: { type: 'number', description: 'how many in the milestones, criticality and sensitivity lists, a whole number (default 25; 0 = all); milestones_total, criticality_total and sensitivity_total say how many there are' } } }) },
  { name: 'validate', annotations: ro, description: 'P6 import diagnostics for the project as it is now (what real P6 would accept, warn about or reject), plus saved dates that P6 would change.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  { name: 'review', annotations: ro, description: 'Schedule quality review (DCMA-style checks graded pass/warn/fail): missing logic, leads, lags, relationship types, hard constraints, float, long durations, invalid dates, resources, out-of-sequence, saved dates P6 would change. For the full DCMA 14-point (critical path test, CPLI, BEI, missed tasks, profiles, activity lists) use dcma_14; for the P6 Check Schedule report use check_schedule.' + exportDoc('review', ['checks', 'activities (every activity each check found, by ID and name)', 'saved_dates']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp } }) },
  ...ANALYSIS_TOOLS(withHandle),
  ...FOURD_TOOLS(withHandle),
  ...LOB_TOOLS(withHandle),
  // (earned_value is one of the analyses: it exports as they do)
  ...LOOKUPS.map((t) => (t.name === 'earned_value'
    ? { name: t.name, annotations: ro, description: t.description + exportDoc('earned_value', ['totals (each project)', 'by_wbs', 'activities (every activity with cost, every figure)', 'worst_cost_performance', 'worst_schedule_performance']), inputSchema: withHandle({ ...t.parameters, properties: { ...(t.parameters.properties as object), export: exportProp, export_name: exportNameProp } }) }
    : { name: t.name, annotations: ro, description: t.description, inputSchema: withHandle(t.parameters) })),
  { name: 'undo', annotations: edit, description: 'Undo your own last change on this project (edit, schedule, progress update, leveling, import). Refused only if someone else\'s later change touched the same items. any_caller: true (with owner_key) undoes the latest change whoever made it.', inputSchema: withHandle({ type: 'object', properties: { any_caller: { type: 'boolean' } } }, true) },
  { name: 'redo', annotations: edit, description: 'Re-apply your last undone change.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  { name: 'save', annotations: writes, description: 'Write the project (needs owner_key): XER (P6 version 5.0-24.12; default the version it was read in; a project with none (new, or read from a non-P6 file) is stamped 7.0 so every P6 since 7 imports it (P6 refuses a file stamped newer than itself, silently). Tell the user: P6 8 and later treat a few things differently (actual dates; a finish pushed into non-work time), so after F9 in a newer P6 a few dates may move slightly), P6 XML (.xml), Microsoft Project XML (format: mspdi) or MPX (.mpx). A Microsoft Project file holds one project: when the file has several, mspdi and mpx need project. repair: true (after a lenient open P6 would still reject) writes a repaired copy P6 imports to a new path (never over the file opened): impossible values taken from the activity\'s own other fields (else P6\'s neutral value), only actual dates P6 refuses cleared (unreadable, before 1753, a finish before its start; never invented), actual dates P6 imports kept and listed in invalid_dates (after the data date, a finish without a start), rows that cannot be identified removed with what pointed at them; the answer lists every change (table, row, key, field, old, new, reason) and check says whether the copy, opened again, would still be rejected. XER and MPX: encoding defaults to the file\'s own (the encoding it was read in, BOM as read; a new project: the code page P6 would use). A changed project is not written when this session\'s changes left it holding what P6 would reject on import (an Activity ID used twice in a project, a Resource / Project ID used twice, a row that is its own ancestor, an activity linked to itself): the save is refused, naming them (allow_invalid: true writes it anyway). What the file already had when it was opened is never a refusal: it is saved as it was and listed in the answer (p6_would_reject). Paths are inside the storage root.', inputSchema: withHandle({ type: 'object', properties: { allow_invalid: { type: 'boolean', description: 'Write even when the changes made in this session added something P6 rejects on import (an Activity ID used twice, a parent cycle, an activity linked to itself); default false: the save is refused and names them' }, path: { type: 'string', description: 'Default: the file it was opened from (requires overwrite: true)' }, project: { type: 'string', description: 'Project ID to write (default: all projects; required for mspdi and mpx when the file holds several)' }, format: { type: 'string', description: 'xer, p6xml, mspdi or mpx (default from the extension; .xml = P6 XML)' }, version: { type: 'string' }, repair: { type: 'boolean', description: 'write a repaired copy P6 imports (a new path)' }, encoding: { type: 'string', description: 'XER/MPX text encoding; encoding defaults to the file\'s own (the one it was read in, BOM as read) while the text fits it; else, and for a new project, the code page P6 would use, e.g. windows-1256 for Arabic' }, overwrite: { type: 'boolean' } } }, true) },
  { name: 'export_pdf', annotations: writes, description: 'Print the schedule to a PDF file like P6 prints the Activities layout: every activity on as many pages as needed, the chosen columns and/or the Gantt chart, WBS bands, timescale and column titles on every page, header/footer with page numbers, legend. Path ending in .html writes the same pages as HTML. ' + PRINT_GUIDE + ' Layout options: filter, group_by (wbs, none), sort_by.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, settings: { type: 'object', description: 'Print settings (see description)' }, project: { type: 'string', description: 'Project ID when the file holds several (default: all)' }, filter: { type: 'string' }, group_by: { type: 'string' }, sort_by: { type: 'string' } }, required: ['path'] }) },
  { name: 'export_excel', annotations: writes, description: 'Export to an Excel workbook (.xlsx) like P6 File > Export > Spreadsheet (Oracle\'s XLSX data map): sheets TASK (activities), TASKPRED (relationships), PROJCOST (expenses), RSRC (resources), TASKRSRC (resource assignments); row 1 field names, row 2 titles ("(*)" = calculated, never imported), durations and lags in days, dates as Excel dates. sheets and columns are P6\'s Modify Template: the subject areas, and per sheet the columns (field names; the ones P6 requires are always written). Code and UDF columns: actv_code_<type id>_id, rsrc_catg_<id>_id, asgnmnt_catg_<id>_id, proj_catg_<id>_id (title: the code type), user_field_<udf id> (title: the UDF); "actv_code_*", "user_field_*"... pick every one of a kind, "*" every column of the sheet. describe: true lists every column of every sheet and writes nothing. Edit the workbook and bring it back with import_excel.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, project: { type: 'string', description: 'Project ID (default: all projects in the file)' }, sheets: { type: 'array', items: { type: 'string' }, description: 'Subject areas to write: TASK, TASKPRED, PROJCOST, RSRC, TASKRSRC (or their titles). Default: all' }, columns: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Per sheet, its columns, e.g. {"TASK": ["task_code", "task_name", "actv_code_*", "user_field_*"]}. A sheet left out gets its default columns' }, describe: { type: 'boolean', description: 'List the columns each sheet can carry (field, title, calc, required) and write nothing' } } }) },
  { name: 'import_excel', annotations: edit, description: 'Update the project from an Excel workbook in the export_excel / P6 spreadsheet layout, as P6\'s spreadsheet import: activities (status, dates, durations, constraints, % complete type, calendar, activity codes, UDFs), relationships, expenses, resources (added and updated: calendar, units, role, unit of measure, contact fields, resource codes, UDFs) and resource assignments (added and updated: units, costs, actuals, dates, durations, role, cost account, curve, assignment codes, UDFs); "Y" in delete_record_flag deletes the row. Calculated columns ("(*)" titles) are ignored; a code value, calendar, role or other dictionary entry the file does not have is skipped with a warning (P6 does not import global data that does not exist). A row P6 would refuse is skipped and listed in refused (sheet, row, message); the rest is applied as one undoable change. dry_run returns the plan only.', inputSchema: withHandle({ type: 'object', properties: { path: { type: 'string' }, project: { type: 'string', description: 'Project ID to update (default: the only project)' }, dry_run: { type: 'boolean' } }, required: ['path'] }) },
  { name: 'compare', annotations: ro, description: 'Compare this project with another open project (other_handle) or a file (path), like P6\'s Claim Digger: projects by Project ID, WBS by code path, activities by Activity ID, relationships by predecessor, successor and type. Durations, lags and floats in days. baseline (project, bl1-bl3 or the name of any saved baseline) compares this project with its baseline stored in the file instead (computed). Activities match by Activity ID, then by a unique name (matched_by_name). mode: computed compares only what the schedule computes, per activity: duration_delta_days, remaining_delta_days, start_shift_days, finish_shift_days, total_float_delta_days (working days), became_critical / no_longer_critical, plus only_in_a / only_in_b.' + exportDoc('compare', ['changes (every change, unpaged)', 'only_in_one (mode computed; empty otherwise)']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, other_handle: { type: 'string', description: 'the newer revision, already open' }, path: { type: 'string', description: 'or a file to compare against' }, mode: { type: 'string', description: 'all (default) or computed' }, baseline: { type: 'string', description: 'project, bl1, bl2, bl3 or a saved baseline name: compare with that baseline in this file' }, project: { type: 'string' }, max_changes: { type: 'number', description: 'changes a page (default 500; no cap)' }, offset: { type: 'number', description: 'changes to skip: pass next_offset for the next page' } } }) },
  { name: 'evaluate', annotations: ro, description: 'What-if without changing the project: schedules a scratch state of it (no undo entry, nothing kept) as it is and with overrides (edit operations, e.g. [{"op":"update_activity","id":"A1000","duration_days":15}]), with the same data_date (this call only) and options (as schedule takes them). Answers base_finish, finish, finish_delta_days (working days), critical (activity IDs), became_critical, no_longer_critical, and changed (per activity, each computed field that changed as [before, after]; max_rows, default 500).' + exportDoc('evaluate', ['changed (every changed field of every activity)', 'critical_changes']), inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, overrides: { type: 'array', items: { type: 'object' } }, options: { type: 'object' }, data_date: { type: 'string' }, project: { type: 'string' }, max_rows: { type: 'number' } } }) },
  { name: 'list_reports', annotations: ro, description: 'Reports available like P6 Tools > Reports: the standard reports by group and reports made with create_report.', inputSchema: withHandle({ type: 'object', properties: {} }) },
  { name: 'run_report', annotations: ro, description: 'Run a report (id or name from list_reports, or an ad-hoc "definition" like create_report takes). Without "path" the rows come back as data; with path it is written as PDF (.pdf), HTML (.html), CSV (.csv/.txt) or Excel (.xlsx).', inputSchema: withHandle({ type: 'object', properties: { report: { type: 'string' }, definition: { type: 'object' }, path: { type: 'string' }, settings: { type: 'object', description: 'print settings for PDF (see export_pdf)' }, project: { type: 'string' }, weeks: { type: 'number', description: 'lookahead weeks' }, max_rows: { type: 'number', description: 'rows a page without path (default 200; no cap)' }, offset: { type: 'number', description: 'rows to skip: the next_offset of the previous page' } } }) },
  { name: 'create_report', annotations: edit, description: 'Save a report definition like the P6 Report Wizard (name, subject, columns, filter, group_by, sort_by, sort_desc, title, group). Kept with this open project for run_report (not written into the XER). Subject areas: activities, assignments, wbs, resources, relationships (see list_reports for examples).', inputSchema: withHandle({ type: 'object', properties: { name: { type: 'string' }, subject: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } }, filter: { type: 'string' }, group_by: { type: 'string' }, sort_by: { type: 'string' }, sort_desc: { type: 'boolean' }, title: { type: 'string' }, group: { type: 'string' } }, required: ['name', 'subject'] }) },
  { name: 'close', annotations: writes, description: 'Close the project and free its memory (needs owner_key). Refused (unsaved_changes) while it has unsaved changes: save first, or pass discard: true to drop them.', inputSchema: withHandle({ type: 'object', properties: { discard: { type: 'boolean', description: 'close even with unsaved changes (they are lost)' } } }, true) },
];

// ---------------------------------------------------------------- helpers
const allIds = (db: Db) => (db.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of).map((p) => p.proj_id);
const summary = (s: Session) => runTool('project_summary', {}, s.db, makeCtx(s.db, { hoursPerDay: s.hpd }), [], s.hpd, true);
const brief = (f: Finding[]) => ({ verdict: worst(f) ?? 'clean', counts: f.reduce<Record<string, number>>((a, x) => ((a[x.severity] = (a[x.severity] ?? 0) + findingCount(x)), a), {}), findings: f.filter((x) => x.severity !== 'info').slice(0, 40).map((x) => ({ severity: x.severity, code: x.code, where: [x.table, x.field, x.key].filter(Boolean).join(' '), message: x.message, p6: x.p6 })) });
const dd = (v: unknown) => { if (v == null || v === '') return null; const t = parseP6Date(String(v)); if (t == null) fail('bad_input', `"${v}" is not a date.`, 'Use YYYY-MM-DD or YYYY-MM-DD HH:MM.'); return t; };
const projectIds = (db: Db, id: unknown) => {
  const ps = (db.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of);
  if (id == null || id === '') return ps.map((p) => p.proj_id);
  const p = ps.find((x) => x.proj_short_name.toLowerCase() === String(id).toLowerCase());
  if (!p) fail('bad_input', `No project "${id}".`, `Projects in this file: ${ps.map((x) => x.proj_short_name).join(', ')}.`);
  return [p!.proj_id];
};
/** A .mpp read through MPXJ (core/msp/mpp.ts) as the Microsoft Project XML it turns it into; refused in words when this
 *  installation cannot (no MPXJ, no Java) or the file cannot be read. */
/** The other side of compare, import_file and transfer_progress: another open project (other_handle) or a file (path),
 *  read for this call only and counted in the memory budget while it is held (C14). */
async function readOther(a: Record<string, any>, what: string): Promise<{ db: Db; release: () => void; bytes: number; /** what P6 would refuse in the file read (path), as open_file says it */ asGiven?: ReturnType<typeof fileAsGiven> }> {
  if (a.other_handle) { const o = getSession(a.other_handle); return { db: o.db, release: () => {}, bytes: o.bytes }; }
  if (!a.path) fail('bad_input', 'Give other_handle or path.', `other_handle: another open project; path: a file to ${what}.`);
  const p = pathArg(a.path), bytes = estimateBytes(fileSize(p));
  const release = reserveMemory(bytes, `Reading ${basename(p)} to ${what}`, `open the other file with open_file and pass other_handle when there is room`);
  try {
    let db: Db, findings: Finding[], format: ReturnType<typeof detectFormat>;
    const head = readHead(p);
    if ((format = detectFormat(p, head)) === 'xer') ({ db, findings } = readXerFile(p));
    else { const b = readBytes(p); format = detectFormat(p, b); ({ db, findings } = format === 'mpp' ? await readMpp(p) : readRaw(b, format)); }
    if (!db.tables.PROJECT?.rows.length) fail('bad_input', `${basename(p)} holds no project to ${what}.`, `Give an XER, P6 XML or Microsoft Project file. If this is the file the user asked about: ${outsideRoute(format, head)}.`);
    // the checks open_file runs on the file read: what P6 would refuse in it, said beside the answer (the call goes on as it always did)
    return { db, release, bytes, asGiven: fileAsGiven(importChecks(db, findings, format), 'The file as given is one P6 itself would refuse (fatal_kinds); this call used what the clone could read from it: tell the user.') };
  } catch (e) { release(); throw e; }
}
/** A project of this file by Project ID (default: its only non-baseline project). */
function projectOf(db: Db, id: unknown, where: string): Row {
  const P = (db.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of);
  if (id != null && id !== '') return (db.tables.PROJECT?.rows ?? []).find((p) => p.proj_short_name === String(id)) ?? fail('bad_input', `${where} has no project ${id}.`, `Projects: ${P.map((p) => p.proj_short_name).join(', ')}.`);
  if (P.length === 1) return P[0];
  return fail('bad_input', `${where} holds ${P.length} projects: say which.`, `Projects: ${P.map((p) => p.proj_short_name).join(', ')}.`);
}
const IMPORT_DATA: Record<string, string[]> = { activities: ['TASK'], wbs: ['PROJWBS'], relationships: ['TASKPRED'], assignments: ['TASKRSRC'], activity_code_assignments: ['TASKACTV'], udf_values: ['UDFVALUE'], notebooks: ['TASKMEMO', 'WBSMEMO'], steps: ['TASKPROC'], expenses: ['PROJCOST'], issues: ['PROJISSU'], project_calendars: ['CALENDAR'], project_code_types: ['ACTVTYPE'] };
const IMPORT_DICT: Record<string, string[]> = { calendars: ['CALENDAR'], resources: ['RSRC'], roles: ['ROLES'], cost_accounts: ['ACCOUNT'], activity_codes: ['ACTVTYPE', 'ACTVCODE'], udfs: ['UDFTYPE'], obs: ['OBS'], currencies: ['CURRTYPE'], units: ['UMEASURE'], notebook_topics: ['MEMOTYPE'], expense_categories: ['COSTTYPE'], resource_curves: ['RSRCCURVDATA'], project_codes: ['PCATTYPE', 'PCATVAL'], resource_codes: ['RCATTYPE', 'RCATVAL'], financial_periods: ['FINDATES'], resource_rates: ['RSRCRATE'], role_rates: ['ROLERATE'] };
/** {name or table: action} -> {table: action}, each action checked. */
function importActions<T extends string>(v: unknown, names: Record<string, string[]>, allowed: readonly T[], what: string): Partial<Record<string, T>> {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) fail('bad_input', `${what} must be an object of {type: action}.`, `e.g. {"${Object.keys(names)[0]}": "${allowed[0]}"}`);
  const out: Partial<Record<string, T>> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const tables = names[k.toLowerCase()] ?? (/^[A-Z]+$/.test(k) ? [k] : fail('bad_input', `${what}: unknown type "${k}".`, `Types: ${Object.keys(names).join(', ')} (or a P6 table name).`));
    if (!allowed.includes(x as T)) fail('bad_input', `${what}.${k} must be ${allowed.join(', ')}.`, `e.g. "${allowed[0]}"`);
    for (const t of tables) out[t] = x as T;
  }
  return out;
}

/** A file the clone cannot open (task continuity): the second route, outside the clone. A text file (an XER, XML, MPX) can still be read
 *  by the agent's own file tools and the work done from its tables directly, said to the user as work done outside the P6 engine. */
const TEXT_FORMAT: Record<string, string> = { xer: 'an XER is tab-separated tables: %T table, %F fields, %R rows', xml: 'P6 XML: elements for the project, its WBS, activities, relationships and resources', mspdi: 'Microsoft Project XML: a Task element for each activity, with its predecessor links', mpx: 'MPX is comma-separated records, one kind of record per line' };
const startsWith = (h: Uint8Array, ...b: number[]) => b.every((x, i) => h[i] === x);
/** What the first bytes of a file say it is, when it is not a schedule text: each its own true sentence and route. A text file (and a
 *  UTF-16 one, which has zero bytes) is not one of these. */
const notText = (head: Uint8Array | undefined): string | undefined => {
  if (!head) return undefined;
  if (!head.length) return 'the file is empty (0 bytes): there is nothing in it to read, and it is not damaged, nothing was ever written to it (a copy or download that failed leaves one); tell the user it is empty and ask for the file again';
  if (startsWith(head, 0x50, 0x4b)) return 'the file is a zip-packed Office file (an Excel workbook or another Office document), not a schedule file: a P6 Excel export (the P6 spreadsheet layout) is read by the import_excel tool, which updates a project that is open (open or create that project first, then call import_excel with this path); any other workbook or document holds no schedule the clone reads, so tell the user what it is and ask for the schedule as an XER, P6 XML or Microsoft Project XML file';
  if (startsWith(head, 0x25, 0x50, 0x44, 0x46)) return 'the file is a PDF: a document, not a schedule file, and it is not damaged. Read it with the document reader (your PDF or file-reading tool) as any document, and tell the user it is a PDF, so it holds no schedule the clone can open and whatever was taken from it was done outside the P6 engine; ask for the schedule as an XER, P6 XML or Microsoft Project XML file if the analysis needs one';
  const utf16 = startsWith(head, 0xff, 0xfe) || startsWith(head, 0xfe, 0xff);
  if (!utf16 && head.includes(0)) return 'the file is binary (not text) and not one of the schedule formats the clone reads (XER, P6 XML, Microsoft Project XML, MPX, .mpp): it cannot be read as text either. Tell the user the file is not a schedule file the clone can open, what it appears to be if you can tell from its name, and ask for the schedule as an XER, P6 XML or Microsoft Project XML file';
  return undefined;
};
const outsideRoute = (format: string, head?: Uint8Array) => notText(head) ?? (format === 'mpp'
  ? 'this .mpp is a binary file that cannot be read as text: open it in Microsoft Project and save it as Microsoft Project XML, then open that; if that cannot be done, tell the user the file could not be read, the cause given, and that no analysis of it was possible'
  : `the file is text (${TEXT_FORMAT[format] ?? TEXT_FORMAT.xer}): read it with your file-reading tool, do what the user asked from the tables directly (code or a spreadsheet), and tell the user the file is damaged, what is wrong with it, and that the analysis was done outside the P6 engine`);
/** The fatal findings of a file by kind, with counts, in the order first met. */
/** Every fatal finding, in words (open_file's refusal lists them all in data.fatal, and a lenient open in file_as_given.fatal). */
const fatalList = (f: Finding[]) => f.filter((x) => x.severity === 'fatal').map((x) => ({ code: x.code, where: [x.table, x.field, x.key].filter(Boolean).join(' '), message: x.message, p6: x.p6 }));
/** What P6 would refuse in a file as it was given: said every time a file is read, so the answer to the user can say it. */
/** The real number of fatal findings (the validator keeps 5 of a kind and a line that says how many more). */
const fatalTotal = (f: Finding[]) => f.filter((x) => x.severity === 'fatal').reduce((n, x) => n + findingCount(x), 0);
/** How many fatal findings are listed in words of the real total (a "…and N more" line stands for the rest of its kind). */
const fatalListed = (f: Finding[]) => f.filter((x) => x.severity === 'fatal' && x.omitted == null).length;
const fileAsGiven = (f: Finding[], tell: string, o: { list?: boolean } = {}) => { const fatal = worst(f) === 'fatal'; return { p6_would_reject: fatal, ...(fatal ? { fatal_total: fatalTotal(f), fatal_kinds: fatalKinds(f), ...(o.list ? { fatal_listed: fatalListed(f), fatal: fatalList(f) } : {}), tell_the_user: tell } : {}) }; };
const fatalKinds = (f: Finding[]) => { const m = new Map<string, number>(); for (const x of f) if (x.severity === 'fatal') m.set(x.code, (m.get(x.code) ?? 0) + findingCount(x)); return [...m].map(([code, count]) => ({ code, count })); };

async function readMpp(path: string): Promise<{ db: Db; findings: Finding[] }> {
  let xml: Awaited<ReturnType<typeof mppToMspdi>>;
  try { xml = await mppToMspdi(path); }
  catch (e) {
    if (e instanceof StuckError) return fail('file_unreadable', `Cannot read ${basename(path)}: ${e.message}`, e.stuck.alternatives, { data: { cause: 'stuck', stuck: e.stuck } });
    if (e instanceof MppReaderMissing) return fail('mpp_reader_missing', e.message, 'Save the file as Microsoft Project XML in Microsoft Project (File > Save As > XML) and open that.');
    return fail('file_unreadable', `Cannot read ${basename(path)}: ${(e as Error).message}`, `Carry on outside the clone: ${outsideRoute('mpp')}.`);
  }
  const r = parseMspdi(xml);
  r.findings.push({ severity: 'info', code: 'MPP_READ', message: 'Read without Microsoft Project: MPXJ turned the .mpp into Microsoft Project XML, read as such (every task, resource, assignment and calendar element is kept: read_table, msp:<Name>).', p6: 'P6 imports .mpp through an installed Microsoft Project.' });
  return r;
}
const openProblemsOf = (db: Db) => new Map(p6Refusals(db).map((x) => [x.key, x.count] as const));
/** A project restored from a recovery entry written before the open-time list existed has none: the file it was opened from, read again, gives it
 *  (when that file is still the one opened: this project was never saved over it). False when that cannot be done. */
async function rebuildOpenProblems(s: Session): Promise<boolean> {
  try {
    if (!s.path || s.savedTo === s.path || !existsSync(s.path)) return false;
    const fmt = detectFormat(s.path, readHead(s.path));
    const r = fmt === 'mpp' ? await readMpp(s.path) : fmt === 'xer' ? readXerFile(s.path, 'auto') : readRaw(readBytes(s.path), fmt, 'auto');
    s.openProblems = openProblemsOf(r.db);
    return true;
  } catch { return false; }
}
/** The first 4,000 bytes of a file (what detectFormat reads). */
const readHead = (p: string): Uint8Array => { try { const fd = openSync(p, 'r'); try { const b = Buffer.alloc(4000); return new Uint8Array(b.subarray(0, readSync(fd, b, 0, 4000, 0))); } finally { closeSync(fd); } } catch (e) { return fail('file_unreadable', `Cannot read ${p}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}.`, 'Check the path (relative paths are taken from the storage root).'); } };
const readBytes = (p: string) => { try { return new Uint8Array(readFileSync(p)); } catch (e) { return fail('file_unreadable', `Cannot read ${p}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}.`, 'Check the path (relative paths are taken from the storage root).'); } };
/** Write a file atomically: a temporary file in the same folder, flushed to disk, then renamed over the target (a crash
 *  leaves the old file or the new one, never half of one). Missing folders inside the write root are made. */
let writeNotice: ((tmp: string) => void) | null = null;
const writeTag = { value: '' };
const writeOut = (p: string, data: string | Uint8Array) => writeOutWith(p, (put) => put(data));
/** writeOut for a file made piece by piece: `make` hands each piece to `put`, which goes to the temporary file in
 *  writes of about 4 MB, so a file larger than memory (a P6 XML of a big schedule) is never one string. */
const writeOutWith = (p: string, make: (put: (piece: string | Uint8Array) => void) => void) => {
  // (in a compute worker the name carries the job's tag, and is logged where the main thread can read it even if the worker is ended
  //  at once: the main thread removes the file if the call is ended meanwhile)
  const tmp = join(dirname(p), `.${basename(p)}.${writeTag.value}${randomBytes(4).toString('hex')}.p6clone-tmp`);
  writeNotice?.(tmp);
  try {
    if (writeBase()) mkdirSync(dirname(p), { recursive: true });
    const fd = openSync(tmp, 'w');
    try {
      const flush = (b: Uint8Array) => { for (let at = 0; at < b.length;) at += writeSync(fd, b, at, b.length - at); };
      let held: string[] = [], size = 0;
      // a piece cut inside a surrogate pair (text cut every n characters) keeps its first half for the next write
      const out = (last: boolean) => {
        if (!held.length) return;
        let t = held.join(''); held = []; size = 0;
        const c = t.charCodeAt(t.length - 1);
        if (!last && c >= 0xd800 && c <= 0xdbff) { held = [t.slice(-1)]; size = 1; t = t.slice(0, -1); }
        flush(Buffer.from(t, 'utf8'));
      };
      make((piece) => {
        if (typeof piece !== 'string') { out(true); flush(piece); return; }
        held.push(piece); size += piece.length;
        if (size >= 4194304) out(false);
      });
      out(true); fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, p);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* gone */ }
    // the file system's refusals (EACCES, ENOSPC, EBUSY...) are the file's; anything else is a bug in the writer, said as one
    if (e instanceof ToolError || !/^E[A-Z]+$/.test(String((e as { code?: unknown }).code ?? ''))) throw e;
    fail('file_unwritable', `Cannot write ${p}: ${(e as Error).message}.`, 'Check that the folder exists and the file is not open elsewhere.');
  }
};
/** One page of compare's changes: max_changes (default 500; no cap) from offset; next_offset for the rest. */
const changesPage = <T,>(all: T[], a: Record<string, any>) => {
  const asked = countArg(a.max_changes, 'max_changes'), max = asked === 0 ? Infinity : asked ?? 500, offset = countArg(a.offset, 'offset') ?? 0;
  const changes = all.slice(offset, offset + max), next = offset + changes.length < all.length ? offset + changes.length : null;
  return { changes, truncated: next != null, ...(offset || next != null ? { offset, next_offset: next } : {}) };
};
const fileSize = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
const iso = (t: number | null | undefined) => (t == null || !Number.isFinite(t) ? null : formatP6Date(t));
/** Between phases of long work: let waiting messages in (a cancellation), then stop if this call was cancelled. */
const checkpoint = async (ctx: Ctx) => { await new Promise((r) => setImmediate(r)); if (ctx.signal.aborted) fail('cancelled', 'The call was cancelled.', 'Nothing was kept or written by it; call again when needed.'); };

// ---------------------------------------------------------------- tool implementations
type Ctx = { caller: string; job?: ReturnType<typeof startJob>; signal: AbortSignal; progress?: (done: number, total: number, message: string) => void; /** a finished row of the answer, sent out as it is done (a compute worker keeps it if it is ended) */ keep?: (row: unknown) => void; /** in a compute worker: how a run claims its kept file on the server's main thread (keptRuns.ts) */ claim?: Claim };

/** monte_carlo's run-only inputs (events, sampler, re_anchor, deadline) for the engine; bad ones are refused. */
function monteCarloInputs(s: Session, ids: string[], a: Record<string, any>): Pick<MonteCarloOptions, 'events' | 'sampler' | 'reAnchor' | 'deadline'> {
  const dh = dayHours(s.db, s.hpd, true);
  const tasks = (s.db.tables.TASK?.rows ?? []).filter((t) => ids.includes(t.proj_id));
  const proj = s.db.tables.PROJECT.rows.find((p) => p.proj_id === ids[0]);
  const n = (v: unknown, what: string) => { const x = Number(v); return Number.isFinite(x) ? x : fail('bad_input', `${what} must be a number.`, 'See the monte_carlo description.'); };
  const events = a.events == null ? undefined : (Array.isArray(a.events) ? a.events : fail('bad_input', '"events" must be a list.', 'events: [{name, probability, delay_days, activities?}]')).map((e: any, i: number) => {
    const p = e?.probability_pct != null ? n(e.probability_pct, `events[${i}].probability_pct`) / 100 : n(e?.probability, `events[${i}].probability`);
    if (!(p >= 0 && p <= 1)) fail('bad_input', `events[${i}]: probability must be between 0 and 1 (or probability_pct 0-100).`, 'Give the chance the event happens.');
    const acts = Array.isArray(e.activities) ? e.activities.map((c: unknown) => tasks.find((t) => t.task_code === String(c)) ?? fail('bad_input', `events[${i}]: no activity "${c}".`, 'Use Activity IDs of the project.')) : [];
    const hours = (t?: Row) => (e.delay_hours != null ? n(e.delay_hours, `events[${i}].delay_hours`) : n(e.delay_days, `events[${i}].delay_days`) * (t ? dh.task(t) : dh.cal(proj?.clndr_id)));
    return { name: String(e.name ?? `Event ${i + 1}`), p, taskHours: acts.map((t: Row) => [t.task_id, hours(t)] as [string, number]), projectHours: acts.length ? 0 : hours() };
  });
  let sampler: Sampler | undefined;
  if (a.sampler != null) {
    const x = a.sampler, scope = x.scope === 'unestimated' ? 'unestimated' : 'all';
    const normal = (y: any, at: string) => ({ ...(y?.mean != null ? { mean: n(y.mean, `${at}.mean`) } : {}), ...(y?.std != null ? { std: n(y.std, `${at}.std`) } : {}), ...(y?.min_ratio != null ? { minRatio: n(y.min_ratio, `${at}.min_ratio`) } : {}), ...(y?.max_ratio != null ? { maxRatio: n(y.max_ratio, `${at}.max_ratio`) } : {}) });
    if (x.type === 'ratio_normal') sampler = { type: 'ratio_normal', ...normal(x, 'sampler'), scope };
    else if (x.type === 'ratio_empirical') {
      const ratios = Array.isArray(x.ratios) && x.ratios.length ? x.ratios.map((v: unknown, i: number) => n(v, `sampler.ratios[${i}]`)) : fail('bad_input', 'sampler.ratios must be a list of numbers.', 'e.g. {type: "ratio_empirical", ratios: [...at least 10 history ratios], weight: 0.66}');
      const weight = x.weight == null ? 0.66 : typeof x.weight === 'number' && x.weight >= 0 && x.weight <= 1 ? x.weight : fail('bad_input', 'sampler.weight must be a number from 0 to 1: the chance a ratio is drawn from ratios (else from the normal).', 'e.g. weight: 0.66');
      sampler = { type: 'ratio_empirical', ratios, weight, ...(x.normal != null ? { normal: normal(x.normal, 'sampler.normal') } : {}), scope };
    } else fail('bad_input', 'sampler.type must be ratio_normal or ratio_empirical.', 'See the monte_carlo description.');
  }
  return { events, sampler, reAnchor: a.re_anchor === true, ...(a.deadline != null ? { deadline: dd(a.deadline) ?? fail('bad_input', 'deadline must be a date YYYY-MM-DD.', 'The date to give the chance of finishing by.') } : {}) };
}
const NO_HANDLE = new Set(['open_file', 'new_project', 'compute_schedule', 'list_open', 'server_status', 'job_status', 'cancel_job']);
/** Tools that can change a project (their answers carry unsaved_changes). */
const MUTATES = new Set(TOOLS.filter((t) => !t.annotations.readOnlyHint && !['list_open', 'server_status', 'job_status', 'cancel_job'].includes(t.name)).map((t) => t.name));

async function run(name: string, a: Record<string, any>, ctx: Ctx): Promise<unknown> {
  // a tool outside P6CLONE_TOOLSETS is not there at all: listed or called (L-8)
  if (TOOLS.some((t) => t.name === name) && !toolsList().some((t) => t.name === name)) fail('unknown_tool', `${name} is not offered by this server (P6CLONE_TOOLSETS=${process.env.P6CLONE_TOOLSETS}).`, 'tools/list shows the tools.');
  if (name === 'open_model' && a.discard_kept === true) return discardKeptMeshing(a.path);
  // export (the analysis tools): a folder outside the write root, or one that cannot be made, is refused before anything is worked out or changed
  if ((TOOLS.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.export) {
    if (a.export != null) exportFolder(a.export);
    exportName(a.export_name, a.export != null, name); // export_name: a bad name, or one with no folder, is refused here too
  }
  switch (name) {
    case 'list_open': return { open: [...sessions.values()].map((s) => ({ handle: s.handle, file: s.path, projects: allIds(s.db).map((id) => s.db.tables.PROJECT.rows.find((p) => p.proj_id === id)?.proj_short_name), unsaved_changes: s.dirty, changes: s.history.length })), moved_out: evictedList() };
    case 'server_status': return { version: VERSION, ...status(), recovery: recoveryStatus(), reasoner: reasonerState(reasonerStatus, reasonerModelPath) };
    case 'job_status': {
      const job = getJob(a.job_id);
      const wait = Math.min(20, Math.max(0, Number(a.wait_seconds) || 0)) * 1000;
      // the agent may ask to be woken again if the job still shows no progress after wake_after_s (its own choice; nothing is stopped)
      if (Number(a.wake_after_s) > 0) askWake(job, Number(a.wake_after_s));
      for (const t0 = Date.now(); !job.done && Date.now() - t0 < wait;) await new Promise((r) => setTimeout(r, 200));
      return jobView(job);
    }
    case 'cancel_job': { const job = getJob(a.job_id); job.abort?.abort(); return { job_id: job.id, cancel_requested: true, note: ['monte_carlo', 'open_file', 'save', 'schedule', 'evaluate_batch', 'crash_schedule', 'optimize_schedule', 'windows_analysis', 'lint', 'render_4d', 'lob_create', 'lob_edit', 'lob_takt', 'lob_import'].includes(job.tool) ? 'The job stops at its next step.' : 'This kind of job cannot be interrupted; it will finish its current step.' }; }
    case 'open_file': {
      const path = pathArg(a.path);
      // an XER is read from its file a chunk at a time; the other formats are read whole (XML trees, MPX)
      const head = readHead(path), size = fileSize(path), format0 = detectFormat(path, head);
      const bytes = format0 === 'xer' ? null : readBytes(path);
      const need = estimateBytes(size);
      // reserve the memory first, so a big file is refused (with a way forward) instead of exhausting the process: the
      // project as it stays in memory, and while it is read the reader's own peak above that (workset.ts READ_PEAK)
      const s0 = createSession({ tables: {} }, { path, format: 'xer', hpd: Number(a.hours_per_day) || 8, bytes: need, dirty: false });
      const heap0 = size >= MEASURE_FILE_BYTES ? heapNow() : 0; // (a big file: what the project holds is measured once it is read)
      let reading = () => {};
      try { const peak = readPeak(format0, size); if (peak > need) reading = reserveMemory(peak - need, `Reading ${basename(path)} (${Math.round(size / 1048576)} MB)`, 'save it as XER from P6 or Microsoft Project (the XER reader needs the least), or split it by project', s0.handle); }
      catch (e) { closeSession(s0); forgetEvicted(s0.handle); throw e; }
      try {
        await checkpoint(ctx);
        const format = format0;
        const r: { db: Db; findings: Finding[]; meta?: ParseMeta } = format === 'mpp' ? await readMpp(path) : bytes ? readRaw(bytes, format, a.encoding ?? 'auto') : readXerFile(path, a.encoding ?? 'auto');
        await checkpoint(ctx);
        const f = importChecks(r.db, r.findings, format);
        await checkpoint(ctx);
        const fatal = worst(f) === 'fatal';
        // lenient: the file is opened to be repaired, when there is a project to hold (a file that could not be read has none)
        if (fatal && !(a.lenient === true && allIds(r.db).length)) {
          // what P6 refuses (every kind, with its count, and the first few in words; the total is said when the words are cut), and how to
          // carry on: lenient first when there is a project to repair, else (or if that fails) the file read as text outside the clone
          const bad = f.filter((x) => x.severity === 'fatal'), total = fatalTotal(f), listed = fatalListed(f), kinds = fatalKinds(f), shown = 3;
          const noProject = !allIds(r.db).length, cause = bad.slice(0, shown).map((x) => x.message).join(' ');
          fail('p6_would_reject', `P6 would reject ${basename(path)}: ${total} fatal finding${total === 1 ? '' : 's'} (${kinds.map((k) => `${k.code} x${k.count}`).join(', ')}). ${cause}${bad.length > shown ? ` (the first ${shown} of ${total}; data.fatal lists ${listed} of the ${total} in words, a \u201c\u2026and N more\u201d line standing for the rest of its kind)` : ''}`,
            noProject
              ? `The clone could not read a project from this file, so lenient: true cannot open it either. Carry on outside the clone: ${outsideRoute(format, head)}.`
              : `1. Call open_file again with lenient: true: the clone repairs what it can and opens it, and says what it repaired; work on that, and tell the user the file as given is one P6 itself would refuse and why. 2. If it still cannot be opened, ${outsideRoute(format, head)}.`,
            { data: { fatal_total: total, fatal_kinds: kinds, fatal_listed: listed, fatal: fatalList(f), diagnostics: brief(f) } });
        }
        s0.db = r.db; s0.openProblems = openProblemsOf(r.db); s0.format = format; /* (openProblems: what P6 would reject in the file as it is; save refuses only what edits add) */ s0.encoding = r.meta ? xerEncoding(r.db, r.meta) : readEncoding(bytes!, format, r.db, a.encoding);
        if (size >= MEASURE_FILE_BYTES) { s0.bytes = retainedBytes(heap0); } // what the project really holds (heap after a full gc, +25 % for undo and schedule work), and the parse's garbage given back
        load4dSidecar(r.db, path); // <file>.4d.json: the 4D model and links saved with it
        // <file>.lob.json: the LOB models as last saved (used when a notebook was damaged outside the clone)
        const lobSide = readLobSidecar(path);
        if (lobSide) lobSidecars.set(s0.handle, lobSide);
        const lobInfo = [...loadLobModels(r.db, lobSide)].map(([pid, x]) => ({ project: r.db.tables.PROJECT.rows.find((p) => p.proj_id === pid)!.proj_short_name, model_from: x.from, ...(x.problems.length ? { problems: x.problems } : {}) }));
        const lob = lobInfo.length ? { lob: lobInfo } : {};
        // opened from a Microsoft Project file (by its format: the .mpx / MSPDI content the reader saw): Project's rules
        if (format === 'mspdi' || format === 'mpx' || format === 'mpp') for (const p of r.db.tables.PROJECT?.rows ?? []) if (p._msp_source !== 'Y') { addField(r.db.tables.PROJECT, '_msp_source'); p._msp_source = 'Y'; }
        // activities P6 does not load (rows made from damaged lines, no readable id): named with their line, so a reader
        // of the file's rows (read_table) knows they are not activities; a save with repair removes them
        const unreadable = () => {
          const T = r.db.tables.TASK?.rows ?? [], at = new Map(T.map((t, i) => [t, i]));
          const list = [...unidentified(r.db).why].map(([t, why]) => { const i = at.get(t) ?? -1; return { table: 'TASK', row: i + 1, ...(r.meta?.taskLines?.[i] ? { line: r.meta.taskLines[i] } : {}), task_id: t.task_id ?? '', activity_id: String(t.task_code ?? '').slice(0, 60), reason: why }; }).sort((x, y) => x.row - y.row);
          return list.length ? { unreadable_rows: { total: list.length, rows: list.slice(0, 500), note: 'TASK rows P6 does not load as activities (read_table still lists them as they are in the file); save with repair: true removes them.' } } : {};
        };
        if (a.lenient !== true) return { handle: s0.handle, owner_key: s0.ownerKey, file: basename(path), format, diagnostics: brief(f), summary: summary(s0), ...unreadable(), ...lob };
        // lenient: repair what can be repaired without guessing (key columns, ids), then judge the file again
        const fix = repairKeys(r.db);
        const g = fix.repaired.length ? importChecks(r.db, r.findings, format) : f;
        await checkpoint(ctx);
        if (fix.repaired.length) s0.dirty = true; // the repairs reach the file with the next save
        const still = worst(g) === 'fatal' || g.some((x) => x.code === 'EMPTY_KEY');
        // errors left as they are (repairing them would mean guessing or cutting data): named, so nothing is a surprise
        const left = new Map<string, Finding[]>();
        for (const x of g) if (x.severity === 'fatal' || x.severity === 'error') { const l = left.get(x.code); if (l) l.push(x); else left.set(x.code, [x]); }
        for (const [code, xs] of left) fix.not_repaired.push(`${code} x${xs.length} (${xs[0].severity}) not repaired: ${xs[0].message}${xs[0].p6 ? ` P6: ${xs[0].p6}` : ''}`);
        // the file as given: said every time, so the answer to the user can say it (a repaired copy is not the user's file)
        // (every fatal finding is listed here: diagnostics.findings shows the first 40 findings only)
        const asGiven = fileAsGiven(f, 'The file as given is one P6 itself would refuse (fatal_kinds, every one in fatal); this project is the clone\'s repaired copy of it (diagnostics.repaired says what was repaired, not_repaired what was left).', { list: true });
        return {
          handle: s0.handle, owner_key: s0.ownerKey, file: basename(path), format, lenient: true, still_rejected: still, file_as_given: asGiven,
          note: (fatal ? 'The file as given is one P6 itself would refuse (file_as_given says why): tell the user so. ' : '') + (still ? 'P6 would still reject this project if it were saved now: the fatal findings in diagnostics (and not_repaired) were not repaired automatically. Fix them with edit operations before P6 gets the file.'
            : fix.repaired.length ? 'Opened with repairs (diagnostics.repaired): a save writes a file P6 imports.' : 'Opened; nothing needed repairing.'),
          diagnostics: { ...brief(g), repaired: fix.repaired, not_repaired: fix.not_repaired, ...(fix.repaired.length ? { before_repairs: { verdict: worst(f) ?? 'clean', counts: brief(f).counts } } : {}) }, summary: summary(s0), ...unreadable(), ...lob,
        };
      } catch (e) { closeSession(s0); throw e; } finally { reading(); }
    }
    case 'compute_schedule': { const r = computeSchedule(a); return r.ok ? r : { ok: false, error: { ...r.error, hint: r.error.code === 'schedule_failed' ? 'Fix the reported problem (or pass break_loops: true for loops) and call again.' : 'Fix that part of the input (where says which) and call again.' } }; }
    case 'new_project': {
      const db: Db = { tables: {} };
      const r = applyOps(db, [{ op: 'add_project', id: a.id, name: a.name ?? a.id, start: a.start, ...(a.must_finish_by ? { must_finish_by: a.must_finish_by } : {}) }]);
      if (!r.ok) fail('bad_input', r.error!.message, 'Give id (Project ID) and start (YYYY-MM-DD).');
      const s = createSession(db, { path: null, format: 'xer', hpd: Number(a.hours_per_day) || 8, bytes: 8 * 1048576, dirty: true });
      s.openProblems = new Map(); // (nothing in it yet: whatever a later edit leaves that P6 rejects is that edit's)
      return { handle: s.handle, owner_key: s.ownerKey, project: a.id };
    }
  }

  const s = getSession(a.handle);
  // the main thread only routes: a tool that can run long works on a copy of its project in a worker thread (compute.ts)
  if (isMainThread && offloads(name, a)) { const r = await offload(name, a, s, ctx); if (r !== RUN_HERE) return r; }
  switch (name) {
    case 'edit': {
      // Microsoft Project has no project notebook to put one in (its project notes are one plain text on the summary
      // task, without topics, and the clone does not write notebooks to its files): refused, not silently lost
      const ops = Array.isArray(a.operations) ? a.operations : [];
      const pn = ops.findIndex((o: any) => o?.op === 'set_notebook' && (o.activity == null || o.activity === ''));
      if (pn >= 0 && (s.format === 'mspdi' || s.format === 'mpx')) return { ok: false, error: { code: 'unsupported_for_format', index: pn, op: ops[pn], format: s.format, message: `A project notebook cannot be kept in a ${s.format === 'mpx' ? 'MPX' : 'Microsoft Project XML'} file: Microsoft Project has no notebook topics, and its project notes do not map onto a P6 notebook.`, hint: 'Nothing was changed. Save the project as XER or P6 XML (save with format xer or p6xml), open that, and set the notebook there; or put the text on an activity notebook.' } };
      // an LOB plan's activities: their structure is the plan's (lob_edit), progress and the rest are free
      // a select's activities checked one by one (link_activities and renumber_activities included)
      const lobRefusal = lobGuard(s.db, ops.some((o: any) => o?.select !== undefined) ? expandSelects(s.db, ops) : ops);
      if (lobRefusal) return { ok: false, error: { code: 'op_failed', message: lobRefusal, hint: 'Use lob_edit for an LOB plan’s durations, crews, locations and logic; progress, notes, resources and other codes edit as usual.' } };
      let r!: ReturnType<typeof applyOps>;
      try { change(s, ctx.caller, 'Edit', (d) => { r = applyOps(d, a.operations, { hoursPerDay: s.hpd, calendarDays: true }); if (!r.ok) throw new Error('refused'); }); }
      catch (e) { if (r && !r.ok) return { ok: false, error: { code: 'op_failed', ...r.error, hint: 'Fix that operation (the message says what is wrong) and send the list again; nothing was changed.' } }; throw e; }
      s.history[s.history.length - 1].label = `Edit (${r.applied} operation${r.applied === 1 ? '' : 's'})`;
      return r;
    }
    case 'evaluate': {
      let options: ReturnType<typeof parseScheduleOptions> = {};
      if (a.options != null) { try { options = parseScheduleOptions(a.options, (m) => { throw new Error(m); }, s.hpd); } catch (e) { fail('bad_input', (e as Error).message, `Options: ${SCHEDULE_OPTIONS_GUIDE}.`); } }
      if (a.overrides != null && !Array.isArray(a.overrides)) fail('bad_input', '"overrides" must be a list of edit operations.', 'e.g. [{"op":"update_activity","id":"A1000","duration_days":15}]');
      const ev = evaluate(s.db, a.project != null && a.project !== '' ? projectIds(s.db, a.project) : allIds(s.db), { overrides: a.overrides ?? [], options, dataDate: dd(a.data_date) ?? undefined, hoursPerDay: s.hpd, maxRows: a.export != null ? Infinity : Number(a.max_rows) || undefined });
      if (a.export == null || !ev.ok) return ev;
      // the export: every changed activity (the answer lists max_rows of them, default 500; changed_total says how many there are)
      // (one row per field that changed; an added activity's fields come from nothing, a deleted one is a row of its own)
      const evRows = (ev.changed as { id: string; [k: string]: unknown }[]).flatMap((c) => (c.deleted ? [{ id: c.id, change: 'deleted' }] : Object.entries(c).filter(([, v]) => Array.isArray(v)).map(([field, v]) => ({ id: c.id, change: c.added ? 'added' : 'changed', field, before: (v as unknown[])[0], after: (v as unknown[])[1] }))));
      return { ...ev, changed: ev.changed.slice(0, Number(a.max_rows) || 500), exported: exportResult('evaluate', a.export, ev, [
        { name: 'changed', columns: ['id', 'change', 'field', 'before', 'after'], rows: evRows },
        { name: 'critical_changes', columns: ['id', 'change'], rows: [...ev.became_critical.map((id: string) => ({ id, change: 'became_critical' })), ...ev.no_longer_critical.map((id: string) => ({ id, change: 'no_longer_critical' }))] },
      ], writeOutWith, { name: a.export_name }) };
    }
    case 'list_tables': { let ids: string[] | null; try { ids = projectFilter(s.db, a.project); } catch (e) { return fail('bad_input', (e as Error).message, 'Leave project out for every table and project.'); } return { tables: listTables(s.db, ids) }; }
    case 'read_table': {
      if (typeof a.table !== 'string' || !a.table) fail('bad_input', 'table is required.', 'list_tables names the tables.');
      try { return readTable(s.db, a.table, projectFilter(s.db, a.project), { offset: a.offset, limit: a.limit, columns: Array.isArray(a.columns) ? a.columns.map(String) : undefined }); }
      catch (e) { if (e instanceof RangeError) return fail('bad_input', e.message, 'list_tables gives the tables and their columns.'); throw e; }
    }
    case 'activity_table': if (a.of === 'assignments' || a.of === 'codes') return linkTable(s.db, a.project != null && a.project !== '' ? projectIds(s.db, a.project) : allIds(s.db), a.of, { offset: a.offset, limit: a.limit, hoursPerDay: s.hpd });
      if (a.of != null && a.of !== 'activities') fail('bad_input', 'of must be activities, assignments or codes.', 'Leave it out for the activities.');
      return activityTable(s.db, a.project != null && a.project !== '' ? projectIds(s.db, a.project) : allIds(s.db), { offset: a.offset, limit: a.limit, names: a.names === true, hoursPerDay: s.hpd });
    case 'schedule': {
      const t = dd(a.data_date);
      let over: ReturnType<typeof parseScheduleOptions> = {};
      if (a.options != null) { if (typeof a.options !== 'object') fail('bad_input', '"options" must be an object.', SCHEDULE_OPTIONS_GUIDE); try { over = parseScheduleOptions(a.options, (m) => { throw new Error(m); }, s.hpd); } catch (e) { fail('bad_input', (e as Error).message, `Options: ${SCHEDULE_OPTIONS_GUIDE}.`); } }
      if (a.break_loops === true) over.breakLoops = true;
      const only = a.project != null && a.project !== '' ? projectIds(s.db, a.project)[0] : null;
      await checkpoint(ctx);
      // a project read from Microsoft Project XML in which nothing that drives the dates changed keeps Microsoft
      // Project's own dates: F9 leaves it alone (a new data date for it is a change)
      const name = (id: string) => s.db.tables.PROJECT.rows.find((p) => p.proj_id === id)!.proj_short_name;
      const keptMsp = allIds(s.db).filter((id) => (t == null || (only != null && id !== only)) && mspUntouched(s.db, id) === true);
      const todo = allIds(s.db).filter((id) => !keptMsp.includes(id));
      const kept = keptMsp.length ? { kept_msp_dates: keptMsp.map(name), note: `Not rescheduled: ${keptMsp.map(name).join(', ')} came from Microsoft Project and nothing that drives its dates changed since, so Microsoft Project's own dates stand.` } : {};
      if (!todo.length) {
        // the same answer shape as a real F9, from the dates Microsoft Project wrote
        const ids = new Set(keptMsp), tasks = (s.db.tables.TASK?.rows ?? []).filter((x) => ids.has(x.proj_id));
        const finish = tasks.reduce((m, x) => Math.max(m, parseP6Date(x.act_end_date || x.early_end_date || x.target_end_date) ?? -Infinity), -Infinity);
        const dataDate = minOf(keptMsp.map((id) => parseP6Date(s.db.tables.PROJECT.rows.find((p) => p.proj_id === id)!.last_recalc_date) ?? Infinity));
        return { ok: true, ...kept, loops: [], data_date: iso(dataDate), finish: iso(finish), stats: { activities: tasks.length, dataDate, finish: Number.isFinite(finish) ? finish : null, kept_msp_dates: true }, warnings: [] };
      }
      const was = s.dirty;
      const res = change(s, ctx.caller, 'Schedule', (d) => {
        // with "project" the data date moves on that project only; the others schedule on their own
        if (only && t != null) d.tables.PROJECT.rows.find((p) => p.proj_id === only)!.last_recalc_date = formatP6Date(t);
        const x = scheduleWithLob(d, todo, s.hpd, { ...over, ...(t != null && !only ? { dataDate: t } : {}) }, lobSidecars.get(s.handle)).schedule; if (x.ok) syncAssignmentDates(d); return x;
      });
      if (!res.ok) { dropLast(s); return { ok: false, loops: res.loops ?? [], error: { code: 'schedule_failed', message: res.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' '), hint: res.loops?.length ? 'The network has loops (loops lists them): fix the logic, or schedule with break_loops: true to leave out the links that close them for this run; nothing was changed.' : 'Fix the reported problem (often a missing calendar) and schedule again; nothing was changed.' } }; }
      const code = new Map((s.db.tables.TASK?.rows ?? []).map((x) => [x.task_id, x.task_code]));
      const loopInfo = { loops: res.loops ?? [], ...(over.breakLoops ? { broken_links: (res.broken ?? []).map((x) => ({ pred: code.get(x.pred_task_id) ?? x.pred_task_id, succ: code.get(x.task_id) ?? x.task_id, type: (x.pred_type || 'PR_FS').slice(3) })) } : {}) };
      try { await checkpoint(ctx); } catch (e) { dropLast(s); s.dirty = was; throw e; }
      // F9 on a project from Microsoft Project XML: say which of Microsoft Project's dates the clone's schedule replaced
      const fromMsp = todo.filter((id) => mspUntouched(s.db, id) !== null);
      const mspChanged = fromMsp.length ? { msp_dates_changed: Object.fromEntries(fromMsp.map((id) => [name(id), mspDateChanges(s.db, id)])) } : {};
      return { ok: true, ...kept, ...mspChanged, ...loopInfo, ...(only ? { project: s.db.tables.PROJECT.rows.find((p) => p.proj_id === only)!.proj_short_name } : {}), data_date: iso(only ? res.projects[only].dataDate : res.stats.dataDate), finish: iso(res.stats.finish), stats: res.stats, log: a.log === false ? undefined : scheduleLogReport(s.db, todo, res, a.log_max_ids != null ? Math.max(0, Number(a.log_max_ids)) : 100), warnings: res.findings.filter((f) => f.severity !== 'info').slice(0, 30).map((f) => f.message) };
    }
    case 'update_progress': {
      const t = dd(a.data_date) ?? fail('bad_input', 'Give data_date.', 'The new data date, YYYY-MM-DD.');
      const res = change(s, ctx.caller, 'Update Progress', (d) => { const by = Object.fromEntries(allIds(d).map((id) => [id, updateProgress(d, id, t)])); const x = scheduleWithLob(d, allIds(d), s.hpd, { dataDate: t }, lobSidecars.get(s.handle)).schedule; if (x.ok) syncAssignmentDates(d); return { ok: x.ok, finish: iso(x.stats.finish), progress: by, errors: x.findings.filter((f) => f.severity === 'error').map((f) => f.message) }; });
      if (!res.ok) { dropLast(s); return { ok: false, error: { code: 'schedule_failed', message: res.errors.join(' '), hint: 'Scheduling failed, so the progress update was undone; fix the problem and try again.' } }; }
      return res;
    }
    case 'import_file': {
      const action = String(a.action ?? '');
      if (!['new', 'replace', 'update', 'add_into'].includes(action)) fail('bad_input', 'action must be new, replace, update or add_into.', 'update: Update Existing Project (matched objects updated, new ones added).');
      const data = importActions(a.data, IMPORT_DATA, ['update', 'keep', 'skip', 'remove_missing'] as const, 'data');
      for (const [t, x] of Object.entries(data)) if (x === 'remove_missing' && !REMOVABLE.includes(t)) fail('bad_input', `remove_missing is for activities, relationships and assignments, not ${t}.`, 'Use update, keep or skip.');
      if (Object.keys(data).length && action !== 'update') fail('bad_input', 'data actions apply to action: update.', 'Leave data out, or use action update.');
      const dict = importActions(a.dictionaries, IMPORT_DICT, ['keep', 'update', 'insert', 'skip'] as const, 'dictionaries');
      const target = action === 'new' ? undefined : projectOf(s.db, a.project, 'This file');
      if (target?._baseline_of) fail('bad_input', `${target.proj_short_name} is a baseline.`, 'Import into the project itself.');
      const { db: src, release, asGiven } = await readOther(a, 'import');
      try {
        const theirs = (src.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of);
        const from = a.from_project != null ? [projectOf(src, a.from_project, 'The file')] : action === 'new' ? theirs : [projectOf(src, undefined, 'The file')];
        let wbsId: string | undefined;
        if (action === 'add_into' && a.wbs != null) {
          const ws = (s.db.tables.PROJWBS?.rows ?? []).filter((w) => w.proj_id === target!.proj_id && w.wbs_short_name === String(a.wbs));
          if (ws.length !== 1) fail('bad_input', ws.length ? `More than one WBS of code ${a.wbs}.` : `No WBS ${a.wbs} in ${target!.proj_short_name}.`, 'list_wbs lists the WBS codes.');
          wbsId = ws[0].wbs_id;
        }
        const plan: ImportPlan = { projects: from.map((p) => ({ srcProjId: p.proj_id, action: action as ProjectAction, targetProjId: target?.proj_id, wbsId })), dict, data };
        if (action === 'new') for (const b of (src.tables.PROJECT?.rows ?? []).filter((p) => p._baseline_of && from.some((f) => f.proj_id === p._baseline_of))) plan.projects.push({ srcProjId: b.proj_id, action: 'new' }); // their baselines come with them
        const run = (d: Db) => { const r = importIntoDb(d, src, plan); return { projects: r.projIds.map((id) => d.tables.PROJECT.rows.find((p) => p.proj_id === id)?.proj_short_name), counts: r.counts, findings: r.findings.map((f) => ({ severity: f.severity, code: f.code, message: f.message })) }; };
        if (a.dry_run === true) { let out!: ReturnType<typeof run>; const j = record(s.db, (d) => { out = run(d); }); rollback(j); return { dry_run: true, ...out, ...(asGiven ? { file_as_given: asGiven } : {}) }; }
        const out = change(s, ctx.caller, `Import (${action})`, run);
        regrow(s); // what the project now holds with the imported rows
        return { ...out, ...(asGiven ? { file_as_given: asGiven } : {}) };
      } finally { release(); }
    }
    case 'transfer_progress': {
      changesPage([], a); // max_changes and offset are refused here, before the transfer changes anything
      const by = String(a.match ?? 'activity_id') as MatchBy;
      if (!['activity_id', 'name', 'code', 'udf', 'pairs'].includes(by)) fail('bad_input', 'match must be activity_id, name, code, udf or pairs.', 'activity_id when both schedules share Activity IDs.');
      if (by === 'code' && !a.code_type) fail('bad_input', 'match code needs code_type.', 'The activity code type whose value names their activity.');
      if (by === 'udf' && !a.udf) fail('bad_input', 'match udf needs udf.', 'The activity UDF whose value names their activity.');
      if (by === 'pairs' && !Array.isArray(a.pairs)) fail('bad_input', 'match pairs needs pairs: [{from, to}].', 'from: their Activity ID; to: this project\'s.');
      const include = a.include == null ? undefined : typeof a.include === 'object' ? a.include : fail('bad_input', 'include must be {part: true|false}.', `Parts: ${PARTS.join(', ')}.`);
      for (const k of Object.keys(include ?? {})) if (!(PARTS as readonly string[]).includes(k)) fail('bad_input', `include: unknown part "${k}".`, `Parts: ${PARTS.join(', ')}.`);
      if (a.costs != null && a.costs !== 'recompute' && a.costs !== 'copy') fail('bad_input', 'costs must be recompute or copy.', 'recompute: this project\'s own rates.');
      if (a.data_date != null && a.data_date !== 'from' && !dd(a.data_date)) fail('bad_input', 'data_date must be "from" or a date.', 'e.g. "from" or 2026-03-02.');
      const target = projectOf(s.db, a.project, 'This file');
      if (target._baseline_of) fail('bad_input', `${target.proj_short_name} is a baseline.`, 'Transfer onto the project itself.');
      const { db: src, release, asGiven } = await readOther(a, 'transfer progress from');
      try {
        const from = a.from_project != null ? [projectOf(src, a.from_project, 'Their file')] : (src.tables.PROJECT?.rows ?? []).filter((p) => !p._baseline_of);
        const spec: TransferSpec = { from: src, fromProjIds: from.map((p) => p.proj_id), toProjId: target.proj_id, by, codeType: a.code_type, fromCodeType: a.from_code_type, udf: a.udf, fromUdf: a.from_udf, pairs: a.pairs?.map((x: any) => ({ from: String(x?.from ?? ''), to: String(x?.to ?? '') })), include, costs: a.costs, addAssignments: a.add_assignments === true, dataDate: a.data_date == null ? undefined : String(a.data_date) };
        const run = (d: Db) => { const r = transferProgress(d, spec); if ('error' in r) throw new ToolError('bad_input', r.error, 'Check the match options (list_dictionaries lists code types and UDFs).'); return r; };
        // the answer sized for an agent: counts per changed field, the first max_changes changes (offset pages a dry run)
        // and the first 100 of each unmatched list with its count; thousands of activities stay a few kilobytes
        const brief = (r: ReturnType<typeof run>) => {
          const fields: Record<string, number> = {};
          for (const c of r.changes) for (const f of Object.keys(c.changed)) fields[f] = (fields[f] ?? 0) + 1;
          const cap = <T,>(l: T[]) => l.slice(0, 100);
          return { ...r, changed_fields: fields, ...changesPage(r.changes, { max_changes: a.max_changes ?? 100, offset: a.offset }), unmatched_from: cap(r.unmatched_from), unmatched_from_count: r.unmatched_from.length, ambiguous: cap(r.ambiguous), ambiguous_count: r.ambiguous.length,
            assignments: { ...r.assignments, unmatched: cap(r.assignments.unmatched), unmatched_count: r.assignments.unmatched.length }, expenses: { ...r.expenses, unmatched: cap(r.expenses.unmatched), unmatched_count: r.expenses.unmatched.length }, steps: { ...r.steps, unmatched: cap(r.steps.unmatched), unmatched_count: r.steps.unmatched.length } };
        };
        if (a.dry_run === true) { let out!: ReturnType<typeof run>; const j = record(s.db, (d) => { out = run(d); }); rollback(j); return { dry_run: true, ...brief(out), ...(asGiven ? { file_as_given: asGiven } : {}) }; }
        return { ...brief(change(s, ctx.caller, 'Transfer Progress', run)), ...(asGiven ? { file_as_given: asGiven } : {}) };
      } finally { release(); }
    }
    case 'level_resources': {
      const PB: Record<string, 'es' | 'tf' | 'priority'> = { early_start: 'es', es: 'es', total_float: 'tf', tf: 'tf', priority: 'priority' };
      const by = a.priority_by == null ? undefined : PB[String(a.priority_by).toLowerCase()] ?? fail('bad_input', 'priority_by must be early_start, total_float or priority.', 'Leave it out for early start.');
      const R = s.db.tables.RSRC?.rows ?? [], T = (s.db.tables.TASK?.rows ?? []).filter((t) => allIds(s.db).includes(t.proj_id));
      const list = (v: unknown, what: string) => (Array.isArray(v) ? v.map(String) : fail('bad_input', `${what} must be a list of IDs.`, `e.g. ${what}: ["A1000"]`));
      const rsrcIds = a.resources == null ? undefined : list(a.resources, 'resources').map((c) => R.find((r) => r.rsrc_short_name.toLowerCase() === c.toLowerCase())?.rsrc_id ?? fail('bad_input', `No resource "${c}".`, 'Use resource IDs (resource_summary lists them).'));
      const first = a.activity_priority == null ? undefined : list(a.activity_priority, 'activity_priority').map((c) => T.find((t) => t.task_code === c)?.task_id ?? fail('bad_input', `No activity "${c}".`, 'Use Activity IDs.'));
      const pct = a.over_allocation_pct == null ? undefined : Number(a.over_allocation_pct);
      if (pct != null && !(pct >= 0)) fail('bad_input', 'over_allocation_pct must be 0 or more.', 'e.g. 10 for 10 %.');
      const opts = { withinFloat: !!a.within_float, overAllocPct: pct, priority: by, rsrcIds, first };
      const answer = (r: ReturnType<typeof levelResources>) => ({ delayed: r.delayed, moved: r.moved.map((m) => ({ id: m.code, from: m.from, start: m.start, finish: m.finish })), peaks: r.peaks.map((p) => ({ resource: p.code, peak: p.peak, limit: p.limit, day: p.day, overallocated: p.overallocated })), report: r.log });
      // (leveling for real has changed the project before the export is written: a failure to write it is said beside the result)
      const levelOut = <T extends ReturnType<typeof answer>>(r: T) => {
        if (a.export == null) return r;
        const make = () => exportResult('level_resources', a.export, r, [
          { name: 'moved', columns: ['id', 'from', 'start', 'finish'], rows: r.moved },
          { name: 'peaks', columns: ['resource', 'peak', 'limit', 'day', 'overallocated'], rows: r.peaks },
        ], writeOutWith, { name: a.export_name });
        return { ...r, ...(a.dry_run === true ? { exported: make() } : exportAfterChange(make)) };
      };
      if (a.dry_run === true) { let out!: ReturnType<typeof answer>; const j = record(s.db, (d) => { out = answer(levelResources(d, allIds(d), opts)); }); rollback(j); return levelOut({ dry_run: true, ...out }); }
      return levelOut(change(s, ctx.caller, 'Level Resources', (d) => answer(levelResources(d, allIds(d), opts))));
    }
    case 'monte_carlo': {
      if (a.resume != null && (typeof a.resume !== 'string' || !a.resume.trim())) fail('bad_input', 'resume must be the path a stopped monte_carlo answered.', 'Pass that path exactly as given, or leave resume out to start over.');
      const ids = projectIds(s.db, a.project);
      // the counts, refused before any iteration runs when they are not whole numbers (and, in withWorkingSet, when they do not fit)
      const { iterations, top, buckets, days: dayBins } = monteCarloCounts(a);
      // default estimates only for this run: applied in a journal and rolled back afterwards
      const j = a.default_estimates ? record(s.db, (d) => { defaultEstimates(d, ids, Number(a.default_estimates.min_pct) || 90, Number(a.default_estimates.max_pct) || 125, a.default_estimates.dist ?? 'triangle'); }) : null;
      try {
        const mc = monteCarloInputs(s, ids, a);
        let last = 0;
        // every iteration is kept as it finishes (keptRuns.ts); in a compute worker the file's path goes out first, so the answer of a
        // worker that was ended names it
        // (one run at a time on a kept file: a second is refused as run_busy, naming the job that holds it)
        const store = new IterationFile(a.resume ?? null, ctx.claim ?? claimHere(() => ctx.job?.id), ctx.keep ? (path) => ctx.keep!({ resume: path }) : undefined);
        const r = await runMonteCarlo(s.db, ids, { iterations, seed: a.seed != null ? Number(a.seed) : undefined, riskEvents: a.risk_events === 'post' || a.risk_events === 'off' ? a.risk_events : 'pre', signal: ctx.signal, ...mc, store, samples: a.export != null, ...(ctx.keep ? { onIteration: (f: number) => ctx.keep!(f) } : {}),
          onProgress: (i) => { if (ctx.job) ctx.job.progress = `${i} of ${iterations} iterations`; const now = Date.now(); if (i === iterations || now - last > 250) { last = now; ctx.progress?.(i, iterations, `${i} of ${iterations} iterations`); } } }).finally(() => store.release());
        const wd = (x: number) => Math.round(x * 100) / 100;
        // top (default 25; 0 = all) and buckets (default 20, at least 5): monteCarloCounts, above
        // the finishes counted in bins of width w from lo (the last bin takes the latest finish)
        const bins = (lo: number, w: number, n: number) => {
          const hist = Array.from({ length: n }, (_, i) => ({ start: iso(lo + i * w), end: iso(lo + (i + 1) * w), count: 0, cum_pct: 0 }));
          for (const t of r.finishSamples) hist[Math.min(n - 1, Math.floor((t - lo) / w))].count++;
          let acc = 0; for (const b of hist) { acc += b.count; b.cum_pct = Math.round((acc / r.finishSamples.length) * 1000) / 10; }
          return hist;
        };
        const lo = r.min, hi = r.max;
        // histogram: "days": the engine's own whole-day bins (the Risks window's bars); else `buckets` equal bins
        const hist = dayBins ? r.histogram.map((b) => ({ start: iso(b.start), end: iso(b.end), count: b.count, cum_pct: b.cumPct })) : bins(lo, (hi - lo) / buckets || 1, buckets);
        const milestones = r.milestones.map((m) => ({ id: m.code, name: m.name, deterministic: iso(m.deterministic), P10: iso(m.P10), P50: iso(m.P50), P80: iso(m.P80), P90: iso(m.P90) }));
        // an activity's row as the export's criticality table has it (the answer lists the first `top`, the export all): the Risks window's grid reads it whole
        const criticalityRow = (x: (typeof r.activities)[number], exact = false) => ({ id: x.code, name: x.name, milestone: x.milestone, critical_pct: exact ? x.criticality : Math.round(x.criticality * 100) / 100, deterministic_finish: iso(x.deterministicFinish), mean_finish: iso(x.meanFinish), p50_finish: iso(x.p50Finish), p80_finish: iso(x.p80Finish), sensitivity: x.sensitivity, min_remaining_hours: x.minDur, mean_remaining_hours: x.meanDur, max_remaining_hours: x.maxDur });
        const criticality = r.activities.map((x) => criticalityRow(x));
        // the S-curve as the engine has it (a point for each finish date, thinned to about 200): what the chart draws
        const cumulative = r.cumulative.map((p) => ({ finish: iso(p.t), cum_pct: p.pct }));
        const sensitivity = r.sensitivity.map((x) => ({ id: x.code, name: x.name, correlation: Math.round(x.rho * 100) / 100 }));
        // the lists cut to `top` say how many there are
        const listed = (key: string, list: unknown[]) => ({ [key]: list.slice(0, top), [`${key}_total`]: list.length });
        const answer = {
          iterations: r.iterations, seed: r.seed, elapsed_seconds: Math.round(r.elapsedMs / 100) / 10, data_date: iso(r.dataDate),
          deterministic_finish: iso(r.deterministicFinish), chance_of_meeting_deterministic: Math.round(r.probDeterministic * 1000) / 10,
          finish: { P10: iso(r.percentiles.P10), P50: iso(r.percentiles.P50), P80: iso(r.percentiles.P80), P90: iso(r.percentiles.P90), mean: iso(r.mean), min: iso(r.min), max: iso(r.max), std_dev_days: Math.round(r.stdDevDays * 10) / 10 },
          histogram: hist, cumulative,
          ...listed('milestones', milestones), ...listed('criticality', criticality), ...listed('sensitivity', sensitivity),
          risk_events: r.risks.map((x) => ({ id: x.code, name: x.name, probability_pct: Math.round(x.probability * 1000) / 10, impact_days: Math.round((x.hours / s.hpd) * 10) / 10, activities: x.activities, triggered_pct: Math.round(x.triggeredPct * 10) / 10 })),
          working_days: { from: iso(r.days.from), hours_per_day: r.days.hoursPerDay, deterministic: wd(r.days.deterministic), mean: wd(r.days.mean), std: wd(r.days.std), min: wd(r.days.min), max: wd(r.days.max), P10: wd(r.days.P10), P50: wd(r.days.P50), P80: wd(r.days.P80), P90: wd(r.days.P90), sigma: r.days.sigma.map((x) => ({ k: x.k, days: wd(x.days), date: iso(x.date) })) },
          ...(r.probDeadline != null ? { deadline: { date: iso(mc.deadline!), probability_pct: Math.round(r.probDeadline * 1000) / 10 } } : {}),
          ...(r.events.length ? { events: r.events.map((x) => ({ name: x.name, probability_pct: Math.round(x.probability * 1000) / 10, triggered_pct: Math.round(x.triggeredPct * 10) / 10 })) } : {}),
          ...(r.partial ? { partial: true, stopped: r.partial.stopped, iterations_done: r.iterations, iterations_requested: r.partial.requested, ...(r.partial.error ? { error: r.partial.error } : {}), ...(r.partial.kept ? { resume: r.partial.kept } : {}) } : {}),
          ...(r.resumed ? { resumed_iterations: r.resumed } : {}),
          // kept iterations that did not check out (a power loss can leave zeros or old bytes), with every one after them: run again, said
          ...(r.redone ? { redone_iterations: r.redone, redone_note: `${r.redone} kept iteration${r.redone === 1 ? '' : 's'} did not check out (damaged, as a power loss can leave a file, or after a damaged one) and ${r.redone === 1 ? 'was' : 'were'} run again.` } : {}),
          // a finished run removed its kept file: named, so a copy of it elsewhere (the platform's mirror of the outputs) goes too
          ...(!r.partial && !r.keptNote && store.path ? { parts_removed: keptPlace(store.path) } : {}),
          note: r.partial ? `Partial: the run ${r.partial.stopped === 'cancelled' ? 'was cancelled' : 'failed'} after ${r.iterations} of ${r.partial.requested} iterations${r.partial.error ? ` (${r.partial.error})` : ''}; these statistics are of the ${r.iterations} that finished.${r.partial.kept ? ` The ${r.iterations} iterations are kept in ${r.partial.kept}: ${keepWords('monte_carlo', r.partial.kept, 'iterations')}` : ''}` : [r.keptNote, r.sensitivity.length || r.events.length ? undefined : 'No activity has a three-point estimate and no risk event applies: every iteration equals the deterministic schedule. Set estimates with the set_estimates edit operation, or pass default_estimates or a sampler.'].filter(Boolean).join(' ') || undefined,
        };
        if (a.export == null) return answer;
        // the export: every list whole, every iteration in the order it ran (a resumed run's kept ones first), the engine's own values
        const sm = r.samples!, day = 1440, d0 = Math.floor(r.min / day) * day;
        const mileKey = r.milestones.map((m, j, all) => (all.findIndex((x) => x.code === m.code) === j ? `${m.code}_finish` : `${m.code}_finish_${j + 1}`));
        const pct = (x: number) => x * 100;
        const full = {
          ...answer,
          // whole days from the earliest finish's day to the latest's
          histogram: bins(d0, day, Math.floor((r.max - d0) / day) + 1),
          milestones: r.milestones.map((m) => ({ id: m.code, name: m.name, deterministic: iso(m.deterministic), mean: iso(m.mean), P10: iso(m.P10), P50: iso(m.P50), P80: iso(m.P80), P90: iso(m.P90) })),
          criticality: r.activities.map((x) => criticalityRow(x, true)), // (exact; the answer's are to 2 decimals)
          sensitivity: r.sensitivity.map((x) => ({ id: x.code, name: x.name, correlation: x.rho })),
          risk_events: r.risks.map((x) => ({ id: x.code, name: x.name, probability_pct: pct(x.probability), impact_days: x.hours / s.hpd, activities: x.activities, triggered_pct: x.triggeredPct })),
          events: r.events.map((x) => ({ name: x.name, probability_pct: pct(x.probability), triggered_pct: x.triggeredPct })),
          percentiles: [
            ...(['P10', 'P50', 'P80', 'P90'] as const).map((k) => ({ statistic: k, date: iso(r.percentiles[k]), working_days: r.days[k], value: null, unit: null })),
            { statistic: 'mean', date: iso(r.mean), working_days: r.days.mean, value: null, unit: null }, { statistic: 'min', date: iso(r.min), working_days: r.days.min, value: null, unit: null }, { statistic: 'max', date: iso(r.max), working_days: r.days.max, value: null, unit: null },
            { statistic: 'std_dev', date: null, working_days: r.days.std, value: r.stdDevDays, unit: 'calendar days' },
            { statistic: 'deterministic', date: iso(r.deterministicFinish), working_days: r.days.deterministic, value: null, unit: null },
            { statistic: 'prob_deterministic', date: iso(r.deterministicFinish), working_days: null, value: pct(r.probDeterministic), unit: '%' },
            ...(r.probDeadline != null ? [{ statistic: 'prob_deadline', date: iso(mc.deadline!), working_days: null, value: pct(r.probDeadline), unit: '%' }] : []),
          ],
          sigma: r.days.sigma.map((x) => ({ k: x.k, working_days: x.days, date: iso(x.date) })),
          samples: r.finishSamples.map((f, i) => ({ iteration: i + 1, finish: iso(f), finish_days: sm.finishDays[i], ...Object.fromEntries(mileKey.map((key, j) => [key, iso(sm.milestones[j][i])])) })),
        };
        return { ...answer, exported: exportResult('monte_carlo', a.export, full, [
          { name: 'iterations', columns: ['iteration', 'finish', 'finish_days', ...mileKey], rows: full.samples },
          { name: 'histogram', columns: ['start', 'end', 'count', 'cum_pct'], rows: full.histogram },
          { name: 'percentiles', columns: ['statistic', 'date', 'working_days', 'value', 'unit'], rows: full.percentiles },
          { name: 'sigma', columns: ['k', 'working_days', 'date'], rows: full.sigma },
          { name: 'cumulative', columns: ['finish', 'cum_pct'], rows: cumulative },
          { name: 'criticality', columns: ['id', 'name', 'milestone', 'critical_pct', 'deterministic_finish', 'mean_finish', 'p50_finish', 'p80_finish', 'sensitivity', 'min_remaining_hours', 'mean_remaining_hours', 'max_remaining_hours'], rows: full.criticality },
          { name: 'sensitivity', columns: ['id', 'name', 'correlation'], rows: full.sensitivity },
          { name: 'milestones', columns: ['id', 'name', 'deterministic', 'mean', 'P10', 'P50', 'P80', 'P90'], rows: full.milestones },
          { name: 'risk_events', columns: ['id', 'name', 'probability_pct', 'impact_days', 'activities', 'triggered_pct'], rows: full.risk_events },
          { name: 'events', columns: ['name', 'probability_pct', 'triggered_pct'], rows: full.events },
        ], writeOutWith, { partial: !!r.partial, name: a.export_name }) };
      } catch (e) { if (ctx.signal.aborted) fail('cancelled', 'The Monte Carlo run was cancelled.', 'Start it again when needed.'); throw e; }
      finally { if (j) rollback(j); }
    }
    case 'validate': return brief(importChecks(s.db, [], s.format));
    case 'review': {
      // worked out with every activity listed: the answer shows 10 per check (examples_total says how many there are), the export all
      const full = reviewSchedule(s.db, { hoursPerDay: s.hpd, calendarDays: true, examples: 0, activities: a.export != null });
      const answer = { ...full, checks: full.checks.map(({ activities: _a, ...c }) => (c.id !== 'saved_dates' && c.examples_total != null ? { ...c, examples: c.examples.slice(0, 10) } : c)) };
      if (a.export == null) return answer;
      return { ...answer, exported: exportResult('review', a.export, full, [
        { name: 'checks', columns: ['id', 'title', 'grade', 'count', 'of', 'percent', 'limit', 'detail', 'examples_total'], rows: full.checks.map(({ examples: _e, activities: _a, ...c }) => c) },
        { name: 'activities', columns: ['check', 'id', 'name'], rows: full.checks.flatMap((c) => (c.activities ?? []).map((x) => ({ check: c.id, ...x }))) },
        { name: 'saved_dates', columns: ['message'], rows: (full.checks.find((c) => c.id === 'saved_dates')?.examples ?? []).map((message) => ({ message })) },
      ], writeOutWith, { name: a.export_name }) };
    }
    case 'undo': {
      if (a.any_caller) requireOwner(s, a.owner_key ?? fail('owner_key_required', 'any_caller undo needs the owner key.', 'Pass owner_key, or undo only your own changes.'), 'Undoing other callers\' changes');
      const r = undo(s, ctx.caller, !!a.any_caller);
      return r.undone ? { undone: r.undone, by: r.by, your_remaining_changes: s.history.filter((h) => h.caller === ctx.caller).length } : { undone: null, note: a.any_caller ? 'Nothing to undo.' : `You (${ctx.caller}) have no change to undo on this project.` };
    }
    case 'redo': { const r = redo(s, ctx.caller); return r.redone ? r : { redone: null, note: 'Nothing to redo (redo is cleared when you make a new change).' }; }
    case 'save': {
      requireOwner(s, a.owner_key, 'Saving');
      const path = a.path ? pathArg(a.path, 'path', 'write') : s.path ?? fail('bad_input', 'Give "path" (this project was created in memory).', 'Pass a file path inside the storage root.');
      if (a.repair === true) {
        const same = (x: string | null) => { if (!x) return false; try { return realpathSync(x) === realpathSync(path); } catch { return x === path; } };
        if (!a.path || same(s.path)) fail('bad_input', 'A repaired copy is a new file: it never overwrites the file the project was opened from.', 'Pass a new path for the repaired copy.');
      }
      if (!a.path && !a.overwrite) fail('confirm_overwrite', `Saving would overwrite ${path}.`, 'Pass overwrite: true, or a new path.');
      const fmt = String(a.format ?? (/\.mpx$/i.test(path) ? 'mpx' : /\.xml$/i.test(path) ? 'p6xml' : 'xer')).toLowerCase();
      const projIds = a.project != null && a.project !== '' ? projectIds(s.db, a.project) : undefined;
      const names = () => allIds(s.db).map((id) => s.db.tables.PROJECT.rows.find((p) => p.proj_id === id)!.proj_short_name).join(', ');
      // repair: true writes a repaired copy P6 imports (repair-valid.ts), as one undoable change; never over the original
      let repairs: ReturnType<typeof repairToValid> | null = null;
      if (a.repair === true) {
        if (fmt !== 'xer' && fmt !== 'p6xml' && fmt !== 'xml') fail('bad_input', 'repair writes XER or P6 XML.', 'Save the repaired copy as .xer (or .xml).');
        repairs = change(s, ctx.caller, 'Repair to valid', (d) => { repairKeys(d); return repairToValid(d); });
      }
      if ((fmt === 'mspdi' || fmt === 'mpx') && !projIds && allIds(s.db).length > 1) fail('bad_input', `A Microsoft Project file holds one project, and this file holds ${allIds(s.db).length}: ${names()}.`, 'Pass "project" with the Project ID to write (save once per project).');
      // a project changed in this session is not written holding what P6 rejects on import (the edit tools refuse these as they are made; this is the net under the rest)
      // Violations the file ALREADY had when it was opened are reported in the answer, never a refusal; the ones this session's edits added are refused.
      let p6found: ReturnType<typeof p6Refusals> = [], rebuilt = false;
      if (a.repair !== true && (fmt === 'xer' || fmt === 'p6xml' || fmt === 'xml')) {
        if (!s.openProblems && s.dirty) rebuilt = await rebuildOpenProblems(s);
        p6found = p6Refusals(s.db, projIds);
        const was = s.openProblems;
        const fresh = s.dirty && a.allow_invalid !== true && was ? p6found.filter((x) => !((was.get(x.key) ?? 0) >= x.count)) : [];
        if (fresh.length) fail('invalid_for_p6', `Not saved: this session's changes left what P6 would reject on import. ${fresh.slice(0, 5).map((x) => x.message).join(' ')}${fresh.length > 5 ? ` (and ${fresh.length - 5} more)` : ''}`, 'Fix those rows (set_fields / update_activity / delete_rows), or save with allow_invalid: true to write it as it is.');
      }
      await checkpoint(ctx);
      let bytes: string | Uint8Array | null = null, label: string;
      let xerOut: ((put: (b: Uint8Array) => void) => void) | null = null; // an XER goes to the file a chunk at a time
      const notes: string[] = [];
      // P6 XML goes to the file as it is made (never one string the size of the file)
      if (fmt === 'p6xml' || fmt === 'xml') label = 'P6 XML';
      else if (fmt === 'mspdi') label = 'Microsoft Project XML';
      else if (fmt === 'mpx') { bytes = exportFile(s.db, fmt as Format, { version: '', projIds: projIds ?? allIds(s.db).slice(0, 1), encoding: a.encoding ?? 'auto', readAs: s.encoding, report: notes }); label = fmt === 'mpx' ? 'MPX' : 'Microsoft Project XML'; }
      else if (fmt === 'xer') {
        // the label is the version written; a project without one is stamped NEW_XER_VERSION, and the answer says what that means
        const stamped = a.version == null && s.db.header?.version == null;
        const o = { version: a.version ?? s.db.header?.version ?? NEW_XER_VERSION, encoding: a.encoding ?? 'auto', readAs: s.encoding, projIds, report: notes };
        xerOut = (put) => writeXerTo(s.db, o, put); label = `XER ${o.version}`;
        if (stamped) notes.push(NEW_XER_NOTE);
      }
      else return fail('bad_input', `Unknown format "${a.format}".`, 'Use xer, p6xml, mspdi or mpx.');
      await checkpoint(ctx); // nothing is written once the call is cancelled; the write itself is one step
      if (xerOut) writeOutWith(path, xerOut);
      else if (bytes == null && fmt === 'mspdi') writeOutWith(path, (put) => writeMspdiTo(s.db, { projIds: projIds ?? allIds(s.db).slice(0, 1), report: notes }, put));
      else if (bytes == null) writeOutWith(path, (put) => writeP6XmlTo(s.db, { version: a.version ?? '19.12', projIds }, put));
      else writeOut(path, bytes);
      // what P6's XML has no place for, with values in this data: said in the answer, never silent (structured in not_in_p6_xml, plainly in notes)
      let xmlLosses: ReturnType<typeof p6xmlLosses> = [];
      if (fmt === 'p6xml' || fmt === 'xml') { xmlLosses = p6xmlLosses(s.db, projIds); notes.push(...p6xmlLossNotes(xmlLosses)); }
      // the 4D model, links and rules travel beside the file (<file>.4d.json); XER and P6 XML have no place for them
      const sidecar = fmt === 'xer' || fmt === 'p6xml' || fmt === 'xml' ? save4dSidecar(s.db, path, projIds ?? allIds(s.db), writeOut) : null;
      if (sidecar) notes.push(`4D links saved beside it: ${basename(sidecar)}`);
      // the LOB plans travel inside the XER / P6 XML (a notebook); a copy beside it in case P6 damages that notebook
      const lobText = fmt === 'xer' || fmt === 'p6xml' || fmt === 'xml' ? lobSidecarText(s.db, projIds ?? allIds(s.db)) : null;
      if (lobText) { writeOut(`${path}.lob.json`, lobText); notes.push(`LOB plans also saved beside it: ${basename(path)}.lob.json`); }
      if (!projIds || allIds(s.db).length === 1) { s.dirty = false; s.savedTo = path; }
      if ((fmt === 'mspdi' || fmt === 'mpx') && (s.db.tables.WBSMEMO?.rows.length || s.db.tables.TASKMEMO?.rows.length)) notes.push('Notebooks (project, WBS and activity) are not written to Microsoft Project files; save as XER or P6 XML to keep them.');
      if (repairs) {
        // the repaired copy, opened again as P6 would: it must not be rejected
        const bytes2 = readBytes(path), fmt2 = detectFormat(path, bytes2);
        const back = readRaw(bytes2, fmt2, 'auto');
        const g = importChecks(back.db, back.findings, fmt2);
        const still = worst(g) === 'fatal' || g.some((x) => x.code === 'EMPTY_KEY');
        return { saved: path, format: label, repaired: true, changes: repairs.changes.map((c) => ({ table: c.table, row: c.row, key: c.key, field: c.field, old: c.old, new: c.new, reason: c.reason })), changes_total: repairs.changes.length,
          // kept as the customer recorded them (P6 imports them), reported as DCMA's invalid dates
          invalid_dates: repairs.findings, cleared_actuals_rule: REFUSED_ACTUALS, check: { ...brief(g), still_rejected: still },
          note: still ? 'The repaired copy is still one P6 would reject: check.findings names what is left.' : 'The repaired copy is one P6 imports. Run schedule to recalculate the dates the repair cleared. Undo takes the repairs back from the project in memory (the file written stays).' };
      }
      return { saved: path, format: label, ...(notes.length ? { notes } : {}), ...(xmlLosses.length ? { not_in_p6_xml: xmlLosses } : {}), ...(p6found.length ? { p6_would_reject: { total: p6found.length, in_the_file_as_opened: s.openProblems ? p6found.filter((x) => (s.openProblems!.get(x.key) ?? 0) >= x.count).length : null, findings: p6found.slice(0, 20).map((x) => x.message), note: s.openProblems ? `Not caused by this session: the file already had these when it was opened (they were saved as they were)${rebuilt ? ' (read again from the file it was opened from, as this project was restored without that list)' : ''}. allow_invalid: true is only needed for ones edits add.` : 'This project was restored from a recovery entry written before the list of what the file had when it was opened existed, and the file it was opened from is not available as it was opened (it is missing, or this project was saved over it): nothing could be told apart, so nothing was refused and everything found is listed.' } } : {}), ...(projIds ? { project: s.db.tables.PROJECT.rows.find((p) => p.proj_id === projIds[0])!.proj_short_name } : {}) };
    }
    case 'close': {
      requireOwner(s, a.owner_key, 'Closing');
      if (s.dirty && a.discard !== true) fail('unsaved_changes', 'This project has unsaved changes, so it was not closed.', 'Save it first (save), or close with discard: true to drop the changes.');
      closeSession(s); forgetEvicted(s.handle); return { closed: s.handle, had_unsaved_changes: s.dirty };
    }
    case 'export_pdf': {
      const path = pathArg(a.path, 'path', 'write');
      const r = printPages(s.db, { projIds: projectIds(s.db, a.project), setup: a.settings ?? {}, filter: a.filter, groupBy: a.group_by, sortBy: a.sort_by, prefs: prefsOf(s) });
      // a PDF goes to the file in its pieces, each page's drawing let go once compressed
      if (/\.html?$/i.test(path)) writeOut(path, pagesToHtml(r.pages, r.title));
      else { const parts = await pagesToPdfParts(r.pages, r.title, { release: true, font: (cs) => findUnicodeFont(cs, a.settings?.font_path ? pathArg(a.settings.font_path, 'font_path') : undefined) }); writeOutWith(path, (put) => { for (const b of parts) put(b); }); }
      return { saved: path, pages: r.pages.length, activities: r.activities, ...(r.unknownColumns.length ? { unknown_columns: r.unknownColumns, printable_columns: printableColumns(s.db).map((c) => c.id) } : {}) };
    }
    case 'export_excel': {
      if (a.sheets != null && !Array.isArray(a.sheets)) fail('bad_input', '"sheets" must be a list of subject areas.', 'e.g. ["TASK", "PROJCOST"]');
      if (a.columns != null && (typeof a.columns !== 'object' || Array.isArray(a.columns) || Object.values(a.columns).some((v) => !Array.isArray(v)))) fail('bad_input', '"columns" must map a sheet to its list of columns.', 'e.g. {"TASK": ["task_code", "task_name", "actv_code_*"]}');
      const ids = projectIds(s.db, a.project), template = { sheets: a.sheets?.map(String), columns: a.columns };
      const t = templateColumns(s.db, ids, template, s.hpd, true);
      if (a.describe) return { sheets: Object.fromEntries(SHEETS.map((n) => [n, { title: SHEET_TITLES[n], columns: t.available[n] }])) };
      if (!Object.keys(t.columns).length) fail('bad_input', `No subject area to write: ${t.unknown.join(', ')}.`, `Sheets: ${SHEETS.join(', ')}.`);
      const path = pathArg(a.path, 'path', 'write');
      writeOut(path, await writeXlsx(exportSheets(s.db, ids, s.hpd, true, template)));
      return { saved: path, sheets: Object.keys(t.columns), columns: Object.fromEntries(Object.entries(t.columns).map(([k, v]) => [k, v!.map((c) => c.field)])), ...(t.unknown.length ? { unknown_columns: t.unknown, hint: 'describe: true lists every column of every sheet.' } : {}) };
    }
    case 'import_excel': {
      const path = pathArg(a.path);
      const ids = projectIds(s.db, a.project);
      if (ids.length !== 1) fail('bad_input', 'The file holds several projects.', 'Say which one with "project".');
      const pid = s.db.tables.PROJECT.rows.find((p) => p.proj_id === ids[0])!.proj_short_name;
      let sheets;
      try { sheets = await readXlsx(readBytes(path)); } catch (e) { if (e instanceof ToolError) throw e; fail('bad_file', (e as Error).message, 'Use an .xlsx saved by export_excel or Excel in that layout.'); }
      const plan = planImport(s.db, sheets!, pid, s.hpd, true);
      if (a.dry_run || !plan.ops.length) return { applied: false, ...(plan.ops.length ? {} : { note: 'Nothing to change.' }), summary: plan.summary, warnings: plan.warnings, operations: plan.ops.slice(0, 200).map((o, i) => ({ ...o, sheet_row: `${plan.rows[i].sheet}!${plan.rows[i].row}` })) };
      const lobRefusal = lobGuard(s.db, plan.ops);
      if (lobRefusal) return { ok: false, error: { code: 'op_failed', message: lobRefusal, hint: 'Use lob_edit for an LOB plan\u2019s durations, crews, locations and logic; progress, notes, resources and other codes edit as usual.' } };
      const res = change(s, ctx.caller, `Import ${basename(path)}`, (d) => applyImport(d, plan, { hoursPerDay: s.hpd, calendarDays: true }));
      if (!res.applied) dropLast(s);
      const refused = res.refused.map((x) => ({ sheet: x.sheet, row: x.row, op: x.op.op, message: x.message }));
      return { applied: res.applied > 0, operations_applied: res.applied, summary: plan.summary, warnings: [...plan.warnings, ...res.warnings], ...(refused.length ? { refused } : {}), note: res.applied ? `Undo with undo (one step).${refused.length ? ` ${refused.length} row(s) were refused and skipped; the rest was applied.` : ''} Run schedule to recalculate dates.` : 'Every row with a change was refused; nothing was changed.' };
    }
    case 'compare': {
      // the export: every change (the answer pages them, max_changes a page) and the activities on one side only
      const COMPUTED = ['id', 'duration_delta_days', 'remaining_delta_days', 'start_shift_days', 'finish_shift_days', 'total_float_delta_days', 'became_critical', 'no_longer_critical'];
      const compared = <T extends object>(answer: T, changes: object[], columns: string[], only?: { only_in_a: string[]; only_in_b: string[] }) => (a.export == null ? answer : { ...answer, exported: exportResult('compare', a.export, { ...answer, changes, truncated: false, offset: undefined, next_offset: undefined }, [
        { name: 'changes', columns, rows: changes },
        { name: 'only_in_one', columns: ['id', 'only_in'], rows: only ? [...only.only_in_a.map((id) => ({ id, only_in: 'a' })), ...only.only_in_b.map((id) => ({ id, only_in: 'b' }))] : [] },
      ], writeOutWith, { name: a.export_name }) });
      if (a.baseline) { // this project against its baseline stored in the same file (computed fields)
        const cur = (s.db.tables.PROJECT?.rows ?? []).find((p) => !p._baseline_of && (a.project == null || p.proj_short_name === a.project)) ?? fail('bad_input', 'No project to compare.', 'Pass project.');
        const bl = baselineOf(s.db, cur, String(a.baseline) as 'project') ?? fail('bad_input', `The project has no ${a.baseline} baseline in this file.`, 'Use project, bl1, bl2, bl3 or the name of a saved baseline.');
        const c = compareComputed(s.db, s.db, s.hpd, { aProjIds: [bl.projId], bProjIds: [cur.proj_id] });
        return compared({ mode: 'computed', baseline: bl.name, ...c, changed: c.changes.length, ...changesPage(c.changes, a) }, c.changes, COMPUTED, c);
      }
      // a file compared against is read for this call only, and counted in the memory budget while it is held (C14)
      const { db: other, release } = await readOther(a, 'compare with');
      try {
      if (a.mode === 'computed') { const c = compareComputed(s.db, other, s.hpd); return compared({ mode: 'computed', changed: c.changes.length, ...changesPage(c.changes, a), became_critical: c.became_critical, no_longer_critical: c.no_longer_critical, only_in_a: c.only_in_a, only_in_b: c.only_in_b }, c.changes, COMPUTED, c); }
      if (a.mode != null && a.mode !== 'all') fail('bad_input', 'mode must be all or computed.', 'Leave it out to compare everything.');
      const cs = compareSchedules(s.db, other, s.hpd, true);
      const count = (o: string, k: string) => cs.filter((c) => c.object === o && c.kind === k).length;
      return compared({ summary: Object.fromEntries(['project', 'wbs', 'activity', 'relationship'].map((o) => [o, { added: count(o, 'added'), deleted: count(o, 'deleted'), changed: new Set(cs.filter((c) => c.object === o && c.kind === 'changed').map((c) => c.id)).size }])), ...changesPage(cs, a) }, cs, ['object', 'kind', 'id', 'name', 'field', 'a', 'b']);
      } finally { release(); }
    }
    case 'list_reports': return listReports(s.db).map((e) => ({ id: e.id, name: e.name, group: e.group, kind: e.kind, description: e.description }));
    case 'create_report': {
      const spec = parseSpec(a) ?? fail('bad_input', 'Give the report a "name" and "subject".', 'subject: activities, assignments, wbs, resources or relationships.');
      return change(s, ctx.caller, `Report ${spec.name}`, (d) => {
        const t = (d.tables._REPORT ??= { name: '_REPORT', fields: ['report_id', 'name', 'json'], rows: [] });
        const ex = t.rows.find((r) => r.name.toLowerCase() === spec.name.toLowerCase());
        if (ex) ex.json = JSON.stringify(spec); else t.rows.push({ report_id: String(t.rows.length + 1), name: spec.name, json: JSON.stringify(spec) });
        return { saved: spec.name, id: `custom:${ex?.report_id ?? t.rows.length}`, replaced: !!ex };
      });
    }
    case 'run_report': {
      const prefs = prefsOf(s);
      const ids = projectIds(s.db, a.project);
      let rname: string, report;
      if (a.definition) { const spec = parseSpec({ name: 'Ad hoc report', ...a.definition }) ?? fail('bad_input', 'definition needs a name and subject.', 'subject: activities, assignments, wbs, resources or relationships.'); report = runSpec(s.db, ids, spec, { prefs }); rname = spec.name; }
      else { try { const r = runReport(s.db, ids, String(a.report ?? ''), { prefs, weeks: Number(a.weeks) || undefined }); report = r.report; rname = r.entry.name; } catch (e) { fail('bad_input', (e as Error).message, 'Use an id or name from list_reports.'); } }
      if (!a.path) { const max = Math.max(1, Number(a.max_rows) || 200), off = Math.max(0, Math.floor(Number(a.offset) || 0)), n = report!.rows.length, next = off + max < n ? off + max : undefined; return { report: rname!, title: report!.title, subtitle: report!.subtitle, columns: report!.columns, total_rows: n, offset: off, rows: report!.rows.slice(off, off + max).map((r) => ({ cells: r.cells, ...(r.bold ? { group: true, level: r.level ?? 0 } : r.level ? { level: r.level } : {}) })), truncated: next != null, ...(next != null ? { next_offset: next } : {}) }; }
      const path = pathArg(a.path, 'path', 'write');
      const ext = (/\.(\w+)$/.exec(path)?.[1] ?? '').toLowerCase();
      if (ext === 'pdf') { const pages = reportPages(s.db, ids, report!, a.settings ?? {}, prefs, rname!), n = pages.length; const parts = await pagesToPdfParts(pages, report!.title, { release: true, font: (cs) => findUnicodeFont(cs, a.settings?.font_path ? pathArg(a.settings.font_path, 'font_path') : undefined) }); writeOutWith(path, (put) => { for (const b of parts) put(b); }); return { saved: path, pages: n, rows: report!.rows.length }; }
      if (ext === 'html' || ext === 'htm') writeOut(path, reportHtml(report!, nowStamp()));
      else if (ext === 'csv' || ext === 'txt') writeOut(path, reportText(report!));
      else if (ext === 'xlsx') writeOut(path, await reportXlsx(report!));
      else fail('bad_input', 'path must end in .pdf, .html, .csv, .txt or .xlsx.', 'Choose one of those extensions.');
      return { saved: path, rows: report!.rows.length };
    }
  }
  let lastTick = 0;
  const tick = async (done: number, total: number, message: string) => {
    if (ctx.job) ctx.job.progress = message;
    const now = Date.now();
    if (now - lastTick > 250) { lastTick = now; ctx.progress?.(done, total, message); }
    await checkpoint(ctx); // yields, and throws "cancelled" once the call or its job is cancelled
  };
  const helpers = { projectIds, allIds, dd, writeOut, writeOutWith, apply: <T,>(label: string, fn: (d: Db) => T) => change(s, ctx.caller, label, fn), applyAsync: <T,>(label: string, fn: (d: Db) => Promise<T>) => changeAsync(s, ctx.caller, label, fn), tick, keep: ctx.keep, job: () => ctx.job?.id, claim: ctx.claim };
  const analysed = await runAnalysis(name, a, s, helpers);
  if (analysed !== undefined) return analysed;
  const fourd = await runFourD(name, a, s, helpers);
  if (fourd !== undefined) return fourd;
  const lobbed = await runLob(name, a, s, helpers);
  if (lobbed !== undefined) { regrow(s); return lobbed; }
  if (LOOKUPS.some((t) => t.name === name)) {
    const { handle: _h, caller: _c, async: _a, export: _x, ...args } = a;
    const answer = runTool(name, args, s.db, makeCtx(s.db, { hoursPerDay: s.hpd }), [], s.hpd, true);
    if (name !== 'earned_value' || a.export == null || (answer as { error?: unknown }).error) return answer;
    // the export: every activity (the answer lists the `worst` few of each kind), each with every figure
    type Ev = { projects: { project: string; data_date: string; totals: object; by_wbs: object[] }[]; worst_cost_performance: object[]; worst_schedule_performance: object[]; activities: object[] };
    const full = runTool(name, { ...args, worst: 0, every_activity: true }, s.db, makeCtx(s.db, { hoursPerDay: s.hpd }), [], s.hpd, true) as Ev;
    const EV = ['bac', 'pv', 'ev', 'ac', 'sv', 'cv', 'spi', 'cpi', 'etc', 'eac', 'vac', 'schedule_pct', 'performance_pct'];
    return { ...(answer as object), exported: exportResult('earned_value', a.export, full, [
      { name: 'totals', columns: ['project', 'data_date', 'has_baseline', ...EV], rows: full.projects.map((p) => ({ project: p.project, data_date: p.data_date, has_baseline: (p as { has_baseline?: boolean }).has_baseline, ...p.totals })) },
      { name: 'by_wbs', columns: ['project', 'wbs', 'name', ...EV], rows: full.projects.flatMap((p) => p.by_wbs.map((w) => ({ project: p.project, ...w }))) },
      { name: 'activities', columns: ['project', 'id', 'name', 'wbs', ...EV], rows: full.activities },
      { name: 'worst_cost_performance', columns: ['id', 'name', 'cpi', 'cv'], rows: full.worst_cost_performance },
      { name: 'worst_schedule_performance', columns: ['id', 'name', 'spi', 'sv'], rows: full.worst_schedule_performance },
    ], writeOutWith, { name: a.export_name }) };
  }
  return fail('unknown_tool', `Unknown tool ${name}.`, 'tools/list shows the tools.');
}

/** One tool call: queued per project, run (or turned into a job), always answered with data or {error}. */
/** progress: when the request asked for progress (MCP progressToken), called as long work goes on. */
export async function callTool(name: string, a: Record<string, any>, sessionCaller?: string, signal?: AbortSignal, progress?: Ctx['progress']): Promise<{ out: unknown; isError: boolean }> {
  ensureCwd(); // (a folder the server was started in may be gone: workers and child processes read it when they start)
  // one abort for the call: the request's cancellation (notifications/cancelled) and cancel_job once it is a job
  const abort = new AbortController();
  if (signal?.aborted) abort.abort(); else signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const ctx: Ctx = { caller: String(a.caller ?? sessionCaller ?? 'default'), signal: abort.signal, progress };
  // open_model without a handle: the file opens into a new model-only workspace (an empty project named after it), for
  // agents that read a model without a schedule (quantities, procurement)
  // (open_model discard_kept touches only the model cache: no workspace, no project; run answers it)
  const discardKept = name === 'open_model' && a.discard_kept === true;
  if (name === 'open_model' && !discardKept && (a.handle == null || a.handle === '') && typeof a.path === 'string') {
    const id = (basename(a.path).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'MODEL').toUpperCase();
    const np = await callTool('new_project', { id, start: new Date().toISOString().slice(0, 10), ...(a.caller ? { caller: a.caller } : {}) }, sessionCaller, signal);
    if (np.isError) return np;
    const ws = np.out as { handle: string; owner_key: string };
    const r = await callTool('open_model', { ...a, handle: ws.handle, owner_key: ws.owner_key }, sessionCaller, signal, progress);
    const discard = () => callTool('close', { handle: ws.handle, owner_key: ws.owner_key, discard: true }, sessionCaller);
    if (r.isError) { await discard(); return r; }
    const mine = { handle: ws.handle, owner_key: ws.owner_key, workspace: `model only: project ${id} holds no schedule; save it, or close it with discard: true, when done` };
    // a long open goes on as a job: its result carries the workspace, and a failure closes the workspace as above
    const job = (r.out as { job_id?: string; status?: string }).status === 'running' ? (r.out as { job_id: string }).job_id : null;
    if (job) followJob(job, (res) => (res && typeof res === 'object' ? { ...res, ...mine } : res), () => { void discard(); });
    return { out: { ...(r.out as object), ...mine }, isError: false };
  }
  const handle = NO_HANDLE.has(name) || discardKept ? undefined : String(a.handle ?? '');
  // A watch in this call (liveness.ts) whose work uses the processor without progress says so on the job's progress line, each window,
  // and takes it back once progress returns (no number decides anything: the job is never stopped while it works; the agent sees it).
  const busy: { job?: { progress?: string } } = {};
  let busyText: string | null = null, busyBase: string | undefined;
  const reportBusy = (line: string | null) => {
    const j = busy.job;
    if (!j) return;
    if (line) { if (busyText == null || j.progress !== busyText) busyBase = j.progress; busyText = `${busyBase ? `${busyBase} — ` : ''}${line}`; j.progress = busyText; }
    else if (busyText != null) { if (j.progress === busyText) j.progress = busyBase; busyText = null; }
  };
  // …and every window with no progress goes to the job, which may wake the agent once (runtime.ts noteSilence)
  const work = () => watchReport.run({ line: reportBusy, silence: (x) => { if (busy.job) noteSilence(busy.job as Parameters<typeof noteSilence>[0], x); } }, async () => {
    let out = handle != null ? await exclusive(handle, () => withWorkingSet(name, a, handle, () => run(name, a, ctx))) : await run(name, a, ctx);
    const plain = !!out && typeof out === 'object' && !Array.isArray(out);
    if (plain) out = noteCuts(out, name); // where the whole of each cut list is, when an export was written (export.ts)
    // a tool that can change a project says whether that project now has unsaved changes
    const h = handle ?? (plain && typeof (out as { handle?: unknown }).handle === 'string' ? (out as { handle: string }).handle : undefined);
    if (plain && h && MUTATES.has(name) && !(name === 'lob_takt' && a.apply !== true)) { // lob_takt's check reads only (L-9)
      out = { ...(out as object), unsaved_changes: isDirty(h) }; scheduleCheckpoint(h); }
    const s = handle ? sessions.get(handle) : undefined;
    if (s?.notice && plain) { const n = s.notice; s.notice = undefined; return { ...(out as object), _notice: n }; }
    return out;
  });
  const asJob = a.async === true && name !== 'job_status';
  try {
    if (asJob) { const job = startJob(name, handle, Promise.resolve().then(() => { ctx.job = job; busy.job = job; return work(); }), abort); return { out: { job_id: job.id, status: 'running', note: 'Call job_status with this job_id for the result.' }, isError: false }; }
    const p = work();
    const timeout = Symbol('timeout');
    // (the timer is cleared once the call answers: left running, its promise held the race's result - the whole answer, a page of 500 rows - for the soft timeout, call after call)
    let soft: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([p, new Promise((res) => { soft = setTimeout(() => res(timeout), config.softTimeoutMs); soft.unref?.(); })]).finally(() => clearTimeout(soft));
    // (ctx.job too: the tool's progress goes to the job from now on, and a tool that names its job, render_4d's render_busy, finds it)
    if (r === timeout) { const job = startJob(name, handle, p, abort); ctx.job = job; busy.job = job; return { out: { job_id: job.id, status: 'running', note: `Still working after ${config.softTimeoutMs / 1000} s; the work continues as a job. Call job_status with this job_id.` }, isError: false }; }
    const o = r as { ok?: boolean; status?: string; error?: Record<string, unknown> } | null;
    // a refusal answered as data (ok: false), and a job that failed or was cancelled, are errors too
    const isError = !!(o && typeof o === 'object' && (o.ok === false || (name === 'job_status' && (o.status === 'failed' || o.status === 'cancelled') && !('result' in o))));
    if (isError && o!.error) return { out: { ...o, error: keptNote(contractError(o!.error), handle) }, isError };
    return { out: r, isError };
  } catch (e) {
    if (e instanceof ToolError) return { out: { error: keptNote(contractError({ code: e.code, message: e.message, hint: e.hint, ...(e.retryAfter ? { retry_after: e.retryAfter } : {}), ...(e.data ?? {}) }), handle) }, isError: true };
    return { out: { error: contractError({ code: 'internal', message: (e as Error).message, hint: 'This is a bug in the server; the project was not changed by this call. Retry, or report it with the message.', detail: String((e as Error).stack ?? e).split('\n').slice(0, 4).join(' | ') }) }, isError: true };
  }
}

/** A call's working set (workset.ts) reserved in the memory budget while it runs: refused up front, in words, when it
 *  cannot fit (idle projects are moved out first), instead of running the server out of heap halfway. */
async function withWorkingSet<T>(name: string, a: Record<string, any>, handle: string, fn: () => Promise<T>): Promise<T> {
  let s: Session | undefined;
  try { s = getSession(handle); } catch { return fn(); } // an unknown handle: the tool says so
  const need = workNeed(name, a, s, freeMemory);
  if (!need || need.bytes < 16 * 1048576) return fn();
  const release = reserveMemory(need.bytes, need.what, need.hint, handle);
  try { return await fn(); } finally { release(); }
}

/** The craft forks' error shape ({code, reason, next_step, retry_after_ms}) with the older fields (message, hint,
 *  retry_after in seconds) kept beside it for one release. */
/** A failed call on an open project says what is kept (WHIQ 4L-13): the call's own change is rolled back (one journal entry per
 *  call), every earlier call stands — so only this call is redone, never the steps before it. */
function keptNote(err: Record<string, unknown>, handle: unknown): Record<string, unknown> {
  if (typeof handle !== 'string' || !handle || err.code === 'unknown_handle' || err.code === 'unknown_job' || !sessions.has(handle)) return err;
  return { ...err, project_state: 'as after your last successful call: your earlier calls on this project are kept; only this one did not apply. Redo only this call (fixed), not the ones before it.' };
}
function contractError(e: Record<string, unknown>): Record<string, unknown> {
  const { code, message, hint, retry_after, ...rest } = e;
  return { code, reason: e.reason ?? message, next_step: e.next_step ?? hint, ...(retry_after ? { retry_after_ms: Number(retry_after) * 1000 } : {}), message, hint, ...(retry_after ? { retry_after } : {}), ...rest };
}

/** The text encoding an XER / MPX file was read in (as given, else as recognised; BOM as read); none for XML or a
 *  file of plain ASCII (any code page writes it the same, so a save chooses as for a new project). */
/** readEncoding for an XER read from its file: what the reader saw (a file of plain ASCII has none). */
const xerEncoding = (db: Db, meta: ParseMeta): TextEncodingName | undefined => {
  const enc = db.header?.encoding ?? meta.encoding;
  return enc === 'utf-8' && !meta.nonAscii ? undefined : (enc as TextEncodingName);
};
function readEncoding(bytes: Uint8Array, format: Format, db: Db, given?: string): TextEncodingName | undefined {
  if (format !== 'xer' && format !== 'mpx') return undefined;
  const enc = (format === 'xer' ? db.header?.encoding : undefined) ?? detectEncoding(bytes, (given as TextEncodingName | undefined) ?? 'auto').encoding;
  if (enc === 'utf-8') { let hi = false; for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) { hi = true; break; } if (!hi) return undefined; }
  return enc as TextEncodingName;
}

/** At exit: every project with unsaved changes (in memory or moved out) is saved as <name>.recovered-<stamp>.xer in the
 *  write root (else the storage root, else the project's own folder, else the working folder). Returns the files. */
export function saveUnsavedAtExit(reason: string): string[] {
  const saved: string[] = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const one = (handle: string, path: string | null, db: Db, readAs?: TextEncodingName) => {
    const first = (db.tables.PROJECT?.rows ?? []).find((p) => p.proj_id === allIds(db)[0])?.proj_short_name;
    const name = ((path ? basename(path).replace(/\.[^.]+$/, '') : '') || first || handle).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'project';
    const dir = writeBase() ?? (path ? dirname(path) : safeCwd());
    let file = join(dir, `${name}.recovered-${stamp}.xer`);
    for (let i = 2; existsSync(file) || saved.includes(file); i++) file = join(dir, `${name}.recovered-${stamp}-${i}.xer`);
    try { writeOutWith(file, (put) => writeXerTo(db, { version: db.header?.version ?? NEW_XER_VERSION, encoding: 'auto', readAs }, put)); saved.push(file); process.stderr.write(`P6 Clone: unsaved changes of ${handle} saved to ${file} (${reason})\n`); }
    catch (e) { process.stderr.write(`P6 Clone: the unsaved changes of ${handle} could not be saved (${reason}): ${(e as Error).message}\n`); return; }
    // the 4D model / links (XER has no place for them) and the LOB plans' copy go beside it, as an explicit save writes them
    try { save4dSidecar(db, file, allIds(db), writeOut); const lob = lobSidecarText(db, allIds(db)); if (lob) writeOut(`${file}.lob.json`, lob); }
    catch (e) { process.stderr.write(`P6 Clone: the 4D links / LOB plans of ${handle} could not be saved beside ${file} (${reason}): ${(e as Error).message}\n`); }
  };
  for (const s of sessions.values()) if (s.dirty) one(s.handle, s.path, s.db, s.encoding);
  for (const e of unsavedEvicted()) one(e.handle, e.path, e.db, e.encoding);
  return saved;
}
let exiting = false;
/** Leave: save what is unsaved first (stdin closed, SIGTERM, SIGINT). */
export function shutdown(reason: string): void {
  if (exiting) return;
  exiting = true;
  // an analysis still trying changes on a project (crash_schedule mid-step) gives them back first, so the files below
  // hold the project as the user left it, never a trial state
  rollbackRunning();
  // every handle checkpointed, so the next start brings it back; unsaved work also saved as .recovered files
  try { if (config.checkpointMs) checkpointAll(); } catch { /* the .recovered files below still hold the work */ }
  try { saveUnsavedAtExit(reason); } finally { process.exit(0); }
}

/** An MCP tools/call result; oversized output is cut down to a preview instead of flooding the client, and the whole
 *  result is written to a JSON file (in the write root, else the storage root, else the system's temporary folder)
 *  whose path the answer gives, so none of it is out of reach. */
/** Every answer is compact JSON in the text part (no pretty-printing) beside structuredContent: the MCP spec asks for the serialized result in a text block, and a client that reads only text must not lose the rows. */
export function toolResult(out: unknown, isError: boolean, tool?: string) {
  let text = JSON.stringify(out);
  releaseIfGrown();
  let structured = out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out };
  if (text.length > config.maxResponseChars) {
    let saved: string | null = null;
    try {
      const dir = writeBase() ?? join(tmpdir(), 'p6clone-results');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      let file = join(dir, `${(tool ?? 'result').replace(/[^\w-]+/g, '_')}-result-${stamp}.json`);
      for (let i = 2; existsSync(file); i++) file = join(dir, `${(tool ?? 'result').replace(/[^\w-]+/g, '_')}-result-${stamp}-${i}.json`);
      writeOutWith(file, (put) => { for (let at = 0; at < text.length; at += 1 << 22) put(text.slice(at, at + (1 << 22))); });
      saved = file;
    } catch { /* the preview below still answers */ }
    structured = { truncated: true, size_chars: text.length, ...(saved ? { saved, written: [saved] } : {}),
      note: saved ? `The result was too large to return whole (${text.length} characters); all of it is in ${saved} (JSON). Read that file, or ask for less (limit and offset, max_rows, filters, a narrower project).`
        : 'The result was too large to return whole and could not be written to a file; ask for less (limit and offset, max_rows, filters, a narrower project) or write it to a file (run_report / export_* with path).',
      preview: text.slice(0, 20000) };
    text = JSON.stringify(structured);
  }
  return { content: [{ type: 'text', text }], structuredContent: structured, isError };
}

export const SERVER_INFO = { name: 'p6-clone', title: 'P6 Clone (headless Primavera P6)', version: VERSION };
export const INSTRUCTIONS = 'Open an XER with open_file (or new_project): keep the handle (for editing) and the owner_key (for save, close and undoing others\' work). Then query, edit, schedule, review, run reports, Monte Carlo; save writes the file. Several agents may share one handle: calls run one at a time, undo and redo act on your own changes (pass caller). Every error has a code and a hint: follow the hint (busy: retry after retry_after seconds; unknown_handle: open the file again). Long work can run with async: true and job_status.';
/** The arguments naming files a tool reads (the White Hat IQ platform stages them before the call; a tool not listed reads
 *  none). "updates[].path" and "settings.font_path" are inside an argument. */
const FILES: Record<string, { read: string[]; opens: boolean }> = {
  open_file: { read: ['path'], opens: true }, compare: { read: ['path'], opens: false }, import_excel: { read: ['path'], opens: false },
  export_pdf: { read: ['settings.font_path'], opens: false }, run_report: { read: ['settings.font_path'], opens: false },
  windows_analysis: { read: ['updates[].path'], opens: false },
  ...FOURD_FILES,
  ...LOB_FILES,
};
/** P6CLONE_TOOLSETS (e.g. "core,analysis,4d,lob"): a host that wants fewer tools lists only some groups; default all. */
const toolsetOf = (name: string) => (FOURD_NAMES.has(name) ? '4d' : LOB_NAMES.has(name) ? 'lob' : ANALYSIS_NAMES.has(name) ? 'analysis' : 'core');
const ANALYSIS_NAMES = new Set(ANALYSIS_TOOLS((x) => x).map((t) => t.name));
/** Tools that can run long on a project (the analysis tools; Monte Carlo, levelling, F9, progress updates, imports into the project and progress transfers, what-if evaluation; LOB plans;
 *  PDF, Excel and report files): they run in a worker thread on a copy of the project (compute.ts). Not here, and why: file opens and saves
 *  (they create or serialise the session's database), edit/undo/redo (finite, fast operations on the database itself), the lookups, and the 4D
 *  tools (they work on models held in this process; their heavy parts already run in worker processes). */
const OFFLOAD = new Set([...ANALYSIS_NAMES, 'monte_carlo', 'level_resources', 'schedule', 'update_progress', 'import_file', 'transfer_progress', 'evaluate', 'review', 'validate', 'export_pdf', 'export_excel', 'lob_create', 'lob_edit', 'lob_takt', 'lob_forecast', 'lob_import']);
const offloads = (name: string, a: Record<string, any>) => process.env.P6CLONE_COMPUTE_WORKERS !== '0' && (OFFLOAD.has(name) || (name === 'run_report' && !!a.path));
export const toolsList = () => {
  const sets = process.env.P6CLONE_TOOLSETS ? new Set(process.env.P6CLONE_TOOLSETS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) : null;
  return TOOLS.filter((t) => !sets || sets.has(toolsetOf(t.name))).map((t) => (FILES[t.name] ? { ...t, _meta: { 'whiq/files': FILES[t.name] } } : t));
};

// ---------------------------------------------------------------- start
export function housekeeping(): void { setInterval(() => { try { sweepIdle(); sweepJobs(); } catch { /* keep serving */ } }, 60000).unref(); }

const isMain = isMainThread && (() => { try { return /server\.(ts|js|cjs)$|p6clone-mcp/.test(process.argv[1] ?? ''); } catch { return false; } })();
// a compute worker (compute.ts): the same server code, serving one tool call at a time on a copy of a project
if (!isMainThread && (workerData as { p6Compute?: boolean } | null)?.p6Compute) startComputeWorker(run, (f) => { writeNotice = f; return writeTag; });
answerReasoner(reasonerStatus);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  setRoot(opt('root') ?? process.env.P6CLONE_ROOT ?? null);
  setRoots(opt('automation-read-root'), opt('automation-write-root'));
  config.checkpointMs = Number(process.env.P6CLONE_CHECKPOINT_MS) > 0 ? Number(process.env.P6CLONE_CHECKPOINT_MS) : 2000;
  const adopted = adoptRecovery();
  if (adopted.length) process.stderr.write(`P6 Clone: ${adopted.length} project(s) from a server that is no longer running are back under their handles.\n`);
  housekeeping();
  // SIGHUP: a terminal closed (on Windows, the console window); SIGBREAK: Ctrl+Break on Windows
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] as const : [])] as const) process.on(sig, () => shutdown(sig));
  if (args.includes('--http')) {
    config.requireOwnerKey = !args.includes('--no-owner-key');
    // not awaited: http/stdio import this module, so it must finish evaluating first
    void import('./http.ts').then(({ startHttp }) => startHttp({ port: Number(opt('port') ?? process.env.P6CLONE_PORT ?? 8765), host: opt('host') ?? '127.0.0.1', token: opt('token') ?? process.env.P6CLONE_TOKEN ?? null }));
  } else {
    config.requireOwnerKey = args.includes('--require-owner-key');
    void import('./stdio.ts').then(({ startStdio }) => startStdio());
  }
}
