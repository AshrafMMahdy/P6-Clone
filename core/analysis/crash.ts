// Least-cost crashing (Kelley-Walker, as taught and as planners do it by hand in P6 with Global Change): each step
// shortens the cheapest cut set, the activities that together shorten every critical path at once (a minimum cut of
// the critical network, so one shared activity competes with the sum of one activity per parallel path), by the
// smaller of their remaining crash capacity, the float of the next near-critical path and what is still needed.
// Durations are working days on each activity's own calendar; only remaining work is crashed. Runs on a copy.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { recordAsync, rollback } from '../journal.ts';
import { makeCtx } from '../project/ctx.ts';
import { dayHours } from '../project/units.ts';
import { calendarResolver, scheduleProjects } from '../schedule/cpm.ts';
import { fitAssignmentsToDuration } from '../resource/assign.ts';
import { drivingFloat } from './delay.ts';
import { isLoe, isMilestone, isWbs, type Tick } from './common.ts';

class ScheduleFailed extends Error {}

export interface CrashActivity { id: string; min_days?: number; cost_per_day?: number; crash_days?: number; crash_cost?: number }
export interface CrashOptions {
  targetFinish?: string; targetDays?: number;
  activities?: CrashActivity[];
  /** without an activities list every remaining critical activity may lose up to this share of its remaining duration, at an equal cost of 1 per day */
  defaultMaxPct?: number;
  indirectPerDay?: number; ldPerDay?: number; locked?: string[]; maxSteps?: number; hoursPerDay?: number; tick?: Tick;
}
export type CrashStop = 'SUCCESS' | 'PLATEAU' | 'EXHAUSTED' | 'CAP' | 'ALREADY_MET';
export interface CrashStep { step: number; activities: { id: string; days: number; cost: number }[]; days_gained: number; cost: number; finish: string | null; cumulative_direct_cost: number; total_cost: number }

const INF = 1e15, EPS = 1e-6;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Minimum cut by Dinic max flow; returns the nodes on the source side. */
function minCut(n: number, edges: [number, number, number][], s: number, t: number): { flow: number; side: Uint8Array } {
  const head = new Int32Array(n).fill(-1), to: number[] = [], cap: number[] = [], next: number[] = [];
  const add = (u: number, v: number, c: number) => { to.push(v); cap.push(c); next.push(head[u]); head[u] = to.length - 1; to.push(u); cap.push(0); next.push(head[v]); head[v] = to.length - 1; };
  for (const [u, v, c] of edges) add(u, v, c);
  let flow = 0;
  const level = new Int32Array(n), it = new Int32Array(n);
  const bfs = () => { level.fill(-1); level[s] = 0; const q = [s]; for (let i = 0; i < q.length; i++) for (let e = head[q[i]]; e >= 0; e = next[e]) if (cap[e] > EPS && level[to[e]] < 0) { level[to[e]] = level[q[i]] + 1; q.push(to[e]); } return level[t] >= 0; };
  // one augmenting path along the level graph, walked with an explicit stack (long driving chains are thousands of
  // nodes deep, too deep for recursion)
  const dfs = (): number => {
    const path: number[] = [];
    let u = s;
    for (;;) {
      if (u === t) {
        let f = INF;
        for (const e of path) f = Math.min(f, cap[e]);
        for (const e of path) { cap[e] -= f; cap[e ^ 1] += f; }
        return f;
      }
      let e = it[u];
      while (e >= 0 && !(cap[e] > EPS && level[to[e]] === level[u] + 1)) e = it[u] = next[e];
      if (e >= 0) { path.push(e); u = to[e]; continue; }
      level[u] = -1; // dead end
      if (!path.length) return 0;
      const back = path.pop()!;
      u = to[back ^ 1];
      it[u] = next[it[u]];
    }
  };
  while (bfs() && flow < INF) { for (let i = 0; i < n; i++) it[i] = head[i]; let f; while ((f = dfs()) > EPS) { flow += f; if (flow >= INF) break; } }
  const side = new Uint8Array(n), q = [s]; side[s] = 1;
  for (let i = 0; i < q.length; i++) for (let e = head[q[i]]; e >= 0; e = next[e]) if (cap[e] > EPS && !side[to[e]]) { side[to[e]] = 1; q.push(to[e]); }
  return { flow, side };
}

export async function crashSchedule(db: Db, projIds: string[], o: CrashOptions) {
  const hpd0 = o.hoursPerDay ?? 8, maxSteps = o.maxSteps ?? 100;
  const open = new Set(projIds);
  const p0 = rows(db, 'PROJECT').find((p) => p.proj_id === projIds[0]);
  const pcal = calendarResolver(db, []).fallback(p0?.clndr_id ?? '');
  const phpd = pcal.hoursPerDay() || hpd0;
  const days = (a: number, b: number) => pcal.workBetween(a, b) / 60 / phpd;
  const target = o.targetFinish ? parseP6Date(o.targetFinish) : null;
  if (o.targetFinish && target == null) return { ok: false as const, error: { code: 'bad_input', message: `target_finish "${o.targetFinish}" is not a date.` } };
  const locked = new Set(o.locked ?? []);
  const warnings: string[] = [];
  // liquidated damages run from a contract date: without target_finish there is nothing they are owed against
  const ld = target != null ? o.ldPerDay ?? 0 : 0;
  if (o.ldPerDay && target == null) warnings.push('ld_per_day needs target_finish (the date damages run from); ignored.');
  if (target == null && o.targetDays == null && !o.indirectPerDay) return { ok: false as const, error: { code: 'bad_input', message: 'Give target_finish or target_days, or indirect_cost_per_day to crash to the least total cost.' } };
  const given = new Map((o.activities ?? []).map((a) => [a.id, a]));
  const steps: CrashStep[] = [];
  let stop = 'SUCCESS' as CrashStop, note = '', baseFinish: number | null = null, finish: number | null = null;
  const changed = new Map<string, { task: Row; from: number; to: number; started: boolean }>();

  let j;
  try { j = await recordAsync(db, async (d) => {
    const dh = dayHours(d, hpd0, true);
    const sched = () => { const r = scheduleProjects(d, projIds, {}); if (!r.ok) throw new ScheduleFailed(r.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' ') || 'The schedule failed.'); return r.stats.finish; };
    const tasks = rows(d, 'TASK').filter((t) => open.has(t.proj_id));
    const byCode = new Map<string, Row>();
    for (const t of tasks) if (!byCode.has(t.task_code)) byCode.set(t.task_code, t);
    for (const id of given.keys()) if (!byCode.has(id)) warnings.push(`Activity ${id} is not in the open project(s); ignored.`);
    // crash limits in hours and cost per day, per task_id
    const limit = new Map<string, { minH: number; slope: number }>();
    const eligible = (t: Row) => !t.act_end_date && !isWbs(t) && !isLoe(t) && !isMilestone(t) && !locked.has(t.task_code);
    if (o.activities?.length) {
      for (const a of o.activities) {
        const t = byCode.get(a.id);
        if (!t || !eligible(t)) continue;
        const h = dh.task(t), rem = Number(t.remain_drtn_hr_cnt || 0);
        if (a.crash_days != null) {
          const gain = rem / h - a.crash_days;
          if (gain <= 0) { warnings.push(`${a.id}: crash_days ${a.crash_days} is not below the remaining ${r2(rem / h)} d; ignored.`); continue; }
          limit.set(t.task_id, { minH: a.crash_days * h, slope: (a.crash_cost ?? 0) / gain });
        } else limit.set(t.task_id, { minH: (a.min_days ?? 0) * h, slope: a.cost_per_day ?? 0 });
      }
    } else {
      const pct = Math.min(100, Math.max(0, o.defaultMaxPct ?? 30)) / 100;
      for (const t of tasks) if (eligible(t)) limit.set(t.task_id, { minH: Number(t.remain_drtn_hr_cnt || 0) * (1 - pct), slope: 1 });
      note = `No crash data given: every remaining activity may lose up to ${Math.round(pct * 100)}% of its remaining duration at an equal cost of 1 per day, so costs are crash-days.`;
    }
    const remH = (t: Row) => Number(t.remain_drtn_hr_cnt || 0);
    const capDays = (t: Row) => { const l = limit.get(t.task_id); return l ? Math.max(0, (remH(t) - l.minH) / dh.task(t)) : 0; };
    const setRem = (t: Row, h: number) => {
      const c = changed.get(t.task_id) ?? { task: t, from: remH(t), to: 0, started: !!t.act_start_date };
      t.remain_drtn_hr_cnt = String(r2(h));
      if (!t.act_start_date) t.target_drtn_hr_cnt = t.remain_drtn_hr_cnt;
      fitAssignmentsToDuration(d, t);
      c.to = Number(t.remain_drtn_hr_cnt); changed.set(t.task_id, c);
    };
    const needed = (f: number) => (target != null ? days(target, f) : (o.targetDays ?? Infinity) - days(f, baseFinish!));
    const late = (f: number) => (target != null ? Math.max(0, days(target, f)) : 0);
    const save = (o.indirectPerDay ?? 0) + ld;

    baseFinish = finish = sched();
    if (finish == null) throw new ScheduleFailed('The project has no finish date to crash.');
    if (needed(finish) <= EPS) { stop = 'ALREADY_MET'; return; }
    const preds = new Map<string, Row[]>();
    for (const r of rows(d, 'TASKPRED')) (preds.get(r.task_id) ?? preds.set(r.task_id, []).get(r.task_id)!).push(r);
    let direct = 0, stalls = 0, minStep = 0, grown = 0;
    const ineffective = new Set<string>();
    for (let n = 1; ; n++) {
      if (n > maxSteps) { stop = 'CAP'; break; }
      if (o.tick) await o.tick(n - 1, maxSteps, `step ${n}: ${r2(days(finish, baseFinish!))} working days gained`);
      const ctx = makeCtx(d, { hoursPerDay: hpd0 });
      const rf = drivingFloat(d, ctx);
      // the critical network: what drives the project finish, walked back along driving links (negative float from
      // constraints elsewhere does not move the finish, so it is not crashed)
      // LOE and WBS summary activities take their dates from the logic around them, so they never drive it
      const inNet = new Set<string>(), stack = tasks.filter((t) => !t.act_end_date && !isLoe(t) && !isWbs(t) && Math.abs((parseP6Date(t.early_end_date) ?? -Infinity) - finish!) <= 1).map((t) => t.task_id);
      while (stack.length) { const id = stack.pop()!; if (inNet.has(id)) continue; inNet.add(id); for (const r of preds.get(id) ?? []) { const a = ctx.taskById.get(r.pred_task_id); if (a && !a.act_end_date && !isLoe(a) && !isWbs(a) && open.has(a.proj_id) && rf(r) === 0) stack.push(a.task_id); } }
      const crit = tasks.filter((t) => inNet.has(t.task_id));
      const idx = new Map(crit.map((t, i) => [t.task_id, i]));
      const tfd = Math.min(...crit.map((t) => Number(t.total_float_hr_cnt || 0) / dh.task(t)));
      const N = crit.length * 2 + 2, S = N - 2, T = N - 1;
      const edges: [number, number, number][] = [];
      const hasIn = new Uint8Array(crit.length), hasOut = new Uint8Array(crit.length);
      for (const r of [...inNet].flatMap((id) => preds.get(id) ?? [])) {
        const a = idx.get(r.pred_task_id), b = idx.get(r.task_id);
        if (a == null || b == null || rf(r) !== 0) continue;
        const fromNode = r.pred_type === 'PR_SS' || r.pred_type === 'PR_SF' ? 2 * a : 2 * a + 1;
        const toNode = r.pred_type === 'PR_FF' || r.pred_type === 'PR_SF' ? 2 * b + 1 : 2 * b;
        edges.push([fromNode, toNode, INF]); hasOut[a] = 1; hasIn[b] = 1;
      }
      crit.forEach((t, i) => {
        const l = limit.get(t.task_id), c = capDays(t);
        edges.push([2 * i, 2 * i + 1, l && c > EPS && !ineffective.has(t.task_id) ? l.slope + EPS : INF]);
        edges.push([2 * i + 1, 2 * i, INF]); // a start set back from a driven finish (FF in, SS out) is on the path too, and crashing does not help it
        if (!hasIn[i]) edges.push([S, 2 * i, INF]);
        if (!hasOut[i]) edges.push([2 * i + 1, T, INF]);
      });
      const cut = minCut(N, edges, S, T);
      if (!crit.length || cut.flow >= INF) {
        if (ineffective.size) { stop = 'PLATEAU'; note = `Crashing the remaining cut sets did not move the finish (tried ${[...ineffective].slice(0, 5).map((id) => crit.find((t) => t.task_id === id)?.task_code ?? id).join(', ')}).`; break; }
        stop = 'EXHAUSTED';
        const stuck = crit.filter((t) => !(limit.has(t.task_id) && capDays(t) > EPS)).sort((a, b) => (b.early_end_date ?? '').localeCompare(a.early_end_date ?? '')).slice(0, 5).map((t) => t.task_code);
        note = `${note ? note + ' ' : ''}No path to the finish can be shortened further: it runs through ${stuck.join(', ')}${crit.length > 5 ? ' and others' : ''} (milestones, locked, without crash data or at their limit).`;
        break;
      }
      const acts = crit.filter((_, i) => cut.side[2 * i] && !cut.side[2 * i + 1]);
      const slope = acts.reduce((s, t) => s + limit.get(t.task_id)!.slope, 0);
      if (target == null && o.targetDays == null && slope >= save) { stop = 'SUCCESS'; note = `Least total cost reached: the next cut costs ${r2(slope)}/day, more than the ${r2(save)}/day it would save.`; break; }
      // the next near-critical path: the smallest float above the critical network's
      let near = Infinity;
      for (const t of tasks) {
        if (t.act_end_date || isWbs(t) || inNet.has(t.task_id) || t.total_float_hr_cnt === '' || t.total_float_hr_cnt == null) continue;
        const f = Number(t.total_float_hr_cnt) / dh.task(t) - tfd;
        if (f > EPS) near = Math.min(near, f);
      }
      const want = needed(finish);
      const room = Math.min(...acts.map(capDays));
      // whole days where the room allows. A step that does not move the finish (non-work days on a successor's
      // calendar swallow it) is retried larger, up to the room, before the cut is given up
      let step = Math.max(0.01, Math.min(want, near, room));
      if (step >= 1) step = Math.floor(step);
      if (minStep) step = Math.min(room, Math.max(step, minStep));
      const asg = rows(d, 'TASKRSRC').filter((a) => acts.some((t) => t.task_id === a.task_id));
      const before = new Map(acts.map((t) => [t.task_id, [t.remain_drtn_hr_cnt, t.target_drtn_hr_cnt] as const]));
      const beforeAsg = asg.map((a) => [a, a.remain_drtn_hr_cnt, a.target_drtn_hr_cnt, a.remain_qty_per_hr] as const);
      for (const t of acts) setRem(t, remH(t) - step * dh.task(t));
      const f = sched();
      const gained = f == null ? 0 : days(f, finish);
      if (gained <= 0.005) {
        // the cut did not move the finish (e.g. lags on other calendars): undo it and keep those activities out
        const again: boolean = room > step + 0.005 && grown < 4;
        for (const t of acts) { const [rm, tg] = before.get(t.task_id)!; t.remain_drtn_hr_cnt = rm; t.target_drtn_hr_cnt = tg; const c = changed.get(t.task_id)!; c.to = Number(rm); if (c.to === c.from) changed.delete(t.task_id); if (!again) ineffective.add(t.task_id); }
        for (const [a, rd, td, q] of beforeAsg) { a.remain_drtn_hr_cnt = rd; a.target_drtn_hr_cnt = td; a.remain_qty_per_hr = q; }
        if (again) { minStep = Math.min(room, Math.max(1, step * 2)); grown++; } else { minStep = 0; grown = 0; }
        sched();
        if (++stalls >= 5) { stop = 'PLATEAU'; note = 'Crashing the cheapest cut sets no longer moved the finish.'; break; }
        n--; continue;
      }
      stalls = 0; minStep = 0; grown = 0; ineffective.clear();
      const cost = acts.reduce((s, t) => s + limit.get(t.task_id)!.slope * step, 0);
      direct += cost; finish = f!;
      steps.push({
        step: n, activities: acts.map((t) => ({ id: t.task_code, days: r2(step), cost: r2(limit.get(t.task_id)!.slope * step) })), days_gained: r2(gained), cost: r2(cost),
        finish: formatP6Date(finish), cumulative_direct_cost: r2(direct),
        total_cost: r2(direct - (o.indirectPerDay ?? 0) * days(finish, baseFinish!) - ld * (late(baseFinish!) - late(finish))),
      });
      if (needed(finish) <= 0.005) { stop = 'SUCCESS'; break; }
      if (target == null && o.targetDays == null && steps.length >= 2 && steps.at(-1)!.total_cost > steps.at(-2)!.total_cost) { stop = 'PLATEAU'; note = 'Total cost started rising.'; break; }
    }
  }); } catch (e) { if (!(e instanceof ScheduleFailed)) throw e; return { ok: false as const, error: { code: 'schedule_failed', message: e.message } }; }
  rollback(j);
  const projCode = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name]));
  const ops = [...changed.values()].map((c) => ({ op: 'update_activity', id: c.task.task_code, project: projCode.get(c.task.proj_id), ...(c.started ? { remaining_hours: c.to } : { duration_hours: c.to }), assignments_follow: true }));
  return {
    ok: true as const, stop, ...(note ? { note } : {}),
    base_finish: baseFinish != null ? formatP6Date(baseFinish) : null, finish: finish != null ? formatP6Date(finish) : null,
    days_gained: baseFinish != null && finish != null ? r2(days(finish, baseFinish)) : 0,
    ...(target != null && finish != null ? { days_late: r2(Math.max(0, days(target, finish))) } : {}),
    direct_cost: steps.at(-1)?.cumulative_direct_cost ?? 0, total_cost: steps.at(-1)?.total_cost ?? 0,
    steps, changes: [...changed.values()].map((c) => ({ id: c.task.task_code, remaining_days_from: r2(c.from / (dayHours(db, hpd0, true).task(c.task))), remaining_days_to: r2(c.to / dayHours(db, hpd0, true).task(c.task)) })),
    ops, warnings,
  };
}
