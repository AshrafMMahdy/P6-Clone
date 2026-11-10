// What a panel's Apply does with a result of a tool run (Crashing, Optimize): refused, as text, when the project changed since the run, else
// the proposal's edit operations, F9 and anything after it as one undoable change. No window or React in here, so a test can run it
// (tests/screens-run-as-tools.test.ts).
import { getUi, mutate } from '../store.ts';
import type { Db } from '../../core/db.ts';
import { applyOps } from '../../core/project/ops.ts';
import { scheduleProjects } from '../../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../../core/resource/assign.ts';
import { writeWhiqFields, type FieldData } from '../../core/analysis/whiq-fields.ts';
import { levelInProposedOrder, staleReason, type PriorityEntry, type RunStamp } from './toolAnswers.ts';
import { stampNow } from './toolRun.ts';

/** Edit operations, F9 and anything after it (leveling) as one undoable change; a refused step leaves nothing. Returns why it was refused
 *  (null: applied): the panel shows that as text, and keeps the result on screen. */
export function applyAndSchedule(label: string, ops: unknown[], after?: (d: Db) => void): string | null {
  const ui = getUi();
  let err = '';
  try {
    mutate(label, (d) => {
      const r = applyOps(d, ops, { hoursPerDay: ui.prefs.hoursPerDay });
      if (!r.ok) { err = r.error!.message; throw new Error(err); }
      const s = scheduleProjects(d, ui.openProjects, {});
      if (!s.ok) { err = s.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' ') || 'the changed schedule cannot be scheduled'; throw new Error(err); }
      after?.(d);
      syncAssignmentDates(d);
    });
  } catch (e) { err ||= (e as Error).message; } // (reported below: a refusal in words, nothing changed)
  return err ? `Not applied: ${err}` : null;
}
/** An Apply on a result: refused as text when the project changed since the run (the result is of the older state), else done. Null: applied. */
export function applyResult(stamp: RunStamp, label: string, ops: unknown[], after?: (d: Db) => void): string | null {
  return staleReason(stamp, stampNow()) ?? applyAndSchedule(label, ops, after);
}

/** What Crashing's Apply does after the edit operations and F9: the WHIQ fields (writeWhiqFields, as the tool's apply does). */
export const afterCrash = (res: { field_data?: FieldData }, stamp: RunStamp) => (d: Db): void => { writeWhiqFields(d, res.field_data!, { hoursPerDay: getUi().prefs.hoursPerDay, projIds: stamp.projects }); };
/** What Optimize's Apply does after the edit operations and F9: the WHIQ fields, then the leveling in the tool's whole placement order when
 *  activities are on limited resources (as the tool's apply: true does). */
export const afterOptimize = (res: { field_data?: FieldData; leveled_activities: number; priority: PriorityEntry[] }, stamp: RunStamp) => (d: Db): void => {
  writeWhiqFields(d, res.field_data!, { hoursPerDay: getUi().prefs.hoursPerDay, projIds: stamp.projects });
  if (res.leveled_activities > 0) levelInProposedOrder(d, stamp.projects, res.priority);
};
