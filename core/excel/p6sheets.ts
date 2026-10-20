// P6-style spreadsheet export and import (File > Export / Import > Spreadsheet in P6): one sheet per table (TASK,
// TASKPRED, RSRC, TASKRSRC), row 1 the field names P6 matches on, row 2 the column titles, data from row 3.
// Import turns the sheets into edit operations (core/project/ops.ts) so it is checked, previewed and applied as one
// undoable step; read-only columns (status, dates P6 calculates, float) are ignored like P6 ignores them.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { durationPct } from '../progress/update.ts';
import type { Op } from '../project/ops.ts';
import { dayHours } from '../project/units.ts';
import type { Cell, Sheet } from './xlsx.ts';

export const TYPE_LABEL: Record<string, string> = { TT_Task: 'Task Dependent', TT_Rsrc: 'Resource Dependent', TT_Mile: 'Start Milestone', TT_FinMile: 'Finish Milestone', TT_LOE: 'Level of Effort', TT_WBS: 'WBS Summary' };
export const CSTR_LABEL: Record<string, string> = { CS_MSO: 'Start On', CS_MSOA: 'Start On or After', CS_MSOB: 'Start On or Before', CS_MEO: 'Finish On', CS_MEOA: 'Finish On or After', CS_MEOB: 'Finish On or Before', CS_MANDSTART: 'Mandatory Start', CS_MANDFIN: 'Mandatory Finish', CS_ALAP: 'As Late As Possible' };
const STATUS_LABEL: Record<string, string> = { TK_NotStart: 'Not Started', TK_Active: 'In Progress', TK_Complete: 'Completed' };
const RTYPE_LABEL: Record<string, string> = { RT_Labor: 'Labor', RT_Equip: 'Nonlabor', RT_Mat: 'Material' };
const REL_LABEL: Record<string, string> = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };

const TASK_COLS: [string, string][] = [['proj_id', 'Project ID'], ['task_code', 'Activity ID'], ['status_code', 'Activity Status'], ['wbs_id', 'WBS Code'], ['task_name', 'Activity Name'], ['task_type', 'Activity Type'], ['target_drtn_hr_cnt', 'Original Duration(d)'], ['remain_drtn_hr_cnt', 'Remaining Duration(d)'], ['start_date', 'Start'], ['end_date', 'Finish'], ['act_start_date', 'Actual Start'], ['act_end_date', 'Actual Finish'], ['complete_pct', 'Activity % Complete'], ['cstr_type', 'Primary Constraint'], ['cstr_date', 'Primary Constraint Date'], ['total_float_hr_cnt', 'Total Float(d)'], ['clndr_id', 'Calendar'], ['delete_record_flag', 'Delete This Row']];
const PRED_COLS: [string, string][] = [['pred_proj_id', 'Predecessor Project'], ['pred_task_id', 'Predecessor'], ['proj_id', 'Successor Project'], ['task_id', 'Successor'], ['pred_type', 'Relationship Type'], ['lag_hr_cnt', 'Lag(d)'], ['delete_record_flag', 'Delete This Row']];
const RSRC_COLS: [string, string][] = [['rsrc_short_name', 'Resource ID'], ['rsrc_name', 'Resource Name'], ['rsrc_type', 'Resource Type'], ['max_qty_per_hr', 'Max Units / Day'], ['cost_per_qty', 'Price / Unit']];
const ASG_COLS: [string, string][] = [['proj_id', 'Project ID'], ['task_id', 'Activity ID'], ['rsrc_id', 'Resource ID'], ['target_qty', 'Budgeted Units'], ['remain_qty', 'Remaining Units'], ['act_reg_qty', 'Actual Units'], ['delete_record_flag', 'Delete This Row']];

const days = (h: string | undefined, hpd: number) => h === '' || h == null ? null : Math.round((Number(h) / hpd) * 100) / 100;
const date = (s: string | undefined) => { const m = parseP6Date(s); return m == null ? null : new Date(m * 60000); };

/** The open project(s) as P6-style sheets. */
export function exportSheets(db: Db, projIds: string[], hpd = 8, calendarDays = false): Sheet[] {
  const dh = dayHours(db, hpd, calendarDays); // days as edits (and planImport with the same option) take them
  const ids = new Set(projIds);
  const proj = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p]));
  const W = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w]));
  const wbsCode = (id: string) => { const out: string[] = []; for (let w = W.get(id), n = 0; w && n < 50; w = W.get(w.parent_wbs_id), n++) out.unshift(w.proj_node_flag === 'Y' ? proj.get(w.proj_id)?.proj_short_name ?? w.wbs_short_name : w.wbs_short_name); return out.join('.'); };
  const cal = new Map(rows(db, 'CALENDAR').map((c) => [c.clndr_id, c.clndr_name]));
  const tasks = rows(db, 'TASK').filter((t) => ids.has(t.proj_id));
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const allTasks = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const rsrc = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r]));
  const rate = new Map(rows(db, 'RSRCRATE').map((r) => [r.rsrc_id, r]));
  const pid = (id: string) => proj.get(id)?.proj_short_name ?? '';
  const head = (cols: [string, string][]): Cell[][] => [cols.map((c) => c[0]), cols.map((c) => c[1])];

  const taskRows: Cell[][] = tasks.map((t) => [
    pid(t.proj_id), t.task_code, STATUS_LABEL[t.status_code] ?? t.status_code, wbsCode(t.wbs_id), t.task_name, TYPE_LABEL[t.task_type] ?? t.task_type,
    days(t.target_drtn_hr_cnt, dh.task(t)), days(t.remain_drtn_hr_cnt, dh.task(t)),
    date(t.act_start_date || t.early_start_date || t.restart_date || t.target_start_date), date(t.act_end_date || t.early_end_date || t.reend_date || t.target_end_date),
    date(t.act_start_date), date(t.act_end_date),
    Math.round((t.complete_pct_type === 'CP_Phys' && !t.act_end_date ? Number(t.phys_complete_pct || 0) : durationPct(t)) * 100) / 100,
    CSTR_LABEL[t.cstr_type] ?? '', date(t.cstr_date), days(t.total_float_hr_cnt, dh.task(t)), cal.get(t.clndr_id) ?? '', '',
  ]);
  const predRows: Cell[][] = rows(db, 'TASKPRED').filter((p) => byId.has(p.task_id) || byId.has(p.pred_task_id)).map((p) => {
    const a = allTasks.get(p.pred_task_id), b = allTasks.get(p.task_id);
    return [pid(a?.proj_id ?? ''), a?.task_code ?? '', pid(b?.proj_id ?? ''), b?.task_code ?? '', REL_LABEL[p.pred_type] ?? p.pred_type, days(p.lag_hr_cnt, dh.rel(p)) ?? 0, ''];
  });
  const asgs = rows(db, 'TASKRSRC').filter((a) => byId.has(a.task_id));
  const rsrcRows: Cell[][] = rows(db, 'RSRC').map((r) => [
    r.rsrc_short_name, r.rsrc_name, RTYPE_LABEL[r.rsrc_type] ?? r.rsrc_type,
    rate.get(r.rsrc_id)?.max_qty_per_hr ? Math.round(Number(rate.get(r.rsrc_id)!.max_qty_per_hr) * hpd * 100) / 100 : null, rate.get(r.rsrc_id)?.cost_per_qty ? Number(rate.get(r.rsrc_id)!.cost_per_qty) : null,
  ]);
  const asgRows: Cell[][] = asgs.map((a) => [pid(a.proj_id), byId.get(a.task_id)?.task_code ?? '', rsrc.get(a.rsrc_id)?.rsrc_short_name ?? '', Number(a.target_qty || 0), Number(a.remain_qty || 0), Number(a.act_reg_qty || 0), '']);
  const w = (cols: [string, string][]) => cols.map(([f, t]) => Math.max(10, Math.min(45, (f === 'task_name' || f === 'rsrc_name' ? 40 : t.length + 2))));
  return [
    { name: 'TASK', rows: [...head(TASK_COLS), ...taskRows], widths: w(TASK_COLS), boldRows: 2 },
    { name: 'TASKPRED', rows: [...head(PRED_COLS), ...predRows], widths: w(PRED_COLS), boldRows: 2 },
    { name: 'RSRC', rows: [...head(RSRC_COLS), ...rsrcRows], widths: w(RSRC_COLS), boldRows: 2 },
    { name: 'TASKRSRC', rows: [...head(ASG_COLS), ...asgRows], widths: w(ASG_COLS), boldRows: 2 },
    { name: 'USERDATA', rows: [['UserSettings Do Not Edit'], [`DurationQtyType=QT_Day`], [`HoursPerDay=${hpd}`], [`Exported=${formatP6Date(Date.now() / 60000)}`]] },
  ];
}

export interface ImportPlan {
  ops: Op[];
  summary: { activitiesAdded: number; activitiesUpdated: number; activitiesDeleted: number; relationshipsAdded: number; relationshipsUpdated: number; relationshipsDeleted: number; resourcesAdded: number; assignmentsAdded: number; assignmentsDeleted: number; unchanged: number };
  warnings: string[];
}

const str = (v: Cell) => v == null ? '' : v instanceof Date ? formatP6Date(v.getTime() / 60000) : String(v).trim();
const num = (v: Cell) => { const s = str(v); if (!s) return null; const n = Number(s.replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const yes = (v: Cell) => /^(y|yes|true|1|x)$/i.test(str(v));
const dateOf = (v: Cell) => v instanceof Date ? formatP6Date(v.getTime() / 60000).slice(0, 16) : typeof v === 'number' ? formatP6Date((v - 25569) * 1440).slice(0, 16) : str(v);
const fromLabel = (map: Record<string, string>, v: string) => Object.keys(map).find((k) => k === v || map[k].toLowerCase() === v.toLowerCase());

/** Sheets (from readXlsx) as edit operations against the database, for one target project. */
export function planImport(db: Db, sheets: Sheet[], projectId: string, hpd = 8, calendarDays = false): ImportPlan {
  const dh = dayHours(db, hpd, calendarDays);
  const warnings: string[] = [];
  const s = { activitiesAdded: 0, activitiesUpdated: 0, activitiesDeleted: 0, relationshipsAdded: 0, relationshipsUpdated: 0, relationshipsDeleted: 0, resourcesAdded: 0, assignmentsAdded: 0, assignmentsDeleted: 0, unchanged: 0 };
  const ops: Op[] = [];
  const proj = rows(db, 'PROJECT').find((p) => p.proj_short_name === projectId && !p._baseline_of);
  if (!proj) return { ops, summary: s, warnings: [`No project "${projectId}".`] };
  const sheet = (n: string) => sheets.find((x) => x.name.toUpperCase() === n);
  // row 1 = field names (P6 matches on these); data from the first row that is not the titles row
  const records = (sh: Sheet | undefined): Record<string, Cell>[] => {
    if (!sh || !sh.rows.length) return [];
    const fields = sh.rows[0].map((f) => str(f).toLowerCase());
    const titles = sh.rows[1]?.map(str) ?? [];
    const start = titles.some((t, i) => t && t.toLowerCase() !== fields[i] && !/^\d/.test(t)) ? 2 : 1;
    return sh.rows.slice(start).filter((r) => r.some((v) => str(v) !== '')).map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));
  };
  const tasks = rows(db, 'TASK').filter((t) => t.proj_id === proj.proj_id);
  const byCode = new Map(tasks.map((t) => [t.task_code, t]));
  const cal = new Map(rows(db, 'CALENDAR').map((c) => [c.clndr_id, c.clndr_name]));
  const W = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w]));
  const wbsPath = (id: string) => { const out: string[] = []; for (let w = W.get(id), n = 0; w && w.proj_node_flag !== 'Y' && n < 50; w = W.get(w.parent_wbs_id), n++) out.unshift(w.wbs_short_name); return out.join('.'); };
  const near = (a: number | null, b: number | null) => a == null || b == null ? a === b : Math.abs(a - b) < 0.01;
  const sameDate = (a: string, b: string | undefined) => (a || '').slice(0, 16) === (b || '').slice(0, 16) || (a.length === 10 && (b || '').startsWith(a));

  for (const r of records(sheet('TASK'))) {
    const code = str(r.task_code);
    if (!code) continue;
    if (r.proj_id != null && str(r.proj_id) && str(r.proj_id) !== projectId) { warnings.push(`Activity ${code} belongs to project ${str(r.proj_id)}; skipped.`); continue; }
    const t = byCode.get(code);
    if (yes(r.delete_record_flag)) { if (t) { ops.push({ op: 'delete_activity', id: code }); s.activitiesDeleted++; } continue; }
    const op: Op = { op: t ? 'update_activity' : 'add_activity', id: code };
    const name = str(r.task_name);
    if (name && (!t || name !== t.task_name)) op.name = name;
    if (!t && !name) { warnings.push(`New activity ${code} has no name; skipped.`); continue; }
    const wbs = str(r.wbs_id).replace(new RegExp(`^${projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?`), '');
    if (r.wbs_id != null && (!t || wbs !== wbsPath(t.wbs_id))) op.wbs = wbs || '';
    const type = str(r.task_type);
    if (type) { const code2 = fromLabel(TYPE_LABEL, type); if (!code2) warnings.push(`Activity ${code}: unknown activity type "${type}".`); else if (!t || code2 !== t.task_type) op.type = code2; }
    const od = num(r.target_drtn_hr_cnt), rd = num(r.remain_drtn_hr_cnt);
    if (od != null && (!t || !near(od, days(t.target_drtn_hr_cnt, dh.task(t))))) op.duration_days = od;
    if (t && rd != null && t.act_start_date && !t.act_end_date && !near(rd, days(t.remain_drtn_hr_cnt, dh.task(t)))) op.remaining_days = rd;
    const ct = str(r.cstr_type);
    if (r.cstr_type !== undefined) {
      const c = ct ? fromLabel(CSTR_LABEL, ct) : '';
      if (c == null) warnings.push(`Activity ${code}: unknown constraint "${ct}".`);
      else { const cd = dateOf(r.cstr_date); if (!t || c !== (t.cstr_type || '') || (c && !sameDate(cd, t.cstr_date))) op.constraint = c ? { type: c, date: cd || undefined } : 'none'; }
    }
    const as = dateOf(r.act_start_date), af = dateOf(r.act_end_date);
    if (r.act_start_date !== undefined && (!t ? !!as : !sameDate(as, t.act_start_date) && (as || t.act_start_date))) op.actual_start = as || null;
    if (r.act_end_date !== undefined && (!t ? !!af : !sameDate(af, t.act_end_date) && (af || t.act_end_date))) op.actual_finish = af || null;
    const pct = num(r.complete_pct);
    if (t && pct != null && t.complete_pct_type === 'CP_Phys' && !near(pct, Number(t.phys_complete_pct || 0)) && (t.act_start_date || op.actual_start)) op.percent_complete = pct;
    const cname = str(r.clndr_id);
    if (cname && (!t || cname !== cal.get(t.clndr_id))) op.calendar = cname;
    if (Object.keys(op).length > 2 || !t) { ops.push(op); if (t) s.activitiesUpdated++; else s.activitiesAdded++; } else s.unchanged++;
  }

  const P = rows(db, 'TASKPRED');
  for (const r of records(sheet('TASKPRED'))) {
    const pred = str(r.pred_task_id), succ = str(r.task_id);
    if (!pred || !succ) continue;
    const type = str(r.pred_type).toUpperCase().replace(/^PR_/, '') || 'FS';
    if (!['FS', 'SS', 'FF', 'SF'].includes(type)) { warnings.push(`Relationship ${pred} -> ${succ}: unknown type "${type}".`); continue; }
    const a = byCode.get(pred), b = byCode.get(succ);
    const existing = a && b ? P.find((p) => p.pred_task_id === a.task_id && p.task_id === b.task_id && p.pred_type === `PR_${type}`) : undefined;
    if (yes(r.delete_record_flag)) { if (existing) { ops.push({ op: 'delete_relationship', pred, succ, type }); s.relationshipsDeleted++; } continue; }
    const lag = num(r.lag_hr_cnt) ?? 0;
    if (!existing) { ops.push({ op: 'add_relationship', pred, succ, type, lag_days: lag }); s.relationshipsAdded++; }
    else if (!near(lag, days(existing.lag_hr_cnt, dh.rel(existing)) ?? 0)) { ops.push({ op: 'update_relationship', pred, succ, type, lag_days: lag }); s.relationshipsUpdated++; }
    else s.unchanged++;
  }

  const R = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_short_name.toLowerCase(), r]));
  for (const r of records(sheet('RSRC'))) {
    const id = str(r.rsrc_short_name);
    if (!id || R.has(id.toLowerCase())) continue;
    const ty = fromLabel(RTYPE_LABEL, str(r.rsrc_type));
    ops.push({ op: 'add_resource', id, name: str(r.rsrc_name) || id, type: ty === 'RT_Equip' ? 'nonlabor' : ty === 'RT_Mat' ? 'material' : 'labor', ...(num(r.max_qty_per_hr) != null ? { max_units_per_day: num(r.max_qty_per_hr)! } : {}), ...(num(r.cost_per_qty) != null ? { price_per_unit: num(r.cost_per_qty)! } : {}) });
    R.set(id.toLowerCase(), {} as Row); s.resourcesAdded++;
  }
  const A = rows(db, 'TASKRSRC');
  for (const r of records(sheet('TASKRSRC'))) {
    const act = str(r.task_id), res = str(r.rsrc_id);
    if (!act || !res) continue;
    const t = byCode.get(act), rr = rows(db, 'RSRC').find((x) => x.rsrc_short_name.toLowerCase() === res.toLowerCase());
    const has = t && rr ? A.some((a) => a.task_id === t.task_id && a.rsrc_id === rr.rsrc_id) : false;
    if (yes(r.delete_record_flag)) { if (has) { ops.push({ op: 'unassign_resource', activity: act, resource: res }); s.assignmentsDeleted++; } continue; }
    if (has) { s.unchanged++; continue; }
    const units = num(r.target_qty);
    ops.push({ op: 'assign_resource', activity: act, resource: res, ...(units != null ? { units } : {}) }); s.assignmentsAdded++;
  }
  if (!sheet('TASK') && !sheet('TASKPRED') && !sheet('TASKRSRC') && !sheet('RSRC')) warnings.push('No TASK, TASKPRED, RSRC or TASKRSRC sheet: this does not look like a P6 spreadsheet export.');
  // deletions last so additions referring to them are not affected; relationships after activities
  const rank = (o: Op) => o.op.startsWith('delete') || o.op === 'unassign_resource' ? 3 : o.op.includes('relationship') ? 1 : o.op === 'assign_resource' ? 2 : 0;
  ops.sort((a, b) => rank(a) - rank(b));
  return { ops: ops.map((o) => ({ project: projectId, ...o })), summary: s, warnings };
}
