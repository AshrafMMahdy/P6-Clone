// Tools > Level Resources: serial leveling like P6's leveler.
// Activities are placed in priority order once all predecessors are placed; an activity is delayed day by day
// until every leveled resource has capacity (max units/time) for its remaining work.
import { addField, rows, table, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date, MIN_PER_DAY } from '../dates.ts';
import type { Finding } from '../findings.ts';
import { calendarResolver, p6num } from '../schedule/cpm.ts';
import type { WorkCalendar } from '../calendar/calendar.ts';

export interface LevelOptions {
  /** Only delay within total float. */
  withinFloat?: boolean;
  /** Allowed overallocation in percent. */
  overAllocPct?: number;
  /** Order activities by: early start (default), total float, or priority. */
  priority?: 'es' | 'tf' | 'priority';
  /** Level only these resources (default: resources with level_flag != 'N'). */
  rsrcIds?: string[];
  /** These activities (task ids) are placed first, in this order, ahead of the priority rule. */
  first?: string[];
}
/** moved: activities leveling delayed (early start before and after, finish after); peaks: per leveled resource, the
 *  highest use in a day after leveling (unit-hours) against its limit (Max Units/Time x 8 h x the allowed overallocation). */
export interface LevelResult { log: string; delayed: number; findings: Finding[]; moved: { taskId: string; code: string; from: string; start: string; finish: string }[]; peaks: { rsrcId: string; code: string; peak: number; limit: number; day: string; overallocated: boolean }[] }

const PRIO: Record<string, number> = { PT_Top: 0, PT_High: 1, PT_Normal: 2, PT_Low: 3, PT_Lowest: 4 };
const HORIZON_DAYS = 366 * 10;

export function levelResources(db: Db, projIds: string[], opts: LevelOptions): LevelResult {
  const findings: Finding[] = [];
  const cals = calendarResolver(db, findings);
  const projects = new Map(rows(db, 'PROJECT').filter((p) => projIds.includes(p.proj_id)).map((p) => [p.proj_id, p]));
  const tasks = rows(db, 'TASK').filter((t) => projects.has(t.proj_id));
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const tol = 1 + (opts.overAllocPct ?? 0) / 100;

  // capacity per resource (units per hour)
  const rsrcs = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r]));
  // Max Units/Time: from the resource's price/unit rows (or the resource). A resource with no limit defined cannot be
  // overallocated, so it is not leveled (it is listed in the report) rather than given an invented limit.
  const cap = new Map<string, number>();
  for (const r of rsrcs.values()) if (Number(r.max_qty_per_hr) > 0) cap.set(r.rsrc_id, Number(r.max_qty_per_hr));
  for (const rate of rows(db, 'RSRCRATE')) if (Number(rate.max_qty_per_hr) > 0) cap.set(rate.rsrc_id, Number(rate.max_qty_per_hr));
  const noLimit = new Set<string>();
  const leveled = (id: string) => {
    const want = opts.rsrcIds ? opts.rsrcIds.includes(id) : rsrcs.get(id)?.level_flag !== 'N' && rsrcs.get(id)?.rsrc_type !== 'RT_Mat';
    if (want && !cap.has(id)) { noLimit.add(id); return false; }
    return want;
  };

  const assigns = new Map<string, Row[]>();
  for (const a of rows(db, 'TASKRSRC')) if (byId.has(a.task_id) && leveled(a.rsrc_id)) { if (!assigns.has(a.task_id)) assigns.set(a.task_id, []); assigns.get(a.task_id)!.push(a); }

  const calOf = (t: Row): WorkCalendar => cals.get(t.clndr_id) ?? cals.fallback(projects.get(t.proj_id)?.clndr_id);
  const preds = new Map<string, Row[]>();
  for (const r of rows(db, 'TASKPRED')) if (byId.has(r.task_id) && byId.has(r.pred_task_id)) { if (!preds.has(r.task_id)) preds.set(r.task_id, []); preds.get(r.task_id)!.push(r); }

  // usage[rsrc][day] = hours of unit-demand
  const usage = new Map<string, Map<number, number>>();
  const use = (rid: string) => { let u = usage.get(rid); if (!u) usage.set(rid, (u = new Map())); return u; };
  const demand = (t: Row, a: Row, s: number, f: number): Map<number, number> => {
    const cal = calOf(t);
    const out = new Map<number, number>();
    const rate = Number(a.remain_qty_per_hr || a.target_qty_per_hr || 0) || (Number(t.remain_drtn_hr_cnt) ? Number(a.remain_qty || 0) / Number(t.remain_drtn_hr_cnt) : 0);
    for (let d = Math.floor(s / MIN_PER_DAY); d * MIN_PER_DAY < f; d++) {
      const h = cal.workBetween(Math.max(s, d * MIN_PER_DAY), Math.min(f, (d + 1) * MIN_PER_DAY)) / 60;
      if (h > 0) out.set(d, h * rate);
    }
    return out;
  };
  const capOn = (rid: string, day: number, cal: WorkCalendar) => {
    const hrs = cal.shiftsOn(day).reduce((x, s) => x + s.end - s.start, 0) / 60;
    return cap.get(rid)! * hrs * tol;
  };

  // fixed load: completed and in-progress activities stay where they are
  const placed = new Map<string, { s: number; f: number }>();
  for (const t of tasks) {
    if (t.act_end_date) { placed.set(t.task_id, { s: parseP6Date(t.act_start_date)!, f: parseP6Date(t.act_end_date)! }); continue; }
    if (t.act_start_date) {
      const s = parseP6Date(t.restart_date || t.early_start_date)!, f = parseP6Date(t.reend_date || t.early_end_date)!;
      placed.set(t.task_id, { s: parseP6Date(t.act_start_date)!, f });
      for (const a of assigns.get(t.task_id) ?? []) for (const [d, h] of demand(t, a, s, f)) use(a.rsrc_id).set(d, (use(a.rsrc_id).get(d) ?? 0) + h);
    }
  }

  const pending = tasks.filter((t) => !placed.has(t.task_id) && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE');
  const firstAt = new Map((opts.first ?? []).map((id, i) => [id, i]));
  const order = (t: Row) => {
    const es = parseP6Date(t.early_start_date) ?? 0;
    if (firstAt.has(t.task_id)) return [-1e15 + firstAt.get(t.task_id)!, es];
    if (opts.priority === 'tf') return [Number(t.total_float_hr_cnt || 0), es];
    if (opts.priority === 'priority') return [PRIO[t.priority_type] ?? 2, es];
    return [es, Number(t.total_float_hr_cnt || 0)];
  };
  const log: string[] = [];
  let delayed = 0;
  const moved = new Set<string>(); // activities leveling delayed
  const movedList: LevelResult['moved'] = [];
  // ready queue: an activity becomes ready when all its (non-LOE) predecessors are placed; the highest priority goes first
  const remaining = new Set(pending.map((t) => t.task_id));
  const succs = new Map<string, string[]>();
  const waiting = new Map<string, number>();
  for (const t of pending) {
    let n = 0;
    for (const r of preds.get(t.task_id) ?? []) if (remaining.has(r.pred_task_id) && byId.get(r.pred_task_id)?.task_type !== 'TT_LOE') { n++; let l = succs.get(r.pred_task_id); if (!l) succs.set(r.pred_task_id, (l = [])); l.push(t.task_id); }
    waiting.set(t.task_id, n);
  }
  const key = new Map(pending.map((t) => [t.task_id, order(t)]));
  const before = (a: Row, b: Row) => { const x = key.get(a.task_id)!, y = key.get(b.task_id)!; return x[0] - y[0] || x[1] - y[1] || a.task_code.localeCompare(b.task_code); };
  const heap: Row[] = [];
  const push = (t: Row) => { heap.push(t); let i = heap.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (before(heap[i], heap[q]) >= 0) break; [heap[i], heap[q]] = [heap[q], heap[i]]; i = q; } };
  const pop = (): Row => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && before(heap[l], heap[m]) < 0) m = l; if (r < heap.length && before(heap[r], heap[m]) < 0) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  for (const t of pending) if (!waiting.get(t.task_id)) push(t);
  while (remaining.size) {
    if (!heap.length) { findings.push({ severity: 'error', code: 'LEVEL_LOOP', message: 'Leveling stopped: relationship loop.', p6: 'P6 cannot level a network with loops.' }); break; }
    const t = pop();
    remaining.delete(t.task_id);
    for (const sid of succs.get(t.task_id) ?? []) { const n = waiting.get(sid)! - 1; waiting.set(sid, n); if (n === 0) push(byId.get(sid)!); }
    const cal = calOf(t);
    const dur = Math.round(Number(t.remain_drtn_hr_cnt || 0) * 60);
    const es0 = parseP6Date(t.early_start_date) ?? 0, ef0 = parseP6Date(t.early_end_date);
    // The scheduler's dates already honour all logic; only a predecessor that leveling moved can push this one.
    let s = es0;
    for (const r of preds.get(t.task_id) ?? []) {
      const p = placed.get(r.pred_task_id);
      if (!p || !moved.has(r.pred_task_id)) continue;
      const lag = Math.round(Number(r.lag_hr_cnt || 0) * 60);
      const pc = calOf(byId.get(r.pred_task_id)!);
      const add = (x: number) => (lag ? pc.addWork(x, lag) : x);
      let v = r.pred_type === 'PR_SS' || r.pred_type === 'PR_SF' ? add(p.s) : add(p.f);
      if (r.pred_type === 'PR_FF' || r.pred_type === 'PR_SF') v = dur ? cal.subWork(v, dur) : v;
      s = Math.max(s, v);
    }
    const pushed = s > es0;
    if (pushed) s = cal.nextWorkStart(s);
    const lf = parseP6Date(t.late_end_date);
    const as = assigns.get(t.task_id) ?? [];
    let f = !pushed && ef0 != null ? ef0 : dur ? cal.addWork(s, dur) : s; // unmoved: keep the scheduler's own finish
    // Delay until no day of the activity adds to a resource beyond its limit. A day the resource is not yet using
    // never conflicts: an activity that alone needs more than the limit cannot be fixed by delaying it (P6 places
    // it and reports the overallocation). After a conflict, the next try starts the day after the conflicting day.
    const limit = (opts.withinFloat && lf != null) ? lf : null;
    for (let n = 0; as.length && n < HORIZON_DAYS; n++) {
      let clash = -1;
      for (const a of as) {
        const u = use(a.rsrc_id);
        for (const [d, h] of demand(t, a, s, f)) { const have = u.get(d) ?? 0; if (have > 1e-6 && have + h > capOn(a.rsrc_id, d, cal) + 1e-6) { clash = clash < 0 ? d : Math.min(clash, d); break; } }
      }
      if (clash < 0) break;
      const ns = cal.nextWorkStart((Math.max(clash, Math.floor(s / MIN_PER_DAY)) + 1) * MIN_PER_DAY);
      const nf = dur ? cal.addWork(ns, dur) : ns;
      if (limit != null && nf > limit) break;
      s = ns; f = nf;
    }
    for (const a of as) for (const [d, h] of demand(t, a, s, f)) use(a.rsrc_id).set(d, (use(a.rsrc_id).get(d) ?? 0) + h);
    placed.set(t.task_id, { s, f });
    if (s > es0 + 1) {
      moved.add(t.task_id);
      delayed++;
      log.push(`  ${t.task_code.padEnd(20)} delayed from ${formatP6Date(es0)} to ${formatP6Date(s)}`);
      movedList.push({ taskId: t.task_id, code: t.task_code, from: formatP6Date(es0), start: formatP6Date(s), finish: formatP6Date(f) });
    }
    if (!moved.has(t.task_id)) continue; // unchanged activities keep every date the scheduler gave them
    const T = table(db, 'TASK');
    for (const fld of ['early_start_date', 'early_end_date', 'restart_date', 'reend_date', 'total_float_hr_cnt']) addField(T, fld);
    const fs = formatP6Date(s), ff = formatP6Date(f);
    Object.assign(t, { early_start_date: fs, early_end_date: ff, restart_date: fs, reend_date: ff, target_start_date: fs, target_end_date: ff });
    if (lf != null) t.total_float_hr_cnt = p6num(cal.workBetween(f, lf) / 60);
  }
  // report remaining overallocation, and each resource's peak day
  const peaks: LevelResult['peaks'] = [];
  for (const [rid, u] of usage) {
    let worst = 0, day = 0, peak = 0, pday = 0;
    const c = cap.get(rid)! * 8 * tol;
    for (const [d, h] of u) { if (h - c > worst) { worst = h - c; day = d; } if (h > peak) { peak = h; pday = d; } }
    if (worst > 0.01) log.push(`  Resource ${rsrcs.get(rid)?.rsrc_short_name ?? rid} still overallocated by ${p6num(worst)} h on ${formatP6Date(day * MIN_PER_DAY).slice(0, 10)}`);
    peaks.push({ rsrcId: rid, code: rsrcs.get(rid)?.rsrc_short_name ?? rid, peak: Math.round(peak * 100) / 100, limit: Math.round(c * 100) / 100, day: formatP6Date(pday * MIN_PER_DAY).slice(0, 10), overallocated: worst > 0.01 });
  }
  peaks.sort((a, b) => a.code.localeCompare(b.code));
  const text = ['Leveling Report', '', `Activities delayed .......... ${delayed}`, `Resources leveled ........... ${new Set([...assigns.values()].flat().map((a) => a.rsrc_id)).size}`, `Level within float .......... ${opts.withinFloat ? 'Yes' : 'No'}`,
    ...(noLimit.size ? ['', `Not leveled: ${noLimit.size} resource(s) have no Max Units/Time (set it in Enterprise > Resources > Units & Prices): ${[...noLimit].map((id) => rsrcs.get(id)?.rsrc_short_name ?? id).sort().slice(0, 40).join(', ')}${noLimit.size > 40 ? ', ...' : ''}`] : []),
    '', ...log, '', 'End of report'].join('\r\n');
  return { log: text, delayed, findings, moved: movedList, peaks };
}
