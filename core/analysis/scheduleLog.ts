// The full P6 schedule log as data: Errors, Warnings and Exceptions, each section with the activities it lists, plus
// the statistics. F9's own findings (loops, open ends, out of sequence, actuals after the data date, unmet constraints,
// negative float) are joined by the sections P6 also prints and F9 does not compute itself: milestones with invalid
// relationships, critical activities, unsatisfied constraints of every type, unsatisfied relationships, external dates.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import type { Finding } from '../findings.ts';
import { isCritical, makeCtx } from '../project/ctx.ts';
import { relationshipFloat, type ScheduleResult } from '../schedule/cpm.ts';
import { dayHours } from '../project/units.ts';
import { cstrName, daysText, plural } from '../notes.ts';

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
export function extraLogSections(db: Db, projIds: string[], maxIds = 100): { warnings: LogSection[]; exceptions: LogSection[] } {
  const open = new Set(projIds);
  const tasks = rows(db, 'TASK').filter((t) => open.has(t.proj_id));
  const ctx = makeCtx(db, { hoursPerDay: 8 });
  const relFF = relationshipFloat(db, ctx), dh = dayHours(db, 8, true);
  const sec = (code: string, title: string, list: { t: Row; detail?: string }[]): LogSection => ({ code, title, count: list.length, activities: (maxIds ? list.slice(0, maxIds) : list).map((x) => ({ id: x.t.task_code, name: x.t.task_name, ...(x.detail ? { detail: x.detail } : {}) })) });

  // a start milestone has no finish and a finish milestone no start: links that use them are invalid in P6
  const badMs: { t: Row; detail: string }[] = [];
  for (const t of tasks) {
    if (t.task_type === 'TT_Mile') {
      for (const r of ctx.predsOf.get(t.task_id) ?? []) if (r.pred_type === 'PR_FF' || r.pred_type === 'PR_SF') badMs.push({ t, detail: `start milestone with a ${r.pred_type.slice(3)} predecessor` });
      for (const r of ctx.succsOf.get(t.task_id) ?? []) if (r.pred_type === 'PR_FF' || r.pred_type === 'PR_FS') { if (r.pred_type === 'PR_FF') badMs.push({ t, detail: 'start milestone driving an FF successor' }); }
    }
    if (t.task_type === 'TT_FinMile') {
      for (const r of ctx.succsOf.get(t.task_id) ?? []) if (r.pred_type === 'PR_SS' || r.pred_type === 'PR_SF') badMs.push({ t, detail: `finish milestone driving an ${r.pred_type.slice(3)} successor` });
      for (const r of ctx.predsOf.get(t.task_id) ?? []) if (r.pred_type === 'PR_SS') badMs.push({ t, detail: 'finish milestone with an SS predecessor' });
    }
  }

  // constraints not met by the scheduled dates (every type), and relationships the dates do not satisfy
  const unmet: { t: Row; detail: string }[] = [];
  for (const t of tasks) {
    if (t.act_end_date) continue;
    const es = parseP6Date(t.act_start_date || t.restart_date || t.early_start_date), ef = parseP6Date(t.reend_date || t.early_end_date);
    for (const [ty, d] of [[t.cstr_type, t.cstr_date], [t.cstr_type2, t.cstr_date2]] as const) {
      const c = parseP6Date(d);
      if (!ty || c == null) continue;
      const bad = (ty === 'CS_MSO' || ty === 'CS_MANDSTART') ? es != null && es !== c && !t.act_start_date
        : ty === 'CS_MSOB' ? es != null && es > c && !t.act_start_date
        : ty === 'CS_MSOA' ? es != null && es < c && !t.act_start_date
        : (ty === 'CS_MEO' || ty === 'CS_MANDFIN') ? ef != null && ef !== c
        : ty === 'CS_MEOB' ? ef != null && ef > c
        : ty === 'CS_MEOA' ? ef != null && ef < c : false;
      if (bad) { const onStart = START_TYPES.has(ty); unmet.push({ t, detail: `${cstrName(ty)} ${formatP6Date(c).slice(0, 16)}, scheduled ${onStart ? 'start' : 'finish'} ${formatP6Date((onStart ? es : ef)!).slice(0, 16)}` }); }
    }
  }
  const unsatRel: { t: Row; detail: string }[] = [];
  for (const r of rows(db, 'TASKPRED')) {
    if (!open.has(r.proj_id)) continue;
    const ff = relFF(r);
    const t = ctx.taskById.get(r.task_id), p = ctx.taskById.get(r.pred_task_id);
    if (ff != null && ff < 0 && t && p && !t.act_end_date) unsatRel.push({ t, detail: `${p.task_code} ${(r.pred_type || 'PR_FS').slice(3)} ${t.task_code}: relationship float ${daysText(Math.round((ff / 60 / dh.rel(r)) * 100) / 100)}` });
  }
  const external = tasks.filter((t) => t.external_early_start_date || t.external_late_end_date).map((t) => ({ t, detail: [t.external_early_start_date && `external early start ${t.external_early_start_date.slice(0, 16)}`, t.external_late_end_date && `external late finish ${t.external_late_end_date.slice(0, 16)}`].filter(Boolean).join(', ') }));
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
export function scheduleLogReport(db: Db, projIds: string[], res: Pick<ScheduleResult, 'findings' | 'stats'>, maxIds = 100): ScheduleLogReport {
  const out: ScheduleLogReport = { statistics: res.stats, errors: [], warnings: [], exceptions: [] };
  const byCode = (code: string) => res.findings.filter((f: Finding) => f.code === code);
  const names = new Map(rows(db, 'TASK').filter((t) => projIds.includes(t.proj_id)).map((t) => [t.task_code, t.task_name]));
  for (const [code, title, where] of FROM_F9) {
    const fs = byCode(code);
    if (!fs.length) continue;
    out[where].push({ code, title, count: fs.length, activities: (maxIds ? fs.slice(0, maxIds) : fs).map((f) => ({ id: f.key ?? '', name: names.get(f.key ?? '') ?? '', detail: f.message })) });
  }
  const ex = extraLogSections(db, projIds, maxIds);
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

/** The warnings of an `schedule` answer: one sentence for each kind of thing that is wrong, with its count, where the list of activities is (the log: the one home of every
 *  list) and the next call, so no fact is said twice. `withLog` false (the caller left the log out): the sentence says the list is left out. */
export function scheduleWarnings(res: Pick<ScheduleResult, 'findings'>, report: ScheduleLogReport, withLog: boolean): string[] {
  const out: string[] = [];
  const at = (area: 'warnings' | 'exceptions', code: string) => (withLog ? `log.${area} (${code})` : 'the log (left out by log: false)');
  for (const f of res.findings) if (f.code === 'NO_DATA_DATE') out.push(f.message.replace(/\.$/, '; give data_date to set one.'));
  for (const f of res.findings) if (f.code === 'SCHED_CAL_INVALID') out.push(f.message);
  const n = (area: 'warnings' | 'exceptions', code: string) => report[area].find((s) => s.code === code)?.count ?? 0;
  let k = n('warnings', 'OUT_OF_SEQUENCE');
  if (k) out.push(`${plural(k, 'relationship')} out of sequence (an activity started before its predecessor finished), listed in ${at('warnings', 'OUT_OF_SEQUENCE')}. Choose how the schedule treats them with options {logic: retained | override | actual}.`);
  k = n('warnings', 'ACTUAL_AFTER_DD');
  if (k) out.push(`${plural(k, 'activity', 'activities')} ${k === 1 ? 'has' : 'have'} an actual date after the data date, listed in ${at('warnings', 'ACTUAL_AFTER_DD')}: give a later data date (data_date) or correct the actuals (edit update_activity).`);
  k = n('exceptions', 'CONSTRAINT_UNMET');
  if (k) out.push(`${plural(k, 'activity', 'activities')} ${k === 1 ? 'has' : 'have'} a constraint the scheduled dates do not meet, listed with the scheduled date in ${at('exceptions', 'CONSTRAINT_UNMET')}: change or remove the constraint with edit update_activity.`);
  k = n('exceptions', 'RELATIONSHIP_UNMET');
  if (k) out.push(`${plural(k, 'relationship')} ${k === 1 ? 'is' : 'are'} not met by the scheduled dates, listed in ${at('exceptions', 'RELATIONSHIP_UNMET')}: a mandatory constraint or an actual date overrides the logic; change it with edit update_activity.`);
  k = n('exceptions', 'NEGATIVE_FLOAT');
  if (k) out.push(`${plural(k, 'activity', 'activities')} ${k === 1 ? 'has' : 'have'} negative total float, listed in ${at('exceptions', 'NEGATIVE_FLOAT')}: the dates cannot meet a constraint or the project's must-finish-by date; critical_path shows what drives them.`);
  const broken = res.findings.filter((f) => f.code === 'SCHED_LOOP_BROKEN').length;
  if (broken) out.push(`${plural(broken, 'relationship')} that closed a loop ${broken === 1 ? 'was' : 'were'} left out of this run (broken_links names them): remove them for good with edit delete_relationship.`);
  return out;
}

/** Every warning of a computed schedule (compute_schedule has no log): one sentence for each activity or relationship, in the order of the kinds above. */
export function computeWarnings(db: Db, pid: string, res: Pick<ScheduleResult, 'findings'>, mustFinishBy: number | null, finish: number | null): string[] {
  const out: string[] = [];
  for (const f of res.findings) if (f.code === 'SCHED_CAL_INVALID' || f.code === 'OUT_OF_SEQUENCE' || f.code === 'ACTUAL_AFTER_DD' || f.code === 'NEGATIVE_FLOAT') out.push(f.message);
  const ex = extraLogSections(db, [pid], 0);
  for (const s of ex.exceptions) if (s.code === 'CONSTRAINT_UNMET' || s.code === 'RELATIONSHIP_UNMET') for (const a of s.activities) out.push(s.code === 'CONSTRAINT_UNMET' ? `${a.id} does not meet its constraint: ${a.detail}.` : `${a.id}: the relationship ${a.detail} is not met by the dates.`);
  if (mustFinishBy != null && finish != null && finish > mustFinishBy) out.push(`The project finishes ${formatP6Date(finish).slice(0, 16)}, after its must-finish-by date ${formatP6Date(mustFinishBy).slice(0, 16)}.`);
  const broken = res.findings.filter((f) => f.code === 'SCHED_LOOP_BROKEN').length;
  if (broken) out.push(`${plural(broken, 'relationship')} that closed a loop ${broken === 1 ? 'was' : 'were'} left out of this run (broken_links names them): remove ${broken === 1 ? 'it' : 'them'} for good by changing the activity's predecessors.`);
  return out;
}
