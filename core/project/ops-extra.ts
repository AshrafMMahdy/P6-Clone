// More edit operations (see ops.ts): WBS changes, codes, UDFs, notebooks, cost accounts and expenses, steps,
// risk estimates, baselines, EPS/OBS/roles, calendar changes and assignment details. Same rules as ops.ts:
// addressed by IDs and names a scheduler sees, durations in days, one transaction per list.
import { addField, dropIndexes, nextId, refTarget, rowIndex, rows, table, type Db, type Row } from '../db.ts';
import { p6num } from '../schedule/cpm.ts';
import { parseClndrData, scheduledCalendarDef, serializeClndrData, type Shift } from '../calendar/clndr-data.ts';
import { assignmentActuals, recalcAssignment, recomputeCosts } from '../resource/assign.ts';
import { ensureEps, projectNumberProblem, renumberProject } from './edit.ts';
import { pick, realOf, removeWhere } from '../journal.ts';
import { LOB_UDF } from '../lob/expand.ts';
import { LOB_FLAG } from '../lob/store.ts';
import { STEP_FIELDS, syncFromSteps } from './steps.ts';
import { DISTS, setEstimate, type Dist } from '../risk/montecarlo.ts';
import { assignBaseline, deleteBaseline, restoreBaseline, saveBaseline } from '../progress/baseline.ts';

export interface OpHelpers {
  hpd: number;
  fail: (m: string) => never;
  str: (v: unknown, what: string) => string;
  num: (v: unknown, what: string) => number;
  date: (v: unknown, what: string) => string;
  project: (id?: unknown) => Row;
  /** op.project, or the project of the WBS element a "wbs_id:" reference names */
  projectFor: (id: unknown, wbsRef: unknown) => Row;
  activity: (id: unknown, proj?: unknown) => Row;
  wbsOf: (p: Row, code: unknown) => Row;
  calendar: (name: unknown) => Row;
  resource: (id: unknown) => Row;
  curveId: (name: unknown) => string;
  /** hours in a day of the activity's own calendar */
  dayHours: (t: Row) => number;
  warn: (message: string) => void;
  periods: (v: unknown) => Shift[];
  ole: (d: string) => number;
}
type Op = Record<string, unknown> & { op: string };

export const EXTRA_OP_NAMES = ['add_resource_curve', 'build_baseline', 'update_wbs', 'add_code_type', 'add_code_value', 'assign_code', 'add_udf', 'set_udf', 'set_notebook', 'add_cost_account', 'add_expense', 'update_expense', 'delete_expense', 'add_step', 'update_step', 'delete_step', 'set_estimates', 'save_baseline', 'assign_baseline', 'delete_baseline', 'restore_baseline', 'update_baseline', 'clear_notebooks', 'add_eps', 'update_eps', 'delete_eps', 'add_obs', 'update_obs', 'delete_obs', 'add_role', 'update_role', 'delete_role', 'update_calendar', 'update_assignment', 'update_resource', 'delete_resource', 'update_code_type', 'update_code_value', 'delete_code_value', 'update_cost_account', 'regenerate_guids', 'clear_authors', 'clear_udfs', 'delete_expenses', 'update_udf', 'update_resource_curve'];

export const EXTRA_GUIDE = [
  `update_resource_curve: name, new_name`,
  `add_resource_curve: name, values (21 percentages totalling 100: values[0] at the start, values[1..20] for each 5% of the assignment's time, like P6 Resource Curves); assign it with assign_resource / update_assignment curve`,
  `build_baseline: [project], [name], [assign_as] (project default, bl1, bl2, bl3; "" = not assigned), activities [{activity (ID or uid:<UID>), [start], [finish], [duration_days], [cost]}]: a baseline (a copy of the project, as save_baseline) whose listed activities carry the given baseline values (planned, not started); activities not listed keep the project's current values; an activity not in the project is skipped with a warning`,
  `update_wbs: code, [new_code], [name], [parent] (move under this WBS code; "" = top level), [project]`,
  `add_code_type: name, [subject] (activity default, project, resource), [scope] (global default, project; activity codes only), [project], [max_length] (default 20, at most 60: a longer value is refused, never cut), [values [{code, [name], [parent]}]]`,
  `add_code_value: type, code, [name], [parent] (parent value code), [subject]`,
  `assign_code: type, value ("" removes), and activity (+[project]) | project | resource, [subject] (default from the target)`,
  `add_udf: name, [subject] (activity default, wbs, project, resource, assignment), [data_type] (text default, number, integer, cost, start_date, finish_date)`,
  `set_udf: udf, value (null or "" removes), and activity (+[project]) | wbs (+[project]) | project | resource`,
  `clear_udfs: [project], [subject] (activity, wbs, project, assignment, resource), [udf] (one UDF's label): removes every UDF value of the project's activities, WBS, assignments and the project itself in one step (resource UDF values, shared by every project, only with subject resource or a resource udf); an LOB plan's own UDFs (LOB Task, LOB Quantity, LOB Consumption, LOB Crew, Schedule Method = LOB (P6 clone)) stay unless udf names one`,
  `update_udf: udf (label), new_name, [subject] (activity default, wbs, project, resource, assignment)`,
  `set_notebook: [activity] | project, topic, text (text "" removes the topic; answer removed: true/false; the topic itself stays). activity (+[project]): its activity notebook; project alone: the project's notebook (P6's WBSMEMO on the project's root WBS node). topic default "Notes", created when missing, else reused`,
  `set_notebook, more targets: wbs (+[project]): that WBS element's notebook; topic "*" with text "": every notebook of the activity, WBS element or project, whatever its topic (one whose topic the file no longer lists too; answer removed: how many); in_baseline: true with project = a baseline's name: the baseline's notebooks`,
  `clear_notebooks: [project], [baselines] (default true): every notebook of the project in one step (activity notebooks; WBS and project notebooks, which hold the EPS notebooks P6 writes into an XER; any topic, one the file no longer lists too), and of its baselines; without project, of every project and baseline in the file. Answers how many went`,
  `add_cost_account: id, [name], [parent]; update_cost_account: id, [new_id], [name]`,
  `add_expense: activity, name, [account], [budgeted_cost], [actual_cost], [remaining_cost] (default budgeted - actual), [units], [price_per_unit], [vendor], [po_number], [description], [project]`,
  `update_expense: activity, name, then any add_expense field plus [new_name]; delete_expense: activity, name; delete_expenses: [project], [activity] (+[project]): every expense of the project, or of that one activity, in one step`,
  `add_step: activity, name, [weight] (default 1), [percent_complete], [completed], [description]; update_step: activity, name, [new_name], [weight], [percent_complete], [completed], [description]; delete_step: activity, name`,
  `set_estimates: activity, [min_days], [most_likely_days], [max_days], [distribution] (${Object.keys(DISTS).join(', ')}), or clear: true. Three-point remaining durations for monte_carlo (missing values default to the remaining duration)`,
  `save_baseline: [project], [name], [assign_as] (project, bl1, bl2, bl3). Copies the project as a baseline`,
  `assign_baseline: baseline (name), [as] (project default = the project baseline P6 stores; bl1, bl2, bl3 = primary/secondary/tertiary user baselines), [project]; "" baseline clears that slot`,
  `delete_baseline: baseline; restore_baseline: baseline (turns it back into a normal project); update_baseline: baseline, [new_name] (its Project ID, and its root WBS code), [name] (its project name, the root WBS name). A baseline's activities and WBS elements are renamed with update_activity / update_wbs and in_baseline: true, project = the baseline`,
  `add_eps / update_eps / delete_eps: id, [name], [parent], [new_id]; projects are put under an EPS with set_project eps`,
  `add_obs / update_obs / delete_obs: name, [parent], [new_name], [description] (update_obs; "" clears it); add_role / update_role / delete_role: id, [name], [parent], [new_id]`,
  `update_calendar: name, [new_name], [work_week] (days given replace those days), [holidays [dates]] (non-work), [work_exceptions {date: periods}], [remove_exceptions [dates]]`,
  `update_assignment: activity, resource, [units], [units_per_day], [remaining_units], [actual_units], [budgeted_cost], [actual_cost], [remaining_cost] (kept as entered), [curve] (resource curve name; "" = linear), [project]`,
  `update_resource: id, [new_id] (a new Resource ID), [name], [max_units_per_day] or [max_units_per_hour] (Max Units / Time on every rate row of the resource, read by level_resources and optimize_schedule)`,
  `delete_resource: id, [clear_references] (default false: refused while an assignment, in any project or baseline, or an activity's primary resource points at it; true: those assignments are removed and the primary resources cleared). Its rates, resource codes, roles and UDF values go with it; its child resources move up to its parent`,
  `regenerate_guids: [project], [dictionaries] (default true: also the GUIDs of the file's shared resources, calendars, codes, OBS, roles...), [new_proj_id] or [keep_proj_id]: every GUID of the project and its baselines (project, WBS, activities, assignments, ...) replaced by a fresh one, template GUIDs cleared; the project also gets a new internal number (the next free one unless new_proj_id; keep_proj_id: true keeps it), every reference following`,
  `clear_authors: [project], [dictionaries] (default true): clears the user fields P6 writes (create_user, update_user, add_by_name, user_id, ts_approve_user_id, checkout_user_id) on the project's rows (and the shared dictionaries'), and with dictionaries the exporting user and database named in the file's header (set to P6's defaults admin / dbxDatabaseNoName)`,
  `update_code_type: name, new_name, [subject] (activity default, project, resource), [project] (picks the project's own code type when several share the name)`,
  `update_code_value: type, code (value code or dotted path), [new_code], [name], [subject] (activity default, project, resource), [project] (picks the project's own code type when several share the name)`,
  `delete_code_value: type, code, [subject], [project]: removes the value, its child values and every assignment of them (TASKACTV, PROJPCAT, RSRCRCAT)`,
].join('\n');

const CODE_SUBJECTS = {
  activity: { type: 'ACTVTYPE', tid: 'actv_code_type_id', tname: 'actv_code_type', tlen: 'actv_short_len', val: 'ACTVCODE', vid: 'actv_code_id', vparent: 'parent_actv_code_id', vshort: 'short_name', vname: 'actv_code_name', link: 'TASKACTV', fk: 'task_id' },
  project: { type: 'PCATTYPE', tid: 'proj_catg_type_id', tname: 'proj_catg_type', tlen: 'proj_catg_short_len', val: 'PCATVAL', vid: 'proj_catg_id', vparent: 'parent_proj_catg_id', vshort: 'proj_catg_short_name', vname: 'proj_catg_name', link: 'PROJPCAT', fk: 'proj_id' },
  resource: { type: 'RCATTYPE', tid: 'rsrc_catg_type_id', tname: 'rsrc_catg_type', tlen: 'rsrc_catg_short_len', val: 'RCATVAL', vid: 'rsrc_catg_id', vparent: 'parent_rsrc_catg_id', vshort: 'rsrc_catg_short_name', vname: 'rsrc_catg_name', link: 'RSRCRCAT', fk: 'rsrc_id' },
} as const;
const UDF_SUBJECT: Record<string, string> = { activity: 'TASK', wbs: 'PROJWBS', project: 'PROJECT', resource: 'RSRC', assignment: 'TASKRSRC' };
const UDF_TYPE: Record<string, string> = { text: 'FT_TEXT', number: 'FT_FLOAT_2_DECIMALS', integer: 'FT_INT', cost: 'FT_MONEY', start_date: 'FT_START_DATE', finish_date: 'FT_END_DATE', date: 'FT_START_DATE' };
const TREES = {
  eps: { table: 'EPS', id: 'eps_id', parent: 'parent_eps_id', key: 'eps_short_name', name: 'eps_name', fields: ['eps_id', 'parent_eps_id', 'eps_short_name', 'eps_name', 'seq_num'] },
  obs: { table: 'OBS', id: 'obs_id', parent: 'parent_obs_id', key: 'obs_name', name: 'obs_name', fields: ['obs_id', 'parent_obs_id', 'seq_num', 'obs_name', 'obs_descr'] },
  role: { table: 'ROLES', id: 'role_id', parent: 'parent_role_id', key: 'role_short_name', name: 'role_name', fields: ['role_id', 'parent_role_id', 'seq_num', 'role_name', 'role_short_name'] },
} as const;
/** P6 holds at most 60 characters in a code value (a code type's max length can be 1-60). */
const CODE_MAX = 60;
const PROJCOST_FIELDS = ['cost_item_id', 'acct_id', 'pobs_id', 'cost_type_id', 'proj_id', 'task_id', 'cost_name', 'po_number', 'vendor_name', 'act_cost', 'cost_per_qty', 'remain_cost', 'target_cost', 'cost_load_type', 'auto_compute_act_flag', 'target_qty', 'qty_name', 'cost_descr', 'contract_manager_import'];

const ensure = (db: Db, name: string, fields: readonly string[]) => { const T = table(db, name); for (const f of fields) addField(T, f); return T; };
const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();
const subtree = (all: Row[], id: string, idF: string, parentF: string) => {
  const s = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const r of all) if (s.has(r[parentF]) && !s.has(r[idF])) { s.add(r[idF]); grew = true; } }
  return s;
};
/** P6 writes a resource's or role's ID and name again on the rows that point at it (RSRCROLE): kept the same. */
const copies = (db: Db, own: string, id: string, key: string, name: string, v: Row) => {
  for (const t of Object.values(db.tables)) {
    const F = realOf(t.fields), fs = [key, name].filter((f) => F.includes(f));
    if (t.name !== own && F.includes(id) && fs.length) for (const x of pick(t.rows, (y) => y[id] === v[id])) for (const f of fs) x[f] = v[f];
  }
};
const freshGuid = () => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64').slice(0, 22); // P6's form
const AUTHOR_FIELDS = new Set(['create_user', 'update_user', 'add_by_name', 'user_id', 'ts_approve_user_id', 'checkout_user_id']);
/** Per table, the rows of these projects, and with dictionaries those of the file's shared objects (no project). */
function scopedRows(db: Db, projIds: Set<string>, dictionaries: boolean): [string, Row[]][] {
  const tasks = new Set(realOf(rows(db, 'TASK')).filter((t) => projIds.has(t.proj_id)).map((t) => t.task_id));
  return Object.values(db.tables).map((t) => {
    const F = realOf(t.fields);
    const mine = t.name === 'PROJECT' ? (r: Row) => projIds.has(r.proj_id) : F.includes('proj_id') ? (r: Row) => projIds.has(r.proj_id) || (dictionaries && !r.proj_id) : F.includes('task_id') ? (r: Row) => tasks.has(r.task_id) : () => dictionaries;
    return [t.name, pick(t.rows, mine)] as [string, Row[]];
  });
}
const memoHtml = (t: string) => `<HTML><BODY>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</BODY></HTML>`;

/** Apply one of the extra operations; undefined when the name is not one of them. */
export function applyExtra(db: Db, op: Op, h: OpHelpers): unknown {
  const { fail, str, num, date, hpd } = h;
  const codeSubject = (v: unknown, dflt: keyof typeof CODE_SUBJECTS = 'activity') => {
    const k = (v == null || v === '' ? dflt : lc(v)) as keyof typeof CODE_SUBJECTS;
    return CODE_SUBJECTS[k] ? CODE_SUBJECTS[k] : fail(`subject must be ${Object.keys(CODE_SUBJECTS).join(', ')}.`);
  };
  /** The code type of this name; when several share it (project code types of different projects), the one of projId,
   *  and with strict, refused unless that tells them apart. */
  const codeType = (S: (typeof CODE_SUBJECTS)[keyof typeof CODE_SUBJECTS], name: unknown, projId?: string, strict = false) => {
    let hits = pick(rows(db, S.type), (t) => lc(t[S.tname]) === lc(name));
    if (hits.length > 1 && projId) hits = hits.filter((t) => t.proj_id === projId).length ? hits.filter((t) => t.proj_id === projId) : hits;
    if (hits.length > 1 && strict) fail(`Several code types are named "${name}"; add "project" to say whose.`);
    return hits[0] ?? fail(`No code type "${name}" (add it with {"op":"add_code_type"}).`);
  };
  const codeValue = (S: (typeof CODE_SUBJECTS)[keyof typeof CODE_SUBJECTS], type: Row, code: unknown) => {
    // read only: the real rows (a search through the journal's view, once per assign_code, was slow)
    const tid = type[S.tid], c = lc(code);
    const vals = realOf(rows(db, S.val)).filter((v) => v[S.tid] === tid);
    const byId = new Map(vals.map((v) => [v[S.vid], v]));
    const path = (v: Row) => { const out: string[] = []; for (let x: Row | undefined = v, n = 0; x && n < 50; x = byId.get(x[S.vparent]), n++) out.unshift(x[S.vshort]); return out.join('.').toLowerCase(); };
    const hits = vals.filter((v) => lc(v[S.vshort]) === c || path(v) === c);
    if (hits.length > 1) fail(`Code value "${code}" is ambiguous in ${type[S.tname]}; use the full path (e.g. ${path(hits[0])}).`);
    return hits[0] ?? fail(`No value "${code}" in code type ${type[S.tname]}.`);
  };
  const addCodeValue = (S: (typeof CODE_SUBJECTS)[keyof typeof CODE_SUBJECTS], type: Row, v: { code?: unknown; name?: unknown; parent?: unknown }) => {
    const code = str(v.code, 'code');
    const len = Math.min(CODE_MAX, Number(type[S.tlen]) || CODE_MAX);
    if (code.length > len) fail(`Code value "${code}" is ${code.length} characters; code type "${type[S.tname]}" allows ${len} (its max length${len < CODE_MAX ? `; add_code_type max_length can be up to ${CODE_MAX}` : ', the most P6 holds'}). Nothing was cut: give a shorter value.`);
    const parent = v.parent != null && v.parent !== '' ? codeValue(S, type, v.parent) : null;
    if (rows(db, S.val).some((x) => x[S.tid] === type[S.tid] && x[S.vparent] === (parent?.[S.vid] ?? '') && lc(x[S.vshort]) === lc(code))) fail(`Code value "${code}" already exists there.`);
    const T = ensure(db, S.val, [S.vid, S.vparent, S.tid, S.vname, S.vshort, 'seq_num']);
    T.rows.push({ [S.vid]: String(nextId(db, S.val)), [S.vparent]: parent?.[S.vid] ?? '', [S.tid]: type[S.tid], [S.vname]: typeof v.name === 'string' ? v.name : code, [S.vshort]: code, seq_num: String(T.rows.length + 1) });
    return code;
  };
  const target = (o: Op): { subject: string; row: Row; fk: string; projId: string } => {
    if (o.activity != null) { const t = h.activity(o.activity, o.project); return { subject: 'activity', row: t, fk: t.task_id, projId: t.proj_id }; }
    if (o.wbs != null) { const p = h.projectFor(o.project, o.wbs); const w = h.wbsOf(p, o.wbs); return { subject: 'wbs', row: w, fk: w.wbs_id, projId: p.proj_id }; }
    if (o.resource != null) { const r = h.resource(o.resource); return { subject: 'resource', row: r, fk: r.rsrc_id, projId: '' }; }
    if (o.project != null) { const p = h.project(o.project); return { subject: 'project', row: p, fk: p.proj_id, projId: p.proj_id }; }
    return fail('Say what to set it on: activity, wbs, project or resource.');
  };
  const expense = (o: Op) => {
    const t = h.activity(o.activity, o.project);
    const name = str(o.name, 'name');
    const tid = t.task_id, key = lc(name);
    const hits = pick(rows(db, 'PROJCOST'), (c) => c.task_id === tid && lc(c.cost_name) === key); // the real rows searched: a view's scan per op was slow
    if (hits.length > 1) fail(`Activity ${t.task_code} has several expenses named "${name}".`);
    return { t, c: hits[0] ?? fail(`Activity ${t.task_code} has no expense "${name}".`) };
  };
  const setExpense = (c: Row, o: Op) => {
    if (o.account !== undefined) c.acct_id = o.account ? (rows(db, 'ACCOUNT').find((a) => lc(a.acct_short_name) === lc(o.account))?.acct_id ?? fail(`No cost account "${o.account}" (add it with {"op":"add_cost_account"}).`)) : '';
    if (o.units != null) c.target_qty = p6num(num(o.units, 'units'));
    if (o.price_per_unit != null) c.cost_per_qty = p6num(num(o.price_per_unit, 'price_per_unit'));
    if (o.budgeted_cost != null) c.target_cost = p6num(num(o.budgeted_cost, 'budgeted_cost'));
    else if (o.units != null || o.price_per_unit != null) c.target_cost = p6num((Number(c.target_qty) || 0) * (Number(c.cost_per_qty) || 0));
    if (o.actual_cost != null) c.act_cost = p6num(num(o.actual_cost, 'actual_cost'));
    if (o.remaining_cost != null) c.remain_cost = p6num(num(o.remaining_cost, 'remaining_cost'));
    else if (o.budgeted_cost != null || o.actual_cost != null || o.units != null || o.price_per_unit != null) c.remain_cost = p6num(Math.max(0, (Number(c.target_cost) || 0) - (Number(c.act_cost) || 0)));
    for (const [k, f] of [['vendor', 'vendor_name'], ['po_number', 'po_number'], ['description', 'cost_descr']] as const) if (o[k] != null) c[f] = String(o[k]);
  };
  const step = (o: Op) => {
    const t = h.activity(o.activity, o.project);
    const name = str(o.name, 'name');
    return { t, s: rows(db, 'TASKPROC').find((s) => s.task_id === t.task_id && lc(s.proc_name) === lc(name)) ?? fail(`Activity ${t.task_code} has no step "${name}".`) };
  };
  const setStep = (s: Row, o: Op) => {
    if (o.weight != null) { const w = num(o.weight, 'weight'); if (w < 0) fail('weight cannot be negative.'); s.proc_wt = p6num(w); }
    if (o.percent_complete != null) { const p = num(o.percent_complete, 'percent_complete'); if (p < 0 || p > 100) fail('percent_complete must be 0-100.'); s.complete_pct = p6num(p); s.complete_flag = p >= 100 ? 'Y' : 'N'; }
    if (o.completed != null) { s.complete_flag = o.completed ? 'Y' : 'N'; if (o.completed) s.complete_pct = '100'; }
    if (o.description != null) s.proc_descr = String(o.description);
  };
  const baseline = (name: unknown) => rows(db, 'PROJECT').find((p) => p._baseline_of && lc(p.proj_short_name) === lc(name)) ?? fail(`No baseline "${name}". Baselines: ${rows(db, 'PROJECT').filter((p) => p._baseline_of).map((p) => p.proj_short_name).join(', ') || 'none yet (save_baseline)'}.`);
  const SLOT: Record<string, string> = { project: 'sum_base_proj_id', bl1: '_bl1', bl2: '_bl2', bl3: '_bl3', primary: '_bl1', secondary: '_bl2', tertiary: '_bl3' };
  const slot = (v: unknown) => SLOT[lc(v ?? 'project')] ?? fail('as / assign_as must be project, bl1, bl2 or bl3.');
  const assignSlot = (p: Row, f: string, bid: string) => { if (f === 'sum_base_proj_id') { if (bid) assignBaseline(db, p.proj_id, bid); else p.sum_base_proj_id = ''; } else { addField(table(db, 'PROJECT'), f); p[f] = bid; } };
  /** A baseline activity's budgeted cost: its assignments' budgets scaled to it, else one expense line. */
  const setBaselineCost = (b: Row, cost: number) => {
    const A = rows(db, 'TASKRSRC').filter((a) => a.task_id === b.task_id), E = rows(db, 'PROJCOST').filter((c) => c.task_id === b.task_id);
    const total = [...A, ...E].reduce((s, r) => s + (Number(r.target_cost) || 0), 0);
    if (total > 0) { for (const r of [...A, ...E]) r.target_cost = r.remain_cost = p6num(((Number(r.target_cost) || 0) * cost) / total); return; }
    for (const r of [...A, ...E]) r.target_cost = r.remain_cost = '0';
    const T = ensure(db, 'PROJCOST', PROJCOST_FIELDS);
    T.rows.push({ ...Object.fromEntries(PROJCOST_FIELDS.map((k) => [k, ''])), cost_item_id: String(nextId(db, 'PROJCOST')), proj_id: b.proj_id, task_id: b.task_id, cost_name: 'Baseline cost', act_cost: '0', cost_per_qty: '0', remain_cost: p6num(cost), target_cost: p6num(cost), cost_load_type: 'CL_Uniform', auto_compute_act_flag: 'N', target_qty: '0', contract_manager_import: 'N' });
  };
  const tree = (kind: keyof typeof TREES) => {
    const T = TREES[kind];
    if (kind === 'eps') ensureEps(db);
    const find = (v: unknown) => rows(db, T.table).find((r) => lc(r[T.key]) === lc(v)) ?? fail(`No ${kind.toUpperCase()} "${v}".`);
    return { T, find };
  };

  switch (op.op) {
    case 'add_resource_curve': {
      const name = str(op.name, 'name');
      if (rows(db, 'RSRCCURVDATA').some((c) => lc(c.curv_name) === lc(name))) fail(`Resource curve "${name}" already exists.`);
      const v = Array.isArray(op.values) && op.values.length === 21 ? op.values.map((x, i) => num(x, `values[${i}]`)) : fail('"values" must be a list of 21 percentages (P6 resource curve: the start, then each 5% of the time).');
      if (v.some((x) => x < 0)) fail('Curve percentages cannot be negative.');
      const sum = v.reduce((a, x) => a + x, 0);
      if (Math.abs(sum - 100) > 0.1) fail(`The curve's percentages total ${p6num(sum)}; P6 needs them to total 100.`);
      const T = ensure(db, 'RSRCCURVDATA', ['curv_id', 'curv_name', 'default_flag', ...v.map((_, i) => `pct_usage_${i}`)]);
      const id = String(nextId(db, 'RSRCCURVDATA'));
      T.rows.push({ curv_id: id, curv_name: name, default_flag: 'N', ...Object.fromEntries(v.map((x, i) => [`pct_usage_${i}`, p6num(x)])) });
      return { resource_curve: name };
    }
    case 'build_baseline': {
      const p = h.project(op.project);
      const name = typeof op.name === 'string' && op.name.trim() ? op.name.trim() : undefined;
      if (name && rows(db, 'PROJECT').some((x) => lc(x.proj_short_name) === lc(name))) fail(`A project or baseline "${name}" already exists.`);
      const list = Array.isArray(op.activities) ? op.activities as Record<string, unknown>[] : fail('"activities" must be a list of {activity, start, finish, duration_days, cost}.');
      const bid = saveBaseline(db, p.proj_id, name);
      const byCode = new Map(rows(db, 'TASK').filter((t) => t.proj_id === bid).map((t) => [t.task_code, t]));
      let set = 0;
      for (const [i, x] of list.entries()) {
        let cur: Row;
        try { cur = h.activity(x?.activity ?? x?.id, p.proj_short_name); } catch (e) { h.warn(`build_baseline: activities[${i}] skipped: ${(e as Error).message}`); continue; }
        const b = byCode.get(cur.task_code)!;
        // a baseline value is a plan: the baseline activity is not started, with these dates
        Object.assign(b, { act_start_date: '', act_end_date: '', status_code: 'TK_NotStart', phys_complete_pct: '0' });
        if (x.start != null) b.target_start_date = b.early_start_date = b.restart_date = date(x.start, `activities[${i}].start`);
        if (x.finish != null) b.target_end_date = b.early_end_date = b.reend_date = date(x.finish, `activities[${i}].finish`);
        if (x.duration_days != null) b.target_drtn_hr_cnt = b.remain_drtn_hr_cnt = p6num(num(x.duration_days, `activities[${i}].duration_days`) * h.dayHours(b));
        if (x.cost != null) setBaselineCost(b, num(x.cost, `activities[${i}].cost`));
        set++;
      }
      const as = op.assign_as === undefined ? 'project' : op.assign_as;
      if (as) assignSlot(rows(db, 'PROJECT').find((x) => x.proj_id === p.proj_id)!, slot(as), bid);
      return { baseline: rows(db, 'PROJECT').find((x) => x.proj_id === bid)!.proj_short_name, of: p.proj_short_name, activities_set: set, assigned_as: as || null };
    }
    case 'update_wbs': {
      const p = h.projectFor(op.project, op.code);
      const w = h.wbsOf(p, str(op.code, 'code'));
      if (op.parent !== undefined) {
        const parent = h.wbsOf(p, op.parent === '' ? null : op.parent);
        if (subtree(rows(db, 'PROJWBS'), w.wbs_id, 'wbs_id', 'parent_wbs_id').has(parent.wbs_id)) fail(`Cannot move WBS ${w.wbs_short_name} under itself or one of its children.`);
        w.parent_wbs_id = parent.wbs_id;
        dropIndexes(realOf(rows(db, 'PROJWBS')));
      }
      if (op.new_code != null) {
        const code = str(op.new_code, 'new_code');
        if (rows(db, 'PROJWBS').some((x) => x.wbs_id !== w.wbs_id && x.proj_id === p.proj_id && x.parent_wbs_id === w.parent_wbs_id && lc(x.wbs_short_name) === lc(code))) fail(`WBS "${code}" already exists there.`);
        w.wbs_short_name = code;
        dropIndexes(realOf(rows(db, 'PROJWBS')));
      }
      if (op.name != null) w.wbs_name = str(op.name, 'name');
      return { wbs: w.wbs_short_name };
    }
    case 'add_code_type': {
      const S = codeSubject(op.subject);
      const name = str(op.name, 'name');
      if (rows(db, S.type).some((t) => lc(t[S.tname]) === lc(name))) fail(`Code type "${name}" already exists.`);
      if (op.max_length != null && num(op.max_length, 'max_length') > CODE_MAX) fail(`max_length ${op.max_length} is more than P6 allows for a code value (${CODE_MAX}).`);
      const T = ensure(db, S.type, [S.tid, S.tlen, 'seq_num', S.tname, ...(S.type === 'ACTVTYPE' ? ['proj_id', 'wbs_id', 'actv_code_type_scope', 'super_flag'] : [])]);
      const row: Row = { [S.tid]: String(nextId(db, S.type)), [S.tlen]: String(op.max_length != null ? Math.max(1, Math.floor(num(op.max_length, 'max_length'))) : 20), seq_num: String(T.rows.length + 1), [S.tname]: name };
      if (S.type === 'ACTVTYPE') {
        const proj = lc(op.scope) === 'project';
        if (op.scope != null && !['project', 'global'].includes(lc(op.scope))) fail('scope must be global or project.');
        Object.assign(row, { proj_id: proj ? h.project(op.project).proj_id : '', wbs_id: '', actv_code_type_scope: proj ? 'AS_Project' : 'AS_Global', super_flag: 'N' });
      }
      T.rows.push(row);
      const values = Array.isArray(op.values) ? op.values.map((v) => addCodeValue(S, row, (v ?? {}) as { code?: unknown })) : [];
      return { code_type: name, values };
    }
    case 'add_code_value': {
      const S = codeSubject(op.subject);
      return { code_value: addCodeValue(S, codeType(S, str(op.type, 'type')), op as { code?: unknown }) };
    }
    case 'assign_code': {
      const tg = target(op);
      if (tg.subject === 'wbs') fail('Codes are assigned to activities, projects or resources.');
      const S = codeSubject(op.subject, tg.subject as keyof typeof CODE_SUBJECTS);
      const type = codeType(S, str(op.type, 'type'), tg.projId);
      const L = ensure(db, S.link, [S.fk, S.tid, S.vid, ...(S.link === 'TASKACTV' ? ['proj_id'] : [])]);
      const fk = tg.fk, tid = type[S.tid]; // plain values: a view's field read per row is slow
      const valsOfType = new Set(realOf(rows(db, S.val)).filter((v) => v[S.tid] === tid).map((v) => v[S.vid]));
      const LR = realOf(L.rows); // the scan only when the index says the object has an assignment (a new activity has none)
      if (rowIndex(LR, `fk:${S.fk}`, (a) => a[S.fk]).get(fk)?.length) removeWhere(L.rows, (a) => a[S.fk] === fk && (a[S.tid] === tid || valsOfType.has(a[S.vid])));
      if (op.value == null || op.value === '') return { removed: type[S.tname] };
      const v = codeValue(S, type, op.value);
      L.rows.push({ [S.fk]: tg.fk, [S.tid]: type[S.tid], [S.vid]: v[S.vid], ...(S.link === 'TASKACTV' ? { proj_id: tg.projId } : {}) });
      return { assigned: `${type[S.tname]} = ${v[S.vshort]}` };
    }
    case 'add_udf': {
      const name = str(op.name, 'name');
      const tbl = UDF_SUBJECT[lc(op.subject ?? 'activity')] ?? fail(`subject must be ${Object.keys(UDF_SUBJECT).join(', ')}.`);
      const dt = UDF_TYPE[lc(op.data_type ?? 'text')] ?? fail(`data_type must be ${Object.keys(UDF_TYPE).join(', ')}.`);
      if (rows(db, 'UDFTYPE').some((u) => u.table_name === tbl && lc(u.udf_type_label) === lc(name))) fail(`UDF "${name}" already exists for that subject.`);
      const T = ensure(db, 'UDFTYPE', ['udf_type_id', 'table_name', 'udf_type_name', 'udf_type_label', 'logical_data_type', 'super_flag', 'indicator_expression', 'summary_indicator_expression', 'export_flag']);
      const id = String(nextId(db, 'UDFTYPE'));
      T.rows.push({ udf_type_id: id, table_name: tbl, udf_type_name: `user_field_${id}`, udf_type_label: name, logical_data_type: dt, super_flag: 'N', indicator_expression: '', summary_indicator_expression: '', export_flag: 'Y' });
      return { udf: name, data_type: dt };
    }
    case 'set_udf': {
      const tg = target(op);
      const tbl = UDF_SUBJECT[tg.subject];
      const name = str(op.udf, 'udf');
      const u = rows(db, 'UDFTYPE').find((x) => x.table_name === tbl && lc(x.udf_type_label) === lc(name)) ?? fail(`No ${tg.subject} UDF "${name}" (add it with {"op":"add_udf"}).`);
      const V = ensure(db, 'UDFVALUE', ['udf_type_id', 'fk_id', 'proj_id', 'udf_date', 'udf_number', 'udf_text', 'udf_code_id']);
      const uid = u.udf_type_id, fk = tg.fk;
      const VR = realOf(V.rows); // the scan only when the index says the object has a value of this UDF
      if (rowIndex(VR, 'udf:fk', (v) => v.fk_id).get(fk)?.some((i) => VR[i].udf_type_id === uid)) removeWhere(V.rows, (v) => v.udf_type_id === uid && v.fk_id === fk);
      if (op.value == null || op.value === '') return { cleared: name };
      const r: Row = { udf_type_id: u.udf_type_id, fk_id: tg.fk, proj_id: tg.projId, udf_date: '', udf_number: '', udf_text: '', udf_code_id: '' };
      if (/DATE/.test(u.logical_data_type)) r.udf_date = date(op.value, 'value');
      else if (u.logical_data_type === 'FT_TEXT') r.udf_text = String(op.value);
      else { const n = num(op.value, 'value'); r.udf_number = p6num(u.logical_data_type === 'FT_INT' ? Math.round(n) : n); }
      V.rows.push(r);
      return { udf: name, value: op.value };
    }
    case 'set_notebook': {
      const all = op.topic === '*';
      const topic = typeof op.topic === 'string' && op.topic.trim() ? op.topic.trim() : 'Notes';
      const MT = ensure(db, 'MEMOTYPE', ['memo_type_id', 'seq_num', 'eps_flag', 'proj_flag', 'wbs_flag', 'task_flag', 'memo_type']);
      // one topic per name: an existing one (any case) is reused and made available where it is now used
      let mt = all ? undefined : MT.rows.find((m) => lc(m.memo_type) === lc(topic));
      const text = typeof op.text === 'string' ? op.text : op.text == null ? '' : fail('"text" must be text.');
      if (all && text) fail('topic "*" only removes (text ""): name the topic to write a notebook.');
      if (op.activity == null || op.activity === '') {
        // a WBS element's notebook, or the project's: a WBSMEMO on the element (the project's root WBS node for the
        // project), under a topic for projects / WBS
        const p = h.project(op.project);
        const node = op.wbs != null && op.wbs !== '' ? h.wbsOf(p, op.wbs) : rows(db, 'PROJWBS').find((w) => w.proj_id === p.proj_id && w.proj_node_flag === 'Y') ?? fail(`Project ${p.proj_short_name} has no root WBS node to hold its notebook.`);
        const what = op.wbs != null && op.wbs !== '' ? { wbs: node.wbs_short_name, project: p.proj_short_name } : { project: p.proj_short_name };
        const WM = ensure(db, 'WBSMEMO', ['wbs_memo_id', 'proj_id', 'memo_type_id', 'wbs_id', 'wbs_memo']);
        const wid = node.wbs_id;
        // "" removes that topic's memo, if there is one ("*": every memo of the node); the topic (MEMOTYPE) stays
        if (!text) { const id = mt?.memo_type_id; const n = all || mt ? removeWhere(WM.rows, (m) => m.wbs_id === wid && (all || m.memo_type_id === id)) : 0; return { cleared: all ? 'every topic' : topic, ...what, removed: all ? n : n > 0 }; }
        if (!mt) { mt = { memo_type_id: String(nextId(db, 'MEMOTYPE')), seq_num: String(MT.rows.length), eps_flag: 'N', proj_flag: 'Y', wbs_flag: 'Y', task_flag: 'N', memo_type: topic }; MT.rows.push(mt); }
        else { if (mt.proj_flag !== 'Y') mt.proj_flag = 'Y'; if (mt.wbs_flag !== 'Y') mt.wbs_flag = 'Y'; }
        const mid = mt.memo_type_id;
        const cur = pick(WM.rows, (m) => m.wbs_id === wid && m.memo_type_id === mid, 1)[0];
        if (cur) cur.wbs_memo = memoHtml(text);
        else WM.rows.push({ wbs_memo_id: String(nextId(db, 'WBSMEMO')), proj_id: p.proj_id, memo_type_id: mid, wbs_id: wid, wbs_memo: memoHtml(text) });
        return { notebook: `${p.proj_short_name}${what.wbs ? ` / ${what.wbs}` : ''} / ${topic}`, ...what };
      }
      const t = h.activity(op.activity, op.project);
      const TM = ensure(db, 'TASKMEMO', ['memo_id', 'task_id', 'memo_type_id', 'proj_id', 'task_memo']);
      if (!text) { const id = mt?.memo_type_id, tid = t.task_id; const n = all || mt ? removeWhere(TM.rows, (m) => m.task_id === tid && (all || m.memo_type_id === id)) : 0; return { cleared: all ? 'every topic' : topic, removed: all ? n : n > 0 }; }
      if (!mt) { mt = { memo_type_id: String(nextId(db, 'MEMOTYPE')), seq_num: String(MT.rows.length), eps_flag: 'N', proj_flag: 'N', wbs_flag: 'N', task_flag: 'Y', memo_type: topic }; MT.rows.push(mt); }
      else if (mt.task_flag !== 'Y') mt.task_flag = 'Y';
      const tid = t.task_id, mid = mt.memo_type_id;
      const cur = pick(TM.rows, (m) => m.task_id === tid && m.memo_type_id === mid, 1)[0];
      if (cur) cur.task_memo = memoHtml(text);
      else TM.rows.push({ memo_id: String(nextId(db, 'TASKMEMO')), task_id: t.task_id, memo_type_id: mt.memo_type_id, proj_id: t.proj_id, task_memo: memoHtml(text) });
      return { notebook: `${t.task_code} / ${topic}` };
    }
    case 'clear_notebooks': {
      // every notebook a project carries: its activities' (TASKMEMO), its WBS elements' and its own (WBSMEMO: P6 writes
      // the EPS notebooks of an XER there too), any topic, and its baselines'
      const ids = new Set<string>();
      if (op.project != null && op.project !== '') {
        const p = h.project(op.project);
        ids.add(p.proj_id);
        if (op.baselines !== false) for (const b of rows(db, 'PROJECT')) if (b._baseline_of === p.proj_id) ids.add(b.proj_id);
      } else for (const p of rows(db, 'PROJECT')) if (op.baselines !== false || !p._baseline_of) ids.add(p.proj_id);
      const taskProj = new Map(rows(db, 'TASK').map((t) => [t.task_id, t.proj_id]));
      const wbsProj = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w.proj_id]));
      const a = db.tables.TASKMEMO ? removeWhere(rows(db, 'TASKMEMO'), (m) => ids.has(m.proj_id || taskProj.get(m.task_id) || '')) : 0;
      const w = db.tables.WBSMEMO ? removeWhere(rows(db, 'WBSMEMO'), (m) => ids.has(m.proj_id || wbsProj.get(m.wbs_id) || '')) : 0;
      return { activity_notebooks: a, wbs_and_project_notebooks: w, projects: ids.size };
    }
    case 'add_cost_account': {
      const id = str(op.id, 'id');
      if (rows(db, 'ACCOUNT').some((a) => lc(a.acct_short_name) === lc(id))) fail(`Cost account "${id}" already exists.`);
      const parent = op.parent ? rows(db, 'ACCOUNT').find((a) => lc(a.acct_short_name) === lc(op.parent)) ?? fail(`No cost account "${op.parent}".`) : null;
      const T = ensure(db, 'ACCOUNT', ['acct_id', 'parent_acct_id', 'acct_seq_num', 'acct_name', 'acct_short_name', 'acct_descr']);
      T.rows.push({ acct_id: String(nextId(db, 'ACCOUNT')), parent_acct_id: parent?.acct_id ?? '', acct_seq_num: String(T.rows.length + 1), acct_name: typeof op.name === 'string' ? op.name : id, acct_short_name: id, acct_descr: '' });
      return { cost_account: id };
    }
    case 'update_cost_account': {
      const a = rows(db, 'ACCOUNT').find((x) => lc(x.acct_short_name) === lc(op.id)) ?? fail(`No cost account "${op.id}".`);
      if (op.new_id != null) { const k = str(op.new_id, 'new_id'); if (rows(db, 'ACCOUNT').some((x) => x.acct_id !== a.acct_id && lc(x.acct_short_name) === lc(k))) fail(`Cost account "${k}" already exists.`); a.acct_short_name = k; }
      if (op.name != null) a.acct_name = str(op.name, 'name');
      return { cost_account: a.acct_short_name };
    }
    case 'add_expense': {
      const t = h.activity(op.activity, op.project);
      const name = str(op.name, 'name');
      if (rows(db, 'PROJCOST').some((c) => c.task_id === t.task_id && lc(c.cost_name) === lc(name))) fail(`Activity ${t.task_code} already has an expense "${name}".`);
      const T = ensure(db, 'PROJCOST', PROJCOST_FIELDS);
      const c: Row = { cost_item_id: String(nextId(db, 'PROJCOST')), acct_id: '', pobs_id: '', cost_type_id: '', proj_id: t.proj_id, task_id: t.task_id, cost_name: name, po_number: '', vendor_name: '', act_cost: '0', cost_per_qty: '0', remain_cost: '0', target_cost: '0', cost_load_type: 'CL_Uniform', auto_compute_act_flag: 'N', target_qty: '0', qty_name: '', cost_descr: '', contract_manager_import: 'N' };
      T.rows.push(c);
      setExpense(c, op);
      return { expense: `${t.task_code} / ${name}`, budgeted_cost: Number(c.target_cost) };
    }
    case 'update_expense': {
      const { t, c } = expense(op);
      if (op.new_name != null) c.cost_name = str(op.new_name, 'new_name');
      setExpense(c, op);
      return { expense: `${t.task_code} / ${c.cost_name}` };
    }
    case 'delete_expense': { const { t, c } = expense(op); const id = c.cost_item_id; removeWhere(rows(db, 'PROJCOST'), (x) => x.cost_item_id === id); return { deleted: `${t.task_code} / ${c.cost_name}` }; }
    case 'add_step': {
      const t = h.activity(op.activity, op.project);
      const name = str(op.name, 'name');
      if (rows(db, 'TASKPROC').some((s) => s.task_id === t.task_id && lc(s.proc_name) === lc(name))) fail(`Activity ${t.task_code} already has a step "${name}".`);
      const T = ensure(db, 'TASKPROC', STEP_FIELDS);
      const seq = Math.max(0, ...T.rows.filter((s) => s.task_id === t.task_id).map((s) => Number(s.seq_num) || 0)) + 10;
      const s: Row = { proc_id: String(Math.max(0, ...T.rows.map((r) => Number(r.proc_id) || 0)) + 1), task_id: t.task_id, proj_id: t.proj_id, seq_num: String(seq), proc_name: name, complete_flag: 'N', proc_wt: '1', complete_pct: '0', proc_descr: '' };
      T.rows.push(s);
      setStep(s, op);
      syncFromSteps(db, t.task_id);
      return { step: `${t.task_code} / ${name}` };
    }
    case 'update_step': {
      const { t, s } = step(op);
      if (op.new_name != null) s.proc_name = str(op.new_name, 'new_name');
      setStep(s, op);
      syncFromSteps(db, t.task_id);
      return { step: `${t.task_code} / ${s.proc_name}` };
    }
    case 'delete_step': { const { t, s } = step(op); const id = s.proc_id; removeWhere(rows(db, 'TASKPROC'), (x) => x.proc_id === id); syncFromSteps(db, t.task_id); return { deleted: `${t.task_code} / ${s.proc_name}` }; }
    case 'set_estimates': {
      const t = h.activity(op.activity, op.project);
      if (op.clear === true) { setEstimate(db, t.task_id, null); return { cleared: t.task_code }; }
      const d = (k: string) => (op[k] != null ? num(op[k], k) * h.dayHours(t) : undefined);
      const dist = op.distribution != null ? (DISTS[lc(op.distribution) as Dist] ? (lc(op.distribution) as Dist) : fail(`distribution must be ${Object.keys(DISTS).join(', ')}.`)) : undefined;
      const [min, ml, max] = [d('min_days'), d('most_likely_days'), d('max_days')];
      if (min != null && max != null && min > max) fail('min_days is more than max_days.');
      if (ml != null && ((min != null && ml < min) || (max != null && ml > max))) fail('most_likely_days must lie between min_days and max_days.');
      setEstimate(db, t.task_id, { min, ml, max, dist });
      return { estimates: t.task_code };
    }
    case 'save_baseline': {
      const p = h.project(op.project);
      const name = typeof op.name === 'string' && op.name.trim() ? op.name.trim() : undefined;
      if (name && rows(db, 'PROJECT').some((x) => lc(x.proj_short_name) === lc(name))) fail(`A project or baseline "${name}" already exists.`);
      const bid = saveBaseline(db, p.proj_id, name);
      const b = rows(db, 'PROJECT').find((x) => x.proj_id === bid)!;
      if (op.assign_as != null) assignSlot(rows(db, 'PROJECT').find((x) => x.proj_id === p.proj_id)!, slot(op.assign_as), bid);
      return { baseline: b.proj_short_name, of: p.proj_short_name, assigned_as: op.assign_as ?? null };
    }
    case 'assign_baseline': {
      const p = h.project(op.project);
      const f = slot(op.as);
      if (op.baseline == null || op.baseline === '') { assignSlot(p, f, ''); return { cleared: lc(op.as ?? 'project') }; }
      const b = baseline(op.baseline);
      if (b._baseline_of !== p.proj_id) fail(`Baseline "${b.proj_short_name}" belongs to another project.`);
      assignSlot(p, f, b.proj_id);
      return { assigned: b.proj_short_name, as: lc(op.as ?? 'project'), project: p.proj_short_name };
    }
    case 'delete_baseline': {
      const b = baseline(str(op.baseline, 'baseline'));
      for (const p of rows(db, 'PROJECT')) for (const f of ['_bl1', '_bl2', '_bl3']) if (p[f] === b.proj_id) p[f] = '';
      const name = b.proj_short_name;
      deleteBaseline(db, b.proj_id);
      return { deleted: name };
    }
    case 'update_baseline': {
      const b = baseline(str(op.baseline, 'baseline'));
      const old = b.proj_short_name;
      const root = rows(db, 'PROJWBS').find((w) => w.proj_id === b.proj_id && w.proj_node_flag === 'Y');
      if (op.new_name != null) {
        const n = str(op.new_name, 'new_name');
        if (rows(db, 'PROJECT').some((x) => x.proj_id !== b.proj_id && lc(x.proj_short_name) === lc(n))) fail(`A project or baseline "${n}" already exists.`);
        b.proj_short_name = n;
        if (root) root.wbs_short_name = n;
      }
      if (op.name != null && root) root.wbs_name = str(op.name, 'name');
      return { baseline: b.proj_short_name, was: old };
    }
    case 'restore_baseline': {
      const b = baseline(str(op.baseline, 'baseline'));
      const name = b.proj_short_name;
      for (const p of rows(db, 'PROJECT')) { if (p.sum_base_proj_id === b.proj_id) p.sum_base_proj_id = ''; for (const f of ['_bl1', '_bl2', '_bl3']) if (p[f] === b.proj_id) p[f] = ''; }
      restoreBaseline(db, b.proj_id);
      return { restored: name, note: 'It is now a normal project with this Project ID.' };
    }
    case 'add_eps': case 'add_obs': case 'add_role': {
      const kind = op.op.slice(4) as keyof typeof TREES;
      const { T, find } = tree(kind);
      const key = str(kind === 'obs' ? op.name : op.id, kind === 'obs' ? 'name' : 'id');
      if (rows(db, T.table).some((r) => lc(r[T.key]) === lc(key))) fail(`${kind.toUpperCase()} "${key}" already exists.`);
      const parent = op.parent != null && op.parent !== '' ? find(op.parent) : kind === 'eps' ? ensureEps(db) : null;
      const Tb = ensure(db, T.table, T.fields);
      const r: Row = Object.fromEntries(T.fields.map((f) => [f, ''])) as Row;
      Object.assign(r, { [T.id]: String(nextId(db, T.table)), [T.parent]: parent?.[T.id] ?? '', seq_num: String(Tb.rows.length + 1), [T.key]: key, [T.name]: typeof op.name === 'string' ? op.name : key });
      Tb.rows.push(r);
      return { [kind]: key };
    }
    case 'update_eps': case 'update_obs': case 'update_role': {
      const kind = op.op.slice(7) as keyof typeof TREES;
      const { T, find } = tree(kind);
      const r = find(kind === 'obs' ? op.name : op.id);
      if (op.parent !== undefined) {
        const parent = op.parent === '' || op.parent == null ? (kind === 'eps' ? ensureEps(db) : null) : find(op.parent);
        if (parent && subtree(rows(db, T.table), r[T.id], T.id, T.parent).has(parent[T.id])) fail(`Cannot move ${r[T.key]} under itself or one of its children.`);
        r[T.parent] = parent?.[T.id] ?? '';
      }
      const nk = kind === 'obs' ? op.new_name : op.new_id;
      if (nk != null) { const k = str(nk, kind === 'obs' ? 'new_name' : 'new_id'); if (rows(db, T.table).some((x) => x[T.id] !== r[T.id] && lc(x[T.key]) === lc(k))) fail(`${kind.toUpperCase()} "${k}" already exists.`); r[T.key] = k; }
      if (kind !== 'obs' && op.name != null) r[T.name] = str(op.name, 'name');
      if (kind === 'obs' && op.description !== undefined) { addField(table(db, 'OBS'), 'obs_descr'); r.obs_descr = op.description == null ? '' : String(op.description); }
      if (kind === 'role') copies(db, 'ROLES', 'role_id', 'role_short_name', 'role_name', r);
      return { [kind]: r[T.key] };
    }
    case 'delete_eps': case 'delete_obs': case 'delete_role': {
      const kind = op.op.slice(7) as keyof typeof TREES;
      const { T, find } = tree(kind);
      const r = find(kind === 'obs' ? op.name : op.id);
      const sub = subtree(rows(db, T.table), r[T.id], T.id, T.parent);
      if (kind === 'eps') {
        if (!r[T.parent]) fail('The EPS root cannot be deleted.');
        const n = rows(db, 'PROJECT').filter((p) => sub.has(p._eps_id)).length;
        if (n) fail(`EPS "${r[T.key]}" (or a child) holds ${n} project(s); move them first (set_project eps).`);
      }
      if (kind === 'obs') { const n = rows(db, 'PROJWBS').filter((w) => sub.has(w.obs_id)).length; if (n) fail(`OBS "${r[T.key]}" (or a child) is the responsible manager of ${n} WBS element(s).`); }
      if (kind === 'role') { const n = rows(db, 'TASKRSRC').filter((a) => sub.has(a.role_id)).length; if (n) fail(`Role "${r[T.key]}" (or a child) is used by ${n} assignment(s).`); }
      removeWhere(rows(db, T.table), (x) => sub.has(x[T.id]));
      return { deleted: r[T.key], with_children: sub.size - 1 };
    }
    case 'update_calendar': {
      const c = h.calendar(op.name);
      if (op.new_name != null) { const n = str(op.new_name, 'new_name'); if (rows(db, 'CALENDAR').some((x) => x.clndr_id !== c.clndr_id && lc(x.clndr_name) === lc(n))) fail(`Calendar "${n}" already exists.`); c.clndr_name = n; }
      const def = scheduledCalendarDef(c); // no calendar data: the week F9 gives it, now written out in full
      const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      if (op.work_week != null) {
        if (typeof op.work_week !== 'object') fail('"work_week" must map days (sun..sat) to lists of ["08:00","17:00"] periods.');
        for (const [k, v] of Object.entries(op.work_week as Record<string, unknown>)) { const i = DAYS.indexOf(k.slice(0, 3).toLowerCase()); if (i < 0) fail(`Unknown day "${k}" in work_week.`); def.week[i] = h.periods(v); }
        const weekH = def.week.flat().reduce((a, s) => a + s.end - s.start, 0) / 60;
        const dayH = Math.round((weekH / Math.max(1, def.week.filter((d) => d.length).length)) * 100) / 100;
        Object.assign(c, { day_hr_cnt: p6num(dayH), week_hr_cnt: p6num(weekH), month_hr_cnt: p6num(weekH * 4.3), year_hr_cnt: p6num(weekH * 52) });
      }
      for (const d of (Array.isArray(op.holidays) ? op.holidays : [])) def.exceptions.set(h.ole(date(d, 'holidays[]')), []);
      for (const [k, v] of Object.entries((op.work_exceptions ?? {}) as Record<string, unknown>)) def.exceptions.set(h.ole(date(k, 'work_exceptions key')), h.periods(v));
      for (const d of (Array.isArray(op.remove_exceptions) ? op.remove_exceptions : [])) def.exceptions.delete(h.ole(date(d, 'remove_exceptions[]')));
      c.clndr_data = serializeClndrData(def);
      return { calendar: c.clndr_name, note: 'Schedule to apply the change to dates.' };
    }
    case 'update_assignment': {
      const t = h.activity(op.activity, op.project), r = h.resource(op.resource);
      // by an index of the real rows kept for the edit (a search through the journal's view per operation was quadratic)
      const view = rows(db, 'TASKRSRC'), raw = realOf(view), tid = t.task_id, rid = r.rsrc_id;
      const i = (rowIndex(raw, 'task', (x) => x.task_id).get(tid) ?? []).find((k) => raw[k].task_id === tid && raw[k].rsrc_id === rid);
      const a = i != null ? (raw === view ? raw[i] : view[i]) : fail(`${r.rsrc_short_name} is not assigned to ${t.task_code}.`);
      if (op.units_per_day != null) recalcAssignment(db, t, a, 'target_qty_per_hr', num(op.units_per_day, 'units_per_day') / hpd);
      if (op.units != null) { recalcAssignment(db, t, a, 'target_qty', num(op.units, 'units')); if (!t.act_start_date) a.remain_qty = a.target_qty; }
      if (op.remaining_units != null) a.remain_qty = p6num(num(op.remaining_units, 'remaining_units'));
      if (op.curve !== undefined) { addField(table(db, 'TASKRSRC'), 'curv_id'); a.curv_id = op.curve ? h.curveId(op.curve) : ''; }
      recomputeCosts(db, a);
      assignmentActuals(db, a, op, num);
      return { assignment: `${r.rsrc_short_name} -> ${t.task_code}`, budgeted_units: Number(a.target_qty), remaining_units: Number(a.remain_qty) };
    }
    case 'update_resource': {
      const r = h.resource(op.id);
      if (op.new_id != null) { const k = str(op.new_id, 'new_id'); if (rows(db, 'RSRC').some((x) => x.rsrc_id !== r.rsrc_id && lc(x.rsrc_short_name) === lc(k))) fail(`Resource "${k}" already exists.`); r.rsrc_short_name = k; }
      if (op.name != null) r.rsrc_name = str(op.name, 'name');
      copies(db, 'RSRC', 'rsrc_id', 'rsrc_short_name', 'rsrc_name', r);
      // Max Units / Time: P6 keeps it on the resource's rate rows (one per effective date); the cap set here applies to
      // every one of them (leveling and the resource checks read it there), and a resource with none gets one
      if (op.max_units_per_hour != null && op.max_units_per_day != null) fail('Give max_units_per_hour or max_units_per_day, not both.');
      if (op.max_units_per_hour != null || op.max_units_per_day != null) {
        const perHr = op.max_units_per_hour != null ? num(op.max_units_per_hour, 'max_units_per_hour') : num(op.max_units_per_day, 'max_units_per_day') / hpd;
        if (!(perHr > 0)) fail('Max units must be greater than 0.');
        const RR = ensure(db, 'RSRCRATE', ['rsrc_rate_id', 'rsrc_id', 'max_qty_per_hr', 'cost_per_qty', 'start_date']);
        const mine = RR.rows.filter((x) => x.rsrc_id === r.rsrc_id);
        if (!mine.length) RR.rows.push({ rsrc_rate_id: String(nextId(db, 'RSRCRATE')), rsrc_id: r.rsrc_id, max_qty_per_hr: p6num(perHr), cost_per_qty: '0', start_date: '' });
        for (const x of mine) x.max_qty_per_hr = p6num(perHr);
        if (realOf(table(db, 'RSRC').fields).includes('max_qty_per_hr')) r.max_qty_per_hr = p6num(perHr);
        return { resource: r.rsrc_short_name, max_units_per_hour: Number(p6num(perHr)), max_units_per_day: Math.round(perHr * hpd * 1000) / 1000 };
      }
      return { resource: r.rsrc_short_name };
    }
    case 'delete_resource': {
      const r = h.resource(op.id);
      const rid = r.rsrc_id, key = r.rsrc_short_name, up = r.parent_rsrc_id ?? '';
      const assignments = realOf(rows(db, 'TASKRSRC')).filter((a) => a.rsrc_id === rid).length, primary = pick(rows(db, 'TASK'), (t) => t.rsrc_id === rid);
      if ((assignments || primary.length) && op.clear_references !== true) fail(`Resource "${key}" is on ${assignments} assignment(s) and the primary resource of ${primary.length} activit${primary.length === 1 ? 'y' : 'ies'}; clear_references: true removes those assignments and clears the primary resources.`);
      removeWhere(rows(db, 'TASKRSRC'), (a) => a.rsrc_id === rid);
      for (const t of primary) t.rsrc_id = '';
      for (const c of pick(rows(db, 'RSRC'), (x) => x.parent_rsrc_id === rid)) c.parent_rsrc_id = up;
      const udf = new Set(rows(db, 'UDFTYPE').filter((u) => u.table_name === 'RSRC').map((u) => u.udf_type_id));
      removeWhere(rows(db, 'UDFVALUE'), (v) => v.fk_id === rid && udf.has(v.udf_type_id));
      // every other row that points at it: its own (rates, codes, roles, hours: removed), or a reference (cleared)
      for (const name of Object.keys(db.tables)) {
        if (name === 'RSRC' || name === 'TASK' || name === 'TASKRSRC') continue;
        const fs = realOf(db.tables[name].fields).filter((f) => refTarget(f, name) === 'RSRC');
        if (!fs.length) continue;
        if (/^(RSRC|WBSRSRC)/.test(name)) removeWhere(rows(db, name), (x) => fs.some((f) => x[f] === rid));
        else for (const x of pick(rows(db, name), (y) => fs.some((f) => y[f] === rid))) for (const f of fs) if (x[f] === rid) x[f] = '';
      }
      removeWhere(rows(db, 'RSRC'), (x) => x.rsrc_id === rid);
      return { deleted: key, assignments_removed: assignments, primary_resources_cleared: primary.length };
    }
    case 'regenerate_guids': case 'clear_authors': {
      const p = h.project(op.project), dict = op.dictionaries !== false;
      const ids = new Set([p.proj_id, ...rows(db, 'PROJECT').filter((x) => x._baseline_of === p.proj_id).map((x) => x.proj_id)]);
      let n = 0;
      for (const [name, list] of scopedRows(db, ids, dict)) {
        const fs = realOf(db.tables[name].fields).filter((f) => (op.op === 'clear_authors' ? AUTHOR_FIELDS.has(f) : f === 'guid' || f.endsWith('_guid')));
        if (fs.length) for (const x of list) for (const f of fs) if (x[f]) { x[f] = f === 'guid' ? freshGuid() : ''; n++; }
      }
      if (op.op === 'clear_authors') {
        const raw = db.header?.raw;
        if (dict && raw) [[4, 'admin'], [5, 'admin'], [6, 'dbxDatabaseNoName']].forEach(([i, v]) => { if (raw[i as number]) raw[i as number] = v as string; });
        return { project: p.proj_short_name, fields_cleared: n };
      }
      if (op.keep_proj_id !== true) {
        const to = op.new_proj_id != null ? String(op.new_proj_id).trim() : String(nextId(db, 'PROJECT'));
        const why = projectNumberProblem(db, p.proj_id, to);
        if (why) fail(why);
        if (to !== p.proj_id) renumberProject(db, p.proj_id, to);
      }
      return { project: p.proj_short_name, guids: n, proj_id: p.proj_id };
    }
    case 'clear_udfs': {
      const p = h.project(op.project), pid = p.proj_id;
      const subj = op.subject != null ? UDF_SUBJECT[lc(op.subject)] ?? fail(`subject must be ${Object.keys(UDF_SUBJECT).join(', ')}.`) : null;
      const types = rows(db, 'UDFTYPE').filter((u) => (!subj || u.table_name === subj) && (op.udf == null || lc(u.udf_type_label) === lc(op.udf)));
      if (op.udf != null && !types.length) fail(`No ${subj ? `${lc(op.subject)} ` : ''}UDF "${op.udf}".`);
      // unless named, the clone's LOB plan keeps its own UDFs (its activities' LOB Task... and the project's Schedule Method)
      const lob = new Set<string>(op.udf == null ? [...Object.values(LOB_UDF), LOB_FLAG.udf] : []);
      const tableOf = new Map(types.map((u) => [u.udf_type_id, u.table_name]));
      const keep = (v: Row) => { const u = types.find((x) => x.udf_type_id === v.udf_type_id); return !!u && lob.has(u.udf_type_label) && (u.udf_type_label !== LOB_FLAG.udf || v.udf_text === LOB_FLAG.value); };
      const ofProject = (name: string, key: string) => new Set(realOf(rows(db, name)).filter((x) => x.proj_id === pid).map((x) => x[key]));
      const mine: Record<string, Set<string> | null> = { TASK: ofProject('TASK', 'task_id'), PROJWBS: ofProject('PROJWBS', 'wbs_id'), TASKRSRC: ofProject('TASKRSRC', 'taskrsrc_id'), PROJECT: new Set([pid]), RSRC: subj === 'RSRC' || op.udf != null ? null : new Set() };
      const n = removeWhere(rows(db, 'UDFVALUE'), (v) => { const tn = tableOf.get(v.udf_type_id); if (!tn || keep(v)) return false; const m = mine[tn]; return m === null || (!!m && m.has(v.fk_id)); });
      return { project: p.proj_short_name, cleared: n };
    }
    case 'delete_expenses': {
      const t = op.activity != null ? h.activity(op.activity, op.project) : null, p = t ? null : h.project(op.project);
      const n = removeWhere(rows(db, 'PROJCOST'), t ? (c) => c.task_id === t.task_id : (c) => c.proj_id === p!.proj_id);
      return { [t ? 'activity' : 'project']: t ? t.task_code : p!.proj_short_name, deleted: n };
    }
    case 'update_udf': {
      const tbl = UDF_SUBJECT[lc(op.subject ?? 'activity')] ?? fail(`subject must be ${Object.keys(UDF_SUBJECT).join(', ')}.`);
      const name = str(op.udf, 'udf'), n = str(op.new_name, 'new_name');
      const u = rows(db, 'UDFTYPE').find((x) => x.table_name === tbl && lc(x.udf_type_label) === lc(name)) ?? fail(`No ${lc(op.subject ?? 'activity')} UDF "${name}".`);
      if (rows(db, 'UDFTYPE').some((x) => x.udf_type_id !== u.udf_type_id && x.table_name === tbl && lc(x.udf_type_label) === lc(n))) fail(`UDF "${n}" already exists for that subject.`);
      u.udf_type_label = n;
      return { udf: n };
    }
    case 'update_resource_curve': {
      const c = rows(db, 'RSRCCURVDATA').find((x) => lc(x.curv_name) === lc(op.name)) ?? fail(`No resource curve "${op.name}".`);
      const n = str(op.new_name, 'new_name');
      if (rows(db, 'RSRCCURVDATA').some((x) => x.curv_id !== c.curv_id && lc(x.curv_name) === lc(n))) fail(`Resource curve "${n}" already exists.`);
      c.curv_name = n;
      return { resource_curve: n };
    }
    case 'update_code_type': {
      const S = codeSubject(op.subject);
      const t = codeType(S, str(op.name, 'name'), op.project != null ? h.project(op.project).proj_id : undefined, true);
      const n = str(op.new_name, 'new_name'), tid = t[S.tid];
      if (realOf(rows(db, S.type)).some((x) => x[S.tid] !== tid && lc(x[S.tname]) === lc(n))) fail(`Code type "${n}" already exists.`);
      t[S.tname] = n;
      return { code_type: n };
    }
    case 'update_code_value': case 'delete_code_value': {
      const S = codeSubject(op.subject);
      const type = codeType(S, str(op.type, 'type'), op.project != null ? h.project(op.project).proj_id : undefined, true);
      const vid = codeValue(S, type, str(op.code, 'code'))[S.vid];
      const v = pick(rows(db, S.val), (x) => x[S.vid] === vid, 1)[0];
      if (op.op === 'delete_code_value') {
        const sub = subtree(realOf(rows(db, S.val)), vid, S.vid, S.vparent);
        const n = removeWhere(rows(db, S.link), (a) => sub.has(a[S.vid]));
        removeWhere(rows(db, S.val), (x) => sub.has(x[S.vid]));
        return { deleted: `${type[S.tname]} = ${v[S.vshort]}`, with_children: sub.size - 1, assignments_removed: n };
      }
      if (op.new_code != null) {
        const code = str(op.new_code, 'new_code'), len = Math.min(CODE_MAX, Number(type[S.tlen]) || CODE_MAX);
        if (code.length > len) fail(`Code value "${code}" is ${code.length} characters; code type "${type[S.tname]}" allows ${len}. Nothing was cut: give a shorter value.`);
        const tid = type[S.tid], parent = v[S.vparent];
        if (realOf(rows(db, S.val)).some((x) => x[S.vid] !== vid && x[S.tid] === tid && x[S.vparent] === parent && lc(x[S.vshort]) === lc(code))) fail(`Code value "${code}" already exists there.`);
        v[S.vshort] = code;
      }
      if (op.name != null) v[S.vname] = String(op.name);
      return { code_value: `${type[S.tname]} = ${v[S.vshort]}` };
    }
  }
  return undefined;
}
