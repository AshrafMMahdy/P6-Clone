import observed from './schema-observed.json' with { type: 'json' };

type Variant = { fields: string[]; sources: string[] };
const OBS = observed.versions as Record<string, Record<string, Variant[]>>;

/** Versions offered in the export wizard (P6 Professional "export as" list). */
export const EXPORT_VERSIONS = ['5.0', '6.0', '6.2', '7.0', '8.1', '8.2', '8.3', '8.4', '15.1', '15.2', '16.1', '16.2', '17.12', '18.8', '19.12', '20.12', '21.12', '22.12', '23.12', '24.12'];

/** Preferred layout source for versions with several observed layouts (the genuine build for that label). */
const PREFERRED_SOURCE: Record<string, string> = { '7.0': 'DHBL-24FEB13_VER-7.0.xer' };

/** Layout fallback chains. A modern P6 build wrote the "6.2" sample (has location_id, no est_wt). */
const MODERN_CHAIN = ['6.2', '7.0', '6.0.0', '5.0'];
const LEGACY_CHAIN = ['6.0.0', '5.0', '5.0.2000', '7.0', '6.2'];

export type Verification = 'exact' | 'modern-build' | 'fallback' | 'none';

function major(v: string): number {
  return Number(v.split('.')[0]) || 0;
}

function canonical(v: string, t: string): string[] | undefined {
  const list = OBS[v]?.[t];
  if (!list?.length) return undefined;
  const pref = PREFERRED_SOURCE[v];
  return (pref && list.find((x) => x.sources.includes(pref)) || list[0]).fields;
}

function chain(version: string): string[] {
  return major(version) >= 8 || version === '6.2' ? MODERN_CHAIN : LEGACY_CHAIN;
}

/** Field list P6 writes for a table at an export version. Undefined for tables P6 layouts we have never seen. */
export function fieldsFor(version: string, tableName: string): string[] | undefined {
  return canonical(version, tableName) ?? chain(version).map((v) => canonical(v, tableName)).find(Boolean);
}

/** All observed layouts of a table at a version (exact label only). */
export function variantsFor(version: string, tableName: string): string[][] {
  return (OBS[version]?.[tableName] ?? []).map((x) => x.fields);
}

export function verification(version: string, tableName: string): Verification {
  if (OBS[version]?.[tableName]) return 'exact';
  if ((major(version) >= 8) && OBS['6.2']?.[tableName]) return 'modern-build';
  return fieldsFor(version, tableName) ? 'fallback' : 'none';
}

/** Every field name ever seen for a table in any real P6 layout. */
export function knownFields(tableName: string): Set<string> {
  const s = new Set<string>();
  for (const v of Object.values(OBS)) for (const x of v[tableName] ?? []) for (const f of x.fields) s.add(f);
  return s;
}

export function knownTables(): Set<string> {
  const s = new Set<string>(observed.tableOrder);
  for (const t of MODERN_ONLY_TABLES) s.add(t);
  return s;
}

/** Tables a modern P6 may emit that the real samples never contained. Order positions are best knowledge. */
const MODERN_ONLY_TABLES = ['NONWORK', 'FINTMPL', 'LOCATION', 'SHIFT', 'SHIFTPER', 'ROLELIMIT', 'RISKTYPE', 'PROJFUND', 'FUNDSRC', 'ISSUHIST', 'TASKFDBK', 'RSRCLEVELLIST', 'TRSRCFIN', 'RSRCHOUR', 'PROJEST', 'DOCUMENT', 'TASKDOC', 'EXPTYPE', 'JOBSVC', 'ASGNMNTCATTYPE', 'ASGNMNTCATVAL', 'ASGNMNTACAT'];

export const TABLE_ORDER: string[] = (() => {
  const order = [...observed.tableOrder];
  const insertBefore = (t: string, before: string) => { if (!order.includes(t)) order.splice(Math.max(0, order.indexOf(before)), 0, t); };
  insertBefore('NONWORK', 'OBS');
  insertBefore('FINTMPL', 'MEMOTYPE');
  insertBefore('LOCATION', 'MEMOTYPE');
  insertBefore('SHIFT', 'UDFTYPE');
  insertBefore('SHIFTPER', 'UDFTYPE');
  insertBefore('ROLELIMIT', 'PROJECT');
  insertBefore('RISKTYPE', 'ROLES');
  // assignment codes (Oracle's XER data map): the code types with the other code types, values with values, the
  // assignments of them after the resource assignments they name
  insertBefore('ASGNMNTCATTYPE', 'COSTTYPE');
  insertBefore('ASGNMNTCATVAL', 'PCATVAL');
  insertBefore('ASGNMNTACAT', 'UDFVALUE');
  for (const t of MODERN_ONLY_TABLES) if (!order.includes(t)) order.push(t);
  return order;
})();

const ORDERS = observed.tableOrders as Record<string, string[]>;

/** Table order P6 writes at a version: that layout's observed order, other tables slotted in by global order. */
export function tableOrderFor(version: string): string[] {
  const base = ORDERS[version] ?? chain(version).map((v) => ORDERS[v]).find(Boolean) ?? [];
  const out = [...base];
  for (const t of TABLE_ORDER) {
    if (out.includes(t)) continue;
    const gi = TABLE_ORDER.indexOf(t);
    let pos = 0;
    out.forEach((u, i) => { const ui = TABLE_ORDER.indexOf(u); if (ui !== -1 && ui < gi) pos = i + 1; });
    out.splice(pos, 0, t);
  }
  return out;
}

/** Valid enum codes per TABLE.field. */
export const ENUMS: Record<string, string[]> = {
  'TASK.task_type': ['TT_Task', 'TT_Rsrc', 'TT_LOE', 'TT_Mile', 'TT_FinMile', 'TT_WBS'],
  'TASK.status_code': ['TK_NotStart', 'TK_Active', 'TK_Complete'],
  'TASK.duration_type': ['DT_FixedDUR2', 'DT_FixedDrtn', 'DT_FixedQty', 'DT_FixedRate'],
  'TASK.complete_pct_type': ['CP_Drtn', 'CP_Phys', 'CP_Units'],
  'TASK.cstr_type': ['', 'CS_MSO', 'CS_MSOB', 'CS_MSOA', 'CS_MEO', 'CS_MEOB', 'CS_MEOA', 'CS_ALAP', 'CS_MANDSTART', 'CS_MANDFIN'],
  'TASK.cstr_type2': ['', 'CS_MSO', 'CS_MSOB', 'CS_MSOA', 'CS_MEO', 'CS_MEOB', 'CS_MEOA', 'CS_ALAP', 'CS_MANDSTART', 'CS_MANDFIN'],
  'TASK.priority_type': ['', 'PT_Top', 'PT_High', 'PT_Normal', 'PT_Low', 'PT_Lowest'],
  'TASKPRED.pred_type': ['PR_FS', 'PR_SS', 'PR_FF', 'PR_SF'],
  'TASKRSRC.rsrc_type': ['', 'RT_Labor', 'RT_Equip', 'RT_Mat'],
  'RSRC.rsrc_type': ['RT_Labor', 'RT_Equip', 'RT_Mat'],
  'CALENDAR.clndr_type': ['CA_Base', 'CA_Rsrc', 'CA_Project'],
  'PROJWBS.status_code': ['WS_Planned', 'WS_Open', 'WS_Closed', 'WS_Whatif', 'WS_Requested'],
  'PROJECT.def_duration_type': ['', 'DT_FixedDUR2', 'DT_FixedDrtn', 'DT_FixedQty', 'DT_FixedRate'],
  'PROJECT.def_complete_pct_type': ['', 'CP_Drtn', 'CP_Phys', 'CP_Units'],
  'PROJECT.def_task_type': ['', 'TT_Task', 'TT_Rsrc', 'TT_LOE', 'TT_Mile', 'TT_FinMile', 'TT_WBS'],
  'PROJECT.critical_path_type': ['', 'CT_TotFloat', 'CT_DrivPath'],
  'PROJECT.def_qty_type': ['', 'QT_Hour', 'QT_Day', 'QT_Week', 'QT_Month', 'QT_Year'],
  'PROJECT.def_rate_type': ['', 'COST_PER_QTY', 'COST_PER_QTY2', 'COST_PER_QTY3', 'COST_PER_QTY4', 'COST_PER_QTY5'],
  'TASKRSRC.rate_type': ['', 'COST_PER_QTY', 'COST_PER_QTY2', 'COST_PER_QTY3', 'COST_PER_QTY4', 'COST_PER_QTY5'],
  'SCHEDOPTIONS.sched_float_type': ['FT_FF', 'FT_SS', 'FT_Min'],
  'SCHEDOPTIONS.sched_calendar_on_relationship_lag': ['rcal_Predecessor', 'rcal_Successor', 'rcal_24Hour', 'rcal_ProjDefault'],
  'SCHEDOPTIONS.sched_outer_depend_type': ['SD_Both', 'SD_None', 'SD_Pred', 'SD_Succ'],
  'UDFTYPE.logical_data_type': ['FT_TEXT', 'FT_START_DATE', 'FT_END_DATE', 'FT_DATE', 'FT_FLOAT_2_DECIMALS', 'FT_INT', 'FT_MONEY', 'FT_STATICTYPE', 'FT_CODE'],
};

export type FieldType = 'date' | 'flag' | 'number' | 'id' | 'text';

const NUMERIC = /(_hr_cnt|_qty|_cost|_pct|_num|_per_hr|_factor|_value|_cnt|_rate|_amt|_wt)$/;
const NOT_NUMERIC = new Set(['curr_symbol', 'name_sep_char', 'ev_compute_type', 'ev_etc_compute_type', 'udf_text', 'decimal_symbol', 'digit_group_symbol']);

export function fieldType(field: string): FieldType {
  if (NOT_NUMERIC.has(field)) return 'text';
  if (field.endsWith('_date') || field === 'cstr_date2' || field === 'udf_date') return 'date';
  if (field.endsWith('_flag')) return 'flag';
  if (field.endsWith('_id')) return 'id';
  if (NUMERIC.test(field) || field === 'udf_number') return 'number';
  return 'text';
}
