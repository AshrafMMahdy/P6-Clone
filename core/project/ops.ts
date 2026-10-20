// Edit a P6 database with a list of JSON operations, as one transaction: if any operation fails nothing changes
// and the error names the operation. Everything is addressed the way a scheduler sees it (project ID, activity
// ID, WBS code, resource ID, calendar name), never by internal database numbers. Durations are in days.
// Used by the command-line `edit` command and the MCP server.
import { addField, nextId, rows, table, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { p6num } from '../schedule/cpm.ts';
import { record, rollback } from '../journal.ts';
import { parseClndrData, serializeClndrData, standardCalendar, type Shift } from '../calendar/clndr-data.ts';
import { assignResource, recalcAssignment, recomputeCosts } from '../resource/assign.ts';
import { copyProject } from './copy.ts';
import { applyExtra, EXTRA_GUIDE, EXTRA_OP_NAMES } from './ops-extra.ts';
import {
  addActivity, addRelationship, addWbs, deleteActivities, dissolveActivities, ensureDefaultCalendar, ensureEps, newProject,
  enumOk, normDate, refreshOwnDates, setActual, setFinish, setPercent, setStart, statusOf,
} from './edit.ts';

export type Op = Record<string, unknown> & { op: string };
export interface OpsResult { ok: boolean; applied: number; results: unknown[]; error?: { index: number; op: unknown; message: string } }
export interface OpsOptions { hoursPerDay?: number }

const TYPES: Record<string, string> = { task: 'TT_Task', task_dependent: 'TT_Task', resource_dependent: 'TT_Rsrc', start_milestone: 'TT_Mile', finish_milestone: 'TT_FinMile', milestone: 'TT_FinMile', level_of_effort: 'TT_LOE', loe: 'TT_LOE', wbs_summary: 'TT_WBS' };
const CSTR: Record<string, string> = { start_on: 'CS_MSO', start_on_or_after: 'CS_MSOA', start_on_or_before: 'CS_MSOB', finish_on: 'CS_MEO', finish_on_or_before: 'CS_MEOB', finish_on_or_after: 'CS_MEOA', mandatory_start: 'CS_MANDSTART', mandatory_finish: 'CS_MANDFIN', as_late_as_possible: 'CS_ALAP', alap: 'CS_ALAP', none: '' };
const REL: Record<string, string> = { FS: 'PR_FS', SS: 'PR_SS', FF: 'PR_FF', SF: 'PR_SF' };
const RTYPE: Record<string, string> = { labor: 'RT_Labor', nonlabor: 'RT_Equip', equipment: 'RT_Equip', material: 'RT_Mat' };
const PRIO: Record<string, string> = { top: 'PT_Top', high: 'PT_High', normal: 'PT_Normal', low: 'PT_Low', lowest: 'PT_Lowest' };
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const OP_NAMES = ['add_project', 'copy_project', 'set_project', 'add_calendar', 'add_holidays', 'add_wbs', 'delete_wbs', 'add_activity', 'update_activity', 'delete_activity', 'dissolve_activity', 'add_relationship', 'update_relationship', 'delete_relationship', 'add_resource', 'assign_resource', 'unassign_resource', ...EXTRA_OP_NAMES];

/** The operations as an AI model needs to know them (fields, units, codes). Kept here, next to the code it describes. */
export const OP_GUIDE = [
  'Operations (JSON objects with "op"; [x] = optional; durations and lags in days; dates "2026-03-02" or "2026-03-02 08:00"; "project" may be left out when one project is meant):',
  `add_project: id, start, [name], [must_finish_by], [calendar]`,
  `copy_project: from (project ID to copy), id (new project ID), [name], [start] (moves every planned date by the same amount), [keep_progress] (default false: actuals and % complete cleared). Copies WBS, activities, logic, resource assignments, codes, UDFs and notebooks; the copy is then edited like any project`,
  `set_project: [project], [name], [data_date], [planned_start], [must_finish_by], [calendar], [eps] (EPS ID)`,
  `add_calendar: name, [work_week {"mon":[["08:00","12:00"],["13:00","17:00"]], ... "sat":[]}] (default Mon-Fri 8h), [holidays [dates]], [work_exceptions {date: periods}]`,
  `add_holidays: calendar, dates [dates]`,
  `add_wbs: code, [name], [parent] (parent WBS code or dotted path; omit for top level), [project]`,
  `delete_wbs: code, [keep_logic] (default true: every predecessor of the removed activities is linked on to their successors, so the chain stays closed; false = just delete), [project]. Removes the WBS element, its child elements and all their activities: the way to remove whole floors or areas, e.g. from a copied project`,
  `add_activity: name, [id], [wbs] (WBS code; omit = project root), [type] (${Object.keys(TYPES).join(', ')}), [duration_days], [calendar], [priority] (${Object.keys(PRIO).join(', ')}), [constraint {type, date}] (types: ${Object.keys(CSTR).filter((k) => k !== 'none').join(', ')}), [secondary_constraint], [project]`,
  `update_activity: id, then any add_activity field, plus [new_id], [remaining_days], [percent_complete], [actual_start], [actual_finish], [expected_finish], [start], [finish]`,
  `delete_activity / dissolve_activity: id`,
  `add_relationship: pred, succ, [type] (FS default, SS, FF, SF), [lag_days] (negative = lead)`,
  `update_relationship: pred, succ, [type], [new_type], [lag_days]; delete_relationship: pred, succ, [type]`,
  `add_resource: id, [name], [type] (labor, nonlabor, material), [units_per_day], [max_units_per_day], [price_per_unit], [calendar], [parent]`,
  `assign_resource: activity, resource, [units_per_day] or [units]; unassign_resource: activity, resource`,
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
  const results: unknown[] = [];
  let at = -1;
  try {
    record(db, (d) => { for (at = 0; at < list.length; at++) results.push(apply(d, list[at] as Op, hpd)); });
    return { ok: true, applied: list.length, results };
  } catch (e) {
    // record() has already put the database back as it was
    return { ok: false, applied: 0, results: [], error: { index: at, op: list[at], message: e instanceof OpError ? e.message : `Internal error: ${(e as Error).message}` } };
  }
}

function apply(db: Db, op: Op, hpd: number): unknown {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') fail('Each operation needs an "op" name.');
  const projects = () => rows(db, 'PROJECT').filter((p) => !p._baseline_of);
  const project = (id?: unknown): Row => {
    if (id != null) return projects().find((p) => p.proj_short_name.toLowerCase() === String(id).toLowerCase()) ?? fail(`No project "${id}".`);
    const ps = projects();
    return ps.length === 1 ? ps[0] : fail(ps.length ? `Several projects are in the file; say which with "project": ${ps.map((p) => p.proj_short_name).join(', ')}.` : 'The file has no project yet; add one with {"op":"add_project"}.');
  };
  const activity = (id: unknown, proj?: unknown): Row => {
    const code = str(id, 'id');
    const pool = proj != null ? rows(db, 'TASK').filter((t) => t.proj_id === project(proj).proj_id) : rows(db, 'TASK').filter((t) => projects().some((p) => p.proj_id === t.proj_id));
    const hits = pool.filter((t) => t.task_code === code);
    if (hits.length > 1) fail(`Activity ID "${code}" exists in several projects; add "project".`);
    return hits[0] ?? fail(`No activity "${code}".`);
  };
  const wbsOf = (p: Row, code: unknown): Row => {
    const W = rows(db, 'PROJWBS').filter((w) => w.proj_id === p.proj_id);
    if (code == null || code === '') return W.find((w) => w.proj_node_flag === 'Y') ?? fail(`Project ${p.proj_short_name} has no WBS root.`);
    const c = String(code).toLowerCase();
    const byId = new Map(W.map((w) => [w.wbs_id, w]));
    const path = (w: Row) => { const out: string[] = []; for (let x: Row | undefined = w, n = 0; x && x.proj_node_flag !== 'Y' && n < 50; x = byId.get(x.parent_wbs_id), n++) out.unshift(x.wbs_short_name); return out.join('.').toLowerCase(); };
    // A full path names one element; only a bare short name can be ambiguous ("1" is both the top element 1 and the
    // child 1.1's short name — the normal P6 shape, so the path must win).
    const byPath = W.filter((w) => w.proj_node_flag !== 'Y' && path(w) === c);
    if (byPath.length === 1) return byPath[0];
    const hits = W.filter((w) => w.proj_node_flag !== 'Y' && (path(w) === c || w.wbs_short_name.toLowerCase() === c));
    if (hits.length > 1) fail(`WBS code "${code}" is ambiguous; use the full path (e.g. ${path(hits[0])}).`);
    return hits[0] ?? fail(`No WBS "${code}" in project ${p.proj_short_name}.`);
  };
  const calendar = (name: unknown): Row => rows(db, 'CALENDAR').find((c) => c.clndr_name.toLowerCase() === String(name).toLowerCase()) ?? fail(`No calendar "${name}".`);
  const resource = (id: unknown): Row => rows(db, 'RSRC').find((r) => r.rsrc_short_name.toLowerCase() === String(id).toLowerCase()) ?? fail(`No resource "${id}" (add it with {"op":"add_resource"}).`);
  const cstr = (v: unknown): [string, string] => {
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
      if (op.eps != null) { ensureEps(db); addField(table(db, 'PROJECT'), '_eps_id'); p._eps_id = rows(db, 'EPS').find((e) => e.eps_short_name.toLowerCase() === String(op.eps).toLowerCase())?.eps_id ?? fail(`No EPS "${op.eps}" (add it with {"op":"add_eps"}).`); }
      return { project: p.proj_short_name };
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
      const def = parseClndrData(c.clndr_data);
      for (const h of (Array.isArray(op.dates) ? op.dates : fail('"dates" must be a list of dates.'))) def.exceptions.set(ole(date(h, 'dates[]')), []);
      c.clndr_data = serializeClndrData(def);
      return { calendar: c.clndr_name };
    }
    case 'add_wbs': {
      const p = project(op.project);
      const parent = wbsOf(p, op.parent);
      const code = str(op.code, 'code');
      if (rows(db, 'PROJWBS').some((w) => w.proj_id === p.proj_id && w.parent_wbs_id === parent.wbs_id && w.wbs_short_name.toLowerCase() === code.toLowerCase())) fail(`WBS "${code}" already exists there.`);
      const w = addWbs(db, p.proj_id, parent.wbs_id);
      w.wbs_short_name = code; w.wbs_name = typeof op.name === 'string' ? op.name : code;
      return { wbs: code };
    }
    case 'delete_wbs': {
      const p = project(op.project);
      const w = wbsOf(p, str(op.code, 'code'));
      const sub = new Set([w.wbs_id]);
      for (let grew = true; grew;) { grew = false; for (const x of rows(db, 'PROJWBS')) if (sub.has(x.parent_wbs_id) && !sub.has(x.wbs_id)) { sub.add(x.wbs_id); grew = true; } }
      const ids = rows(db, 'TASK').filter((t) => sub.has(t.wbs_id)).map((t) => t.task_id);
      const linked = op.keep_logic === false ? (deleteActivities(db, ids), 0) : dissolveActivities(db, ids);
      table(db, 'PROJWBS').rows = rows(db, 'PROJWBS').filter((x) => !sub.has(x.wbs_id));
      return { deleted_wbs: w.wbs_short_name, wbs_elements: sub.size, activities: ids.length, relationships_added: linked };
    }
    case 'add_activity': {
      const p = project(op.project);
      const w = wbsOf(p, op.wbs);
      const t = addActivity(db, p.proj_id, w.wbs_id, hpd);
      if (op.id != null) {
        const code = str(op.id, 'id');
        if (rows(db, 'TASK').some((x) => x.task_id !== t.task_id && x.proj_id === p.proj_id && x.task_code === code)) fail(`Activity ID "${code}" already exists in ${p.proj_short_name}.`);
        t.task_code = code;
      }
      t.task_name = str(op.name, 'name');
      updateActivity(db, t, op, hpd, calendar, cstr);
      if (op.duration_days == null && op.duration_hours == null && (t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile')) { t.target_drtn_hr_cnt = t.remain_drtn_hr_cnt = '0'; refreshOwnDates(db, t); }
      return { activity: t.task_code };
    }
    case 'update_activity': {
      const t = activity(op.id, op.project);
      if (op.new_id != null) {
        const code = str(op.new_id, 'new_id');
        if (rows(db, 'TASK').some((x) => x.task_id !== t.task_id && x.proj_id === t.proj_id && x.task_code === code)) fail(`Activity ID "${code}" already exists.`);
        t.task_code = code;
      }
      if (op.wbs != null) t.wbs_id = wbsOf(project(projects().find((p) => p.proj_id === t.proj_id)!.proj_short_name), op.wbs).wbs_id;
      updateActivity(db, t, op, hpd, calendar, cstr);
      return { activity: t.task_code };
    }
    case 'delete_activity': { const t = activity(op.id, op.project); deleteActivities(db, [t.task_id]); return { deleted: t.task_code }; }
    case 'dissolve_activity': { const t = activity(op.id, op.project); const n = dissolveActivities(db, [t.task_id]); return { dissolved: t.task_code, relationships_added: n }; }
    case 'add_relationship': {
      const a = activity(op.pred, op.pred_project ?? op.project), b = activity(op.succ, op.succ_project ?? op.project);
      const type = REL[String(op.type ?? 'FS').toUpperCase()] ?? fail(`Relationship type must be FS, SS, FF or SF.`);
      ok(addRelationship(db, a.task_id, b.task_id, type, op.lag_days != null ? num(op.lag_days, 'lag_days') * hpd : op.lag_hours != null ? num(op.lag_hours, 'lag_hours') : 0));
      return { relationship: `${a.task_code} ${type.slice(3)} ${b.task_code}` };
    }
    case 'update_relationship': case 'delete_relationship': {
      const a = activity(op.pred, op.pred_project ?? op.project), b = activity(op.succ, op.succ_project ?? op.project);
      const P = table(db, 'TASKPRED');
      const want = op.type ? REL[String(op.type).toUpperCase()] : null;
      const hits = P.rows.filter((r) => r.pred_task_id === a.task_id && r.task_id === b.task_id && (!want || r.pred_type === want));
      if (!hits.length) fail(`No relationship ${a.task_code} -> ${b.task_code}${want ? ` (${want.slice(3)})` : ''}.`);
      if (hits.length > 1) fail(`Several relationships ${a.task_code} -> ${b.task_code}; give "type".`);
      if (op.op === 'delete_relationship') { P.rows = P.rows.filter((r) => r !== hits[0]); return { deleted: `${a.task_code} -> ${b.task_code}` }; }
      if (op.new_type) {
        const nt = REL[String(op.new_type).toUpperCase()] ?? fail('new_type must be FS, SS, FF or SF.');
        if (P.rows.some((r) => r !== hits[0] && r.pred_task_id === a.task_id && r.task_id === b.task_id && r.pred_type === nt)) fail(`${a.task_code} -> ${b.task_code} already has a ${nt.slice(3)} relationship.`);
        hits[0].pred_type = nt;
      }
      if (op.lag_days != null) hits[0].lag_hr_cnt = p6num(num(op.lag_days, 'lag_days') * hpd);
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
      RR.rows.push({ rsrc_rate_id: String(nextId(db, 'RSRCRATE')), rsrc_id: rid, max_qty_per_hr: p6num(op.max_units_per_day != null ? num(op.max_units_per_day, 'max_units_per_day') / hpd : perHr), cost_per_qty: p6num(op.price_per_unit != null ? num(op.price_per_unit, 'price_per_unit') : 0), start_date: '' });
      return { resource: id };
    }
    case 'assign_resource': {
      const t = activity(op.activity, op.project), r = resource(op.resource);
      if (rows(db, 'TASKRSRC').some((a) => a.task_id === t.task_id && a.rsrc_id === r.rsrc_id)) fail(`${r.rsrc_short_name} is already assigned to ${t.task_code}.`);
      const a = assignResource(db, t, r.rsrc_id);
      if (op.units_per_day != null) recalcAssignment(db, t, a, 'target_qty_per_hr', num(op.units_per_day, 'units_per_day') / hpd);
      if (op.units != null) { recalcAssignment(db, t, a, 'target_qty', num(op.units, 'units')); a.remain_qty = a.target_qty; recomputeCosts(db, a); }
      return { assigned: `${r.rsrc_short_name} -> ${t.task_code}`, budgeted_units: Number(a.target_qty) };
    }
    case 'unassign_resource': {
      const t = activity(op.activity, op.project), r = resource(op.resource);
      const T = table(db, 'TASKRSRC'), n = T.rows.length;
      T.rows = T.rows.filter((a) => !(a.task_id === t.task_id && a.rsrc_id === r.rsrc_id));
      if (T.rows.length === n) fail(`${r.rsrc_short_name} is not assigned to ${t.task_code}.`);
      return { unassigned: `${r.rsrc_short_name} -> ${t.task_code}` };
    }
  }
  const extra = applyExtra(db, op, { hpd, fail, str, num, date, project, activity, wbsOf, calendar, resource, periods, ole });
  if (extra !== undefined) return extra;
  return fail(`Unknown operation "${op.op}". Known: ${OP_NAMES.join(', ')}.`);
}

function updateActivity(db: Db, t: Row, op: Op, hpd: number, calendar: (n: unknown) => Row, cstr: (v: unknown) => [string, string]): void {
  if (op.name != null) t.task_name = str(op.name, 'name');
  if (op.type != null) t.task_type = TYPES[String(op.type).toLowerCase()] ?? (enumOk('TASK', 'task_type', String(op.type)) && /^TT_/.test(String(op.type)) ? String(op.type) : fail(`Unknown activity type "${op.type}". Use: ${Object.keys(TYPES).join(', ')}.`));
  // P6 sets a milestone's durations to zero when the type changes
  if (op.type != null && (t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile') && op.duration_days == null && op.duration_hours == null) { t.target_drtn_hr_cnt = '0'; if (!t.act_end_date) t.remain_drtn_hr_cnt = '0'; refreshOwnDates(db, t); }
  if (op.calendar != null) t.clndr_id = calendar(op.calendar).clndr_id;
  if (op.priority != null) t.priority_type = PRIO[String(op.priority).toLowerCase()] ?? fail('priority: top, high, normal, low or lowest.');
  const durH = op.duration_days != null ? num(op.duration_days, 'duration_days') * hpd : op.duration_hours != null ? num(op.duration_hours, 'duration_hours') : null;
  if (durH != null) {
    if (durH < 0) fail('Duration cannot be negative.');
    if ((t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile') && durH > 0) fail('A milestone has zero duration.');
    t.target_drtn_hr_cnt = p6num(durH);
    if (!t.act_start_date) t.remain_drtn_hr_cnt = p6num(durH);
  }
  if (op.remaining_days != null) { if (t.act_end_date) fail('A completed activity has no remaining duration.'); t.remain_drtn_hr_cnt = p6num(num(op.remaining_days, 'remaining_days') * hpd); }
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
  if (durH != null || op.remaining_days != null || op.calendar != null) refreshOwnDates(db, t);
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
