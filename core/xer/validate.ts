import { KEYS, refTarget, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { sortFindings, type Finding, type Severity } from '../findings.ts';
import { parseClndrData, hoursPerWeek } from '../calendar/clndr-data.ts';
import { ENUMS, fieldType, fieldsFor, knownFields, knownTables } from './schema.ts';
import { actualAfterDataDate, defaultCalendarWeek, hoursAsDays, loopNote, namesText, noDataDateUsed, plural } from '../notes.ts';

/** What a table's row is called in a message (the Activity, relationship, resource... the planner knows, never the table's name). */
const WORD: Record<string, string> = { TASK: 'activity', TASKPRED: 'relationship', PROJWBS: 'WBS element', PROJECT: 'project', RSRC: 'resource', TASKRSRC: 'resource assignment', CALENDAR: 'calendar', ACTVCODE: 'activity code value', ACTVTYPE: 'activity code type', UDFTYPE: 'user-defined field', UDFVALUE: 'user-defined field value', TASKACTV: 'activity code assignment', PROJCOST: 'expense', TASKMEMO: 'activity notebook topic', OBS: 'OBS element', CURRTYPE: 'currency', RSRCRATE: 'resource rate', ACCOUNT: 'cost account', ROLES: 'role', PCATTYPE: 'project code type', PCATVAL: 'project code value', RCATTYPE: 'resource code type', RCATVAL: 'resource code value', EPS: 'EPS node' };
export const wordOf = (table: string) => WORD[table] ?? `${table} row`;

/** Two rows that are the same row twice: every field equal. */
export const sameRow = (a: Row, b: Row): boolean => { const ks = new Set([...Object.keys(a), ...Object.keys(b)]); for (const k of ks) if ((a[k] ?? '') !== (b[k] ?? '')) return false; return true; };

/** The scheduler's rule for loops (one place for it): level of effort and WBS summary activities are not part of a loop, so a chain through one is not a loop. */
export const inLoopCheck = (taskType: string | undefined): boolean => taskType !== 'TT_LOE' && taskType !== 'TT_WBS';
/** The loops of a set of relationships (pred -> succ pairs): the strongly connected sets of more than one activity. */
export function loopsOfLinks(links: Iterable<[string, string]>): string[][] {
  const succ = new Map<string, string[]>();
  for (const [a, b] of links) { let l = succ.get(a); if (!l) succ.set(a, (l = [])); l.push(b); }
  return findLoops(succ);
}

/** The loops in the logic of the file (a stored baseline is not judged: F9 never runs on it), by the scheduler's own rule (inLoopCheck): each with its activities
 *  and every project it runs through (relationships between projects can close a loop that no one project holds alone). */
export function projectLoops(db: Db): { projIds: string[]; tasks: Row[] }[] {
  const P = db.tables.PROJECT?.rows ?? [], baselines = new Set(P.filter((p) => p._baseline_of).map((p) => p.proj_id));
  const byId = new Map<string, Row>();
  for (const t of db.tables.TASK?.rows ?? []) if (!baselines.has(t.proj_id) && !byId.has(t.task_id)) byId.set(t.task_id, t);
  const links: [string, string][] = [];
  for (const r of db.tables.TASKPRED?.rows ?? []) { const a = byId.get(r.pred_task_id), b = byId.get(r.task_id); if (a && b && inLoopCheck(a.task_type) && inLoopCheck(b.task_type)) links.push([r.pred_task_id, r.task_id]); }
  return loopsOfLinks(links).map((ids) => { const tasks = ids.map((id) => byId.get(id)!); return { projIds: [...new Set(tasks.map((t) => t.proj_id))], tasks }; });
}
/** The loops as the agent reads them, grouped by the projects they run through (a loop is said once, whatever the number of its projects): the Project IDs, and each
 *  loop's Activity IDs (with its Project ID where the loop runs through several). `only`: the loops that touch one of these projects. */
export interface LoopGroup { projIds: string[]; projs: string[]; loops: string[][] }
export function loopGroups(db: Db, only?: string[], loops = projectLoops(db)): LoopGroup[] {
  const name = new Map((db.tables.PROJECT?.rows ?? []).map((p) => [p.proj_id, p.proj_short_name || p.proj_id]));
  const out = new Map<string, LoopGroup>();
  for (const l of loops) {
    if (only && !l.projIds.some((id) => only.includes(id))) continue;
    const key = [...l.projIds].sort().join('|');
    const g = out.get(key) ?? { projIds: l.projIds, projs: l.projIds.map((id) => name.get(id) ?? id), loops: [] };
    out.set(key, g);
    g.loops.push(l.tasks.map((t) => (l.projIds.length > 1 ? `${t.task_code} in ${name.get(t.proj_id) ?? t.proj_id}` : t.task_code)));
  }
  return [...out.values()];
}

const KNOWN_VERSION = /^(3\.5|4\.[01]|5\.0(\.\d+)?|6\.[0-2](\.\d+)?|7\.0(\.\d+)?|8\.[1-4](\.\d+)?|1[5-9]\.\d+|2[0-6]\.\d+)$/;
const PER_KIND_CAP = 5;
/** Column sizes in the P6 database (characters). */
export const MAX_LEN: Record<string, number> = { 'TASK.task_code': 40, 'TASK.task_name': 120, 'PROJWBS.wbs_short_name': 40, 'PROJWBS.wbs_name': 100, 'PROJECT.proj_short_name': 40 };

/** Severity when a reference does not resolve. Unlisted = warning. */
const REF_SEVERITY: Record<string, Severity> = {
  'TASK.proj_id': 'error', 'TASK.wbs_id': 'error', 'PROJWBS.proj_id': 'error',
  'TASKPRED.task_id': 'error', 'TASKPRED.pred_task_id': 'warning', 'TASKPRED.pred_proj_id': 'info', 'TASKPRED.proj_id': 'error',
  'TASKRSRC.task_id': 'error', 'TASKRSRC.rsrc_id': 'error', 'TASKRSRC.proj_id': 'error',
  'TASKACTV.task_id': 'error', 'TASKACTV.actv_code_id': 'error', 'ACTVCODE.actv_code_type_id': 'error',
  'UDFVALUE.udf_type_id': 'error', 'PROJCOST.task_id': 'error', 'TASKMEMO.task_id': 'error',
};
const REF_P6: Record<Severity, string> = {
  fatal: 'P6 rejects the file.',
  error: 'P6 import fails or the row is rejected.',
  warning: 'P6 imports and substitutes a default (e.g. project default calendar, root OBS).',
  info: 'P6 keeps it as an external relationship if that project exists in the database, otherwise drops it.',
};

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bd = 4;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

class Collector {
  out: Finding[] = [];
  private counts = new Map<string, number>();
  add(f: Finding): void {
    const k = `${f.code}|${f.table ?? ''}|${f.field ?? ''}`;
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    if (n <= PER_KIND_CAP) this.out.push(f);
  }
  finish(): Finding[] {
    for (const [k, n] of this.counts) {
      if (n <= PER_KIND_CAP) continue;
      const first = this.out.find((f) => `${f.code}|${f.table ?? ''}|${f.field ?? ''}` === k)!;
      this.out.push({ ...first, row: undefined, key: undefined, omitted: n - PER_KIND_CAP, message: `${PER_KIND_CAP} of ${n} ${first.code} findings${first.table ? ` in ${first.table}${first.field ? '.' + first.field : ''}` : ''} shown.` });
    }
    return this.out;
  }
}

/** Validate a parsed XER the way P6 import would, with diagnostics. Returns parse findings plus rule findings, worst first. */
export function validateXer(db: Db, parseFindings: Finding[] = []): Finding[] {
  const c = new Collector();
  parseFindings.forEach((f) => c.add(f));
  const T = db.tables;
  const version = db.header?.version ?? '';
  const raw = db.header?.raw ?? [];
  // activities and projects are named by their Activity ID and Project ID in every message (never an internal id)
  const projShort = new Map((T.PROJECT?.rows ?? []).map((p) => [p.proj_id, p.proj_short_name || p.proj_id]));
  const manyProj = projShort.size > 1;
  const firstTask = new Map<string, Row>();
  for (const t of T.TASK?.rows ?? []) if (!firstTask.has(t.task_id)) firstTask.set(t.task_id, t);
  const actName = (t: Row) => `${t.task_code || '(no Activity ID)'}${manyProj ? ` (project ${projShort.get(t.proj_id) ?? t.proj_id})` : ''}`;
  const act = (id: string) => { const t = firstTask.get(id); return t ? actName(t) : '(an activity that is not in the file)'; };
  const dupTaskRows = new Set<Row>(); // TASK rows reported as a repeated key: not reported again as a repeated Activity ID

  // Header
  if (db.header) {
    if (!KNOWN_VERSION.test(version)) c.add({ severity: 'warning', code: 'VERSION_UNKNOWN', message: `The file says P6 version ${version}, which is not a P6 release: some P6 versions refuse it; save with version: <release> to restamp it.`, p6: '' });
    if (raw[3] !== 'Project' && !(raw[3] === '' && raw[4] === 'Project')) c.add({ severity: 'warning', code: 'HEADER_FORMAT', message: `ERMHDR 4th value is "${raw[3] ?? ''}", P6 writes "Project".`, p6: 'P6 expects ERMHDR, version, date, "Project", user, user name, database, "Project Management", currency.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw[2] ?? '')) c.add({ severity: 'warning', code: 'HEADER_DATE', message: `ERMHDR export date "${raw[2] ?? ''}" is not yyyy-mm-dd.`, p6: 'P6 writes the export date without a time.' });
  }

  // Tables, fields, values
  const known = knownTables();
  const ref = fieldsFor(KNOWN_VERSION.test(version) ? version : '19.12', 'TASK') ? (KNOWN_VERSION.test(version) ? version : '19.12') : '7.0';
  for (const t of Object.values(T)) {
    if (t.name === 'EPS' || t.name.startsWith('_')) continue; // the clone's own in-memory tables (never written to a file)
    if (!known.has(t.name)) {
      c.add({ severity: 'warning', code: 'TABLE_UNKNOWN', table: t.name, message: `Table ${t.name} is not a P6 table: P6 ignores it, its ${plural(t.rows.length, 'row')} ${t.rows.length === 1 ? 'is' : 'are'} lost on import.`, p6: '' });
      continue;
    }
    const kf = knownFields(t.name);
    const key = KEYS[t.name];
    if (key && kf.has(key) && !t.fields.includes(key) && t.rows.length) { // (a table with no rows has no ids to lack: an empty project is only said to have none)
      const s = suggest(key, t.fields);
      c.add({ severity: 'fatal', code: 'MISSING_KEY_FIELD', table: t.name, field: key, message: `The ${wordOf(t.name)} rows have no unique id column${s ? ` (found "${s}" instead)` : ''}: P6 refuses the file; open_file lenient: true repairs it.`, p6: '' });
    }
    for (const f of t.fields) {
      if (kf.size && !kf.has(f) && !f.startsWith('_')) { // _fields are the clone's own, never written to a file
        const s = suggest(f, kf);
        c.add({ severity: 'warning', code: 'FIELD_UNKNOWN', table: t.name, field: f, message: `${t.name}.${f} is not a P6 field: its values are lost on import${s ? ` (did you mean ${s}?)` : ''}.`, p6: '' });
      }
    }
    const expected = fieldsFor(ref, t.name) ?? [];
    const missing = expected.filter((f) => !t.fields.includes(f));
    if (missing.length) c.add({ severity: 'info', code: 'MISSING_FIELD', table: t.name, message: `${t.name} lacks ${missing.length} of ${expected.length} P6 ${ref} fields: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}.`, p6: 'P6 fills missing columns with defaults.' });

    const seen = new Map<string, Row>(), rowOf = new Map<Row, number>();
    // each column's rule, worked out once per table (not per value: a big file has millions of values)
    const cols = t.fields.filter((f) => kf.has(f)).map((f) => ({ f, max: MAX_LEN[`${t.name}.${f}`], en: ENUMS[`${t.name}.${f}`], ty: fieldType(f) }));
    const hasKey = !!key && t.fields.includes(key);
    t.rows.forEach((r, i) => {
      const row = i + 1;
      if (hasKey) {
        const k = r[key];
        if (!k) c.add({ severity: 'error', code: 'EMPTY_KEY', table: t.name, row, field: key, message: `${t.name} row ${row} has empty ${key}.`, p6: 'P6 rejects the row.' });
        else if (seen.has(k)) {
          const same = sameRow(seen.get(k)!, r);
          if (t.name === 'TASK') dupTaskRows.add(r);
          c.add({ severity: 'fatal', code: 'DUP_KEY', table: t.name, row, key: k, field: key, message: t.name === 'TASK'
            ? (same ? `Activity ${actName(r)} appears twice in the file (rows ${seen.get(k) ? rowOf.get(seen.get(k)!) : '?'} and ${row}): P6 refuses the file; save with repair: true removes the identical copy.` : `Activity ${actName(r)} appears twice in the file (rows ${seen.get(k) ? rowOf.get(seen.get(k)!) : '?'} and ${row}) with different contents: P6 refuses the file; save with repair: true gives this one a new key when its Activity ID tells the two apart.`)
            : `${wordOf(t.name)} ${k} appears twice in the file (rows ${seen.get(k) ? rowOf.get(seen.get(k)!) : '?'} and ${row}): P6 refuses the file; save with repair: true ${same ? 'removes the identical copy' : 'gives the second a new key when nothing points at it'}.`, p6: 'P6 import fails with a unique constraint error.' });
        } else { seen.set(k, r); rowOf.set(r, row); }
      }
      for (const { f, max, en, ty } of cols) {
        const v = r[f];
        if (v === '' || v == null) continue;
        if (max && v.length > max) c.add({ severity: 'error', code: 'FIELD_TOO_LONG', table: t.name, row, field: f, key: key ? r[key] : undefined, message: `${t.name}.${f} is ${v.length} characters, P6 allows ${max}: "${v.slice(0, 50)}…".`, p6: `P6 stores at most ${max} characters here; depending on the database the import fails or the value is cut.` });
        if (en) {
          if (t.name === 'TASKPRED' && f === 'pred_type' && /^PR_(FS|SS|FF|SF)\d$/.test(v)) {
            c.add({ severity: 'warning', code: 'LEGACY_REL_TYPE', table: t.name, row, field: f, message: `TASKPRED.pred_type = "${v}" is a legacy numbered code (seen in P6 5.0 exports).`, p6: 'Old P6 builds accept it as the base type; current P6 expects PR_FS/PR_SS/PR_FF/PR_SF.' });
            continue;
          }
          if (!en.includes(v)) c.add({ severity: 'error', code: 'BAD_ENUM', table: t.name, row, field: f, key: key ? r[key] : undefined, message: `${t.name === 'TASK' && r.task_code ? `${r.task_code} ` : ''}${t.name}.${f} is "${v}", not a valid code (valid: ${en.filter(Boolean).join(', ')}): P6 refuses the file.`, p6: 'P6 import fails on an invalid code value.' });
          continue;
        }
        if (ty === 'date') {
          if (parseP6Date(v) == null) c.add({ severity: 'error', code: 'BAD_DATE', table: t.name, row, field: f, key: key ? r[key] : undefined, message: `${t.name === 'TASK' && r.task_code ? `${r.task_code} ` : ''}${t.name}.${f} is "${v}", not a valid date: P6 refuses the file.`, p6: 'P6 import fails on unparseable dates.' });
          else if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) c.add({ severity: 'warning', code: 'DATE_FORMAT', table: t.name, row, field: f, message: `${t.name}.${f} = "${v}" is not in P6's yyyy-mm-dd hh:mm format.`, p6: 'P6 writes yyyy-mm-dd hh:mm; other forms may be misread.' });
        } else if (ty === 'number' && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) {
          c.add({ severity: 'error', code: 'BAD_NUMBER', table: t.name, row, field: f, key: key ? r[key] : undefined, message: `${t.name === 'TASK' && r.task_code ? `${r.task_code} ` : ''}${t.name}.${f} is "${v}", not a valid number: P6 refuses the file.`, p6: 'P6 import fails on non-numeric values.' });
        } else if (ty === 'flag' && v !== 'Y' && v !== 'N') {
          c.add({ severity: 'error', code: 'BAD_FLAG', table: t.name, row, field: f, key: key ? r[key] : undefined, message: `${t.name === 'TASK' && r.task_code ? `${r.task_code} ` : ''}${t.name}.${f} is "${v}", not a valid Y/N: P6 refuses the file.`, p6: 'P6 import fails on invalid flags.' });
        }
      }
    });

    // References
    for (const f of t.fields) {
      const target = refTarget(f, t.name);
      if (!target || !known.has(target)) continue;
      const tk = KEYS[target];
      const keys = new Set((T[target]?.rows ?? []).map((x) => x[tk]));
      const sev: Severity = REF_SEVERITY[`${t.name}.${f}`] ?? (f === 'clndr_id' ? 'warning' : T[target] ? 'warning' : 'info');
      t.rows.forEach((r, i) => {
        const v = r[f];
        if (!v || keys.has(v)) return;
        if (t.name === 'PROJWBS' && f === 'parent_wbs_id' && r.proj_node_flag === 'Y') return; // EPS parent, not exported
        if (t.name === 'CALENDAR' && f === 'proj_id') return;
        c.add({ severity: sev, code: 'DANGLING_REF', table: t.name, row: i + 1, field: f, key: key ? r[key] : undefined, message: dangling(t.name, r, f, v, target, !!T[target]), p6: REF_P6[sev] });
      });
    }
  }

  // a reference that points at nothing, in words (the rows are named by Activity ID where they can be)
  function dangling(table: string, r: Row, f: string, v: string, target: string, targetKept: boolean): string {
    const what = `${wordOf(target)}${targetKept ? '' : ' (the file has no such table)'}`;
    if (table === 'TASKPRED') {
      const other = f === 'pred_task_id' ? `the successor ${act(r.task_id)}` : `the predecessor ${act(r.pred_task_id)}`;
      if (f === 'pred_task_id' || f === 'task_id') return `A relationship of ${other} points at an activity that is not in the file. ${f === 'task_id' ? 'save {repair: true} removes it.' : 'It is kept as an external link; edit delete_relationship removes it once the activity is known.'}`;
    }
    const owner = table === 'TASK' ? `Activity ${actName(r)}` : `A ${wordOf(table)}${r[KEYS[table]] ? ` (id ${r[KEYS[table]]})` : ''}`;
    return `${owner} points at a ${what} that is not in the file (${f.replace(/_id$/, '').replace(/_/g, ' ')} id ${v}).${table === 'TASK' ? '' : ''}`;
  }

  // Project structure
  const projects = T.PROJECT?.rows ?? [];
  if (!projects.length) c.add({ severity: 'fatal', code: 'NO_PROJECT', message: 'No PROJECT rows.', p6: 'P6 finds no project to import.' });
  if (!T.TASK?.rows.length) c.add({ severity: 'warning', code: 'NO_TASK', message: 'The project has no activities.', p6: 'P6 imports an empty project.' });
  const wbs = T.PROJWBS?.rows ?? [];
  for (const p of projects) {
    const nodes = wbs.filter((w) => w.proj_id === p.proj_id && w.proj_node_flag === 'Y');
    if (!nodes.length) c.add({ severity: 'fatal', code: 'NO_PROJ_NODE', table: 'PROJWBS', key: p.proj_short_name || p.proj_id, message: `Project ${p.proj_short_name || p.proj_id} has no root WBS node: P6 refuses the file; save with repair: true adds it.`, p6: 'P6 import fails: every project needs its root WBS node.' });
    if (nodes.length > 1) c.add({ severity: 'error', code: 'MULTI_PROJ_NODE', table: 'PROJWBS', key: p.proj_short_name || p.proj_id, message: `Project ${p.proj_short_name || p.proj_id} has ${nodes.length} root WBS elements.`, p6: 'P6 import fails.' });
    if (!p.plan_start_date) c.add({ severity: 'error', code: 'NO_PLAN_START', table: 'PROJECT', key: p.proj_short_name || p.proj_id, field: 'plan_start_date', message: `Project ${p.proj_short_name || p.proj_id} has no planned start.`, p6: 'P6 requires a project planned start.' });
    if (!p.last_recalc_date) c.add({ severity: 'warning', code: 'NO_DATA_DATE', table: 'PROJECT', key: p.proj_short_name || p.proj_id, field: 'last_recalc_date', message: noDataDateUsed(p.proj_short_name || p.proj_id, p.plan_start_date ? p.plan_start_date.slice(0, 16) : null), p6: 'P6 uses the planned start as data date.' });
  }

  // WBS tree
  const wbsById = new Map(wbs.map((w) => [w.wbs_id, w]));
  for (const w of wbs) {
    const visited = new Set<string>();
    let cur: Row | undefined = w;
    while (cur && cur.proj_node_flag !== 'Y') {
      if (visited.has(cur.wbs_id)) { c.add({ severity: 'fatal', code: 'WBS_CYCLE', table: 'PROJWBS', key: w.wbs_id, message: `WBS ${w.wbs_short_name || w.wbs_id} is in a parent cycle: P6 refuses the file.`, p6: 'P6 import fails.' }); break; }
      visited.add(cur.wbs_id);
      const parent = wbsById.get(cur.parent_wbs_id);
      if (!parent) { c.add({ severity: 'warning', code: 'WBS_ORPHAN', table: 'PROJWBS', key: w.wbs_id, message: `WBS ${w.wbs_short_name || w.wbs_id} does not lead to the project root: P6 places it under the project.`, p6: 'P6 places it directly under the project.' }); break; }
      if (parent.proj_id !== w.proj_id) { c.add({ severity: 'error', code: 'WBS_CROSS_PROJECT', table: 'PROJWBS', key: w.wbs_id, message: `WBS ${w.wbs_short_name || w.wbs_id} has a parent in another project: P6 refuses the file.`, p6: 'P6 import fails.' }); break; }
      cur = parent;
    }
  }

  // Calendars
  // the activities each calendar carries (named in the sentence of a calendar with no work time)
  const calUsers = (clndrId: string) => { const ids = (T.TASK?.rows ?? []).filter((t) => t.clndr_id === clndrId).map((t) => t.task_code || t.task_id); return ids.length ? ` (${namesText(ids)})` : ''; };
  const noWeekColumn = !!T.CALENDAR?.rows.length && !T.CALENDAR.fields.includes('clndr_data');
  if (noWeekColumn) for (const [i, r] of T.CALENDAR.rows.entries()) c.add({ severity: 'warning', code: 'CAL_NO_DATA', table: 'CALENDAR', row: i + 1, key: r.clndr_id, message: defaultCalendarWeek(r.clndr_name), p6: '' });
  for (const [i, r] of (T.CALENDAR?.rows ?? []).entries()) {
    if (!T.CALENDAR.fields.includes('clndr_data')) break;
    if (!r.clndr_data) { c.add({ severity: 'warning', code: 'CAL_NO_DATA', table: 'CALENDAR', row: i + 1, key: r.clndr_id, message: defaultCalendarWeek(r.clndr_name), p6: 'P6 creates it with the default work week.' }); continue; }
    try {
      const cal = parseClndrData(r.clndr_data);
      const wh = hoursPerWeek(cal);
      if (wh === 0) c.add({ severity: 'warning', code: 'CAL_NO_WORK', table: 'CALENDAR', row: i + 1, key: r.clndr_id, message: `Calendar ${r.clndr_name} has no work time: activities on it${calUsers(r.clndr_id)} cannot be scheduled; give it work hours or move them to another calendar.`, p6: 'P6 imports it; activities on it cannot be scheduled.' });
    } catch (e) {
      c.add({ severity: 'error', code: 'CAL_PARSE', table: 'CALENDAR', row: i + 1, key: r.clndr_id, field: 'clndr_data', message: `Calendar ${r.clndr_name} cannot be read fully (${(e as Error).message}): only what could be read is used.`, p6: 'P6 import fails or the calendar is unusable.' });
    }
  }

  // Activities
  const projById = new Map(projects.map((p) => [p.proj_id, p]));
  const calHours = new Map((T.CALENDAR?.rows ?? []).map((c) => [c.clndr_id, c.day_hr_cnt]));
  const codes = new Map<string, string>();
  for (const [i, r] of (T.TASK?.rows ?? []).entries()) {
    const row = i + 1;
    const id = r.task_code || r.task_id;
    const ck = `${r.proj_id}|${r.task_code}`;
    if (r.task_code) {
      if (codes.has(ck) && !dupTaskRows.has(r)) c.add({ severity: 'error', code: 'DUP_TASK_CODE', table: 'TASK', row, key: r.task_id, field: 'task_code', message: `Activity ID ${r.task_code} is used by two activities in project ${projShort.get(r.proj_id) ?? r.proj_id}: P6 refuses the file; give one of them another Activity ID.`, p6: 'P6 requires unique Activity IDs within a project.' });
      codes.set(ck, r.task_id);
    } else if (T.TASK.fields.includes('task_code')) c.add({ severity: 'error', code: 'EMPTY_TASK_CODE', table: 'TASK', row, key: r.task_id, message: `An activity (${r.task_name ? String(r.task_name).slice(0, 40) : 'no name'}) has no Activity ID: P6 drops it on import.`, p6: 'P6 rejects activities without an ID.' });
    if (!r.clndr_id && T.TASK.fields.includes('clndr_id')) c.add({ severity: 'warning', code: 'NO_CALENDAR', table: 'TASK', row, key: id, message: `${actName(r)} has no calendar: the project default calendar is used.`, p6: 'P6 assigns the project default calendar.' });
    const isMile = r.task_type === 'TT_Mile' || r.task_type === 'TT_FinMile';
    if (isMile && Number(r.target_drtn_hr_cnt || 0) > 0) c.add({ severity: 'warning', code: 'MILESTONE_DURATION', table: 'TASK', row, key: id, message: `Milestone ${actName(r)} has a duration of ${hoursAsDays(Number(r.target_drtn_hr_cnt), Number(calHours.get(r.clndr_id)) || 8)}: P6 sets it to 0.`, p6: 'P6 sets milestone durations to zero.' });
    for (const f of ['target_drtn_hr_cnt', 'remain_drtn_hr_cnt']) if (Number(r[f]) < 0) c.add({ severity: 'error', code: 'NEG_DURATION', table: 'TASK', row, field: f, key: id, message: `${actName(r)} has a negative ${f === 'target_drtn_hr_cnt' ? 'Original' : 'Remaining'} Duration: P6 refuses it; set a duration of 0 or more.`, p6: 'P6 rejects negative durations.' });
    const as = parseP6Date(r.act_start_date), ae = parseP6Date(r.act_end_date);
    if (as != null && ae != null && ae < as) c.add({ severity: 'error', code: 'ACT_DATES_ORDER', table: 'TASK', row, key: id, message: `${actName(r)} has its actual finish before its actual start: P6 drops the actual dates.`, p6: 'P6 rejects the actual dates.' });
    if (r.status_code === 'TK_Complete' && (as == null || ae == null)) c.add({ severity: 'warning', code: 'STATUS_MISMATCH', table: 'TASK', row, key: id, message: `${actName(r)} is Completed but has no ${as == null ? 'actual start' : 'actual finish'}: P6 sets its status from the actual dates.`, p6: 'P6 fills missing actuals from early dates.' });
    if (r.status_code === 'TK_Active' && (as == null || ae != null)) c.add({ severity: 'warning', code: 'STATUS_MISMATCH', table: 'TASK', row, key: id, message: `${actName(r)} is In Progress but ${as == null ? 'has no actual start' : 'has an actual finish'}: P6 sets its status from the actual dates.`, p6: 'P6 derives status from actual dates.' });
    if (r.status_code === 'TK_NotStart' && (as != null || ae != null)) c.add({ severity: 'warning', code: 'STATUS_MISMATCH', table: 'TASK', row, key: id, message: `${actName(r)} is Not Started but has actual dates: P6 sets its status from the actual dates.`, p6: 'P6 derives status from actual dates.' });
    const dd = parseP6Date(projById.get(r.proj_id)?.last_recalc_date);
    if (dd != null && ((as != null && as > dd) || (ae != null && ae > dd))) c.add({ severity: 'warning', code: 'ACTUAL_AFTER_DD', table: 'TASK', row, key: id, message: actualAfterDataDate(actName(r), as != null && as > dd! && ae != null && ae > dd! ? 'start and finish' : as != null && as > dd! ? 'start' : 'finish', [as != null && as > dd! ? r.act_start_date.slice(0, 16) : '', ae != null && ae > dd! ? r.act_end_date.slice(0, 16) : ''].filter(Boolean).join(' and '), projById.get(r.proj_id)!.last_recalc_date.slice(0, 16)), p6: '' });
  }

  // Relationships
  const preds = T.TASKPRED?.rows ?? [];
  const links: [string, string][] = [];
  for (const [i, r] of preds.entries()) {
    const row = i + 1;
    if (r.task_id && r.task_id === r.pred_task_id) c.add({ severity: 'error', code: 'REL_SELF', table: 'TASKPRED', row, key: r.task_pred_id, message: `${act(r.task_id)} is linked to itself; P6 drops this relationship on import.`, p6: 'P6 rejects the relationship.' });
    const a1 = firstTask.get(r.pred_task_id), b1 = firstTask.get(r.task_id);
    if (a1 && b1 && inLoopCheck(a1.task_type) && inLoopCheck(b1.task_type)) links.push([r.pred_task_id, r.task_id]);
  }
  // loops follow the scheduler's rule (inLoopCheck): a chain through a level of effort or a WBS summary is not a loop, and does not stop scheduling
  for (const loop of loopsOfLinks(links)) {
    c.add({ severity: 'warning', code: 'REL_LOOP', table: 'TASKPRED', message: loopNote(loop.map((id) => act(id))), p6: 'P6 imports the file, but scheduling stops with a loop error.' });
  }

  return sortFindings(c.finish());
}

/** Strongly connected components with more than one node (Tarjan, iterative). */
export function findLoops(succ: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const start of succ.keys()) {
    if (idx.has(start)) continue;
    const work: [string, number][] = [[start, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      if (i === 0) { idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v); }
      const ns = succ.get(v) ?? [];
      if (i < ns.length) {
        top[1]++;
        const w = ns[i];
        if (!idx.has(w)) work.push([w, 0]);
        else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p)!, low.get(v)!)); }
      if (low.get(v) === idx.get(v)) {
        const comp: string[] = [];
        let w: string;
        do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1) out.push(comp.reverse());
      }
    }
  }
  return out;
}
