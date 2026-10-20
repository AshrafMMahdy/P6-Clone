// The full P6 schedule log as data: Errors, Warnings and Exceptions, each section with the activities it lists, plus
// the statistics. F9's own findings (loops, open ends, out of sequence, actuals after the data date, unmet constraints,
// negative float) are joined by the sections P6 also prints and F9 does not compute itself: milestones with invalid
// relationships, critical activities, unsatisfied constraints of every type, unsatisfied relationships, external dates.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import type { Finding } from '../findings.ts';
import { isCritical, makeCtx } from '../project/ctx.ts';
import { relationshipFloat, type ScheduleResult } from '../schedule/cpm.ts';

export interface LogSection { code: string; title: string; count: number; activities: { id: string; name: string; detail?: string }[] }
export interface ScheduleLogReport { statistics: ScheduleResult['stats']; errors: LogSection[]; warnings: LogSection[]; exceptions: LogSection[] }

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
  const relFF = relationshipFloat(db, ctx);
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
      if (bad) unmet.push({ t, detail: `${ty.slice(3)} ${formatP6Date(c).slice(0, 16)}` });
    }
  }
  const unsatRel: { t: Row; detail: string }[] = [];
  for (const r of rows(db, 'TASKPRED')) {
    if (!open.has(r.proj_id)) continue;
    const ff = relFF(r);
    const t = ctx.taskById.get(r.task_id), p = ctx.taskById.get(r.pred_task_id);
    if (ff != null && ff < 0 && t && p && !t.act_end_date) unsatRel.push({ t, detail: `${p.task_code} ${(r.pred_type || 'PR_FS').slice(3)} ${t.task_code}: ${Math.round(ff * 10) / 10} h relationship float` });
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
