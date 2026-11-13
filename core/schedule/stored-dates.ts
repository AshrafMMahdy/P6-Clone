// Are the dates saved in a file the ones P6 would calculate from the file's own logic, durations and calendars?
// Reschedules as a dry run (nothing in the file changes) and compares. A difference means the file was edited after
// it was last scheduled, or it was written by a tool whose dates do not follow its own data: pressing F9 in P6 would
// move those dates.
import type { Db, Row } from '../db.ts';
import type { Finding } from '../findings.ts';
import { datesNotCurrent, datesNotStored } from '../notes.ts';
import { scheduleProjects } from './cpm.ts';
import { loopGroups, projectLoops, type LoopGroup } from '../xer/validate.ts';

const FIELDS: [string, string][] = [
  ['early_start_date', 'early start'], ['early_end_date', 'early finish'], ['late_start_date', 'late start'],
  ['late_end_date', 'late finish'], ['total_float_hr_cnt', 'total float (h)'], ['free_float_hr_cnt', 'free float (h)'],
];

/** One project whose saved dates differ from what F9 gives: how many of its open activities differ, out of how many are open. */
export interface StoredDatesState { proj: string; differ: number; open: number; values: number; examples: Finding[] }

/** Per project: are the saved dates of the open activities the ones F9 would calculate? `notStored`: the Project IDs that have open activities but no saved early dates at all.
 *  `loops`: the loops in the logic, grouped by the projects they run through (F9 stops on a file with one: owner 2026-11-13, said by every analysis that reads saved dates).
 *  The projects no loop runs through are still judged, by a calculation of them alone. `judged`: the open activities of the projects that were compared.
 *  Reschedules as a dry run; the file does not change. Projects that are current are not listed. */
export function storedDatesState(db: Db, only?: string[]): { stale: StoredDatesState[]; notStored: string[]; calculable: boolean; loops: LoopGroup[]; judged: number } {
  // a baseline stored in the file as a project of its own (_baseline_of) is a snapshot: its dates are never "current", and F9 cannot change them, so it is never reported
  const baselines = new Set((db.tables.PROJECT?.rows ?? []).filter((p) => p._baseline_of).map((p) => p.proj_id));
  const tasks = (db.tables.TASK?.rows ?? []).filter((t) => !baselines.has(t.proj_id) && (!only || only.includes(t.proj_id)));
  const open = tasks.filter((t) => t.status_code !== 'TK_Complete' && !t.act_end_date);
  const projName = new Map((db.tables.PROJECT?.rows ?? []).map((p) => [p.proj_id, p.proj_short_name || p.proj_id]));
  // the loops first: they are a fact of the logic, whatever dates the file holds
  const found = projectLoops(db), inLoop = new Set(found.flatMap((l) => l.projIds)), loops = loopGroups(db, only, found);
  if (!open.length) return { stale: [], notStored: [], calculable: !loops.length, loops, judged: 0 };
  const ids = [...new Set(open.map((t) => t.proj_id))];
  const notStored = ids.filter((id) => !open.some((t) => t.proj_id === id && t.early_start_date)).map((id) => projName.get(id) ?? id);
  if (notStored.length === ids.length) return { stale: [], notStored, calculable: !loops.length, loops, judged: 0 };
  // what the scheduler calculates, without writing it (no copy of the file, no undo record): the projects no loop runs through
  // (another reason F9 stops, no data date and no planned start, is reported by schedule itself)
  const rest = (db.tables.PROJECT?.rows ?? []).filter((p) => !baselines.has(p.proj_id) && !inLoop.has(p.proj_id)).map((p) => p.proj_id);
  const calc = new Map<Row, string[]>();
  const ok = rest.length > 0 && scheduleProjects(db, rest, {}, (row, v) => {
    let c = calc.get(row);
    if (!c) calc.set(row, (c = FIELDS.map(([f]) => row[f])));
    FIELDS.forEach(([f], k) => { if (f in v) c[k] = v[f]; });
  }).ok;
  if (!ok) return { stale: [], notStored, calculable: false, loops, judged: 0 };
  const judged = new Set(rest);
  const byId = new Map(open.map((t) => [t.task_id, t])); // a repeated task_id compares as its last row (P6 rejects such files)
  const per = new Map<string, StoredDatesState>();
  for (const t0 of open) {
    if (!judged.has(t0.proj_id)) continue;
    const t = byId.get(t0.task_id)!, now = calc.get(t);
    if (!t.early_start_date) continue;
    const st = per.get(t0.proj_id) ?? { proj: projName.get(t0.proj_id) ?? t0.proj_id, differ: 0, open: open.filter((x) => x.proj_id === t0.proj_id).length, values: 0, examples: [] };
    per.set(t0.proj_id, st);
    let differs = false;
    FIELDS.forEach(([f, label], k) => {
      const old = t[f], a = now ? now[k] : old;
      const same = f.endsWith('_cnt') ? Math.abs(Number(old || 0) - Number(a || 0)) < 0.02 : (old ?? '') === (a ?? '');
      if (same) return;
      if (!differs) st.examples.push({ severity: 'info', code: 'DATE_NOT_CURRENT', message: `${t0.task_code}: ${label} saved as ${old || '(blank)'}, F9 gives ${a || '(blank)'}.`, p6: '', table: 'TASK', key: t0.task_code, field: f });
      differs = true; st.values++;
    });
    if (differs) st.differ++;
  }
  return { stale: [...per.values()].filter((x) => x.differ > 0), notStored, calculable: loops.length === 0, loops, judged: open.filter((t) => judged.has(t.proj_id) && t.early_start_date).length };
}

/** The same as findings (validate, open_file): one warning per project whose saved dates are not current, with the first examples as data rows. */
export function checkStoredDates(db: Db): Finding[] {
  const { stale, notStored } = storedDatesState(db);
  const out: Finding[] = [];
  for (const id of notStored) out.push({ severity: 'info', code: 'DATES_NOT_STORED', message: datesNotStored(id), p6: '', table: 'TASK' });
  for (const st of stale) out.push({ severity: 'warning', code: 'DATES_NOT_CURRENT', message: datesNotCurrent(st.proj, st.differ, st.open), p6: '', table: 'TASK' }, ...st.examples);
  return out;
}
