// A schedule computed from a description, with no project kept (MCP compute_schedule): the project, calendars,
// activities (constraints, milestones, progress) and links are built with the same edit operations as `edit`,
// scheduled like F9 with the given options, and answered as the activity table (core/query/table.ts) plus loops.
import { calendarDefOfRow } from '../calendar/clndr-data.ts';
import { rows, type Db } from '../db.ts';
import { formatP6Date } from '../dates.ts';
import { applyOps, type Op } from '../project/ops.ts';
import { scheduleProjects } from '../schedule/cpm.ts';
import { SCHEDULE_OPTIONS_GUIDE } from '../schedule/options.ts';
import { activityTable, TABLE_GUIDE, type ActivityTable } from './table.ts';
import { computeNotes } from '../analysis/scheduleLog.ts';
import { parseP6Date } from '../dates.ts';

export const COMPUTE_GUIDE = `start (planned start, YYYY-MM-DD), [data_date] (default start), [must_finish_by], [hours_per_day] (default 8: days where a calendar has no day length), [calendar] (default calendar name), `
  + `[calendars [{name, work_week or copy_from, holidays, work_exceptions}] as add_calendar: each has a week of its own or copies one], activities [{id, [name], [type], [duration_days] or [duration_hours], [calendar], [constraint {type, date}], [secondary_constraint], `
  + `[actual_start], [actual_finish], [remaining_days] or [remaining_hours], [percent_complete], [expected_finish], [predecessors [{id, [type], [lag_days] or [lag_hours]}]]}] (fields as add_activity / update_activity), `
  + `[relationships [{pred, succ, [type], [lag_days] or [lag_hours]}]], [options {${SCHEDULE_OPTIONS_GUIDE}}], [break_loops] (default false: a loop fails the call and is named, as P6 refuses one; true: links that close a loop are left out and returned in broken_links), `
  + `[offset], [limit], [names]. Answer: finish, data_date, loops [[activity IDs]], broken_links, notes, and the rows: ${TABLE_GUIDE}`;

export type ComputeAnswer = ({ ok: true; finish: string | null; data_date: string | null; loops: string[][]; broken_links: { pred: string; succ: string; type: string }[]; notes: string[] } & ActivityTable)
  | { ok: false; error: { code: string; message: string; where?: string; loops?: string[][] } };

/** The calendar a computation with no `calendar` ran on: its name and week, and how to give another. */
function defaultCalendarNote(db: Db, pid: string): string {
  const id = rows(db, 'PROJECT').find((p) => p.proj_id === pid)?.clndr_id;
  const c = rows(db, 'CALENDAR').find((x) => x.clndr_id === id);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let week = '';
  try { const d = calendarDefOfRow(c ?? {}); week = d.week.map((sh, i) => (sh.length ? `${days[i]} ${sh.reduce((h, x) => h + x.end - x.start, 0) / 60} h` : '')).filter(Boolean).join(', '); } catch { week = ''; }
  return `No calendar was named: computed on the default calendar "${c?.clndr_name ?? '?'}"${week ? ` (${week})` : ''}, as P6 gives a new project its default calendar. Give calendar (and calendars) for the project's own week.`;
}

export function computeSchedule(a: Record<string, any>): ComputeAnswer {
  const bad = (message: string, where?: string): ComputeAnswer => ({ ok: false, error: { code: 'bad_input', message, ...(where ? { where } : {}) } });
  if (typeof a.start !== 'string' || !a.start) return bad('Give "start", the planned start (YYYY-MM-DD).');
  if (!Array.isArray(a.activities) || !a.activities.length) return bad('Give "activities": [{id, duration_days, predecessors?...}].');
  // 8 hours a day when none is given: P6's own default Hours per Day (item 26, rule 6); anything that is not a number above 0 and at most 24 is refused
  if (a.hours_per_day != null && !(typeof a.hours_per_day === 'number' && a.hours_per_day > 0 && a.hours_per_day <= 24)) return bad(`hours_per_day must be a number above 0 and at most 24 (got ${JSON.stringify(a.hours_per_day)}).`, 'hours_per_day');
  for (const [k, least] of [['offset', 0], ['limit', 1]] as const) if (a[k] != null && !(typeof a[k] === 'number' && Number.isSafeInteger(a[k]) && a[k] >= least)) return bad(`${k} must be a whole number of ${least} or more (got ${JSON.stringify(a[k])}).`, k);
  const hpd: number = a.hours_per_day ?? 8;
  const ops: Op[] = [], where: string[] = [];
  const put = (op: Op, w: string) => { ops.push(op); where.push(w); };
  put({ op: 'add_project', id: 'COMPUTE', start: a.start, ...(a.must_finish_by ? { must_finish_by: a.must_finish_by } : {}) }, 'start / must_finish_by');
  (Array.isArray(a.calendars) ? a.calendars : []).forEach((c: any, i: number) => put({ ...c, op: 'add_calendar' }, `calendars[${i}]`));
  if (a.calendar || a.data_date) put({ op: 'set_project', ...(a.calendar ? { calendar: a.calendar } : {}), ...(a.data_date ? { data_date: a.data_date } : {}) }, 'calendar / data_date');
  a.activities.forEach((x: any, i: number) => {
    if (!x || typeof x !== 'object') { put({ op: 'add_activity' }, `activities[${i}]`); return; }
    const { predecessors: _p, ...rest } = x;
    put({ ...rest, op: 'add_activity', id: x.id, name: x.name ?? x.id }, `activities[${i}] (${x.id})`);
  });
  a.activities.forEach((x: any, i: number) => (Array.isArray(x?.predecessors) ? x.predecessors : []).forEach((p: any, j: number) => put({ op: 'add_relationship', pred: p?.id, succ: x.id, type: p?.type, lag_days: p?.lag_days, lag_hours: p?.lag_hours }, `activities[${i}].predecessors[${j}]`)));
  (Array.isArray(a.relationships) ? a.relationships : []).forEach((r: any, i: number) => put({ ...r, op: 'add_relationship' }, `relationships[${i}]`));
  if (a.options && typeof a.options === 'object' && Object.keys(a.options).length) put({ ...a.options, op: 'set_schedule_options' }, 'options');
  for (const op of ops) for (const k of Object.keys(op)) if (op[k] === undefined) delete op[k];
  const db: Db = { tables: {} };
  const r = applyOps(db, ops, { hoursPerDay: hpd, calendarDays: true, allowLoops: true });
  // (compute_schedule has no project to edit: the calendar and the activity's calendar are the inputs it names)
  if (!r.ok) return bad(r.error!.message.replace(/^add_calendar needs/, 'A calendar of calendars[] needs').replace('edit update_activity calendar', 'activities[].calendar'), where[r.error!.index]);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  // a loop fails the call, as P6 refuses one, unless break_loops: true asks for the closing links to be left out (item 26, rule 4: P6's own default)
  const s = scheduleProjects(db, [pid], { breakLoops: a.break_loops === true });
  const loops = s.loops ?? [];
  if (!s.ok) return { ok: false, error: { code: 'schedule_failed', message: s.findings.filter((f) => f.severity === 'error').map((f) => f.message.replace('(edit delete_relationship)', '(in predecessors or relationships)').replace('schedule with break_loops: true', 'pass break_loops: true')).join(' '), ...(loops.length ? { loops } : {}) } };
  const code = new Map(rows(db, 'TASK').map((t) => [t.task_id, t.task_code]));
  const table = activityTable(db, [pid], { offset: a.offset, limit: a.limit, names: a.names === true, hoursPerDay: hpd });
  const iso = (t: number | null) => (t == null ? null : formatP6Date(t));
  return {
    ok: true, finish: iso(s.stats.finish), data_date: iso(s.stats.dataDate), loops,
    broken_links: (s.broken ?? []).map((x) => ({ pred: code.get(x.pred_task_id) ?? x.pred_task_id, succ: code.get(x.task_id) ?? x.task_id, type: (x.pred_type || 'PR_FS').slice(3) })),
    // every note, whole (the MCP answer lists the first 25 by the list rule and keeps the whole list in a file)
    // (no calendar named: the default one P6 gives a new project, said — never a week assumed in silence)
    notes: [...(r.warnings ?? []), ...computeNotes(db, pid, s), ...(a.calendar ? [] : [defaultCalendarNote(db, pid)])],   // (what is wrong first; the calendar it ran on last)
    ...table,
  };
}
