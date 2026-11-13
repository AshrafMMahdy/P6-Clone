// Shared pieces of the schedule analyses (Check Schedule, DCMA 14-point, lint): the projects and activities in scope,
// activity kinds, baselines, constraint groups, and the result shape every check returns.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { tidyNotes, differentDataDates, namesText, noDataDateNotAssessed, noDataDateUsed, notAssessed as notAssessedNote } from '../notes.ts';
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

/** Long analyses call this between units of work: it reports progress, yields to the event loop and throws when the
 *  call was cancelled (the MCP server's; the desktop app passes none, so the work runs straight through). */
export type Tick = (done: number, total: number, message: string) => Promise<void>;

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

/** The sentences about projects with no data date of their own: where the planned start stood in for one (said by the schedule that did it), and where there is none at all (`noneNotAssessed`: the checks that need one are not assessed; pass false for a tool that goes on without it). */
export function dataDateNotes(projs: Row[], noneNotAssessed = true): string[] {
  const out: string[] = [];
  for (const p of projs) {
    if (parseP6Date(p.last_recalc_date) != null && p._dd_assumed && p._dd_assumed === p.last_recalc_date) out.push(noDataDateUsed(p.proj_short_name, formatP6Date(parseP6Date(p.last_recalc_date)!).slice(0, 16)));
    else if (parseP6Date(p.last_recalc_date) == null && noneNotAssessed) out.push(noDataDateNotAssessed(p.proj_short_name));
  }
  return out;
}

/** What an answer that carries a data / status date adds as data: each project's own date when they differ (the answer's single date is the first project's with one). The sentence is in the notes (Scope.dateNotes). */
export const dateFields = (s: Scope, label = 'status_dates'): Record<string, unknown> => { const by = s.dataDatesByProject(); return by ? { [label]: by } : {}; };

export interface Scope {
  db: Db; ctx: Ctx; dh: DayHours; hpd: number;
  projs: Row[]; projIds: Set<string>;
  tasks: Row[];
  /** relationships with both ends in scope or one end in scope (external links count once) */
  rels: Row[];
  /** the data date (or the status date given) of each project, in minutes */
  dataDate: (projId: string) => number | null;
  /** the data dates of the projects in scope, by Project ID, when they differ (null when they are all the same or none has one) */
  dataDatesByProject: () => Record<string, string | null> | null;
  /** the notes about the data dates: a project with none (the planned start stood in, or the checks that need one are not assessed) and projects with different ones (none when the caller gave a status date) */
  dateNotes: (noneNotAssessed?: boolean) => string[];
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
  const dataDatesByProject = () => {
    const by = Object.fromEntries(projs.map((p) => { const d = dd.get(p.proj_id) ?? null; return [p.proj_short_name, d != null ? formatP6Date(d) : null]; }));
    return projs.length > 1 && new Set(Object.values(by)).size > 1 ? by : null;
  };
  const dateNotes = (noneNotAssessed = true) => {
    if (o.statusDate != null) return [];
    const by = dataDatesByProject();
    return [...dataDateNotes(projs, noneNotAssessed), ...(by ? [differentDataDates(Object.entries(by).filter(([, d]) => d != null).map(([proj, d]) => ({ proj, date: String(d).slice(0, 10) })), 'each project\u2019s own date')] : [])];
  };
  return { db, ctx, dh: dayHours(db, hpd, o.calendarDays ?? true), hpd, projs, projIds, tasks, rels, dataDate: (id) => dd.get(id) ?? null, dataDatesByProject, dateNotes, cal, projCal, workDays };
}

/** A project's baseline: the project baseline P6 stores (sum_base_proj_id) or a user baseline BL1-BL3. */
export function baselineOf(db: Db, proj: Row, which: 'project' | 'bl1' | 'bl2' | 'bl3' | (string & {}) = 'project'): { projId: string; name: string; tasks: Map<string, Row>; how: string } | null {
  // any saved baseline by its name (P6 keeps any number; BL1-BL3 are only the ones assigned for display)
  if (!['project', 'bl1', 'bl2', 'bl3'].includes(which)) {
    const want = which.replace(/^baseline:/i, '').trim().toLowerCase();
    const b = rows(db, 'PROJECT').find((p) => p._baseline_of === proj.proj_id && (p.proj_short_name.toLowerCase() === want || (p.proj_name ?? '').toLowerCase() === want));
    if (!b) return null;
    return { projId: b.proj_id, name: b.proj_short_name, tasks: new Map(rows(db, 'TASK').filter((t) => t.proj_id === b.proj_id).map((t) => [t.task_code, t])), how: 'saved baseline, chosen by name' };
  }
  // the project baseline: sum_base_proj_id, else the one baseline copy saved from this project (files that carry the
  // baseline project but not the assignment, e.g. Tower-A)
  const copies = which === 'project' && !proj.sum_base_proj_id ? rows(db, 'PROJECT').filter((p) => p._baseline_of === proj.proj_id) : [];
  const id = which === 'project' ? proj.sum_base_proj_id || (copies.length === 1 ? copies[0].proj_id : '') : proj[`_${which}`];
  if (!id || id === proj.proj_id) return null;
  const b = rows(db, 'PROJECT').find((p) => p.proj_id === id);
  if (!b) return null;
  const tasks = new Map(rows(db, 'TASK').filter((t) => t.proj_id === id).map((t) => [t.task_code, t]));
  const how = which !== 'project' ? `assigned as ${which.toUpperCase()}` : proj.sum_base_proj_id ? 'the project baseline' : 'the only baseline saved from this project (none is assigned as the project baseline)';
  return { projId: id, name: b.proj_short_name, tasks, how };
}

/** A baseline activity's finish: its actual finish, else its planned/early finish. */
export const baselineFinish = (b: Row | undefined) => (b ? parseP6Date(b.act_end_date || b.early_end_date || b.target_end_date) : null);
/** An activity's forecast finish: actual finish, else remaining early finish, else early finish. */
export const forecastFinish = (t: Row) => parseP6Date(t.act_end_date || t.reend_date || t.early_end_date || t.target_end_date);

// (LISTED and namesText live in core/notes.ts, with the agreed-limit mark; re-exported here for the analyses)
export { LISTED, namesText } from '../notes.ts';

/** A share (n of d) as a percent, FOR DISPLAY ONLY: one decimal, and a share that is not zero but would show as 0.0 shows its first two significant digits (1 of 2,068 reads 0.048, never 0); that two-significant-digit rule is only how a small share is shown. Every check is judged on the exact count: use `exactPct` (below), never this rounded figure. */
export const pct = (n: number, d: number) => {
  if (!d) return null;
  const v = Math.round((1000 * n) / d) / 10;
  return v === 0 && n > 0 ? Number(((100 * n) / d).toPrecision(2)) : v;
};
/** A share (n of d) as an exact percent: what a threshold is judged against (a check that finds one activity fails a 0 % threshold whatever the population; the rounded display above must never decide). */
export const exactPct = (n: number, d: number) => (100 * n) / d;
export const offender = (t: Row, s: Scope, value?: string | number): Offender => ({ id: t.task_code, name: t.task_name, ...(s.projs.length > 1 ? { project: s.ctx.proj.get(t.proj_id)?.proj_short_name } : {}), ...(value != null ? { value } : {}) });

/** Grade a ratio or percentage against a threshold. */
export function passes(v: number, th: Threshold): boolean {
  switch (th.op) { case '<': return v < th.value; case '<=': return v <= th.value; case '>': return v > th.value; case '>=': return v >= th.value; default: return v === th.value; }
}

/** A percentage check: count of activities (or links) found over a population. */
export function percentCheck(id: string, name: string, found: Offender[], denominator: number, th: Threshold, maxIds: number): CheckResult {
  const metric = pct(found.length, denominator);
  return {
    id, name, unit: '%', metric, threshold: th, numerator: found.length, denominator,
    result: denominator === 0 ? 'pass' : passes(exactPct(found.length, denominator), th) ? 'pass' : 'fail',
    activities: maxIds > 0 ? found.slice(0, maxIds) : found, total_activities: found.length,
  };
}

/** A check that could not be assessed: its note is the one sentence "<check> not assessed: <reason>." (the same wording in every tool). */
export const notAssessed = (id: string, name: string, unit: CheckResult['unit'], th: Threshold | null, reason: string): CheckResult =>
  ({ id, name, result: 'not_assessed', metric: null, unit, threshold: th, numerator: null, denominator: null, activities: [], total_activities: 0, note: notAssessedNote(name.replace(/^\d+[A-Za-z]?\.\s*/, ''), reason) });
/** The notes of a report of checks: the sentences about the data dates, then the check notes (a part that is not assessed, a test that was run on another activity). The checks keep `note` for the desktop screens; an agent's answer carries these once, in `notes`. */
export const checkNotes = (s: Scope, checks: CheckResult[], extra: string[] = [], noneNotAssessed = true): string[] => tidyNotes([...s.dateNotes(noneNotAssessed), ...checks.flatMap((c) => (c.note ? [c.note] : [])), ...extra]);

/** A relationship as an offender: "pred -> succ (type lag)". */
export function relOffender(r: Row, s: Scope): Offender {
  const p = s.ctx.taskById.get(r.pred_task_id), t = s.ctx.taskById.get(r.task_id);
  const lagDays = Math.round((Number(r.lag_hr_cnt || 0) / (p ? s.dh.task(p) : s.hpd)) * 100) / 100;
  return { id: `${p?.task_code ?? r.pred_task_id} -> ${t?.task_code ?? r.task_id}`, name: `${(r.pred_type || 'PR_FS').slice(3)}${lagDays ? ` lag ${lagDays}d` : ''}`, value: lagDays };
}
