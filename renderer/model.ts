// Derived views of the raw P6 tables for the UI: formatting, columns, edit rules, structural edits.
import { addField, emptyDb, groupBy, indexBy, nextId, rows, table, type Db, type Row } from '../core/db.ts';
import { formatP6Date, parseP6Date } from '../core/dates.ts';
import { p6num, calendarResolver } from '../core/schedule/cpm.ts';
import { durationPct } from '../core/progress/update.ts';
import { ENUMS } from '../core/xer/schema.ts';
import type { Prefs } from './store.ts';
import { makeCtx as coreMakeCtx, isCritical, type Ctx as CoreCtx } from '../core/project/ctx.ts';
import { isMilestone, statusOf, setStart as setStartLike, setFinish as setFinishLike, setActual, setPercent, refreshOwnDates } from '../core/project/edit.ts';
export { isCritical, isMilestone, statusOf, setActual, setPercent, refreshOwnDates };
export { normDate, ensureEps, ensureDefaultCalendar, ensureCurrency, newProject, projectName, nextTaskCode, TASK_FIELDS, addActivity, deleteActivities, dissolveActivities, checkRelationship, addRelationship, addWbs, enumOk } from '../core/project/edit.ts';
/** Context computed once per render for column getters (the core context with the user's preferences). */
export type Ctx = CoreCtx<Prefs>;
export const makeCtx = (db: Db, prefs: Prefs): Ctx => coreMakeCtx(db, prefs);

/** Notebook (memo) HTML as plain text, and plain text back to the HTML P6 stores. */
export const memoText = (h: string) => h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
export const memoHtml = (t: string) => `<HTML><BODY>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</BODY></HTML>`;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(v: string | number | null | undefined, prefs: Prefs, withTime = prefs.showTime): string {
  const t = typeof v === 'number' ? v : parseP6Date(v ?? '');
  if (t == null) return '';
  const s = formatP6Date(t);
  const [y, mo, d] = [s.slice(0, 4), +s.slice(5, 7), s.slice(8, 10)];
  let out: string;
  switch (prefs.dateFormat) {
    case 'yyyy-mm-dd': out = s.slice(0, 10); break;
    case 'mm/dd/yy': out = `${s.slice(5, 7)}/${d}/${y.slice(2)}`; break;
    case 'dd/mm/yy': out = `${d}/${s.slice(5, 7)}/${y.slice(2)}`; break;
    default: out = `${d}-${MON[mo - 1]}-${y.slice(2)}`;
  }
  return withTime ? `${out} ${s.slice(11)}` : out;
}

export function fmtDur(hours: string | number | undefined, prefs: Prefs): string {
  if (hours === '' || hours == null) return '';
  const h = Number(hours);
  if (!Number.isFinite(h)) return '';
  const d = h / prefs.hoursPerDay;
  return (Math.round(d * 10 ** prefs.durationDecimals) / 10 ** prefs.durationDecimals).toString();
}
export const daysToHours = (d: number, prefs: Prefs) => d * prefs.hoursPerDay;

const calsOf = new WeakMap<Ctx, ReturnType<typeof calendarResolver>>();
/** P6 Actual Duration (hours): working time on the activity's calendar from its actual start to its actual finish, or to the data date while in progress. */
export function actualDurHours(r: Row, ctx: Ctx): number {
  const as = parseP6Date(r.act_start_date);
  if (as == null) return 0;
  const p = ctx.proj.get(r.proj_id);
  const end = parseP6Date(r.act_end_date) ?? parseP6Date(p?.last_recalc_date);
  if (end == null || end <= as) return 0;
  let cals = calsOf.get(ctx);
  if (!cals) calsOf.set(ctx, (cals = calendarResolver(ctx.db, [])));
  return (cals.get(r.clndr_id) ?? cals.fallback(p?.clndr_id)).workBetween(as, end) / 60;
}
/** P6 At Completion Duration: Actual Duration + Remaining Duration. */
export const atCompletionDurHours = (r: Row, ctx: Ctx) => actualDurHours(r, ctx) + (r.act_end_date ? 0 : Number(r.remain_drtn_hr_cnt || 0));

export const TASK_TYPES: Record<string, string> = { TT_Task: 'Task Dependent', TT_Rsrc: 'Resource Dependent', TT_LOE: 'Level of Effort', TT_Mile: 'Start Milestone', TT_FinMile: 'Finish Milestone', TT_WBS: 'WBS Summary' };
export const DUR_TYPES: Record<string, string> = { DT_FixedDUR2: 'Fixed Duration and Units', DT_FixedDrtn: 'Fixed Duration and Units/Time', DT_FixedQty: 'Fixed Units', DT_FixedRate: 'Fixed Units/Time' };
export const PCT_TYPES: Record<string, string> = { CP_Drtn: 'Duration', CP_Phys: 'Physical', CP_Units: 'Units' };
export const CSTR_TYPES: Record<string, string> = { '': '<None>', CS_MSO: 'Start On', CS_MSOB: 'Start On or Before', CS_MSOA: 'Start On or After', CS_MEO: 'Finish On', CS_MEOB: 'Finish On or Before', CS_MEOA: 'Finish On or After', CS_ALAP: 'As Late As Possible', CS_MANDSTART: 'Mandatory Start', CS_MANDFIN: 'Mandatory Finish' };
export const REL_TYPES: Record<string, string> = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };
export const RSRC_TYPES: Record<string, string> = { RT_Labor: 'Labor', RT_Equip: 'Nonlabor', RT_Mat: 'Material' };
export const STATUS: Record<string, string> = { TK_NotStart: 'Not Started', TK_Active: 'In Progress', TK_Complete: 'Completed' };


/** Activity % complete per its percent complete type. */
export function activityPct(r: Row, ctx?: Ctx): number {
  if (r.act_end_date) return 100;
  if (r.complete_pct_type === 'CP_Phys') return Number(r.phys_complete_pct || 0);
  if (r.complete_pct_type === 'CP_Units' && ctx) {
    const as = ctx.rsrcByTask.get(r.task_id) ?? [];
    const bud = as.reduce((a, x) => a + Number(x.target_qty || 0), 0), act = as.reduce((a, x) => a + Number(x.act_reg_qty || 0) + Number(x.act_ot_qty || 0), 0);
    return bud ? (100 * act) / bud : 0;
  }
  return durationPct(r);
}

export function wbsPath(wbsId: string, ctx: Ctx): string {
  const parts: string[] = [];
  for (let w = ctx.wbs.get(wbsId), n = 0; w && n < 50; w = ctx.wbs.get(w.parent_wbs_id), n++) {
    if (w.proj_node_flag === 'Y') { parts.unshift(ctx.proj.get(w.proj_id)?.proj_short_name ?? w.wbs_short_name); break; }
    parts.unshift(w.wbs_short_name);
  }
  return parts.join('.');
}

export interface Column {
  id: string; title: string; width: number; align?: 'left' | 'right' | 'center';
  /** View > Columns folder for columns made from the database (Activity Codes, User Defined Fields) */
  group?: string;
  get: (r: Row, ctx: Ctx) => string;
  edit?: { type: 'text' | 'number' | 'date' | 'select'; options?: Record<string, string>; set: (db: Db, r: Row, v: string, ctx: Ctx) => string | void };
}

const sumBy = (rs: Row[] | undefined, f: string) => (rs ?? []).reduce((a, x) => a + Number(x[f] || 0), 0);
const USD = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const money = (n: number) => (n ? USD.format(n) : '$0.00');
const startOf = (r: Row, ctx: Ctx) => (r.act_start_date ? `${fmtDate(r.act_start_date, ctx.prefs)} A` : fmtDate(r.early_start_date || r.restart_date || r.target_start_date, ctx.prefs) + (r.cstr_type && /MSO|MANDSTART/.test(r.cstr_type) ? '*' : ''));
const finishOf = (r: Row, ctx: Ctx) => (r.act_end_date ? `${fmtDate(r.act_end_date, ctx.prefs)} A` : fmtDate(r.early_end_date || r.reend_date || r.target_end_date, ctx.prefs) + (r.cstr_type && /MEO|MANDFIN/.test(r.cstr_type) ? '*' : ''));

/** Activity table columns (View > Columns). */
export const COLUMNS: Column[] = [
  { id: 'task_code', title: 'Activity ID', width: 110, get: (r) => r.task_code, edit: { type: 'text', set: (db, r, v) => {
    v = v.trim();
    if (!v) return 'Activity ID cannot be blank.';
    if (rows(db, 'TASK').some((t) => t !== r && t.proj_id === r.proj_id && t.task_code === v)) return `Activity ID ${v} already exists in this project.`;
    r.task_code = v;
  } } },
  { id: 'task_name', title: 'Activity Name', width: 260, get: (r) => r.task_name, edit: { type: 'text', set: (_db, r, v) => { r.task_name = v; } } },
  { id: 'orig_dur', title: 'Original Duration', width: 62, align: 'right', get: (r, c) => fmtDur(r.target_drtn_hr_cnt, c.prefs), edit: { type: 'number', set: (_db, r, v, c) => {
    const h = daysToHours(Number(v), c.prefs);
    if (!(h >= 0)) return 'Duration must be zero or greater.';
    if (isMilestone(r) && h > 0) return 'Milestones have zero duration.';
    r.target_drtn_hr_cnt = p6num(h);
    if (!r.act_start_date) r.remain_drtn_hr_cnt = p6num(h);
    refreshOwnDates(_db, r);
  } } },
  { id: 'rem_dur', title: 'Remaining Duration', width: 62, align: 'right', get: (r, c) => fmtDur(r.remain_drtn_hr_cnt, c.prefs), edit: { type: 'number', set: (_db, r, v, c) => {
    if (r.act_end_date) return 'Completed activities have no remaining duration.';
    const h = daysToHours(Number(v), c.prefs);
    if (!(h >= 0)) return 'Duration must be zero or greater.';
    r.remain_drtn_hr_cnt = p6num(h);
    if (!r.act_start_date) r.target_drtn_hr_cnt = p6num(h);
    refreshOwnDates(_db, r);
  } } },
  { id: 'act_dur', title: 'Actual Duration', width: 56, align: 'right', get: (r, c) => fmtDur(actualDurHours(r, c), c.prefs) },
  { id: 'atc_dur', title: 'At Completion Duration', width: 70, align: 'right', get: (r, c) => fmtDur(atCompletionDurHours(r, c), c.prefs) },
  { id: 'pct', title: 'Activity % Complete', width: 62, align: 'right', get: (r, c) => `${Math.round(activityPct(r, c) * 10) / 10}%`, edit: { type: 'number', set: (_db, r, v) => setPercent(r, Number(v)) } },
  { id: 'dur_pct', title: 'Duration % Complete', width: 62, align: 'right', get: (r) => `${Math.round(durationPct(r) * 10) / 10}%` },
  { id: 'phys_pct', title: 'Physical % Complete', width: 62, align: 'right', get: (r) => `${Number(r.phys_complete_pct || 0)}%`, edit: { type: 'number', set: (_db, r, v) => { if (!(Number(v) >= 0 && Number(v) <= 100)) return 'Enter 0 to 100.'; r.phys_complete_pct = p6num(Number(v)); } } },
  { id: 'start', title: 'Start', width: 82, get: startOf, edit: { type: 'date', set: (db, r, v) => setStartLike(db, r, v) } },
  { id: 'finish', title: 'Finish', width: 82, get: finishOf, edit: { type: 'date', set: (db, r, v) => setFinishLike(db, r, v) } },
  { id: 'early_start', title: 'Early Start', width: 82, get: (r, c) => (r.act_end_date ? '' : fmtDate(r.early_start_date, c.prefs)) },
  { id: 'early_finish', title: 'Early Finish', width: 82, get: (r, c) => (r.act_end_date ? '' : fmtDate(r.early_end_date, c.prefs)) },
  { id: 'late_start', title: 'Late Start', width: 82, get: (r, c) => (r.act_end_date ? '' : fmtDate(r.late_start_date, c.prefs)) },
  { id: 'late_finish', title: 'Late Finish', width: 82, get: (r, c) => (r.act_end_date ? '' : fmtDate(r.late_end_date, c.prefs)) },
  { id: 'act_start', title: 'Actual Start', width: 82, get: (r, c) => fmtDate(r.act_start_date, c.prefs), edit: { type: 'date', set: (_db, r, v) => setActual(r, 'start', v) } },
  { id: 'act_finish', title: 'Actual Finish', width: 82, get: (r, c) => fmtDate(r.act_end_date, c.prefs), edit: { type: 'date', set: (_db, r, v) => setActual(r, 'finish', v) } },
  { id: 'planned_start', title: 'Planned Start', width: 82, get: (r, c) => fmtDate(r.target_start_date, c.prefs) },
  { id: 'planned_finish', title: 'Planned Finish', width: 82, get: (r, c) => fmtDate(r.target_end_date, c.prefs) },
  { id: 'bl_start', title: 'BL Project Start', width: 82, get: (r, c) => { const b = c.baseline.get(`${r.task_code}|${r.proj_id}`); return b ? fmtDate(b.act_start_date || b.target_start_date, c.prefs) : ''; } },
  { id: 'bl_finish', title: 'BL Project Finish', width: 82, get: (r, c) => { const b = c.baseline.get(`${r.task_code}|${r.proj_id}`); return b ? fmtDate(b.act_end_date || b.target_end_date, c.prefs) : ''; } },
  { id: 'var_bl_finish', title: 'Variance - BL Project Finish Date', width: 80, align: 'right', get: (r, c) => {
    const b = c.baseline.get(`${r.task_code}|${r.proj_id}`);
    if (!b) return '';
    const bf = parseP6Date(b.act_end_date || b.target_end_date), f = parseP6Date(r.act_end_date || r.early_end_date);
    return bf == null || f == null ? '' : fmtDur((bf - f) / 60 * (c.prefs.hoursPerDay / 24), c.prefs);
  } },
  { id: 'total_float', title: 'Total Float', width: 56, align: 'right', get: (r, c) => fmtDur(r.total_float_hr_cnt, c.prefs) },
  { id: 'free_float', title: 'Free Float', width: 56, align: 'right', get: (r, c) => fmtDur(r.free_float_hr_cnt, c.prefs) },
  { id: 'status', title: 'Activity Status', width: 80, get: (r) => STATUS[statusOf(r)] },
  { id: 'task_type', title: 'Activity Type', width: 110, get: (r) => TASK_TYPES[r.task_type] ?? r.task_type, edit: { type: 'select', options: TASK_TYPES, set: (_db, r, v) => { r.task_type = v; if (isMilestone(r)) { r.target_drtn_hr_cnt = '0'; r.remain_drtn_hr_cnt = '0'; } } } },
  { id: 'duration_type', title: 'Duration Type', width: 130, get: (r) => DUR_TYPES[r.duration_type] ?? r.duration_type, edit: { type: 'select', options: DUR_TYPES, set: (_db, r, v) => { r.duration_type = v; } } },
  { id: 'pct_type', title: '% Complete Type', width: 70, get: (r) => PCT_TYPES[r.complete_pct_type] ?? r.complete_pct_type, edit: { type: 'select', options: PCT_TYPES, set: (_db, r, v) => { r.complete_pct_type = v; } } },
  { id: 'calendar', title: 'Calendar', width: 140, get: (r, c) => c.cal.get(r.clndr_id)?.clndr_name ?? '' },
  { id: 'cstr_type', title: 'Primary Constraint', width: 110, get: (r) => (r.cstr_type ? CSTR_TYPES[r.cstr_type] : ''), edit: { type: 'select', options: CSTR_TYPES, set: (_db, r, v) => {
    r.cstr_type = v;
    // like the Status tab: a new constraint starts on the activity's early start (finish constraints: early finish)
    if (!v || v === 'CS_ALAP') r.cstr_date = '';
    else if (!r.cstr_date) r.cstr_date = (/MEO|FIN/.test(v) ? r.early_end_date || r.target_end_date : r.early_start_date || r.target_start_date) ?? '';
  } } },
  { id: 'cstr_date', title: 'Primary Constraint Date', width: 82, get: (r, c) => fmtDate(r.cstr_date, c.prefs), edit: { type: 'date', set: (_db, r, v) => { r.cstr_date = v; } } },
  { id: 'cstr_type2', title: 'Secondary Constraint', width: 110, get: (r) => (r.cstr_type2 ? CSTR_TYPES[r.cstr_type2] : '') },
  { id: 'cstr_date2', title: 'Secondary Constraint Date', width: 82, get: (r, c) => fmtDate(r.cstr_date2, c.prefs) },
  { id: 'wbs_code', title: 'WBS Code', width: 120, get: (r, c) => wbsPath(r.wbs_id, c) },
  { id: 'wbs_name', title: 'WBS Name', width: 150, get: (r, c) => c.wbs.get(r.wbs_id)?.wbs_name ?? '' },
  { id: 'critical', title: 'Critical', width: 46, align: 'center', get: (r, c) => (isCritical(r, c) ? 'Yes' : 'No') },
  { id: 'longest', title: 'Longest Path', width: 50, align: 'center', get: (r) => (r.driving_path_flag === 'Y' ? 'Yes' : 'No') },
  { id: 'resources', title: 'Resources', width: 140, get: (r, c) => (c.rsrcByTask.get(r.task_id) ?? []).map((a) => c.rsrc.get(a.rsrc_id)?.rsrc_short_name ?? '?').join(', ') },
  { id: 'bud_units', title: 'Budgeted Labor Units', width: 70, align: 'right', get: (r, c) => p6num(sumBy(c.rsrcByTask.get(r.task_id)?.filter((a) => (a.rsrc_type || c.rsrc.get(a.rsrc_id)?.rsrc_type) === 'RT_Labor'), 'target_qty')) },
  { id: 'act_units', title: 'Actual Labor Units', width: 70, align: 'right', get: (r, c) => p6num(sumBy(c.rsrcByTask.get(r.task_id)?.filter((a) => (a.rsrc_type || c.rsrc.get(a.rsrc_id)?.rsrc_type) === 'RT_Labor'), 'act_reg_qty')) },
  { id: 'bud_cost', title: 'Budgeted Total Cost', width: 90, align: 'right', get: (r, c) => money(sumBy(c.rsrcByTask.get(r.task_id), 'target_cost') + sumBy(c.costByTask.get(r.task_id), 'target_cost')) },
  { id: 'act_cost', title: 'Actual Total Cost', width: 90, align: 'right', get: (r, c) => money(sumBy(c.rsrcByTask.get(r.task_id), 'act_reg_cost') + sumBy(c.rsrcByTask.get(r.task_id), 'act_ot_cost') + sumBy(c.costByTask.get(r.task_id), 'act_cost')) },
  { id: 'rem_cost', title: 'Remaining Total Cost', width: 90, align: 'right', get: (r, c) => money(sumBy(c.rsrcByTask.get(r.task_id), 'remain_cost') + sumBy(c.costByTask.get(r.task_id), 'remain_cost')) },
  { id: 'preds', title: 'Predecessors', width: 120, get: (r, c) => (c.predsOf.get(r.task_id) ?? []).map((p) => c.taskById.get(p.pred_task_id)?.task_code ?? `[${p.pred_task_id}]`).join(', ') },
  { id: 'succs', title: 'Successors', width: 120, get: (r, c) => (c.succsOf.get(r.task_id) ?? []).map((p) => c.taskById.get(p.task_id)?.task_code ?? `[${p.task_id}]`).join(', ') },
  { id: 'rem_early_start', title: 'Remaining Early Start', width: 82, get: (r, c) => fmtDate(r.restart_date, c.prefs) },
  { id: 'rem_early_finish', title: 'Remaining Early Finish', width: 82, get: (r, c) => fmtDate(r.reend_date, c.prefs) },
  { id: 'rem_late_start', title: 'Remaining Late Start', width: 82, get: (r, c) => fmtDate(r.rem_late_start_date, c.prefs) },
  { id: 'rem_late_finish', title: 'Remaining Late Finish', width: 82, get: (r, c) => fmtDate(r.rem_late_end_date, c.prefs) },
  { id: 'suspend', title: 'Suspend Date', width: 82, get: (r, c) => fmtDate(r.suspend_date, c.prefs) },
  { id: 'resume', title: 'Resume Date', width: 82, get: (r, c) => fmtDate(r.resume_date, c.prefs) },
  { id: 'ext_early_start', title: 'External Early Start', width: 82, get: (r, c) => fmtDate(r.external_early_start_date, c.prefs) },
  { id: 'ext_late_finish', title: 'External Late Finish', width: 82, get: (r, c) => fmtDate(r.external_late_end_date, c.prefs) },
  { id: 'float_path', title: 'Float Path', width: 50, align: 'right', get: (r) => r.float_path ?? '' },
  { id: 'float_path_order', title: 'Float Path Order', width: 50, align: 'right', get: (r) => r.float_path_order ?? '' },
  { id: 'priority', title: 'Leveling Priority', width: 80, get: (r) => PRIORITIES[r.priority_type] ?? r.priority_type ?? '' },
  { id: 'expect_end', title: 'Expected Finish', width: 82, get: (r, c) => fmtDate(r.expect_end_date, c.prefs) },
  { id: 'proj', title: 'Project ID', width: 90, get: (r, c) => c.proj.get(r.proj_id)?.proj_short_name ?? '' },
  { id: 'task_id', title: 'Activity (internal) ID', width: 70, align: 'right', get: (r) => r.task_id },
];
const PRIORITIES: Record<string, string> = { PT_Top: 'Top', PT_High: 'High', PT_Normal: 'Normal', PT_Low: 'Low', PT_Lowest: 'Lowest' };
const BASE_COLUMNS = new Map(COLUMNS.map((c) => [c.id, c]));

// per-context lookups for the database columns (task_id -> text), built on first use
const extraValues = new WeakMap<Ctx, Map<string, Map<string, string>>>();
function extraValue(ctx: Ctx, colId: string, taskId: string, build: () => Map<string, string>): string {
  let byCol = extraValues.get(ctx);
  if (!byCol) extraValues.set(ctx, (byCol = new Map()));
  let m = byCol.get(colId);
  if (!m) byCol.set(colId, (m = build()));
  return m.get(taskId) ?? '';
}

/** Activity code and activity UDF columns of a database (P6: the Activity Codes and User Defined Fields folders of View > Columns). */
export function extraColumns(db: Db): Column[] {
  const out: Column[] = [];
  for (const t of rows(db, 'ACTVTYPE')) {
    const id = `code_${t.actv_code_type_id}`;
    out.push({ id, title: t.actv_code_type, width: 100, group: 'Activity Codes', get: (r, c) => extraValue(c, id, r.task_id, () => {
      const codes = indexBy(rows(c.db, 'ACTVCODE'), 'actv_code_id'), m = new Map<string, string>();
      for (const a of rows(c.db, 'TASKACTV')) if (a.actv_code_type_id === t.actv_code_type_id || (!a.actv_code_type_id && codes.get(a.actv_code_id)?.actv_code_type_id === t.actv_code_type_id)) m.set(a.task_id, codes.get(a.actv_code_id)?.short_name ?? '');
      return m;
    }) });
  }
  for (const u of rows(db, 'UDFTYPE').filter((x) => x.table_name === 'TASK')) {
    const id = `udf_${u.udf_type_id}`, ty = u.logical_data_type ?? '';
    const num = /FLOAT|INT|MONEY/.test(ty);
    out.push({ id, title: u.udf_type_label, width: 100, align: num ? 'right' : undefined, group: 'User Defined Fields', get: (r, c) => extraValue(c, id, r.task_id, () => {
      const ucodes = indexBy(rows(c.db, 'UDFCODE'), 'udf_code_id'), m = new Map<string, string>();
      for (const v of rows(c.db, 'UDFVALUE')) if (v.udf_type_id === u.udf_type_id) {
        m.set(v.fk_id, /DATE/.test(ty) ? fmtDate(v.udf_date, c.prefs) : ty === 'FT_MONEY' ? money(Number(v.udf_number || 0)) : num ? (v.udf_number ?? '') : ty === 'FT_CODE' ? (ucodes.get(v.udf_code_id)?.short_name ?? '') : (v.udf_text ?? ''));
      }
      return m;
    }) });
  }
  return out;
}

let columnDb: () => Db = emptyDb;
/** Where database columns (codes, UDFs) look up their names: the app's current database. */
export const setColumnDb = (f: () => Db) => { columnDb = f; };
/** Column by id: the fixed columns, then the database's code and UDF columns. */
export const COLUMN_BY_ID = { get: (id: string): Column | undefined => BASE_COLUMNS.get(id) ?? (/^(code|udf)_/.test(id) ? extraColumns(columnDb()).find((c) => c.id === id) : undefined) };

