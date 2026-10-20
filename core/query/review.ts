// Schedule review: the checks a planning reviewer runs on a programme (thresholds follow the common DCMA 14-point
// guidance), plus whether the saved dates are the ones P6 would calculate. Each check passes, warns or fails.
import { dayHours } from '../project/units.ts';
import type { Db, Row } from '../db.ts';
import { rows } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { makeCtx, isCritical } from '../project/ctx.ts';
import { checkStoredDates } from '../schedule/stored-dates.ts';

export type Grade = 'pass' | 'warn' | 'fail';
export interface Check { id: string; title: string; grade: Grade; count: number; of: number; percent: number | null; limit: string; detail: string; examples: string[] }
export interface Review { grade: Grade; projects: string[]; openActivities: number; relationships: number; checks: Check[] }

export function reviewSchedule(db: Db, opts: { hoursPerDay?: number; projIds?: string[]; calendarDays?: boolean } = {}): Review {
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
  const add = (id: string, title: string, list: Row[] | number, of: number, warnAt: number | null, failAt: number | null, limit: string, detail: string, examples: string[] = []) => {
    const count = typeof list === 'number' ? list : list.length;
    const percent = of ? Math.round((1000 * count) / of) / 10 : null;
    const p = percent ?? 0;
    const grade: Grade = failAt != null && (failAt === 0 ? count > 0 : p > failAt) ? 'fail' : warnAt != null && (warnAt === 0 ? count > 0 : p > warnAt) ? 'warn' : 'pass';
    checks.push({ id, title, grade, count, of, percent, limit, detail, examples: (typeof list === 'number' ? examples : list.slice(0, 10).map(name)) });
  };
  const dd = parseP6Date(projs.map((p) => p.last_recalc_date).find(Boolean));

  // a start milestone opening the network and a finish milestone closing it are expected open ends
  const noPred = live.filter((t) => t.task_type !== 'TT_Mile' && !(ctx.predsOf.get(t.task_id) ?? []).length);
  const noSucc = live.filter((t) => t.task_type !== 'TT_FinMile' && !(ctx.succsOf.get(t.task_id) ?? []).length);
  const missing = new Set([...noPred, ...noSucc]);
  add('logic', 'Missing logic (no predecessor or no successor)', [...missing], live.length, null, 5, 'at most 5%', `${noPred.length} without predecessors, ${noSucc.length} without successors (start milestones without predecessors and finish milestones without successors are not counted).`);
  add('leads', 'Leads (negative lags)', P.filter((r) => Number(r.lag_hr_cnt) < 0).length, P.length, null, 0, 'none', 'Negative lags hide logic; model the overlap with SS/FF relationships instead.');
  add('lags', 'Positive lags', P.filter((r) => Number(r.lag_hr_cnt) > 0).length, P.length, 5, null, 'at most 5% of relationships', 'Lags are not visible as work; long lags often stand in for missing activities.');
  add('rel_types', 'Relationships other than finish-to-start', P.filter((r) => r.pred_type !== 'PR_FS').length, P.length, 10, null, 'at most 10%', 'Mostly FS logic keeps the critical path readable.');
  const hard = live.filter((t) => /^(CS_MSO|CS_MEO|CS_MANDSTART|CS_MANDFIN)$/.test(t.cstr_type ?? '') || /^(CS_MANDSTART|CS_MANDFIN)$/.test(t.cstr_type2 ?? ''));
  add('hard_constraints', 'Hard constraints (Start On, Finish On, Mandatory)', hard, live.length, null, 5, 'at most 5%', 'Hard constraints override logic and can create negative float.');
  add('high_float', 'High total float (over 44 working days)', live.filter((t) => Number(t.total_float_hr_cnt) / dh.task(t) > 44), live.length, 5, null, 'at most 5%', 'Usually a sign of missing successors.');
  add('negative_float', 'Negative total float', live.filter((t) => t.total_float_hr_cnt !== '' && Number(t.total_float_hr_cnt) < 0), live.length, null, 0, 'none', 'The plan cannot meet a constraint or the must-finish date.');
  add('long_durations', 'Long remaining durations (over 44 working days)', live.filter((t) => t.task_type !== 'TT_Mile' && t.task_type !== 'TT_FinMile' && Number(t.remain_drtn_hr_cnt) / dh.task(t) > 44), live.length, 5, null, 'at most 5%', 'Break long activities down so progress can be measured.');
  const invalid = dd == null ? [] : tasks.filter((t) => (!t.act_start_date && t.early_start_date && (parseP6Date(t.early_start_date) ?? Infinity) < dd) || (t.act_start_date && (parseP6Date(t.act_start_date) ?? 0) > dd) || (t.act_end_date && (parseP6Date(t.act_end_date) ?? 0) > dd));
  add('invalid_dates', 'Invalid dates (forecast before the data date, or actuals after it)', invalid, tasks.length, null, 0, 'none', dd == null ? 'The project has no data date.' : 'Work not done yet must be planned after the data date; actuals must be on or before it.');
  const withRsrc = new Set(rows(db, 'TASKRSRC').map((a) => a.task_id));
  const noRes = live.filter((t) => t.task_type !== 'TT_Mile' && t.task_type !== 'TT_FinMile' && !withRsrc.has(t.task_id));
  add('resources', 'Activities without resources', noRes, live.filter((t) => t.task_type !== 'TT_Mile' && t.task_type !== 'TT_FinMile').length, withRsrc.size ? 0 : null, null, 'all resourced (if the schedule is resource-loaded)', withRsrc.size ? 'The schedule is resource-loaded, but these activities have no resources.' : 'The schedule is not resource-loaded (informational).');
  const oos = live.filter((t) => t.act_start_date && (ctx.predsOf.get(t.task_id) ?? []).some((r) => { const p = ctx.taskById.get(r.pred_task_id); return r.pred_type === 'PR_FS' && p && !p.act_end_date; }));
  add('out_of_sequence', 'Started out of sequence', oos, live.filter((t) => t.act_start_date).length, 0, null, 'none', 'Started before a finish-to-start predecessor finished.');
  const crit = live.filter((t) => isCritical(t, ctx));
  add('critical', 'Critical activities', crit.length, live.length, null, null, 'informational', `${crit.length} critical of ${live.length} open activities.`, crit.slice(0, 10).map(name));
  const dates = checkStoredDates(db);
  const head = dates.find((f) => f.code === 'DATES_NOT_CURRENT');
  const n = head ? Number(/^(\d+) of/.exec(head.message)?.[1] ?? 0) : 0;
  add('saved_dates', 'Saved dates P6 would change on F9', n, live.length, 0, null, 'none', head ? head.message : 'The saved dates are the ones P6 calculates from this file.', dates.filter((f) => f.code === 'DATE_NOT_CURRENT').map((f) => f.message));

  const grade: Grade = checks.some((c) => c.grade === 'fail') ? 'fail' : checks.some((c) => c.grade === 'warn') ? 'warn' : 'pass';
  return { grade, projects: projs.map((p) => p.proj_short_name), openActivities: live.length, relationships: P.length, checks };
}

export function reviewText(r: Review): string {
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
  const out = [`Schedule review: ${r.projects.join(', ')} (${r.openActivities} open activities, ${r.relationships} relationships)`, ''];
  for (const c of r.checks) {
    out.push(`${mark[c.grade]}  ${c.title}: ${c.count}${c.percent != null && c.of ? ` of ${c.of} (${c.percent}%)` : ''}  [limit: ${c.limit}]`);
    if (c.grade !== 'pass') { out.push(`      ${c.detail}`); for (const e of c.examples.slice(0, 5)) out.push(`      - ${e}`); }
  }
  out.push('', `Overall: ${mark[r.grade]}`);
  return out.join('\n');
}
