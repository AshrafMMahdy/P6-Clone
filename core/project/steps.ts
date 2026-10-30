// Activity steps (TASKPROC): weighted physical % complete, shared by the desktop app and the edit operations.
import { rows, rowsBy, type Db, type Row } from '../db.ts';

export const STEP_FIELDS = ['proc_id', 'task_id', 'proj_id', 'seq_num', 'proc_name', 'complete_flag', 'proc_wt', 'complete_pct', 'proc_descr'];

/** Weighted step % complete (each step's weight x its % complete, completed steps count 100%). */
export function stepsPercent(steps: Row[]): number | null {
  const w = steps.reduce((s, x) => s + (Number(x.proc_wt) || 0), 0);
  if (!steps.length || !w) return null;
  return steps.reduce((s, x) => s + (Number(x.proc_wt) || 0) * (x.complete_flag === 'Y' ? 100 : Number(x.complete_pct) || 0), 0) / w;
}
/** P6: with "Activity percent complete based on activity steps", a physical-% activity takes its % from its steps. */
export function syncFromSteps(d: Db, taskId: string): void {
  // by indexes kept for the edit: a scan of every activity and step per call made a select over every activity quadratic
  const t = rowsBy(rows(d, 'TASK'), 'task_id', (x) => x.task_id, taskId)[0];
  const p = t && rows(d, 'PROJECT').find((x) => x.proj_id === t.proj_id);
  if (!t || p?.step_complete_flag !== 'Y' || t.complete_pct_type !== 'CP_Phys') return;
  const pct = stepsPercent(rowsBy(rows(d, 'TASKPROC'), 'task', (s) => s.task_id, taskId));
  if (pct != null && (t.act_start_date || pct === 0)) t.phys_complete_pct = String(Math.round(pct * 100) / 100);
}
