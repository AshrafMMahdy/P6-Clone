// Resource usage: time-phased actual/remaining units and availability per resource (Resource Usage Profile/Spreadsheet).
import { indexBy, rows, type Db, type Row } from '../db.ts';
import { MIN_PER_DAY, parseP6Date } from '../dates.ts';
import { calendarResolver } from '../schedule/cpm.ts';
import type { WorkCalendar } from '../calendar/calendar.ts';
import { curveOf, shareBetween, type Curve } from './curve.ts';

export type UsageBucket = 'day' | 'week' | 'month';

export interface UsageRow { rsrcId: string; actual: number[]; remaining: number[]; capacity: number[] }
export interface UsageResult { buckets: number[]; rows: UsageRow[] }

/** Start of the bucket containing t (weeks start Monday, months are calendar months). */
export function bucketStart(t: number, bucket: UsageBucket): number {
  const day = Math.floor(t / MIN_PER_DAY);
  if (bucket === 'day') return day * MIN_PER_DAY;
  if (bucket === 'week') {
    const dow = (day + 4) % 7; // 0 = Sunday
    return (day - ((dow + 6) % 7)) * MIN_PER_DAY;
  }
  const d = new Date(day * MIN_PER_DAY * 60000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 60000;
}

/** Start of the bucket after the one starting at t. */
export function nextBucket(t: number, bucket: UsageBucket): number {
  if (bucket === 'day') return t + MIN_PER_DAY;
  if (bucket === 'week') return t + 7 * MIN_PER_DAY;
  const d = new Date(t * 60000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 60000;
}

const num = (s: string | undefined) => Number(s || 0) || 0;

/**
 * Spread assignment units (hours) of the given projects into time buckets.
 * Remaining units go linearly over the work time of the activity calendar between remaining start and finish;
 * actual units between actual start and actual finish (or the data date while in progress).
 * Capacity = max units/hour x work hours of the resource calendar in the bucket (0 for material resources).
 */
export function spreadUsage(db: Db, projIds: string[], opts: { start: number; end: number; bucket: UsageBucket; rsrcId?: string }): UsageResult {
  const buckets: number[] = [];
  if (Number.isFinite(opts.start) && Number.isFinite(opts.end) && opts.end > opts.start) {
    for (let t = bucketStart(opts.start, opts.bucket); t < opts.end && buckets.length < 20000; t = nextBucket(t, opts.bucket)) buckets.push(t);
  }
  const ends = buckets.map((b) => nextBucket(b, opts.bucket));
  const n = buckets.length;

  const cals = calendarResolver(db, []);
  const projects = indexBy(rows(db, 'PROJECT'), 'proj_id');
  const tasks = indexBy(rows(db, 'TASK'), 'task_id');
  const rsrcs = indexBy(rows(db, 'RSRC'), 'rsrc_id');
  const projSet = new Set(projIds);
  const out = new Map<string, UsageRow>();
  const rowFor = (id: string): UsageRow => {
    let r = out.get(id);
    if (!r) out.set(id, (r = { rsrcId: id, actual: new Array<number>(n).fill(0), remaining: new Array<number>(n).fill(0), capacity: new Array<number>(n).fill(0) }));
    return r;
  };
  if (opts.rsrcId) rowFor(opts.rsrcId);

  // first bucket whose end is after t
  const firstBucket = (t: number) => {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ends[m] <= t) lo = m + 1; else hi = m; }
    return lo;
  };
  const curves = new Map(rows(db, 'RSRCCURVDATA').map((c) => [c.curv_id, curveOf(c)]));
  // Spread qty over the work time [a, b]: linearly, or along a P6 resource curve when one is given.
  const spread = (into: number[], qty: number, a: number, b: number, cal: WorkCalendar, curve: Curve | null = null) => {
    if (!(qty > 0) || !n) return;
    const total = b > a ? cal.workBetween(a, b) : 0;
    if (total <= 0) {
      const i = firstBucket(a);
      if (i < n && a >= buckets[0]) into[i] += qty;
      return;
    }
    let done = 0; // work minutes from a to the start of the current bucket
    for (let i = firstBucket(a); i < n && buckets[i] < b; i++) {
      const w = cal.workBetween(Math.max(a, buckets[i]), Math.min(b, ends[i]));
      if (w > 0 || (curve && buckets[i] <= a)) into[i] += qty * shareBetween(curve, done === 0 && buckets[i] <= a ? 0 : done / total, (done + w) / total);
      done += w;
    }
  };

  for (const a of rows(db, 'TASKRSRC')) {
    if (!projSet.has(a.proj_id) && !projSet.has(tasks.get(a.task_id)?.proj_id ?? '')) continue;
    if (opts.rsrcId && a.rsrc_id !== opts.rsrcId) continue;
    if (!a.rsrc_id) continue;
    const t: Row | undefined = tasks.get(a.task_id);
    const proj = projects.get(a.proj_id || t?.proj_id || '');
    const cal = (t && cals.get(t.clndr_id)) || cals.fallback(proj?.clndr_id);
    const r = rowFor(a.rsrc_id);

    const act = num(a.act_reg_qty) + num(a.act_ot_qty);
    if (act > 0) {
      const as = parseP6Date(a.act_start_date || t?.act_start_date);
      const finished = a.act_end_date || t?.act_end_date;
      let ae = parseP6Date(finished) ?? parseP6Date(proj?.last_recalc_date);
      if (as != null) {
        if (ae == null || ae < as) ae = as;
        spread(r.actual, act, as, ae, cal);
      }
    }
    const rem = num(a.remain_qty);
    if (rem > 0) {
      const rs = parseP6Date(a.restart_date || t?.restart_date || t?.early_start_date);
      let re = parseP6Date(a.reend_date || t?.reend_date || t?.early_end_date);
      if (rs != null) {
        if (re == null || re < rs) re = rs;
        spread(r.remaining, rem, rs, re, cal, a.curv_id ? curves.get(a.curv_id) ?? null : null);
      }
    }
  }

  // capacity
  const rates = new Map<string, Row[]>();
  for (const rr of rows(db, 'RSRCRATE')) {
    let l = rates.get(rr.rsrc_id);
    if (!l) rates.set(rr.rsrc_id, (l = []));
    l.push(rr);
  }
  for (const l of rates.values()) l.sort((x, y) => (x.start_date || '').localeCompare(y.start_date || ''));
  for (const r of out.values()) {
    const rsrc = rsrcs.get(r.rsrcId);
    if (rsrc?.rsrc_type === 'RT_Mat') continue;
    const cal = cals.get(rsrc?.clndr_id) ?? cals.fallback();
    const rl = (rates.get(r.rsrcId) ?? []).map((x) => ({ at: parseP6Date(x.start_date) ?? -Infinity, max: x.max_qty_per_hr }));
    for (let i = 0; i < n; i++) {
      let maxStr: string | undefined;
      for (const x of rl) if (x.at <= buckets[i] && x.max !== '' && x.max != null) maxStr = x.max;
      maxStr ??= rl.find((x) => x.max !== '' && x.max != null)?.max;
      const perHr = maxStr != null ? Number(maxStr) : rsrc?.max_qty_per_hr ? Number(rsrc.max_qty_per_hr) : 1;
      r.capacity[i] = ((Number.isFinite(perHr) ? perHr : 1) * cal.workBetween(buckets[i], ends[i])) / 60;
    }
  }

  const name = (id: string) => rsrcs.get(id)?.rsrc_short_name ?? id;
  return { buckets, rows: [...out.values()].sort((x, y) => name(x.rsrcId).localeCompare(name(y.rsrcId), undefined, { numeric: true })) };
}
