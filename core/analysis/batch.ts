// What-ifs in bulk: the project is scheduled once as it is, then each scenario (a list of edit operations) is applied
// and scheduled on a rolled-back copy, so dozens of candidates cost one call and one F9 each, and nothing is kept.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { record, rollback } from '../journal.ts';
import { applyOps } from '../project/ops.ts';
import { isCritical, makeCtx } from '../project/ctx.ts';
import { activityCosts, sumLines } from '../cost/rollup.ts';
import { calendarResolver, scheduleProjects, type SchedOptions } from '../schedule/cpm.ts';
import type { Tick } from './common.ts';

export interface Scenario { name: string; overrides: unknown[] }
export interface ScenarioResult {
  name: string; ok: boolean; error?: string;
  finish?: string | null; finish_delta_days?: number | null;
  critical?: number; became_critical?: string[]; no_longer_critical?: string[]; negative_float?: number;
  cost?: number; cost_delta?: number;
  changed?: { id: string; start: [string | null, string | null]; finish: [string | null, string | null] }[];
}
export interface Measure { finish: number | null; critical: Set<string>; negative: number; cost: number; dates: Map<string, [string | null, string | null]> }

/** Run fn on a copy that is rolled back afterwards; its result is kept. */
export function onScratch<T>(db: Db, fn: (d: Db) => T): T {
  let out!: T;
  const j = record(db, (d) => { out = fn(d); });
  rollback(j);
  return out;
}

/** Schedule and read what a scenario is judged by. */
export function measure(d: Db, projIds: string[], over: Partial<SchedOptions> = {}): { ok: true; m: Measure } | { ok: false; error: string } {
  const r = scheduleProjects(d, projIds, over);
  if (!r.ok) return { ok: false, error: r.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' ') || 'The schedule failed.' };
  const open = new Set(projIds), ctx = makeCtx(d, { hoursPerDay: 8 });
  const tasks = rows(d, 'TASK').filter((t) => open.has(t.proj_id));
  const crit = new Set(tasks.filter((t) => isCritical(t, ctx)).map((t) => t.task_code));
  const dates = new Map(tasks.map((t) => [t.task_code, [(t.act_start_date || t.early_start_date || null)?.slice(0, 16) ?? null, (t.act_end_date || t.early_end_date || null)?.slice(0, 16) ?? null] as [string | null, string | null]]));
  return { ok: true, m: { finish: r.stats.finish, critical: crit, negative: tasks.filter((t: Row) => !t.act_end_date && Number(t.total_float_hr_cnt || 0) < 0).length, cost: sumLines(activityCosts(d, projIds).values()).eac, dates } };
}

export async function evaluateBatch(db: Db, projIds: string[], scenarios: Scenario[], o: { options?: Partial<SchedOptions>; hoursPerDay?: number; calendarDays?: boolean; top?: number; tick?: Tick } = {}) {
  const hpd = o.hoursPerDay ?? 8, top = o.top ?? 3;
  const base = onScratch(db, (d) => measure(d, projIds, o.options));
  if (!base.ok) return { ok: false as const, error: { code: 'schedule_failed', message: `The project as it is cannot be scheduled: ${base.error}` } };
  const p0 = rows(db, 'PROJECT').find((p) => p.proj_id === projIds[0]);
  const cal = calendarResolver(db, []).fallback(p0?.clndr_id ?? '');
  const days = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round((cal.workBetween(a, b) / 60 / (cal.hoursPerDay() || hpd)) * 100) / 100);
  const results: (ScenarioResult & { _m?: Measure })[] = [];
  for (const [i, sc] of scenarios.entries()) {
    if (o.tick) await o.tick(i, scenarios.length, `scenario ${i + 1} of ${scenarios.length}`);
    const name = sc.name || `scenario ${i + 1}`;
    results.push(onScratch(db, (d): ScenarioResult & { _m?: Measure } => {
      const r = applyOps(d, sc.overrides ?? [], { hoursPerDay: hpd, calendarDays: o.calendarDays ?? true }); // days as the caller edits
      if (!r.ok) return { name, ok: false, error: `operation ${r.error!.index + 1}: ${r.error!.message}` };
      const m = measure(d, projIds, o.options);
      if (!m.ok) return { name, ok: false, error: m.error };
      return {
        name, ok: true, finish: m.m.finish != null ? formatP6Date(m.m.finish) : null, finish_delta_days: days(base.m.finish, m.m.finish),
        critical: m.m.critical.size, became_critical: [...m.m.critical].filter((c) => !base.m.critical.has(c)), no_longer_critical: [...base.m.critical].filter((c) => !m.m.critical.has(c)),
        negative_float: m.m.negative, cost: Math.round(m.m.cost * 100) / 100, cost_delta: Math.round((m.m.cost - base.m.cost) * 100) / 100, _m: m.m,
      };
    }));
  }
  // the best few (earliest finish, then cheapest) carry the activities whose dates moved
  const ranked = results.filter((r) => r.ok).sort((a, b) => (parseP6Date(a.finish ?? '') ?? Infinity) - (parseP6Date(b.finish ?? '') ?? Infinity) || (a.cost ?? 0) - (b.cost ?? 0));
  for (const r of ranked.slice(0, top)) r.changed = [...r._m!.dates].filter(([k, v]) => { const b = base.m.dates.get(k); return !b || b[0] !== v[0] || b[1] !== v[1]; }).slice(0, 200).map(([k, v]) => { const b = base.m.dates.get(k) ?? [null, null]; return { id: k, start: [b[0], v[0]], finish: [b[1], v[1]] }; });
  for (const r of results) delete r._m;
  return { ok: true as const, base: { finish: base.m.finish != null ? formatP6Date(base.m.finish) : null, critical: base.m.critical.size, cost: Math.round(base.m.cost * 100) / 100 }, best: ranked[0]?.name ?? null, scenarios: results };
}
