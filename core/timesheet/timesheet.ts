// Timesheets the way P6 (with Progress Reporter / timesheet approval) stores them:
//   TSDATES  timesheet periods (ts_id, start_date, end_date = last day of the period)
//   TIMESHT  one header per resource and period (ts_id + rsrc_id), with the approval status
//   RSRCHOUR hours per assignment and day (regular hr_cnt + overtime ot_hr_cnt)
//   _TSLINE  (clone-internal, not exported) which assignments are on a timesheet + the "complete" flag
// Apply Actuals moves approved, not yet applied hours into the assignments and activities.
import { addField, rows, table, type Db, type Row, type Table } from '../db.ts';
import { dayStart, formatP6Date, MIN_PER_DAY, parseP6Date } from '../dates.ts';
import { calendarResolver, p6num } from '../schedule/cpm.ts';
import { recalcAssignment } from '../resource/assign.ts';

export type TsStatus = 'TS_Active' | 'TS_Submit' | 'TS_Approve' | 'TS_Reject';
export const TS_STATUS: Record<TsStatus, string> = { TS_Active: 'Active', TS_Submit: 'Submitted', TS_Approve: 'Approved', TS_Reject: 'Rejected' };

export const TSDATES_FIELDS = ['ts_id', 'start_date', 'end_date'];
export const TIMESHT_FIELDS = ['ts_id', 'rsrc_id', 'status_code', 'status_date', 'ts_notes'];
export const RSRCHOUR_FIELDS = ['rsrc_hr_id', 'rsrc_id', 'ts_id', 'taskrsrc_id', 'task_id', 'proj_id', 'workdate', 'hr_cnt', 'ot_hr_cnt', 'status'];
export const TSLINE_FIELDS = ['ts_id', 'rsrc_id', 'taskrsrc_id', 'task_id', 'proj_id', 'complete_flag'];

/** Most hours (regular + overtime) one resource can report on one day. */
export const MAX_HOURS_PER_DAY = 24;

const num = (s: string | undefined) => Number(s || 0) || 0;

function tbl(db: Db, name: string, fields: string[]): Table {
  const T = table(db, name);
  for (const f of fields) addField(T, f);
  return T;
}

function newId(db: Db, name: string, key: string): string {
  let max = 0;
  for (const r of rows(db, name)) { const n = Number(r[key]); if (n > max) max = n; }
  return String(max + 1);
}

// ---------------------------------------------------------------- periods

export interface PeriodRange { tsId: string; start: number; /** exclusive */ end: number; days: number }

export function periodRange(p: Row): PeriodRange {
  const start = dayStart(parseP6Date(p.start_date) ?? 0);
  const last = dayStart(parseP6Date(p.end_date) ?? start);
  const end = Math.max(start, last) + MIN_PER_DAY;
  return { tsId: p.ts_id, start, end, days: Math.round((end - start) / MIN_PER_DAY) };
}

/** Timesheet periods, earliest first. */
export function listPeriods(db: Db): Row[] {
  return [...rows(db, 'TSDATES')].sort((a, b) => (parseP6Date(a.start_date) ?? 0) - (parseP6Date(b.start_date) ?? 0));
}

export function getPeriod(db: Db, tsId: string): Row | undefined {
  return rows(db, 'TSDATES').find((p) => p.ts_id === tsId);
}

/** Start of each day of a period (minutes). */
export function periodDays(p: Row): number[] {
  const r = periodRange(p);
  return Array.from({ length: r.days }, (_, i) => r.start + i * MIN_PER_DAY);
}

/**
 * Admin > Timesheet Dates > Batch Create: `count` consecutive periods of `lengthDays` days from `start`.
 * Periods overlapping an existing period are skipped (P6 does not allow overlapping periods). Returns the new rows.
 */
export function createPeriods(db: Db, start: number, count: number, lengthDays = 7): Row[] {
  if (!(count >= 1) || !Number.isInteger(count)) throw new Error('Number of periods must be a whole number of 1 or more.');
  if (!(lengthDays >= 1) || !Number.isInteger(lengthDays)) throw new Error('Period length must be a whole number of days.');
  const T = tbl(db, 'TSDATES', TSDATES_FIELDS);
  const existing = T.rows.map(periodRange);
  const out: Row[] = [];
  const s0 = dayStart(start);
  for (let i = 0; i < count; i++) {
    const s = s0 + i * lengthDays * MIN_PER_DAY, e = s + lengthDays * MIN_PER_DAY;
    if (existing.some((x) => s < x.end && e > x.start)) continue;
    const r: Row = { ts_id: newId(db, 'TSDATES', 'ts_id'), start_date: formatP6Date(s), end_date: formatP6Date(e - MIN_PER_DAY) };
    T.rows.push(r);
    existing.push(periodRange(r));
    out.push(r);
  }
  return out;
}

/** Why a period cannot be deleted, or null. */
export function deletePeriodError(db: Db, tsId: string): string | null {
  if (!getPeriod(db, tsId)) return 'Timesheet period not found.';
  const n = rows(db, 'TIMESHT').filter((h) => h.ts_id === tsId).length;
  return n ? `The period has ${n} timesheet${n === 1 ? '' : 's'} and cannot be deleted.` : null;
}

export function deletePeriod(db: Db, tsId: string): void {
  const err = deletePeriodError(db, tsId);
  if (err) throw new Error(err);
  db.tables.TSDATES.rows = db.tables.TSDATES.rows.filter((p) => p.ts_id !== tsId);
}

// ---------------------------------------------------------------- timesheets

export function getTimesheet(db: Db, rsrcId: string, tsId: string): Row | undefined {
  return rows(db, 'TIMESHT').find((h) => h.ts_id === tsId && h.rsrc_id === rsrcId);
}

/** Submitted and approved timesheets cannot be edited. */
export function isEditable(h: Row | undefined): boolean {
  return !h || h.status_code === 'TS_Active' || h.status_code === 'TS_Reject' || !h.status_code;
}

/** Activity span for timesheets: actual start (else remaining/planned start) to actual finish (else remaining/planned finish). */
function taskSpan(t: Row): { s: number | null; f: number | null } {
  const s = parseP6Date(t.act_start_date || t.restart_date || t.early_start_date || t.target_start_date);
  const f = parseP6Date(t.act_end_date || t.reend_date || t.early_end_date || t.target_end_date);
  return { s, f: f ?? s };
}

/** Assignments of a resource whose activity is active in the period (labor/nonlabor, not baselines, not WBS summaries). */
export function activeAssignments(db: Db, rsrcId: string, tsId: string): Row[] {
  const p = getPeriod(db, tsId);
  if (!p) return [];
  const r = periodRange(p);
  const tasks = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const baseline = new Set(rows(db, 'PROJECT').filter((x) => x._baseline_of).map((x) => x.proj_id));
  return rows(db, 'TASKRSRC').filter((a) => {
    if (a.rsrc_id !== rsrcId || a.rsrc_type === 'RT_Mat') return false;
    const t = tasks.get(a.task_id);
    if (!t || t.task_type === 'TT_WBS' || baseline.has(t.proj_id)) return false;
    const { s, f } = taskSpan(t);
    return s != null && s < r.end && (f ?? s) >= r.start;
  });
}

function addLine(db: Db, h: Row, a: Row): Row {
  const L = tbl(db, '_TSLINE', TSLINE_FIELDS);
  let l = L.rows.find((x) => x.ts_id === h.ts_id && x.rsrc_id === h.rsrc_id && x.taskrsrc_id === a.taskrsrc_id);
  if (!l) {
    l = { ts_id: h.ts_id, rsrc_id: h.rsrc_id, taskrsrc_id: a.taskrsrc_id, task_id: a.task_id, proj_id: a.proj_id || '', complete_flag: 'N' };
    L.rows.push(l);
  }
  return l;
}

/**
 * The resource's timesheet for a period, created when missing (status Active) with one line per assignment
 * active in the period. Editable timesheets also pick up assignments added since.
 */
export function timesheetFor(db: Db, rsrcId: string, tsId: string): Row {
  if (!getPeriod(db, tsId)) throw new Error(`Timesheet period ${tsId} not found.`);
  if (!rows(db, 'RSRC').some((r) => r.rsrc_id === rsrcId)) throw new Error(`Resource ${rsrcId} not found.`);
  const H = tbl(db, 'TIMESHT', TIMESHT_FIELDS);
  let h = getTimesheet(db, rsrcId, tsId);
  if (!h) {
    h = { ts_id: tsId, rsrc_id: rsrcId, status_code: 'TS_Active', status_date: '', ts_notes: '' };
    H.rows.push(h);
  }
  if (isEditable(h)) for (const a of activeAssignments(db, rsrcId, tsId)) addLine(db, h, a);
  return h;
}

export interface TsLine {
  taskrsrcId: string; taskId: string; projId: string;
  assignment?: Row; task?: Row;
  complete: boolean;
  /** regular / overtime hours per day of the period */
  hours: number[]; ot: number[];
  total: number; otTotal: number;
}

/**
 * Lines of a timesheet without changing the database: the stored lines, plus (while the timesheet is
 * missing or editable) the assignments timesheetFor would add.
 */
export function timesheetLines(db: Db, rsrcId: string, tsId: string): TsLine[] {
  const p = getPeriod(db, tsId);
  if (!p) return [];
  const r = periodRange(p);
  const h = getTimesheet(db, rsrcId, tsId);
  const asg = new Map(rows(db, 'TASKRSRC').map((a) => [a.taskrsrc_id, a]));
  const tasks = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const projects = new Map(rows(db, 'PROJECT').map((x) => [x.proj_id, x]));
  const out = new Map<string, TsLine>();
  const add = (taskrsrcId: string, taskId: string, projId: string, complete: boolean) => {
    if (out.has(taskrsrcId)) return out.get(taskrsrcId)!;
    const a = asg.get(taskrsrcId);
    const t = tasks.get(a?.task_id ?? taskId);
    const line: TsLine = { taskrsrcId, taskId: t?.task_id ?? taskId, projId: t?.proj_id ?? projId, assignment: a, task: t, complete, hours: Array(r.days).fill(0), ot: Array(r.days).fill(0), total: 0, otTotal: 0 };
    out.set(taskrsrcId, line);
    return line;
  };
  if (h) for (const l of rows(db, '_TSLINE')) if (l.ts_id === tsId && l.rsrc_id === rsrcId) add(l.taskrsrc_id, l.task_id, l.proj_id, l.complete_flag === 'Y');
  if (isEditable(h)) for (const a of activeAssignments(db, rsrcId, tsId)) add(a.taskrsrc_id, a.task_id, a.proj_id, false);
  for (const e of rows(db, 'RSRCHOUR')) {
    if (e.ts_id !== tsId || e.rsrc_id !== rsrcId) continue;
    const line = add(e.taskrsrc_id, e.task_id, e.proj_id, false);
    const i = Math.round((dayStart(parseP6Date(e.workdate) ?? 0) - r.start) / MIN_PER_DAY);
    if (i < 0 || i >= r.days) continue;
    line.hours[i] += num(e.hr_cnt);
    line.ot[i] += num(e.ot_hr_cnt);
  }
  for (const l of out.values()) { l.total = l.hours.reduce((s, x) => s + x, 0); l.otTotal = l.ot.reduce((s, x) => s + x, 0); }
  const key = (l: TsLine) => `${projects.get(l.projId)?.proj_short_name ?? ''}\u0000${l.task?.task_code ?? ''}`;
  return [...out.values()].sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }));
}

/** Day of the period: a 0-based index, or a time (minutes) inside the period. Returns the day start or null. */
function resolveDay(r: PeriodRange, day: number): number | null {
  if (Number.isInteger(day) && day >= 0 && day < r.days) return r.start + day * MIN_PER_DAY;
  if (day >= r.start && day < r.end) return dayStart(day);
  return null;
}

/** Why the hours cannot be entered, or null. */
export function validateHours(db: Db, tsId: string, taskrsrcId: string, day: number, hours: number, overtime = false): string | null {
  const p = getPeriod(db, tsId);
  if (!p) return 'Timesheet period not found.';
  const a = rows(db, 'TASKRSRC').find((x) => x.taskrsrc_id === taskrsrcId);
  if (!a) return 'Resource assignment not found.';
  if (!rows(db, 'TASK').some((t) => t.task_id === a.task_id)) return 'The activity of this assignment is missing.';
  const h = getTimesheet(db, a.rsrc_id, tsId);
  if (!isEditable(h)) return `The timesheet is ${TS_STATUS[h!.status_code as TsStatus] ?? h!.status_code} and cannot be edited.`;
  if (!Number.isFinite(hours) || hours < 0) return 'Hours must be zero or greater.';
  if (hours > MAX_HOURS_PER_DAY) return `No more than ${MAX_HOURS_PER_DAY} hours can be entered for a day.`;
  const r = periodRange(p);
  const d = resolveDay(r, day);
  if (d == null) return 'The day is outside the timesheet period.';
  let other = 0;
  for (const e of rows(db, 'RSRCHOUR')) {
    if (e.ts_id !== tsId || e.rsrc_id !== a.rsrc_id || dayStart(parseP6Date(e.workdate) ?? -1) !== d) continue;
    other += e.taskrsrc_id === taskrsrcId ? (overtime ? num(e.hr_cnt) : num(e.ot_hr_cnt)) : num(e.hr_cnt) + num(e.ot_hr_cnt);
  }
  if (other + hours > MAX_HOURS_PER_DAY) return `The resource would report ${p6num(other + hours)} hours on ${formatP6Date(d).slice(0, 10)}; the most is ${MAX_HOURS_PER_DAY}.`;
  return null;
}

/** Enter regular (or overtime) hours for an assignment on a day of the period. Creates the timesheet if needed. */
export function setHours(db: Db, tsId: string, taskrsrcId: string, day: number, hours: number, overtime = false): void {
  const err = validateHours(db, tsId, taskrsrcId, day, hours, overtime);
  if (err) throw new Error(err);
  const a = rows(db, 'TASKRSRC').find((x) => x.taskrsrc_id === taskrsrcId)!;
  const t = rows(db, 'TASK').find((x) => x.task_id === a.task_id)!;
  const h = timesheetFor(db, a.rsrc_id, tsId);
  addLine(db, h, a);
  const d = resolveDay(periodRange(getPeriod(db, tsId)!), day)!;
  const E = tbl(db, 'RSRCHOUR', RSRCHOUR_FIELDS);
  const workdate = formatP6Date(d);
  let e = E.rows.find((x) => x.ts_id === tsId && x.taskrsrc_id === taskrsrcId && dayStart(parseP6Date(x.workdate) ?? -1) === d);
  if (!e) {
    if (hours === 0) return;
    e = { rsrc_hr_id: newId(db, 'RSRCHOUR', 'rsrc_hr_id'), rsrc_id: a.rsrc_id, ts_id: tsId, taskrsrc_id: taskrsrcId, task_id: a.task_id, proj_id: t.proj_id, workdate, hr_cnt: '0', ot_hr_cnt: '0', status: h.status_code };
    E.rows.push(e);
  }
  e[overtime ? 'ot_hr_cnt' : 'hr_cnt'] = p6num(hours);
  if (!num(e.hr_cnt) && !num(e.ot_hr_cnt) && e._applied_flag !== 'Y') E.rows = E.rows.filter((x) => x !== e);
}

/** Flag a timesheet line "complete": Apply Actuals then finishes the assignment (and activity, see applyApprovedTimesheets). */
export function setLineComplete(db: Db, tsId: string, taskrsrcId: string, complete: boolean): void {
  const a = rows(db, 'TASKRSRC').find((x) => x.taskrsrc_id === taskrsrcId);
  if (!a) throw new Error('Resource assignment not found.');
  const h0 = getTimesheet(db, a.rsrc_id, tsId);
  if (!isEditable(h0)) throw new Error(`The timesheet is ${TS_STATUS[h0!.status_code as TsStatus] ?? h0!.status_code} and cannot be edited.`);
  const h = timesheetFor(db, a.rsrc_id, tsId);
  addLine(db, h, a).complete_flag = complete ? 'Y' : 'N';
}

// ---------------------------------------------------------------- approval workflow

/** Why the timesheet cannot move to `to`, or null. */
export function statusError(db: Db, tsId: string, rsrcId: string, to: TsStatus): string | null {
  if (!getPeriod(db, tsId)) return 'Timesheet period not found.';
  const h = getTimesheet(db, rsrcId, tsId);
  const cur = (h?.status_code || 'TS_Active') as TsStatus;
  const name = TS_STATUS[cur] ?? cur;
  if (to === 'TS_Submit') return cur === 'TS_Active' || cur === 'TS_Reject' ? null : `The timesheet is already ${name.toLowerCase()}.`;
  if (to === 'TS_Approve' || to === 'TS_Reject') {
    if (!h) return 'The resource has not created this timesheet.';
    return cur === 'TS_Submit' ? null : `Only submitted timesheets can be ${to === 'TS_Approve' ? 'approved' : 'rejected'} (this one is ${name.toLowerCase()}).`;
  }
  return 'Unknown timesheet status.';
}

export interface StatusOpts { note?: string; at?: number }

function transition(db: Db, tsId: string, rsrcId: string, to: TsStatus, opts: StatusOpts = {}): Row {
  const err = statusError(db, tsId, rsrcId, to);
  if (err) throw new Error(err);
  const h = timesheetFor(db, rsrcId, tsId);
  const at = formatP6Date(opts.at ?? Math.floor(Date.now() / 60000) - new Date().getTimezoneOffset()); // local wall clock
  h.status_code = to;
  h.status_date = at;
  if (opts.note?.trim()) h.ts_notes = [h.ts_notes, `${at.slice(0, 10)} ${TS_STATUS[to]}: ${opts.note.trim()}`].filter(Boolean).join(' | ');
  for (const e of rows(db, 'RSRCHOUR')) if (e.ts_id === tsId && e.rsrc_id === rsrcId) e.status = to;
  return h;
}

/** Resource submits the timesheet for approval (Active or Rejected -> Submitted). */
export const submit = (db: Db, tsId: string, rsrcId: string, opts?: StatusOpts) => transition(db, tsId, rsrcId, 'TS_Submit', opts);
/** Approver approves a submitted timesheet; it becomes read-only and its hours can be applied. */
export const approve = (db: Db, tsId: string, rsrcId: string, opts?: StatusOpts) => transition(db, tsId, rsrcId, 'TS_Approve', opts);
/** Approver rejects a submitted timesheet; the resource can edit and resubmit it. */
export const reject = (db: Db, tsId: string, rsrcId: string, opts?: StatusOpts) => transition(db, tsId, rsrcId, 'TS_Reject', opts);

export interface TimesheetInfo { tsId: string; rsrcId: string; header: Row; hours: number; ot: number; applied: number; pending: number }

/** All timesheets of a period with totals (Timesheet Approval). */
export function periodTimesheets(db: Db, tsId: string): TimesheetInfo[] {
  const out = new Map<string, TimesheetInfo>();
  for (const h of rows(db, 'TIMESHT')) if (h.ts_id === tsId) out.set(h.rsrc_id, { tsId, rsrcId: h.rsrc_id, header: h, hours: 0, ot: 0, applied: 0, pending: 0 });
  for (const e of rows(db, 'RSRCHOUR')) {
    const i = e.ts_id === tsId ? out.get(e.rsrc_id) : undefined;
    if (!i) continue;
    i.hours += num(e.hr_cnt);
    i.ot += num(e.ot_hr_cnt);
    if (e._applied_flag === 'Y') i.applied += num(e.hr_cnt) + num(e.ot_hr_cnt);
    else i.pending += num(e.hr_cnt) + num(e.ot_hr_cnt);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- apply actuals

export interface ApplySummary {
  timesheets: number; entries: number; regHours: number; otHours: number;
  assignments: number; activitiesStarted: number; activitiesCompleted: number;
  /** latest day with applied hours, yyyy-mm-dd ('' when nothing applied) */
  lastWorkDay: string;
}

const approvedHeaders = (db: Db) => new Set(rows(db, 'TIMESHT').filter((h) => h.status_code === 'TS_Approve').map((h) => `${h.ts_id}|${h.rsrc_id}`));

/** Approved hour entries of these projects not yet applied (optionally only days before `upTo`). */
export function pendingApprovedEntries(db: Db, projIds: string[], upTo?: number): Row[] {
  const ok = approvedHeaders(db);
  const projs = new Set(projIds);
  const tasks = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  return rows(db, 'RSRCHOUR').filter((e) => {
    if (e._applied_flag === 'Y' || !ok.has(`${e.ts_id}|${e.rsrc_id}`)) return false;
    if (!projs.has(tasks.get(e.task_id)?.proj_id ?? e.proj_id)) return false;
    return upTo == null || dayStart(parseP6Date(e.workdate) ?? Infinity) < upTo;
  });
}

/** Lines of approved timesheets flagged complete and not yet applied. */
export function pendingCompleteLines(db: Db, projIds: string[], upTo?: number): Row[] {
  const ok = approvedHeaders(db);
  const projs = new Set(projIds);
  const asgById = new Map(rows(db, 'TASKRSRC').map((a) => [a.taskrsrc_id, a]));
  const taskById = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const periods = new Map(rows(db, 'TSDATES').map((p) => [p.ts_id, periodRange(p)]));
  return rows(db, '_TSLINE').filter((l) => {
    if (l.complete_flag !== 'Y' || l._applied_flag === 'Y' || !ok.has(`${l.ts_id}|${l.rsrc_id}`)) return false;
    const a = asgById.get(l.taskrsrc_id), t = a && taskById.get(a.task_id);
    if (!t || !projs.has(t.proj_id)) return false;
    const r = periods.get(l.ts_id);
    return upTo == null || !r || r.start < upTo;
  });
}

/** Whether Apply Actuals has anything to do for these projects. */
export function hasPendingActuals(db: Db, projIds: string[], upTo?: number): boolean {
  return pendingApprovedEntries(db, projIds, upTo).length > 0 || pendingCompleteLines(db, projIds, upTo).length > 0;
}

/**
 * Tools > Apply Actuals from approved timesheets.
 * - Each assignment: actual regular/overtime units += approved hours not applied yet; remaining units reduced by
 *   the same amount (not below 0; P6 "subtract actual from at completion"), then units/time and costs refreshed
 *   through recalcAssignment. Applied entries are marked (_applied_flag, not exported) so re-applying adds nothing.
 * - Actual start (assignment and activity, when missing) = start of work on the first day with hours; activity
 *   becomes TK_Active.
 * - Remaining duration: only for Units % complete (CP_Units) activities, reduced in proportion to units progress:
 *   remaining = original x (1 - actual units / at-completion units), never increased. Duration and Physical
 *   activities keep the remaining duration the scheduler set.
 * - Finish: a line flagged complete finishes its assignment (remaining units 0, actual finish = end of the last day
 *   with hours). The activity finishes too when that resource is the activity's primary resource or every
 *   labor/nonlabor assignment of the activity is finished.
 * The data date is not moved; reschedule (F9) afterwards.
 */
export function applyApprovedTimesheets(db: Db, projIds: string[], upTo?: number): ApplySummary {
  const s: ApplySummary = { timesheets: 0, entries: 0, regHours: 0, otHours: 0, assignments: 0, activitiesStarted: 0, activitiesCompleted: 0, lastWorkDay: '' };
  const entries = pendingApprovedEntries(db, projIds, upTo);
  const asgById = new Map(rows(db, 'TASKRSRC').map((a) => [a.taskrsrc_id, a]));
  const taskById = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const periods = new Map(rows(db, 'TSDATES').map((p) => [p.ts_id, periodRange(p)]));
  const completeLines = pendingCompleteLines(db, projIds, upTo);
  if (!entries.length && !completeLines.length) return s;

  tbl(db, 'TASK', ['act_start_date', 'act_end_date', 'status_code', 'remain_drtn_hr_cnt']);
  tbl(db, 'TASKRSRC', ['act_reg_qty', 'act_ot_qty', 'act_start_date', 'act_end_date', 'remain_qty']);
  const projById = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p]));
  const cals = calendarResolver(db, []);
  const calOf = (t: Row) => cals.get(t.clndr_id) ?? cals.fallback(projById.get(t.proj_id)?.clndr_id);
  const workStart = (t: Row, d: number) => { const sh = calOf(t).shiftsOn(Math.floor(d / MIN_PER_DAY)); return d + (sh.length ? sh[0].start : 480); };
  const workEnd = (t: Row, d: number) => { const sh = calOf(t).shiftsOn(Math.floor(d / MIN_PER_DAY)); return d + (sh.length ? sh[sh.length - 1].end : 1020); };

  // group entries per assignment
  const per = new Map<string, { reg: number; ot: number; first: number; last: number }>();
  const sheets = new Set<string>();
  let lastDay = -Infinity;
  for (const e of entries) {
    const a = asgById.get(e.taskrsrc_id);
    if (!a || !taskById.has(a.task_id)) continue;
    const d = dayStart(parseP6Date(e.workdate) ?? 0);
    const reg = num(e.hr_cnt), ot = num(e.ot_hr_cnt);
    let x = per.get(a.taskrsrc_id);
    if (!x) per.set(a.taskrsrc_id, (x = { reg: 0, ot: 0, first: Infinity, last: -Infinity }));
    x.reg += reg; x.ot += ot;
    if (reg + ot > 0) { x.first = Math.min(x.first, d); x.last = Math.max(x.last, d); lastDay = Math.max(lastDay, d); }
    e._applied_flag = 'Y';
    sheets.add(`${e.ts_id}|${e.rsrc_id}`);
    s.entries++; s.regHours += reg; s.otHours += ot;
  }
  for (const l of completeLines) sheets.add(`${l.ts_id}|${l.rsrc_id}`);
  s.timesheets = sheets.size;

  const touched = new Set<string>(); // task ids
  const changed = new Set<string>(); // taskrsrc ids
  for (const [id, x] of per) {
    const a = asgById.get(id)!, t = taskById.get(a.task_id)!;
    a.act_reg_qty = p6num(num(a.act_reg_qty) + x.reg);
    a.act_ot_qty = p6num(num(a.act_ot_qty) + x.ot);
    a.remain_qty = p6num(Math.max(0, num(a.remain_qty) - x.reg - x.ot));
    if (Number.isFinite(x.first)) {
      const st = workStart(t, x.first);
      if (!a.act_start_date) a.act_start_date = formatP6Date(st);
      if (!t.act_start_date) { t.act_start_date = formatP6Date(st); t.status_code = 'TK_Active'; s.activitiesStarted++; }
    }
    s.assignments++;
    touched.add(t.task_id);
    changed.add(id);
  }

  // last day with hours per assignment over all applied entries (for actual finish)
  const lastWorked = new Map<string, number>();
  for (const e of rows(db, 'RSRCHOUR')) {
    if (e._applied_flag !== 'Y' || num(e.hr_cnt) + num(e.ot_hr_cnt) <= 0) continue;
    const d = dayStart(parseP6Date(e.workdate) ?? 0);
    lastWorked.set(e.taskrsrc_id, Math.max(lastWorked.get(e.taskrsrc_id) ?? -Infinity, d));
  }
  const finishTasks = new Set<string>();
  for (const l of completeLines) {
    const a = asgById.get(l.taskrsrc_id)!, t = taskById.get(a.task_id)!;
    const last = lastWorked.get(a.taskrsrc_id) ?? periods.get(l.ts_id)?.start;
    if (last == null) continue;
    const fin = workEnd(t, last);
    if (!a.act_start_date) a.act_start_date = t.act_start_date || formatP6Date(workStart(t, last));
    if (!t.act_start_date) { t.act_start_date = a.act_start_date; t.status_code = 'TK_Active'; s.activitiesStarted++; }
    a.act_end_date = formatP6Date(Math.max(fin, parseP6Date(a.act_start_date) ?? fin));
    a.remain_qty = '0';
    l._applied_flag = 'Y';
    touched.add(t.task_id);
    changed.add(a.taskrsrc_id);
    const others = rows(db, 'TASKRSRC').filter((y) => y.task_id === t.task_id && y.rsrc_type !== 'RT_Mat');
    if ((t.rsrc_id && t.rsrc_id === a.rsrc_id) || others.every((y) => y.act_end_date)) finishTasks.add(t.task_id);
  }

  for (const tid of touched) {
    const t = taskById.get(tid)!;
    const list = rows(db, 'TASKRSRC').filter((y) => y.task_id === tid);
    if (finishTasks.has(tid) && !t.act_end_date) {
      let fin = -Infinity;
      for (const y of list) fin = Math.max(fin, parseP6Date(y.act_end_date) ?? -Infinity);
      if (!Number.isFinite(fin)) fin = workEnd(t, lastDay);
      fin = Math.max(fin, parseP6Date(t.act_start_date) ?? fin);
      t.act_end_date = formatP6Date(fin);
      t.remain_drtn_hr_cnt = '0';
      t.status_code = 'TK_Complete';
      for (const y of list) { y.remain_qty = '0'; if (!y.act_end_date) y.act_end_date = t.act_end_date; if (!y.act_start_date) y.act_start_date = t.act_start_date; changed.add(y.taskrsrc_id); }
      s.activitiesCompleted++;
    } else if (!t.act_end_date && t.complete_pct_type === 'CP_Units') {
      const units = list.filter((y) => y.rsrc_type !== 'RT_Mat');
      const act = units.reduce((v, y) => v + num(y.act_reg_qty) + num(y.act_ot_qty), 0);
      const atc = act + units.reduce((v, y) => v + num(y.remain_qty), 0);
      if (atc > 0) {
        const rem = num(t.target_drtn_hr_cnt) * (1 - act / atc);
        t.remain_drtn_hr_cnt = p6num(Math.max(0, Math.min(num(t.remain_drtn_hr_cnt), rem)));
      }
    }
    // refresh units/time and costs per assignment rules
    for (const y of list) if (changed.has(y.taskrsrc_id)) recalcAssignment(db, t, y, 'remain_qty', num(y.remain_qty));
  }
  s.lastWorkDay = Number.isFinite(lastDay) ? formatP6Date(lastDay).slice(0, 10) : '';
  return s;
}

export function formatApplySummary(s: ApplySummary): string {
  if (!s.entries && !s.activitiesCompleted) return 'No approved timesheet hours to apply.';
  const h = (n: number) => p6num(Math.round(n * 100) / 100);
  return `Applied ${h(s.regHours)}h regular${s.otHours ? ` + ${h(s.otHours)}h overtime` : ''} from ${s.timesheets} timesheet${s.timesheets === 1 ? '' : 's'} to ${s.assignments} assignment${s.assignments === 1 ? '' : 's'}`
    + `; ${s.activitiesStarted} activit${s.activitiesStarted === 1 ? 'y' : 'ies'} started, ${s.activitiesCompleted} completed`
    + (s.lastWorkDay ? `; last day worked ${s.lastWorkDay}. Reschedule (F9) to update dates.` : '.');
}
