// Financial periods and Store Period Performance (P6: Admin > Financial Periods, Tools > Store Period Performance).
// Storing writes the period's actuals, earned value and planned value per activity (TASKFIN) and per assignment
// (TRSRCFIN) into the chosen financial period, then sets Actual This Period to zero. With "Link actual to date and
// actual this period" (which P6 requires), a period's value is the value to date less what the other periods stored;
// storing the same period again overwrites it, as in P6. Past periods then drive the S-curves (analysis/curves.ts).
import { addField, groupBy, nextId, rows, table, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { removeWhere } from '../journal.ts';
import { activityCosts, baselineActivities, percentComplete, plannedShare } from '../cost/rollup.ts';
import { p6num } from '../schedule/cpm.ts';

export const FINDATES_FIELDS = ['fin_dates_id', 'fin_dates_name', 'start_date', 'end_date'] as const;
const TASKFIN_FIELDS = ['fin_dates_id', 'task_id', 'proj_id', 'act_work_qty', 'act_work_cost', 'act_equip_qty', 'act_equip_cost', 'act_mat_cost', 'act_expense_cost', 'bcwp', 'perfm_work_qty', 'bcws', 'sched_work_qty'] as const;
const TRSRCFIN_FIELDS = ['fin_dates_id', 'taskrsrc_id', 'task_id', 'proj_id', 'act_qty', 'act_cost'] as const;

const n = (s: string | undefined) => Number(s || 0) || 0;
const money = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

/** The financial periods, earliest first. */
export function financialPeriods(db: Db): Row[] {
  return [...rows(db, 'FINDATES')].sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
}

/** The period to store by default: the latest one that starts on a day before the project's data date (the data date
 *  is normally the first day of the next period, at 00:00 or at the work start time). */
export function defaultPeriod(db: Db, project: Row): Row | undefined {
  const day = (project.last_recalc_date || new Date().toISOString()).slice(0, 10);
  return financialPeriods(db).filter((f) => (f.start_date || '').slice(0, 10) < day).pop();
}

/** A period that would overlap one already defined (P6 keeps them apart), or null. */
export function overlapping(db: Db, start: string, end: string, except?: string): Row | null {
  const s = parseP6Date(start)!, e = parseP6Date(end)!;
  return rows(db, 'FINDATES').find((f) => f.fin_dates_id !== except && (parseP6Date(f.start_date) ?? 0) <= e && (parseP6Date(f.end_date) ?? 0) >= s) ?? null;
}

export function addPeriod(db: Db, name: string, start: string, end: string): Row {
  const T = table(db, 'FINDATES');
  for (const f of FINDATES_FIELDS) addField(T, f);
  const r: Row = { fin_dates_id: String(nextId(db, 'FINDATES')), fin_dates_name: name, start_date: start, end_date: end };
  T.rows.push(r);
  return r;
}

export interface StoreResult { project: string; period: string; activities: number; assignments: number; stored: { labor_units: number; labor_cost: number; nonlabor_units: number; nonlabor_cost: number; material_cost: number; expense_cost: number; earned_value: number; planned_value: number } }

/** Store Period Performance for one project into one financial period (one undoable change when run inside an edit). */
export function storePeriodPerformance(db: Db, projId: string, finDatesId: string): StoreResult | { error: string } {
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === projId);
  if (!p) return { error: 'No such project.' };
  if (p._baseline_of) return { error: `${p.proj_short_name} is a baseline; period performance is stored for projects.` };
  const fin = rows(db, 'FINDATES').find((f) => f.fin_dates_id === finDatesId);
  if (!fin) return { error: 'No such financial period.' };
  if (p.act_this_per_link_flag !== 'Y') return { error: `P6 stores period performance only with "Link actual to date and actual this period units and costs" on (Project Details, Calculations); ${p.proj_short_name} has it off (set_fields PROJECT act_this_per_link_flag = Y).` };

  const tasks = rows(db, 'TASK').filter((t) => t.proj_id === projId);
  const ids = new Set(tasks.map((t) => t.task_id));
  const asgBy = groupBy(rows(db, 'TASKRSRC').filter((a) => ids.has(a.task_id)), 'task_id');
  const expBy = groupBy(rows(db, 'PROJCOST').filter((c) => ids.has(c.task_id)), 'task_id');
  const kind = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r.rsrc_type]));
  // what the other periods hold (this period's own rows are overwritten)
  const otherTask = groupBy(rows(db, 'TASKFIN').filter((f) => ids.has(f.task_id) && f.fin_dates_id !== finDatesId), 'task_id');
  const otherAsg = groupBy(rows(db, 'TRSRCFIN').filter((f) => ids.has(f.task_id) && f.fin_dates_id !== finDatesId), 'taskrsrc_id');
  const before = (l: Row[] | undefined, f: string) => (l ?? []).reduce((s, r) => s + n(r[f]), 0);
  // earned and planned value as the earned value report has them; labor units by the same baseline and shares
  const costs = activityCosts(db, [projId]);
  const bl = baselineActivities(db, [projId]), dd = parseP6Date(p.last_recalc_date) ?? 0;
  const blAsg = p.sum_base_proj_id ? groupBy(rows(db, 'TASKRSRC').filter((a) => a.proj_id === p.sum_base_proj_id), 'task_id') : null;
  // the labor units budget at completion: the baseline activity's (none when it was added after the baseline), as BAC
  const laborBudget = (t: Row) => {
    const b = bl.get(`${projId}|${t.task_code}`);
    const src = blAsg ? (b ? blAsg.get(b.task_id) ?? [] : []) : asgBy.get(t.task_id) ?? [];
    return src.filter((a) => kind.get(a.rsrc_id) === 'RT_Labor').reduce((s, a) => s + n(a.target_qty), 0);
  };

  const TF = table(db, 'TASKFIN'), RF = table(db, 'TRSRCFIN');
  for (const f of TASKFIN_FIELDS) addField(TF, f);
  for (const f of TRSRCFIN_FIELDS) addField(RF, f);
  removeWhere(TF.rows, (r) => r.fin_dates_id === finDatesId && ids.has(r.task_id));
  removeWhere(RF.rows, (r) => r.fin_dates_id === finDatesId && ids.has(r.task_id));
  const total = { labor_units: 0, labor_cost: 0, nonlabor_units: 0, nonlabor_cost: 0, material_cost: 0, expense_cost: 0, earned_value: 0, planned_value: 0 };
  let nTask = 0, nAsg = 0;
  for (const t of tasks) {
    const A = asgBy.get(t.task_id) ?? [], E = expBy.get(t.task_id) ?? [];
    const sum = (type: string, f: (a: Row) => number) => A.filter((a) => kind.get(a.rsrc_id) === type).reduce((s, a) => s + f(a), 0);
    // units to date: the assignments', or the activity's own actual units when it has none of that kind (P6 keeps them
    // on the activity then; imported files and transfer_progress write them)
    const units = (type: string, own: string) => (A.some((a) => kind.get(a.rsrc_id) === type) ? sum(type, (a) => n(a.act_reg_qty) + n(a.act_ot_qty)) : n(t[own]));
    const qty = (a: Row) => n(a.act_reg_qty) + n(a.act_ot_qty), cost = (a: Row) => n(a.act_reg_cost) + n(a.act_ot_cost);
    const c = costs.get(t.task_id)!;
    const frac = plannedShare(t, bl.get(`${projId}|${t.task_code}`), dd), pct = percentComplete(t, A), lb = laborBudget(t);
    const prior = otherTask.get(t.task_id);
    const v = {
      act_work_qty: units('RT_Labor', 'act_work_qty') - before(prior, 'act_work_qty'), act_work_cost: sum('RT_Labor', cost) - before(prior, 'act_work_cost'),
      act_equip_qty: units('RT_Equip', 'act_equip_qty') - before(prior, 'act_equip_qty'), act_equip_cost: sum('RT_Equip', cost) - before(prior, 'act_equip_cost'),
      act_mat_cost: sum('RT_Mat', cost) - before(prior, 'act_mat_cost'), act_expense_cost: E.reduce((s, x) => s + n(x.act_cost), 0) - before(prior, 'act_expense_cost'),
      bcwp: c.ev - before(prior, 'bcwp'), perfm_work_qty: lb * pct - before(prior, 'perfm_work_qty'),
      bcws: c.pv - before(prior, 'bcws'), sched_work_qty: lb * frac - before(prior, 'sched_work_qty'),
    };
    if (Object.values(v).some((x) => Math.abs(x) > 0.005)) {
      TF.rows.push({ fin_dates_id: finDatesId, task_id: t.task_id, proj_id: projId, act_work_qty: p6num(v.act_work_qty), act_work_cost: money(v.act_work_cost), act_equip_qty: p6num(v.act_equip_qty), act_equip_cost: money(v.act_equip_cost), act_mat_cost: money(v.act_mat_cost), act_expense_cost: money(v.act_expense_cost), bcwp: money(v.bcwp), perfm_work_qty: p6num(v.perfm_work_qty), bcws: money(v.bcws), sched_work_qty: p6num(v.sched_work_qty) });
      nTask++;
      total.labor_units += v.act_work_qty; total.labor_cost += v.act_work_cost; total.nonlabor_units += v.act_equip_qty; total.nonlabor_cost += v.act_equip_cost;
      total.material_cost += v.act_mat_cost; total.expense_cost += v.act_expense_cost; total.earned_value += v.bcwp; total.planned_value += v.bcws;
    }
    for (const a of A) {
      const prev = otherAsg.get(a.taskrsrc_id);
      const q = qty(a) - before(prev, 'act_qty'), k = cost(a) - before(prev, 'act_cost');
      if (Math.abs(q) > 0.005 || Math.abs(k) > 0.005) { RF.rows.push({ fin_dates_id: finDatesId, taskrsrc_id: a.taskrsrc_id, task_id: t.task_id, proj_id: projId, act_qty: p6num(q), act_cost: money(k) }); nAsg++; }
      // Actual This Period starts again from zero
      if (a.act_this_per_qty !== undefined) a.act_this_per_qty = '0';
      if (a.act_this_per_cost !== undefined) a.act_this_per_cost = '0';
    }
    if (t.act_this_per_work_qty !== undefined) t.act_this_per_work_qty = '0';
    if (t.act_this_per_equip_qty !== undefined) t.act_this_per_equip_qty = '0';
  }
  addField(table(db, 'PROJECT'), 'last_fin_dates_id');
  p.last_fin_dates_id = finDatesId;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { project: p.proj_short_name, period: fin.fin_dates_name, activities: nTask, assignments: nAsg, stored: Object.fromEntries(Object.entries(total).map(([k, x]) => [k, r2(x)])) as StoreResult['stored'] };
}
