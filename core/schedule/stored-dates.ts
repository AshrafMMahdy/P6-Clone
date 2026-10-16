// Are the dates saved in a file the ones P6 would calculate from the file's own logic, durations and calendars?
// Reschedules a copy (nothing in the file changes) and compares. A difference means the file was edited after it
// was last scheduled, or it was written by a tool whose dates do not follow its own data: pressing F9 in P6 would
// move those dates.
import type { Db } from '../db.ts';
import type { Finding } from '../findings.ts';
import { scheduleProjects } from './cpm.ts';
import { record, rollback } from '../journal.ts';

const FIELDS: [string, string][] = [
  ['early_start_date', 'early start'], ['early_end_date', 'early finish'], ['late_start_date', 'late start'],
  ['late_end_date', 'late finish'], ['total_float_hr_cnt', 'total float (h)'], ['free_float_hr_cnt', 'free float (h)'],
];
const EXAMPLES = 10; // one example per activity

export function checkStoredDates(db: Db): Finding[] {
  const tasks = db.tables.TASK?.rows ?? [];
  const open = tasks.filter((t) => t.status_code !== 'TK_Complete' && !t.act_end_date);
  if (!open.length) return [];
  if (!open.some((t) => t.early_start_date)) return [{ severity: 'info', code: 'DATES_NOT_STORED', message: 'The file has no early dates for its open activities; P6 calculates them when you schedule (F9).', p6: 'P6 imports the file and shows blank or planned dates until it is scheduled.', table: 'TASK' }];
  // schedule in place while recording, keep what it calculated, then put the file's own values back
  const before = new Map(open.map((t) => [t.task_id, Object.fromEntries(FIELDS.map(([f]) => [f, t[f]]))]));
  let ok = false;
  const j = record(db, (d) => { ok = scheduleProjects(d, (d.tables.PROJECT?.rows ?? []).map((p) => p.proj_id)).ok; });
  const after = new Map(open.map((t) => [t.task_id, Object.fromEntries(FIELDS.map(([f]) => [f, t[f]]))]));
  rollback(j);
  if (!ok) return []; // the scheduler's own findings (loops etc.) are reported by Tools > Schedule
  const out: Finding[] = [];
  let acts = 0, values = 0;
  for (const t0 of open) {
    const t = { ...t0, ...before.get(t0.task_id) }, a = after.get(t0.task_id);
    if (!a || !t.early_start_date) continue;
    let differs = false;
    for (const [f, label] of FIELDS) {
      const same = f.endsWith('_cnt') ? Math.abs(Number(t[f] || 0) - Number(a[f] || 0)) < 0.02 : (t[f] ?? '') === (a[f] ?? '');
      if (same) continue;
      const differsBefore = differs;
      differs = true; values++;
      if (out.length < EXAMPLES && !differsBefore) out.push({ severity: 'info', code: 'DATE_NOT_CURRENT', message: `${t.task_code}: ${label} saved as ${t[f] || '(blank)'}, P6 would calculate ${a[f] || '(blank)'}`, p6: 'Pressing F9 in P6 changes this value.', table: 'TASK', key: t.task_code, field: f });
    }
    if (differs) acts++;
  }
  if (!acts) return [];
  return [{
    severity: 'warning', code: 'DATES_NOT_CURRENT',
    message: `${acts} of ${open.length} open activities (${values} values) have saved dates or floats that differ from what P6 calculates from this file's own logic, durations and calendars. The file was edited after it was last scheduled, or the tool that wrote it did not calculate its dates the way P6 does.`,
    p6: 'P6 imports the file with these dates as they are; the first time you schedule (F9) they change.', table: 'TASK',
  }, ...out];
}
