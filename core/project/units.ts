// Days <-> hours. With calendarDays (MCP server and CLI) on the activity's own calendar (its hours per day, P6's
// "use assigned calendar to specify the number of work hours for each time period"), a lag on the relationship-lag
// calendar of the successor's project (P6's default: the predecessor's calendar), and the caller's hours per day
// (MCP hours_per_day, CLI --hours-per-day) only where a calendar has no day length. Without it (the desktop app, P6's
// default with that setting off) every day is the fixed hours per day of the preference, for edits and lookups alike.
import { realOf } from '../journal.ts';
import type { Db, Row } from '../db.ts';

export interface DayHours {
  /** hours in a day of this calendar */
  cal: (clndrId: string | undefined) => number;
  /** hours in a day of this activity (its calendar) */
  task: (t: Row | undefined) => number;
  /** hours in a day of a lag between these activities */
  lag: (pred: Row | undefined, succ: Row | undefined) => number;
  /** hours in a day of a relationship row's lag */
  rel: (r: Row) => number;
}

export function dayHours(db: Db, fallback: number, calendarDays: boolean): DayHours {
  if (!calendarDays) { const k = () => fallback; return { cal: k, task: k, lag: k, rel: k }; }
  const rows = (n: string) => realOf(db.tables[n]?.rows ?? []); // read only
  const len = new Map(rows('CALENDAR').map((c) => [c.clndr_id, Number(c.day_hr_cnt)]));
  const lagCal = new Map(rows('SCHEDOPTIONS').map((s) => [s.proj_id, s.sched_calendar_on_relationship_lag]));
  const projCal = new Map(rows('PROJECT').map((p) => [p.proj_id, p.clndr_id]));
  let tasks: Map<string, Row> | null = null;
  const cal = (id: string | undefined) => { const h = len.get(id ?? ''); return h && h > 0 ? h : fallback; };
  const task = (t: Row | undefined) => (t ? cal(t.clndr_id) : fallback);
  const lag = (pred: Row | undefined, succ: Row | undefined) => {
    const k = lagCal.get(succ?.proj_id ?? pred?.proj_id ?? '');
    return k === 'rcal_24Hour' ? 24 : k === 'rcal_Successor' ? task(succ) : k === 'rcal_ProjDefault' ? cal(projCal.get(succ?.proj_id ?? '')) : task(pred ?? succ);
  };
  const rel = (r: Row) => { tasks ??= new Map(rows('TASK').map((t) => [t.task_id, t])); return lag(tasks.get(r.pred_task_id), tasks.get(r.task_id)); };
  return { cal, task, lag, rel };
}
