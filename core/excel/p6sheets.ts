// P6-style spreadsheet export and import (File > Export / Import > Spreadsheet in P6), as Oracle's XLSX Import/Export
// Data Map lays it out: one sheet per subject area (TASK Activities, TASKPRED Relationships, PROJCOST Expenses, RSRC
// Resources, TASKRSRC Resource Assignments), row 1 the field names P6 matches on, row 2 the column titles ("(*)" marks a
// calculated column, read back never), data from row 3. Activity, resource, assignment and project codes are columns
// actv_code_<type id>_id / rsrc_catg_<id>_id / asgnmnt_catg_<id>_id / proj_catg_<id>_id, UDFs user_field_<udf id>. A
// template picks the subject areas and the columns of each (P6's Modify Template); the columns P6 requires are always
// written. Import turns the sheets into edit operations (core/project/ops.ts) so they are checked, previewed and applied
// as one undoable step; a row P6 would refuse is skipped and reported (P6's import log), the rest is applied.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { durationPct } from '../progress/update.ts';
import { applyOps, type Op, type OpsOptions } from '../project/ops.ts';
import { dayHours } from '../project/units.ts';
import type { Cell, Sheet } from './xlsx.ts';

export const TYPE_LABEL: Record<string, string> = { TT_Task: 'Task Dependent', TT_Rsrc: 'Resource Dependent', TT_Mile: 'Start Milestone', TT_FinMile: 'Finish Milestone', TT_LOE: 'Level of Effort', TT_WBS: 'WBS Summary' };
export const CSTR_LABEL: Record<string, string> = { CS_MSO: 'Start On', CS_MSOA: 'Start On or After', CS_MSOB: 'Start On or Before', CS_MEO: 'Finish On', CS_MEOA: 'Finish On or After', CS_MEOB: 'Finish On or Before', CS_MANDSTART: 'Mandatory Start', CS_MANDFIN: 'Mandatory Finish', CS_ALAP: 'As Late As Possible' };
const STATUS_LABEL: Record<string, string> = { TK_NotStart: 'Not Started', TK_Active: 'In Progress', TK_Complete: 'Completed' };
const RTYPE_LABEL: Record<string, string> = { RT_Labor: 'Labor', RT_Equip: 'Nonlabor', RT_Mat: 'Material' };
const REL_LABEL: Record<string, string> = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };
const PCT_LABEL: Record<string, string> = { CP_Drtn: 'Duration', CP_Phys: 'Physical', CP_Units: 'Units' };

/** The subject areas, in the order P6 writes them, with their titles. */
export const SHEETS = ['TASK', 'TASKPRED', 'PROJCOST', 'RSRC', 'TASKRSRC'] as const;
export type SheetName = (typeof SHEETS)[number];
export const SHEET_TITLES: Record<SheetName, string> = { TASK: 'Activities', TASKPRED: 'Activity Relationships', PROJCOST: 'Expenses', RSRC: 'Resources', TASKRSRC: 'Resource Assignments' };

/** A column a sheet can carry. calc: calculated or for reference only, never imported ("(*)" in its title).
 *  required: P6 always writes it and needs it to import the sheet. */
export interface ColumnDef { field: string; title: string; calc?: boolean; required?: boolean }
/** P6's Modify Template: the subject areas to write and, per sheet, its columns (field names; "*" = every column,
 *  "actv_code_*", "rsrc_catg_*", "asgnmnt_catg_*", "proj_catg_*" = every code column of that kind, "user_field_*" every
 *  UDF column). A sheet left out of columns gets its default columns. */
export interface ExportTemplate { sheets?: string[]; columns?: Record<string, string[]> }

interface Col extends ColumnDef { get: (r: Row) => Cell }

const days = (h: string | undefined, hpd: number) => h === '' || h == null ? null : Math.round((Number(h) / hpd) * 100) / 100;
const date = (s: string | undefined) => { const m = parseP6Date(s); return m == null ? null : new Date(m * 60000); };
const n0 = (v: string | undefined) => Number(v || 0);
const round = (v: number) => Math.round(v * 100) / 100;
const lc = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** Code subjects as columns: the code type, value and assignment tables, and the column prefix. */
const CODES = {
  activity: { prefix: 'actv_code_', type: 'ACTVTYPE', tid: 'actv_code_type_id', tname: 'actv_code_type', val: 'ACTVCODE', vid: 'actv_code_id', vparent: 'parent_actv_code_id', vshort: 'short_name', link: 'TASKACTV', fk: 'task_id' },
  project: { prefix: 'proj_catg_', type: 'PCATTYPE', tid: 'proj_catg_type_id', tname: 'proj_catg_type', val: 'PCATVAL', vid: 'proj_catg_id', vparent: 'parent_proj_catg_id', vshort: 'proj_catg_short_name', link: 'PROJPCAT', fk: 'proj_id' },
  resource: { prefix: 'rsrc_catg_', type: 'RCATTYPE', tid: 'rsrc_catg_type_id', tname: 'rsrc_catg_type', val: 'RCATVAL', vid: 'rsrc_catg_id', vparent: 'parent_rsrc_catg_id', vshort: 'rsrc_catg_short_name', link: 'RSRCRCAT', fk: 'rsrc_id' },
  assignment: { prefix: 'asgnmnt_catg_', type: 'ASGNMNTCATTYPE', tid: 'asgnmnt_catg_type_id', tname: 'asgnmnt_catg_type', val: 'ASGNMNTCATVAL', vid: 'asgnmnt_catg_id', vparent: 'parent_asgnmnt_catg_id', vshort: 'asgnmnt_catg_short_name', link: 'ASGNMNTACAT', fk: 'taskrsrc_id' },
} as const;
type CodeKind = keyof typeof CODES;
interface CodeType { kind: CodeKind; type: Row; field: string; name: string; byId: Map<string, Row>; path: (vid: string) => string; of: Map<string, string> /* fk -> value id */ }
/** The P6 table whose UDFs a sheet carries. */
const UDF_TABLE: Partial<Record<SheetName, string>> = { TASK: 'TASK', PROJCOST: 'PROJCOST', RSRC: 'RSRC', TASKRSRC: 'TASKRSRC' };
const UDF_TARGET: Record<string, string> = { TASK: 'activity', PROJCOST: 'expense', RSRC: 'resource', TASKRSRC: 'assignment' };

/** What a workbook of these projects is read and written against: names for ids, codes, UDFs. */
function context(db: Db, projIds: string[], hpd: number, calendarDays: boolean) {
  const dh = dayHours(db, hpd, calendarDays);
  const ids = new Set(projIds);
  const proj = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p]));
  const W = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w]));
  const wbsCode = (id: string) => { const out: string[] = []; for (let w = W.get(id), n = 0; w && n < W.size; w = W.get(w.parent_wbs_id), n++) out.unshift(w.proj_node_flag === 'Y' ? proj.get(w.proj_id)?.proj_short_name ?? w.wbs_short_name : w.wbs_short_name); return out.join('.'); };
  const name = (table: string, key: string, field: string) => new Map(rows(db, table).map((r) => [r[key], r[field]]));
  const calName = name('CALENDAR', 'clndr_id', 'clndr_name'), roleName = name('ROLES', 'role_id', 'role_short_name'), acctName = name('ACCOUNT', 'acct_id', 'acct_short_name');
  const curveName = name('RSRCCURVDATA', 'curv_id', 'curv_name'), unitName = name('UMEASURE', 'unit_id', 'unit_abbrev');
  const allTasks = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const rsrc = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r]));
  const rate = new Map(rows(db, 'RSRCRATE').map((r) => [r.rsrc_id, r])); // the last rate row of each resource
  const codes = (kind: CodeKind, keep: (t: Row) => boolean = () => true): CodeType[] => {
    const S = CODES[kind];
    const vals = rows(db, S.val), links = rows(db, S.link);
    return rows(db, S.type).filter(keep).map((type) => {
      const tid = type[S.tid];
      const byId = new Map(vals.filter((v) => v[S.tid] === tid).map((v) => [v[S.vid], v]));
      const path = (vid: string) => { const out: string[] = []; for (let x = byId.get(vid), n = 0; x && n <= byId.size; x = byId.get(x[S.vparent]), n++) out.unshift(x[S.vshort]); return out.join('.'); };
      const of = new Map<string, string>();
      for (const l of links) if ((l[S.tid] === tid || byId.has(l[S.vid])) && byId.has(l[S.vid]) && !of.has(l[S.fk])) of.set(l[S.fk], l[S.vid]);
      return { kind, type, field: `${S.prefix}${tid}_id`, name: type[S.tname], byId, path, of };
    });
  };
  const udfValue = new Map(rows(db, 'UDFVALUE').map((v) => [`${v.udf_type_id}|${v.fk_id}`, v]));
  const udfs = (table: string) => rows(db, 'UDFTYPE').filter((u) => u.table_name === table);
  return { dh, ids, proj, wbsCode, W, calName, roleName, acctName, curveName, unitName, allTasks, rsrc, rate, codes, udfValue, udfs };
}
type Ctx = ReturnType<typeof context>;

const isDateUdf = (u: Row) => /DATE/.test(u.logical_data_type);
const isTextUdf = (u: Row) => u.logical_data_type === 'FT_TEXT';
/** An indicator UDF (P6's traffic lights): its value is P6's icon code (UDF_G0 to UDF_G4) held as text. */
const isIndicator = (u: Row) => u.logical_data_type === 'FT_STATICTYPE';
const udfCell = (c: Ctx, u: Row, fk: string, codes?: Map<string, string>): Cell => {
  const v = c.udfValue.get(`${u.udf_type_id}|${fk}`);
  if (!v) return null;
  if (isIndicator(u)) return v.udf_text || (codes?.get(v.udf_code_id) ?? v.udf_code_id) || null;
  return isDateUdf(u) ? date(v.udf_date) : isTextUdf(u) ? v.udf_text : v.udf_number === '' || v.udf_number == null ? null : Number(v.udf_number);
};

/** Every column each sheet can carry, for these projects (codes and UDFs included). */
function allColumns(db: Db, c: Ctx): Record<SheetName, Col[]> {
  const pid = (id: string) => c.proj.get(id)?.proj_short_name ?? '';
  const code = (t: Row | undefined) => t?.task_code ?? '';
  const udfCodes = new Map(rows(db, 'UDFCODE').map((x) => [x.udf_code_id, x.short_name]));
  const udfCols = (table: string, fk: (r: Row) => string): Col[] => c.udfs(table).map((u) => ({ field: `user_field_${u.udf_type_id}`, title: u.udf_type_label, calc: false, get: (r: Row) => udfCell(c, u, fk(r), udfCodes) }));
  const codeCols = (kind: CodeKind, fk: (r: Row) => string, calc: boolean, keep?: (t: Row) => boolean): Col[] =>
    c.codes(kind, keep).map((ct) => ({ field: ct.field, title: ct.name, calc, get: (r: Row) => { const v = ct.of.get(fk(r)); return v ? ct.path(v) : null; } }));
  const tdh = (t: Row | undefined) => c.dh.task(t);
  const start = (t: Row | undefined) => date(t && (t.act_start_date || t.early_start_date || t.restart_date || t.target_start_date));
  const finish = (t: Row | undefined) => date(t && (t.act_end_date || t.early_end_date || t.reend_date || t.target_end_date));
  const status = (t: Row | undefined) => (t ? STATUS_LABEL[t.status_code] ?? t.status_code : null);
  const projCodes = codeCols('project', (t) => t.proj_id, true);
  const task: Col[] = [
    { field: 'proj_id', title: 'Project ID', required: true, get: (t) => pid(t.proj_id) },
    { field: 'task_code', title: 'Activity ID', required: true, get: (t) => t.task_code },
    { field: 'status_code', title: 'Activity Status', required: true, get: status },
    { field: 'wbs_id', title: 'WBS Code', required: true, get: (t) => c.wbsCode(t.wbs_id) },
    { field: 'task_name', title: 'Activity Name', get: (t) => t.task_name },
    { field: 'task_type', title: 'Activity Type', get: (t) => TYPE_LABEL[t.task_type] ?? t.task_type },
    { field: 'target_drtn_hr_cnt', title: 'Original Duration(d)', get: (t) => days(t.target_drtn_hr_cnt, tdh(t)) },
    { field: 'remain_drtn_hr_cnt', title: 'Remaining Duration(d)', get: (t) => days(t.remain_drtn_hr_cnt, tdh(t)) },
    { field: 'start_date', title: 'Start', calc: true, get: start },
    { field: 'end_date', title: 'Finish', calc: true, get: finish },
    { field: 'act_start_date', title: 'Actual Start', get: (t) => date(t.act_start_date) },
    { field: 'act_end_date', title: 'Actual Finish', get: (t) => date(t.act_end_date) },
    { field: 'complete_pct', title: 'Activity % Complete', get: (t) => round(t.complete_pct_type === 'CP_Phys' && !t.act_end_date ? n0(t.phys_complete_pct) : durationPct(t)) },
    { field: 'complete_pct_type', title: 'Percent Complete Type', get: (t) => PCT_LABEL[t.complete_pct_type] ?? t.complete_pct_type ?? null },
    { field: 'cstr_type', title: 'Primary Constraint', get: (t) => CSTR_LABEL[t.cstr_type] ?? '' },
    { field: 'cstr_date', title: 'Primary Constraint Date', get: (t) => date(t.cstr_date) },
    { field: 'cstr_type2', title: 'Secondary Constraint', get: (t) => CSTR_LABEL[t.cstr_type2] ?? '' },
    { field: 'cstr_date2', title: 'Secondary Constraint Date', get: (t) => date(t.cstr_date2) },
    { field: 'total_float_hr_cnt', title: 'Total Float(d)', calc: true, get: (t) => days(t.total_float_hr_cnt, tdh(t)) },
    { field: 'clndr_id', title: 'Calendar', get: (t) => c.calName.get(t.clndr_id) ?? '' },
    ...codeCols('activity', (t) => t.task_id, false, (ty) => !ty.proj_id || c.ids.has(ty.proj_id)),
    ...udfCols('TASK', (t) => t.task_id),
    ...projCodes,
    { field: 'delete_record_flag', title: 'Delete This Row', required: true, get: () => '' },
  ];
  const pred: Col[] = [
    { field: 'pred_proj_id', title: 'Predecessor Project', required: true, get: (p) => pid(c.allTasks.get(p.pred_task_id)?.proj_id ?? '') },
    { field: 'pred_task_id', title: 'Predecessor', required: true, get: (p) => code(c.allTasks.get(p.pred_task_id)) },
    { field: 'proj_id', title: 'Successor Project', required: true, get: (p) => pid(c.allTasks.get(p.task_id)?.proj_id ?? '') },
    { field: 'task_id', title: 'Successor', required: true, get: (p) => code(c.allTasks.get(p.task_id)) },
    { field: 'pred_type', title: 'Relationship Type', required: true, get: (p) => REL_LABEL[p.pred_type] ?? p.pred_type },
    { field: 'lag_hr_cnt', title: 'Lag(d)', get: (p) => days(p.lag_hr_cnt, c.dh.rel(p)) ?? 0 },
    { field: 'pred_task_name', title: 'Predecessor Activity Name', calc: true, get: (p) => c.allTasks.get(p.pred_task_id)?.task_name ?? null },
    { field: 'pred_status_code', title: 'Predecessor Activity Status', calc: true, get: (p) => status(c.allTasks.get(p.pred_task_id)) },
    { field: 'pred_wbs_id', title: 'Predecessor WBS', calc: true, get: (p) => c.wbsCode(c.allTasks.get(p.pred_task_id)?.wbs_id ?? '') },
    { field: 'task_name', title: 'Successor Activity Name', calc: true, get: (p) => c.allTasks.get(p.task_id)?.task_name ?? null },
    { field: 'status_code', title: 'Successor Activity Status', calc: true, get: (p) => status(c.allTasks.get(p.task_id)) },
    { field: 'wbs_id', title: 'Successor WBS', calc: true, get: (p) => c.wbsCode(c.allTasks.get(p.task_id)?.wbs_id ?? '') },
    { field: 'delete_record_flag', title: 'Delete This Row', required: true, get: () => '' },
  ];
  const cost: Col[] = [
    { field: 'proj_id', title: 'Project ID', required: true, get: (x) => pid(x.proj_id) },
    { field: 'task_id', title: 'Activity ID', required: true, get: (x) => code(c.allTasks.get(x.task_id)) },
    { field: 'status_code', title: 'Activity Status', calc: true, required: true, get: (x) => status(c.allTasks.get(x.task_id)) },
    { field: 'cost_name', title: 'Expense Item', required: true, get: (x) => x.cost_name },
    { field: 'acct_id', title: 'Cost Account ID', get: (x) => c.acctName.get(x.acct_id) ?? '' },
    { field: 'target_cost', title: 'Budgeted Cost', get: (x) => n0(x.target_cost) },
    { field: 'act_cost', title: 'Actual Cost', get: (x) => n0(x.act_cost) },
    { field: 'remain_cost', title: 'Remaining Cost', get: (x) => n0(x.remain_cost) },
    { field: 'total_cost', title: 'At Completion Cost', calc: true, get: (x) => n0(x.act_cost) + n0(x.remain_cost) },
    { field: 'target_qty', title: 'Budgeted Units', get: (x) => n0(x.target_qty) },
    { field: 'act_units', title: 'Actual Units', get: (x) => (n0(x.cost_per_qty) > 0 ? round(n0(x.act_cost) / n0(x.cost_per_qty)) : null) },
    { field: 'remain_units', title: 'Remaining Units', get: (x) => (n0(x.cost_per_qty) > 0 ? round(n0(x.remain_cost) / n0(x.cost_per_qty)) : null) },
    { field: 'at_completion_units', title: 'At Completion Units', calc: true, get: (x) => (n0(x.cost_per_qty) > 0 ? round((n0(x.act_cost) + n0(x.remain_cost)) / n0(x.cost_per_qty)) : null) },
    { field: 'cost_per_qty', title: 'Price / Unit', get: (x) => n0(x.cost_per_qty) },
    { field: 'qty_name', title: 'Unit of Measure', get: (x) => x.qty_name ?? '' },
    { field: 'vendor_name', title: 'Vendor', get: (x) => x.vendor_name ?? '' },
    { field: 'po_number', title: 'Document Number', get: (x) => x.po_number ?? '' },
    { field: 'cost_descr', title: 'Expense Description', get: (x) => x.cost_descr ?? '' },
    ...udfCols('PROJCOST', (x) => x.cost_item_id),
    { field: 'delete_record_flag', title: 'Delete This Row', required: true, get: () => '' },
  ];
  const res: Col[] = [
    { field: 'rsrc_short_name', title: 'Resource ID', required: true, get: (r) => r.rsrc_short_name },
    { field: 'rsrc_name', title: 'Resource Name', get: (r) => r.rsrc_name },
    { field: 'rsrc_type', title: 'Resource Type', get: (r) => RTYPE_LABEL[r.rsrc_type] ?? r.rsrc_type },
    { field: 'max_qty_per_hr', title: 'Max Units / Day', get: (r) => (c.rate.get(r.rsrc_id)?.max_qty_per_hr ? round(n0(c.rate.get(r.rsrc_id)!.max_qty_per_hr) * c.dh.cal(r.clndr_id)) : null) },
    { field: 'cost_per_qty', title: 'Price / Unit', get: (r) => (c.rate.get(r.rsrc_id)?.cost_per_qty ? n0(c.rate.get(r.rsrc_id)!.cost_per_qty) : null) },
    { field: 'def_qty_per_hr', title: 'Default Units / Day', get: (r) => (r.def_qty_per_hr === '' || r.def_qty_per_hr == null ? null : round(n0(r.def_qty_per_hr) * c.dh.cal(r.clndr_id))) },
    { field: 'clndr_id', title: 'Calendar', get: (r) => c.calName.get(r.clndr_id) ?? '' },
    { field: 'role_id', title: 'Role ID', get: (r) => c.roleName.get(r.role_id) ?? '' },
    { field: 'unit_id', title: 'Unit of Measure', get: (r) => c.unitName.get(r.unit_id) ?? '' },
    { field: 'rsrc_title_name', title: 'Title', get: (r) => r.rsrc_title_name ?? '' },
    { field: 'employee_code', title: 'Employee ID', get: (r) => r.employee_code ?? '' },
    { field: 'email_addr', title: 'Email Address', get: (r) => r.email_addr ?? '' },
    { field: 'office_phone', title: 'Office Phone', get: (r) => r.office_phone ?? '' },
    { field: 'other_phone', title: 'Other Phone', get: (r) => r.other_phone ?? '' },
    { field: 'user_id', title: 'User Login Name', get: (r) => r.user_id ?? '' },
    ...codeCols('resource', (r) => r.rsrc_id, false),
    ...udfCols('RSRC', (r) => r.rsrc_id),
  ];
  const at = (a: Row) => c.allTasks.get(a.task_id);
  const asgDur = (a: Row, which: 'target' | 'remain') => {
    const own = a[`${which}_drtn_hr_cnt`], qty = n0(a[`${which}_qty`]), rate = n0(a[`${which}_qty_per_hr`]), t = at(a);
    const h = own !== '' && own != null ? Number(own) : rate > 0 && qty > 0 ? qty / rate : n0(t?.[`${which}_drtn_hr_cnt`]);
    return days(String(h), tdh(t));
  };
  const asg: Col[] = [
    { field: 'proj_id', title: 'Project ID', required: true, get: (a) => pid(a.proj_id) },
    { field: 'task_id', title: 'Activity ID', required: true, get: (a) => code(at(a)) },
    { field: 'status_code', title: 'Activity Status', calc: true, required: true, get: (a) => status(at(a)) },
    { field: 'rsrc_id', title: 'Resource ID', required: true, get: (a) => c.rsrc.get(a.rsrc_id)?.rsrc_short_name ?? '' },
    { field: 'role_id', title: 'Role ID', required: true, get: (a) => c.roleName.get(a.role_id) ?? '' },
    { field: 'acct_id', title: 'Cost Account ID', required: true, get: (a) => c.acctName.get(a.acct_id) ?? '' },
    { field: 'target_qty', title: 'Budgeted Units', get: (a) => n0(a.target_qty) },
    { field: 'remain_qty', title: 'Remaining Units', get: (a) => n0(a.remain_qty) },
    { field: 'act_qty', title: 'Actual Units', get: (a) => n0(a.act_reg_qty) + n0(a.act_ot_qty) },
    { field: 'total_qty', title: 'At Completion Units', calc: true, get: (a) => n0(a.act_reg_qty) + n0(a.act_ot_qty) + n0(a.remain_qty) },
    { field: 'effort_complete_pct', title: 'Units % Complete', get: (a) => { const done = n0(a.act_reg_qty) + n0(a.act_ot_qty), all = done + n0(a.remain_qty); return all > 0 ? round((done / all) * 100) : 0; } },
    { field: 'target_cost', title: 'Budgeted Cost', get: (a) => n0(a.target_cost) },
    { field: 'act_cost', title: 'Actual Cost', get: (a) => n0(a.act_reg_cost) + n0(a.act_ot_cost) },
    { field: 'remain_cost', title: 'Remaining Cost', get: (a) => n0(a.remain_cost) },
    { field: 'total_cost', title: 'At Completion Cost', calc: true, get: (a) => n0(a.act_reg_cost) + n0(a.act_ot_cost) + n0(a.remain_cost) },
    { field: 'act_this_per_qty', title: 'Actual This Period Units', get: (a) => n0(a.act_this_per_qty) },
    { field: 'act_this_per_cost', title: 'Actual This Period Cost', get: (a) => n0(a.act_this_per_cost) },
    { field: 'start_date', title: 'Start', calc: true, get: (a) => date(a.act_start_date || a.restart_date || a.target_start_date) },
    { field: 'end_date', title: 'Finish', calc: true, get: (a) => date(a.act_end_date || a.reend_date || a.target_end_date) },
    { field: 'act_start_date', title: 'Actual Start', get: (a) => date(a.act_start_date) },
    { field: 'act_end_date', title: 'Actual Finish', get: (a) => date(a.act_end_date) },
    { field: 'target_drtn_hr_cnt', title: 'Original Duration(d)', get: (a) => asgDur(a, 'target') },
    { field: 'remain_drtn_hr_cnt', title: 'Remaining Duration(d)', get: (a) => asgDur(a, 'remain') },
    { field: 'remain_lag_drtn_hr_cnt', title: 'Remaining Lag(d)', get: (a) => days(a.relag_drtn_hr_cnt || '0', tdh(at(a))) },
    { field: 'remain_qty_per_hr', title: 'Remaining Units / Day', get: (a) => round(n0(a.remain_qty_per_hr) * tdh(at(a))) },
    { field: 'curv_id', title: 'Curve', get: (a) => c.curveName.get(a.curv_id) ?? '' },
    { field: 'cost_per_qty', title: 'Price / Unit', calc: true, get: (a) => n0(a.cost_per_qty) },
    { field: 'rsrc_type', title: 'Resource Type', calc: true, get: (a) => { const t = c.rsrc.get(a.rsrc_id)?.rsrc_type ?? a.rsrc_type; return t ? RTYPE_LABEL[t] ?? t : null; } },
    // the resource's own unit of measure (an assignment holds none of its own in P6's tables): for reference
    { field: 'unit_of_measure', title: 'Unit of Measure', calc: true, get: (a) => c.unitName.get(c.rsrc.get(a.rsrc_id)?.unit_id ?? '') ?? '' },
    ...codeCols('assignment', (a) => a.taskrsrc_id, false),
    ...codeCols('resource', (a) => a.rsrc_id, true), // the assigned resource's codes: edited on the Resources sheet
    ...udfCols('TASKRSRC', (a) => a.taskrsrc_id),
    { field: 'delete_record_flag', title: 'Delete This Row', required: true, get: () => '' },
  ];
  return { TASK: task, TASKPRED: pred, PROJCOST: cost, RSRC: res, TASKRSRC: asg };
}

/** The columns written when a template does not name a sheet's columns (the clone's long-standing layout, plus the
 *  columns P6 requires). */
const DEFAULTS: Record<SheetName, string[]> = {
  TASK: ['proj_id', 'task_code', 'status_code', 'wbs_id', 'task_name', 'task_type', 'target_drtn_hr_cnt', 'remain_drtn_hr_cnt', 'start_date', 'end_date', 'act_start_date', 'act_end_date', 'complete_pct', 'cstr_type', 'cstr_date', 'total_float_hr_cnt', 'clndr_id', 'delete_record_flag'],
  TASKPRED: ['pred_proj_id', 'pred_task_id', 'proj_id', 'task_id', 'pred_type', 'lag_hr_cnt', 'delete_record_flag'],
  PROJCOST: ['proj_id', 'task_id', 'status_code', 'cost_name', 'acct_id', 'target_cost', 'act_cost', 'remain_cost', 'total_cost', 'delete_record_flag'],
  RSRC: ['rsrc_short_name', 'rsrc_name', 'rsrc_type', 'max_qty_per_hr', 'cost_per_qty'],
  TASKRSRC: ['proj_id', 'task_id', 'status_code', 'rsrc_id', 'role_id', 'acct_id', 'target_qty', 'remain_qty', 'act_qty', 'delete_record_flag'],
};

const sheetName = (s: string): SheetName | undefined => {
  const u = s.trim().toUpperCase();
  return (SHEETS as readonly string[]).includes(u) ? (u as SheetName) : (Object.entries(SHEET_TITLES).find(([, t]) => t.toUpperCase() === u)?.[0] as SheetName | undefined);
};

/** The sheets and columns a template gives, every column a sheet can carry (for a template dialog), and the sheet and
 *  column names it gave that are not there. */
export function templateColumns(db: Db, projIds: string[], template: ExportTemplate = {}, hpd = 8, calendarDays = false): { columns: Partial<Record<SheetName, ColumnDef[]>>; available: Record<SheetName, ColumnDef[]>; unknown: string[] } {
  const all = allColumns(db, context(db, projIds, hpd, calendarDays));
  const unknown: string[] = [];
  const picked = template.sheets?.length ? template.sheets.map((s) => sheetName(s) ?? (unknown.push(s), undefined)).filter((s): s is SheetName => !!s) : [...SHEETS];
  const want = new Map(Object.entries(template.columns ?? {}).map(([k, v]) => [sheetName(k) ?? (unknown.push(k), k), v]));
  const strip = (c: Col): ColumnDef => ({ field: c.field, title: c.title, ...(c.calc ? { calc: true } : {}), ...(c.required ? { required: true } : {}) });
  const columns: Partial<Record<SheetName, ColumnDef[]>> = {};
  for (const s of SHEETS.filter((x) => picked.includes(x))) columns[s] = pick(all[s], want.get(s) ?? DEFAULTS[s], unknown, s).map(strip);
  return { columns, available: Object.fromEntries(SHEETS.map((s) => [s, all[s].map(strip)])) as Record<SheetName, ColumnDef[]>, unknown };
}

/** The columns of a sheet a list of field names (and wildcards) picks, required ones first where P6 puts them. */
function pick(cols: Col[], fields: string[], unknown: string[], sheet: string): Col[] {
  const out = new Set<Col>();
  for (const f of fields) {
    const k = String(f).trim().toLowerCase();
    const hit = k === '*' ? cols : k.endsWith('*') ? cols.filter((c) => c.field.startsWith(k.slice(0, -1))) : cols.filter((c) => c.field === k);
    if (!hit.length && !(k.endsWith('*') && k !== '*')) unknown.push(`${sheet}.${f}`);
    for (const c of hit) out.add(c);
  }
  // the required columns stay, in the sheet's own order around the chosen ones
  return cols.filter((c) => c.required || out.has(c)).sort((a, b) => {
    const ia = fields.findIndex((f) => String(f).toLowerCase() === a.field), ib = fields.findIndex((f) => String(f).toLowerCase() === b.field);
    return ia >= 0 && ib >= 0 ? ia - ib : cols.indexOf(a) - cols.indexOf(b);
  });
}

/** The open project(s) as P6-style sheets, laid out by the template (default: every subject area, default columns). */
export function exportSheets(db: Db, projIds: string[], hpd = 8, calendarDays = false, template: ExportTemplate = {}): Sheet[] {
  const c = context(db, projIds, hpd, calendarDays);
  const all = allColumns(db, c);
  const { columns } = templateColumns(db, projIds, template, hpd, calendarDays);
  const tasks = rows(db, 'TASK').filter((t) => c.ids.has(t.proj_id));
  const taskIds = new Set(tasks.map((t) => t.task_id));
  const data: Record<SheetName, Row[]> = {
    TASK: tasks,
    TASKPRED: rows(db, 'TASKPRED').filter((p) => taskIds.has(p.task_id) || taskIds.has(p.pred_task_id)),
    PROJCOST: rows(db, 'PROJCOST').filter((x) => taskIds.has(x.task_id)),
    RSRC: rows(db, 'RSRC'),
    TASKRSRC: rows(db, 'TASKRSRC').filter((a) => taskIds.has(a.task_id)),
  };
  const out: Sheet[] = [];
  for (const s of SHEETS) {
    const defs = columns[s];
    if (!defs) continue;
    const cols = defs.map((d) => all[s].find((x) => x.field === d.field)!);
    const head: Cell[][] = [cols.map((x) => x.field), cols.map((x) => (x.calc ? `(*)${x.title}` : x.title))];
    const w = cols.map((x) => Math.max(10, Math.min(45, x.field === 'task_name' || x.field === 'rsrc_name' || x.field === 'cost_name' ? 40 : x.title.length + 4)));
    out.push({ name: s, rows: [...head, ...data[s].map((r) => cols.map((x) => x.get(r)))], widths: w, boldRows: 2 });
  }
  out.push({ name: 'USERDATA', rows: [['UserSettings Do Not Edit'], [`DurationQtyType=QT_Day`], [`HoursPerDay=${hpd}`], [`Exported=${formatP6Date(Date.now() / 60000)}`]] });
  return out;
}

export interface ImportSummary {
  activitiesAdded: number; activitiesUpdated: number; activitiesDeleted: number;
  relationshipsAdded: number; relationshipsUpdated: number; relationshipsDeleted: number;
  expensesAdded: number; expensesUpdated: number; expensesDeleted: number;
  resourcesAdded: number; resourcesUpdated: number;
  assignmentsAdded: number; assignmentsUpdated: number; assignmentsDeleted: number;
  unchanged: number;
}
/** Where an operation came from: the sheet and its row as Excel numbers it. */
export interface RowRef { sheet: string; row: number }
export interface ImportPlan {
  ops: Op[];
  /** per operation, its sheet row (rows[i] made ops[i]) */
  rows: RowRef[];
  summary: ImportSummary;
  warnings: string[];
}

const str = (v: Cell) => v == null ? '' : v instanceof Date ? formatP6Date(v.getTime() / 60000) : String(v).trim();
const num = (v: Cell) => { const s = str(v); if (!s) return null; const n = Number(s.replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const yes = (v: Cell) => /^(y|yes|true|1|x)$/i.test(str(v));
const dateOf = (v: Cell) => v instanceof Date ? formatP6Date(v.getTime() / 60000).slice(0, 16) : typeof v === 'number' ? formatP6Date((v - 25569) * 1440).slice(0, 16) : str(v);
const fromLabel = (map: Record<string, string>, v: string) => Object.keys(map).find((k) => k === v || map[k].toLowerCase() === v.toLowerCase());
const near = (a: number | null, b: number | null) => a == null || b == null ? a === b : Math.abs(a - b) < 0.01;
const sameDate = (a: string, b: string | undefined) => (a || '').slice(0, 16) === (b || '').slice(0, 16) || (a.length === 10 && (b || '').startsWith(a));
const has = (r: Record<string, Cell>, f: string) => r[f] !== undefined;
/** A cell (trimmed, as str reads it) against the database's text, trimmed alike: a trailing space P6 kept is no edit. */
const sameText = (cell: string, v: string | undefined) => cell === String(v ?? '').trim();

/** Sheets (from readXlsx) as edit operations against the database, for one target project. */
export function planImport(db: Db, sheets: Sheet[], projectId: string, hpd = 8, calendarDays = false): ImportPlan {
  const c = context(db, [], hpd, calendarDays);
  const dh = c.dh;
  const warnings: string[] = [];
  const s: ImportSummary = { activitiesAdded: 0, activitiesUpdated: 0, activitiesDeleted: 0, relationshipsAdded: 0, relationshipsUpdated: 0, relationshipsDeleted: 0, expensesAdded: 0, expensesUpdated: 0, expensesDeleted: 0, resourcesAdded: 0, resourcesUpdated: 0, assignmentsAdded: 0, assignmentsUpdated: 0, assignmentsDeleted: 0, unchanged: 0 };
  const out: { op: Op; ref: RowRef; rank: number }[] = [];
  const proj = rows(db, 'PROJECT').find((p) => p.proj_short_name === projectId && !p._baseline_of);
  if (!proj) return { ops: [], rows: [], summary: s, warnings: [`No project "${projectId}".`] };
  const P = { project: projectId };
  const sheet = (n: string) => sheets.find((x) => x.name.toUpperCase() === n);
  // row 1 = field names (P6 matches on these); data from the first row that is not the titles row
  const records = (name: string): { r: Record<string, Cell>; ref: RowRef; titles: Map<string, string> }[] => {
    const sh = sheet(name);
    if (!sh || !sh.rows.length) return [];
    const fields = sh.rows[0].map((f) => str(f).toLowerCase());
    const titles = sh.rows[1]?.map(str) ?? [];
    const start = titles.some((t, i) => t && t.toLowerCase() !== fields[i] && !/^\d/.test(t)) ? 2 : 1;
    const tmap = new Map(fields.map((f, i) => [f, start === 2 ? (titles[i] ?? '').replace(/^\(\*\)\s*/, '') : '']));
    const outR: { r: Record<string, Cell>; ref: RowRef; titles: Map<string, string> }[] = [];
    sh.rows.forEach((r, i) => { if (i >= start && r.some((v) => str(v) !== '')) outR.push({ r: Object.fromEntries(fields.map((f, k) => [f, r[k]])), ref: { sheet: name, row: i + 1 }, titles: tmap }); });
    return outR;
  };
  const tasks = rows(db, 'TASK').filter((t) => t.proj_id === proj.proj_id);
  const byCode = new Map(tasks.map((t) => [t.task_code, t]));
  const calByName = new Map(rows(db, 'CALENDAR').map((x) => [lc(x.clndr_name), x]));
  const wbsPath = (id: string) => { const o: string[] = []; for (let w = c.W.get(id), n = 0; w && w.proj_node_flag !== 'Y' && n < c.W.size; w = c.W.get(w.parent_wbs_id), n++) o.unshift(w.wbs_short_name.trim()); return o.join('.'); };
  const emit = (op: Op, ref: RowRef, rank: number) => { out.push({ op, ref, rank }); };

  /** The code and UDF columns of a sheet: compared with the object's values, as assign_code / set_udf operations. */
  const extras = (kind: CodeKind, udfTable: string, fields: string[], titles: Map<string, string>, scopeProj?: string) => {
    const cts = c.codes(kind, kind === 'activity' ? (t) => !t.proj_id || t.proj_id === scopeProj : undefined);
    const S = CODES[kind];
    const codeCols = fields.filter((f) => f.startsWith(S.prefix) && f.endsWith('_id')).map((f) => {
      const mid = f.slice(S.prefix.length, -3);
      const ct = cts.find((x) => x.type[S.tid] === mid) ?? cts.find((x) => lc(x.name) === lc(mid)) ?? cts.find((x) => lc(x.name) === lc(titles.get(f)));
      if (!ct) warnings.push(`${f}: no ${kind} code type ${titles.get(f) || mid} in this file; the column was skipped (P6 does not import code types that do not exist).`);
      return ct ? { f, ct } : null;
    }).filter((x): x is { f: string; ct: CodeType } => !!x);
    const udfTypes = c.udfs(udfTable);
    const udfCols = fields.filter((f) => /^user_field_/.test(f)).map((f) => {
      const id = f.slice('user_field_'.length);
      const u = udfTypes.find((x) => x.udf_type_id === id) ?? udfTypes.find((x) => lc(x.udf_type_label) === lc(titles.get(f)));
      if (!u) warnings.push(`${f}: no UDF ${titles.get(f) || id} for ${UDF_TARGET[udfTable]}s in this file; the column was skipped.`);
      return u ? { f, u } : null;
    }).filter((x): x is { f: string; u: Row } => !!x);
    /** The operations for one row (fk: the object's key when it exists; target: how operations name it). */
    return (r: Record<string, Cell>, fk: string | null, target: Record<string, unknown>, ref: RowRef, rank: number): number => {
      let n = 0;
      for (const { f, ct } of codeCols) {
        const want = str(r[f]);
        const cur = fk ? ct.of.get(fk) : undefined;
        if (cur ? lc(ct.path(cur)) === lc(want) || lc(ct.byId.get(cur)?.[S.vshort]) === lc(want) : !want) continue;
        if (want) {
          const hits = [...ct.byId.values()].filter((v) => lc(ct.path(v[S.vid])) === lc(want) || lc(v[S.vshort]) === lc(want));
          if (hits.length !== 1) { warnings.push(`Row ${ref.row} of ${ref.sheet}: ${ct.name} "${want}" ${hits.length ? 'is ambiguous; use the full path' : 'is not a value of that code; skipped (P6 does not import code values that do not exist)'}.`); continue; }
        }
        emit({ op: 'assign_code', type: ct.name, value: want, ...target }, ref, rank); n++;
      }
      for (const { f, u } of udfCols) {
        const cell = r[f], cur = fk ? c.udfValue.get(`${u.udf_type_id}|${fk}`) : undefined;
        let value: string | number = '';
        if (isDateUdf(u)) { value = dateOf(cell); if (cur ? sameDate(value, cur.udf_date) && !!value === !!cur.udf_date : !value) continue; }
        else if (isTextUdf(u) || isIndicator(u)) { value = str(cell); if (sameText(value, cur?.udf_text)) continue; }
        else { const v = num(cell); if (str(cell) && v == null) { warnings.push(`Row ${ref.row} of ${ref.sheet}: ${u.udf_type_label} "${str(cell)}" is not a number; skipped.`); continue; } if (near(v, cur && cur.udf_number !== '' ? Number(cur.udf_number) : null)) continue; value = v ?? ''; }
        emit({ op: 'set_udf', udf: u.udf_type_label, value, ...target }, ref, rank); n++;
      }
      return n;
    };
  };
  const fieldsOf = (name: string) => (sheet(name)?.rows[0] ?? []).map((f) => str(f).toLowerCase());

  // ---- Resources first: assignments may name a resource the sheet adds
  const R = new Map(rows(db, 'RSRC').map((r) => [lc(r.rsrc_short_name), r]));
  const resRecs = records('RSRC');
  const resExtras = extras('resource', 'RSRC', fieldsOf('RSRC'), resRecs[0]?.titles ?? new Map());
  const lookup = (table: string, key: string, field: string, alt?: string) => { const m = new Map<string, string>(); for (const x of rows(db, table)) { m.set(lc(x[field]), x[key]); if (alt) m.set(lc(x[alt]), x[key]); } return m; };
  const roleId = lookup('ROLES', 'role_id', 'role_short_name'), acctId = lookup('ACCOUNT', 'acct_id', 'acct_short_name'), unitId = lookup('UMEASURE', 'unit_id', 'unit_abbrev', 'unit_name'), curveId = lookup('RSRCCURVDATA', 'curv_id', 'curv_name');
  const named = (m: Map<string, string>, v: string, what: string, ref: RowRef): string | null => { if (!v) return ''; const id = m.get(lc(v)); if (id == null) warnings.push(`Row ${ref.row} of ${ref.sheet}: no ${what} "${v}" in this file; that cell was skipped (P6 does not import dictionary entries that do not exist).`); return id ?? null; };
  for (const { r, ref } of resRecs) {
    const id = str(r.rsrc_short_name);
    if (!id) continue;
    const x = R.get(lc(id)), hd = c.dh.cal(x?.clndr_id);
    let n = 0;
    const ty = has(r, 'rsrc_type') && str(r.rsrc_type) ? fromLabel(RTYPE_LABEL, str(r.rsrc_type)) : undefined;
    if (has(r, 'rsrc_type') && str(r.rsrc_type) && !ty) warnings.push(`Row ${ref.row} of RSRC: unknown resource type "${str(r.rsrc_type)}".`);
    if (!x) {
      const cal = has(r, 'clndr_id') && str(r.clndr_id) ? calByName.get(lc(str(r.clndr_id))) : undefined;
      if (has(r, 'clndr_id') && str(r.clndr_id) && !cal) warnings.push(`Row ${ref.row} of RSRC: no calendar "${str(r.clndr_id)}"; the resource gets the default calendar.`);
      emit({ op: 'add_resource', id, name: str(r.rsrc_name) || id, type: ty === 'RT_Equip' ? 'nonlabor' : ty === 'RT_Mat' ? 'material' : 'labor', ...(num(r.max_qty_per_hr) != null ? { max_units_per_day: num(r.max_qty_per_hr)! } : {}), ...(num(r.cost_per_qty) != null ? { price_per_unit: num(r.cost_per_qty)! } : {}), ...(cal ? { calendar: cal.clndr_name } : {}) }, ref, 0);
      R.set(lc(id), { rsrc_short_name: id } as Row); s.resourcesAdded++;
    } else {
      const upd: Op = { op: 'update_resource', id: x.rsrc_short_name };
      if (has(r, 'rsrc_name') && str(r.rsrc_name) && !sameText(str(r.rsrc_name), x.rsrc_name)) upd.name = str(r.rsrc_name);
      const mx = num(r.max_qty_per_hr), rate = c.rate.get(x.rsrc_id);
      if (has(r, 'max_qty_per_hr') && mx != null && mx > 0 && !near(mx, rate?.max_qty_per_hr ? round(n0(rate.max_qty_per_hr) * hd) : null)) upd.max_units_per_day = mx;
      if (Object.keys(upd).length > 2) { emit(upd, ref, 0); n++; }
      const price = num(r.cost_per_qty);
      if (has(r, 'cost_per_qty') && price != null && !near(price, rate?.cost_per_qty ? n0(rate.cost_per_qty) : null)) {
        emit(rate ? { op: 'set_fields', table: 'RSRCRATE', where: { rsrc_rate_id: rate.rsrc_rate_id }, fields: { cost_per_qty: price } } : { op: 'add_row', table: 'RSRCRATE', fields: { rsrc_id: x.rsrc_id, cost_per_qty: price, max_qty_per_hr: x.def_qty_per_hr || '1' } }, ref, 0); n++;
      }
    }
    // the fields of the resource row itself (a new one's too): set_fields on RSRC by its Resource ID
    const fields: Record<string, unknown> = {};
    if (x && ty && ty !== x.rsrc_type) fields.rsrc_type = ty;
    const cur = (f: string) => x?.[f] ?? '';
    if (has(r, 'def_qty_per_hr') && num(r.def_qty_per_hr) != null && !near(num(r.def_qty_per_hr), x && x.def_qty_per_hr !== '' ? round(n0(x.def_qty_per_hr) * hd) : null)) fields.def_qty_per_hr = num(r.def_qty_per_hr)! / hd;
    if (x && has(r, 'clndr_id') && str(r.clndr_id) && lc(str(r.clndr_id)) !== lc(c.calName.get(x.clndr_id))) { const cal = calByName.get(lc(str(r.clndr_id))); if (cal) fields.clndr_id = cal.clndr_id; else warnings.push(`Row ${ref.row} of RSRC: no calendar "${str(r.clndr_id)}"; that cell was skipped.`); }
    for (const [f, m, what] of [['role_id', roleId, 'role'], ['unit_id', unitId, 'unit of measure']] as const) {
      if (!has(r, f)) continue;
      const v = str(r[f]), curName = f === 'role_id' ? c.roleName.get(cur(f)) : c.unitName.get(cur(f));
      if (lc(v) === lc(curName)) continue;
      const nid = named(m, v, what, ref);
      if (nid != null && nid !== cur(f)) fields[f] = nid;
    }
    for (const f of ['rsrc_title_name', 'employee_code', 'email_addr', 'office_phone', 'other_phone', 'user_id']) if (has(r, f) && !sameText(str(r[f]), cur(f))) fields[f] = str(r[f]);
    if (Object.keys(fields).length) { emit({ op: 'set_fields', table: 'RSRC', where: { rsrc_short_name: x?.rsrc_short_name ?? id }, fields }, ref, 0); n++; }
    n += resExtras(r, x?.rsrc_id ?? null, { resource: x?.rsrc_short_name ?? id }, ref, 0);
    if (x) { if (n) s.resourcesUpdated++; else s.unchanged++; }
  }

  // ---- Activities
  const taskRecs = records('TASK');
  const taskExtras = extras('activity', 'TASK', fieldsOf('TASK'), taskRecs[0]?.titles ?? new Map(), proj.proj_id);
  for (const { r, ref } of taskRecs) {
    const code = str(r.task_code);
    if (!code) continue;
    if (has(r, 'proj_id') && str(r.proj_id) && str(r.proj_id) !== projectId) { warnings.push(`Activity ${code} belongs to project ${str(r.proj_id)}; skipped.`); continue; }
    const t = byCode.get(code);
    if (yes(r.delete_record_flag)) { if (t) { emit({ op: 'delete_activity', id: code, ...P }, ref, 3); s.activitiesDeleted++; } continue; }
    const op: Op = { op: t ? 'update_activity' : 'add_activity', id: code, ...P };
    const name = str(r.task_name);
    if (name && (!t || !sameText(name, t.task_name))) op.name = name;
    if (!t && !name) { warnings.push(`New activity ${code} has no name; skipped.`); continue; }
    // (each code trimmed: a WBS code P6 kept with a trailing space is the same code)
    const wbs = str(r.wbs_id).replace(new RegExp(`^${projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?`), '').split('.').map((x) => x.trim()).join('.');
    if (has(r, 'wbs_id') && (!t || wbs !== wbsPath(t.wbs_id))) op.wbs = wbs || '';
    const type = str(r.task_type);
    if (type) { const code2 = fromLabel(TYPE_LABEL, type); if (!code2) warnings.push(`Activity ${code}: unknown activity type "${type}".`); else if (!t || code2 !== t.task_type) op.type = code2; }
    const od = num(r.target_drtn_hr_cnt), rd = num(r.remain_drtn_hr_cnt);
    if (od != null && (!t || !near(od, days(t.target_drtn_hr_cnt, dh.task(t))))) op.duration_days = od;
    if (t && rd != null && t.act_start_date && !t.act_end_date && !near(rd, days(t.remain_drtn_hr_cnt, dh.task(t)))) op.remaining_days = rd;
    for (const [tf, df, key] of [['cstr_type', 'cstr_date', 'constraint'], ['cstr_type2', 'cstr_date2', 'secondary_constraint']] as const) {
      if (!has(r, tf)) continue;
      const ct = str(r[tf]), cc = ct ? fromLabel(CSTR_LABEL, ct) : '';
      if (cc == null) { warnings.push(`Activity ${code}: unknown constraint "${ct}".`); continue; }
      const cd = dateOf(r[df]);
      if (!t || cc !== (t[tf] || '') || (cc && !sameDate(cd, t[df]))) op[key] = cc ? { type: cc, date: cd || undefined } : 'none';
    }
    const as = dateOf(r.act_start_date), af = dateOf(r.act_end_date);
    if (has(r, 'act_start_date') && (!t ? !!as : !sameDate(as, t.act_start_date) && (as || t.act_start_date))) op.actual_start = as || null;
    if (has(r, 'act_end_date') && (!t ? !!af : !sameDate(af, t.act_end_date) && (af || t.act_end_date))) op.actual_finish = af || null;
    // Activity Status: a status changed with the actual dates left as they were sets or clears them, as P6's import does
    const st = str(r.status_code);
    if (st && op.actual_start === undefined && op.actual_finish === undefined) {
      const want = fromLabel(STATUS_LABEL, st);
      if (!want) warnings.push(`Activity ${code}: unknown status "${st}".`);
      else if (want !== (t?.status_code ?? 'TK_NotStart')) {
        const start = dateOf(r.start_date) || (t ? (t.early_start_date || t.restart_date || t.target_start_date || '').slice(0, 16) : '');
        const finish = dateOf(r.end_date) || (t ? (t.early_end_date || t.reend_date || t.target_end_date || '').slice(0, 16) : '');
        if (want === 'TK_NotStart') { if (t?.act_end_date) op.actual_finish = null; if (t?.act_start_date) op.actual_start = null; }
        else if (!t?.act_start_date && !start) warnings.push(`Activity ${code}: status "${st}" needs a Start date to take as its actual start; skipped.`);
        else { if (!t?.act_start_date) op.actual_start = start; if (want === 'TK_Complete') op.actual_finish = finish || start; else if (t?.act_end_date) op.actual_finish = null; }
      }
    }
    // an actual start cleared while the activity has an actual finish: the finish goes first (P6's order)
    if (t && op.actual_start === null && t.act_end_date) { emit({ op: 'update_activity', id: code, ...P, actual_finish: null }, ref, 0); delete op.actual_finish; }
    const pct = num(r.complete_pct);
    const pctCell = has(r, 'complete_pct_type') && str(r.complete_pct_type) !== (t?.complete_pct_type ?? '') ? str(r.complete_pct_type) : ''; // a value the file has, as written: no edit
    const pctType = pctCell ? fromLabel(PCT_LABEL, pctCell) : undefined;
    if (pctCell && !pctType) warnings.push(`Activity ${code}: unknown percent complete type "${pctCell}".`);
    const pctTypeChanged = !!pctType && pctType !== (t?.complete_pct_type ?? 'CP_Drtn');
    if (t && pct != null && (pctType ?? t.complete_pct_type) === 'CP_Phys' && !near(pct, Number(t.phys_complete_pct || 0)) && (t.act_start_date || op.actual_start)) op.percent_complete = pct;
    const cname = str(r.clndr_id);
    if (cname && (!t || cname !== c.calName.get(t.clndr_id))) op.calendar = cname;
    let n = 0;
    // the % complete type before the % (it says which % the column is); a new activity's after it is added
    const setType = () => { emit({ op: 'set_fields', table: 'TASK', ...P, where: { task_code: code }, fields: { complete_pct_type: pctType } }, ref, 0); n++; };
    if (t && pctTypeChanged) setType();
    if (Object.keys(op).length > 3 || !t) { emit(op, ref, 0); n++; }
    if (!t && pctTypeChanged) setType();
    n += taskExtras(r, t?.task_id ?? null, { activity: code, ...P }, ref, 0);
    if (!t) s.activitiesAdded++; else if (n) s.activitiesUpdated++; else s.unchanged++;
  }

  // ---- Relationships: rows by pair: a row matches the relationship of its type; a row whose type is not on the pair
  // while the pair has a relationship of a type no row names is that relationship with its type edited (replaced: old
  // type removed, new added); only a row left over after that adds a link. A pair the file holds twice (SS + FF) keeps both
  // an end in another project (P6 keeps relationships between projects) is named by its Predecessor / Successor Project
  const PR = rows(db, 'TASKPRED');
  const projByName = new Map(rows(db, 'PROJECT').filter((p) => !p._baseline_of).map((p) => [p.proj_short_name, p.proj_id]));
  const codesOf = new Map<string, Map<string, Row>>([[proj.proj_id, byCode]]);
  const taskOf = (projName: string, code: string) => {
    const pid = projName ? projByName.get(projName) : proj.proj_id;
    if (!pid) return undefined;
    if (!codesOf.has(pid)) codesOf.set(pid, new Map(rows(db, 'TASK').filter((t) => t.proj_id === pid).map((t) => [t.task_code, t])));
    return codesOf.get(pid)!.get(code);
  };
  const recs: { pred: string; succ: string; type: string; r: Record<string, Cell>; ref: RowRef; ends: Record<string, string>; k: string }[] = [];
  for (const { r, ref } of records('TASKPRED')) {
    const pred = str(r.pred_task_id), succ = str(r.task_id);
    if (!pred || !succ) continue;
    const pp = str(r.pred_proj_id), sp = str(r.proj_id);
    if ((pp && !projByName.has(pp)) || (sp && !projByName.has(sp))) { warnings.push(`Relationship ${pred} -> ${succ}: no project ${pp && !projByName.has(pp) ? pp : sp} in this file; skipped.`); continue; }
    const type = str(r.pred_type).toUpperCase().replace(/^PR_/, '') || 'FS';
    if (!['FS', 'SS', 'FF', 'SF'].includes(type)) { warnings.push(`Relationship ${pred} -> ${succ}: unknown type "${type}".`); continue; }
    // operations name an end in another project by that project (the edit's own project otherwise)
    const ends = { ...(pp && pp !== projectId ? { pred_project: pp } : {}), ...(sp && sp !== projectId ? { succ_project: sp } : {}) };
    recs.push({ pred, succ, type, r, ref, ends, k: `${pp}|${pred}|${sp}|${succ}` });
  }
  const namedTypes = new Map<string, Set<string>>();
  for (const x of recs) (namedTypes.get(x.k) ?? namedTypes.set(x.k, new Set()).get(x.k)!).add(x.type);
  const retyped = new Map<string, Row[]>(); // pair -> its relationships whose type no row names
  // the file's relationships by pair (a scan of every relationship per row was quadratic: 32,000 rows took a minute)
  const byPair = new Map<string, Row[]>();
  for (const p of PR) { const k2 = `${p.pred_task_id}|${p.task_id}`; const l = byPair.get(k2); if (l) l.push(p); else byPair.set(k2, [p]); }
  for (const { pred, succ, type, r, ref, ends, k } of recs) {
    const a = taskOf(str(r.pred_proj_id), pred), b = taskOf(str(r.proj_id), succ);
    const onPair = a && b ? byPair.get(`${a.task_id}|${b.task_id}`) ?? [] : [];
    const existing = onPair.find((p) => p.pred_type === `PR_${type}`);
    if (yes(r.delete_record_flag)) { if (existing) { emit({ op: 'delete_relationship', pred, succ, type, ...P, ...ends }, ref, 3); s.relationshipsDeleted++; } continue; }
    const lag = num(r.lag_hr_cnt) ?? 0;
    if (!existing) {
      if (!retyped.has(k)) retyped.set(k, onPair.filter((p) => !namedTypes.get(k)!.has(p.pred_type.replace(/^PR_/, ''))));
      const old = retyped.get(k)!.shift();
      if (old) { emit({ op: 'update_relationship', pred, succ, type: old.pred_type.replace(/^PR_/, ''), new_type: type, lag_days: lag, ...P, ...ends }, ref, 1); s.relationshipsUpdated++; }
      else { emit({ op: 'add_relationship', pred, succ, type, lag_days: lag, ...P, ...ends }, ref, 1); s.relationshipsAdded++; }
    } else if (!near(lag, days(existing.lag_hr_cnt, dh.rel(existing)) ?? 0)) { emit({ op: 'update_relationship', pred, succ, type, lag_days: lag, ...P, ...ends }, ref, 1); s.relationshipsUpdated++; }
    else s.unchanged++;
  }

  // ---- Expenses, by activity and Expense Item
  const costRecs = records('PROJCOST');
  const costExtras = extras('activity', 'PROJCOST', fieldsOf('PROJCOST').filter((f) => f.startsWith('user_field_')), costRecs[0]?.titles ?? new Map());
  const mineT = new Set(tasks.map((t) => t.task_id));
  const costs = new Map<string, Row[]>();
  for (const x of rows(db, 'PROJCOST')) if (mineT.has(x.task_id)) { const l = costs.get(x.task_id); if (l) l.push(x); else costs.set(x.task_id, [x]); }
  for (const { r, ref } of costRecs) {
    const act = str(r.task_id), name = str(r.cost_name);
    if (!act || !name) { if (act || name) warnings.push(`Row ${ref.row} of PROJCOST: an expense needs both Activity ID and Expense Item; skipped.`); continue; }
    if (has(r, 'proj_id') && str(r.proj_id) && str(r.proj_id) !== projectId) { warnings.push(`Expense ${act} / ${name} belongs to project ${str(r.proj_id)}; skipped.`); continue; }
    const t = byCode.get(act);
    const mine = t ? (costs.get(t.task_id) ?? []).filter((x) => lc(x.cost_name) === lc(name)) : [];
    if (mine.length > 1) { warnings.push(`Row ${ref.row} of PROJCOST: activity ${act} has several expenses named "${name}"; skipped.`); continue; }
    const x = mine[0];
    const target = { activity: act, ...P };
    if (yes(r.delete_record_flag)) { if (x) { emit({ op: 'delete_expense', name: x.cost_name, ...target }, ref, 3); s.expensesDeleted++; } continue; }
    const op: Op = { op: x ? 'update_expense' : 'add_expense', name: x?.cost_name ?? name, ...target };
    if (has(r, 'acct_id') && lc(str(r.acct_id)) !== lc(c.acctName.get(x?.acct_id ?? ''))) { const id = named(acctId, str(r.acct_id), 'cost account', ref); if (id != null) op.account = str(r.acct_id); }
    const price = num(r.cost_per_qty) ?? (x ? n0(x.cost_per_qty) : null);
    const numField = (f: string, key: string, curV: number | null) => { const v = num(r[f]); if (has(r, f) && v != null && !near(v, curV)) op[key] = v; };
    numField('target_qty', 'units', x ? n0(x.target_qty) : null);
    numField('cost_per_qty', 'price_per_unit', x ? n0(x.cost_per_qty) : null);
    numField('target_cost', 'budgeted_cost', x ? n0(x.target_cost) : null);
    numField('act_cost', 'actual_cost', x ? n0(x.act_cost) : null);
    numField('remain_cost', 'remaining_cost', x ? n0(x.remain_cost) : null);
    // units entered for actual / remaining: their cost at the price per unit, unless the cost itself was entered
    for (const [f, key, curCost] of [['act_units', 'actual_cost', 'act_cost'], ['remain_units', 'remaining_cost', 'remain_cost']] as const) {
      const u = num(r[f]);
      if (!has(r, f) || u == null || op[key] != null || !(price && price > 0)) continue;
      if (!near(u, x ? round(n0(x[curCost]) / price) : null)) op[key] = round(u * price);
    }
    for (const [f, key] of [['vendor_name', 'vendor'], ['po_number', 'po_number'], ['cost_descr', 'description'], ['qty_name', 'unit_of_measure']] as const) if (has(r, f) && !sameText(str(r[f]), x?.[f])) op[key] = str(r[f]);
    let n = 0;
    if (!x || Object.keys(op).length > 4) { emit(op, ref, 2); n++; }
    n += costExtras(r, x?.cost_item_id ?? null, { expense: x?.cost_name ?? name, ...target }, ref, 2);
    if (!x) s.expensesAdded++; else if (n) s.expensesUpdated++; else s.unchanged++;
  }

  // ---- Resource assignments, by activity and resource, or by activity and role for a role assignment (no resource);
  // the n-th row of a pair is its n-th assignment, as P6 allows the same resource on an activity more than once
  // a project's assignments by activity and resource / role (a scan per row was quadratic on a big sheet)
  const A = new Map<string, Row[]>();
  const who = (x: Row) => x.rsrc_id || `role:${x.role_id}`;
  for (const x of rows(db, 'TASKRSRC')) if (mineT.has(x.task_id)) { const k = `${x.task_id}|${who(x)}`; const l = A.get(k); if (l) l.push(x); else A.set(k, [x]); }
  const asgRecs = records('TASKRSRC');
  const asgExtras = extras('assignment', 'TASKRSRC', fieldsOf('TASKRSRC').filter((f) => f.startsWith('asgnmnt_catg_') || f.startsWith('user_field_')), asgRecs[0]?.titles ?? new Map());
  const seen = new Map<string, number>();
  for (const { r, ref } of asgRecs) {
    const act = str(r.task_id), res = str(r.rsrc_id), roleOnly = !res ? str(r.role_id) : '';
    if (!act || (!res && !roleOnly)) continue;
    if (has(r, 'proj_id') && str(r.proj_id) && str(r.proj_id) !== projectId) { warnings.push(`Assignment ${act} / ${res || roleOnly} belongs to project ${str(r.proj_id)}; skipped.`); continue; }
    const t = byCode.get(act), rr = res ? R.get(lc(res)) : undefined;
    const rid = roleOnly ? roleId.get(lc(roleOnly)) : undefined;
    if (roleOnly && rid == null) { warnings.push(`Row ${ref.row} of TASKRSRC: no role "${roleOnly}" in this file; row skipped.`); continue; }
    const k = `${act}|${res ? lc(res) : `role:${lc(roleOnly)}`}`, nth = seen.get(k) ?? 0;
    seen.set(k, nth + 1);
    const mine = t ? A.get(`${t.task_id}|${res ? rr?.rsrc_id : `role:${rid}`}`) ?? [] : [];
    const a = mine[nth];
    // the assignment named as the operations name it: resource (or the role of a role assignment), nth among several
    const target: Record<string, unknown> = { activity: act, ...(res ? { resource: rr?.rsrc_short_name ?? res } : { assigned_role: roleOnly }), ...(mine.length > 1 && a ? { nth: nth + 1 } : {}), ...P };
    if (yes(r.delete_record_flag)) { if (a) { emit({ op: 'unassign_resource', ...target }, ref, 3); s.assignmentsDeleted++; } continue; }
    const hd = dh.task(t);
    const upd: Op = { op: 'update_assignment', ...target };
    const numField = (f: string, key: string, curV: number | null, scale = 1) => { const v = num(r[f]); if (has(r, f) && v != null && !near(v, curV)) upd[key] = v * scale; };
    const actQty = a ? n0(a.act_reg_qty) + n0(a.act_ot_qty) : null;
    numField('target_qty', 'units', a ? n0(a.target_qty) : null);
    numField('remain_qty', 'remaining_units', a ? n0(a.remain_qty) : null);
    // Actual Units: P6's act_qty (regular + overtime); act_reg_qty is how the clone's own earlier exports named it
    const actF = has(r, 'act_qty') ? 'act_qty' : 'act_reg_qty';
    const au = num(r[actF]);
    if (has(r, actF) && au != null && !near(au, actQty)) upd.actual_units = au - (a ? n0(a.act_ot_qty) : 0);
    const pct = num(r.effort_complete_pct);
    if (a && has(r, 'effort_complete_pct') && pct != null && upd.actual_units == null && upd.remaining_units == null) {
      const total = n0(a.act_reg_qty) + n0(a.act_ot_qty) + n0(a.remain_qty), done = total > 0 ? round((((actQty ?? 0) / total) * 100)) : 0;
      if (!near(pct, done) && total > 0) { upd.actual_units = round((pct / 100) * total) - n0(a.act_ot_qty); upd.remaining_units = round(total - (pct / 100) * total); }
    }
    numField('target_cost', 'budgeted_cost', a ? n0(a.target_cost) : null);
    const ac = num(r.act_cost);
    if (has(r, 'act_cost') && ac != null && !near(ac, a ? n0(a.act_reg_cost) + n0(a.act_ot_cost) : null)) upd.actual_cost = ac - (a ? n0(a.act_ot_cost) : 0);
    numField('remain_cost', 'remaining_cost', a ? n0(a.remain_cost) : null);
    numField('act_this_per_qty', 'actual_this_period_units', a ? n0(a.act_this_per_qty) : null);
    numField('act_this_per_cost', 'actual_this_period_cost', a ? n0(a.act_this_per_cost) : null);
    const asgDays = (which: 'target' | 'remain') => { if (!a) return null; const own = a[`${which}_drtn_hr_cnt`], qty = n0(a[`${which}_qty`]), rate = n0(a[`${which}_qty_per_hr`]); return days(String(own !== '' && own != null ? Number(own) : rate > 0 && qty > 0 ? qty / rate : n0(t?.[`${which}_drtn_hr_cnt`])), hd); };
    numField('target_drtn_hr_cnt', 'duration_days', asgDays('target'));
    numField('remain_drtn_hr_cnt', 'remaining_duration_days', asgDays('remain'));
    numField('remain_lag_drtn_hr_cnt', 'remaining_lag_days', a ? days(a.relag_drtn_hr_cnt || '0', hd) : null);
    numField('remain_qty_per_hr', 'remaining_units_per_day', a ? round(n0(a.remain_qty_per_hr) * hd) : null);
    for (const [f, key] of [['act_start_date', 'actual_start'], ['act_end_date', 'actual_finish']] as const) {
      if (!has(r, f)) continue;
      const d = dateOf(r[f]);
      if (a ? !sameDate(d, a[f]) && (d || a[f]) : !!d) upd[key] = d || null;
    }
    for (const [f, m, what, curName, key] of [...(roleOnly ? [] : [['role_id', roleId, 'role', c.roleName.get(a?.role_id ?? ''), 'role'] as const]), ['acct_id', acctId, 'cost account', c.acctName.get(a?.acct_id ?? ''), 'account'], ['curv_id', curveId, 'resource curve', c.curveName.get(a?.curv_id ?? ''), 'curve']] as const) {
      if (!has(r, f) || lc(str(r[f])) === lc(curName)) continue;
      if (named(m, str(r[f]), what, ref) != null) upd[key] = str(r[f]);
    }
    let n = 0;
    if (!a) {
      // a new row's zeros are no entry (a cost typed in, even 0, would cut the cost's link to units x price)
      for (const f of ['actual_units', 'budgeted_cost', 'actual_cost', 'remaining_cost', 'actual_this_period_units', 'actual_this_period_cost', 'remaining_lag_days']) if (upd[f] === 0) delete upd[f];
      if (upd.remaining_units != null && upd.remaining_units === upd.units) delete upd.remaining_units;
      // a resource already on the activity again (P6 allows it), or a role assignment
      const add: Op = res ? { op: 'assign_resource', activity: act, resource: target.resource, ...(nth > 0 ? { allow_duplicate: true } : {}), ...P } : { op: 'assign_role', activity: act, role: roleOnly, ...P };
      emit({ ...add, ...(upd.units != null ? { units: upd.units } : {}) }, ref, 2); n++;
      delete upd.units;
      // the operations after it name the new assignment: the last of its pair
      if (nth > 0) { target.nth = nth + 1; upd.nth = nth + 1; }
    }
    if (Object.keys(upd).filter((f) => f !== 'nth').length > 4) { emit(upd, ref, 2); n++; }
    n += asgExtras(r, a?.taskrsrc_id ?? null, target, ref, 2);
    if (!a) s.assignmentsAdded++; else if (n) s.assignmentsUpdated++; else s.unchanged++;
  }
  if (!SHEETS.some((n) => sheet(n))) warnings.push('No TASK, TASKPRED, PROJCOST, RSRC or TASKRSRC sheet: this does not look like a P6 spreadsheet export.');
  // resources and activities first, relationships after them, then expenses and assignments, deletions last (a
  // relationship or assignment may name an activity or resource the sheet adds); in sheet order within each
  const order = out.map((_, i) => i).sort((i, j) => out[i].rank - out[j].rank || i - j);
  return { ops: order.map((i) => out[i].op), rows: order.map((i) => out[i].ref), summary: s, warnings };
}

export interface ImportResult {
  /** operations applied */
  applied: number;
  /** rows P6 would refuse, skipped with all their operations (P6's import log) */
  refused: (RowRef & { op: Op; message: string })[];
  warnings: string[];
}

/** Apply a plan, skipping each row an operation of which is refused (with every operation of that row) and applying
 *  the rest, as P6's import logs a bad row and carries on. Run it inside the caller's change (mutate, change) so the
 *  whole import is one undo step. Each pass that meets a refused row commits what came before it and carries on after
 *  it, so a sheet with k bad rows costs about k + 1 passes over its operations, never one per row. */
export function applyImport(db: Db, plan: ImportPlan, o: OpsOptions = {}): ImportResult {
  const res: ImportResult = { applied: 0, refused: [], warnings: [] };
  const skipped = new Set<string>();
  const key = (i: number) => `${plan.rows[i]?.sheet}|${plan.rows[i]?.row}`;
  const keep = (i: number) => !skipped.has(key(i));
  const run = (list: number[]): void => {
    while (list.length) {
      const r = applyOps(db, list.map((i) => plan.ops[i]), o);
      if (r.ok) { res.applied += list.length; res.warnings.push(...(r.warnings ?? [])); return; }
      const k = Math.max(0, r.error!.index), bad = list[k];
      skipped.add(key(bad));
      res.refused.push({ ...plan.rows[bad], op: plan.ops[bad], message: r.error!.message });
      run(list.slice(0, k).filter(keep)); // what came before it (less the bad row's own operations)
      list = list.slice(k + 1).filter(keep);
    }
  };
  run(plan.ops.map((_, i) => i));
  res.refused.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row);
  return res;
}
