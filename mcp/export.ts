// The analysis tools' `export` option (owner 2026-11-09): the agent builds Excel sheets, Word reports and slides from an analysis, so
// it needs every number, not the few the chat answer shows. `export: "<folder>"` writes <folder>/<tool>.json, the full result (every
// list complete, whatever top / max_ids / limit / max_rows / buckets cut from the answer), and every table of it beside it as
// <tool>-<table>.csv (UTF-8 with a BOM, as run_report writes CSV, so Excel reads the names right; a header row, also of a table with no
// rows; dates as P6 writes them). Files are named by their tool, so the exports of several tools share a folder; the tool's own files of
// an earlier export there are replaced, none left from it. Everything goes to the files a piece at a time (never one string the size of
// the result), and a list given as a function is read as it is written (evaluate_batch reads its kept file). The folder is a write path
// like the tool's others: inside the write root, never outside, and made before the tool works (exportFolder).
// export_name (owner 2026-11-10): a what-if keeps its own files: <tool>-<name>.json and <tool>-<name>-<table>.csv beside the others, and a
// re-run with the same name replaces only that name's files.
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
export interface Exported {
  folder: string; files: { path: string; bytes: number; rows?: number; columns?: string[] }[];
  /** this tool's files of an earlier export that this one replaced: how many, and when the earlier <tool>.json was written (ISO; the newest of them when it was not there). Absent when none was. */
  replaced?: { files: number; written: string };
}
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

/** The `export_name` argument as it goes into a file name: letters, digits, marks, `.`, `_` and `-` stay, anything else becomes `-`.
 *  Absent: undefined (the unnamed files). Refused as bad_input: a name that is empty, one with no export folder to go in, and "partial"
 *  (or one ending in -partial), which is how a stopped run's files are told from a complete run's. */
export function exportName(v: unknown, folderGiven = true): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'string') return fail('bad_input', 'export_name must be a short text, e.g. "option-a".', 'Pass export_name as a string, or leave it out for the unnamed files.');
  if (!folderGiven) fail('bad_input', 'export_name names files inside the export folder, and no export folder was given.', 'Pass export: "<folder>" with export_name, or leave export_name out.');
  const safe = v.trim().replace(/[^\p{L}\p{N}\p{M}._-]/gu, '-');
  if (!safe) fail('bad_input', 'export_name is empty.', 'Give a short name such as "option-a", or leave export_name out to write the unnamed files.');
  if (/(^|-)partial$/i.test(safe)) fail('bad_input', `export_name "${v.trim()}" cannot end in "partial": a stopped run's files are named -partial.`, 'Choose another name, e.g. "option-a".');
  return safe;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Write the full result and every table into the folder `arg` names, as <tool>.json and <tool>-<table>.csv; the answer's `exported`.
 *  A COMPLETE result replaces every file of this tool's earlier exports there, partial ones too (none left from it). A PARTIAL result
 *  (a run that was stopped or cancelled: o.partial) is written as <tool>-partial.json and <tool>-partial-<table>.csv and replaces only an
 *  earlier partial's files: it never removes the files of a complete run. o.as: the name the files carry when that is not the tool the
 *  work is done by (optimize_schedule's crashing is exported as optimize_schedule, so one tool's files are replaced together).
 *  o.name (export_name): the files are <tool>-<name>.json and <tool>-<name>-<table>.csv (-partial within the name), and only that
 *  name's files are replaced; without it only the unnamed files are, never a named set. (A table's name has no hyphen, which is how
 *  <tool>-<table>.csv is told from <tool>-<name>-<table>.csv.)
 *  What was replaced is said in `replaced`, and each file's size in `bytes`. */
export function exportResult(tool: string, arg: unknown, full: unknown, tables: Table[], writeWith: WriteWith, o: { partial?: boolean; as?: string; name?: unknown } = {}): Exported {
  const folder = exportFolder(arg), given = exportName(o.name);
  const base = `${o.as ?? tool}${given ? `-${given}` : ''}`, name = `${base}${o.partial ? '-partial' : ''}`;
  // a table it no longer has is not left behind; other tools' files, and the files of another name, stay
  const re = reEscape(base);
  const mine = o.partial ? new RegExp(`^${re}-partial(\\.json|-[^-]+\\.csv)$`) : new RegExp(`^${re}(-partial)?(\\.json|-[^-]+\\.csv)$`);
  let replaced = 0, json: Date | null = null, newest: Date | null = null;
  for (const f of readdirSync(folder)) if (mine.test(f)) {
    const p = join(folder, f);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      rmSync(p); replaced++;
      if (f === `${name}.json`) json = st.mtime;
      if (!newest || st.mtime > newest) newest = st.mtime;
    } catch (e) { fail('file_unwritable', `Cannot replace ${p}: ${(e as Error).message}.`, 'Close the file where it is open, or give export another folder.'); }
  }
  const files: Exported['files'] = [];
  const sized = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
  const jsonPath = join(folder, `${name}.json`);
  writeWith(jsonPath, (put) => jsonTo(put, full));
  files.push({ path: jsonPath, bytes: sized(jsonPath) });
  for (const t of tables) {
    // the columns: those named, then any other key a row has (a first pass over the rows)
    const columns = [...t.columns], seen = new Set(columns);
    for (const r of each(t.rows)) for (const k of flat(r).keys()) if (!seen.has(k)) { seen.add(k); columns.push(k); }
    const path = join(folder, `${name}-${t.name}.csv`);
    let n = 0;
    writeWith(path, (put) => {
      put(`\ufeff${columns.map(csvQuote).join(',')}\r\n`);
      for (const r of each(t.rows)) { const c = flat(r); put(`${columns.map((k) => csvQuote(cell(c.get(k)))).join(',')}\r\n`); n++; }
    });
    files.push({ path, bytes: sized(path), rows: n, columns });
  }
  const when = json ?? newest;
  return { folder, files, ...(replaced && when ? { replaced: { files: replaced, written: when.toISOString() } } : {}) };
}

/** A list in an answer that the clone cut, with the total beside it: `<list>_total` (or `total_<list>`, or the names a tool gives it:
 *  CUT_LISTS), and the table of the export that holds it whole (table: default the list's name). */
export interface CutList { list: string; total: string; table?: string; /** the export holds only the list as listed (float_paths between.max: the paths are never all made) */ listedOnly?: true }
/** The cut lists whose names do not follow `<list>_total`, by tool. */
export const CUT_LISTS: Record<string, CutList[]> = {
  lint: [{ list: 'activities', total: 'total_activities', table: 'findings' }],
  check_schedule: [{ list: 'activities', total: 'total_activities', table: 'failing_activities' }],
  dcma_14: [{ list: 'activities', total: 'total_activities', table: 'failing_activities' }],
  evaluate_batch: [{ list: 'changed', total: 'changed_total', table: 'dates_moved' }],
  compare: [{ list: 'changes', total: 'changed' }],
  float_paths: [{ list: 'paths', total: 'paths_total', table: 'between', listedOnly: true }],
};
/** Where the whole of every list this answer cut is, when an export was written: beside each `<list>_total` a `<list>_note`
 *  "25 of 340 shown; all 340 in <the list's table CSV, else <tool>.json>". One place for every tool (callTool applies it to what a tool
 *  answered): the lists the clone cuts (firstOf, top, max_ids, windows, changes pages...) all say it the same way. A total that is a
 *  decimal string (a count beyond 2^53) is printed as it is, never through Number. Nothing is added when no export was written. */
export function noteCuts<T>(answer: T, tool: string): T {
  const ex = answer && typeof answer === 'object' ? (answer as { exported?: Exported }).exported : undefined;
  if (!ex || !Array.isArray(ex.files) || !ex.files.length) return answer;
  const extra = CUT_LISTS[tool] ?? [];
  const where = (table: string) => ex.files.find((f) => f.path.endsWith(`-${table}.csv`))?.path ?? ex.files[0].path;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') walk(x); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const list = o[k];
      if (k === 'exported') continue;
      if (!Array.isArray(list)) { if (list && typeof list === 'object') walk(list); continue; }
      const x = extra.find((e) => e.list === k && e.total in o);
      const total = o[x?.total ?? `${k}_total`] ?? o[`total_${k}`];
      if ((typeof total === 'number' || typeof total === 'string') && (typeof total === 'string' ? /^\d+$/.test(total) : Number.isFinite(total) && total > list.length) && !(`${k}_note` in o)) {
        const shown = list.length, path = where(x?.table ?? k);
        o[`${k}_note`] = x?.listedOnly ? `${shown} of ${total} shown (the most asked for); the export holds the same ${shown} in ${path}, ask for more to have more` : `${shown} of ${total} shown; all ${total} in ${path}`;
      }
      for (const item of list) if (item && typeof item === 'object') walk(item);
    }
  };
  walk(answer);
  return answer;
}

/** An export after the tool changed the project: the change stays whatever happens to the files, so a failure to write them is said
 *  beside the result (export_error), never answered as an error that would hide that the change WAS made. */
export function exportAfterChange(make: () => Exported): { exported: Exported } | { export_error: string } {
  try { return { exported: make() }; }
  catch (e) { return { export_error: `The export was not written (${(e as Error)?.message ?? e}); the change WAS made to the project (undo takes it back).` }; }
}

/** The `export_name` argument of a tool's input schema, beside `export`. */
export const exportNameProp = { type: 'string', description: 'a short name for this run\u2019s files (e.g. "option-a"): they are <tool>-<name>.json and <tool>-<name>-<table>.csv, kept beside the others, and a re-run with the same name replaces only that name\u2019s files; without it the files are <tool>.json and <tool>-<table>.csv, replaced on a re-run. Letters, digits, . _ - are kept, anything else becomes -' };
/** The `export` argument of a tool's input schema. */
export const exportProp = { type: 'string', description: 'a folder (inside the write root) to write the full result to: <tool>.json and <tool>-<table>.csv for each table' };
/** The sentence a tool's description gains on export, naming its CSV files. */
export const exportDoc = (tool: string, csvs: string[]) => ` export: a folder (inside the write root) to write the full result to, for Excel sheets, Word reports or slides: ${tool}.json (every list whole, whatever this answer leaves out) and ${csvs.map((c) => c.replace(/^\w+/, (n) => `${tool}-${n}.csv`)).join(', ')} (UTF-8, a header row, dates as P6 writes them; a re-run replaces this tool\u2019s files in the folder; give export_name to keep an experiment\u2019s files beside the others (<tool>-<name>.json, <tool>-<name>-<table>.csv; only that name\u2019s files are replaced); exported.replaced says how many files and when they were written); exported names each file with its bytes, rows and columns. A stopped or cancelled run (partial) is written as ${tool}-partial.json and ${tool}-partial-<table>.csv and replaces only an earlier partial's files, never a complete run's. Each list the answer cut says where all of it is: <list>_note.`;
