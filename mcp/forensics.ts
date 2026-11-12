// The place the benchmark-derived analyses are registered (schedule_index, decm, planning_horizon, change_tracking, baseline_variance: each its own core file under core/analysis/, built by its own package).
// The wiring is done ONCE: this file's list is spread into the server's tools (server.ts), its runner is called after the analysis runner (server.ts), its names join the analysis group, the offload set and the
// result-file set (server.ts, export.ts), and the files and handles a tool reads are named from here (server.ts FILES, compute.ts). A tool is added by ONE entry in FORENSIC_REGISTRY below and its core file:
// nothing else changes. tests/analysis-forensic.test.ts proves the wiring with a throwaway entry.
import { baselineOf, LISTED } from '../core/analysis/common.ts';
import { scheduleIndex, shapeScheduleIndex } from '../core/analysis/scheduleIndex.ts';
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
