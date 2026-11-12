// The place the benchmark-derived analyses are registered (schedule_index, decm, planning_horizon, change_tracking, baseline_variance: each its own core file under core/analysis/, built by its own package).
// The wiring is done ONCE: this file's list is spread into the server's tools (server.ts), its runner is called after the analysis runner (server.ts), its names join the analysis group, the offload set and the
// result-file set (server.ts, export.ts), and the files and handles a tool reads are named from here (server.ts FILES, compute.ts). A tool is added by ONE entry in FORENSIC_REGISTRY below and its core file:
// nothing else changes. The registry is empty until a tool is built; tests/analysis-forensic.test.ts proves the wiring with a throwaway entry.
import { LISTED } from '../core/analysis/common.ts';
import { config, type Session } from './runtime.ts';
import { exportDoc, exportNameProp, exportProp, RESULT_FILE_TOOLS, firstOf, type Table } from './export.ts';
import { loadUpdates, resultExporter, type AnalysisHelpers } from './analysis.ts';
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

/** Every benchmark-derived tool. One entry per tool: add it here with its core file. */
export const FORENSIC_REGISTRY: ForensicTool[] = [];

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
