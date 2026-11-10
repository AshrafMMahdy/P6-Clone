// What the screens that run their MCP tool off the window (Monte Carlo, Crashing, Lint, Float paths, Optimize, and Level resources before
// them) send and show: the tool's arguments built from the panel's settings, and the tool's answer read for the panel. No window, store or
// React in here, so the tests can import it and compare a panel's call with the tool's (tests/screens-run-as-tools.test.ts).
// The mechanism is main/analysis-export-ipc.ts (analysis:run): the tool runs in a child process on the saved database, with the tool's
// own arguments; the answer is the tool's, field for field.
import { parseP6Date } from '../../core/dates.ts';
import type { MonteCarloResult } from '../../core/risk/montecarlo.ts';
import { REASONER_WINDOW } from '../../core/analysis/hrm.ts';
import { rows, type Db } from '../../core/db.ts';
import { levelResources } from '../../core/level/level.ts';

/** What the child answered (callTool's answer): see main/analysis-export-ipc.ts. */
export type ToolAnswer = { isError: boolean; out: Record<string, any> };

/** The message of a tool's error answer (as callTool and the tools give it), whole. */
export function errorText(out: Record<string, any>): string {
  const e = out.error;
  if (typeof e === 'string') return e;
  const m = e?.message ?? e?.reason;
  return m ? `${m}${e.hint ? ` ${e.hint}` : ''}` : JSON.stringify(out).slice(0, 400);
}

/** Why an answer is not the result, in the tool's words (null when it is the result): the tool's refusal (memory, a bad argument, a loop
 *  in the logic), a cancelled run, or a run that could not start. */
export const refusal = (r: ToolAnswer): string | null => (r.isError ? errorText(r.out) : null);

/** An answer that says why nothing ran (the screen's own: the window could not save, or the run was cancelled before it started). */
export const notRun = (code: string, message: string): ToolAnswer => ({ isError: true, out: { error: { code, message } } });

// ---------------------------------------------------------------- Monte Carlo (monte_carlo)
/** monte_carlo's arguments from the settings. The iterations go to the tool as typed: it takes any whole number of 10 or more and refuses
 *  the rest, and a run that does not fit in memory, in words before it starts. top 0 lists every activity as the screen always did; buckets
 *  40 is the chart's resolution (the screen's histogram has had at most 40 bars). `project` as the Export's (projectArgs). */
export function monteCarloArgs(s: { iterations: number; seed?: number; riskEvents: string; project?: { project?: string } }): Record<string, unknown> {
  return { ...(s.project ?? {}), iterations: s.iterations, ...(s.seed != null ? { seed: s.seed } : {}), risk_events: s.riskEvents, top: 0, buckets: 40 };
}

/** The line a stopped monte_carlo run shows (the tool's partial answer: the statistics are of the iterations that finished); null when the run was complete. */
export function monteCarloStopped(out: Record<string, any>): string | null {
  if (!out.partial) return null;
  const how = out.stopped === 'cancelled' ? 'Cancelled' : `Stopped${out.error ? ` (${out.error})` : ''}`;
  return `${how} after ${out.iterations_done} of ${out.iterations_requested} iterations: these results are of the ${out.iterations_done} that finished.`;
}

const at = (s: unknown): number => (typeof s === 'string' ? parseP6Date(s) : null) as number;
const atOrNull = (s: unknown): number | null => (typeof s === 'string' ? parseP6Date(s) : null);

/** monte_carlo's answer as the Risks window's results take it (core/risk/montecarlo.ts MonteCarloResult). The criticality rows carry every
 *  column the grid shows (milestone, the deterministic, P50, mean and P80 finish, the sensitivity, the shortest, mean and longest remaining
 *  hours) and the answer carries the S-curve, so the page reads as it did from the engine's result; only the per-iteration finishes stay
 *  empty (the tool's export has them). taskIdOf: the Activity ID's row in the open projects (a click goes to the activity). */
export function monteCarloResult(out: Record<string, any>, taskIdOf: (code: string) => string): MonteCarloResult {
  const f = out.finish ?? {}, w = out.working_days ?? {};
  const activities = (out.criticality ?? []).map((x: any) => ({ taskId: taskIdOf(x.id), code: x.id, name: x.name, projId: '', milestone: x.milestone === true, criticality: x.critical_pct, sensitivity: x.sensitivity ?? null,
    deterministicFinish: atOrNull(x.deterministic_finish), meanFinish: atOrNull(x.mean_finish), p50Finish: atOrNull(x.p50_finish), p80Finish: atOrNull(x.p80_finish), minDur: x.min_remaining_hours, meanDur: x.mean_remaining_hours, maxDur: x.max_remaining_hours }));
  const hist = (out.histogram ?? []).map((b: any) => ({ start: at(b.start), end: at(b.end), count: b.count, cumPct: b.cum_pct }));
  return {
    iterations: out.iterations, seed: out.seed, elapsedMs: out.elapsed_seconds * 1000, projIds: [], dataDate: atOrNull(out.data_date),
    deterministicFinish: at(out.deterministic_finish), finishSamples: [],
    percentiles: { P10: at(f.P10), P50: at(f.P50), P80: at(f.P80), P90: at(f.P90) },
    mean: at(f.mean), min: at(f.min), max: at(f.max), stdDevDays: f.std_dev_days,
    probDeterministic: out.chance_of_meeting_deterministic / 100,
    ...(out.deadline ? { probDeadline: out.deadline.probability_pct / 100 } : {}),
    days: { from: atOrNull(w.from), hoursPerDay: w.hours_per_day, deterministic: w.deterministic, mean: w.mean, std: w.std, min: w.min, max: w.max, P10: w.P10, P50: w.P50, P80: w.P80, P90: w.P90, sigma: (w.sigma ?? []).map((x: any) => ({ k: x.k, days: x.days, date: at(x.date) })) },
    events: (out.events ?? []).map((x: any) => ({ name: x.name, probability: x.probability_pct / 100, triggeredPct: x.triggered_pct })),
    histogram: hist,
    cumulative: (out.cumulative ?? []).map((p: any) => ({ t: at(p.finish), pct: p.cum_pct })),
    activities,
    // the tornado: the activities whose duration varied, the strongest correlation first (as the engine lists them)
    sensitivity: activities.filter((a: any) => a.sensitivity != null).map((a: any) => ({ taskId: a.taskId, code: a.code, name: a.name, rho: a.sensitivity })).sort((a: any, b: any) => Math.abs(b.rho) - Math.abs(a.rho)),
    milestones: (out.milestones ?? []).map((m: any) => ({ taskId: taskIdOf(m.id), code: m.id, name: m.name, deterministic: atOrNull(m.deterministic), mean: NaN, P10: at(m.P10), P50: at(m.P50), P80: at(m.P80), P90: at(m.P90) })),
    risks: (out.risk_events ?? []).map((r: any) => ({ projRiskId: r.id, code: r.id, name: r.name, probability: r.probability_pct / 100, hours: r.impact_days * w.hours_per_day, activities: r.activities, triggeredPct: r.triggered_pct })),
    ...(out.partial ? { partial: { stopped: out.stopped, requested: out.iterations_requested, ...(out.error ? { error: out.error } : {}) } } : {}),
  } as MonteCarloResult;
}

// ---------------------------------------------------------------- Crashing (crash_schedule)
export interface CrashSettings { mode: 'days' | 'date' | 'cost'; days: string; date: string; indirect: string; ld: string; pct: string; data: Record<string, { min: string; cost: string }> }
/** crash_schedule's arguments from the Crashing panel's settings (the Export's too). No step limit: the tool has none. */
export function crashArgs(s: CrashSettings): Record<string, unknown> {
  const acts = Object.entries(s.data).filter(([, v]) => v.min !== '' || v.cost !== '').map(([id, v]) => ({ id, min_days: Number(v.min) || 0, cost_per_day: Number(v.cost) || 0 }));
  return { ...(s.mode === 'days' ? { target_days: Number(s.days) } : {}), ...(s.mode === 'date' ? { target_finish: s.date.replace('T', ' ') } : {}), ...(Number(s.indirect) ? { indirect_cost_per_day: Number(s.indirect) } : {}), ...(Number(s.ld) ? { ld_per_day: Number(s.ld) } : {}), ...(acts.length ? { activities: acts } : {}), default_max_pct: Number(s.pct) || 30 };
}
/** The line a stopped crash_schedule run shows (stop CANCELLED: the steps done, nothing applied); null for a run that ended by itself. */
export const crashStopped = (out: Record<string, any>): string | null =>
  out.stop === 'CANCELLED' ? `Cancelled after ${out.steps_done ?? out.steps?.length ?? 0} steps: these are the steps done, and nothing was applied.` : null;

// ---------------------------------------------------------------- Lint (lint)
/** lint's arguments from the panel (every critical ladder is simulated: the tool's default). */
export const lintArgs = (project: { project?: string }, profile: string): Record<string, unknown> => ({ ...project, profile });
/** The line a lint that was cancelled shows: the checks finished and, of the fix simulations, how many were done; null for a complete lint. */
export function lintStopped(out: Record<string, any>): string | null {
  if (!out.partial) return null;
  const c = (out.checks ?? []).find((x: any) => x.partial);
  return `Cancelled: the checks finished are shown${c ? `; of the ${c.ladders_to_simulate} critical ladders to simulate, ${c.ladders_simulated} were done (the rest have no days saved)` : ''}.`;
}

// ---------------------------------------------------------------- Float paths (float_paths)
export interface FloatPathsSettings { count?: number; endActivity?: string; method: string; nearDays: number; between?: { from: string; to: string; max?: number } }
/** float_paths' arguments from the panel (as the Export gives them): the paths between two activities are the tool's `between`, refused by the tool in its words (a missing activity, a loop in the logic, a max that does not fit in memory). */
export function floatPathsArgs(s: FloatPathsSettings, project: { project?: string }): Record<string, unknown> {
  return { ...project, ...(s.count != null ? { count: s.count } : {}), ...(s.endActivity ? { end_activity: s.endActivity } : {}), method: s.method, near_critical_days: s.nearDays, ...(s.between ? { between: s.between } : {}) };
}
/** "the longest N of TOTAL" for the paths between two activities (paths_total is a decimal string beyond 2^53). */
export const betweenCount = (b: { paths: unknown[]; paths_total: number | string }): string => `the longest ${b.paths.length} of ${b.paths_total}`;

// ---------------------------------------------------------------- Optimize (optimize_schedule)
/** optimize_schedule's arguments from the panel (as the Export gives them). max_priority 0: the whole placement order, which Apply levels in. */
export const optimizeArgs = (project: { project?: string }, samples?: number, seed?: number): Record<string, unknown> => ({ ...project, ...(samples != null ? { samples } : {}), ...(seed != null ? { seed } : {}), max_priority: 0 });
/** The leveling the Optimize panel's Apply does after the crash changes and F9: P6's leveler given the tool's placement order (`priority`, the
 *  whole order: max_priority 0), as optimize_schedule's apply: true does. Activity IDs shared by several open projects name each of them. */
export function levelInProposedOrder(d: Db, projIds: string[], priority: string[]): void {
  const open = new Set(projIds), byCode = new Map<string, string[]>();
  for (const t of rows(d, 'TASK')) if (open.has(t.proj_id)) byCode.set(t.task_code, [...(byCode.get(t.task_code) ?? []), t.task_id]);
  levelResources(d, projIds, { first: priority.flatMap((c) => byCode.get(c) ?? []) });
}
export interface BiggestChange { id: string; name: string; cpm_start: string | null; cpm_finish: string | null; reasoner_start: string | null; reasoner_finish: string | null; start_delta_days: number | null; finish_delta_days: number | null }
/** What the Optimize panel shows besides the dates: the table's heading line, how the model read the network, and the tool's notes, each only when the answer has it. */
export function optimizeNotes(out: Record<string, any>): { changes: string | null; windows: string | null; notes: string[] } {
  const listed = (out.biggest_changes ?? []).length, total = out.biggest_changes_total ?? listed;
  return {
    changes: total ? (listed < total ? `Biggest changes against CPM: the first ${listed} of ${total}` : `Biggest changes against CPM: all ${total}`) : null,
    windows: out.model_windows > 1 ? `read in ${out.model_windows} windows of ${REASONER_WINDOW} activities` : null,
    notes: [out.over_limit_note, out.partial_note, out.note].filter((x): x is string => typeof x === 'string' && x !== ''),
  };
}
/** The advice beside Apply: the tool's, in one line. */
export const OPTIMIZE_ADVICE = 'Review the biggest changes before applying; Undo takes the apply back.';
