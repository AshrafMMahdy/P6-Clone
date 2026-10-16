// Activity cost rollups and basic earned value (BAC, PV, EV, AC, SPI, CPI).
import { groupBy, rows, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';

export interface CostLine { bac: number; actual: number; remaining: number; eac: number; pv: number; ev: number; ac: number }

const n = (s: string | undefined) => Number(s || 0) || 0;

/** % complete per the activity's percent complete type (duration % for CP_Drtn, physical, or units). */
export function percentComplete(t: Row, asg: Row[]): number {
  if (t.act_end_date) return 1;
  if (!t.act_start_date) return 0;
  if (t.complete_pct_type === 'CP_Phys') return n(t.phys_complete_pct) / 100;
  if (t.complete_pct_type === 'CP_Units') {
    const bud = asg.reduce((a, x) => a + n(x.target_qty), 0);
    return bud ? asg.reduce((a, x) => a + n(x.act_reg_qty) + n(x.act_ot_qty), 0) / bud : 0;
  }
  const o = n(t.target_drtn_hr_cnt);
  return o ? Math.max(0, Math.min(1, (o - n(t.remain_drtn_hr_cnt)) / o)) : 0;
}

/** Cost line per activity. Planned value uses the baseline activity's dates when one is assigned, else planned dates. */
export function activityCosts(db: Db, projIds: string[]): Map<string, CostLine> {
  const asgBy = groupBy(rows(db, 'TASKRSRC'), 'task_id');
  const expBy = groupBy(rows(db, 'PROJCOST'), 'task_id');
  const projects = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p]));
  const bl = new Map<string, Row>();
  for (const pid of projIds) {
    const bid = projects.get(pid)?.sum_base_proj_id;
    if (bid) for (const t of rows(db, 'TASK')) if (t.proj_id === bid) bl.set(`${pid}|${t.task_code}`, t);
  }
  const out = new Map<string, CostLine>();
  for (const t of rows(db, 'TASK')) {
    if (!projIds.includes(t.proj_id)) continue;
    const a = asgBy.get(t.task_id) ?? [], e = expBy.get(t.task_id) ?? [];
    const bac = a.reduce((s, x) => s + n(x.target_cost), 0) + e.reduce((s, x) => s + n(x.target_cost), 0);
    const actual = a.reduce((s, x) => s + n(x.act_reg_cost) + n(x.act_ot_cost), 0) + e.reduce((s, x) => s + n(x.act_cost), 0);
    const remaining = a.reduce((s, x) => s + n(x.remain_cost), 0) + e.reduce((s, x) => s + n(x.remain_cost), 0);
    const dd = parseP6Date(projects.get(t.proj_id)?.last_recalc_date) ?? 0;
    const b = bl.get(`${t.proj_id}|${t.task_code}`) ?? t;
    const ps = parseP6Date(b.target_start_date || b.early_start_date), pf = parseP6Date(b.target_end_date || b.early_end_date);
    let frac = 0;
    if (ps != null && pf != null) frac = dd >= pf ? 1 : dd <= ps ? 0 : (dd - ps) / Math.max(1, pf - ps);
    const ev = bac * percentComplete(t, a);
    out.set(t.task_id, { bac, actual, remaining, eac: actual + remaining, pv: bac * frac, ev, ac: actual });
  }
  return out;
}

export function sumLines(lines: Iterable<CostLine>): CostLine {
  const s: CostLine = { bac: 0, actual: 0, remaining: 0, eac: 0, pv: 0, ev: 0, ac: 0 };
  for (const l of lines) for (const k of Object.keys(s) as (keyof CostLine)[]) s[k] += l[k];
  return s;
}

export const spi = (l: CostLine) => (l.pv ? l.ev / l.pv : 0);
export const cpi = (l: CostLine) => (l.ac ? l.ev / l.ac : 0);
