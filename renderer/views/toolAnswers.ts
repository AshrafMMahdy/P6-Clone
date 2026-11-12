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

/** A run that was cancelled (before it started, or ended by Cancel, nothing kept): a status line, not a failure. */
export const wasCancelled = (r: ToolAnswer): boolean => r.isError && r.out.error?.code === 'cancelled';

/** An answer that says why nothing ran (the screen's own: the window could not save, or the run was cancelled before it started). */
export const notRun = (code: string, message: string): ToolAnswer => ({ isError: true, out: { error: { code, message } } });

// ---------------------------------------------------------------- what a run was of, and where its rows are now
/** The state a run was started on: the database version and the projects open then. A result is of that state only. */
export interface RunStamp { dbVersion: number; projects: string[] }
/** What the line on a result says when the project is no longer the one it was computed from (as the Risks page's "(schedule changed since)"). */
export const CHANGED_SINCE = 'the project changed since this run: run it again';
/** Whether the project changed since the run: the database version or the open projects differ from the run's start. */
export const changedSince = (start: RunStamp, now: RunStamp): boolean => start.dbVersion !== now.dbVersion || start.projects.length !== now.projects.length || start.projects.some((p, i) => p !== now.projects[i]);
/** Why a result must not be applied (null: it may be): it was computed from an older state, so applying it would write the old project's figures over the user's newer edit. */
export const staleReason = (start: RunStamp, now: RunStamp): string | null => (changedSince(start, now) ? `${CHANGED_SINCE[0].toUpperCase()}${CHANGED_SINCE.slice(1)}.` : null);
/** The projects a run covers: exactly the open ones (analysis:run's scope; the tool's own `project` argument is not given). */
export const runScope = (open: string[]): { scope: string[] } => ({ scope: [...open] });

/** The row of an activity in the open projects, by the pair the tool's answer names it with: its Activity ID and, when the run covered several
 *  projects, its Project ID (project). null when there is no such activity now (deleted since the run). */
export function taskIndex(d: Db, open: string[]): (code: string, project?: string) => { taskId: string; projId: string } | null {
  const mine = new Set(open), name = new Map(rows(d, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name as string])), by = new Map<string, { taskId: string; projId: string }>();
  for (const t of rows(d, 'TASK')) if (mine.has(t.proj_id)) { const k = `${name.get(t.proj_id)}\u0000${t.task_code}`; if (!by.has(k)) by.set(k, { taskId: t.task_id, projId: t.proj_id }); if (!by.has(`\u0000${t.task_code}`)) by.set(`\u0000${t.task_code}`, { taskId: t.task_id, projId: t.proj_id }); }
  return (code, project) => by.get(`${project ?? ''}\u0000${code}`) ?? null;
}
/** A row's key: the pair, so two projects' activities with one Activity ID are two rows. */
export const rowKey = (x: { code: string; project?: string }): string => `${x.project ?? ''}\u0000${x.code}`;

// ---------------------------------------------------------------- Monte Carlo (monte_carlo)
/** monte_carlo's arguments from the settings. The iterations go to the tool as typed: it takes any whole number of 10 or more and refuses
 *  the rest, and a run that does not fit in memory, in words before it starts. The screen needs every activity listed and the engine's whole-day
 *  bars: the Export's child process (main/analysis-export.ts) sets config.screens, which gives the tool's answer exactly that (the tool itself has
 *  no list-size or bars argument: an agent always gets 25 per list and 20 bars). exact: true gives the engine's own figures, which the page shows as
 *  it always did. No `project`: the run covers the open projects (runScope). */
export function monteCarloArgs(s: { iterations: number; seed?: number; riskEvents: string }): Record<string, unknown> {
  return { iterations: s.iterations, ...(s.seed != null ? { seed: s.seed } : {}), risk_events: s.riskEvents, exact: true };
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
 *  empty (the tool's export has them). The figures are the engine's own (the call passes exact: true: `exact`, the rows' critical_pct and
 *  correlation). Each row carries its project (the tool names it when the run covers several: `project`) and taskIdOf finds its row in the open
 *  projects by that pair (a click goes to the activity; null: not there now, and the row is shown and not clickable). */
export function monteCarloResult(out: Record<string, any>, taskIdOf: (code: string, project?: string) => { taskId: string; projId: string } | null): MonteCarloResult {
  const f = out.finish ?? {}, w = out.working_days ?? {}, ex = out.exact;
  const place = (x: { id: string; project?: string }) => { const t = taskIdOf(x.id, x.project); return { taskId: t?.taskId ?? '', projId: t?.projId ?? '', project: x.project ?? '' }; };
  const activities = (out.criticality ?? []).map((x: any) => ({ ...place(x), code: x.id, name: x.name, milestone: x.milestone === true, criticality: x.critical_pct, sensitivity: x.sensitivity ?? null,
    deterministicFinish: atOrNull(x.deterministic_finish), meanFinish: atOrNull(x.mean_finish), p50Finish: atOrNull(x.p50_finish), p80Finish: atOrNull(x.p80_finish), minDur: x.min_remaining_hours, meanDur: x.mean_remaining_hours, maxDur: x.max_remaining_hours }));
  const hist = (out.histogram ?? []).map((b: any) => ({ start: at(b.start), end: at(b.end), count: b.count, cumPct: b.cum_pct }));
  return {
    iterations: out.iterations, seed: out.seed, elapsedMs: out.elapsed_seconds * 1000, projIds: [], dataDate: atOrNull(out.data_date),
    deterministicFinish: at(out.deterministic_finish), finishSamples: [],
    percentiles: { P10: at(f.P10), P50: at(f.P50), P80: at(f.P80), P90: at(f.P90) },
    mean: at(f.mean), min: at(f.min), max: at(f.max), stdDevDays: ex.std_dev_days,
    probDeterministic: ex.prob_deterministic,
    ...(ex.prob_deadline != null ? { probDeadline: ex.prob_deadline } : {}),
    days: { from: atOrNull(w.from), hoursPerDay: w.hours_per_day, deterministic: w.deterministic, mean: w.mean, std: w.std, min: w.min, max: w.max, P10: w.P10, P50: w.P50, P80: w.P80, P90: w.P90, sigma: (w.sigma ?? []).map((x: any) => ({ k: x.k, days: x.days, date: at(x.date) })) },
    events: (out.events ?? []).map((x: any, i: number) => ({ name: x.name, probability: ex.events[i].probability, triggeredPct: ex.events[i].triggered_pct })),
    histogram: hist,
    cumulative: (out.cumulative ?? []).map((p: any) => ({ t: at(p.finish), pct: p.cum_pct })),
    activities,
    // the tornado: the activities whose duration varied, the strongest correlation first (the tool's list, in the engine's order)
    sensitivity: (out.sensitivity ?? []).map((x: any) => ({ ...place(x), code: x.id, name: x.name, rho: x.correlation })),
    milestones: (out.milestones ?? []).map((m: any) => ({ ...place(m), code: m.id, name: m.name, deterministic: atOrNull(m.deterministic), mean: NaN, P10: at(m.P10), P50: at(m.P50), P80: at(m.P80), P90: at(m.P90) })),
    risks: (out.risk_events ?? []).map((r: any, i: number) => ({ projRiskId: r.id, code: r.id, name: r.name, probability: ex.risk_events[i].probability, hours: ex.risk_events[i].hours, activities: r.activities, triggeredPct: ex.risk_events[i].triggered_pct })),
    ...(out.partial ? { partial: { stopped: out.stopped, requested: out.iterations_requested, ...(out.error ? { error: out.error } : {}) } } : {}),
  } as MonteCarloResult;
}

/** What the Risks page shows of a result in text, one function each, so a test can compare them with the engine's figures (RiskView.tsx uses
 *  these and only these for them). */
const r2 = (n: number) => String(Math.round(n * 100) / 100);
export const stdDevText = (res: MonteCarloResult): string => `${r2(res.stdDevDays)} calendar days`;
export const probabilityText = (res: MonteCarloResult): string => `${Math.round(res.probDeterministic * 100)}%`;
/** Risk Impact (d): the hours of the risk over the hours of a day. */
export const impactText = (hours: number, hoursPerDay: number): string => r2(hours / hoursPerDay);
export const riskRowText = (r: MonteCarloResult['risks'][number], hoursPerDay: number) => ({ probability: `${Math.round(r.probability * 100)}%`, impact: impactText(r.hours, hoursPerDay), activities: r.activities, occurred: `${Math.round(r.triggeredPct)}%` });
/** The criticality grid's row: the whole percent, whether it is shown in the critical class (50 % or more), and its bar. */
export const criticalityCell = (a: { criticality: number }) => ({ text: `${Math.round(a.criticality)}%`, critical: a.criticality >= 50, bar: `${a.criticality}%` });
export const sensitivityText = (v: number | null): string => (v == null ? '' : v.toFixed(2));

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
/** lint's arguments from the panel (every critical ladder is simulated: the tool's default). The panel lists every activity and fix of every check: in the app's own
 *  process (config.screens, main/analysis-export.ts) the tool's answer carries whole lists, where an agent's carries 25 of each. */
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
/** An entry of the tool's placement order (`priority`): the Activity ID, or {id, project} when the run covered several projects. */
export type PriorityEntry = string | { id: string; project: string };
/** The leveling the Optimize panel's Apply does after the crash changes and F9: P6's leveler given the tool's placement order (`priority`, the
 *  whole order: max_priority 0), as optimize_schedule's apply: true does. An Activity ID shared by several open projects is told apart by
 *  the project the tool names with it. */
export function levelInProposedOrder(d: Db, projIds: string[], priority: PriorityEntry[]): void {
  const open = new Set(projIds), name = new Map(rows(d, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name as string])), byKey = new Map<string, string[]>();
  for (const t of rows(d, 'TASK')) if (open.has(t.proj_id)) for (const k of [`${name.get(t.proj_id)}\u0000${t.task_code}`, `\u0000${t.task_code}`]) byKey.set(k, [...(byKey.get(k) ?? []), t.task_id]);
  levelResources(d, projIds, { first: priority.flatMap((p) => byKey.get(typeof p === 'string' ? `\u0000${p}` : `${p.project}\u0000${p.id}`) ?? []) });
}
/** How many of the placement order the Optimize panel lists, as it always did (the tool's own default of 100): the line is "first 100 of N", and
 *  Apply levels in the whole order the answer holds, not in these. */
export const PRIORITY_SHOWN = 100;
export function priorityShown(priority: PriorityEntry[], total: number): { heading: string; entries: PriorityEntry[] } {
  return { heading: `Priority (${total > PRIORITY_SHOWN ? `first ${PRIORITY_SHOWN} of ${total}` : total})`, entries: priority.slice(0, PRIORITY_SHOWN) };
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
export const OPTIMIZE_ADVICE = 'Review the biggest changes before applying; Undo takes the apply back. Apply makes the new durations current and keeps the numbers they replace in custom fields: the first apply in WHIQ original duration (d), a later one in WHIQ run <N> duration (d). It also writes WHIQ duration change (d), WHIQ change note and WHIQ leveling rank.';
