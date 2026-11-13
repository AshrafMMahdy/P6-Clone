// Are the dates saved in a file the ones P6 would calculate from the file's own logic, durations and calendars?
// Reschedules as a dry run (nothing in the file changes) and compares. A difference means the file was edited after
// it was last scheduled, or it was written by a tool whose dates do not follow its own data: pressing F9 in P6 would
// move those dates.
import type { Db, Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { datesNotCurrent } from '../notes.ts';
import { scheduleProjects } from './cpm.ts';

const FIELDS: [string, string][] = [
  ['early_start_date', 'early start'], ['early_end_date', 'early finish'], ['late_start_date', 'late start'],
  ['late_end_date', 'late finish'], ['total_float_hr_cnt', 'total float (h)'], ['free_float_hr_cnt', 'free float (h)'],
];
const EXAMPLES = 10; // one example per activity

/** One project whose saved dates differ from what F9 gives: how many of its open activities differ, out of how many are open. */
export interface StoredDatesState { proj: string; differ: number; open: number; values: number; examples: Finding[] }

/** Per project: are the saved dates of the open activities the ones F9 would calculate? `none`: the Project IDs that have open activities but no saved early dates at all.
 *  Reschedules as a dry run; the file does not change. Projects that are current are not listed. */
export function storedDatesState(db: Db, only?: string[]): { stale: StoredDatesState[]; notStored: string[]; calculable: boolean } {
  // a baseline stored in the file as a project of its own (_baseline_of) is a snapshot: its dates are never "current", and F9 cannot change them, so it is never reported
  const baselines = new Set((db.tables.PROJECT?.rows ?? []).filter((p) => p._baseline_of).map((p) => p.proj_id));
  const tasks = (db.tables.TASK?.rows ?? []).filter((t) => !baselines.has(t.proj_id) && (!only || only.includes(t.proj_id)));
  const open = tasks.filter((t) => t.status_code !== 'TK_Complete' && !t.act_end_date);
  const projName = new Map((db.tables.PROJECT?.rows ?? []).map((p) => [p.proj_id, p.proj_short_name || p.proj_id]));
  if (!open.length) return { stale: [], notStored: [], calculable: true };
  const ids = [...new Set(open.map((t) => t.proj_id))];
  const notStored = ids.filter((id) => !open.some((t) => t.proj_id === id && t.early_start_date)).map((id) => projName.get(id) ?? id);
  if (notStored.length === ids.length) return { stale: [], notStored, calculable: true };
  // what the scheduler calculates, without writing it (no copy of the file, no undo record)
  const calc = new Map<Row, string[]>();
  const ok = scheduleProjects(db, (db.tables.PROJECT?.rows ?? []).filter((p) => !baselines.has(p.proj_id)).map((p) => p.proj_id), {}, (row, v) => {
    let c = calc.get(row);
    if (!c) calc.set(row, (c = FIELDS.map(([f]) => row[f])));
    FIELDS.forEach(([f], k) => { if (f in v) c[k] = v[f]; });
  }).ok;
  if (!ok) return { stale: [], notStored, calculable: false }; // the scheduler's own findings (loops etc.) are reported by schedule
  const byId = new Map(open.map((t) => [t.task_id, t])); // a repeated task_id compares as its last row (P6 rejects such files)
  const per = new Map<string, StoredDatesState>();
  for (const t0 of open) {
    const t = byId.get(t0.task_id)!, now = calc.get(t);
    if (!t.early_start_date) continue;
    const st = per.get(t0.proj_id) ?? { proj: projName.get(t0.proj_id) ?? t0.proj_id, differ: 0, open: open.filter((x) => x.proj_id === t0.proj_id).length, values: 0, examples: [] };
    per.set(t0.proj_id, st);
    let differs = false;
    FIELDS.forEach(([f, label], k) => {
      const old = t[f], a = now ? now[k] : old;
      const same = f.endsWith('_cnt') ? Math.abs(Number(old || 0) - Number(a || 0)) < 0.02 : (old ?? '') === (a ?? '');
      if (same) return;
      if (st.examples.length < EXAMPLES && !differs) st.examples.push({ severity: 'info', code: 'DATE_NOT_CURRENT', message: `${t0.task_code}: ${label} saved as ${old || '(blank)'}, F9 gives ${a || '(blank)'}.`, p6: '', table: 'TASK', key: t0.task_code, field: f });
      differs = true; st.values++;
    });
    if (differs) st.differ++;
  }
  return { stale: [...per.values()].filter((x) => x.differ > 0), notStored, calculable: true };
}

/** The same as findings (validate, open_file): one warning per project whose saved dates are not current, with the first examples as data rows. */
export function checkStoredDates(db: Db): Finding[] {
  const { stale, notStored } = storedDatesState(db);
  const out: Finding[] = [];
  for (const id of notStored) out.push({ severity: 'info', code: 'DATES_NOT_STORED', message: `${id} has no calculated dates for its open activities; run schedule first.`, p6: '', table: 'TASK' });
  for (const st of stale) out.push({ severity: 'warning', code: 'DATES_NOT_CURRENT', message: datesNotCurrent(st.proj, st.differ, st.open), p6: '', table: 'TASK' }, ...st.examples);
  return out;
}
