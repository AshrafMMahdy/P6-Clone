// Edit operations on any P6 table, as P6's own dialogs and Global Change reach every field: set_fields (one row, or every
// row a "where" picks, with values or expressions), add_row, delete_rows; and activities moved or copied between
// projects. Each value is checked as P6 would hold it: the field exists in that P6 table, its kind (date, flag, number,
// a reference to a row that exists), its allowed values (ENUMS), its length; keys and the clone's own fields are refused.
import { addField, dropIndexes, KEYS, nextId, refTarget, rows, table, type Db, type Row } from '../db.ts';
import { pick, realOf, removeWhere } from '../journal.ts';
import { ENUMS, fieldType, knownFields, knownTables } from '../xer/schema.ts';
import { MAX_LEN } from '../xer/validate.ts';
import { normDate } from './edit.ts';
import type { OpHelpers } from './ops-extra.ts';
import { problemsIn } from './integrity.ts';

type Op = Record<string, unknown> & { op: string };

export const FIELD_OP_NAMES = ['set_fields', 'add_row', 'delete_rows', 'move_activity', 'copy_activities'];
export const FIELD_GUIDE = [
  `set_fields: table (a P6 table: TASK, PROJECT, PROJWBS, RSRC, RSRCRATE, CALENDAR, UDFTYPE, ACCOUNT, SCHEDOPTIONS... as read_table names them), fields {field: value} (P6's own field names and units, as read_table shows them: durations in hours, dates "YYYY-MM-DD HH:MM", flags Y/N or true/false, codes such as DT_FixedDrtn, CP_Phys, PS_Active, WS_Open; null or "" clears), and where {field: value or {op: = != < <= > >= contains starts_with in empty iequals icontains istarts_with, value}} (the rows to change; every row when all: true; text is matched exactly as written, upper and lower case apart - iequals / icontains / istarts_with ignore case; numbers are compared as numbers only in fields that hold numbers, dates as dates), [project] (only that project's rows; a baseline's rows are never touched unless project names that baseline). A change P6 would refuse is refused with the rows named, and nothing is changed: an Activity ID, Project ID, Resource ID, WBS code under one parent or code value used twice, a row made its own ancestor (WBS, resource, cost account, code value, calendar, role, EPS, OBS), a relationship from an activity to itself or one that closes a loop. A value may be an expression on each row: {from: "other_field"}, {multiply: n}, {add: n} (numbers; add_days for dates), {replace: [find, with]}, {prefix: "x"}, {suffix: "x"}. P6's Global Change, and any field no other operation names (duration_type, complete_pct_type, suspend_date, resume_date, a project's status_code and defaults, a WBS's status_code, a resource's type, calendar, units, overtime, level flag, a calendar's default_flag...). Answers matched and changed. Dates and float are not recomputed: schedule afterwards`,
  `add_row: table, fields {field: value}: a new row of any P6 table (a rate history row of RSRCRATE, a role's rate in ROLERATE, a resource's role and proficiency in RSRCROLE...), its key assigned; checked as set_fields checks. Answers the table and the new key`,
  `delete_rows: table, where (as set_fields), [all], [project]: removes the rows a where picks; refused while another row points at one of them (named, with how many), so nothing is left dangling; their UDF values go with them. Activities, WBS and projects have their own operations (delete_activity, delete_wbs)`,
  `move_activity: id, to_project, [project], [wbs] (WBS code in to_project; default its root), [new_id]: the activity, its assignments, codes, UDFs, notes, steps and expenses move to the other project; its relationships stay (between projects, as P6 keeps them); codes of the old project's own code types are removed`,
  `copy_activities: activities [{id, new_id}], [project], [to_project] (default the same project), [wbs] (default: the activity's own WBS in the same project, the root of another), [relationships] (default true: the relationships among the copied activities are copied too): like P6's copy and paste; each copy has the activity's assignments, codes, UDFs, notes, steps and expenses`,
];

/** The references a new row of these tables cannot do without (each is checked to exist when given). */
const REQUIRED: Record<string, string[]> = { RSRCRATE: ['rsrc_id'], ROLERATE: ['role_id'], RSRCROLE: ['rsrc_id', 'role_id'], ACTVCODE: ['actv_code_type_id'], PCATVAL: ['proj_catg_type_id'], RCATVAL: ['rsrc_catg_type_id'], UDFVALUE: ['udf_type_id', 'fk_id'], UDFCODE: ['udf_type_id'], PROJFUND: ['fund_id'], ROLELIMIT: ['role_id'] };
const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();
const numText = (n: number) => String(Math.round(n * 1e6) / 1e6);

export function applyFields(db: Db, op: Op, h: OpHelpers): unknown {
  const { fail, str } = h;
  /** A P6 table of the file (or, for add_row, one P6 has) by name. */
  const tableOf = (v: unknown, create = false) => {
    const name = str(v, 'table').toUpperCase();
    if (name.startsWith('_') || name.includes(':')) fail(`${name} is not a P6 table: the clone's own data and kept XML are read-only here.`);
    if (db.tables[name]) return table(db, name);
    if (create && knownTables().has(name)) return table(db, name);
    return fail(`No table "${name}" in this file. Its tables: ${Object.keys(db.tables).filter((t) => !t.startsWith('_')).join(', ')}.`);
  };
  /** A field of the table that a value may be written to. */
  const writable = (T: { name: string; fields: string[] }, f: string) => {
    if (f.startsWith('_')) fail(`${f} is the clone's own field, not P6's.`);
    if (f === KEYS[T.name]) fail(`${T.name}.${f} is the row's key; it cannot be changed.`);
    if (f === 'proj_id' && T.name !== 'PROJECT') fail(`${T.name}.proj_id: moving rows between projects is move_activity (activities) or the operation of the thing itself.`);
    if (T.name === 'TASK' && f === 'status_code') fail('TASK.status_code follows the actual dates: set actual_start / actual_finish with update_activity.');
    if (!realOf(T.fields).includes(f) && !knownFields(T.name).has(f)) fail(`No field "${f}" in ${T.name}. Its fields: ${realOf(T.fields).filter((x) => !x.startsWith('_')).join(', ')}.`);
  };
  /** The text P6 holds for a value given for field f of row r. */
  const value = (T: { name: string }, f: string, v: unknown, r: Row): string => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const e = v as Record<string, unknown>, cur = r[f] ?? '';
      if ('from' in e) return value(T, f, r[str(e.from, 'from')] ?? '', r);
      if ('multiply' in e || 'add' in e) {
        if (fieldType(f) !== 'number') fail(`multiply / add work on numbers; ${f} is not one.`);
        if (cur === '') return ''; // nothing to multiply or add to: an empty number stays empty (it is not 0)
        return numText((Number(cur) || 0) * ('multiply' in e ? h.num(e.multiply, 'multiply') : 1) + ('add' in e ? h.num(e.add, 'add') : 0));
      }
      if ('add_days' in e) {
        if (fieldType(f) !== 'date') fail(`add_days works on dates; ${f} is not one.`);
        if (!cur) return '';
        const d = new Date(`${cur.slice(0, 10)}T${cur.slice(11, 16) || '00:00'}:00Z`);
        d.setUTCDate(d.getUTCDate() + Math.round(h.num(e.add_days, 'add_days')));
        return value(T, f, d.toISOString().slice(0, 16).replace('T', ' '), r);
      }
      if ('replace' in e) { const [a, b] = Array.isArray(e.replace) ? e.replace : []; if (a == null || String(a) === '') fail(`replace: give the text to find (an empty one would put the new text between every character of ${f}).`); return value(T, f, String(cur).split(String(a ?? '')).join(String(b ?? '')), r); }
      if ('prefix' in e) return value(T, f, `${e.prefix ?? ''}${cur}`, r);
      if ('suffix' in e) return value(T, f, `${cur}${e.suffix ?? ''}`, r);
      return fail(`Unknown expression ${JSON.stringify(v)} for ${f}: use from, multiply, add, add_days, replace, prefix or suffix.`);
    }
    const s = v == null ? '' : typeof v === 'boolean' ? (v ? 'Y' : 'N') : String(v).trim();
    const allowed = ENUMS[`${T.name}.${f}`];
    if (allowed && !allowed.includes(s) && !(s === '' && allowed.includes(''))) fail(`${T.name}.${f} takes ${allowed.filter(Boolean).join(', ')}${allowed.includes('') ? ' or ""' : ''}; not "${s}".`);
    if (s === '') return '';
    const kind = fieldType(f);
    if (kind === 'date') return normDate(s) || fail(`${f} must be a date like 2026-03-02 or 2026-03-02 08:00; not "${s}".`);
    if (kind === 'flag') return /^(y|yes|true)$/i.test(s) ? 'Y' : /^(n|no|false)$/i.test(s) ? 'N' : fail(`${f} is a flag: Y or N (true or false); not "${s}".`);
    if (kind === 'number') return Number.isFinite(Number(s)) ? numText(Number(s)) : fail(`${f} must be a number; not "${s}".`);
    if (kind === 'id') {
      const to = refTarget(f, T.name);
      if (!to) return s;
      const target = rows(db, to).find((x) => x[KEYS[to]] === s) ?? fail(`${f} = ${s}: no ${to} row has that ${KEYS[to]}.`);
      if (target.proj_id && r.proj_id && to !== 'PROJECT' && target.proj_id !== r.proj_id) fail(`${f} = ${s}: that ${to} row belongs to another project.`);
      return s;
    }
    const max = MAX_LEN[`${T.name}.${f}`];
    if (max && s.length > max) fail(`${T.name}.${f} holds at most ${max} characters; "${s}" has ${s.length}. Nothing was cut.`);
    return s;
  };
  /** The baseline projects (PROJECT._baseline_of): their rows are variance data the customer keeps, and P6's Global Change works on the open
   *  project, never on its baselines. They are reached only when `project` names the baseline. */
  const baselines = () => {
    const all = realOf(rows(db, 'PROJECT')).filter((p) => p._baseline_of);
    const want = op.project != null ? String(op.project).toLowerCase() : null;
    const live = want != null && realOf(rows(db, 'PROJECT')).some((p) => !p._baseline_of && p.proj_short_name.toLowerCase() === want);
    const named = want != null && !live ? all.find((p) => p.proj_short_name.toLowerCase() === want)?.proj_id ?? null : null;
    return { hidden: new Set(all.map((p) => p.proj_id).filter((id) => id !== named)), named };
  };
  /** The rows of T a where (and project) picks; every row only with all: true. */
  const picked = (T: { name: string; fields: string[]; rows: Row[] }) => {
    const where = (op.where && typeof op.where === 'object' ? op.where : {}) as Record<string, unknown>;
    if (!Object.keys(where).length && op.all !== true) fail('Give where (the rows to change), or all: true for every row of the table.');
    const F = realOf(T.fields);
    for (const f of Object.keys(where)) if (!F.includes(f)) fail(`where: no field "${f}" in ${T.name}.`);
    const { hidden, named } = baselines();
    let inProject: ((r: Row) => boolean) | null = null;
    if (op.project != null) {
      const pid = named ?? h.project(op.project).proj_id;
      const tasks = F.includes('task_id') && !F.includes('proj_id') ? new Set(realOf(rows(db, 'TASK')).filter((t) => t.proj_id === pid).map((t) => t.task_id)) : null;
      inProject = F.includes('proj_id') ? (r) => r.proj_id === pid : tasks ? (r) => tasks.has(r.task_id) : fail(`${T.name} rows belong to no project; leave project out.`);
    }
    // rows of the baselines are out of reach: by proj_id, by the activity or WBS element they belong to, or (a project row) by being one
    let reach: ((r: Row) => boolean) | null = null;
    if (hidden.size) {
      const bTasks = F.includes('task_id') && !F.includes('proj_id') ? new Set(realOf(rows(db, 'TASK')).filter((t) => hidden.has(t.proj_id)).map((t) => t.task_id)) : null;
      const bWbs = F.includes('wbs_id') && !F.includes('proj_id') && T.name !== 'PROJWBS' ? new Set(realOf(rows(db, 'PROJWBS')).filter((w) => hidden.has(w.proj_id)).map((w) => w.wbs_id)) : null;
      const udf = T.name === 'UDFVALUE' && !F.includes('proj_id') ? (() => {
        const tasks = new Set(realOf(rows(db, 'TASK')).filter((t) => hidden.has(t.proj_id)).map((t) => t.task_id)), wbs = new Set(realOf(rows(db, 'PROJWBS')).filter((w) => hidden.has(w.proj_id)).map((w) => w.wbs_id));
        const tableOf = new Map(realOf(rows(db, 'UDFTYPE')).map((u) => [u.udf_type_id, u.table_name]));
        return (r: Row) => { const t = tableOf.get(r.udf_type_id); return (t === 'TASK' && tasks.has(r.fk_id)) || (t === 'PROJWBS' && wbs.has(r.fk_id)) || (t === 'PROJECT' && hidden.has(r.fk_id)); };
      })() : null;
      reach = (r) => !((T.name === 'PROJECT' && hidden.has(r.proj_id)) || (F.includes('proj_id') && T.name !== 'PROJECT' && hidden.has(r.proj_id)) || bTasks?.has(r.task_id) || bWbs?.has(r.wbs_id) || udf?.(r));
    }
    const norm = (f: string, v: unknown): string => {
      const kind = fieldType(f), t = v == null ? '' : typeof v === 'boolean' ? (v ? 'Y' : 'N') : String(v);
      if (kind === 'date') return t === '' ? '' : normDate(t) ?? t;
      if (kind === 'flag') return /^(y|yes|true)$/i.test(t) ? 'Y' : /^(n|no|false)$/i.test(t) ? 'N' : t;
      return t;
    };
    /** Order of the row's value a against b by the field's own kind: numbers by value in a field that holds numbers, dates as dates, everything else
     *  as the exact text (a code "0100" is not "100", "A1" is not "a1"). */
    const cmp = (f: string, a: string, b: unknown, fold = false): number => {
      if (fieldType(f) === 'number') {
        const y = norm(f, b);
        if (a === '' || y === '') return a === y ? 0 : a === '' ? -1 : 1;
        if (!Number.isFinite(Number(y))) fail(`where ${f}: ${f} holds numbers; "${y}" is not one.`);
        return Number.isFinite(Number(a)) ? Number(a) - Number(y) : a < y ? -1 : 1;
      }
      const x = norm(f, a), y = norm(f, b), p = fold ? x.toLowerCase() : x, q = fold ? y.toLowerCase() : y;
      return p < q ? -1 : p > q ? 1 : 0;
    };
    const test = (r: Row) => (!reach || reach(r)) && (!inProject || inProject(r)) && Object.entries(where).every(([f, c]) => {
      const v = r[f] ?? '';
      if (!c || typeof c !== 'object' || Array.isArray(c)) return Array.isArray(c) ? c.some((x) => cmp(f, v, x) === 0) : cmp(f, v, c) === 0;
      const { op: o = '=', value: w } = c as { op?: string; value?: unknown };
      const by: Record<string, () => boolean> = {
        '=': () => cmp(f, v, w) === 0, '!=': () => cmp(f, v, w) !== 0,
        '<': () => v !== '' && cmp(f, v, w) < 0, '<=': () => v !== '' && cmp(f, v, w) <= 0,
        '>': () => v !== '' && cmp(f, v, w) > 0, '>=': () => v !== '' && cmp(f, v, w) >= 0,
        contains: () => String(v).includes(String(w ?? '')), starts_with: () => String(v).startsWith(String(w ?? '')),
        icontains: () => lc(v).includes(lc(w)), istarts_with: () => lc(v).startsWith(lc(w)), iequals: () => cmp(f, v, w, true) === 0,
        in: () => Array.isArray(w) && w.some((x) => cmp(f, v, x) === 0),
        empty: () => (v === '') === (w !== false),
      };
      return (by[o] ?? fail(`where ${f}: unknown op "${o}" (${Object.keys(by).join(', ')}).`))();
    });
    return pick(T.rows, test);
  };
  /** Rows of other tables that point at these keys of T (field by field). */
  const pointers = (T: { name: string }, keys: Set<string>) => {
    const out: string[] = [];
    for (const t of Object.values(db.tables)) {
      if (t.name.startsWith('_')) continue;
      for (const f of realOf(t.fields)) {
        if (refTarget(f, t.name) !== T.name || (t.name === T.name && f === KEYS[T.name])) continue;
        const n = realOf(t.rows).filter((r) => keys.has(r[f])).length;
        if (n) out.push(`${n} ${t.name} row(s) by ${f}`);
      }
    }
    return out;
  };
  const udfValuesOf = (tableName: string, keys: Set<string>) => {
    const types = new Set(realOf(rows(db, 'UDFTYPE')).filter((u) => u.table_name === tableName).map((u) => u.udf_type_id));
    return (r: Row) => types.has(r.udf_type_id) && keys.has(r.fk_id);
  };
  const projectRoot = (pid: string) => rows(db, 'PROJWBS').find((w) => w.proj_id === pid && w.proj_node_flag === 'Y') ?? fail('That project has no root WBS node.');
  /** What P6 refuses in the rows a call changed (an ID used twice, a row its own ancestor, a relationship to itself or in a loop): the whole call is
   *  refused, naming the rows, and nothing is changed. */
  const refuse = (T: { name: string }, touched: Row[], rewired = new Set<Row>()) => {
    if (!touched.length) return;
    const raw = touched.map(realOf);
    const found = problemsIn(db, T.name, raw).map((p) => p.message);
    // a relationship given other ends is checked for loops with the rest of the edit (one whose lag or type changed closes no new loop)
    for (const r of rewired) { const x = realOf(r); if (x.task_id !== x.pred_task_id) h.linked(x.pred_task_id, x.task_id); }
    if (found.length) fail(`${found.slice(0, 5).join(' ')}${found.length > 5 ? ` (and ${found.length - 5} more)` : ''} Nothing was changed.`);
  };
  /** The rows that belong to an activity (assignments, codes, notes, steps, expenses...): tables with task_id, not TASK, not TASKPRED. */
  const ownTables = () => Object.values(db.tables).filter((t) => !t.name.startsWith('_') && t.name !== 'TASK' && t.name !== 'TASKPRED' && realOf(t.fields).includes('task_id'));

  switch (op.op) {
    case 'set_fields': {
      const T = tableOf(op.table);
      const fields = (op.fields && typeof op.fields === 'object' ? op.fields : fail('Give fields {field: value}.')) as Record<string, unknown>;
      if (!Object.keys(fields).length) fail('Give at least one field.');
      for (const f of Object.keys(fields)) writable(T, f);
      const hit = picked(T);
      let changed = 0;
      const touched: Row[] = [], rewired = new Set<Row>();
      for (const r of hit) {
        const next = Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, value(T, f, v, r)]));
        if (Object.entries(next).some(([f, v]) => (r[f] ?? '') !== v)) { changed++; touched.push(r); if (T.name === 'TASKPRED' && (('task_id' in next && next.task_id !== r.task_id) || ('pred_task_id' in next && next.pred_task_id !== r.pred_task_id))) rewired.add(r); for (const [f, v] of Object.entries(next)) { addField(T, f); r[f] = v; } }
      }
      // actual dates written here move the activity's status with them, as update_activity does (status_code follows the actual dates)
      if (T.name === 'TASK' && ('act_start_date' in fields || 'act_end_date' in fields)) for (const r of touched) { const x = realOf(r); const next = x.act_end_date ? 'TK_Complete' : x.act_start_date ? 'TK_Active' : 'TK_NotStart'; if (x.status_code !== next) { addField(T, 'status_code'); r.status_code = next; } }
      if (!hit.length) h.warn(`set_fields: no ${T.name} row matched ${JSON.stringify(op.where ?? {})}.`);
      refuse(T, touched, rewired);
      return { table: T.name, matched: hit.length, changed };
    }
    case 'add_row': {
      const T = tableOf(op.table, true);
      const fields = (op.fields && typeof op.fields === 'object' ? op.fields : fail('Give fields {field: value}.')) as Record<string, unknown>;
      if (['TASK', 'PROJECT', 'PROJWBS', 'TASKPRED', 'TASKRSRC'].includes(T.name)) fail(`${T.name} rows are added with their own operation (add_activity, add_project, add_wbs, add_relationship, assign_resource).`);
      const key = KEYS[T.name], r: Row = {};
      if (fields.proj_id != null) r.proj_id = h.project(fields.proj_id).proj_id; // a Project ID is given; proj_id is checked as one
      for (const [f, v] of Object.entries(fields)) { if (f === 'proj_id') continue; writable(T, f); r[f] = value(T, f, v, r); }
      for (const f of realOf(T.fields)) r[f] ??= '';
      if (key) r[key] = String(nextId(db, T.name));
      for (const f of Object.keys(r)) addField(T, f);
      for (const f of REQUIRED[T.name] ?? []) if (!r[f]) fail(`${T.name} needs ${f} (the row it belongs to): give it in fields.`);
      T.rows.push(r);
      refuse(T, [realOf(T.rows[T.rows.length - 1])]);
      return { table: T.name, ...(key ? { [key]: r[key] } : {}) };
    }
    case 'delete_rows': {
      const T = tableOf(op.table);
      if (['TASK', 'PROJECT', 'PROJWBS'].includes(T.name)) fail(`${T.name} rows are removed with their own operation (delete_activity, delete_wbs).`);
      const hit = picked(T), key = KEYS[T.name];
      if (key) {
        const keys = new Set(hit.map((r) => r[key]));
        const refs = pointers(T, keys);
        if (refs.length) fail(`Other rows point at these ${T.name} rows: ${refs.join('; ')}. Change or remove those first.`);
        if (db.tables.UDFVALUE) removeWhere(rows(db, 'UDFVALUE'), udfValuesOf(T.name, keys));
      }
      const gone = new Set(hit.map(realOf));
      const n = removeWhere(T.rows, (r) => gone.has(r));
      if (key) dropIndexes(realOf(T.rows));
      return { table: T.name, deleted: n };
    }
    case 'move_activity': {
      const t = h.activity(op.id, op.project), P = h.project(op.to_project), from = t.proj_id;
      if (P.proj_id === from) fail('The activity is in that project already; move it to another WBS with update_activity wbs.');
      const code = op.new_id != null ? str(op.new_id, 'new_id') : t.task_code;
      if (realOf(rows(db, 'TASK')).some((x) => x.proj_id === P.proj_id && lc(x.task_code) === lc(code))) fail(`${P.proj_short_name} has an activity ${code} already; give new_id.`);
      const w = op.wbs != null && op.wbs !== '' ? h.wbsOf(P, op.wbs) : projectRoot(P.proj_id);
      // codes of the old project's own code types do not exist in the new one
      const ownTypes = new Set(realOf(rows(db, 'ACTVTYPE')).filter((c) => c.proj_id === from).map((c) => c.actv_code_type_id));
      const dropped = db.tables.TASKACTV ? removeWhere(rows(db, 'TASKACTV'), (a) => a.task_id === t.task_id && ownTypes.has(a.actv_code_type_id)) : 0;
      if (dropped) h.warn(`move_activity ${t.task_code}: ${dropped} code(s) of ${from}'s own code types removed.`);
      const cal = rows(db, 'CALENDAR').find((c) => c.clndr_id === t.clndr_id);
      if (cal?.proj_id && cal.proj_id !== P.proj_id) h.warn(`move_activity ${t.task_code}: it keeps calendar "${cal.clndr_name}", a project calendar of its old project.`);
      for (const T of ownTables()) if (realOf(T.fields).includes('proj_id')) for (const r of pick(T.rows, (x) => x.task_id === t.task_id)) r.proj_id = P.proj_id;
      for (const r of pick(rows(db, 'TASKPRED'), (x) => x.task_id === t.task_id)) r.proj_id = P.proj_id;
      for (const r of pick(rows(db, 'TASKPRED'), (x) => x.pred_task_id === t.task_id)) r.pred_proj_id = P.proj_id;
      if (db.tables.UDFVALUE) {
        for (const r of pick(rows(db, 'UDFVALUE'), udfValuesOf('TASK', new Set([t.task_id])))) if (r.proj_id != null) r.proj_id = P.proj_id;
        // the UDFs of its assignments move with them
        const mine = new Set(realOf(rows(db, 'TASKRSRC')).filter((a) => a.task_id === t.task_id).map((a) => a.taskrsrc_id));
        for (const r of pick(rows(db, 'UDFVALUE'), udfValuesOf('TASKRSRC', mine))) if (r.proj_id != null) r.proj_id = P.proj_id;
      }
      Object.assign(t, { proj_id: P.proj_id, wbs_id: w.wbs_id, task_code: code });
      dropIndexes(realOf(rows(db, 'TASK')));
      return { activity: code, project: P.proj_short_name, wbs: w.wbs_short_name };
    }
    case 'copy_activities': {
      const list = Array.isArray(op.activities) ? op.activities as Record<string, unknown>[] : fail('Give activities [{id, new_id}].');
      const P = op.to_project != null ? h.project(op.to_project) : null;
      const pairs = list.map((a) => { const t = h.activity(a.id, op.project); return { t: realOf(t), code: str(a.new_id, 'new_id') }; });
      const to = (t: Row) => P?.proj_id ?? t.proj_id;
      const taken = new Set(realOf(rows(db, 'TASK')).map((x) => `${x.proj_id}|${lc(x.task_code)}`));
      for (const { t, code } of pairs) { const k = `${to(t)}|${lc(code)}`; if (taken.has(k)) fail(`Activity ${code} exists in that project already.`); taken.add(k); }
      const map = new Map<string, string>(), T = table(db, 'TASK');
      for (const { t, code } of pairs) {
        const id = String(nextId(db, 'TASK')), wbs = op.wbs != null && op.wbs !== '' ? h.wbsOf(P ?? rows(db, 'PROJECT').find((p) => p.proj_id === t.proj_id)!, op.wbs).wbs_id : P && P.proj_id !== t.proj_id ? projectRoot(P.proj_id).wbs_id : t.wbs_id;
        T.rows.push({ ...t, task_id: id, task_code: code, proj_id: to(t), wbs_id: wbs, ...(t.guid != null ? { guid: '' } : {}) });
        map.set(t.task_id, id);
      }
      // what belongs to each activity, copied with it (a code of the old project's own code type only within that project)
      const ownTypes = new Set(realOf(rows(db, 'ACTVTYPE')).filter((c) => c.proj_id).map((c) => `${c.actv_code_type_id}|${c.proj_id}`));
      // assignments first: what hangs on an assignment (TRSRCFIN, its UDFs) is re-pointed at the COPY of the assignment, not the original
      const assigned = new Map<string, string>();
      let droppedCodes = 0;
      for (const Tb of ownTables().sort((a, b) => Number(b.name === 'TASKRSRC') - Number(a.name === 'TASKRSRC'))) {
        const key = KEYS[Tb.name], src = realOf(Tb.rows).filter((r) => map.has(r.task_id));
        const hangs = realOf(Tb.fields).includes('taskrsrc_id') && key !== 'taskrsrc_id';
        for (const r of src) {
          if (Tb.name === 'TASKACTV' && P && P.proj_id !== r.proj_id && (ownTypes.has(`${r.actv_code_type_id}|${r.proj_id}`))) { droppedCodes++; continue; }
          const id = key ? String(nextId(db, Tb.name)) : null;
          if (Tb.name === 'TASKRSRC' && id) assigned.set(r.taskrsrc_id, id);
          Tb.rows.push({ ...r, task_id: map.get(r.task_id)!, ...(P && r.proj_id != null ? { proj_id: P.proj_id } : {}), ...(key ? { [key]: id } : {}), ...(hangs && assigned.has(r.taskrsrc_id) ? { taskrsrc_id: assigned.get(r.taskrsrc_id)! } : {}), ...(r.guid != null ? { guid: '' } : {}) });
        }
      }
      if (droppedCodes) h.warn(`copy_activities: ${droppedCodes} code assignment(s) of the old project's own code types were not copied (the other project does not have those code types).`);
      if (P) for (const { t } of pairs) {
        const cal = rows(db, 'CALENDAR').find((c) => c.clndr_id === t.clndr_id);
        if (cal?.proj_id && cal.proj_id !== P.proj_id) { h.warn(`copy_activities ${t.task_code}: the copy keeps calendar "${cal.clndr_name}", a project calendar of the old project.`); }
      }
      if (db.tables.UDFVALUE) {
        for (const r of realOf(rows(db, 'UDFVALUE')).filter(udfValuesOf('TASK', new Set(map.keys())))) rows(db, 'UDFVALUE').push({ ...r, fk_id: map.get(r.fk_id)!, ...(r.proj_id != null && P ? { proj_id: P.proj_id } : {}) });
        // the UDFs of the assignments go with the assignments
        for (const r of realOf(rows(db, 'UDFVALUE')).filter(udfValuesOf('TASKRSRC', new Set(assigned.keys())))) rows(db, 'UDFVALUE').push({ ...r, fk_id: assigned.get(r.fk_id)!, ...(r.proj_id != null && P ? { proj_id: P.proj_id } : {}) });
      }
      let links = 0;
      if (op.relationships !== false && db.tables.TASKPRED) {
        const R = table(db, 'TASKPRED');
        for (const r of realOf(R.rows).filter((x) => map.has(x.task_id) && map.has(x.pred_task_id))) {
          R.rows.push({ ...r, task_pred_id: String(nextId(db, 'TASKPRED')), task_id: map.get(r.task_id)!, pred_task_id: map.get(r.pred_task_id)!, ...(P ? { proj_id: P.proj_id, pred_proj_id: P.proj_id } : {}) });
          links++;
        }
      }
      dropIndexes(realOf(rows(db, 'TASK')));
      return { copied: pairs.map((p) => p.code), relationships: links };
    }
  }
  return undefined;
}
