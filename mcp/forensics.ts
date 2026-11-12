// The place the benchmark-derived analyses are registered (schedule_index, decm, planning_horizon, change_tracking, baseline_variance: each its own core file under core/analysis/, built by its own package).
// The wiring is done ONCE: this file's list is spread into the server's tools (server.ts), its runner is called after the analysis runner (server.ts), its names join the analysis group, the offload set and the
// result-file set (server.ts, export.ts), and the files and handles a tool reads are named from here (server.ts FILES, compute.ts). A tool is added by ONE entry in FORENSIC_REGISTRY below and its core file:
// nothing else changes. tests/analysis-forensic.test.ts proves the wiring with a throwaway entry.
import { baselineOf, LISTED } from '../core/analysis/common.ts';
import { scheduleIndex, shapeScheduleIndex } from '../core/analysis/scheduleIndex.ts';
import { decm, DECM_IDS, DECM_PROFILES } from '../core/analysis/decm.ts';
import { planningHorizon, shapeHorizon } from '../core/analysis/planningHorizon.ts';
import { changeTracking, shapeChanges, MODES, DATE_MATERIAL_DAYS, PROGRESS_MATERIAL_POINTS } from '../core/analysis/changeTracking.ts';
import { config, fail, type Session } from './runtime.ts';
import { exportDoc, exportNameProp, exportProp, RESULT_FILE_TOOLS, firstOf, type Table } from './export.ts';
import { loadUpdates, resultExporter, savedBaselines, type AnalysisHelpers } from './analysis.ts';
import { WORK, type Work } from './workset.ts';

/** What a tool's `run` is given besides its arguments: the answer-and-files helper the analysis tools use, the list rule, the series loader. */
export interface ForensicCall {
  /** the arguments as called (handle, project, export and the tool's own) */
  a: Record<string, any>;
  s: Session;
  /** what the server lends the analysis tools (dd: a date argument as minutes, tick, writeOut ...) */
  h: AnalysisHelpers;
  /** the projects in scope: the argument project, else every project in the file */
  projIds: string[];
  /** the answer, and with export (the default result folder when the caller gave none: server.ts) the whole result and its tables written (the answer names them in exported) */
  exported: <T extends object>(answer: T, full: unknown, tables: Table[]) => T;
  /** how many rows of a list the answer carries: LISTED (the clone's list rule, core/analysis/common.ts); 0 = all only for the desktop screens, as the analysis tools do. The whole list goes in the files. */
  listed: number;
  /** the first `listed` of a list */
  first: <T>(list: T[]) => T[];
  /** the series of updates the tool takes (updates: [{baseline} | {path} | {handle} | {data_date, progress}]), as windows_analysis takes them; call release() when done */
  updates: (o: { includeCurrent: boolean; currentName?: unknown }) => { updates: ReturnType<typeof loadUpdates>['updates']; release: () => void };
}

export interface ForensicTool {
  name: string;
  /** what the tool does and answers, without the sentence about the result files (added from `tables`) */
  description: string;
  /** the tool's own arguments (JSON schema properties); handle, caller, async, project, export and export_name are added */
  properties: Record<string, unknown>;
  required?: string[];
  /** the result tables written as CSV files, named as exportDoc names them: 'name' or 'name (what it holds)' */
  tables: string[];
  /** the files the tool reads by path (the platform stages them before the call), as the server's FILES lists them: e.g. ['updates[].path'] */
  readsFiles?: string[];
  /** the tool reads other open projects by handle: updates[].handle (the server lends them to the worker that runs the call) */
  readsHandles?: boolean;
  /** the memory the tool needs beside the project (workset.ts WORK), when it needs more than the others */
  work?: Work;
  run: (c: ForensicCall) => unknown | Promise<unknown>;
}

const STATUS_DATE = { type: 'string', description: 'the date the schedule is judged at (default: each project\u2019s data date), as dcma_14 takes it' };
const BASELINE = { type: 'string', description: 'project (default), bl1, bl2, bl3 or a saved baseline\u2019s name, as dcma_14 takes it' };
/** status_date as dcma_14 takes it; baseline refused when no project in scope has it, as dcma_14 refuses it. */
function dateAndBaseline(c: ForensicCall): { statusDate: number | null; baseline?: string } {
  const statusDate = c.h.dd(c.a.status_date); // (a value that is not a date is refused by dd itself)
  const db = c.s.db;
  if (c.a.baseline != null && !c.projIds.some((id) => baselineOf(db, db.tables.PROJECT.rows.find((p) => p.proj_id === id)!, String(c.a.baseline)))) fail('bad_input', `No baseline "${c.a.baseline}" for this project.`, `Use project, bl1, bl2, bl3 or a saved baseline's name: ${savedBaselines(db, c.projIds).join(', ') || 'none saved'}.`);
  return { statusDate, baseline: c.a.baseline != null ? String(c.a.baseline) : undefined };
}

/** Every benchmark-derived tool. One entry per tool: add it here with its core file. */
export const FORENSIC_REGISTRY: ForensicTool[] = [
  {
    name: 'schedule_index',
    description: 'The schedule health score and the schedule risk index, from the same figures, on the open file\u2019s own tables (the Bellator Schedule Intelligence analyses, as the clone\u2019s own: P6\u2019s stored total float and critical flag, working days of each activity\u2019s calendar, the real baselines, actual dates and data date). health (0-100, grade A-F, signals): 0.40 critical-path density + 0.35 float erosion + 0.15 structural (open ends) + 0.10 relationship (finish-to-start share); a schedule with a loop cannot be calculated and has no score (the loop is named). risk (0-100, lower is better, grade, level, status): the weighted sum of five sub-metrics, each with score, active, reason when not assessed and its parts: float 0.30, logic 0.25 (100 - the logic-audit score), baseline drift 0.20 (needs a baseline: average finish variance, BEI, critical-path delay), progress integrity 0.15 (needs a data date: 100 - the integrity score), resource 0.10 (needs resource assignments: over-allocation against the real limits, work activities with no resource, an over-allocated resource on a critical activity). A part the file cannot supply is not assessed, with the reason, and the composite is re-weighted over the sub-metrics assessed (left_out says which were left out); nothing is invented. drivers rank the sub-metrics by weight x score, each with its recommendation; logic_findings, progress_anomalies, resources and unresourced_activities list what lies behind the scores (25 each in the answer, the true total beside it, the whole list in the result file). method lists every weight and threshold used, so a score can be quoted with how it was made; the numbers are the benchmark\u2019s, carried over as they are. baseline: project, bl1-bl3 or a saved baseline\u2019s name; status_date: the date to judge at.',
    properties: { status_date: STATUS_DATE, baseline: BASELINE },
    tables: ['sub_metrics', 'drivers (with each recommendation)', 'logic_findings (every finding\u2019s activities)', 'progress_anomalies', 'resources (every resource)'],
    run: (c) => {
      const { statusDate, baseline } = dateAndBaseline(c);
      const { answer, whole, tables } = shapeScheduleIndex(scheduleIndex(c.s.db, { projIds: c.projIds, hoursPerDay: c.s.hpd, statusDate, baseline }), c.first);
      return c.exported(answer, whole, tables);
    },
  },
  {
    name: 'decm',
    description: `The DCMA DECM schedule checks (guidelines 6, 8 and 10; 17 checks), shaped like dcma_14 and run on the open file's own tables. Each check answers metric (% of its population), threshold {op, value, source}, result pass | fail | not_assessed, numerator / denominator and the activities it found (25 in the answer, total_activities the true number, the whole list in the result file); summary gives passed, failed, not_assessed, compliance_ratio (passed / assessed) and overall; guidelines groups the checks. Reused from dcma_14: 06A204b (dangling starts and finishes), 06A205a (lags), 06A209a (hard constraints), 06A506a / b / c (actual start after the status date, actual finish after it, incomplete forecast before it: dcma_14's invalid dates split in three), 06A401a (critical path validity: dcma_14's critical path test; a loop in the logic fails it and is named). Also: 06A208a (WBS summary activities carrying logic), 06A210a (level of effort with a discrete successor), 06A212a (out-of-sequence progress), 06A501a (missing baseline dates, against the baseline), 06A505a (under way with no actual start), 06A505b (complete with no actual finish), 06A504a / b (an actual start / finish that differs from the one an earlier update held: needs updates, the earlier schedules given as windows_analysis takes them, [{handle} | {path} | {baseline} | {data_date, progress}]; this project is the last). Not assessed, with the reason: 08I101a (SLPP) and 10A303a (planning package) because P6 has no such activity types; 06A501a without a baseline; 06A506a / b / c without a data date; 06A504a / b without an earlier update; a check whose population is empty. profile: ${Object.entries(DECM_PROFILES).map(([k, v]) => `${k} (${v.label})`).join(', ')}; thresholds overrides single checks by id (percent of the population: ${DECM_IDS.filter((i) => i !== '06A401a').join(', ')}). The DECM threshold values are the benchmark's, carried over as they are, and have NOT been checked against the DCMA DECM workbook. baseline: project (default), bl1, bl2, bl3 or a saved baseline's name; status_date: the date to judge at (default each project's data date). method lists the numbers used.`,
    properties: { profile: { type: 'string', description: 'default or strict' }, thresholds: { type: 'object', description: 'overrides by check id, e.g. {"06A205a": 10}: percent of the population allowed' }, baseline: BASELINE, status_date: STATUS_DATE, updates: { type: 'array', items: { type: 'object' }, description: 'the earlier updates for 06A504a / b: [{handle} | {path} | {baseline: project|bl1|bl2|bl3|<saved baseline name>} | {data_date, progress: [edit ops]}]; this project is the latest' } },
    tables: ['checks', 'failing_activities'],
    readsFiles: ['updates[].path'], readsHandles: true,
    run: (c) => {
      if (c.a.profile != null && !DECM_PROFILES[c.a.profile]) fail('bad_input', `Unknown profile "${c.a.profile}".`, `Profiles: ${Object.keys(DECM_PROFILES).join(', ')}.`);
      if (c.a.thresholds != null) {
        const t = c.a.thresholds;
        if (typeof t !== 'object' || Array.isArray(t)) fail('bad_input', 'thresholds must be an object of check id and percent.', 'e.g. {"06A205a": 10}');
        for (const [k, v] of Object.entries(t)) {
          if (!(DECM_IDS as string[]).includes(k) || k === '06A401a') fail('bad_input', `No threshold for "${k}".`, `Checks with a threshold: ${DECM_IDS.filter((i) => i !== '06A401a').join(', ')}.`);
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail('bad_input', `thresholds.${k} must be a number of 0 or more (percent of the population).`, 'e.g. {"06A205a": 10}');
        }
      }
      const { statusDate, baseline } = dateAndBaseline(c);
      const loaded = c.a.updates != null ? c.updates({ includeCurrent: true }) : null;
      try {
        const full = decm(c.s.db, { projIds: c.projIds, hoursPerDay: c.s.hpd, profile: c.a.profile, thresholds: c.a.thresholds, baseline, statusDate, updates: loaded?.updates });
        const answer = { ...full, checks: full.checks.map((k) => ({ ...k, activities: c.first(k.activities) })) };
        return c.exported(answer, full, [
          { name: 'checks', columns: ['id', 'name', 'guideline', 'result', 'metric', 'unit', 'threshold_op', 'threshold_value', 'threshold_source', 'numerator', 'denominator', 'total_activities', 'note'], rows: full.checks.map(({ activities: _a, ...k }) => (k.threshold == null ? (({ threshold: _t, ...x }) => x)(k) : k)) },
          { name: 'failing_activities', columns: ['check', 'id', 'name', 'project', 'value'], rows: full.checks.flatMap((k) => k.activities.map((x) => ({ check: k.id, ...x }))) },
        ]);
      } finally { loaded?.release(); }
    },
  },
  {
    name: 'planning_horizon',
    description: 'How ready is the work that starts in the next 30, 60 and 90 days (the Bellator Schedule Intelligence planning-horizon analysis, as the clone’s own). The anchor is the data date (or status_date); a file with no data date has no windows and is not assessed, with the reason. The windows are fixed: activities whose forecast start (else planned start) falls 0-30, 31-60 and 61-90 calendar days after the anchor (finished and started work, WBS summaries and level of effort are not in a window). Each activity is scored on five readiness dimensions, 0-100: logic 0.25 (60 with no predecessor, 70 while a finish-to-start predecessor is not complete), resources 0.30 (a resource or expense loaded: 100, else 0; a milestone carries no work to resource), approvals 0.20, float 0.10 (total float under 5 working days scores float / 5; negative 0), forecast stability 0.15 (forecast finish against the planned finish: 5 points off a working day beyond 3). A P6 file carries no approval field, so approvals is not assessed and its weight is spread over the others; a file with no resource assignments is not assessed for resources, an activity with no stored float or no planned finish for those dimensions, and the readiness of an activity is re-weighted over the dimensions assessed for it (summary.dimensions_not_assessed says which and why). Per window: the readiness score (the mean of its activities) and status (>= 90 ready, >= 75 mostly ready, >= 50 at risk, else not ready), the count ready and at risk, the mean of each dimension, every activity with its dimension scores and issues (lowest readiness first), and the risks ranked (the at-risk and not-ready activities with the weakest dimension’s first issue); a window with no activities has no score (it says so). systemic_issues: a dimension weak (< 50) across at least max(2, 30 %) of the activities it applies to. The lists show 25 each, the true total beside them, the whole list in the result file. method lists every weight and threshold; the numbers are the benchmark’s, carried over as they are. status_date: the date the windows are counted from (default each project’s data date).',
    properties: { status_date: STATUS_DATE },
    tables: ['bands', 'activities (every activity of every window)'],
    run: (c) => {
      const { answer, whole, tables } = shapeHorizon(planningHorizon(c.s.db, { projIds: c.projIds, hoursPerDay: c.s.hpd, statusDate: c.h.dd(c.a.status_date) }), c.first);
      return c.exported(answer, whole, tables);
    },
  },
  {
    name: 'change_tracking',
    description: `What changed between a series of updates (the Bellator Schedule Intelligence change-tracking analysis, as the clone\u2019s own). updates is the series taken as windows_analysis takes it ([{handle} | {path} | {baseline: project|bl1|bl2|bl3|<saved baseline name>}]); this open project is the LATEST update; the updates are put in data-date order and each consecutive pair is a period. mode: latest (the last pair only) or all_periods (every pair, the default). Per period and overall, per category {total, material}: baseline_dates (the baseline each update carries: a pair where either update has none is not assessed, with the reason), actual_dates, forecast_dates (the start of work not started and the finish of work not finished in both updates), logic (a relationship added, removed, or kept with another type or lag), resources (an assignment added or removed) and progress (percent complete by the activity\u2019s own type). A date change is material from ${DATE_MATERIAL_DAYS} working day of the activity\u2019s calendar and a percent change from ${PROGRESS_MATERIAL_POINTS} points (the source\u2019s numbers, fixed; a smaller change is counted as not material); logic and resource changes are always material. flags (only those raised): retroactive_actual_dates (an actual start or finish an earlier update held, changed or cleared: DECM 06A504a / b), progress_decreases, baseline_dates_revised (a material baseline date change) and status_regressions; status is fail when a retroactive actual date or a material baseline revision was found, warning when any change is material, else pass. Activities in only one update of a pair are counted (activities_added / activities_deleted), not tracked. Read-only. Lists (changes, logic_changes, resource_changes, retroactive_actuals, progress_decreases, status_regressions): 25 in the answer, <list>_total the true number, the whole list in the result file; changes holds the date and percent changes of every category but logic and resources, which have their own lists. method lists every number with its source line.`,
    properties: { mode: { type: 'string', enum: MODES, description: 'latest (compare the last update with this one only) or all_periods (every consecutive pair, the default)' }, updates: { type: 'array', items: { type: 'object' }, description: 'the earlier updates, as windows_analysis takes them: [{handle} | {path} | {baseline: project|bl1|bl2|bl3|<saved baseline name>} | {data_date, progress: [edit ops]}]; this project is the latest' } },
    required: ['updates'],
    tables: ['changes (date and percent changes by category)', 'retroactive_actuals', 'progress_decreases', 'status_regressions', 'logic_changes', 'resource_changes'],
    readsFiles: ['updates[].path'], readsHandles: true,
    run: (c) => {
      const loaded = c.updates({ includeCurrent: true });
      try {
        const { answer, whole, tables } = shapeChanges(changeTracking({ updates: loaded.updates, mode: c.a.mode, hoursPerDay: c.s.hpd }), c.first);
        return c.exported(answer, whole, tables);
      } finally { loaded.release(); }
    },
  },
];

const ro = { readOnlyHint: true, openWorldHint: false };
const project = { type: 'string', description: 'Project ID (default: every project in the file)' };

/** The tool definitions of a registry, as the server lists them (read-only; handle, caller and async are added by withHandle). */
export const forensicTools = (registry: ForensicTool[], withHandle: (s: Record<string, unknown>) => Record<string, unknown>) => registry.map((t) => ({
  name: t.name, annotations: ro,
  description: t.description + exportDoc(t.name, t.tables),
  inputSchema: withHandle({ type: 'object', properties: { export: exportProp, export_name: exportNameProp, project, ...t.properties }, ...(t.required?.length ? { required: t.required } : {}) }),
}));
export const FORENSIC_TOOLS = (withHandle: (s: Record<string, unknown>) => Record<string, unknown>) => forensicTools(FORENSIC_REGISTRY, withHandle);

/** The names, for the server's analysis group, offload set and result files. A function, so a registry filled after this module loaded (a test's) is read as it is. */
export const forensicNames = (registry: ForensicTool[] = FORENSIC_REGISTRY) => new Set(registry.map((t) => t.name));
/** The files each tool reads (server.ts FILES) and whether it reads other handles (compute.ts). */
export const forensicFiles = (registry: ForensicTool[] = FORENSIC_REGISTRY): Record<string, { read: string[]; opens: boolean }> => Object.fromEntries(registry.filter((t) => t.readsFiles?.length).map((t) => [t.name, { read: t.readsFiles!, opens: false }]));
export const forensicReadsHandles = (name: string, registry: ForensicTool[] = FORENSIC_REGISTRY) => !!registry.find((t) => t.name === name)?.readsHandles;

/** Put a registry's tools into the sets the server consults by name: every result is written to files (export.ts), and a tool's memory need (workset.ts). Called once for the registry, at load. */
export function registerForensicTools(registry: ForensicTool[] = FORENSIC_REGISTRY): void {
  for (const t of registry) { RESULT_FILE_TOOLS.add(t.name); if (t.work) WORK[t.name] = t.work; }
}
registerForensicTools();

/** Run a forensic tool; undefined when the name is not one of them (the server then tries the next group). */
export async function runForensics(name: string, a: Record<string, any>, s: Session, h: AnalysisHelpers, registry: ForensicTool[] = FORENSIC_REGISTRY): Promise<unknown> {
  const tool = registry.find((t) => t.name === name);
  if (!tool) return undefined;
  const projIds = a.project != null && a.project !== '' ? h.projectIds(s.db, a.project) : h.allIds(s.db);
  const max = config.screens ? 0 : LISTED;
  return tool.run({
    a, s, h, projIds, exported: resultExporter(name, a, h) as ForensicCall['exported'], listed: max, first: (list) => firstOf(list, max),
    updates: (o) => loadUpdates(a, s, h, { tool: name, ...o }),
  });
}
