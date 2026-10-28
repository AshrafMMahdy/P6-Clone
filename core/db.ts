export type Row = Record<string, string>;
import { realOf } from './journal.ts';
export interface Table { name: string; fields: string[]; rows: Row[] }
export interface XerHeader { version: string; exportDate: string; raw: string[]; /** text encoding the file was read in */ encoding?: string }
export interface Db { header?: XerHeader; tables: Record<string, Table> }

export function emptyDb(): Db {
  return { tables: {} };
}

/** One column's sharing state in a ValuePool. */
export interface PoolColumn { n: number; hits: number; share: boolean }
const WINDOW = 512; // values of a column looked at before deciding whether to share its values

/** Loading a file: values repeated in a column (dates, flags, codes, ids) become one shared string instead of a copy
 *  per row. Columns of mostly distinct values (names, GUIDs) stop sharing after their first WINDOW values, as a pool
 *  entry each would cost more than it saves. `copy` makes the string that is kept (e.g. one that is not a slice). */
export class ValuePool {
  private pool = new Map<string, string>();
  private copy: (s: string) => string;
  constructor(copy = (s: string) => s) { this.copy = copy; }
  column(): PoolColumn { return { n: 0, hits: 0, share: true }; }
  get(c: PoolColumn, v: string): string {
    if (!c.share) return this.copy(v);
    const hit = this.pool.get(v);
    if (hit !== undefined) { v = hit; c.hits++; } else this.pool.set((v = this.copy(v)), v);
    if (++c.n === WINDOW && c.hits < WINDOW / 4) c.share = false;
    return v;
  }
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
  DOCUMENT: 'doc_id', TASKDOC: 'taskdoc_id', UDFCODE: 'udf_code_id', FUNDSRC: 'fund_id',
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

let idCache: WeakMap<Row[], { n: number; last: Row | undefined; max: number }> | null = null;
/** Run fn with nextId remembering each table's highest id: an edit adds rows one at a time, and a scan of the whole
 *  table per new row made a 20,000-row edit quadratic. Valid while rows are only added at the end or removed. */
export function withIdCache<T>(fn: () => T): T {
  const prev = idCache, prevIx = ixCache;
  idCache ??= new WeakMap();
  ixCache ??= new WeakMap();
  try { return fn(); } finally { idCache = prev; ixCache = prevIx; }
}

type Cached = { n: number; last: Row | undefined; ix: unknown };
let ixCache: WeakMap<Row[], Map<string, Cached>> | null = null;
/** Something derived from a table's real rows, kept inside withIdCache like rowIndex: extend(value, from) takes the
 *  rows appended since (false: build it again); outside withIdCache it is built afresh. */
export function tableCache<T>(raw: Row[], name: string, build: () => T, extend: (t: T, from: number) => boolean): T {
  let byName = ixCache?.get(raw), c = byName?.get(name);
  if (!c || raw.length < c.n || (c.n > 0 && raw[c.n - 1] !== c.last) || (raw.length > c.n && !extend(c.ix as T, c.n))) c = { n: 0, last: undefined, ix: build() };
  c.n = raw.length; c.last = raw[raw.length - 1];
  if (ixCache) { if (!byName) ixCache.set(raw, (byName = new Map())); byName.set(name, c); }
  return c.ix as T;
}
/** Positions of a table's real rows by key(row). Inside withIdCache it is kept for the whole edit like nextId's cache
 *  (rows added at the end are indexed as they come; rows taken away rebuild it), so a lookup per operation stays
 *  linear over a 30,000-operation edit; outside, it is built afresh. A key field changed in place: dropIndexes. */
export function rowIndex(raw: Row[], name: string, key: (r: Row) => string): Map<string, number[]> {
  const add = (ix: Map<string, number[]>, from: number) => { for (let i = from; i < raw.length; i++) { const k = key(raw[i]); const l = ix.get(k); if (l) l.push(i); else ix.set(k, [i]); } return true; };
  return tableCache(raw, name, () => { const ix = new Map<string, number[]>(); add(ix, 0); return ix; }, add);
}
export const dropIndexes = (raw: Row[]) => { ixCache?.delete(raw); idCache?.delete(raw); }; // a key changed: its ids too

/** Next free numeric id for a table's key. */
export function nextId(db: Db, tableName: string): number {
  const k = KEYS[tableName];
  if (!k) return 1;
  const raw = realOf(rows(db, tableName)); // read only: the real rows
  let c = idCache?.get(raw);
  // rows taken away and others added since (the last row seen is not where it was): look at everything again
  if (!c || raw.length < c.n || (c.n > 0 && raw[c.n - 1] !== c.last)) c = { n: 0, last: undefined, max: 0 };
  for (let i = c.n; i < raw.length; i++) { const n = Number(raw[i][k]); if (n > c.max) c.max = n; }
  c.n = raw.length; c.last = raw[raw.length - 1];
  idCache?.set(raw, c);
  return c.max + 1;
}

export function addField(t: Table, f: string): void {
  if (!realOf(t.fields).includes(f)) t.fields.push(f); // read the real list: through a recording view, per field per row, it was slow
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
