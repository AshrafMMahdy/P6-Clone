// Schedule review: the checks a planning reviewer runs on a programme (thresholds follow the common DCMA 14-point
// guidance), plus whether the saved dates are the ones P6 would calculate. Each check passes, warns or fails.
import { dayHours } from '../project/units.ts';
import type { Db, Row } from '../db.ts';
import { rows } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { makeCtx, isCritical } from '../project/ctx.ts';
import { storedDatesState } from '../schedule/stored-dates.ts';
import { datesNotCurrent, NO_RESOURCE_ASSIGNED, notAssessed as notAssessedNote } from '../notes.ts';
import { differentDatesNote } from '../analysis/scheduleLog.ts';
import { constraintsOf, DCMA_HARD, dataDateAssumedNotes, dataDateGaps } from '../analysis/common.ts';

/** Out-of-sequence progress, the one rule: the activity has started while a finish-to-start predecessor has not finished. */
export const startedBeforeFsPredecessor = (t: Row, ctx: Pick<ReturnType<typeof makeCtx>, 'predsOf' | 'taskById'>): boolean =>
  !!t.act_start_date && (ctx.predsOf.get(t.task_id) ?? []).some((r) => { const p = ctx.taskById.get(r.pred_task_id); return r.pred_type === 'PR_FS' && !!p && !p.act_end_date; });

/** A check's grade; not_assessed: the file does not hold what the check needs (no data date, no resource assignments), said in its detail. The review's own grade is pass, warn or fail. */
export type Grade = 'pass' | 'warn' | 'fail' | 'not_assessed';
export interface Check { id: string; title: string; grade: Grade; count: number; of: number; percent: number | null; limit: string; /** a sentence about what was found, only where there is one */ detail?: string; examples: string[]; /** how many examples there are (examples shows the first 10 of a check's activities; saved_dates gives all) */ examples_total?: number;
  /** with opts.activities: every activity the check found, by Activity ID and name (an export) */ activities?: { id: string; name: string }[] }
export interface Review { grade: Exclude<Grade, 'not_assessed'>; projects: string[]; openActivities: number; relationships: number; checks: Check[] }

/** Every check lists every activity it found as `examples` (the answer of a tool cuts the list by the list rule); activities: also each check's activities by ID and name. */
export function reviewSchedule(db: Db, opts: { hoursPerDay?: number; projIds?: string[]; calendarDays?: boolean; activities?: boolean } = {}): Review {
  const hpd = opts.hoursPerDay ?? 8;
  const projs = rows(db, 'PROJECT').filter((p) => !p._baseline_of && (!opts.projIds?.length || opts.projIds.includes(p.proj_id)));
  const open = new Set(projs.map((p) => p.proj_id));
  const ctx = makeCtx(db, { hoursPerDay: hpd });
  const dh = dayHours(db, hpd, !!opts.calendarDays); // 44 working days (of each activity's own calendar with calendarDays)
  const tasks = rows(db, 'TASK').filter((t) => open.has(t.proj_id));
  const live = tasks.filter((t) => !t.act_end_date && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE');
  const P = rows(db, 'TASKPRED').filter((r) => open.has(r.proj_id) || open.has(r.pred_proj_id));
  const name = (t: Row) => `${t.task_code} ${t.task_name}`;
  const checks: Check[] = [];
  const add = (id: string, title: string, list: Row[] | number, of: number, warnAt: number | null, failAt: number | null, limit: string, detail: string, examples: string[] = [], notAssessed = false) => {
    const count = typeof list === 'number' ? list : list.length;
    const percent = of ? Math.round((1000 * count) / of) / 10 : null;
    const p = percent ?? 0;
    const grade: Grade = notAssessed ? 'not_assessed' : failAt != null && (failAt === 0 ? count > 0 : p > failAt) ? 'fail' : warnAt != null && (warnAt === 0 ? count > 0 : p > warnAt) ? 'warn' : 'pass';
    checks.push({ id, title, grade, count, of, percent, limit, ...(detail ? { detail } : {}), examples: (typeof list === 'number' ? examples : list.map(name)),
      ...(typeof list !== 'number' ? { examples_total: list.length } : examples.length ? { examples_total: examples.length } : {}),
      ...(opts.activities && typeof list !== 'number' ? { activities: list.map((t) => ({ id: t.task_code, name: t.task_name })) } : {}) });
  };
  // each project is judged against its own data date (as the scheduler does); a project with none is not judged on it
  const ddOf = new Map(projs.map((p) => [p.proj_id, parseP6Date(p.last_recalc_date)]));

  // a start milestone opening the network and a finish milestone closing it are expected open ends
  const noPred = live.filter((t) => t.task_type !== 'TT_Mile' && !(ctx.predsOf.get(t.task_id) ?? []).length);
  const noSucc = live.filter((t) => t.task_type !== 'TT_FinMile' && !(ctx.succsOf.get(t.task_id) ?? []).length);
  const missing = new Set([...noPred, ...noSucc]);
  add('logic', 'Missing logic (no predecessor or no successor)', [...missing], live.length, null, 5, 'at most 5%', `${noPred.length} without predecessors, ${noSucc.length} without successors.`);
  add('leads', 'Leads (negative lags)', P.filter((r) => Number(r.lag_hr_cnt) < 0).length, P.length, null, 0, 'none', '');
  add('lags', 'Positive lags', P.filter((r) => Number(r.lag_hr_cnt) > 0).length, P.length, 5, null, 'at most 5% of relationships', '');
  add('rel_types', 'Relationships other than finish-to-start', P.filter((r) => r.pred_type !== 'PR_FS').length, P.length, 10, null, 'at most 10%', '');
  const hard = live.filter((t) => constraintsOf(t).some((c) => DCMA_HARD.has(c))); // the DCMA set, the one definition (schedule_health counts the same)
  add('hard_constraints', 'Hard constraints (Start On, Start On or Before, Finish On, Finish On or Before, Mandatory Start, Mandatory Finish)', hard, live.length, null, 5, 'at most 5%', '');
  add('high_float', 'High total float (over 44 working days)', live.filter((t) => Number(t.total_float_hr_cnt) / dh.task(t) > 44), live.length, 5, null, 'at most 5%', '');
  add('negative_float', 'Negative total float', live.filter((t) => t.total_float_hr_cnt !== '' && Number(t.total_float_hr_cnt) < 0), live.length, null, 0, 'none', '');
  add('long_durations', 'Long remaining durations (over 44 working days)', live.filter((t) => t.task_type !== 'TT_Mile' && t.task_type !== 'TT_FinMile' && Number(t.remain_drtn_hr_cnt) / dh.task(t) > 44), live.length, 5, null, 'at most 5%', '');
  const invalid = tasks.filter((t) => { const dd = ddOf.get(t.proj_id); return dd != null && ((!t.act_start_date && t.early_start_date && (parseP6Date(t.early_start_date) ?? Infinity) < dd) || (t.act_start_date && (parseP6Date(t.act_start_date) ?? 0) > dd) || (t.act_end_date && (parseP6Date(t.act_end_date) ?? 0) > dd)); });
  // (no project has a data date: nothing was judged, so the check is not assessed, not passed; a data date the schedule put in from the planned start is said)
  const withDate = projs.filter((p) => ddOf.get(p.proj_id) != null);
  add('invalid_dates', 'Invalid dates (forecast before the data date, or actuals after it)', invalid, tasks.filter((t) => ddOf.get(t.proj_id) != null).length, null, 0, 'none', [...dataDateAssumedNotes(withDate), ...dataDateGaps(projs, 'invalid dates', null), ...(() => { const differ = differentDatesNote(Object.fromEntries(projs.map((p) => [p.proj_short_name, parseP6Date(p.last_recalc_date) != null ? p.last_recalc_date : null])), 'each project\u2019s own date'); return differ ? [differ] : []; })()].join(' '), [], !withDate.length);
  const withRsrc = new Set(rows(db, 'TASKRSRC').map((a) => a.task_id));
  const noRes = live.filter((t) => t.task_type !== 'TT_Mile' && t.task_type !== 'TT_FinMile' && !withRsrc.has(t.task_id));
  add('resources', 'Activities without resources', noRes, live.filter((t) => t.task_type !== 'TT_Mile' && t.task_type !== 'TT_FinMile').length, withRsrc.size ? 0 : null, null, 'all resourced (if the schedule is resource-loaded)', withRsrc.size ? '' : notAssessedNote('Activities without resources', NO_RESOURCE_ASSIGNED), [], !withRsrc.size);
  const oos = live.filter((t) => startedBeforeFsPredecessor(t, ctx));
  add('out_of_sequence', 'Started out of sequence', oos, live.filter((t) => t.act_start_date).length, 0, null, 'none', '');
  const crit = live.filter((t) => isCritical(t, ctx));
  add('critical', 'Critical activities', crit, live.length, null, null, 'informational', '');
  const { stale } = storedDatesState(db, [...open]);
  add('saved_dates', 'Saved dates P6 would change on F9', stale.reduce((a, x) => a + x.differ, 0), live.length, 0, null, 'none', stale.map((x) => datesNotCurrent(x.proj, x.differ, x.open, true)).join(' '), stale.flatMap((x) => x.examples.map((f) => f.message)));

  const grade = checks.some((c) => c.grade === 'fail') ? 'fail' as const : checks.some((c) => c.grade === 'warn') ? 'warn' as const : 'pass' as const;
  return { grade, projects: projs.map((p) => p.proj_short_name), openActivities: live.length, relationships: P.length, checks };
}

export function reviewText(r: Review): string {
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', not_assessed: 'N/A ' } as const;
  const out = [`Schedule review: ${r.projects.join(', ')} (${r.openActivities} open activities, ${r.relationships} relationships)`, ''];
  for (const c of r.checks) {
    out.push(`${mark[c.grade]}  ${c.title}: ${c.count}${c.percent != null && c.of ? ` of ${c.of} (${c.percent}%)` : ''}  [limit: ${c.limit}]`);
    if (c.grade !== 'pass') { if (c.detail) out.push(`      ${c.detail}`); if (c.grade !== 'not_assessed') for (const e of c.examples.slice(0, 5)) out.push(`      - ${e}`); }
  }
  out.push('', `Overall: ${mark[r.grade]}`);
  return out.join('\n');
}
