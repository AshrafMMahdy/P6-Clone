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


export interface TraceLink { rel: Row; from: string; to: string; ff: number | null }
/**
 * Trace Logic: the activity's predecessors and successors a number of levels deep (each activity once, at its
 * nearest level; level -1 = direct predecessors, 0 = the activity, 1 = direct successors) and the links walked.
 * relFF gives a link's relationship free float (0 = driving); drivingOnly walks only driving links.
 * Activities in other databases (external links) are skipped; a level stops growing at maxPerLevel.
 */
export function traceLogic(ctx: Pick<Ctx, 'predsOf' | 'succsOf' | 'taskById'>, taskId: string, opts: { preds: number; succs: number; drivingOnly?: boolean; maxPerLevel?: number }, relFF: (r: Row) => number | null): { levels: Map<number, string[]>; links: TraceLink[]; more: Map<number, number> } {
  const levels = new Map<number, string[]>([[0, [taskId]]]), more = new Map<number, number>();
  const seen = new Set([taskId]), over = new Set<string>(), walked = new Set<Row>(), links: TraceLink[] = [], max = opts.maxPerLevel ?? 50;
  for (const dir of [-1, 1]) {
    let frontier = [taskId];
    for (let lvl = 1; lvl <= (dir < 0 ? opts.preds : opts.succs) && frontier.length; lvl++) {
      const next: string[] = [];
      for (const x of frontier) for (const rel of (dir < 0 ? ctx.predsOf : ctx.succsOf).get(x) ?? []) {
        const o = dir < 0 ? rel.pred_task_id : rel.task_id;
        if (!ctx.taskById.has(o)) continue;
        const ff = relFF(rel);
        if (opts.drivingOnly && ff !== 0) continue;
        if (!seen.has(o)) {
          if (next.length >= max) { if (!over.has(o)) over.add(o), more.set(dir * lvl, (more.get(dir * lvl) ?? 0) + 1); continue; }
          seen.add(o); next.push(o);
        }
        if (!walked.has(rel)) walked.add(rel), links.push({ rel, from: rel.pred_task_id, to: rel.task_id, ff });
      }
      if (next.length) levels.set(dir * lvl, next);
      frontier = next;
    }
  }
  return { levels, links, more };
}
