// Every activity's computed fields in one compact table (MCP activity_table and compute_schedule): a column list
// and one array per activity, paged by offset / limit with no cap on the page size.
import { rows, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { calendarResolver } from '../schedule/cpm.ts';
import { isCritical, makeCtx } from '../project/ctx.ts';
import { dayHours } from '../project/units.ts';

export const TABLE_COLUMNS = ['id', 'status', 'type', 'start', 'finish', 'early_start', 'early_finish', 'late_start', 'late_finish', 'rem_late_start', 'rem_late_finish',
  'orig_days', 'rem_days', 'total_float_days', 'free_float_days', 'critical', 'driving', 'start_wd', 'finish_wd'] as const;
export const TABLE_GUIDE = 'id (Activity ID), status (NS, IP, CO), type (task, rsrc, start_mile, finish_mile, loe, wbs), start / finish (actual, else early; "YYYY-MM-DD HH:MM"), early_*, late_*, rem_late_* (remaining late dates), orig_days, rem_days, total_float_days, free_float_days (working days of the activity\'s own calendar; null when finished or not scheduled), critical, driving (on the longest path), start_wd / finish_wd (working days from the project\'s data date to start / finish on the project\'s default calendar: a common day axis; negative before it)';

const TYPE: Record<string, string> = { TT_Task: 'task', TT_Rsrc: 'rsrc', TT_Mile: 'start_mile', TT_FinMile: 'finish_mile', TT_LOE: 'loe', TT_WBS: 'wbs' };
const d = (s?: string) => (s ? s.slice(0, 16) : null);
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ActivityTable { columns: string[]; rows: unknown[][]; total: number; offset: number; next_offset: number | null }

/** The activities of the projects (all when none given), in table order. */
export function activityTable(db: Db, projIds: string[] | null, opts: { offset?: number; limit?: number; names?: boolean; hoursPerDay?: number } = {}): ActivityTable {
  const projs = new Map(rows(db, 'PROJECT').filter((p) => !p._baseline_of && (!projIds || projIds.includes(p.proj_id))).map((p) => [p.proj_id, p]));
  const all = rows(db, 'TASK').filter((t) => projs.has(t.proj_id));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const page = opts.limit == null ? all.slice(offset) : all.slice(offset, offset + Math.max(0, Math.floor(opts.limit)));
  const ctx = makeCtx(db, { hoursPerDay: opts.hoursPerDay ?? 8 });
  const dh = dayHours(db, opts.hoursPerDay ?? 8, true);
  const cals = calendarResolver(db, []);
  const axis = new Map([...projs.values()].map((p) => { const cal = cals.fallback(p.clndr_id); return [p.proj_id, { cal, dd: parseP6Date(p.last_recalc_date) ?? parseP6Date(p.plan_start_date), h: dh.cal(p.clndr_id) * 60 }]; }));
  const wd = (t: Row, s: string | undefined) => { const a = axis.get(t.proj_id)!, x = parseP6Date(s); return x == null || a.dd == null ? null : r2(a.cal.workBetween(a.dd, x) / a.h); };
  const days = (t: Row, h: string | undefined) => (h === '' || h == null ? null : r2(Number(h) / dh.task(t)));
  const columns: string[] = [...TABLE_COLUMNS.slice(0, 1), ...(opts.names ? ['name'] : []), ...TABLE_COLUMNS.slice(1)];
  const out = page.map((t) => {
    const start = t.act_start_date || t.early_start_date || t.restart_date || t.target_start_date, finish = t.act_end_date || t.early_end_date || t.reend_date || t.target_end_date;
    const row: unknown[] = [t.task_code, t.act_end_date ? 'CO' : t.act_start_date ? 'IP' : 'NS', TYPE[t.task_type] ?? t.task_type, d(start), d(finish), d(t.early_start_date), d(t.early_end_date), d(t.late_start_date), d(t.late_end_date),
      d(t.rem_late_start_date), d(t.rem_late_end_date), days(t, t.target_drtn_hr_cnt), days(t, t.remain_drtn_hr_cnt), t.act_end_date ? null : days(t, t.total_float_hr_cnt), t.act_end_date ? null : days(t, t.free_float_hr_cnt),
      isCritical(t, ctx), t.driving_path_flag === 'Y', wd(t, start), wd(t, finish)];
    if (opts.names) row.splice(1, 0, t.task_name ?? '');
    return row;
  });
  const end = offset + out.length;
  return { columns, rows: out, total: all.length, offset, next_offset: end < all.length ? end : null };
}

/** Resource assignments (TASKRSRC) or activity code assignments (TASKACTV) of the projects as one compact table, paged
 *  like activityTable: what an agent reads to see the whole schedule's resources or codes without one call per activity. */
export function linkTable(db: Db, projIds: string[] | null, of: 'assignments' | 'codes', opts: { offset?: number; limit?: number; hoursPerDay?: number } = {}): ActivityTable {
  const want = projIds ? new Set(projIds) : null, hpd = opts.hoursPerDay ?? 8;
  const task = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const proj = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name]));
  const baseline = new Set(rows(db, 'PROJECT').filter((p) => p._baseline_of).map((p) => p.proj_id));
  const mine = (r: Row) => { const t = task.get(r.task_id); return !!t && (!want || want.has(t.proj_id)) && !baseline.has(t.proj_id); };
  let columns: string[], make: (r: Row) => unknown[], all: Row[];
  if (of === 'assignments') {
    const rsrc = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r.rsrc_short_name])), role = new Map(rows(db, 'ROLES').map((r) => [r.role_id, r.role_short_name]));
    const n = (v: unknown) => (v === '' || v == null ? null : r2(Number(v)));
    columns = ['project', 'activity', 'resource', 'role', 'budgeted_units', 'remaining_units', 'actual_units', 'units_per_day', 'budgeted_cost', 'remaining_cost', 'actual_cost'];
    make = (r) => { const t = task.get(r.task_id)!; return [proj.get(t.proj_id), t.task_code, rsrc.get(r.rsrc_id) ?? null, role.get(r.role_id) ?? null, n(r.target_qty), n(r.remain_qty), n(Number(r.act_reg_qty || 0) + Number(r.act_ot_qty || 0)), r.target_qty_per_hr === '' || r.target_qty_per_hr == null ? null : r2(Number(r.target_qty_per_hr) * hpd), n(r.target_cost), n(r.remain_cost), n(Number(r.act_reg_cost || 0) + Number(r.act_ot_cost || 0))]; };
    all = rows(db, 'TASKRSRC').filter(mine);
  } else {
    const type = new Map(rows(db, 'ACTVTYPE').map((t) => [t.actv_code_type_id, t.actv_code_type])), value = new Map(rows(db, 'ACTVCODE').map((v) => [v.actv_code_id, v]));
    columns = ['project', 'activity', 'code_type', 'code', 'description'];
    make = (r) => { const t = task.get(r.task_id)!, v = value.get(r.actv_code_id); return [proj.get(t.proj_id), t.task_code, type.get(r.actv_code_type_id) ?? null, v?.short_name ?? null, v?.actv_code_name ?? null]; };
    all = rows(db, 'TASKACTV').filter(mine);
  }
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const page = opts.limit == null ? all.slice(offset) : all.slice(offset, offset + Math.max(0, Math.floor(opts.limit)));
  const end = offset + page.length;
  return { columns, rows: page.map(make), total: all.length, offset, next_offset: end < all.length ? end : null };
}
