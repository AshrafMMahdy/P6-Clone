// Every table the clone holds, read as it is (MCP list_tables / read_table): the rows of an XER's tables as the file
// had them, and what a P6 XML or a Microsoft Project file carries beyond them. Nothing summarised, nothing dropped:
//   xml:<Tag>  a P6 XML element's value the clone has no column for (kept by p6xml.ts as _xml_<Tag>)
//   msp:<Name> a Microsoft Project element as the file wrote it (keep.ts: _msp_keep, a calendar's _msp_xml); the text of a simple element,
//              the element's XML for one with elements inside; several of the same name, a list
//   XML:<Element>  a P6 XML object the clone has no table for (kept by p6xml.ts as _XML_<Element> rows)
//   MSP:<Kind> a Microsoft Project element that is not a P6 row (the summary task, blank rows, unassigned assignments...)
// A calendar's row also gives its work week and its exceptions, decoded from clndr_data (work_week, exceptions).
//   clone:<field>, CLONE:<TABLE>  the clone's own data beside the file's (a project's EPS, baseline links, saved
//              filters, layouts, reports, portfolios, timesheet lines, risk estimates...): fields and tables starting with "_"
import type { Db, Row } from '../db.ts';
import { parseClndrData, parseClndrDataLeniently, type CalendarDef, type Shift } from '../calendar/clndr-data.ts';
import { formatP6Date, serialToMinutes } from '../dates.ts';
import { parseXml } from '../xml/p6xml.ts';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const shifts = (ss: Shift[]) => ss.map((s) => `${hhmm(s.start)}-${hhmm(s.end)}`);

/** A table's name as the reader sees it, and back. */
const shown = (name: string) => (name.startsWith('_XML_') ? `XML:${name.slice(5)}` : name.startsWith('_') ? `CLONE:${name.slice(1)}` : name);
const stored = (name: string) => (name.startsWith('XML:') ? `_XML_${name.slice(4)}` : name.startsWith('CLONE:') ? `_${name.slice(6)}` : name);
/** Fields read through other columns (xml:, msp:, MSP: tables), not as clone: columns. */
const EXPANDED = new Set(['_msp_keep', '_msp_xml', '_msp_ghosts']);
const cloneField = (f: string) => f.startsWith('_') && !f.startsWith('_xml_') && !EXPANDED.has(f);

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
/** An element's value: the text of a simple one, else its XML. */
function elementValue(xml: string): string {
  const m = /^<([\w:.-]+)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/.exec(xml.trim());
  if (!m) return /^<[\w:.-]+(?:\s[^>]*)?\/>$/.test(xml.trim()) ? '' : xml;
  return m[2].includes('<') ? xml : unxml(m[2]);
}
/** A Microsoft Project element's children, by name (msp:<Name>). */
function mspFields(r: Row): Record<string, string | string[]> | null {
  let kids: [string, string | null][];
  if (r._msp_keep) {
    // a task's, resource's or assignment's: its children; the project's: { kids, ... }
    try { const k = JSON.parse(r._msp_keep) as [string, string | null][] | { kids?: [string, string | null][] }; kids = Array.isArray(k) ? k : k.kids ?? []; } catch { return { 'msp:_unreadable': r._msp_keep }; } // (kept as it is: not lost, and not silent)
  } else if (r._msp_xml) {
    // a calendar: kept whole, as its element
    const root = parseXml(r._msp_xml), el = root.children[0];
    kids = el ? el.children.map((c): [string, string] => [c.name, r._msp_xml.slice(c.s ?? 0, c.e ?? 0)]) : [];
  } else return null;
  const out: Record<string, string | string[]> = {};
  for (const [name, xml] of kids) {
    if (xml == null) continue; // a collection the project element holds (its tasks, resources...): rows of their own
    const v = elementValue(xml), k = `msp:${name}`;
    const was = out[k];
    out[k] = was == null ? v : Array.isArray(was) ? [...was, v] : [was, v];
  }
  return out;
}
/** A calendar's work week and exceptions, decoded from its clndr_data. */
function calendarFields(r: Row): Record<string, unknown> {
  // work_week_source: strict (read exactly as P6's syntax), lenient_guess (a guess from text P6 would not take: do not schedule from it as if exact), none (no week could be read)
  const decoded = (def: CalendarDef, note: string | null) => ({
    work_week_source: note ? 'lenient_guess' : 'strict',
    work_week: Object.fromEntries(def.week.map((ss, i) => [DAYS[i], shifts(ss)])),
    exceptions: [...def.exceptions.entries()].sort((a, b) => a[0] - b[0]).map(([d, ss]) => ({ date: formatP6Date(serialToMinutes(d)).slice(0, 10), work: shifts(ss) })),
    calendar_note: note,
  });
  try { return decoded(parseClndrData(r.clndr_data ?? ''), null); } catch (e) {
    // text that is not P6's syntax (written by another tool): read as far as it can be, and said so; clndr_data is always the file's text as it is
    const why = (e as Error).message;
    const def = r.clndr_data ? parseClndrDataLeniently(r.clndr_data) : null;
    if (def) return decoded(def, `GUESS, NOT EXACT: clndr_data is not valid P6 syntax (${why}; P6 would not take it): work_week and exceptions are read from it as far as its text allows; clndr_data is the file's text as it is.`);
    return { work_week_source: 'none', work_week: null, exceptions: null, calendar_note: r.clndr_data ? `clndr_data could not be decoded (${why}): it is given as it is in clndr_data.` : null };
  }
}

/** The projects a project argument names (Project ID, a baseline's too, or the proj_id), else null (every row). */
export function projectFilter(db: Db, project: unknown): string[] | null {
  if (project == null || project === '') return null;
  const ps = db.tables.PROJECT?.rows ?? [], key = String(project).toLowerCase();
  const p = ps.find((x) => (x.proj_short_name ?? '').toLowerCase() === key) ?? ps.find((x) => x.proj_id === String(project));
  if (!p) throw new RangeError(`No project "${project}". Projects (and baselines) in this file: ${ps.map((x) => x.proj_short_name).join(', ')}.`);
  return [p.proj_id];
}
const inProjects = (t: { fields: string[] }, ids: string[] | null) => (r: Row) => !ids || !t.fields.includes('proj_id') || ids.includes(r.proj_id);

/** A table's columns as read_table gives them: the file's fields, then the kept extras, then the decoded ones. */
function columnsOf(name: string, t: { fields: string[]; rows: Row[] }, rows: Row[]): string[] {
  const own = t.fields.filter((f) => !f.startsWith('_'));
  const xml = t.fields.filter((f) => f.startsWith('_xml_')).map((f) => `xml:${f.slice(5)}`);
  const msp = new Set<string>();
  for (const r of rows) { const m = mspFields(r); if (m) for (const k of Object.keys(m)) msp.add(k); }
  const clone = t.fields.filter(cloneField).map((f) => `clone:${f.slice(1)}`);
  return [...own, ...xml, ...msp, ...clone, ...(name === 'CALENDAR' ? ['work_week_source', 'work_week', 'exceptions', 'calendar_note'] : [])];
}

/** Microsoft Project elements that are not P6 rows (keep.ts ghosts: the project summary task, blank rows, the blank
 *  resource, unassigned assignments, resource calendars folded into their base), as tables MSP:Task, MSP:Resource,
 *  MSP:Assignment, MSP:Calendar: each element's children as msp:<Name>. */
function ghostTables(db: Db): Record<string, { fields: string[]; rows: Row[] }> {
  const out: Record<string, { fields: string[]; rows: Row[] }> = {};
  const KIND: Record<string, string> = { tasks: 'MSP:Task', resources: 'MSP:Resource', assignments: 'MSP:Assignment', calendars: 'MSP:Calendar' };
  for (const p of db.tables.PROJECT?.rows ?? []) {
    if (!p._msp_ghosts) continue;
    let g: Record<string, { xml?: string; kids?: [string, string][] }[]>;
    try { g = JSON.parse(p._msp_ghosts); } catch { continue; }
    for (const [kind, list] of Object.entries(g)) {
      if (!KIND[kind] || !Array.isArray(list)) continue;
      const t = (out[KIND[kind]] ??= { fields: ['proj_id'], rows: [] });
      for (const x of list) t.rows.push(x.xml ? { proj_id: p.proj_id, _msp_xml: x.xml } : { proj_id: p.proj_id, _msp_keep: JSON.stringify(x.kids ?? []) });
    }
  }
  return out;
}
/** The XER's first line (ERMHDR) as a one-row table: what the file says of itself - the P6 version, the export date, what was exported, by whom,
 *  from which database, the currency - as P6 names the fields, then any further field of the line (field_8...), the whole line, and the text
 *  encoding the clone read the file in. */
const HEADER_FIELDS = ['version', 'export_date', 'export_type', 'export_user', 'database_name', 'module', 'currency'];
function headerTable(db: Db): { fields: string[]; rows: Row[] } | null {
  const h = db.header;
  if (!h) return null;
  const parts = h.raw?.length ? h.raw.slice(1) : [h.version, h.exportDate];
  const row: Row = {};
  const fields = parts.map((_, i) => HEADER_FIELDS[i] ?? `field_${i + 1}`);
  parts.forEach((v, i) => { row[fields[i]] = v; });
  row.raw_line = ['ERMHDR', ...parts].join('\t');
  if (h.encoding) row._encoding = h.encoding;
  return { fields: [...fields, 'raw_line', ...(h.encoding ? ['_encoding'] : [])], rows: [row] };
}
/** Every table the reader sees, by the name it sees: the file's tables, kept XML objects, Microsoft Project's elements
 *  that are not rows. */
function tablesOf(db: Db): Map<string, { real: string; t: { fields: string[]; rows: Row[] } }> {
  const m = new Map<string, { real: string; t: { fields: string[]; rows: Row[] } }>();
  const hdr = headerTable(db);
  if (hdr) m.set('ERMHDR', { real: 'ERMHDR', t: hdr });
  for (const [n, t] of Object.entries(db.tables)) m.set(shown(n), { real: n, t });
  for (const [n, t] of Object.entries(ghostTables(db))) m.set(n, { real: n, t });
  return m;
}

export interface TableInfo { name: string; columns: string[]; rows: number; per_project: boolean }
/** Every table, its columns and rows (of the projects asked for, where the table has a project column). */
export function listTables(db: Db, projIds: string[] | null): TableInfo[] {
  return [...tablesOf(db)].map(([name, { real, t }]) => {
    const rows = t.rows.filter(inProjects(t, projIds));
    return { name, columns: columnsOf(real, t, rows), rows: rows.length, per_project: t.fields.includes('proj_id') };
  });
}

export interface TableRead { table: string; columns: string[]; rows: unknown[][]; total: number; offset: number; next_offset?: number }
/** A table's rows, every column (or those asked for), paged: no cap on limit. */
export function readTable(db: Db, name: string, projIds: string[] | null, o: { offset?: number; limit?: number; columns?: string[] } = {}): TableRead {
  const all_ = tablesOf(db);
  const hit = all_.get(name) ?? [...all_].find(([k]) => k.toLowerCase() === name.toLowerCase() || stored(k) === stored(name))?.[1];
  if (!hit) throw new RangeError(`No table "${name}". Tables in this file: ${[...all_.keys()].join(', ')}.`);
  const { real: realName, t } = hit;
  const shownName = [...all_].find(([, v]) => v === hit)![0];
  const all = t.rows.filter(inProjects(t, projIds));
  const offset = Math.max(0, Math.floor(Number(o.offset) || 0)), limit = o.limit == null ? 1000 : Math.max(1, Math.floor(Number(o.limit) || 1000));
  const page = all.slice(offset, offset + limit);
  const every = columnsOf(realName, t, all);
  let columns = every;
  if (o.columns?.length) {
    const unknown = o.columns.filter((c) => !every.includes(c));
    if (unknown.length) throw new RangeError(`No column ${unknown.map((c) => `"${c}"`).join(', ')} in ${shownName}. Its columns: ${every.join(', ')}.`);
    columns = o.columns;
  }
  const rows = page.map((r) => {
    const msp = mspFields(r), cal = realName === 'CALENDAR' && (columns.includes('work_week') || columns.includes('exceptions') || columns.includes('calendar_note')) ? calendarFields(r) : null;
    return columns.map((c) => (c.startsWith('xml:') ? r[`_xml_${c.slice(4)}`] ?? null : c.startsWith('msp:') ? msp?.[c] ?? null : c.startsWith('clone:') ? r[`_${c.slice(6)}`] ?? null : cal && c in cal ? cal[c] : r[c] ?? null));
  });
  return { table: shownName, columns, rows, total: all.length, offset, ...(offset + page.length < all.length ? { next_offset: offset + page.length } : {}) };
}
