// A schedule computed from a description, with no project kept (MCP compute_schedule): the project, calendars,
// activities (constraints, milestones, progress) and links are built with the same edit operations as `edit`,
// scheduled like F9 with the given options, and answered as the activity table (core/query/table.ts) plus loops.
import { rows, type Db } from '../db.ts';
import { formatP6Date } from '../dates.ts';
import { applyOps, type Op } from '../project/ops.ts';
import { scheduleProjects } from '../schedule/cpm.ts';
import { SCHEDULE_OPTIONS_GUIDE } from '../schedule/options.ts';
import { activityTable, TABLE_GUIDE, type ActivityTable } from './table.ts';

export const COMPUTE_GUIDE = `start (planned start, YYYY-MM-DD), [data_date] (default start), [must_finish_by], [hours_per_day] (default 8: days where a calendar has no day length), [calendar] (default calendar name), `
  + `[calendars [{name, work_week, holidays, work_exceptions}] as add_calendar], activities [{id, [name], [type], [duration_days] or [duration_hours], [calendar], [constraint {type, date}], [secondary_constraint], `
  + `[actual_start], [actual_finish], [remaining_days] or [remaining_hours], [percent_complete], [expected_finish], [predecessors [{id, [type], [lag_days] or [lag_hours]}]]}] (fields as add_activity / update_activity), `
  + `[relationships [{pred, succ, [type], [lag_days] or [lag_hours]}]], [options {${SCHEDULE_OPTIONS_GUIDE}}], [break_loops] (default true: links that close a loop are left out and returned in broken_links; false: a loop fails the call), `
  + `[offset], [limit], [names]. Answer: finish, data_date, loops [[activity IDs]], broken_links, warnings, and the rows: ${TABLE_GUIDE}`;

export type ComputeAnswer = ({ ok: true; finish: string | null; data_date: string | null; loops: string[][]; broken_links: { pred: string; succ: string; type: string }[]; warnings: string[] } & ActivityTable)
  | { ok: false; error: { code: string; message: string; where?: string; loops?: string[][] } };

export function computeSchedule(a: Record<string, any>): ComputeAnswer {
  const bad = (message: string, where?: string): ComputeAnswer => ({ ok: false, error: { code: 'bad_input', message, ...(where ? { where } : {}) } });
  if (typeof a.start !== 'string' || !a.start) return bad('Give "start", the planned start (YYYY-MM-DD).');
  if (!Array.isArray(a.activities) || !a.activities.length) return bad('Give "activities": [{id, duration_days, predecessors?...}].');
  const hpd = Number(a.hours_per_day) || 8;
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
  if (!r.ok) return bad(r.error!.message, where[r.error!.index]);
  const pid = rows(db, 'PROJECT')[0].proj_id;
  const s = scheduleProjects(db, [pid], { breakLoops: a.break_loops !== false });
  const loops = s.loops ?? [];
  if (!s.ok) return { ok: false, error: { code: 'schedule_failed', message: s.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' '), ...(loops.length ? { loops } : {}) } };
  const code = new Map(rows(db, 'TASK').map((t) => [t.task_id, t.task_code]));
  const table = activityTable(db, [pid], { offset: a.offset, limit: a.limit, names: a.names === true, hoursPerDay: hpd });
  const iso = (t: number | null) => (t == null ? null : formatP6Date(t));
  return {
    ok: true, finish: iso(s.stats.finish), data_date: iso(s.stats.dataDate), loops,
    broken_links: (s.broken ?? []).map((x) => ({ pred: code.get(x.pred_task_id) ?? x.pred_task_id, succ: code.get(x.task_id) ?? x.task_id, type: (x.pred_type || 'PR_FS').slice(3) })),
    warnings: [...(r.warnings ?? []), ...s.findings.filter((f) => f.severity === 'warning' || f.severity === 'error').map((f) => f.message)].slice(0, 50),
    ...table,
  };
}
