// A copy of the database with only some projects in it: what a tool that takes "another open project" or another update of the
// project (compare, windows_analysis) sees as one file each. The Compare and Windows panels and the Export child (main/analysis-export.ts)
// build it the same way, so the screen and the exported tool agree.
import { rows, type Db } from '../core/db.ts';

/** The database with only the projects `ids` (and their activities, WBS, relationships and the rest of what is theirs): global rows
 *  (calendars, resources, code types: no Project ID) stay. A copy: nothing is shared with db. */
export function onlyProjects(db: Db, ids: string[]): Db {
  const keep = new Set(ids);
  const out = structuredClone(db);
  const tasks = new Set(rows(out, 'TASK').filter((t) => keep.has(t.proj_id)).map((t) => t.task_id));
  for (const [name, t] of Object.entries(out.tables)) {
    if (name === 'TASKPRED') t.rows = t.rows.filter((r) => tasks.has(r.task_id) && tasks.has(r.pred_task_id));
    else if (name === 'PROJECT') t.rows = t.rows.filter((r) => keep.has(r.proj_id));
    else if (t.fields.includes('proj_id')) t.rows = t.rows.filter((r) => !r.proj_id || keep.has(r.proj_id));
  }
  return out;
}
