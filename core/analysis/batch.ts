// What-ifs in bulk: the project is scheduled once as it is, then each scenario (a list of edit operations) is applied
// and scheduled on a rolled-back copy, so dozens of candidates cost one call and one F9 each, and nothing is kept.
import { dataDigest, PROJECT_PLACE_FIELDS, rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { record, rollback } from '../journal.ts';
import { applyOps } from '../project/ops.ts';
import { isCritical, makeCtx } from '../project/ctx.ts';
import { activityCosts, sumLines } from '../cost/rollup.ts';
import { calendarResolver, optionsFor, scheduleProjects, type SchedOptions } from '../schedule/cpm.ts';
import { LISTED, type Tick } from './common.ts';

/** Test-only: make the scenario at this index throw. */
export const testHooks: { failScenario: number | null } = { failScenario: null };

export interface Scenario { name: string; overrides: unknown[] }
export interface ScenarioResult {
  name: string; ok: boolean; error?: string;
  finish?: string | null; finish_delta_days?: number | null;
  critical?: number; became_critical?: string[]; no_longer_critical?: string[]; negative_float?: number;
  cost?: number; cost_delta?: number;
  changed?: { id: string; start: [string | null, string | null]; finish: [string | null, string | null] }[];
  /** how many activities' dates the scenario moved (changed lists the first 200) */
  changed_total?: number;
}
/** A finished scenario as a store keeps it: its index, its row, and (a scenario that scheduled) every activity whose dates it moved,
 *  which the answer gives for the best few (the first 200 of them) and an export for all. */
export interface KeptScenario { i: number; row: ScenarioResult; changed: NonNullable<ScenarioResult['changed']> | null }
/** Where a batch keeps each finished scenario as it is done (the MCP server: a file in the write root, mcp/keptRuns.ts): a batch that
 *  stops (cancelled, its worker or process ended) is continued from it by a later call, which answers what an uninterrupted one does. */
export interface RowStore {
  /** `inputs` is everything the answer is made from (the store fingerprints it). The scenarios kept by the batch this one continues, in
   *  order (none when it starts afresh); throws, changing nothing, when there is no kept batch there or it is not this one. */
  open(inputs: unknown): Promise<Iterable<KeptScenario>>;
  /** The batch goes on after the first `count` kept scenarios (anything after them is cut off). Returns how many kept scenarios are
   *  done again (found damaged, or after a damaged one). */
  resumeAt(count: number): number;
  /** One finished scenario, kept before it returns. */
  add(kept: KeptScenario): void;
  /** The batch finished: what it kept goes. A message when that could not be removed. */
  finish(): string | undefined;
  /** The batch stopped after `done` scenarios: where they are kept, or null when none are. */
  stop(done: number): string | null;
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

/** What a batch's answer is made from in the project (review 4L-13 M1), as its fingerprint takes it: what the tables say, not how
 *  they are laid out in memory (a project built here, saved and opened again is the same batch), and the options the scheduler takes
 *  from them and from what is not rows (the field list, the file's version). Every table the scenarios' edit operations may read
 *  counts; the EPS and a project's place in it (never in an XER: the EPS lives in P6's database) only when a scenario's operations name
 *  an EPS, and a project's name in the EPS never (nothing a row says reads it). */
export function batchData(db: Db, projIds: string[], scenarios: Scenario[], over: Partial<SchedOptions> = {}): { data: string; scheduler: (SchedOptions | null)[] } {
  const eps = scenarios.some((sc) => (sc.overrides ?? []).some((op) => !!op && typeof op === 'object' && (/_eps$/.test(String((op as { op?: unknown }).op)) || (op as { eps?: unknown }).eps != null)));
  const tables = eps ? db.tables : Object.fromEntries(Object.entries(db.tables).filter(([name]) => name !== 'EPS'));
  return { data: dataDigest(tables, { PROJECT: eps ? ['_name'] : PROJECT_PLACE_FIELDS }), scheduler: projIds.map((id) => { const p = rows(db, 'PROJECT').find((r) => r.proj_id === id); return p ? optionsFor(db, p, over) : null; }) };
}

export async function evaluateBatch(db: Db, projIds: string[], scenarios: Scenario[], o: { options?: Partial<SchedOptions>; hoursPerDay?: number; calendarDays?: boolean; top?: number; tick?: Tick; /** each finished scenario row, as it is done */ onRow?: (row: ScenarioResult) => void; store?: RowStore } = {}) {
  const hpd = o.hoursPerDay ?? 8, top = o.top ?? 3;
  const base = onScratch(db, (d) => measure(d, projIds, o.options));
  if (!base.ok) return { ok: false as const, error: { code: 'schedule_failed', message: `The project as it is cannot be scheduled: ${base.error}` } };
  const p0 = rows(db, 'PROJECT').find((p) => p.proj_id === projIds[0]);
  const cal = calendarResolver(db, []).fallback(p0?.clndr_id ?? '');
  const days = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round((cal.workBetween(a, b) / 60 / (cal.hoursPerDay() || hpd)) * 100) / 100);
  const results: ScenarioResult[] = [];
  // the activities whose dates each scenario moved (worked out as it finishes, so a kept scenario carries them all): the best few show
  // the first LISTED (25) of them, so only those are held here, with how many there are (an export reads them all from the kept file)
  const moved: (KeptScenario['changed'])[] = [], movedTotal: number[] = [];
  const hold = (changed: KeptScenario['changed']) => { moved.push(changed ? changed.slice(0, LISTED) : null); movedTotal.push(changed?.length ?? 0); };
  // a batch continued from a store: its kept scenarios are taken in as they were, and only the rest are scheduled
  const store = o.store;
  let redone = 0;
  if (store) {
    // (format 2: a scenario keeps every activity it moved; format 1 kept the first 200)
    const inputs = { format: 2, projIds, scenarios, options: o.options ?? null, hpd, calendarDays: o.calendarDays ?? true, top, ...batchData(db, projIds, scenarios, o.options) };
    for (const k of await store.open(inputs)) {
      // (a damaged one, and what follows it, are done again)
      if (k?.i !== results.length || results.length >= scenarios.length || !k.row || typeof k.row !== 'object' || (k.row.ok && !Array.isArray(k.changed))) break;
      results.push(k.row); hold(k.changed ?? null);
      o.onRow?.(k.row);
    }
    redone = store.resumeAt(results.length);
  }
  const resumed = results.length;
  // a cancelled call stops after the scenarios it has finished: those rows are the answer, marked partial (so does one whose scenario
  // could not be kept: stopped failed, with the cause)
  let cancelled = false, failed: Error | null = null;
  try {
  for (const [i, sc] of scenarios.entries()) {
    if (i < resumed) continue;
    if (o.tick) {
      try { await o.tick(i, scenarios.length, `scenario ${i + 1} of ${scenarios.length}`); }
      catch (e) { if ((e as { code?: unknown })?.code === 'cancelled' && results.length) { cancelled = true; break; } throw e; }
    }
    const name = sc.name || `scenario ${i + 1}`;
    // a scenario that throws is its own failed row; the others still run (onScratch has put the project back)
    let m: Measure | null = null, row: ScenarioResult;
    try { row = onScratch(db, (d): ScenarioResult => {
      if (testHooks.failScenario === i) throw new Error('test failure');
      const r = applyOps(d, sc.overrides ?? [], { hoursPerDay: hpd, calendarDays: o.calendarDays ?? true }); // days as the caller edits
      if (!r.ok) return { name, ok: false, error: `operation ${r.error!.index + 1}: ${r.error!.message}` };
      const x = measure(d, projIds, o.options);
      if (!x.ok) return { name, ok: false, error: x.error };
      m = x.m;
      return {
        name, ok: true, finish: x.m.finish != null ? formatP6Date(x.m.finish) : null, finish_delta_days: days(base.m.finish, x.m.finish),
        critical: x.m.critical.size, became_critical: [...x.m.critical].filter((c) => !base.m.critical.has(c)), no_longer_critical: [...base.m.critical].filter((c) => !x.m.critical.has(c)),
        negative_float: x.m.negative, cost: Math.round(x.m.cost * 100) / 100, cost_delta: Math.round((x.m.cost - base.m.cost) * 100) / 100,
      };
    }); } catch (e) { row = { name, ok: false, error: `The scenario failed: ${(e as Error)?.message ?? e}` }; m = null; }
    const changed = row.ok && m ? [...(m as Measure).dates].filter(([k, v]) => { const b = base.m.dates.get(k); return !b || b[0] !== v[0] || b[1] !== v[1]; }).map(([k, v]) => { const b = base.m.dates.get(k) ?? [null, null]; return { id: k, start: [b[0], v[0]] as [string | null, string | null], finish: [b[1], v[1]] as [string | null, string | null] }; }) : null;
    try { store?.add({ i, row, changed }); } catch (e) { failed = e as Error; break; } // kept before it counts: a batch stopped later continues after it
    results.push(row); hold(changed);
    // sent out as soon as it is done (a compute worker ended after a cancel keeps it)
    o.onRow?.(row);
  }
  } catch (e) { store?.stop(results.length); throw e; } // (cancelled before any scenario was done: an error, as it was)
  if (failed && !results.length) { store?.stop(0); throw failed; }
  const stopped = cancelled ? 'cancelled' as const : failed ? 'failed' as const : null;
  // what the store keeps: gone once the batch finished; else where it is, to continue the batch
  const kept = stopped ? store?.stop(results.length) ?? null : null;
  const keptNote = !stopped && store ? store.finish() : undefined;
  // the best few (earliest finish, then cheapest) carry the activities whose dates moved, over every scenario (those kept too)
  const order = results.map((_r, i) => i).filter((i) => results[i].ok).sort((a, b) => (parseP6Date(results[a].finish ?? '') ?? Infinity) - (parseP6Date(results[b].finish ?? '') ?? Infinity) || (results[a].cost ?? 0) - (results[b].cost ?? 0));
  const scenariosOut = results.map((r) => ({ ...r }));
  for (const i of order.slice(0, top)) { scenariosOut[i].changed = moved[i]!; scenariosOut[i].changed_total = movedTotal[i]; }
  return { ok: true as const, base: { finish: base.m.finish != null ? formatP6Date(base.m.finish) : null, critical: base.m.critical.size, cost: Math.round(base.m.cost * 100) / 100 }, best: order.length ? results[order[0]].name : null, scenarios: scenariosOut,
    ...(stopped ? { partial: true as const, stopped, scenarios_done: results.length, scenarios_requested: scenarios.length, ...(failed ? { error: failed.message } : {}), ...(kept ? { kept } : {}) } : {}),
    ...(store ? { resumed } : {}), ...(redone ? { redone } : {}), ...(keptNote ? { keptNote } : {}) };
}
