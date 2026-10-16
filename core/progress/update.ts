// Tools > Update Progress: auto-status activities to a new data date from their planned dates.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { calendarResolver, p6num } from '../schedule/cpm.ts';

export interface ProgressSummary { started: number; completed: number; updated: number; dataDate: string }

/** Duration % complete as P6 derives it: (original - remaining) / original. */
export function durationPct(r: Row): number {
  const orig = Number(r.target_drtn_hr_cnt || 0), rem = Number(r.remain_drtn_hr_cnt || 0);
  if (r.act_end_date) return 100;
  if (!orig) return r.act_start_date ? 0 : 0;
  return Math.max(0, Math.min(100, ((orig - rem) / orig) * 100));
}

/** Scale resource assignment actuals to the activity's progress. */
export function applyAssignmentActuals(db: Db, task: Row, pct: number): void {
  for (const a of rows(db, 'TASKRSRC')) {
    if (a.task_id !== task.task_id) continue;
    const budQ = Number(a.target_qty || 0), budC = Number(a.target_cost || 0);
    const actQ = (budQ * pct) / 100, actC = (budC * pct) / 100;
    Object.assign(a, {
      act_reg_qty: p6num(actQ), remain_qty: p6num(Math.max(0, budQ - actQ)),
      act_reg_cost: p6num(actC), remain_cost: p6num(Math.max(0, budC - actC)),
      act_start_date: a.act_start_date || task.act_start_date || '',
      act_end_date: pct >= 100 ? task.act_end_date || '' : '',
    });
  }
}

export function updateProgress(db: Db, projId: string, newDataDate: number): ProgressSummary {
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId);
  if (!proj) throw new Error(`project ${projId} not found`);
  const cals = calendarResolver(db, []);
  const T = table(db, 'TASK');
  for (const f of ['act_start_date', 'act_end_date', 'status_code', 'remain_drtn_hr_cnt', 'phys_complete_pct']) addField(T, f);
  const s: ProgressSummary = { started: 0, completed: 0, updated: 0, dataDate: formatP6Date(newDataDate) };
  for (const r of T.rows) {
    if (r.proj_id !== projId || r.act_end_date || r.task_type === 'TT_WBS') continue;
    const ps = parseP6Date(r.target_start_date) ?? parseP6Date(r.early_start_date);
    const pf = parseP6Date(r.target_end_date) ?? parseP6Date(r.early_end_date);
    if (ps == null || pf == null || ps >= newDataDate) continue;
    const cal = cals.get(r.clndr_id) ?? cals.fallback(proj.clndr_id);
    if (!r.act_start_date) { r.act_start_date = formatP6Date(ps); s.started++; }
    if (pf <= newDataDate) {
      r.act_end_date = formatP6Date(pf);
      r.remain_drtn_hr_cnt = '0';
      r.status_code = 'TK_Complete';
      s.completed++;
    } else {
      r.remain_drtn_hr_cnt = p6num(Math.max(0, cal.workBetween(newDataDate, pf)) / 60);
      r.status_code = 'TK_Active';
      s.updated++;
    }
    const pct = durationPct(r);
    if (r.complete_pct_type === 'CP_Phys' || !r.complete_pct_type) r.phys_complete_pct = p6num(pct);
    applyAssignmentActuals(db, r, pct);
  }
  proj.last_recalc_date = formatP6Date(newDataDate);
  return s;
}
