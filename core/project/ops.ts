// Edit a P6 database with a list of JSON operations, as one transaction: if any operation fails nothing changes
// and the error names the operation. Everything is addressed the way a scheduler sees it (project ID, activity
// ID, WBS code, resource ID, calendar name), never by internal database numbers. Durations are in days. An activity
// read from Microsoft Project can also be named "uid:<task UID>" (the UID it has in that file), a WBS element
// "wbs_id:<id>" (the id add_wbs returns). Days are converted on the activity's own calendar (its hours per day).
// Used by the command-line `edit` command and the MCP server.
import { addField, dropIndexes, nextId, rowIndex, rows, table, tableCache, withIdCache, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { p6num } from '../schedule/cpm.ts';
import { findLoops, MAX_LEN } from '../xer/validate.ts';
import { parseScheduleOptions, writeScheduleOptions, SCHEDULE_OPTIONS_GUIDE } from '../schedule/options.ts';
import { pick, realOf, record, removeWhere, rollback } from '../journal.ts';
import { parseClndrData, scheduledCalendarDef, serializeClndrData, standardCalendar, type Shift } from '../calendar/clndr-data.ts';
import { assignResource, assignmentActuals, fitAssignmentsToDuration, recalcAssignment, recomputeCosts } from '../resource/assign.ts';
import { copyProject } from './copy.ts';
import { dayHours as dayHoursOf } from './units.ts';
import { applyExtra, EXTRA_GUIDE, EXTRA_OP_NAMES } from './ops-extra.ts';
import { SELECT_GUIDE, SELECT_KEY, selectActivities, type SelectHelpers } from './select.ts';
import {
  addActivity, addRelationship, addWbs, LOOP_MESSAGE, onePerPair, relationshipsBetween, deleteActivities, dissolveActivities, ensureDefaultCalendar, ensureEps, namedAssignment, newProject, removeAssignments,
  enumOk, normDate, projectNumberProblem, refreshOwnDates, renumberProject, setActual, setFinish, setPercent, setStart, statusOf,
} from './edit.ts';

export type Op = Record<string, unknown> & { op: string };
export interface OpsResult { ok: boolean; applied: number; results: unknown[]; warnings?: string[]; error?: { index: number; op: unknown; message: string } }
/** calendarDays: days on each activity's own calendar (units.ts; MCP and CLI), else at hoursPerDay (the desktop app).
 *  allowLoops: relationships that close a loop are added (compute_schedule breaks or reports them), else the edit is
 *  refused at the one that closed it. */
export interface OpsOptions { hoursPerDay?: number; calendarDays?: boolean; allowLoops?: boolean }
interface Batch { calDays: boolean; at?: number; added: { pred: string; succ: string; at: number }[] }

/** WBS elements by id, root (per project), lower-case path and short name: positions in the real rows, kept for the
 *  edit (db.ts tableCache; a code or parent changed in place: dropIndexes). */
interface WbsIndex { byId: Map<string, number>; root: Map<string, number[]>; byPath: Map<string, number[]>; byShort: Map<string, number[]>; path: string[] }
function wbsIndex(raw: Row[]): WbsIndex {
  const push = (m: Map<string, number[]>, k: string, i: number) => { const l = m.get(k); if (l) l.push(i); else m.set(k, [i]); };
  const pathOf = (ix: WbsIndex, i: number): string | null => {
    const out: string[] = [];
    for (let x: Row | undefined = raw[i], n = 0; x && x.proj_node_flag !== 'Y' && n < ix.byId.size; n++) { out.unshift(x.wbs_short_name); const pi = ix.byId.get(x.parent_wbs_id); if (pi == null) { if (x.parent_wbs_id) return null; break; } x = raw[pi]; }
    return out.join('.').toLowerCase();
  };
  const add = (ix: WbsIndex, from: number, full: boolean) => {
    for (let i = from; i < raw.length; i++) ix.byId.set(raw[i].wbs_id, i);
    for (let i = from; i < raw.length; i++) {
      const w = raw[i];
      if (w.proj_node_flag === 'Y') { push(ix.root, w.proj_id, i); ix.path[i] = ''; continue; }
      const p = pathOf(ix, i);
      if (p == null && !full) return false; // its parent is not known yet: index everything again
      ix.path[i] = p ?? String(w.wbs_short_name).toLowerCase();
      push(ix.byPath, ix.path[i], i); push(ix.byShort, String(w.wbs_short_name).toLowerCase(), i);
    }
    return true;
  };
  return tableCache(raw, 'wbs', () => { const ix: WbsIndex = { byId: new Map(), root: new Map(), byPath: new Map(), byShort: new Map(), path: [] }; add(ix, 0, true); return ix; }, (ix, from) => add(ix, from, false));
}

/** The operation index of the first relationship added in this edit that closes a loop (none: null). Loops the file
 *  had already are not this edit's doing. */
function firstLoop(db: Db, added: Batch['added']): number | null {
  const P = realOf(rows(db, 'TASKPRED'));
  const mine = new Set(added.map((x) => `${x.pred}|${x.succ}`));
  const graph = (k: number) => {
    const ok = new Set(added.slice(0, k + 1).map((x) => `${x.pred}|${x.succ}`));
    const succ = new Map<string, string[]>();
    for (const r of P) { const key = `${r.pred_task_id}|${r.task_id}`; if (mine.has(key) && !ok.has(key)) continue; const l = succ.get(r.pred_task_id); if (l) l.push(r.task_id); else succ.set(r.pred_task_id, [r.task_id]); }
    return succ;
  };
  const closes = (k: number) => findLoops(graph(k)).some((c) => { const s = new Set(c); return added.slice(0, k + 1).some((x) => s.has(x.pred) && s.has(x.succ)); });
  if (!closes(added.length - 1)) return null;
  let lo = 0, hi = added.length - 1; // the first k whose relationships close a loop
  while (lo < hi) { const m = (lo + hi) >> 1; if (closes(m)) hi = m; else lo = m + 1; }
  return added[lo].at;
}

const TYPES: Record<string, string> = { task: 'TT_Task', task_dependent: 'TT_Task', resource_dependent: 'TT_Rsrc', start_milestone: 'TT_Mile', finish_milestone: 'TT_FinMile', milestone: 'TT_FinMile', level_of_effort: 'TT_LOE', loe: 'TT_LOE', wbs_summary: 'TT_WBS' };
const CSTR: Record<string, string> = { start_on: 'CS_MSO', start_on_or_after: 'CS_MSOA', start_on_or_before: 'CS_MSOB', finish_on: 'CS_MEO', finish_on_or_before: 'CS_MEOB', finish_on_or_after: 'CS_MEOA', mandatory_start: 'CS_MANDSTART', mandatory_finish: 'CS_MANDFIN', as_late_as_possible: 'CS_ALAP', alap: 'CS_ALAP', none: '' };
const REL: Record<string, string> = { FS: 'PR_FS', SS: 'PR_SS', FF: 'PR_FF', SF: 'PR_SF' };
const RTYPE: Record<string, string> = { labor: 'RT_Labor', nonlabor: 'RT_Equip', equipment: 'RT_Equip', material: 'RT_Mat' };
const PRIO: Record<string, string> = { top: 'PT_Top', high: 'PT_High', normal: 'PT_Normal', low: 'PT_Low', lowest: 'PT_Lowest' };
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** The ops in_baseline allows, and the fields they may carry then. */
const IN_BASELINE: Record<string, string[]> = {
  update_activity: ['op', 'in_baseline', 'project', 'id', 'new_id', 'name'],
  update_wbs: ['op', 'in_baseline', 'project', 'code', 'new_code', 'name'],
  set_notebook: ['op', 'in_baseline', 'project', 'activity', 'wbs', 'topic', 'text'],
  update_code_type: ['op', 'in_baseline', 'project', 'name', 'new_name', 'subject'],
  update_code_value: ['op', 'in_baseline', 'project', 'type', 'code', 'new_code', 'name', 'subject'],
};
export const OP_NAMES = ['add_project', 'copy_project', 'set_project', 'set_schedule_options', 'set_predecessors', 'add_calendar', 'add_holidays', 'add_wbs', 'delete_wbs', 'add_activity', 'update_activity', 'delete_activity', 'dissolve_activity', 'add_relationship', 'update_relationship', 'delete_relationship', 'add_resource', 'assign_resource', 'assign_role', 'unassign_resource', 'link_activities', 'renumber_activities', ...EXTRA_OP_NAMES];

/** The operations as an AI model needs to know them (fields, units, codes). Kept here, next to the code it describes. */
export const OP_GUIDE = [
  'Operations (JSON objects with "op"; [x] = optional; durations, remaining and lags in days of the activity\'s own calendar (lags: the relationship-lag calendar, by default the predecessor\'s), or *_hours; dates "2026-03-02" or "2026-03-02 08:00"; "project" may be left out when one project is meant; an activity read from a Microsoft Project file may be named "uid:<task UID>" instead of its ID; a WBS element may be named "wbs_id:<id>" (the id add_wbs returns) instead of its code):',
  `add_project: id, start, [name], [must_finish_by], [calendar]`,
  `copy_project: from (project ID to copy), id (new project ID), [name], [start] (moves every planned date by the same amount), [keep_progress] (default false: actuals and % complete cleared). Copies WBS, activities, logic, resource assignments, codes, UDFs and notebooks; the copy is then edited like any project`,
  `set_schedule_options: [project], then any of ${SCHEDULE_OPTIONS_GUIDE}. Written to the project (P6's Schedule Options), used by every later schedule`,
  `set_project: [project], [name], [data_date], [planned_start], [must_finish_by], [calendar], [financial_period_calendar] (the calendar of financial periods the project reports on; "" = the default), [eps] (EPS ID), [new_id] (a new Project ID, at most 40 characters; the root WBS node's code follows), [new_proj_id] (a new internal project number, the proj_id the XER carries: a positive whole number no other project has; every reference to the project follows)`,
  `add_calendar: name, [work_week {"mon":[["08:00","12:00"],["13:00","17:00"]], ... "sat":[]}] (default Mon-Fri 8h), [holidays [dates]], [work_exceptions {date: periods}]`,
  `add_holidays: calendar, dates [dates]`,
  `add_wbs: code, [name], [parent] (parent WBS code, dotted path or wbs_id:<id>; omit for top level), [project]. Returns wbs_id. P6 needs WBS codes unique under one parent, so a sibling with the same code is refused`,
  `delete_wbs: code, [keep_logic] (default true: every predecessor of the removed activities is linked on to their successors, so the chain stays closed; false = just delete), [project]. Removes the WBS element, its child elements and all their activities: the way to remove whole floors or areas, e.g. from a copied project`,
  `add_activity: name, [id], [wbs] (WBS code; omit = project root), [type] (${Object.keys(TYPES).join(', ')}), [duration_days], [calendar], [priority] (${Object.keys(PRIO).join(', ')}), [constraint {type, date}] (types: ${Object.keys(CSTR).filter((k) => k !== 'none').join(', ')}), [secondary_constraint], [project]`,
  `update_activity: id, then any add_activity field, plus [new_id], [remaining_days] or [remaining_hours], [assignments_follow] (true: assignments take the new remaining duration, the same remaining units over fewer hours; crash_schedule sets it), [percent_complete], [actual_start], [actual_finish], [expected_finish], [start], [finish], [primary_resource] (a resource assigned to it; "" clears the primary resource)`,
  `delete_activity / dissolve_activity: id`,
  `add_relationship: pred, succ, [type] (FS default, SS, FF, SF), [lag_days] (negative = lead). P6 keeps one relationship per pair and type (an SS and an FF between the same two activities are both kept; a Microsoft Project XML / MPX file one per pair): one already there is skipped and reported in "warnings". A relationship that closes a loop refuses the edit`,
  `update_relationship: pred, succ, [type], [new_type], [lag_days]; delete_relationship: pred, succ, [type]`,
  `set_predecessors: activity, links [{pred, [type], [lag_days] or [lag_hours]}] ([] = none): replaces every predecessor of the activity in one step`,
  `add_resource: id, [name], [type] (labor, nonlabor, material), [units_per_day], [max_units_per_day] or [max_units_per_hour], [price_per_unit], [calendar], [parent]`,
  `assign_resource: activity, resource, [allow_duplicate] (true: assign it again when it is already on the activity, as P6 allows), [units_per_day] or [units], [actual_units], [budgeted_cost], [actual_cost], [remaining_cost] (a cost given is kept as entered: the assignment's cost no longer follows units x price, as in P6), [curve] (resource curve name, see add_resource_curve); unassign_resource: activity, resource or assigned_role (a role assignment with no resource), [nth] (the same resource on the activity more than once: 1 = first); its UDF values, period actuals and assignment codes go with it`,
  `assign_role: activity, role (Role ID), [units] or [units_per_day]: P6's Assign Roles, a role assignment with no resource yet, priced by the role's rate`,
  SELECT_GUIDE,
  EXTRA_GUIDE,
].join('\n');

class OpError extends Error {}
const fail = (m: string): never => { throw new OpError(m); };
const str = (v: unknown, what: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fail(`"${what}" is required (text).`));
const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fail(`"${what}" must be a number.`));
const date = (v: unknown, what: string): string => { const d = typeof v === 'string' ? normDate(v) : null; return d ? d : fail(`"${what}" must be a date like 2026-03-02 or 2026-03-02 08:00.`); };
const ok = (msg: string | void) => { if (msg) fail(msg); };

/** Apply operations to db (one transaction). */
export function applyOps(db: Db, ops: unknown, o: OpsOptions = {}): OpsResult {
  const list = Array.isArray(ops) ? ops : ops && typeof ops === 'object' && Array.isArray((ops as { operations?: unknown }).operations) ? (ops as { operations: unknown[] }).operations : null;
  if (!list) return { ok: false, applied: 0, results: [], error: { index: -1, op: ops, message: 'Expected a JSON array of operations (or {"operations": [...]}).' } };
  const hpd = o.hoursPerDay ?? 8;
  const results: unknown[] = [], warnings: string[] = [];
  let at = -1;
  const batch: Batch = { calDays: !!o.calendarDays, added: [] };
  try {
    withIdCache(() => record(db, (d) => {
      for (at = 0; at < list.length; at++) { batch.at = at; results.push(apply(d, list[at] as Op, hpd, warnings, batch)); }
      // loops: checked once for the whole edit (a check per relationship made a 30,000-link load quadratic); the
      // error names the first relationship of the list that closed one
      if (batch.added.length && !o.allowLoops) { const k = firstLoop(d, batch.added); if (k != null) { at = k; fail(LOOP_MESSAGE); } }
    }));
    return { ok: true, applied: list.length, results, ...(warnings.length ? { warnings } : {}) };
  } catch (e) {
    // record() has already put the database back as it was
    return { ok: false, applied: 0, results: [], error: { index: at, op: list[at], message: e instanceof OpError ? e.message : `Internal error: ${(e as Error).message}` } };
  }
}

function apply(db: Db, op: Op, hpd: number, warnings: string[], batch: Batch): unknown {
  const calDays = batch.calDays;
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') fail('Each operation needs an "op" name.');
  // in_baseline: the op works on a baseline named by "project" (renaming its activities, WBS and notebooks the way the
  // live project's are, for an anonymised copy that keeps its baselines); only those ops, only those fields
  const inBaseline = op.in_baseline === true;
  if (inBaseline) {
    const allowed = IN_BASELINE[op.op] ?? fail(`in_baseline works with ${Object.keys(IN_BASELINE).join(', ')} only.`);
    const extra = Object.keys(op).filter((k) => !allowed.includes(k));
    if (extra.length) fail(`${op.op} with in_baseline renames only (${allowed.filter((k) => !['op', 'in_baseline'].includes(k)).join(', ')}); not ${extra.join(', ')}.`);
    if (op.project == null || op.project === '') fail('in_baseline needs "project": the name of the baseline.');
    if (!rows(db, 'PROJECT').some((p) => p._baseline_of && p.proj_short_name.toLowerCase() === String(op.project).toLowerCase())) fail(`No baseline "${op.project}".`);
  }
  const projects = () => rows(db, 'PROJECT').filter((p) => (inBaseline ? !!p._baseline_of : !p._baseline_of));
  const project = (id?: unknown): Row => {
    if (id != null) return projects().find((p) => p.proj_short_name.toLowerCase() === String(id).toLowerCase()) ?? fail(`No project "${id}".`);
    const ps = projects();
    return ps.length === 1 ? ps[0] : fail(ps.length ? `Several projects are in the file; say which with "project": ${ps.map((p) => p.proj_short_name).join(', ')}.` : 'The file has no project yet; add one with {"op":"add_project"}.');
  };
  /** The activities with this Activity ID (any project), by an index kept for the edit (db.ts rowIndex). */
  const byCode = (code: string): Row[] => { const T = rows(db, 'TASK'), raw = realOf(T); return (rowIndex(raw, 'code', (t) => t.task_code).get(code) ?? []).filter((i) => raw[i].task_code === code).map((i) => (raw === T ? raw[i] : T[i])); };
  const activity = (id: unknown, proj?: unknown): Row => {
    const code = str(id, 'id');
    const pids = new Set(proj != null ? [project(proj).proj_id] : projects().map((p) => p.proj_id));
    let hits = byCode(code).filter((t) => pids.has(t.proj_id)).slice(0, 2);
    // an activity a select picked, named by its internal id (its Activity ID may be in several projects)
    const tid = !hits.length ? /^task_id:(.+)$/.exec(code)?.[1] : undefined;
    if (tid) return pick(rows(db, 'TASK'), (t) => t.task_id === tid && pids.has(t.proj_id), 1)[0] ?? fail(`No activity with task_id ${tid}${proj != null ? ` in ${proj}` : ''}.`);
    const uid = !hits.length ? /^uid:\s*(.+)$/i.exec(code)?.[1] : undefined;
    if (uid) hits = pick(rows(db, 'TASK'), (t) => t._msp_uid === uid && pids.has(t.proj_id), 2);
    if (hits.length > 1) fail(`${uid ? `Task UID ${uid}` : `Activity ID "${code}"`} exists in several projects; add "project".`);
    return hits[0] ?? fail(uid ? `No activity with Microsoft Project task UID ${uid} (only activities read from an MSPDI or MPX file have one).` : `No activity "${code}".`);
  };
  const wbsIdOf = (v: unknown) => /^wbs_id:\s*(.+)$/i.exec(typeof v === 'string' ? v.trim() : '')?.[1];
  /** The project of op.project, or of the WBS element a "wbs_id:" reference names (so "project" can be left out). */
  const projectFor = (id: unknown, wbsRef: unknown): Row => {
    const wid = id == null ? wbsIdOf(wbsRef) : undefined;
    const w = wid ? rows(db, 'PROJWBS').find((x) => x.wbs_id === wid && projects().some((p) => p.proj_id === x.proj_id)) : undefined;
    return w ? projects().find((p) => p.proj_id === w.proj_id)! : project(id);
  };
  const wbsOf = (p: Row, code: unknown): Row => {
    const pid = p.proj_id;
    const view = rows(db, 'PROJWBS'), raw = realOf(view), ix = wbsIndex(raw);
    const at = (i: number) => (raw === view ? raw[i] : view[i]);
    const mine = (l: number[] | undefined) => (l ?? []).filter((i) => raw[i].proj_id === pid);
    if (code == null || code === '') { const r = mine(ix.root.get(pid))[0]; return r != null ? at(r) : fail(`Project ${p.proj_short_name} has no WBS root.`); }
    const wid = wbsIdOf(code);
    if (wid) { const r = mine(ix.byId.has(wid) ? [ix.byId.get(wid)!] : [])[0]; return r != null ? at(r) : fail(`No WBS element with wbs_id ${wid} in project ${p.proj_short_name}.`); }
    const c = String(code).toLowerCase();
    // A full path names one element; only a bare short name can be ambiguous ("1" is both the top element 1 and the
    // child 1.1's short name — the normal P6 shape, so the path must win).
    const byPath = mine(ix.byPath.get(c));
    if (byPath.length === 1) return at(byPath[0]);
    const hits = [...new Set([...byPath, ...mine(ix.byShort.get(c))])];
    if (hits.length > 1) fail(`WBS code "${code}" is ambiguous; use the full path (e.g. ${ix.path[hits[0]]}).`);
    return hits.length ? at(hits[0]) : fail(`No WBS "${code}" in project ${p.proj_short_name}.`);
  };
  // days -> hours by units.ts (the activity's calendar with calendarDays, else hpd): the same rule the lookups and
  // reports give days back with; read afresh, a calendar may change mid-list
  const dayHours = (t: Row) => dayHoursOf(db, hpd, calDays).task(t);
  /** Lag days on the relationship-lag calendar of the successor's project (P6 default: the predecessor's calendar). */
  const lagHours = (pred: Row, succ: Row) => dayHoursOf(db, hpd, calDays).lag(pred, succ);

  const resource = (id: unknown): Row => rows(db, 'RSRC').find((r) => r.rsrc_short_name.toLowerCase() === String(id).toLowerCase()) ?? fail(`No resource "${id}" (add it with {"op":"add_resource"}).`);
  const role = (id: unknown): Row => rows(db, 'ROLES').find((r) => r.role_short_name.toLowerCase() === String(id).toLowerCase()) ?? fail(`No role "${id}" (add it with {"op":"add_role"}).`);
  const sel: SelectHelpers = { fail, project, projects, wbsOf, resource };
  const projectId = (t: Row) => projects().find((p) => p.proj_id === t.proj_id)!.proj_short_name;
  /** The activities op.select picks; the op's own "project" limits them when the select names none. */
  const selected = (dflt = 'id') => selectActivities(db, op.select && typeof op.select === 'object' && op.project != null && (op.select as Row).project == null ? { ...(op.select as object), project: op.project } : op.select, sel, dflt);

  // select: the operation done on every activity a filter picks (P6's select-all then Global Change / Assign / Delete)
  if (op.select !== undefined && op.op !== 'link_activities' && op.op !== 'renumber_activities') {
    const key = SELECT_KEY[op.op] ?? fail(`select works with ${Object.keys(SELECT_KEY).join(', ')}, link_activities and renumber_activities.`);
    if (op[key] != null) fail(`Give ${key} or select, not both.`);
    const picked = selected();
    if (!picked.length) { warnings.push(`${op.op}: select picked no activity; nothing changed.`); return { selected: 0 }; }
    // deleting or dissolving them: once for them all (one pass over the tables, not one per activity)
    if (op.op === 'delete_activity') { deleteActivities(db, picked.map((t) => t.task_id)); return { selected: picked.length, deleted: picked.length }; }
    if (op.op === 'dissolve_activity') return { selected: picked.length, dissolved: picked.length, relationships_added: dissolveActivities(db, picked.map((t) => t.task_id)) };
    // each picked activity by its internal id: "project" stays what the op said (set_predecessors resolves its links by it)
    const { select: _s, ...one } = op;
    const done = picked.map((t) => apply(db, { ...one, [key]: `task_id:${t.task_id}` } as Op, hpd, warnings, batch));
    return { selected: picked.length, results: done.slice(0, 10), ...(done.length > 10 ? { more: done.length - 10 } : {}) };
  }

  const calendar = (name: unknown): Row => rows(db, 'CALENDAR').find((c) => c.clndr_name.toLowerCase() === String(name).toLowerCase()) ?? fail(`No calendar "${name}".`);
  const curveId = (name: unknown): string => rows(db, 'RSRCCURVDATA').find((c) => c.curv_name.toLowerCase() === String(name).toLowerCase())?.curv_id ?? fail(`No resource curve "${name}". Curves: ${rows(db, 'RSRCCURVDATA').map((c) => c.curv_name).join(', ') || 'none in this file'} (add one with {"op":"add_resource_curve"}).`);
  const cstr =(v: unknown): [string, string] => {
    if (v == null || v === 'none' || v === '') return ['', ''];
    const c = v as { type?: unknown; date?: unknown };
    const t = typeof c === 'object' ? String(c.type ?? '') : String(v);
    const code = CSTR[t.toLowerCase()] ?? (/^CS_/.test(t) && enumOk('TASK', 'cstr_type', t) ? t : fail(`Unknown constraint "${t}". Use one of: ${Object.keys(CSTR).join(', ')}.`));
    return [code, code === 'CS_ALAP' || !code ? '' : date(c.date, 'constraint.date')];
  };

  switch (op.op) {
    case 'add_project': {
      const id = str(op.id, 'id');
      if (projects().some((p) => p.proj_short_name.toLowerCase() === id.toLowerCase())) fail(`Project "${id}" already exists.`);
      const pid = newProject(db, { id, name: typeof op.name === 'string' ? op.name : id, start: date(op.start, 'start') });
      if (op.must_finish_by) rows(db, 'PROJECT').find((p) => p.proj_id === pid)!.plan_end_date = date(op.must_finish_by, 'must_finish_by');
      if (op.calendar) rows(db, 'PROJECT').find((p) => p.proj_id === pid)!.clndr_id = calendar(op.calendar).clndr_id;
      return { project: id };
    }
    case 'set_schedule_options': {
      const p = project(op.project);
      const set = writeScheduleOptions(db, p, parseScheduleOptions(op, fail, hpd));
      if (!set.length) fail(`Give at least one schedule option: ${SCHEDULE_OPTIONS_GUIDE}.`);
      return { project: p.proj_short_name, set };
    }
    case 'copy_project': {
      const from = project(str(op.from, 'from'));
      const id = str(op.id, 'id');
      if (projects().some((p) => p.proj_short_name.toLowerCase() === id.toLowerCase())) fail(`Project "${id}" already exists.`);
      copyProject(db, from.proj_id, { id, name: typeof op.name === 'string' ? op.name : undefined, start: op.start != null ? date(op.start, 'start') : undefined, keepProgress: op.keep_progress === true });
      return { project: id, copied_from: from.proj_short_name, activities: rows(db, 'TASK').filter((t) => t.proj_id === projects().find((p) => p.proj_short_name === id)?.proj_id).length };
    }
    case 'set_project': {
      const p = project(op.project);
      if (op.name != null) { const root = wbsOf(p, null); root.wbs_name = str(op.name, 'name'); }
      if (op.data_date != null) p.last_recalc_date = date(op.data_date, 'data_date');
      if (op.planned_start != null) p.plan_start_date = date(op.planned_start, 'planned_start');
      if (op.must_finish_by !== undefined) p.plan_end_date = op.must_finish_by ? date(op.must_finish_by, 'must_finish_by') : '';
      if (op.calendar != null) p.clndr_id = calendar(op.calendar).clndr_id;
      if (op.financial_period_calendar !== undefined) {
        addField(table(db, 'PROJECT'), 'fintmpl_id');
        p.fintmpl_id = op.financial_period_calendar ? rows(db, 'FINTMPL').find((c) => c.fintmpl_name.toLowerCase() === String(op.financial_period_calendar).toLowerCase())?.fintmpl_id ?? fail(`No financial period calendar "${op.financial_period_calendar}" (add it with {"op":"add_financial_period_calendar"}).`) : '';
      }
      if (op.eps != null) { ensureEps(db); addField(table(db, 'PROJECT'), '_eps_id'); p._eps_id = rows(db, 'EPS').find((e) => e.eps_short_name.toLowerCase() === String(op.eps).toLowerCase())?.eps_id ?? fail(`No EPS "${op.eps}" (add it with {"op":"add_eps"}).`); }
      if (op.new_id != null) {
        const id = str(op.new_id, 'new_id'), was = p.proj_short_name;
        if (id.length > MAX_LEN['PROJECT.proj_short_name']) fail(`Project ID "${id}" is ${id.length} characters; P6 holds ${MAX_LEN['PROJECT.proj_short_name']}.`);
        if (rows(db, 'PROJECT').some((x) => x.proj_id !== p.proj_id && x.proj_short_name.toLowerCase() === id.toLowerCase())) fail(`A project or baseline "${id}" already exists.`);
        p.proj_short_name = id;
        const root = wbsOf(p, null); // P6 keeps the project's ID on its root WBS node too
        if (root.wbs_short_name.toLowerCase() === was.toLowerCase()) root.wbs_short_name = id;
        if (p._name === was) p._name = id;
      }
      if (op.new_proj_id != null) {
        const n = String(op.new_proj_id).trim();
        ok(projectNumberProblem(db, p.proj_id, n));
        if (n !== p.proj_id) renumberProject(db, p.proj_id, n);
      }
      return { project: p.proj_short_name, ...(op.new_proj_id != null ? { proj_id: p.proj_id } : {}) };
    }
    case 'add_calendar': {
      const name = str(op.name, 'name');
      if (rows(db, 'CALENDAR').some((c) => c.clndr_name.toLowerCase() === name.toLowerCase())) fail(`Calendar "${name}" already exists.`);
      ensureDefaultCalendar(db);
      const def = standardCalendar();
      if (op.work_week != null) {
        if (typeof op.work_week !== 'object') fail('"work_week" must map days (sun..sat) to lists of ["08:00","17:00"] periods.');
        def.week = DAYS.map(() => []);
        for (const [k, v] of Object.entries(op.work_week as Record<string, unknown>)) {
          const i = DAYS.indexOf(k.slice(0, 3).toLowerCase());
          if (i < 0) fail(`Unknown day "${k}" in work_week.`);
          def.week[i] = periods(v);
        }
      }
      for (const h of (Array.isArray(op.holidays) ? op.holidays : [])) def.exceptions.set(ole(date(h, 'holidays[]')), []);
      for (const [k, v] of Object.entries((op.work_exceptions ?? {}) as Record<string, unknown>)) def.exceptions.set(ole(date(k, 'work_exceptions key')), periods(v));
      const C = table(db, 'CALENDAR');
      const weekH = def.week.flat().reduce((a, s) => a + s.end - s.start, 0) / 60;
      const dayH = Math.round((weekH / Math.max(1, def.week.filter((d) => d.length).length)) * 100) / 100;
      C.rows.push({ clndr_id: String(nextId(db, 'CALENDAR')), default_flag: 'N', clndr_name: name, proj_id: '', base_clndr_id: '', last_chng_date: formatP6Date(Date.now() / 60000), clndr_type: 'CA_Base', day_hr_cnt: p6num(dayH), week_hr_cnt: p6num(weekH), month_hr_cnt: p6num(weekH * 4.3), year_hr_cnt: p6num(weekH * 52), rsrc_private: 'N', clndr_data: serializeClndrData(def) });
      return { calendar: name, hours_per_week: weekH };
    }
    case 'add_holidays': {
      const c = calendar(op.calendar);
      const def = scheduledCalendarDef(c); // no calendar data: the week F9 gives it, now written out in full
      for (const h of (Array.isArray(op.dates) ? op.dates : fail('"dates" must be a list of dates.'))) def.exceptions.set(ole(date(h, 'dates[]')), []);
      c.clndr_data = serializeClndrData(def);
      return { calendar: c.clndr_name };
    }
    case 'add_wbs': {
      const p = projectFor(op.project, op.parent);
      const parent = wbsOf(p, op.parent);
      const code = str(op.code, 'code');
      const WR = realOf(rows(db, 'PROJWBS')), pw = parent.wbs_id;
      if ((rowIndex(WR, 'parent', (w) => w.parent_wbs_id).get(pw) ?? []).some((i) => WR[i].proj_id === p.proj_id && WR[i].parent_wbs_id === pw && WR[i].wbs_short_name.toLowerCase() === code.toLowerCase())) fail(`WBS "${code}" already exists there.`);
      const w = addWbs(db, p.proj_id, parent.wbs_id, code, typeof op.name === 'string' ? op.name : code);
      return { wbs: code, wbs_id: w.wbs_id };
    }
    case 'delete_wbs': {
      const p = projectFor(op.project, op.code);
      const w = wbsOf(p, str(op.code, 'code'));
      const sub = new Set([w.wbs_id]);
      for (let grew = true; grew;) { grew = false; for (const x of rows(db, 'PROJWBS')) if (sub.has(x.parent_wbs_id) && !sub.has(x.wbs_id)) { sub.add(x.wbs_id); grew = true; } }
      const ids = rows(db, 'TASK').filter((t) => sub.has(t.wbs_id)).map((t) => t.task_id);
      const linked = op.keep_logic === false ? (deleteActivities(db, ids), 0) : dissolveActivities(db, ids);
      removeWhere(rows(db, 'PROJWBS'), (x) => sub.has(x.wbs_id));
      return { deleted_wbs: w.wbs_short_name, wbs_elements: sub.size, activities: ids.length, relationships_added: linked };
    }
    case 'add_activity': {
      const p = projectFor(op.project, op.wbs);
      const w = wbsOf(p, op.wbs);
      const code = op.id != null ? str(op.id, 'id') : undefined, pid = p.proj_id;
      if (code != null && byCode(code).some((x) => x.proj_id === pid)) fail(`Activity ID "${code}" already exists in ${p.proj_short_name}.`);
      const t = addActivity(db, p.proj_id, w.wbs_id, hpd, code);
      t.task_name = str(op.name, 'name');
      updateActivity(db, t, op, dayHours, calendar, cstr);
      if (op.duration_days == null && op.duration_hours == null && (t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile')) { t.target_drtn_hr_cnt = t.remain_drtn_hr_cnt = '0'; refreshOwnDates(db, t); }
      return { activity: t.task_code };
    }
    case 'update_activity': {
      const t = activity(op.id, op.project);
      if (op.new_id != null) {
        const code = str(op.new_id, 'new_id');
        if (byCode(code).some((x) => x.task_id !== t.task_id && x.proj_id === t.proj_id)) fail(`Activity ID "${code}" already exists.`);
        t.task_code = code;
        dropIndexes(realOf(rows(db, 'TASK'))); // the index by Activity ID no longer holds
      }
      if (op.wbs != null) t.wbs_id = wbsOf(project(projects().find((p) => p.proj_id === t.proj_id)!.proj_short_name), op.wbs).wbs_id;
      updateActivity(db, t, op, dayHours, calendar, cstr);
      if (op.primary_resource !== undefined) {
        addField(table(db, 'TASK'), 'rsrc_id');
        if (op.primary_resource == null || op.primary_resource === '') t.rsrc_id = '';
        else {
          const r = resource(op.primary_resource), tid = t.task_id, rid = r.rsrc_id;
          if (!realOf(rows(db, 'TASKRSRC')).some((a) => a.task_id === tid && a.rsrc_id === rid)) fail(`${r.rsrc_short_name} is not assigned to ${t.task_code}; P6's primary resource is one of the activity's resources (assign_resource first).`);
          t.rsrc_id = rid;
        }
      }
      return { activity: t.task_code };
    }
    case 'delete_activity': { const t = activity(op.id, op.project); deleteActivities(db, [t.task_id]); return { deleted: t.task_code }; }
    case 'dissolve_activity': { const t = activity(op.id, op.project); const n = dissolveActivities(db, [t.task_id]); return { dissolved: t.task_code, relationships_added: n }; }
    case 'add_relationship': {
      const a = activity(op.pred, op.pred_project ?? op.project), b = activity(op.succ, op.succ_project ?? op.project);
      const type = REL[String(op.type ?? 'FS').toUpperCase()] ?? fail(`Relationship type must be FS, SS, FF or SF.`);
      // P6 keeps one relationship per pair and type (an SS and an FF between the same two activities are both kept);
      // Microsoft Project one per pair. A relationship already there is skipped, not a failure of the whole list
      const have = relationshipsBetween(db, a.task_id, b.task_id);
      const dup = have.find((r) => r.pred_type === type) ?? (onePerPair(db, projects().find((p) => p.proj_id === b.proj_id)) ? have[0] : undefined);
      if (dup) {
        warnings.push(dup.pred_type === type ? `Relationship ${a.task_code} -> ${b.task_code} (${type.slice(3)}) skipped: it already exists.`
          : `Relationship ${a.task_code} -> ${b.task_code} (${type.slice(3)}) skipped: ${a.task_code} -> ${b.task_code} already has a ${dup.pred_type.slice(3)} relationship, and Microsoft Project keeps one per pair of activities.`);
        return { skipped: `${a.task_code} ${type.slice(3)} ${b.task_code}`, existing: `${a.task_code} ${dup.pred_type.slice(3)} ${b.task_code}` };
      }
      ok(addRelationship(db, a.task_id, b.task_id, type, op.lag_days != null ? num(op.lag_days, 'lag_days') * lagHours(a, b) : op.lag_hours != null ? num(op.lag_hours, 'lag_hours') : 0, true));
      batch.added.push({ pred: a.task_id, succ: b.task_id, at: batch.at ?? -1 });
      return { relationship: `${a.task_code} ${type.slice(3)} ${b.task_code}` };
    }
    case 'set_predecessors': {
      // the activity's predecessors replaced by the list, as one step (loops are checked with the rest of the edit)
      const b = activity(op.activity, op.project);
      const links = Array.isArray(op.links) ? op.links : fail('"links" must be a list of {pred, type, lag_days} ([] removes every predecessor).');
      const sb = b.task_id, P = table(db, 'TASKPRED');
      const gone = removeWhere(P.rows, (r) => r.task_id === sb);
      const out: string[] = [];
      links.forEach((l: any, i: number) => {
        if (!l || typeof l !== 'object') fail(`links[${i}] must be {pred, type, lag_days}.`);
        const a = activity(l.pred ?? l.id, l.pred_project ?? op.project);
        const type = REL[String(l.type ?? 'FS').toUpperCase()] ?? fail(`links[${i}]: relationship type must be FS, SS, FF or SF.`);
        const have = relationshipsBetween(db, a.task_id, sb);
        if (have.some((r) => r.pred_type === type) || (have.length && onePerPair(db, projects().find((p) => p.proj_id === b.proj_id)))) fail(`links[${i}]: ${a.task_code} -> ${b.task_code} is listed twice${have.some((r) => r.pred_type === type) ? '' : ' (Microsoft Project keeps one relationship per pair)'}.`);
        ok(addRelationship(db, a.task_id, sb, type, l.lag_days != null ? num(l.lag_days, `links[${i}].lag_days`) * lagHours(a, b) : l.lag_hours != null ? num(l.lag_hours, `links[${i}].lag_hours`) : 0, true));
        batch.added.push({ pred: a.task_id, succ: sb, at: batch.at ?? -1 });
        out.push(`${a.task_code} ${type.slice(3)}`);
      });
      return { activity: b.task_code, predecessors: out, removed: gone };
    }
    case 'update_relationship': case 'delete_relationship': {
      const a = activity(op.pred, op.pred_project ?? op.project), b = activity(op.succ, op.succ_project ?? op.project);
      const P = table(db, 'TASKPRED');
      const want = op.type ? REL[String(op.type).toUpperCase()] : null;
      const pa = a.task_id, sb = b.task_id;
      const hits = pick(P.rows, (r) => r.pred_task_id === pa && r.task_id === sb && (!want || r.pred_type === want));
      if (!hits.length) fail(`No relationship ${a.task_code} -> ${b.task_code}${want ? ` (${want.slice(3)})` : ''}.`);
      if (hits.length > 1) fail(`Several relationships ${a.task_code} -> ${b.task_code}; give "type".`);
      if (op.op === 'delete_relationship') { const gone = realOf(hits[0]); removeWhere(P.rows, (r) => r === gone); return { deleted: `${a.task_code} -> ${b.task_code}` }; }
      if (op.new_type) {
        const nt = REL[String(op.new_type).toUpperCase()] ?? fail('new_type must be FS, SS, FF or SF.');
        if (P.rows.some((r) => r !== hits[0] && r.pred_task_id === a.task_id && r.task_id === b.task_id && r.pred_type === nt)) fail(`${a.task_code} -> ${b.task_code} already has a ${nt.slice(3)} relationship.`);
        hits[0].pred_type = nt;
      }
      if (op.lag_days != null) hits[0].lag_hr_cnt = p6num(num(op.lag_days, 'lag_days') * lagHours(a, b));
      if (op.lag_hours != null) hits[0].lag_hr_cnt = p6num(num(op.lag_hours, 'lag_hours'));
      return { relationship: `${a.task_code} ${hits[0].pred_type.slice(3)} ${b.task_code}` };
    }
    case 'add_resource': {
      const id = str(op.id, 'id');
      if (rows(db, 'RSRC').some((r) => r.rsrc_short_name.toLowerCase() === id.toLowerCase())) fail(`Resource "${id}" already exists.`);
      const cal = op.calendar ? calendar(op.calendar) : ensureDefaultCalendar(db);
      const R = table(db, 'RSRC');
      for (const f of ['rsrc_id', 'parent_rsrc_id', 'clndr_id', 'rsrc_seq_num', 'rsrc_name', 'rsrc_short_name', 'def_qty_per_hr', 'cost_qty_type', 'ot_factor', 'active_flag', 'rsrc_type', 'unit_id', 'curr_id']) addField(R, f);
      const rid = String(nextId(db, 'RSRC'));
      const type = RTYPE[String(op.type ?? 'labor').toLowerCase()] ?? fail('Resource type must be labor, nonlabor or material.');
      const perHr = op.units_per_day != null ? num(op.units_per_day, 'units_per_day') / hpd : 1;
      R.rows.push({ rsrc_id: rid, parent_rsrc_id: op.parent ? resource(op.parent).rsrc_id : '', clndr_id: cal.clndr_id, rsrc_seq_num: String(R.rows.length + 1), rsrc_name: typeof op.name === 'string' ? op.name : id, rsrc_short_name: id, def_qty_per_hr: p6num(perHr), cost_qty_type: 'QT_Hour', ot_factor: '1', active_flag: 'Y', rsrc_type: type, unit_id: '', curr_id: rows(db, 'CURRTYPE')[0]?.curr_id ?? '' });
      const RR = table(db, 'RSRCRATE');
      for (const f of ['rsrc_rate_id', 'rsrc_id', 'max_qty_per_hr', 'cost_per_qty', 'start_date']) addField(RR, f);
      RR.rows.push({ rsrc_rate_id: String(nextId(db, 'RSRCRATE')), rsrc_id: rid, max_qty_per_hr: p6num(op.max_units_per_hour != null ? num(op.max_units_per_hour, 'max_units_per_hour') : op.max_units_per_day != null ? num(op.max_units_per_day, 'max_units_per_day') / hpd : perHr), cost_per_qty: p6num(op.price_per_unit != null ? num(op.price_per_unit, 'price_per_unit') : 0), start_date: '' });
      return { resource: id };
    }
    case 'assign_resource': {
      const t = activity(op.activity, op.project), r = resource(op.resource);
      const tid = t.task_id, rid = r.rsrc_id;
      // P6 allows the same resource twice on an activity (two assignments, e.g. different roles or curves): allow_duplicate
      const TR = realOf(rows(db, 'TASKRSRC'));
      if (op.allow_duplicate !== true && (rowIndex(TR, 'task', (x) => x.task_id).get(tid) ?? []).some((i) => TR[i].task_id === tid && TR[i].rsrc_id === rid)) fail(`${r.rsrc_short_name} is already assigned to ${t.task_code} (allow_duplicate: true adds a second assignment).`);
      const a = assignResource(db, t, r.rsrc_id);
      if (op.units_per_day != null) recalcAssignment(db, t, a, 'target_qty_per_hr', num(op.units_per_day, 'units_per_day') / hpd);
      if (op.units != null) { recalcAssignment(db, t, a, 'target_qty', num(op.units, 'units')); a.remain_qty = a.target_qty; recomputeCosts(db, a); }
      if (op.curve != null && op.curve !== '') { addField(table(db, 'TASKRSRC'), 'curv_id'); a.curv_id = curveId(op.curve); }
      assignmentActuals(db, a, op, num);
      return { assigned: `${r.rsrc_short_name} -> ${t.task_code}`, budgeted_units: Number(a.target_qty) };
    }
    case 'link_activities': {
      // P6's Link Activities: each selected activity to the next, in the layout's order (here order_by, default start)
      if (op.select == null) fail('link_activities needs select: the activities to link, in order.');
      const picked = selected('start');
      if (picked.length < 2) { warnings.push(`link_activities: select picked ${picked.length} activit${picked.length === 1 ? 'y' : 'ies'}; nothing to link.`); return { selected: picked.length, linked: 0 }; }
      let linked = 0, skipped = 0;
      for (let i = 1; i < picked.length; i++) {
        const a = picked[i - 1], b = picked[i];
        const r = apply(db, { op: 'add_relationship', pred: a.task_code, pred_project: projectId(a), succ: b.task_code, succ_project: projectId(b), type: op.type, lag_days: op.lag_days, lag_hours: op.lag_hours }, hpd, warnings, batch) as { skipped?: string };
        if (r.skipped) skipped++; else linked++;
      }
      return { selected: picked.length, linked, ...(skipped ? { skipped } : {}) };
    }
    case 'renumber_activities': {
      // P6's Renumber Activity IDs: prefix + start, prefix + (start + increment), ... in order (P6 calls the start number
      // the Suffix; defaults: the project's Activity ID numbering, else A1000 by 10)
      if (op.select == null) fail('renumber_activities needs select: the activities to renumber.');
      const picked = selected('id');
      if (!picked.length) { warnings.push('renumber_activities: select picked no activity; nothing changed.'); return { selected: 0 }; }
      const p = projects().find((x) => x.proj_id === picked[0].proj_id)!;
      const prefix = op.prefix != null ? String(op.prefix) : p.task_code_prefix || 'A';
      const start = op.start != null ? num(op.start, 'start') : Number(p.task_code_base) || 1000;
      const step = op.increment != null ? num(op.increment, 'increment') : Number(p.task_code_step) || 10;
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(step) || step < 1) fail('start must be a whole number of 0 or more, increment a whole number of 1 or more.');
      const next = picked.map((_, i) => `${prefix}${start + i * step}`);
      const long = next.find((c) => c.length > MAX_LEN['TASK.task_code']);
      if (long) fail(`Activity ID "${long}" is ${long.length} characters; P6 holds ${MAX_LEN['TASK.task_code']}.`);
      const moving = new Set(picked.map((t) => t.task_id));
      const clash = picked.flatMap((t, i) => byCode(next[i]).filter((x) => x.proj_id === t.proj_id && !moving.has(x.task_id)).map((x) => `${next[i]} (kept by ${x.task_name})`));
      if (clash.length) fail(`Renumbering would give IDs other activities keep: ${clash.slice(0, 5).join(', ')}${clash.length > 5 ? ` (and ${clash.length - 5} more)` : ''}. Choose another prefix or start.`);
      picked.forEach((t, i) => { t.task_code = next[i]; });
      dropIndexes(realOf(rows(db, 'TASK'))); // the index by Activity ID no longer holds
      return { selected: picked.length, renumbered: picked.length, first: next[0], last: next[next.length - 1] };
    }
    case 'unassign_resource': {
      // the assignment with its UDF values, period actuals and assignment codes (a role assignment: assigned_role)
      const t = activity(op.activity, op.project), byRole = op.resource == null && op.assigned_role != null;
      const a = namedAssignment(db, t, byRole ? null : resource(op.resource), byRole ? role(op.assigned_role) : null, op.nth != null ? num(op.nth, 'nth') : undefined, fail);
      removeAssignments(db, new Set([a.taskrsrc_id]));
      return { unassigned: `${op.resource ?? `Role ${op.assigned_role}`} -> ${t.task_code}` };
    }
    case 'assign_role': {
      // P6's Assign Roles: a role on the activity with no resource yet (priced by the role's rate)
      const t = activity(op.activity, op.project), r = role(op.role);
      const a = assignResource(db, t, '', r.role_id);
      a.cost_per_qty_source_type = 'ST_Role';
      if (op.units_per_day != null) recalcAssignment(db, t, a, 'target_qty_per_hr', num(op.units_per_day, 'units_per_day') / hpd);
      if (op.units != null) { recalcAssignment(db, t, a, 'target_qty', num(op.units, 'units')); a.remain_qty = a.target_qty; }
      recomputeCosts(db, a);
      return { assigned: `Role ${r.role_short_name} -> ${t.task_code}`, budgeted_units: Number(a.target_qty) };
    }
  }
  const extra = applyExtra(db, op, { hpd, fail, str, num, date, project, projectFor, activity, wbsOf, calendar, resource, curveId, dayHours, warn: (m) => warnings.push(m), periods, ole, linked: (pred, succ) => batch.added.push({ pred, succ, at: batch.at ?? -1 }) });
  if (extra !== undefined) return extra;
  return fail(`Unknown operation "${op.op}". Known: ${OP_NAMES.join(', ')}.`);
}

function updateActivity(db: Db, t: Row, op: Op, dayHours: (t: Row) => number, calendar: (n: unknown) => Row, cstr: (v: unknown) => [string, string]): void {
  if (op.name != null) t.task_name = str(op.name, 'name');
  if (op.type != null) t.task_type = TYPES[String(op.type).toLowerCase()] ?? (enumOk('TASK', 'task_type', String(op.type)) && /^TT_/.test(String(op.type)) ? String(op.type) : fail(`Unknown activity type "${op.type}". Use: ${Object.keys(TYPES).join(', ')}.`));
  // P6 sets a milestone's durations to zero when the type changes
  if (op.type != null && (t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile') && op.duration_days == null && op.duration_hours == null) { t.target_drtn_hr_cnt = '0'; if (!t.act_end_date) t.remain_drtn_hr_cnt = '0'; refreshOwnDates(db, t); }
  if (op.calendar != null) t.clndr_id = calendar(op.calendar).clndr_id;
  const hpd = dayHours(t); // after a calendar change in the same operation
  if (op.priority != null) t.priority_type = PRIO[String(op.priority).toLowerCase()] ?? fail('priority: top, high, normal, low or lowest.');
  const durH = op.duration_days != null ? num(op.duration_days, 'duration_days') * hpd : op.duration_hours != null ? num(op.duration_hours, 'duration_hours') : null;
  if (durH != null) {
    if (durH < 0) fail('Duration cannot be negative.');
    if ((t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile') && durH > 0) fail('A milestone has zero duration.');
    t.target_drtn_hr_cnt = p6num(durH);
    if (!t.act_start_date) t.remain_drtn_hr_cnt = p6num(durH);
  }
  if (op.remaining_days != null || op.remaining_hours != null) {
    if (t.act_end_date) fail('A completed activity has no remaining duration.');
    t.remain_drtn_hr_cnt = p6num(op.remaining_hours != null ? num(op.remaining_hours, 'remaining_hours') : num(op.remaining_days, 'remaining_days') * hpd);
  }
  if (op.constraint !== undefined) { const [c, d] = cstr(op.constraint); t.cstr_type = c; t.cstr_date = d; }
  if (op.secondary_constraint !== undefined) { const [c, d] = cstr(op.secondary_constraint); t.cstr_type2 = c; t.cstr_date2 = d; }
  if (op.start != null) ok(setStart(db, t, date(op.start, 'start')));
  if (op.actual_start !== undefined) ok(setActual(t, 'start', op.actual_start ? date(op.actual_start, 'actual_start') : ''));
  if (op.actual_finish !== undefined) ok(setActual(t, 'finish', op.actual_finish ? date(op.actual_finish, 'actual_finish') : ''));
  if (op.percent_complete != null) ok(setPercent(t, num(op.percent_complete, 'percent_complete')));
  if (op.expected_finish !== undefined) t.expect_end_date = op.expected_finish ? date(op.expected_finish, 'expected_finish') : '';
  if (op.finish != null) ok(setFinish(db, t, String(op.finish)));
  t.status_code = statusOf(t);
  t.update_date = formatP6Date(Date.now() / 60000);
  if (op.assignments_follow === true) fitAssignmentsToDuration(db, t);
  if (durH != null || op.remaining_days != null || op.remaining_hours != null || op.calendar != null) refreshOwnDates(db, t);
}

function periods(v: unknown): Shift[] {
  if (!Array.isArray(v)) fail('Work periods must be a list like [["08:00","12:00"],["13:00","17:00"]] (empty list = day off).');
  return (v as unknown[]).map((p) => {
    const [a, b] = Array.isArray(p) ? p : [];
    const m = (s: unknown) => { const x = /^(\d\d?):(\d\d)$/.exec(String(s)); return x ? Number(x[1]) * 60 + Number(x[2]) : fail(`Bad time "${s}" (use HH:MM).`); };
    const s = m(a), e = b === '24:00' ? 1440 : m(b);
    if (!(e > s)) fail(`Period ${a}-${b} ends before it starts.`);
    return { start: s, end: e };
  });
}
const ole = (d: string) => Math.round(parseP6Date(d.slice(0, 10))! / 1440) + 25569;

