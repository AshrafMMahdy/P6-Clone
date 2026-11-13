// Which projects of a file are baselines, and which relationships are logic (a leaf module: the scheduler, the analyses and the queries all read it).
import { rows, type Db, type Row } from '../db.ts';

/** The baseline projects of a file: a project saved as a baseline (_baseline_of) or, in an XER read without markBaselines (the desktop's reader), a project row whose
 *  orig_proj_id names another project of the file (the way P6 writes a baseline). Every project not in this set is a project of its own. */
export function baselineProjectIds(db: Db): Set<string> {
  const P = rows(db, 'PROJECT'), ids = new Set(P.map((p) => p.proj_id));
  return new Set(P.filter((p) => p._baseline_of || (p.orig_proj_id && p.orig_proj_id !== p.proj_id && ids.has(p.orig_proj_id))).map((p) => p.proj_id));
}

/** The relationships that are logic: every relationship of the file but one between a baseline and another project. A baseline is a snapshot: such a row can be
 *  in a file (P6 can leave one, and this engine made them before whiq-v0.1.80), it stays in the file, and it is never read as a predecessor or a successor:
 *  not by the scheduler, not by an analysis, not by a query. Restored, the baseline is a project and its relationships count again. */
export function logicRelationships(db: Db): Row[] {
  const all = rows(db, 'TASKPRED'), snapshots = baselineProjectIds(db);
  if (!snapshots.size) return all;
  const proj = new Map(rows(db, 'TASK').map((t) => [t.task_id, t.proj_id]));
  return all.filter((r) => { const a = proj.get(r.task_id), b = proj.get(r.pred_task_id); return a == null || b == null || a === b || (!snapshots.has(a) && !snapshots.has(b)); });
}
