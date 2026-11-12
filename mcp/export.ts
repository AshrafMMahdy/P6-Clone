// The analysis tools' `export` option (owner 2026-11-09): the agent builds Excel sheets, Word reports and slides from an analysis, so
// it needs every number, not the few the chat answer shows. `export: "<folder>"` writes <folder>/<tool>.json, the full result (every
// list complete, whatever top / max_ids / limit / max_rows / buckets cut from the answer), and every table of it beside it as
// <tool>-<table>.csv (UTF-8 with a BOM, as run_report writes CSV, so Excel reads the names right; a header row, also of a table with no
// rows; dates as P6 writes them). Files are named by their tool, so the exports of several tools share a folder; the tool's own files of
// an earlier export there are replaced, none left from it. Everything goes to the files a piece at a time (never one string the size of
// the result), and a list given as a function is read as it is written (evaluate_batch reads its kept file). The folder is a write path
// like the tool's others: inside the write root, never outside, and made before the tool works (exportFolder).
// (owner 2026-11-12) Without `export` the same files are written to analysis/<project short name>/<tool> (defaultResultFolder), for every analysis tool
// (RESULT_FILE_TOOLS): the answer lists at most 25 rows of any list and names the file that holds all of it; a failure to write them is said in
// exported.error, never a refused call.
// export_name (owner 2026-11-10): a what-if keeps its own files: <tool>-<name>.json and <tool>-<name>-<table>.csv beside the others, and a
// re-run with the same name replaces only that name's files.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  /** present when the name given is not the name the files carry: it was changed by cleaning (letters, digits, marks and . _ - stay) and/or cut to fit a file name */
  export_name_used?: { given: string; used: string; note: string };
  /** this tool's files of an earlier export that this one replaced: how many, and when the earlier <tool>.json was written (ISO; the newest of them when it was not there). Absent when none was. */
  replaced?: { files: number; written: string };
  /** the result file of a call that gave no export folder could not be written: what happened and the next step, in words (the call itself is answered) */
  error?: string;
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

/** The longest a file name may be (owner 2026-11-10: "file names must be 250 characters or less; a longer name is cut off at 250
 *  characters automatically"). */
export const EXPORT_FILE_NAME_MAX = 250;
/** A file name's length as the system it is written on counts it: Windows in UTF-16 characters, the others (Linux, macOS) in the bytes
 *  of its UTF-8, so the 250 holds there too (an Arabic or Chinese name takes 2 to 3 bytes a character and would otherwise fail as ENAMETOOLONG). */
export const fileNameLength = (s: string): number => (process.platform === 'win32' ? s.length : Buffer.byteLength(s));
/** The longest table name a tool may declare. The tables are known only when a tool has run, and the name is cut before any work, so
 *  the room is fixed here; tests/mcp-export.test.ts fails when any table declared in the code is longer. */
export const EXPORT_TABLE_NAME_MAX = 32;
/** What a table name may add to a file name: `-partial-<table>.csv`. */
const TABLE_ROOM = EXPORT_TABLE_NAME_MAX + '-partial-'.length + '.csv'.length;

export interface ExportNameParts { /** the name as the files carry it */ name: string; given: string; /** letters, digits, marks, . _ - kept, anything else became - */ cleaned: boolean; /** cut to the file name length, with a short code of the whole name */ cut: boolean }
/** The `export_name` argument as it goes into a file name: letters, digits, marks, `.`, `_` and `-` stay, anything else becomes `-`.
 *  A name too long for the files (<tool>-<name>-partial-<table>.csv at most EXPORT_FILE_NAME_MAX characters) is cut at a character, and
 *  a short code of the name as cleaned (lower-cased: names that differ only in case, or only in characters that became -, are one name) follows so two long names stay apart.
 *  Absent: undefined (the unnamed files). Refused as bad_input: a name that is empty, one with no export folder to go in, and "partial"
 *  (or one ending in -partial), which is how a stopped run's files are told from a complete run's. */
export function exportNameParts(v: unknown, folderGiven = true, tool = ''): ExportNameParts | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'string') return fail('bad_input', 'export_name must be a short text, e.g. "option-a".', 'Pass export_name as a string, or leave it out for the unnamed files.');
  if (!folderGiven) fail('bad_input', 'export_name names files inside the export folder, and no export folder was given.', 'Pass export: "<folder>" with export_name, or leave export_name out.');
  const given = v.trim(), safe = given.replace(/[^\p{L}\p{N}\p{M}._-]/gu, '-');
  if (!safe) fail('bad_input', 'export_name is empty.', 'Give a short name such as "option-a", or leave export_name out to write the unnamed files.');
  if (/(^|-)partial$/i.test(safe)) fail('bad_input', `export_name "${given}" cannot end in "partial": a stopped run's files are named -partial.`, 'Choose another name, e.g. "option-a".');
  const room = EXPORT_FILE_NAME_MAX - fileNameLength(`${tool}-`) - TABLE_ROOM;
  if (fileNameLength(safe) <= room) return { name: safe, given, cleaned: safe !== given, cut: false };
  const code = createHash('sha256').update(safe.toLowerCase()).digest('hex').slice(0, 8);
  let kept = '', used = fileNameLength(`-${code}`);
  for (const ch of safe) { const w = fileNameLength(ch); if (used + w > room) break; kept += ch; used += w; }
  return { name: `${kept}-${code}`, given, cleaned: safe !== given, cut: true };
}
export const exportName = (v: unknown, folderGiven = true, tool = ''): string | undefined => exportNameParts(v, folderGiven, tool)?.name;

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
export function exportResult(tool: string, arg: unknown, full: unknown, tables: Table[], writeWith: WriteWith, o: { partial?: boolean; as?: string; name?: unknown; /** the folder is the default one (no export given): a failure to write is said in `error`, never refuses the call */ soft?: boolean } = {}): Exported {
  if (!o.soft) return writeExport(tool, arg, full, tables, writeWith, o);
  try { return writeExport(tool, arg, full, tables, writeWith, o); }
  catch (e) { return { folder: String(arg), files: [], error: `The result file could not be written to ${String(arg)}: ${(e as Error)?.message ?? e}. The answer is complete, but the whole lists are not on disk. Next step: call again with export set to a folder inside the write root that can be written to.` }; }
}
/** The arguments every export call passes besides the tool's own: the file-name label, and whether the folder is the default one. */
export const exportOf = (a: Record<string, any>, more: { partial?: boolean; as?: string } = {}) => ({ name: a.export_name, soft: a.export_default === true, ...more });

/** The tools whose whole result is written to a file every time (the analysis tools). */
export const RESULT_FILE_TOOLS = new Set(['lint', 'float_paths', 'evaluate', 'evaluate_batch', 'crash_schedule', 'windows_analysis', 'tia', 'compare', 'earned_value', 'progress_curves', 'resource_histogram', 'monte_carlo', 'optimize_schedule', 'dcma_14', 'check_schedule']);
/** The folder a call writes its result to when it gives no export: analysis/<project short name>/<tool>, relative as an export is (the write
 *  root, else the storage root, else where the server runs). The project names are cleaned and cut as export_name is (exportNameParts). */
export function defaultResultFolder(tool: string, projectNames: string[]): string | undefined {
  if (!projectNames.length) return undefined;
  const clean = exportNameParts(projectNames.join('+'), true, tool)!.name;
  return join('analysis', clean, tool);
}

function writeExport(tool: string, arg: unknown, full: unknown, tables: Table[], writeWith: WriteWith, o: { partial?: boolean; as?: string; name?: unknown }): Exported {
  // every export passes here: a table whose name is longer than the room the cut name reserved would make a file name over the limit, so no table can slip past
  for (const t of tables) if (fileNameLength(t.name) > EXPORT_TABLE_NAME_MAX) throw new Error(`internal: the export table "${t.name}" of ${o.as ?? tool} has a name of ${fileNameLength(t.name)} characters, longer than the ${EXPORT_TABLE_NAME_MAX} reserved for it (EXPORT_TABLE_NAME_MAX in mcp/export.ts): shorten the table's name or raise the constant.`);
  const folder = exportFolder(arg), info = exportNameParts(o.name, true, o.as ?? tool), given = info?.name;
  const base = `${o.as ?? tool}${given ? `-${given}` : ''}`, name = `${base}${o.partial ? '-partial' : ''}`;
  // a table it no longer has is not left behind; other tools' files, and the files of another name, stay
  const re = reEscape(base);
  // (case-insensitive: Windows does not tell "Option-A" from "option-a", so they are one name here too)
  const mine = o.partial ? new RegExp(`^${re}-partial(\\.json|-[^-]+\\.csv)$`, 'i') : new RegExp(`^${re}(-partial)?(\\.json|-[^-]+\\.csv)$`, 'i');
  let replaced = 0, json: Date | null = null, newest: Date | null = null;
  for (const f of readdirSync(folder)) if (mine.test(f)) {
    const p = join(folder, f);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      rmSync(p); replaced++;
      if (f.toLowerCase() === `${name}.json`.toLowerCase()) json = st.mtime;
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
  const used = info && (info.cleaned || info.cut) ? { export_name_used: { given: info.given, used: info.name, note: [
    info.cleaned ? 'letters, digits, marks and . _ - are kept in file names and anything else became -' : '',
    info.cut ? `file names are at most ${EXPORT_FILE_NAME_MAX} characters, so the name was cut and a short code of the whole name added (two long names stay apart; the same name once cleaned, in any case, is the same experiment)` : ''].filter(Boolean).join('; ') } } : {};
  return { folder, files, ...used, ...(replaced && when ? { replaced: { files: replaced, written: when.toISOString() } } : {}) };
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
  resource_histogram: [{ list: 'periods_shown_for', total: 'periods_shown_for_total', table: 'periods' }],
  float_paths: [{ list: 'paths', total: 'paths_total', table: 'between', listedOnly: true }],
};
/** Where the whole of every list this answer cut is, when an export was written: beside each `<list>_total` a `<list>_note`
 *  "25 of 340 shown; all 340 in <the list's table CSV, else <tool>.json>". One place for every tool (callTool applies it to what a tool
 *  answered): the lists the clone cuts (firstOf, top, max_ids, windows, changes pages...) all say it the same way. A total that is a
 *  decimal string (a count beyond 2^53) is printed as it is, never through Number. Nothing is added when no export was written. */
export function noteCuts<T>(answer: T, tool: string): T {
  const ex = answer && typeof answer === 'object' ? (answer as { exported?: Exported }).exported : undefined;
  // a result file that could not be written (`exported.error`, or export_error after a change): the notes say how many are shown and name no file
  const failed = (!!ex && !!ex.error) || (!ex && !!answer && typeof answer === 'object' && (answer as { export_error?: unknown }).export_error != null);
  if (!failed && (!ex || !Array.isArray(ex.files) || !ex.files.length)) return answer;
  const extra = CUT_LISTS[tool] ?? [];
  const where = (table: string) => ex?.files.find((f) => f.path.endsWith(`-${table}.csv`))?.path ?? ex?.files[0]?.path ?? '';
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
        o[`${k}_note`] = failed ? `${shown} of ${total} shown` : x?.listedOnly ? `${shown} of ${total} shown (the most asked for); the export holds the same ${shown} in ${path}, ask for more to have more` : `${shown} of ${total} shown; all ${total} in ${path}`;
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
  catch (e) { return { export_error: `The export was not written (${(e as Error)?.message ?? e}); the change WAS made to the project (undo takes it back). Next step: give export a folder inside the write root that can be written to the next time.` }; }
}

/** The `export_name` argument of a tool's input schema, beside `export`. */
export const exportNameProp = { type: 'string', description: 'a short name for this run\u2019s files (e.g. "option-a"): they are <tool>-<name>.json and <tool>-<name>-<table>.csv, kept beside the others in the result folder, and a re-run with the same name (in any case) replaces only that name\u2019s files; without it the files are <tool>.json and <tool>-<table>.csv, replaced on a re-run. Letters, digits, . _ - are kept, anything else becomes - (export_name_used says so). File names must be 250 characters or less: a longer name is cut off at that automatically, with a short code of the whole name added so two long names stay apart (export_name_used says so)' };
/** The `export` argument of a tool's input schema. */
export const exportProp = { type: 'string', description: 'a folder (inside the write root) for the result files instead of the default analysis/<project short name>/<tool>: <tool>.json and <tool>-<table>.csv for each table' };
/** The sentence a tool's description gains for its result files, naming its CSV files. */
export const exportDoc = (tool: string, csvs: string[]) => ` The whole result is written to files every time, without being asked, for Excel sheets, Word reports or slides: ${tool}.json (every list whole, whatever this answer leaves out) and ${csvs.map((c) => c.replace(/^\w+/, (n) => `${tool}-${n}.csv`)).join(', ')} (UTF-8, a header row, dates as P6 writes them), in the folder analysis/<project short name>/${tool} inside the write root (a re-run replaces this tool\u2019s files there). export: a folder of your own (inside the write root) is written instead; give export_name to keep an experiment\u2019s files beside the others (<tool>-<name>.json, <tool>-<name>-<table>.csv; only that name\u2019s files are replaced, whatever the case; file names are at most 250 characters, a longer name is cut off automatically and a name changed by cleaning is told: exported.export_name_used); exported names the folder and each file with its bytes, rows and columns, and exported.replaced says how many files and when they were written. If the files cannot be written the answer says so in exported.error (or export_error) with the next step, and its notes name no file. A stopped or cancelled run (partial) is written as ${tool}-partial.json and ${tool}-partial-<table>.csv and replaces only an earlier partial\u2019s files, never a complete run\u2019s. Every list of this answer shows at most 25 rows: <list>_total says how many there are and <list>_note says "25 of N shown; all N in <file>".`;
