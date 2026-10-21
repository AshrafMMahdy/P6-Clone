// Delay analysis. Windows (AACE 29R-03 MIP 3.3 contemporaneous, MIP 3.4 half-step): consecutive updates are compared,
// each window's slip is the change of the forecast completion (or a key milestone), and it is laid on the activities of
// the driving path at the window's start that lost time; half-step re-runs update n-1 with only update n's progress to
// split the slip into progress and revisions. Time impact analysis (AACE 52R-06): a fragnet is inserted in a copy and
// rescheduled at the same data date; the delay is impacted less unimpacted completion. All in working days on the
// first update's project calendar, so the windows add up to the total.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { applyOps } from '../project/ops.ts';
import { isCritical, makeCtx } from '../project/ctx.ts';
import { calendarResolver, relationshipFloat, scheduleProjects } from '../schedule/cpm.ts';
import { onScratch } from './batch.ts';
import { isLoe, isWbs, type Tick } from './common.ts';

export interface Update { name: string; db: Db; projId: string }

const r2 = (v: number) => Math.round(v * 100) / 100;
const finOf = (t: Row) => parseP6Date(t.act_end_date || t.early_end_date || t.target_end_date);
const tasksOf = (u: Update) => rows(u.db, 'TASK').filter((t) => t.proj_id === u.projId && !isWbs(t));
const dataDate = (u: Update) => { const p = rows(u.db, 'PROJECT').find((x) => x.proj_id === u.projId); return parseP6Date(p?.last_recalc_date || p?.plan_start_date) ?? null; };

/** Pair activities of two schedules: by Activity ID, then by a name unique on both sides. */
export function matchActivities(a: Row[], b: Row[]): Map<Row, Row> {
  const out = new Map<Row, Row>(), byCode = new Map(b.map((t) => [t.task_code, t])), used = new Set<Row>();
  for (const t of a) { const m = byCode.get(t.task_code); if (m) { out.set(t, m); used.add(m); } }
  const uniq = (list: Row[]) => { const n = new Map<string, Row | null>(); for (const t of list) { const k = t.task_name.trim().toLowerCase(); n.set(k, n.has(k) ? null : t); } return n; };
  const na = uniq(a.filter((t) => !out.has(t))), nb = uniq(b.filter((t) => !used.has(t)));
  for (const [k, t] of na) { const m = nb.get(k); if (t && m) out.set(t, m); }
  return out;
}

/** The finish being measured: the milestone (by Activity ID, then name) or the latest finish of the project. */
function finishActivity(u: Update, milestone?: string): Row | null {
  const T = tasksOf(u);
  if (milestone) return T.find((t) => t.task_code === milestone) ?? T.find((t) => t.task_name.trim().toLowerCase() === milestone.trim().toLowerCase()) ?? null;
  // the latest finish; on a tie, the activity nothing follows (the finish milestone after its last task)
  const hasSucc = new Set(rows(u.db, 'TASKPRED').map((r) => r.pred_task_id));
  let best: Row | null = null;
  for (const t of T) { const f = finOf(t); if (!isLoe(t) && f != null && (best == null || f > finOf(best)! || (f === finOf(best) && hasSucc.has(best.task_id) && !hasSucc.has(t.task_id)))) best = t; }
  return best;
}

/** A relationship's float for "does it drive": P6's relationship free float (on the predecessor's calendar), taken as 0
 *  also when there is no working time between the two dates on the successor's calendar (its non-work days hold it to
 *  that start, e.g. a holiday on the successor's calendar only). */
export function drivingFloat(d: Db, ctx: ReturnType<typeof makeCtx>): (r: Row) => number | null {
  const rf = relationshipFloat(d, ctx), cals = calendarResolver(d, []);
  return (r) => {
    const v = rf(r);
    if (v === 0 || v == null || Number(r.lag_hr_cnt || 0)) return v;
    const a = ctx.taskById.get(r.pred_task_id), b = ctx.taskById.get(r.task_id);
    if (!a || !b) return v;
    const from = parseP6Date(r.pred_type === 'PR_SS' || r.pred_type === 'PR_SF' ? a.act_start_date || a.early_start_date : a.act_end_date || a.early_end_date);
    const to = parseP6Date(r.pred_type === 'PR_FF' || r.pred_type === 'PR_SF' ? b.early_end_date : b.early_start_date);
    if (from == null || to == null) return v;
    const cal = cals.get(b.clndr_id) ?? cals.fallback(ctx.proj.get(b.proj_id)?.clndr_id);
    return Math.abs(cal.workBetween(from, to)) <= 1 ? 0 : v;
  };
}

/** Remaining activities that drive the finish at the update's data date: driving links walked back from it, in order. */
export function drivingPath(u: Update, end: Row): Row[] {
  const ctx = makeCtx(u.db, { hoursPerDay: 8 }), rf = drivingFloat(u.db, ctx);
  const preds = new Map<string, Row[]>();
  for (const r of rows(u.db, 'TASKPRED')) (preds.get(r.task_id) ?? preds.set(r.task_id, []).get(r.task_id)!).push(r);
  const seen = new Set<string>(), out: Row[] = [], stack = [end];
  while (stack.length) {
    const t = stack.pop()!;
    if (seen.has(t.task_id) || t.act_end_date) continue;
    seen.add(t.task_id); out.push(t);
    // LOE and WBS summary activities take their dates from the logic around them, so they never drive it
    for (const r of preds.get(t.task_id) ?? []) { const p = ctx.taskById.get(r.pred_task_id); if (p && p.proj_id === u.projId && !isLoe(p) && rf(r) === 0) stack.push(p); }
  }
  const st = (t: Row) => parseP6Date(t.act_start_date || t.early_start_date) ?? 0;
  return out.sort((x, y) => st(x) - st(y) || (finOf(x) ?? 0) - (finOf(y) ?? 0));
}

const predCodes = (u: Update, t: Row) => { const byId = new Map(tasksOf(u).map((x) => [x.task_id, x.task_code])); return rows(u.db, 'TASKPRED').filter((r) => r.task_id === t.task_id).map((r) => `${byId.get(r.pred_task_id)}:${r.pred_type}:${Number(r.lag_hr_cnt || 0)}`).sort().join(','); };

const PROGRESS = ['act_start_date', 'act_end_date', 'remain_drtn_hr_cnt', 'phys_complete_pct', 'status_code', 'restart_date', 'reend_date', 'suspend_date', 'resume_date', 'expect_end_date', 'act_work_qty', 'remain_work_qty'];

export async function windowsAnalysis(updates: Update[], o: { milestone?: string; method?: 'contemporaneous' | 'half_step'; hoursPerDay?: number; maxIds?: number; tick?: Tick } = {}) {
  const list = [...updates].sort((x, y) => (dataDate(x) ?? 0) - (dataDate(y) ?? 0));
  if (list.length < 2) return { ok: false as const, error: { code: 'bad_input', message: 'A windows analysis needs at least two updates.' } };
  const first = list[0], p0 = rows(first.db, 'PROJECT').find((p) => p.proj_id === first.projId);
  const cal = calendarResolver(first.db, []).fallback(p0?.clndr_id ?? '');
  const hpd = cal.hoursPerDay() || o.hoursPerDay || 8;
  const wd = (a: number | null, b: number | null) => (a == null || b == null ? null : r2(cal.workBetween(a, b) / 60 / hpd));
  const max = o.maxIds ?? 50;
  const windows = [];
  for (let i = 1; i < list.length; i++) {
    const A = list[i - 1], B = list[i];
    if (o.tick) await o.tick(i - 1, list.length - 1, `window ${i} of ${list.length - 1}`);
    const ea = finishActivity(A, o.milestone), eb = finishActivity(B, o.milestone);
    if (!ea || !eb) return { ok: false as const, error: { code: 'bad_input', message: `${o.milestone ? `Milestone "${o.milestone}"` : 'A finish'} is missing in ${!ea ? A.name : B.name}.` } };
    const fa = finOf(ea), fb = finOf(eb);
    const match = matchActivities(tasksOf(A), tasksOf(B));
    const path = drivingPath(A, ea);
    const lost = path.map((a) => {
      const b = match.get(a);
      if (!b) return { id: a.task_code, name: a.task_name, lost_days: null, causes: ['deleted'] };
      const days = wd(finOf(a), finOf(b));
      const causes: string[] = [];
      if (a.target_drtn_hr_cnt !== b.target_drtn_hr_cnt && !b.act_end_date) causes.push('duration revised');
      if (predCodes(A, a) !== predCodes(B, b)) causes.push('logic revised');
      const planStart = parseP6Date(a.act_start_date || a.early_start_date), ddB = dataDate(B);
      if (!a.act_start_date && planStart != null && ddB != null && planStart < ddB && (!b.act_start_date || (parseP6Date(b.act_start_date) ?? 0) > planStart)) causes.push('started late');
      if (!causes.length && (days ?? 0) > 0) causes.push('progressed slower than planned');
      return { id: a.task_code, name: a.task_name, ...(b.task_code !== a.task_code ? { now: b.task_code } : {}), lost_days: days, finish_from: a.act_end_date || a.early_end_date || null, finish_to: b.act_end_date || b.early_end_date || null, causes };
    }).filter((x) => x.lost_days == null || x.lost_days > 0).sort((x, y) => (y.lost_days ?? Infinity) - (x.lost_days ?? Infinity));
    const w: Record<string, unknown> = {
      window: i, from: A.name, to: B.name, data_date_from: fmt(dataDate(A)), data_date_to: fmt(dataDate(B)),
      finish_from: fmt(fa), finish_to: fmt(fb), slip_days: wd(fa, fb),
      driving_path: path.slice(0, max).map((t) => t.task_code), ...(path.length > max ? { driving_path_more: path.length - max } : {}),
      lost_time: lost.slice(0, max), added: (() => { const m = new Set(match.values()); return tasksOf(B).filter((t) => !m.has(t)).slice(0, max).map((t) => t.task_code); })(),
    };
    if (o.method === 'half_step') {
      // update n-1 with only update n's progress, rescheduled at update n's data date
      const back = new Map([...match].map(([a, b]) => [a.task_id, b]));
      const half = onScratch(A.db, (d) => {
        for (const t of rows(d, 'TASK')) { const b = t.proj_id === A.projId ? back.get(t.task_id) : undefined; if (b && (b.act_start_date || b.act_end_date)) for (const f of PROGRESS) if (f in b) t[f] = b[f]; }
        const r = scheduleProjects(d, [A.projId], { dataDate: dataDate(B) ?? undefined });
        const e = rows(d, 'TASK').find((t) => t.task_id === ea.task_id);
        return r.ok && e ? finOf(e) : null;
      });
      w.half_step = { finish: fmt(half), progress_days: wd(fa, half), revision_days: wd(half, fb) };
    }
    windows.push(w);
  }
  const fl = finishActivity(list.at(-1)!, o.milestone), ff = finishActivity(first, o.milestone);
  const total = wd(ff ? finOf(ff) : null, fl ? finOf(fl) : null);
  return {
    ok: true as const, method: o.method ?? 'contemporaneous', measured: o.milestone ? `milestone ${o.milestone}` : 'project completion', calendar_hours_per_day: hpd,
    updates: list.map((u) => ({ name: u.name, data_date: fmt(dataDate(u)) })), windows, total_slip_days: total,
    ...(o.method === 'half_step' ? { total_progress_days: r2(windows.reduce((s, w) => s + (((w.half_step as { progress_days: number | null }).progress_days) ?? 0), 0)), total_revision_days: r2(windows.reduce((s, w) => s + (((w.half_step as { revision_days: number | null }).revision_days) ?? 0), 0)) } : {}),
  };
}

const fmt = (v: number | null | undefined) => (v != null ? formatP6Date(v) : null);

/** Time impact analysis on a copy: unimpacted and impacted schedules at the same data date. */
export function timeImpact(db: Db, projIds: string[], fragnet: unknown[], o: { dataDate?: number; milestone?: string; hoursPerDay?: number; calendarDays?: boolean; baseline?: { name: string; finish: number | null; how?: string } } = {}) {
  const p0 = rows(db, 'PROJECT').find((p) => p.proj_id === projIds[0]);
  const cal = calendarResolver(db, []).fallback(p0?.clndr_id ?? '');
  const hpd = cal.hoursPerDay() || o.hoursPerDay || 8;
  const wd = (a: number | null, b: number | null) => (a == null || b == null ? null : r2(cal.workBetween(a, b) / 60 / hpd));
  const over = o.dataDate != null ? { dataDate: o.dataDate } : {};
  const measure = (d: Db) => {
    const u: Update = { name: '', db: d, projId: projIds[0] };
    const end = finishActivity(u, o.milestone);
    const ctx = makeCtx(d, { hoursPerDay: 8 });
    return { end, finish: end ? finOf(end) : null, critical: new Set(rows(d, 'TASK').filter((t) => projIds.includes(t.proj_id) && isCritical(t, ctx)).map((t) => t.task_code)) };
  };
  const un = onScratch(db, (d) => { const r = scheduleProjects(d, projIds, over); return r.ok ? { ok: true as const, ...measure(d) } : { ok: false as const, error: r.findings.find((f) => f.severity === 'error')?.message ?? 'The schedule failed.' }; });
  if (!un.ok) return { ok: false as const, error: { code: 'schedule_failed', message: `The unimpacted schedule failed: ${un.error}` } };
  if (o.milestone && !un.end) return { ok: false as const, error: { code: 'bad_input', message: `No activity "${o.milestone}".` } };
  // the fragnet's own activities (or, when it only changes existing ones, those it touches)
  const added = new Set<string>(), touched = new Set<string>();
  for (const op of fragnet as Record<string, unknown>[]) { if (op?.op === 'add_activity' && typeof op.id === 'string') added.add(op.id); for (const k of ['id', 'pred', 'succ', 'activity']) if (typeof op?.[k] === 'string') touched.add(op[k] as string); }
  const seeds = added.size ? added : touched;
  const im = onScratch(db, (d) => {
    // days in the ops: each activity's calendar (MCP, CLI) or the fixed hours per day (the desktop app), as the caller edits
    const a = applyOps(d, fragnet, { hoursPerDay: o.hoursPerDay ?? 8, calendarDays: o.calendarDays ?? true });
    if (!a.ok) return { ok: false as const, error: `operation ${a.error!.index + 1}: ${a.error!.message}` };
    const r = scheduleProjects(d, projIds, over);
    if (!r.ok) return { ok: false as const, error: r.findings.find((f) => f.severity === 'error')?.message ?? 'The impacted schedule failed.' };
    const m = measure(d);
    // the path the fragnet drives: its activities and what they drive, on the chain that drives the finish
    const onPath = m.end ? drivingPath({ name: '', db: d, projId: projIds[0] }, m.end) : [];
    const ids = new Set(onPath.map((t) => t.task_code));
    const ctx = makeCtx(d, { hoursPerDay: 8 }), rf = drivingFloat(d, ctx);
    const succ = new Map<string, Row[]>();
    for (const r2_ of rows(d, 'TASKPRED')) (succ.get(r2_.pred_task_id) ?? succ.set(r2_.pred_task_id, []).get(r2_.pred_task_id)!).push(r2_);
    const reach = new Set<string>(), stack = rows(d, 'TASK').filter((t) => projIds.includes(t.proj_id) && seeds.has(t.task_code));
    while (stack.length) { const t = stack.pop()!; if (reach.has(t.task_code)) continue; reach.add(t.task_code); for (const r of succ.get(t.task_id) ?? []) { const s = ctx.taskById.get(r.task_id); if (s && rf(r) === 0) stack.push(s); } }
    const path = onPath.filter((t) => reach.has(t.task_code)).map((t) => t.task_code);
    return { ok: true as const, ...m, path, drives: [...seeds].some((c) => ids.has(c)) };
  });
  if (!im.ok) return { ok: false as const, error: { code: 'bad_input', message: im.error } };
  return {
    ok: true as const, measured: o.milestone ? `milestone ${o.milestone}` : 'project completion', data_date: fmt(o.dataDate ?? dataDate({ name: '', db, projId: projIds[0] })),
    unimpacted_finish: fmt(un.finish), impacted_finish: fmt(im.finish), delay_days: wd(un.finish, im.finish),
    fragnet_on_critical_path: im.drives, fragnet_path: im.path,
    became_critical: [...im.critical].filter((c) => !un.critical.has(c)), no_longer_critical: [...un.critical].filter((c) => !im.critical.has(c)),
    ...(o.baseline ? { baseline: o.baseline.name, ...(o.baseline.how ? { baseline_how: o.baseline.how } : {}), baseline_finish: fmt(o.baseline.finish), variance_to_baseline_days: wd(o.baseline.finish, im.finish) } : {}),
  };
}
