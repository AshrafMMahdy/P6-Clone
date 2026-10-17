// Are the dates saved in a file the ones P6 would calculate from the file's own logic, durations and calendars?
// Reschedules as a dry run (nothing in the file changes) and compares. A difference means the file was edited after
// it was last scheduled, or it was written by a tool whose dates do not follow its own data: pressing F9 in P6 would
// move those dates.
import type { Db, Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { scheduleProjects } from './cpm.ts';

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
  // what the scheduler calculates, without writing it (no copy of the file, no undo record)
  const calc = new Map<Row, string[]>();
  const ok = scheduleProjects(db, (db.tables.PROJECT?.rows ?? []).map((p) => p.proj_id), {}, (row, v) => {
    let c = calc.get(row);
    if (!c) calc.set(row, (c = FIELDS.map(([f]) => row[f])));
    FIELDS.forEach(([f], k) => { if (f in v) c[k] = v[f]; });
  }).ok;
  if (!ok) return []; // the scheduler's own findings (loops etc.) are reported by Tools > Schedule
  const byId = new Map(open.map((t) => [t.task_id, t])); // a repeated task_id compares as its last row (P6 rejects such files)
  const out: Finding[] = [];
  let acts = 0, values = 0;
  for (const t0 of open) {
    const t = byId.get(t0.task_id)!, now = calc.get(t);
    if (!t.early_start_date) continue;
    let differs = false;
    FIELDS.forEach(([f, label], k) => {
      const old = t[f], a = now ? now[k] : old;
      const same = f.endsWith('_cnt') ? Math.abs(Number(old || 0) - Number(a || 0)) < 0.02 : (old ?? '') === (a ?? '');
      if (same) return;
      if (out.length < EXAMPLES && !differs) out.push({ severity: 'info', code: 'DATE_NOT_CURRENT', message: `${t0.task_code}: ${label} saved as ${old || '(blank)'}, P6 would calculate ${a || '(blank)'}`, p6: 'Pressing F9 in P6 changes this value.', table: 'TASK', key: t0.task_code, field: f });
      differs = true; values++;
    });
    if (differs) acts++;
  }
  if (!acts) return [];
  return [{
    severity: 'warning', code: 'DATES_NOT_CURRENT',
    message: `${acts} of ${open.length} open activities (${values} values) have saved dates or floats that differ from what P6 calculates from this file's own logic, durations and calendars. The file was edited after it was last scheduled, or the tool that wrote it did not calculate its dates the way P6 does.`,
    p6: 'P6 imports the file with these dates as they are; the first time you schedule (F9) they change.', table: 'TASK',
  }, ...out];
}
