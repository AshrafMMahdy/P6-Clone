// Copy a project inside the database (WBS, activities, logic, assignments, codes, UDFs, notebooks, expenses), the
// way an XER export of it would be imported as a new project: every internal id is renumbered by the importer,
// shared dictionaries (calendars, resources, code types) are reused by name. By default the copy is a clean
// template: progress is cleared, and with a new start date every planned date moves by the same amount.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { selectRows } from '../xer/write.ts';
import { importIntoDb } from '../xer/import.ts';
import { projectName } from './edit.ts';

export interface CopyOptions { id: string; name?: string; start?: string; keepProgress?: boolean }

const TASK_DATES = ['target_start_date', 'target_end_date', 'early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'restart_date', 'reend_date', 'rem_late_start_date', 'rem_late_end_date', 'cstr_date', 'cstr_date2', 'expect_end_date', 'external_early_start_date', 'external_late_end_date'];
const ASG_DATES = ['target_start_date', 'target_end_date', 'restart_date', 'reend_date', 'rem_late_start_date', 'rem_late_end_date'];

/** Returns the new project's proj_id. */
export function copyProject(db: Db, srcProjId: string, o: CopyOptions): string {
  const srcProj = rows(db, 'PROJECT').find((p) => p.proj_id === srcProjId);
  if (!srcProj) throw new Error('No such project.');
  const src: Db = { tables: {} };
  for (const [n, rs] of selectRows(db, [srcProjId])) {
    // baselines of the source are not part of a copy
    const keep = n === 'PROJECT' ? rs.filter((p) => p.proj_id === srcProjId) : rs;
    src.tables[n] = { name: n, fields: [...(db.tables[n]?.fields ?? Object.keys(keep[0] ?? {}))], rows: keep.map((r) => ({ ...r })) };
  }
  const res = importIntoDb(db, src, { projects: [{ srcProjId, action: 'new' }] });
  const pid = res.projIds[0];
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === pid)!;
  delete p._baseline_of;
  p.proj_short_name = o.id;
  p.sum_base_proj_id = '';
  const root = rows(db, 'PROJWBS').find((w) => w.proj_id === pid && w.proj_node_flag === 'Y');
  if (root) { root.wbs_short_name = o.id; root.wbs_name = o.name ?? `${projectName(db, srcProj)} (copy)`; }
  const tasks = rows(db, 'TASK').filter((t) => t.proj_id === pid);
  const asgs = rows(db, 'TASKRSRC').filter((a) => a.proj_id === pid);
  // the copy is not the Microsoft Project file: none of what was kept of it (UIDs, elements, snapshots) goes with it
  for (const r of [p, ...tasks, ...asgs, ...rows(db, 'PROJWBS').filter((w) => w.proj_id === pid)]) for (const f of Object.keys(r)) if (f.startsWith('_msp_')) delete r[f];
  if (!o.keepProgress) {
    for (const t of tasks) {
      for (const f of ['act_start_date', 'act_end_date', 'suspend_date', 'resume_date', 'expect_end_date']) if (t[f]) t[f] = '';
      t.remain_drtn_hr_cnt = t.target_drtn_hr_cnt;
      for (const f of ['phys_complete_pct', 'act_work_qty', 'act_equip_qty', 'act_this_per_work_qty', 'act_this_per_equip_qty']) if (f in t) t[f] = '0';
      if ('remain_work_qty' in t) t.remain_work_qty = t.target_work_qty ?? '0';
      if ('remain_equip_qty' in t) t.remain_equip_qty = t.target_equip_qty ?? '0';
      t.status_code = 'TK_NotStart';
      if (t.target_start_date) t.early_start_date = t.restart_date = t.target_start_date;
      if (t.target_end_date) t.early_end_date = t.reend_date = t.target_end_date;
    }
    for (const a of asgs) {
      for (const f of ['act_start_date', 'act_end_date']) if (a[f]) a[f] = '';
      for (const f of ['act_reg_qty', 'act_ot_qty', 'act_reg_cost', 'act_ot_cost', 'act_this_per_qty', 'act_this_per_cost']) if (f in a) a[f] = '0';
      if ('remain_qty' in a) a.remain_qty = a.target_qty ?? '0';
      if ('remain_cost' in a) a.remain_cost = a.target_cost ?? '0';
    }
    for (const c of rows(db, 'PROJCOST').filter((x) => x.proj_id === pid)) { if ('act_cost' in c) c.act_cost = '0'; if ('remain_cost' in c) c.remain_cost = c.target_cost ?? '0'; }
  }
  if (o.start) {
    const from = parseP6Date(p.plan_start_date || p.last_recalc_date || '');
    const to = parseP6Date(o.start);
    if (to == null) throw new Error(`Bad start date "${o.start}".`);
    const delta = from == null ? 0 : to - from;
    const shift = (r: Row, fields: string[]) => { for (const f of fields) { const v = r[f] ? parseP6Date(r[f]) : null; if (v != null) r[f] = formatP6Date(v + delta); } };
    if (delta) { for (const t of tasks) shift(t, TASK_DATES); for (const a of asgs) shift(a, ASG_DATES); shift(p, ['plan_end_date', 'scd_end_date']); }
    p.plan_start_date = p.last_recalc_date = formatP6Date(to);
  } else if (!o.keepProgress && p.plan_start_date) {
    p.last_recalc_date = p.plan_start_date; // nothing is progressed, so the data date goes back to the start
  }
  return pid;
}
