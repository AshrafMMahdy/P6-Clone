// The full P6 schedule log as data: Errors, Warnings and Exceptions, each section with the activities it lists, plus
// the statistics. F9's own findings (loops, open ends, out of sequence, actuals after the data date, unmet constraints,
// negative float) are joined by the sections P6 also prints and F9 does not compute itself: milestones with invalid
// relationships, critical activities, unsatisfied constraints of every type, unsatisfied relationships, external dates.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import type { Finding } from '../findings.ts';
import { isCritical, makeCtx } from '../project/ctx.ts';
import { calendarResolver, relationshipFloat, type ScheduleResult } from '../schedule/cpm.ts';
import { constraintNotMet } from '../schedule/constraints.ts';
import { dayHours } from '../project/units.ts';
import { cstrName, daysText, differentDataDates, duplicateRow, LISTED, listCut } from '../notes.ts';

export interface LogSection { code: string; title: string; count: number; activities: { id: string; name: string; detail?: string }[] }

export interface ScheduleLogReport { statistics: ScheduleResult['stats']; errors: LogSection[]; warnings: LogSection[]; exceptions: LogSection[] }

const START_TYPES = new Set(['CS_MSO', 'CS_MSOB', 'CS_MSOA', 'CS_MANDSTART']);

const FROM_F9: [string, string, 'errors' | 'warnings' | 'exceptions'][] = [
  ['SCHED_LOOP', 'Activities that have invalid relationship loops', 'errors'],
  ['SCHED_CALENDAR', 'Calendar errors', 'errors'],
  ['OPEN_START', 'Activities without predecessors', 'warnings'],
  ['OPEN_FINISH', 'Activities without successors', 'warnings'],
  ['OUT_OF_SEQUENCE', 'Out of sequence activities', 'warnings'],
  ['ACTUAL_AFTER_DD', 'Activities with actual dates later than the data date', 'warnings'],
  ['SCHED_CAL_INVALID', 'Invalid calendars', 'warnings'],
  ['NEGATIVE_FLOAT', 'Activities with negative float', 'exceptions'],
];

/** Sections P6 prints that are computed from the scheduled dates (shared by the MCP log and the desktop Schedule Log). */
export function extraLogSections(db: Db, projIds: string[], maxIds = 100, leftOut: Row[] = []): { warnings: LogSection[]; exceptions: LogSection[] } {
  const open = new Set(projIds);
  const tasks = rows(db, 'TASK').filter((t) => open.has(t.proj_id));
  const ctx = makeCtx(db, { hoursPerDay: 8 });
  const relFF = relationshipFloat(db, ctx), dh = dayHours(db, 8, true);
  const sec = (code: string, title: string, list: { t: Row; detail?: string }[]): LogSection => ({ code, title, count: list.length, activities: (maxIds ? list.slice(0, maxIds) : list).map((x) => ({ id: x.t.task_code, name: x.t.task_name, ...(x.detail ? { detail: x.detail } : {}) })) });

  // a start milestone has no finish and a finish milestone no start: links that use them are invalid in P6
  const badMs: { t: Row; detail: string }[] = [];
  const codeOf = (id: string) => ctx.taskById.get(id)?.task_code ?? '(outside the open projects)';
  for (const t of tasks) {
    if (t.task_type === 'TT_Mile') {
      for (const r of ctx.predsOf.get(t.task_id) ?? []) if (r.pred_type === 'PR_FF' || r.pred_type === 'PR_SF') badMs.push({ t, detail: `Start milestone ${t.task_code} has an ${r.pred_type.slice(3)} predecessor ${codeOf(r.pred_task_id)}.` });
      for (const r of ctx.succsOf.get(t.task_id) ?? []) if (r.pred_type === 'PR_FF' || r.pred_type === 'PR_FS') { if (r.pred_type === 'PR_FF') badMs.push({ t, detail: `Start milestone ${t.task_code} has an FF successor ${codeOf(r.task_id)}.` }); }
    }
    if (t.task_type === 'TT_FinMile') {
      for (const r of ctx.succsOf.get(t.task_id) ?? []) if (r.pred_type === 'PR_SS' || r.pred_type === 'PR_SF') badMs.push({ t, detail: `Finish milestone ${t.task_code} has an ${r.pred_type.slice(3)} successor ${codeOf(r.task_id)}.` });
      for (const r of ctx.predsOf.get(t.task_id) ?? []) if (r.pred_type === 'PR_SS') badMs.push({ t, detail: `Finish milestone ${t.task_code} has an SS predecessor ${codeOf(r.pred_task_id)}.` });
    }
  }

  // constraints not met by the scheduled dates (every type), and relationships the dates do not satisfy
  const unmet: { t: Row; detail: string }[] = [];
  const cals = calendarResolver(db, []), projs = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p]));
  const calOf = (t: Row) => cals.get(t.clndr_id) ?? cals.fallback(projs.get(t.proj_id)?.clndr_id);
  for (const t of tasks) {
    if (t.act_end_date) continue;
    const es = parseP6Date(t.act_start_date || t.restart_date || t.early_start_date), ef = parseP6Date(t.reend_date || t.early_end_date);
    for (const [ty, d] of [[t.cstr_type, t.cstr_date], [t.cstr_type2, t.cstr_date2]] as const) {
      const c = parseP6Date(d);
      if (!ty || c == null) continue;
      const cal = calOf(t), bad = constraintNotMet(cal, ty, c, START_TYPES.has(ty) && t.act_start_date ? null : es, ef);
      if (bad) { const onStart = START_TYPES.has(ty); unmet.push({ t, detail: `${t.task_code}: ${cstrName(ty)} ${formatP6Date(c).slice(0, 16)} is not met (scheduled ${formatP6Date((onStart ? es : ef)!).slice(0, 16)}).` }); }
    }
  }
  const unsatRel: { t: Row; detail: string }[] = [];
  const gone = new Set(leftOut.map((x) => x.task_pred_id)); // a link left out to break a loop is not in the schedule: it is not unmet
  for (const r of rows(db, 'TASKPRED')) {
    if (!open.has(r.proj_id) || gone.has(r.task_pred_id)) continue;
    const ff = relFF(r);
    const t = ctx.taskById.get(r.task_id), p = ctx.taskById.get(r.pred_task_id);
    if (ff != null && ff < 0 && t && p && !t.act_end_date) unsatRel.push({ t, detail: `${p.task_code} ${(r.pred_type || 'PR_FS').slice(3)} ${t.task_code} is not met by ${daysText(Math.abs(Math.round((ff / 60 / dh.rel(r)) * 100) / 100))}.` });
  }
  const external = tasks.filter((t) => t.external_early_start_date || t.external_late_end_date).map((t) => ({ t, detail: [t.external_early_start_date && `${t.task_code} has an external early start ${t.external_early_start_date.slice(0, 16)}.`, t.external_late_end_date && `${t.task_code} has an external late finish ${t.external_late_end_date.slice(0, 16)}.`].filter(Boolean).join(' ') }));
  const critical = tasks.filter((t) => !t.act_end_date && t.task_type !== 'TT_WBS' && isCritical(t, ctx)).map((t) => ({ t }));
  return {
    warnings: [sec('MILESTONE_REL', 'Milestones with invalid relationships', badMs)],
    exceptions: [
      sec('CRITICAL', 'Critical activities', critical),
      sec('CONSTRAINT_UNMET', 'Activities with unsatisfied constraints', unmet),
      sec('RELATIONSHIP_UNMET', 'Activities with unsatisfied relationships', unsatRel),
      sec('EXTERNAL_DATES', 'Activities with external dates', external),
    ],
  };
}

/** The whole log as data, from an F9 result. */
export function scheduleLogReport(db: Db, projIds: string[], res: Pick<ScheduleResult, 'findings' | 'stats' | 'broken'>, maxIds = 100): ScheduleLogReport {
  const out: ScheduleLogReport = { statistics: res.stats, errors: [], warnings: [], exceptions: [] };
  const byCode = (code: string) => res.findings.filter((f: Finding) => f.code === code);
  const names = new Map(rows(db, 'TASK').filter((t) => projIds.includes(t.proj_id)).map((t) => [t.task_code, t.task_name]));
  for (const [code, title, where] of FROM_F9) {
    const fs = byCode(code);
    if (!fs.length) continue;
    out[where].push({ code, title, count: fs.length, activities: (maxIds ? fs.slice(0, maxIds) : fs).map((f) => ({ id: f.key ?? '', name: names.get(f.key ?? '') ?? '', detail: f.message })) });
  }
  const ex = extraLogSections(db, projIds, maxIds, res.broken);
  out.warnings.push(...ex.warnings.filter((s) => s.count));
  out.exceptions.push(...ex.exceptions.filter((s) => s.count));
  return out;
}

/** The extra sections as text, appended to F9's Schedule Log in the desktop app. */
export function extraLogText(db: Db, projIds: string[]): string {
  const ex = extraLogSections(db, projIds, 0);
  const L: string[] = [];
  for (const [head, list] of [['Warnings', ex.warnings], ['Exceptions', ex.exceptions]] as const) {
    for (const s of list) {
      if (!s.count) continue;
      const title = `${head}: ${s.title} (${s.count})`;
      L.push(title, '-'.repeat(title.length));
      for (const a of s.activities) L.push(`  ${a.id}  ${a.name}${a.detail ? `  (${a.detail})` : ''}`);
      L.push('');
    }
  }
  return L.join('\r\n');
}

/** The links the run left out to break loops, in one sentence (a loop the run did not break is in the log's errors). */
export const loopLinksLeftOut = (links: string[], saves = true): string => `Left out of this schedule to break loops: ${links.join(', ')}${saves ? '; the saved logic is unchanged' : ''}.`;

/** The notes of a `schedule` answer: what the run left out or replaced (a data date, a calendar, links that closed a loop). The log holds what P6's schedule log says (out of sequence, actuals after the
 *  data date, constraints and relationships not met, negative float): none of that is said twice. */
export function scheduleNotes(res: Pick<ScheduleResult, 'findings'>, noDataDate = true, saves = true): string[] {
  const out: string[] = [];
  for (const f of res.findings) if ((noDataDate && f.code === 'NO_DATA_DATE') || f.code === 'SCHED_CAL_INVALID') out.push(f.message);
  const broken = res.findings.filter((f) => f.code === 'SCHED_LOOP_BROKEN');
  if (broken.length) out.push(loopLinksLeftOut(broken.map((f) => f.message), saves));
  return out;
}

/** compute_schedule has no log: its notes carry the schedule log's sentences in full, each once, then what the run left out or replaced. */
export function computeNotes(db: Db, pid: string, res: Pick<ScheduleResult, 'findings' | 'broken'>): string[] {
  const out: string[] = [];
  for (const f of res.findings) if (f.code === 'OUT_OF_SEQUENCE' || f.code === 'ACTUAL_AFTER_DD' || f.code === 'NEGATIVE_FLOAT') out.push(f.message);
  const ex = extraLogSections(db, [pid], 0, res.broken);
  for (const s of ex.exceptions) if (s.code === 'CONSTRAINT_UNMET' || s.code === 'RELATIONSHIP_UNMET') for (const a of s.activities) out.push(a.detail ?? '');
  return [...out, ...scheduleNotes(res, false, false)];
}

/** One note per Activity ID that two or more TASK rows of these projects carry (the scheduler and the counts take it once). `did`: what was done once ("scheduled", "counted"); at most LISTED sentences, then the cut. */
export function duplicateRowNotes(db: Db, projIds: string[], did: string): string[] {
  const seen = new Map<string, Row>(), dup = new Map<string, string>();
  for (const t of rows(db, 'TASK')) {
    if (!projIds.includes(t.proj_id)) continue;
    if (seen.has(t.task_id)) dup.set(t.task_id, t.task_code || t.task_id); else seen.set(t.task_id, t);
  }
  const ids = [...dup.values()];
  const shown = ids.slice(0, LISTED).map((id) => duplicateRow(id, did));
  return ids.length > LISTED ? [...shown, listCut(LISTED, ids.length)] : shown;
}

/** Projects that schedule from different data dates: the one sentence (the shared wording), by Project ID. */
export function differentDatesNote(own: Record<string, string | null>, used: string): string | null {
  const entries = Object.entries(own).filter(([, d]) => d != null).map(([proj, date]) => ({ proj, date: String(date).slice(0, 10) }));
  return new Set(entries.map((e) => e.date)).size > 1 ? differentDataDates(entries, used) : null;
}
