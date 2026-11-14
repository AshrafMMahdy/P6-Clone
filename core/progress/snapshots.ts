// A baseline's links: relationships with one end in a baseline and the other outside it. P6 keeps them (Oracle, "Modify a baseline manually": "When a baseline
// contains relationships to non-baseline projects, these relationships are maintained and copied when a baseline is restored"), its scheduler never reads them, and
// planners see them as links of the baseline. Here: they stay in the file, every reader of LOGIC takes its relationships from logicRelationships (the scheduler, the
// analyses, the queries, the reports, the comparisons), the agent is shown them apart (baselineLinks) and can delete them, and a restored baseline's links are logic again.
// (A leaf module: it imports the tables only.)
import { rows, type Db, type Row } from '../db.ts';

const snapshotIds = (db: Db): Set<string> => new Set(rows(db, 'PROJECT').filter((p) => p._baseline_of).map((p) => p.proj_id));
/** The test of a baseline's link, for a caller that has its own way from an activity to its project (an index it keeps); null when the file holds no baseline. */
export function baselineLinkTest(db: Db, projOf: (taskId: string) => string | undefined): ((r: Row) => boolean) | null {
  const snapshots = snapshotIds(db);
  if (!snapshots.size) return null;
  return (r) => { const a = projOf(r.task_id), b = projOf(r.pred_task_id); return a != null && b != null && a !== b && (snapshots.has(a) || snapshots.has(b)); };
}
function split(db: Db): { logic: Row[]; links: Row[] } {
  const all = rows(db, 'TASKPRED');
  let proj: Map<string, string> | undefined;
  const isLink = baselineLinkTest(db, (id) => (proj ??= new Map(rows(db, 'TASK').map((t) => [t.task_id, t.proj_id]))).get(id));
  if (!isLink) return { logic: all, links: [] };
  const logic: Row[] = [], links: Row[] = [];
  for (const r of all) (isLink(r) ? links : logic).push(r);
  return { logic, links };
}
/** The relationships that are logic: every relationship of the file but a baseline's links. */
export const logicRelationships = (db: Db): Row[] => split(db).logic;
/** A baseline's links: the relationships between an activity of a baseline and an activity outside that baseline. */
export const baselineLinks = (db: Db): Row[] => split(db).links;
