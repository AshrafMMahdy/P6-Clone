// Activities picked the way a P6 user filters a layout and selects the rows (Ctrl+A), for the edit operations that work
// on one activity: "select" in place of their id / activity applies the operation to every activity it picks, as P6's
// Global Change, Assign, Delete and Link Activities do on a selection. Criteria all apply together; exclude takes
// activities back out. Baselines are never picked.
import { rows, type Db, type Row } from '../db.ts';
import { realOf } from '../journal.ts';
import { whereTest } from './ops-fields.ts';

/** The operations select works with, and the field that names their one activity. */
export const SELECT_KEY: Record<string, string> = {
  update_activity: 'id', delete_activity: 'id', dissolve_activity: 'id', move_activity: 'id',
  assign_code: 'activity', set_udf: 'activity', set_notebook: 'activity', set_estimates: 'activity', set_predecessors: 'activity',
  assign_resource: 'activity', assign_role: 'activity', unassign_resource: 'activity', update_assignment: 'activity',
  add_expense: 'activity', update_expense: 'activity', delete_expense: 'activity', delete_expenses: 'activity',
  add_step: 'activity', update_step: 'activity', delete_step: 'activity', set_period_actuals: 'activity',
};

export const SELECT_GUIDE = [
  `select (in place of id / activity on ${Object.keys(SELECT_KEY).join(', ')}; required on link_activities and renumber_activities): the activities to work on, as a P6 filter and select-all picks them; one operation then does them all (one undo). Criteria, all applying together: [project], [ids [Activity IDs]], [wbs] (a WBS code or list: those elements and everything under them), [code {type, value or values [..], or empty: true}] (activity code values and their child values; a list of such = all of them), [udf {udf, value} or {udf, op, value} or {udf, empty: true}] (op as in set_fields' where), [resource] (a Resource ID or list: activities it is assigned to), [where {TASK field: value or {op, value}}] (as set_fields' where: task_name icontains, status_code TK_NotStart / TK_Active / TK_Complete, task_type, total_float_hr_cnt <= 0 for critical, early_start_date >= a date...), [exclude {same criteria}] (taken back out), [order_by] (id, start, finish, name, listed: the order activities are done in; default id, or the ids order when ids is given). An empty selection changes nothing and is reported in warnings. The answer gives selected (how many) and the first results`,
  `link_activities: select, [type] (FS default, SS, FF, SF), [lag_days], [order_by] (default start): links each picked activity to the next one in that order, as P6's Link Activities on a selection; a relationship already there is skipped`,
  `renumber_activities: select, [prefix], [start] (the first number; P6's dialog calls it Suffix), [increment], [order_by] (default id): new Activity IDs prefix + start, prefix + (start + increment)... in that order, as P6's Renumber Activity IDs (defaults: the project's Activity ID prefix, suffix and increment, else A, 1000, 10); refused, nothing changed, when a new ID is one another activity of the project keeps (as P6 warns of a duplicate Activity ID)`,
].join('\n');

export interface SelectHelpers {
  fail: (m: string) => never;
  /** the live projects, or the one named */
  project: (id?: unknown) => Row;
  projects: () => Row[];
  wbsOf: (p: Row, code: unknown) => Row;
  resource: (id: unknown) => Row;
}

const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();
const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]);
/** Every id under these (and these), by a parent field. */
const under = (all: Row[], ids: Set<string>, idF: string, parentF: string) => {
  const kids = new Map<string, string[]>();
  for (const r of all) { const l = kids.get(r[parentF]); if (l) l.push(r[idF]); else kids.set(r[parentF], [r[idF]]); }
  const out = new Set(ids), todo = [...ids];
  while (todo.length) for (const k of kids.get(todo.pop()!) ?? []) if (!out.has(k)) { out.add(k); todo.push(k); }
  return out;
};
const startOf = (t: Row) => t.act_start_date || t.early_start_date || t.restart_date || t.target_start_date || '';
const finishOf = (t: Row) => t.act_end_date || t.early_end_date || t.reend_date || t.target_end_date || '';
const byId = (a: Row, b: Row) => String(a.task_code).localeCompare(String(b.task_code), undefined, { numeric: true });

/** The activities a select picks, in its order. */
export function selectActivities(db: Db, sel: unknown, h: SelectHelpers, defaultOrder = 'id'): Row[] {
  const { fail } = h;
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) fail('select must be an object of criteria, e.g. {"wbs": "1.2", "where": {"status_code": "TK_NotStart"}}.');
  const s = sel as Record<string, unknown>;
  const known = ['project', 'ids', 'wbs', 'code', 'udf', 'resource', 'where', 'exclude', 'order_by'];
  const extra = Object.keys(s).filter((k) => !known.includes(k));
  if (extra.length) fail(`select: unknown ${extra.join(', ')} (criteria: ${known.join(', ')}).`);
  const projs = s.project != null ? [h.project(s.project)] : h.projects();
  const pids = new Set(projs.map((p) => p.proj_id));
  const T = rows(db, 'TASK');
  let picked = T.filter((t) => pids.has(t.proj_id));
  const ids = s.ids != null ? (Array.isArray(s.ids) ? s.ids.map(String) : fail('select.ids must be a list of Activity IDs.')) : null;
  picked = filterBy(db, picked, s, ids, h, pids);
  if (s.exclude != null) {
    if (typeof s.exclude !== 'object' || Array.isArray(s.exclude)) fail('select.exclude takes the same criteria as select.');
    const x = s.exclude as Record<string, unknown>;
    if (x.project != null || x.exclude != null || x.order_by != null) fail('select.exclude takes ids, wbs, code, udf, resource and where.');
    if (!['ids', 'wbs', 'code', 'udf', 'resource', 'where'].some((k) => x[k] != null)) fail('select.exclude needs at least one criterion (ids, wbs, code, udf, resource or where); an empty one would take every activity out.');
    const xids = x.ids != null ? (Array.isArray(x.ids) ? x.ids.map(String) : fail('select.exclude.ids must be a list of Activity IDs.')) : null;
    const out = new Set(filterBy(db, picked, x, xids, h, pids));
    picked = picked.filter((t) => !out.has(t));
  }
  const order = lc(s.order_by ?? (ids ? 'listed' : defaultOrder));
  const sorts: Record<string, (a: Row, b: Row) => number> = {
    id: byId,
    start: (a, b) => startOf(a).localeCompare(startOf(b)) || byId(a, b),
    finish: (a, b) => finishOf(a).localeCompare(finishOf(b)) || byId(a, b),
    name: (a, b) => String(a.task_name).localeCompare(String(b.task_name)) || byId(a, b),
  };
  if (order === 'listed') {
    const at = new Map((ids ?? fail('order_by listed needs ids.')).map((c, i) => [c, i]));
    return picked.sort((a, b) => (at.get(a.task_code)! - at.get(b.task_code)!) || byId(a, b));
  }
  return picked.sort(sorts[order] ?? fail(`order_by must be ${[...Object.keys(sorts), 'listed'].join(', ')}.`));
}

function filterBy(db: Db, from: Row[], s: Record<string, unknown>, ids: string[] | null, h: SelectHelpers, pids: Set<string>): Row[] {
  const { fail } = h;
  let picked = from;
  if (ids) {
    const want = new Set(ids);
    const have = new Set(rows(db, 'TASK').filter((t) => pids.has(t.proj_id)).map((t) => t.task_code));
    const missing = ids.filter((c) => !have.has(c));
    if (missing.length) fail(`select.ids: no activity ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (and ${missing.length - 5} more)` : ''}.`);
    picked = picked.filter((t) => want.has(t.task_code));
  }
  if (s.wbs != null) {
    const W = realOf(rows(db, 'PROJWBS'));
    const roots = new Set<string>();
    for (const code of list(s.wbs)) {
      // one project: its own refusal (no such code, an ambiguous short name) is the answer; several: the ones that have it
      const projs = h.projects().filter((p) => pids.has(p.proj_id));
      const hits = projs.length === 1 ? [h.wbsOf(projs[0], code)] : projs.map((p) => { try { return h.wbsOf(p, code); } catch { return null; } }).filter((w): w is Row => !!w);
      if (!hits.length) fail(`select.wbs: no WBS "${code}"${pids.size === 1 ? '' : ' in any of the projects'}.`);
      for (const w of hits) roots.add(w.wbs_id);
    }
    const all = under(W, roots, 'wbs_id', 'parent_wbs_id');
    picked = picked.filter((t) => all.has(t.wbs_id));
  }
  for (const c of list(s.code)) {
    if (!c || typeof c !== 'object') fail('select.code must be {type, value} (or values, or empty: true), or a list of them.');
    const { type, value, values, empty } = c as Record<string, unknown>;
    const types = rows(db, 'ACTVTYPE').filter((x) => lc(x.actv_code_type) === lc(type) && (!x.proj_id || pids.has(x.proj_id)));
    if (!types.length) fail(`select.code: no activity code type "${type}".`);
    const tids = new Set(types.map((x) => x.actv_code_type_id));
    const A = rows(db, 'TASKACTV').filter((a) => tids.has(a.actv_code_type_id));
    if (empty === true) { const coded = new Set(A.map((a) => a.task_id)); picked = picked.filter((t) => !coded.has(t.task_id)); continue; }
    const wanted = list(values ?? value);
    if (!wanted.length) fail('select.code needs value, values or empty: true.');
    const V = realOf(rows(db, 'ACTVCODE')).filter((v) => tids.has(v.actv_code_type_id));
    const vById = new Map(V.map((v) => [v.actv_code_id, v]));
    const path = (v: Row) => { const out: string[] = []; for (let x: Row | undefined = v, n = 0; x && n <= V.length; x = vById.get(x.parent_actv_code_id), n++) out.unshift(x.short_name); return out.join('.').toLowerCase(); };
    const roots = new Set<string>();
    for (const w of wanted) {
      const hits = V.filter((v) => lc(v.short_name) === lc(w) || path(v) === lc(w));
      if (!hits.length) fail(`select.code: no value "${w}" in code type ${type}.`);
      for (const v of hits) roots.add(v.actv_code_id);
    }
    const all = under(V, roots, 'actv_code_id', 'parent_actv_code_id');
    const tasks = new Set(A.filter((a) => all.has(a.actv_code_id)).map((a) => a.task_id));
    picked = picked.filter((t) => tasks.has(t.task_id));
  }
  for (const u of list(s.udf)) {
    if (!u || typeof u !== 'object') fail('select.udf must be {udf, value} (or {udf, op, value}, or {udf, empty: true}), or a list of them.');
    const { udf, op, value, empty } = u as Record<string, unknown>;
    const ut = rows(db, 'UDFTYPE').find((x) => x.table_name === 'TASK' && lc(x.udf_type_label) === lc(udf)) ?? fail(`select.udf: no activity UDF "${udf}".`);
    const field = ut.logical_data_type === 'FT_TEXT' ? 'udf_text' : /DATE/.test(ut.logical_data_type) ? 'udf_date' : /CODE/.test(ut.logical_data_type) ? 'udf_code_id' : 'udf_number';
    const vals = new Map(rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === ut.udf_type_id).map((v) => [v.fk_id, v]));
    if (empty === true) { picked = picked.filter((t) => !(vals.get(t.task_id)?.[field] ?? '')); continue; }
    const test = whereTest({ [field]: op != null ? { op, value } : value }, fail);
    picked = picked.filter((t) => { const v = vals.get(t.task_id); return !!v && test(v); });
  }
  if (s.resource != null) {
    const rids = new Set(list(s.resource).map((r) => h.resource(r).rsrc_id));
    const tasks = new Set(rows(db, 'TASKRSRC').filter((a) => rids.has(a.rsrc_id)).map((a) => a.task_id));
    picked = picked.filter((t) => tasks.has(t.task_id));
  }
  if (s.where != null) {
    if (typeof s.where !== 'object' || Array.isArray(s.where)) fail('select.where must be {field: value or {op, value}}.');
    const F = new Set(realOf(db.tables.TASK?.fields ?? []));
    for (const f of Object.keys(s.where as object)) if (!F.has(f)) fail(`select.where: no field "${f}" in TASK.`);
    const test = whereTest(s.where as Record<string, unknown>, fail);
    picked = picked.filter(test);
  }
  return picked;
}
