export type Row = Record<string, string>;
export interface Table { name: string; fields: string[]; rows: Row[] }
export interface XerHeader { version: string; exportDate: string; raw: string[]; /** text encoding the file was read in */ encoding?: string }
export interface Db { header?: XerHeader; tables: Record<string, Table> }

export function emptyDb(): Db {
  return { tables: {} };
}

export function table(db: Db, name: string): Table {
  return (db.tables[name] ??= { name, fields: [], rows: [] });
}

export function rows(db: Db, name: string): Row[] {
  return db.tables[name]?.rows ?? [];
}

/** Primary key field per table. Tables without an own key (link tables) are absent. */
export const KEYS: Record<string, string> = {
  ACCOUNT: 'acct_id', ACTVCODE: 'actv_code_id', ACTVTYPE: 'actv_code_type_id', CALENDAR: 'clndr_id',
  COSTTYPE: 'cost_type_id', CURRTYPE: 'curr_id', FINDATES: 'fin_dates_id', MEMOTYPE: 'memo_type_id',
  OBS: 'obs_id', PCATTYPE: 'proj_catg_type_id', PCATVAL: 'proj_catg_id', POBS: 'pobs_id',
  PROJCOST: 'cost_item_id', PROJECT: 'proj_id', PROJISSU: 'issue_id', PROJTHRS: 'thresh_id',
  PROJWBS: 'wbs_id', RCATTYPE: 'rsrc_catg_type_id', RCATVAL: 'rsrc_catg_id', ROLERATE: 'role_rate_id',
  ROLES: 'role_id', RSRC: 'rsrc_id', RSRCCURVDATA: 'curv_id', RSRCRATE: 'rsrc_rate_id',
  SCHEDOPTIONS: 'schedoptions_id', TASK: 'task_id', TASKMEMO: 'memo_id',
  TASKPRED: 'task_pred_id', TASKPROC: 'proc_id', TASKRSRC: 'taskrsrc_id', THRSPARM: 'thresh_parm_id',
  UDFTYPE: 'udf_type_id', UMEASURE: 'unit_id', WBSBUDG: 'wbs_budg_id', WBSMEMO: 'wbs_memo_id',
  WBSRSRC: 'wbsrsrc_id', SHIFT: 'shift_id', LOCATION: 'location_id', EPS: 'eps_id',
  ROLELIMIT: 'rolelim_id', NONWORK: 'nonwork_type_id', FINTMPL: 'fintmpl_id', RISKTYPE: 'risk_type_id',
  DOCUMENT: 'doc_id', TASKDOC: 'taskdoc_id',
};

const KEY_TO_TABLE: Record<string, string> = Object.fromEntries(Object.entries(KEYS).map(([t, k]) => [k, t]));

const ALIASES: Record<string, string> = {
  pred_task_id: 'TASK', parent_wbs_id: 'PROJWBS', pred_proj_id: 'PROJECT', base_clndr_id: 'CALENDAR',
  parent_rsrc_id: 'RSRC', parent_actv_code_id: 'ACTVCODE', parent_acct_id: 'ACCOUNT', parent_obs_id: 'OBS',
  parent_role_id: 'ROLES', pobs_parent_id: 'POBS', parent_proj_catg_id: 'PCATVAL', parent_rsrc_catg_id: 'RCATVAL',
  orig_proj_id: 'PROJECT', source_proj_id: 'PROJECT', sum_base_proj_id: 'PROJECT', parent_eps_id: 'EPS',
  last_fin_dates_id: 'FINDATES', new_fin_dates_id: 'FINDATES', _eps_id: 'EPS', _baseline_of: 'PROJECT',
};

/** Fields that look like refs but are not (or point outside the XER). */
const NOT_REFS = new Set(['user_id', 'shift_id', 'base_type_id', 'phase_id', 'fk_id', 'guid', 'tmpl_guid', 'pobs_id', 'rsrc_id@TASK']);

/** Table a foreign-key field points to, e.g. pred_task_id -> TASK. Undefined for the table's own key. */
const refCache = new Map<string, string | undefined>(); // called for every field of every row by the writer and importer
export function refTarget(field: string, inTable?: string): string | undefined {
  const ck = field + '@' + (inTable ?? '');
  if (refCache.has(ck)) return refCache.get(ck);
  const v = refTargetUncached(field, inTable);
  refCache.set(ck, v);
  return v;
}
function refTargetUncached(field: string, inTable?: string): string | undefined {
  if (NOT_REFS.has(field) || (inTable && NOT_REFS.has(`${field}@${inTable}`))) return undefined;
  if (inTable && KEYS[inTable] === field) return undefined;
  return ALIASES[field] ?? KEY_TO_TABLE[field];
}

/** Next free numeric id for a table's key. */
export function nextId(db: Db, tableName: string): number {
  const k = KEYS[tableName];
  let max = 0;
  if (k) for (const r of rows(db, tableName)) { const n = Number(r[k]); if (n > max) max = n; }
  return max + 1;
}

export function addField(t: Table, f: string): void {
  if (!t.fields.includes(f)) t.fields.push(f);
}

export function indexBy(rs: Row[], field: string): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of rs) m.set(r[field], r);
  return m;
}

export function groupBy(rs: Row[], field: string): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rs) {
    const k = r[field];
    let a = m.get(k);
    if (!a) m.set(k, (a = []));
    a.push(r);
  }
  return m;
}
