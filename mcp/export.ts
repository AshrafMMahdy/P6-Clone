// The analysis tools' `export` option (owner 2026-11-09): the agent builds Excel sheets, Word reports and slides from an analysis, so
// it needs every number, not the few the chat answer shows. `export: "<folder>"` writes <folder>/<tool>.json, the full result (every
// list complete, whatever top / max_ids / limit / max_rows / buckets cut from the answer), and one CSV per table of it beside it
// (UTF-8 with a BOM, as run_report writes CSV, so Excel reads the names right; a header row; dates as P6 writes them). The folder is
// a write path like the tool's others: inside the write root, never outside.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { reportCsv } from '../core/report/reports.ts';
import { fail, pathArg } from './runtime.ts';

/** One table of a result: a CSV of its rows. columns: its columns in order (the header row, also of a table with no rows); a key a
 *  row has beyond them (a nested object's parts, a milestone of Monte Carlo's) follows, in the order it first appears. */
export interface Table { name: string; columns: string[]; rows: object[] }
/** What an answer says it exported. */
export interface Exported { folder: string; files: { path: string; rows?: number; columns?: string[] }[] }

/** The first `max` of a list as the chat answer shows it (0 or less, or not a number: all), as the engines cut theirs. */
export const firstOf = <T>(list: T[], max: number): T[] => (max > 0 ? list.slice(0, max) : list);

/** A row's cells by column: nested objects as their own columns (threshold.op -> threshold_op), lists of values joined by "; ",
 *  lists of objects (edit operations) as JSON; nothing (null, NaN) as an empty cell. */
function flat(row: object, into: Map<string, unknown> = new Map(), prefix = ''): Map<string, unknown> {
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    const key = prefix + k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, into, `${key}_`);
    else into.set(key, v);
  }
  return into;
}
const cell = (v: unknown): string => {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (Array.isArray(v)) return v.some((x) => x && typeof x === 'object') ? JSON.stringify(v) : v.map(cell).join('; ');
  return String(v);
};

/** Write the full result and its tables into the folder `arg` names; the answer's `exported`. */
export function exportResult(tool: string, arg: unknown, full: unknown, tables: Table[], writeOut: (path: string, data: string) => void): Exported {
  const folder = pathArg(arg, 'export', 'write');
  try { mkdirSync(folder, { recursive: true }); } // inside the write root (pathArg checked it)
  catch (e) { fail('file_unwritable', `Cannot make the folder ${folder}: ${(e as Error).message}.`, 'Give export a folder path (not a file) inside the write root.'); }
  const files: Exported['files'] = [];
  const json = join(folder, `${tool}.json`);
  writeOut(json, JSON.stringify(full, null, 1));
  files.push({ path: json });
  for (const t of tables) {
    const cells = t.rows.map((r) => flat(r)), columns = [...t.columns];
    const seen = new Set(columns);
    for (const c of cells) for (const k of c.keys()) if (!seen.has(k)) { seen.add(k); columns.push(k); }
    const path = join(folder, `${t.name}.csv`);
    writeOut(path, '\ufeff' + reportCsv({ title: t.name, columns, rows: cells.map((c) => ({ cells: columns.map((k) => cell(c.get(k))) })) }) + '\r\n');
    files.push({ path, rows: t.rows.length, columns });
  }
  return { folder, files };
}

/** The `export` argument of a tool's input schema. */
export const exportProp = { type: 'string', description: 'a folder (inside the write root) to write the full result to: <tool>.json and a CSV per table' };
/** The sentence a tool's description gains on export, naming its CSV files. */
export const exportDoc = (tool: string, csvs: string[]) => ` export: a folder (inside the write root) to write the full result to, for Excel sheets, Word reports or slides: ${tool}.json (every list whole, whatever this answer leaves out) and ${csvs.map((c) => c.replace(/^\w+/, (n) => `${n}.csv`)).join(', ')} (UTF-8, a header row, dates as P6 writes them); exported names each file with its rows and columns.`;
