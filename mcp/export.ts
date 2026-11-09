// The analysis tools' `export` option (owner 2026-11-09): the agent builds Excel sheets, Word reports and slides from an analysis, so
// it needs every number, not the few the chat answer shows. `export: "<folder>"` writes <folder>/<tool>.json, the full result (every
// list complete, whatever top / max_ids / limit / max_rows / buckets cut from the answer), and every table of it beside it as
// <tool>-<table>.csv (UTF-8 with a BOM, as run_report writes CSV, so Excel reads the names right; a header row, also of a table with no
// rows; dates as P6 writes them). Files are named by their tool, so the exports of several tools share a folder; the tool's own files of
// an earlier export there are replaced, none left from it. Everything goes to the files a piece at a time (never one string the size of
// the result), and a list given as a function is read as it is written (evaluate_batch reads its kept file). The folder is a write path
// like the tool's others: inside the write root, never outside, and made before the tool works (exportFolder).
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { csvQuote } from '../core/report/reports.ts';
import { fail, pathArg } from './runtime.ts';

/** A list in a result or a table: the items, or a function that gives them each time it is called (read as it is written). */
export type Rows = object[] | (() => Iterable<object>);
/** One table of a result: a CSV of its rows. columns: its columns in order (the header row, also of a table with no rows); a key a
 *  row has beyond them (a nested object's parts, a milestone of Monte Carlo's) follows, in the order it first appears. */
export interface Table { name: string; columns: string[]; rows: Rows }
/** What an answer says it exported. */
export interface Exported { folder: string; files: { path: string; rows?: number; columns?: string[] }[] }
/** writeOutWith: a file made piece by piece, written atomically. */
export type WriteWith = (path: string, make: (put: (piece: string) => void) => void) => void;

/** The first `max` of a list as the chat answer shows it (0 or less, or not a number: all), as the engines cut theirs. */
export const firstOf = <T>(list: T[], max: number): T[] => (max > 0 ? list.slice(0, max) : list);

/** The export folder, inside the write root and made now: a folder that cannot be made is refused before the tool does anything. */
export function exportFolder(arg: unknown): string {
  const folder = pathArg(arg, 'export', 'write');
  try { mkdirSync(folder, { recursive: true }); }
  catch (e) { fail('file_unwritable', `Cannot make the export folder ${folder}: ${(e as Error).message}.`, 'Give export a folder path (not a file) inside the write root.'); }
  return folder;
}

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
/** A cell's text. Text starting with = + or @ (names from a file) gets a leading ' so Excel shows it rather than runs it as a formula;
 *  numbers are written as they are. */
const cell = (v: unknown): string => {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const t = Array.isArray(v) ? (v.some((x) => x && typeof x === 'object') ? JSON.stringify(v) : v.map((x) => (x == null ? '' : String(x))).join('; ')) : String(v);
  return /^[=+@]/.test(t) ? `'${t}` : t;
};
const each = (rows: Rows): Iterable<object> => (typeof rows === 'function' ? rows() : rows);

/** A value as JSON, a piece at a time: objects and lists are opened and walked (a list given as a function is read as it is
 *  written), down to their small parts, each stringified on its own. */
function jsonTo(put: (s: string) => void, v: unknown, depth = 0): void {
  if (typeof v === 'function') v = (v as () => Iterable<unknown>)();
  if (v == null || typeof v !== 'object' || depth > 3) { put(JSON.stringify(v) ?? 'null'); return; }
  if (Array.isArray(v) || Symbol.iterator in v) {
    put('['); let first = true;
    for (const x of v as Iterable<unknown>) { if (!first) put(','); first = false; jsonTo(put, x === undefined ? null : x, depth + 1); }
    put(']'); return;
  }
  put('{'); let first = true;
  for (const [k, x] of Object.entries(v)) { if (x === undefined) continue; if (!first) put(','); first = false; put(`${JSON.stringify(k)}:`); jsonTo(put, x, depth + 1); }
  put('}');
}

/** Write the full result and every table into the folder `arg` names (replacing this tool's files of an earlier export there); the
 *  answer's `exported`. */
export function exportResult(tool: string, arg: unknown, full: unknown, tables: Table[], writeWith: WriteWith): Exported {
  const folder = exportFolder(arg);
  // this tool's own files of an earlier export go (a table it no longer has is not left behind); other tools' stay
  const mine = new RegExp(`^${tool}(\\.json|-.*\\.csv)$`);
  for (const f of readdirSync(folder)) if (mine.test(f)) { const p = join(folder, f); try { if (statSync(p).isFile()) rmSync(p); } catch (e) { fail('file_unwritable', `Cannot replace ${p}: ${(e as Error).message}.`, 'Close the file where it is open, or give export another folder.'); } }
  const files: Exported['files'] = [];
  const json = join(folder, `${tool}.json`);
  writeWith(json, (put) => jsonTo(put, full));
  files.push({ path: json });
  for (const t of tables) {
    // the columns: those named, then any other key a row has (a first pass over the rows)
    const columns = [...t.columns], seen = new Set(columns);
    for (const r of each(t.rows)) for (const k of flat(r).keys()) if (!seen.has(k)) { seen.add(k); columns.push(k); }
    const path = join(folder, `${tool}-${t.name}.csv`);
    let n = 0;
    writeWith(path, (put) => {
      put(`\ufeff${columns.map(csvQuote).join(',')}\r\n`);
      for (const r of each(t.rows)) { const c = flat(r); put(`${columns.map((k) => csvQuote(cell(c.get(k)))).join(',')}\r\n`); n++; }
    });
    files.push({ path, rows: n, columns });
  }
  return { folder, files };
}

/** An export after the tool changed the project: the change stays whatever happens to the files, so a failure to write them is said
 *  beside the result (export_error), never answered as an error that would hide that the change WAS made. */
export function exportAfterChange(make: () => Exported): { exported: Exported } | { export_error: string } {
  try { return { exported: make() }; }
  catch (e) { return { export_error: `The export was not written (${(e as Error)?.message ?? e}); the change WAS made to the project (undo takes it back).` }; }
}

/** The `export` argument of a tool's input schema. */
export const exportProp = { type: 'string', description: 'a folder (inside the write root) to write the full result to: <tool>.json and <tool>-<table>.csv for each table' };
/** The sentence a tool's description gains on export, naming its CSV files. */
export const exportDoc = (tool: string, csvs: string[]) => ` export: a folder (inside the write root) to write the full result to, for Excel sheets, Word reports or slides: ${tool}.json (every list whole, whatever this answer leaves out) and ${csvs.map((c) => c.replace(/^\w+/, (n) => `${tool}-${n}.csv`)).join(', ')} (UTF-8, a header row, dates as P6 writes them; an earlier export of this tool there is replaced); exported names each file with its rows and columns.`;
