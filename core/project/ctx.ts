// Lookup maps built once over a database (indexes by key, predecessors/successors, baselines) and the
// critical test. Shared by the desktop app, the AI assistant tools and the command-line tool.
import { groupBy, indexBy, rows, type Db, type Row } from '../db.ts';

/** Context computed once for column getters and lookups. */
export interface Ctx<P = { hoursPerDay: number }> {
  db: Db; prefs: P;
  proj: Map<string, Row>;
  wbs: Map<string, Row>;
  cal: Map<string, Row>;
  rsrc: Map<string, Row>;
  rsrcByTask: Map<string, Row[]>;
  predsOf: Map<string, Row[]>;
  succsOf: Map<string, Row[]>;
  taskById: Map<string, Row>;
  baseline: Map<string, Row>; // task_code|proj_id -> baseline task row
  costByTask: Map<string, Row[]>;
}

export function makeCtx<P>(db: Db, prefs: P): Ctx<P> {
  const tasks = rows(db, 'TASK');
  const baseline = new Map<string, Row>();
  for (const p of rows(db, 'PROJECT')) {
    const bl = p.sum_base_proj_id && p.sum_base_proj_id !== p.proj_id ? p.sum_base_proj_id : '';
    if (!bl) continue;
    for (const t of tasks) if (t.proj_id === bl) baseline.set(`${t.task_code}|${p.proj_id}`, t);
  }
  return {
    db, prefs,
    proj: indexBy(rows(db, 'PROJECT'), 'proj_id'),
    wbs: indexBy(rows(db, 'PROJWBS'), 'wbs_id'),
    cal: indexBy(rows(db, 'CALENDAR'), 'clndr_id'),
    rsrc: indexBy(rows(db, 'RSRC'), 'rsrc_id'),
    rsrcByTask: groupBy(rows(db, 'TASKRSRC'), 'task_id'),
    predsOf: groupBy(rows(db, 'TASKPRED'), 'task_id'),
    succsOf: groupBy(rows(db, 'TASKPRED'), 'pred_task_id'),
    taskById: indexBy(tasks, 'task_id'),
    baseline,
    costByTask: groupBy(rows(db, 'PROJCOST'), 'task_id'),
  };
}

export function isCritical(r: Row, ctx: { proj: Map<string, Row> }): boolean {
  if (r.act_end_date || r.total_float_hr_cnt === '' || r.total_float_hr_cnt == null) return false;
  const p = ctx.proj.get(r.proj_id);
  if (p?.critical_path_type === 'CT_DrivPath') return r.driving_path_flag === 'Y';
  return Number(r.total_float_hr_cnt) <= Number(p?.critical_drtn_hr_cnt || 0);
}
