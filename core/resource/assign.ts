// Resource assignments (TASKRSRC): P6 duration-type rules and cost = units x price.
import { addField, nextId, rows, table, type Db, type Row } from '../db.ts';
import { p6num } from '../schedule/cpm.ts';
import { pick } from '../journal.ts';

export const ASSIGN_FIELDS = ['taskrsrc_id', 'task_id', 'proj_id', 'cost_qty_link_flag', 'role_id', 'acct_id', 'rsrc_id', 'remain_qty', 'target_qty', 'remain_qty_per_hr', 'target_qty_per_hr', 'act_ot_qty', 'act_reg_qty', 'cost_per_qty', 'target_cost', 'act_reg_cost', 'act_ot_cost', 'remain_cost', 'act_start_date', 'act_end_date', 'restart_date', 'reend_date', 'target_start_date', 'target_end_date', 'rem_late_start_date', 'rem_late_end_date', 'rate_type', 'curv_id', 'rsrc_type', 'cost_per_qty_source_type'];

/** Price per unit: the assignment's own rate, else the resource's rate in effect at the activity start. */
export function priceOf(db: Db, a: Row, at?: string): number {
  if (a.cost_per_qty && a.cost_per_qty_source_type === 'ST_Custom') return Number(a.cost_per_qty);
  const rid = a.rsrc_id;
  const rates = pick(rows(db, 'RSRCRATE'), (r) => r.rsrc_id === rid).sort((x, y) => (x.start_date || '').localeCompare(y.start_date || ''));
  const when = at ?? a.target_start_date ?? '';
  let rate: Row | undefined;
  for (const r of rates) if (!r.start_date || !when || r.start_date <= when) rate = r;
  rate ??= rates[0];
  const field = a.rate_type && a.rate_type !== 'COST_PER_QTY' ? a.rate_type.toLowerCase() : 'cost_per_qty';
  if (rate) return Number(rate[field] ?? rate.cost_per_qty ?? 0);
  return Number(a.cost_per_qty || 0);
}

export function recomputeCosts(db: Db, a: Row): void {
  if (a.cost_qty_link_flag === 'N') return;
  const p = priceOf(db, a);
  a.cost_per_qty = p6num(p);
  a.target_cost = p6num(Number(a.target_qty || 0) * p);
  a.act_reg_cost = p6num(Number(a.act_reg_qty || 0) * p);
  a.act_ot_cost = p6num(Number(a.act_ot_qty || 0) * p);
  a.remain_cost = p6num(Number(a.remain_qty || 0) * p);
}

/**
 * Change an assignment value the way P6 does. Units changes on Fixed Units / Fixed Units/Time activities
 * change the activity duration; otherwise units/time is recalculated.
 */
export function recalcAssignment(db: Db, task: Row, a: Row, field: 'target_qty' | 'act_reg_qty' | 'remain_qty' | 'target_qty_per_hr', value: number): void {
  const started = !!task.act_start_date;
  const durH = Number(task.target_drtn_hr_cnt || 0);
  const remH = Number(task.remain_drtn_hr_cnt || 0);
  a[field] = p6num(Math.max(0, value));
  const act = Number(a.act_reg_qty || 0) + Number(a.act_ot_qty || 0);
  if (field === 'target_qty') {
    a.remain_qty = p6num(started ? Math.max(0, value - act) : value);
    const fixedUnits = task.duration_type === 'DT_FixedQty' || task.duration_type === 'DT_FixedRate';
    const rate = Number(a.target_qty_per_hr || 0);
    if (fixedUnits && rate > 0 && !started && task.task_type !== 'TT_Mile' && task.task_type !== 'TT_FinMile') {
      const h = value / rate;
      task.target_drtn_hr_cnt = p6num(h);
      task.remain_drtn_hr_cnt = p6num(h);
    } else if (durH > 0) a.target_qty_per_hr = p6num(value / durH);
  } else if (field === 'act_reg_qty') {
    a.remain_qty = p6num(Math.max(0, Number(a.target_qty || 0) - act));
  } else if (field === 'target_qty_per_hr') {
    a.target_qty = p6num(value * durH);
    a.remain_qty = p6num(started ? Math.max(0, value * durH - act) : value * durH);
  }
  a.remain_qty_per_hr = remH > 0 ? p6num(Number(a.remain_qty || 0) / remH) : a.target_qty_per_hr;
  recomputeCosts(db, a);
}

/** Assign a resource to an activity with its default units/time over the activity duration. */
export function assignResource(db: Db, task: Row, rsrcId: string, roleId = ''): Row {
  const T = table(db, 'TASKRSRC');
  for (const f of ASSIGN_FIELDS) addField(T, f);
  const rsrc = pick(rows(db, 'RSRC'), (r) => r.rsrc_id === rsrcId, 1)[0];
  const perHr = Number(rsrc?.def_qty_per_hr || 1);
  const durH = Number(task.target_drtn_hr_cnt || 0);
  const remH = Number(task.remain_drtn_hr_cnt || 0);
  const a: Row = {
    taskrsrc_id: String(nextId(db, 'TASKRSRC')), task_id: task.task_id, proj_id: task.proj_id, cost_qty_link_flag: 'Y', role_id: roleId, acct_id: '', rsrc_id: rsrcId,
    remain_qty: p6num(perHr * remH), target_qty: p6num(perHr * durH), remain_qty_per_hr: p6num(perHr), target_qty_per_hr: p6num(perHr), act_ot_qty: '0', act_reg_qty: '0',
    cost_per_qty: '0', target_cost: '0', act_reg_cost: '0', act_ot_cost: '0', remain_cost: '0', act_start_date: '', act_end_date: '',
    restart_date: task.restart_date || task.early_start_date || '', reend_date: task.reend_date || task.early_end_date || '',
    target_start_date: task.target_start_date || '', target_end_date: task.target_end_date || '', rem_late_start_date: '', rem_late_end_date: '',
    rate_type: 'COST_PER_QTY', curv_id: '', rsrc_type: rsrc?.rsrc_type || 'RT_Labor', cost_per_qty_source_type: 'ST_Rsrc',
  };
  if (rsrc?.rsrc_type === 'RT_Mat') { a.target_qty = '0'; a.remain_qty = '0'; a.target_qty_per_hr = '0'; a.remain_qty_per_hr = '0'; }
  recomputeCosts(db, a);
  T.rows.push(a);
  return a;
}

/** After scheduling, assignment dates follow their activity (linear spread assumption). */
export function syncAssignmentDates(db: Db, taskIds?: Set<string>): void {
  const tasks = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  for (const a of rows(db, 'TASKRSRC')) {
    if (taskIds && !taskIds.has(a.task_id)) continue;
    const t = tasks.get(a.task_id);
    if (!t) continue;
    a.restart_date = t.act_end_date ? '' : t.restart_date || t.early_start_date || '';
    a.reend_date = t.act_end_date ? '' : t.reend_date || t.early_end_date || '';
    a.rem_late_start_date = t.act_end_date ? '' : t.rem_late_start_date || '';
    a.rem_late_end_date = t.act_end_date ? '' : t.rem_late_end_date || '';
    if (!t.act_start_date) { a.target_start_date = t.target_start_date || a.target_start_date; a.target_end_date = t.target_end_date || a.target_end_date; }
    a.act_start_date = t.act_start_date || '';
    a.act_end_date = t.act_end_date || '';
  }
}

/** Actual units and costs entered on an assignment. A cost typed in is the cost (P6 turns the units/price link off for it). */
export function assignmentActuals(a: Row, op: Record<string, unknown>, num: (v: unknown, name: string) => number): void {
  if (op.actual_units != null) { const q = num(op.actual_units, 'actual_units'); a.act_reg_qty = p6num(q); a.remain_qty = p6num(Math.max(0, Number(a.target_qty || 0) - q)); }
  if (op.budgeted_cost != null || op.actual_cost != null || op.remaining_cost != null) {
    a.cost_qty_link_flag = 'N';
    if (op.budgeted_cost != null) a.target_cost = p6num(num(op.budgeted_cost, 'budgeted_cost'));
    if (op.actual_cost != null) a.act_reg_cost = p6num(num(op.actual_cost, 'actual_cost'));
    a.remain_cost = p6num(op.remaining_cost != null ? num(op.remaining_cost, 'remaining_cost') : Math.max(0, Number(a.target_cost || 0) - Number(a.act_reg_cost || 0) - Number(a.act_ot_cost || 0)));
  }
}
