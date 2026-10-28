// What P6 refuses to hold, checked where the clone lets a value be written anywhere (set_fields, add_row, delete_calendar's
// replacement) and again before a changed project is saved: an ID used twice where P6 needs it unique, a row that is its own
// ancestor (WBS, resources, cost accounts, code values, calendars, roles, OBS, EPS), a relationship from an activity to itself.
// Each check looks at the rows a call changed (`only`) so a flaw the file already had is not blamed on the edit; with no `only`
// it looks at every row (the check before a save).
import { KEYS, refTarget, rows, type Db, type Row } from '../db.ts';
import { realOf } from '../journal.ts';

/** A problem: its message, and a key that names the thing itself (not its count), so a flaw the file already had can be told from one an edit made. */
export interface Problem { key: string; message: string }
interface Unique { table: string; field: string; scope: string[]; what: string; skip?: (r: Row) => boolean }
/** Values P6 holds unique: the field, within the scope fields' values. */
export const UNIQUE: Unique[] = [
  { table: 'TASK', field: 'task_code', scope: ['proj_id'], what: 'Activity ID' },
  { table: 'PROJECT', field: 'proj_short_name', scope: [], what: 'Project ID', skip: (r) => !!r._baseline_of },
  { table: 'RSRC', field: 'rsrc_short_name', scope: [], what: 'Resource ID' },
  { table: 'ROLES', field: 'role_short_name', scope: [], what: 'Role ID' },
  { table: 'PROJWBS', field: 'wbs_short_name', scope: ['proj_id', 'parent_wbs_id'], what: 'WBS code (among the elements under one parent)', skip: (r) => r.proj_node_flag === 'Y' },
  { table: 'ACTVTYPE', field: 'actv_code_type', scope: ['proj_id'], what: 'Activity code type' },
  { table: 'ACTVCODE', field: 'short_name', scope: ['actv_code_type_id', 'parent_actv_code_id'], what: 'Activity code value (among the values of one type under one parent)' },
  { table: 'PCATTYPE', field: 'proj_catg_type', scope: [], what: 'Project code type' },
  { table: 'PCATVAL', field: 'proj_catg_short_name', scope: ['proj_catg_type_id', 'parent_proj_catg_id'], what: 'Project code value (among the values of one type under one parent)' },
  { table: 'RCATTYPE', field: 'rsrc_catg_type', scope: [], what: 'Resource code type' },
  { table: 'RCATVAL', field: 'rsrc_catg_short_name', scope: ['rsrc_catg_type_id', 'parent_rsrc_catg_id'], what: 'Resource code value (among the values of one type under one parent)' },
  { table: 'ACCOUNT', field: 'acct_short_name', scope: ['parent_acct_id'], what: 'Cost account ID (among the accounts under one parent)' },
  { table: 'EPS', field: 'eps_short_name', scope: ['parent_eps_id'], what: 'EPS ID (among the nodes under one parent)' },
  { table: 'UDFTYPE', field: 'udf_type_label', scope: ['table_name'], what: 'User-defined field title' },
];

const label = (r: Row, T: string): string => String(r[UNIQUE.find((u) => u.table === T)?.field ?? ''] ?? r[KEYS[T]] ?? '');

/** The ID problems of the rows of `table` (`only`, else all): a value another row of the same scope also has. */
export function duplicates(db: Db, table: string, only?: Row[]): Problem[] {
  const out: Problem[] = [];
  for (const u of UNIQUE.filter((x) => x.table === table)) {
    const all = realOf(rows(db, table)).filter((r) => !u.skip?.(r) && String(r[u.field] ?? '') !== '');
    const key = (r: Row) => [...u.scope.map((f) => r[f] ?? ''), r[u.field]].join('\u0001');
    const count = new Map<string, number>();
    for (const r of all) count.set(key(r), (count.get(key(r)) ?? 0) + 1);
    const seen = new Set<string>();
    for (const r of only ? only.filter((x) => !u.skip?.(x) && String(x[u.field] ?? '') !== '') : all) {
      const k = key(r);
      if ((count.get(k) ?? 0) < 2 || seen.has(k)) continue;
      seen.add(k);
      out.push({ key: `dup|${table}|${u.field}|${k}`, message: `${u.what} "${r[u.field]}" would be used by ${count.get(k)} ${table} rows${u.scope.includes('proj_id') && r.proj_id ? ` in project ${r.proj_id}` : ''}; P6 needs it unique.` });
    }
  }
  return out;
}

/** The parent fields of a table: those that point at the table itself (parent_wbs_id, parent_rsrc_id, base_clndr_id...). */
export const parentFields = (db: Db, table: string): string[] => (db.tables[table] ? realOf(db.tables[table].fields) : []).filter((f) => f !== KEYS[table] && refTarget(f, table) === table);

/** The cycle problems of the rows of `table` (`only`, else all): a row that is its own ancestor. */
export function cycles(db: Db, table: string, only?: Row[]): Problem[] {
  const out: Problem[] = [], key = KEYS[table];
  if (!key || !db.tables[table]) return out;
  const all = realOf(rows(db, table));
  for (const f of parentFields(db, table)) {
    const byId = new Map(all.map((r) => [r[key], r]));
    for (const r of only ?? all) {
      const seen = new Set<string>([r[key]]);
      for (let x: Row | undefined = byId.get(r[f]), n = 0; x; x = byId.get(x[f]), n++) {
        if (seen.has(x[key])) { out.push({ key: `cycle|${table}|${f}|${r[key]}`, message: `${table}.${f}: ${label(r, table) || r[key]} would be its own ancestor (a parent cycle); P6 rejects that.` }); break; }
        seen.add(x[key]);
        if (n > all.length) break;
      }
      if (out.length > 20) return out;
    }
  }
  return out;
}

/** Relationships from an activity to itself. */
export const selfLinks = (rs: Row[]): Problem[] => rs.filter((r) => r.task_id && r.task_id === r.pred_task_id).map((r) => ({ key: `self|${r.task_pred_id ?? r.task_id}`, message: `TASKPRED: activity ${r.task_id} would be its own predecessor.` }));

/** Everything P6 refuses in the rows a call changed. */
export function problemsIn(db: Db, table: string, only?: Row[]): Problem[] {
  return [...duplicates(db, table, only), ...cycles(db, table, only), ...(table === 'TASKPRED' ? selfLinks(only ?? realOf(rows(db, 'TASKPRED'))) : [])];
}

/** What P6 would reject in the project(s) to be saved (all of the file when projIds is not given): checked before a changed project is written. */
export function p6Refusals(db: Db, projIds?: string[]): Problem[] {
  const inScope = projIds ? new Set(projIds) : null;
  const out: Problem[] = [];
  for (const t of Object.keys(db.tables)) {
    if (t.startsWith('_')) continue;
    const rs = realOf(rows(db, t));
    const only = inScope && realOf(db.tables[t].fields).includes('proj_id') ? rs.filter((r) => inScope.has(r.proj_id)) : undefined;
    if (UNIQUE.some((u) => u.table === t) || parentFields(db, t).length || t === 'TASKPRED') out.push(...problemsIn(db, t, only));
  }
  return out;
}
