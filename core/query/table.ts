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
