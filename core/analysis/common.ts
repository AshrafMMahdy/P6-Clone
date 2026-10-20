// Shared pieces of the schedule analyses (Check Schedule, DCMA 14-point, lint): the projects and activities in scope,
// activity kinds, baselines, constraint groups, and the result shape every check returns.
import { rows, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { makeCtx, type Ctx } from '../project/ctx.ts';
import { dayHours, type DayHours } from '../project/units.ts';
import { calendarResolver } from '../schedule/cpm.ts';
import type { WorkCalendar } from '../calendar/calendar.ts';

export interface Offender { id: string; name: string; project?: string; value?: string | number }
export interface Threshold { op: '<' | '<=' | '>' | '>=' | '='; value: number; source: string }
export interface CheckResult {
  id: string; name: string;
  result: 'pass' | 'fail' | 'not_assessed';
  /** the measured value: a percentage, a ratio, or for a test a number of days */
  metric: number | null; unit: '%' | 'ratio' | 'days';
  threshold: Threshold | null;
  numerator: number | null; denominator: number | null;
  /** the activities the check found (capped; total_activities has the full count) */
  activities: Offender[]; total_activities: number;
  note?: string;
  detail?: Record<string, unknown>;
}

export const isWbs = (t: Row) => t.task_type === 'TT_WBS';
export const isLoe = (t: Row) => t.task_type === 'TT_LOE';
export const isMilestone = (t: Row) => t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile';
export const isDone = (t: Row) => !!t.act_end_date;
export const isStarted = (t: Row) => !!t.act_start_date && !t.act_end_date;

/** P6's constraint groups (Check Schedule): hard = Mandatory; soft = every other constraint. */
export const P6_HARD = new Set(['CS_MANDSTART', 'CS_MANDFIN']);
export const P6_SOFT = new Set(['CS_MSO', 'CS_MSOB', 'CS_MSOA', 'CS_MEO', 'CS_MEOB', 'CS_MEOA', 'CS_ALAP']);
/** DCMA's hard constraints: Must Start/Finish On (P6 Start On, Finish On, Mandatory) and Start/Finish No Later Than (On or Before). */
export const DCMA_HARD = new Set(['CS_MSO', 'CS_MEO', 'CS_MSOB', 'CS_MEOB', 'CS_MANDSTART', 'CS_MANDFIN']);
export const START_CONSTRAINTS = new Set(['CS_MSO', 'CS_MSOB', 'CS_MSOA', 'CS_MANDSTART']);
/** The activity's constraints (primary and secondary). */
export const constraintsOf = (t: Row) => [t.cstr_type, t.cstr_type2].filter((c): c is string => !!c);

export interface Scope {
  db: Db; ctx: Ctx; dh: DayHours; hpd: number;
  projs: Row[]; projIds: Set<string>;
  tasks: Row[];
  /** relationships with both ends in scope or one end in scope (external links count once) */
  rels: Row[];
  /** the data date (or the status date given) of each project, in minutes */
  dataDate: (projId: string) => number | null;
  cal: (t: Row) => WorkCalendar;
  projCal: (p: Row) => WorkCalendar;
  /** working days between two times on a calendar (b after a: positive) */
  workDays: (c: WorkCalendar, a: number, b: number) => number;
}

export function makeScope(db: Db, o: { projIds?: string[]; hoursPerDay?: number; statusDate?: number | null; calendarDays?: boolean } = {}): Scope {
  const hpd = o.hoursPerDay ?? 8;
  const projs = rows(db, 'PROJECT').filter((p) => !p._baseline_of && (!o.projIds?.length || o.projIds.includes(p.proj_id)));
  const projIds = new Set(projs.map((p) => p.proj_id));
  const tasks = rows(db, 'TASK').filter((t) => projIds.has(t.proj_id));
  const rels = rows(db, 'TASKPRED').filter((r) => projIds.has(r.proj_id) || projIds.has(r.pred_proj_id));
  const ctx = makeCtx(db, { hoursPerDay: hpd });
  const cals = calendarResolver(db, []);
  const projById = new Map(projs.map((p) => [p.proj_id, p]));
  const dd = new Map(projs.map((p) => [p.proj_id, o.statusDate ?? parseP6Date(p.last_recalc_date) ?? null]));
  const projCal = (p: Row) => cals.fallback(p.clndr_id);
  const cal = (t: Row) => cals.get(t.clndr_id) ?? cals.fallback(projById.get(t.proj_id)?.clndr_id);
  const workDays = (c: WorkCalendar, a: number, b: number) => {
    const hrs = c.hoursPerDay() || hpd;
    const m = a <= b ? c.workBetween(a, b) : -c.workBetween(b, a);
    return Math.round((m / 60 / hrs) * 100) / 100;
  };
  return { db, ctx, dh: dayHours(db, hpd, o.calendarDays ?? true), hpd, projs, projIds, tasks, rels, dataDate: (id) => dd.get(id) ?? null, cal, projCal, workDays };
}

/** A project's baseline: the project baseline P6 stores (sum_base_proj_id) or a user baseline BL1-BL3. */
export function baselineOf(db: Db, proj: Row, which: 'project' | 'bl1' | 'bl2' | 'bl3' = 'project'): { projId: string; name: string; tasks: Map<string, Row> } | null {
  const id = which === 'project' ? proj.sum_base_proj_id : proj[`_${which}`];
  if (!id || id === proj.proj_id) return null;
  const b = rows(db, 'PROJECT').find((p) => p.proj_id === id);
  if (!b) return null;
  const tasks = new Map(rows(db, 'TASK').filter((t) => t.proj_id === id).map((t) => [t.task_code, t]));
  return { projId: id, name: b.proj_short_name, tasks };
}

/** A baseline activity's finish: its actual finish, else its planned/early finish. */
export const baselineFinish = (b: Row | undefined) => (b ? parseP6Date(b.act_end_date || b.early_end_date || b.target_end_date) : null);
/** An activity's forecast finish: actual finish, else remaining early finish, else early finish. */
export const forecastFinish = (t: Row) => parseP6Date(t.act_end_date || t.reend_date || t.early_end_date || t.target_end_date);

export const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
export const offender = (t: Row, s: Scope, value?: string | number): Offender => ({ id: t.task_code, name: t.task_name, ...(s.projs.length > 1 ? { project: s.ctx.proj.get(t.proj_id)?.proj_short_name } : {}), ...(value != null ? { value } : {}) });

/** Grade a ratio or percentage against a threshold. */
export function passes(v: number, th: Threshold): boolean {
  switch (th.op) { case '<': return v < th.value; case '<=': return v <= th.value; case '>': return v > th.value; case '>=': return v >= th.value; default: return v === th.value; }
}

/** A percentage check: count of activities (or links) found over a population. */
export function percentCheck(id: string, name: string, found: Offender[], denominator: number, th: Threshold, maxIds: number, note?: string): CheckResult {
  const metric = pct(found.length, denominator);
  return {
    id, name, unit: '%', metric, threshold: th, numerator: found.length, denominator,
    result: denominator === 0 ? 'pass' : passes(metric!, th) ? 'pass' : 'fail',
    activities: maxIds > 0 ? found.slice(0, maxIds) : found, total_activities: found.length,
    ...(note ? { note } : {}),
  };
}

export const notAssessed = (id: string, name: string, unit: CheckResult['unit'], th: Threshold | null, note: string): CheckResult =>
  ({ id, name, result: 'not_assessed', metric: null, unit, threshold: th, numerator: null, denominator: null, activities: [], total_activities: 0, note });

/** A relationship as an offender: "pred -> succ (type lag)". */
export function relOffender(r: Row, s: Scope): Offender {
  const p = s.ctx.taskById.get(r.pred_task_id), t = s.ctx.taskById.get(r.task_id);
  const lagDays = Math.round((Number(r.lag_hr_cnt || 0) / (p ? s.dh.task(p) : s.hpd)) * 100) / 100;
  return { id: `${p?.task_code ?? r.pred_task_id} -> ${t?.task_code ?? r.task_id}`, name: `${(r.pred_type || 'PR_FS').slice(3)}${lagDays ? ` lag ${lagDays}d` : ''}`, value: lagDays };
}
