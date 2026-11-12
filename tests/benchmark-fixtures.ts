// The test fixtures of the Bellator Schedule Intelligence benchmark (our copy's tests/fixtures/schedules.ts), rebuilt as small P6 projects the way the clone's tests build
// projects: new project + edit operations (applyOps), F9 (scheduleProjects), a baseline saved (build_baseline) where the fixture has one, and history as separate saved updates.
// Every project has a 7-day, 24-hour calendar ("D7"), so a working day on it is a calendar day and the clone's working-day figures equal the source's calendar-day ones.
// Relationships and lags are as the source gives them. What P6 cannot hold is said where it happens (the loop; progress with no actual start is written onto the row, as a file can carry it).
// The source's numbers for these fixtures are frozen in tests/fixtures/benchmark-golden.json (how: its _how). The later packages' tests use this file for the other analyses' fixtures.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rows, type Db } from '../core/db.ts';
import { applyOps } from '../core/project/ops.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { parseP6Date } from '../core/dates.ts';

export interface Built { db: Db; projId: string; id: string; dataDate: string }
type Op = Record<string, unknown>;
const DAY = [['00:00', '24:00']];
const CAL = { name: 'D7', work_week: { mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY, sun: DAY } };

const apply = (db: Db, ops: Op[], allowLoops = false) => { const r = applyOps(db, ops, { calendarDays: true, allowLoops }); if (!r.ok) throw new Error(JSON.stringify(r.error)); };
/** an activity as the source gives it: duration in days, predecessors "ID" or "ID:TYPE+lag" (days; negative = lead), a task_type */
export interface Source { id: string; name?: string; duration_days: number; predecessors?: string[]; task_type?: 'start_milestone' | 'milestone' | 'task'; resources?: string[]; constraint?: { type: string; date: string } }

/** The project: id, start (the source's planned start, else 2026-01-05) and the activities with their logic, scheduled at data_date (default: the start). */
export function project(id: string, tasks: Source[], o: { start?: string; dataDate?: string; ops?: Op[]; schedule?: boolean; allowLoops?: boolean; resources?: { id: string; max_units_per_day: number }[] } = {}): Built {
  const db: Db = { tables: {} };
  const start = o.start ?? '2026-01-05';
  const ops: Op[] = [{ op: 'add_calendar', ...CAL }, { op: 'add_project', id, start, calendar: 'D7' }];
  for (const r of o.resources ?? []) ops.push({ op: 'add_resource', id: r.id, max_units_per_day: r.max_units_per_day, units_per_day: 1 });
  for (const t of tasks) ops.push({ op: 'add_activity', id: t.id, name: t.name ?? t.id, calendar: 'D7', ...(t.task_type === 'milestone' ? { type: 'finish_milestone' } : t.task_type === 'start_milestone' ? { type: 'start_milestone' } : { duration_days: t.duration_days }), ...(t.constraint ? { constraint: t.constraint } : {}) });
  for (const t of tasks) for (const p of t.predecessors ?? []) {
    const m = /^([^:]+)(?::(FS|SS|FF|SF)([+-]\d+(?:\.\d+)?)?)?$/.exec(p)!;
    ops.push({ op: 'add_relationship', pred: m[1], succ: t.id, type: m[2] ?? 'FS', ...(m[3] ? { lag_days: Number(m[3]) } : {}) });
  }
  for (const t of tasks) for (const r of t.resources ?? []) ops.push({ op: 'assign_resource', activity: t.id, resource: r, units_per_day: 1 });
  apply(db, [...ops, ...(o.ops ?? [])], o.allowLoops);
  const projId = rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
  const dataDate = o.dataDate ?? start;
  if (o.schedule !== false) { const r = scheduleProjects(db, [projId], { dataDate: parseP6Date(`${dataDate} 00:00`)! }); if (!r.ok) throw new Error(`cannot schedule ${id}: ${r.findings.map((f) => f.message).join(' ')}`); }
  return { db, projId, id, dataDate };
}

/** progress the source holds as percent_complete is written as physical percent (what a file can carry, also with no actual start, which the edit operations refuse) */
export function setPhysicalPercent(b: Built, activity: string, pct: number): void {
  const t = rows(b.db, 'TASK').find((x) => x.proj_id === b.projId && x.task_code === activity)!;
  t.complete_pct_type = 'CP_Phys'; t.phys_complete_pct = String(pct);
}

/** Clean 4-task linear chain, all FS: 5 + 10 + 8 + milestone; project duration 23; every activity critical. */
export const cleanChain = (): Built => project('CLEAN', [
  { id: 'T1', name: 'Design', duration_days: 5 }, { id: 'T2', name: 'Procure', duration_days: 10, predecessors: ['T1'] },
  { id: 'T3', name: 'Build', duration_days: 8, predecessors: ['T2'] }, { id: 'M1', name: 'Complete', duration_days: 0, predecessors: ['T3'], task_type: 'milestone' }]);

/** A parallel branch gives C 7 days of float (A10 -> B10 -> D5; A -> C3 -> D). */
export const withFloat = (): Built => project('FLOAT', [
  { id: 'A', duration_days: 10 }, { id: 'B', duration_days: 10, predecessors: ['A'] }, { id: 'C', duration_days: 3, predecessors: ['A'] }, { id: 'D', duration_days: 5, predecessors: ['B', 'C'] }]);

/** A lead (P1:FS-2) and an orphan (no predecessor, no successor). */
export const withLogicIssues = (): Built => project('LOGIC', [
  { id: 'P1', duration_days: 5 }, { id: 'P2', duration_days: 5, predecessors: ['P1:FS-2'] }, { id: 'ORPHAN', duration_days: 3 }]);

/** A loop: X <- Z, Y <- X, Z <- Y. P6 refuses a loop in an edit (and the scheduler refuses to schedule one), so the project is built with allowLoops and not scheduled. */
export const withCycle = (): Built => project('CYCLE', [
  { id: 'X', duration_days: 4, predecessors: ['Z'] }, { id: 'Y', duration_days: 4, predecessors: ['X'] }, { id: 'Z', duration_days: 4, predecessors: ['Y'] }], { allowLoops: true, schedule: false });

/** Progress against a baseline, status date 2026-01-20. T1 baseline 5 Jan - 12 Jan, done as planned; T2 baseline 12 - 26 Jan, started 12 Jan, finishes 31 Jan (5 days late); T3 baseline 26 Jan - 5 Feb, forecast 10 Feb.
 *  The baseline is a saved copy with the source's baseline dates (build_baseline), assigned as the project baseline. The source's forecast dates are given by the remaining durations at the data date
 *  (T2: 11 days left from 20 Jan = 31 Jan; T3 follows T2 with 10 days left = 10 Feb: the source's forecast dates are typed numbers, P6 schedules the logic, so they are reached through the remaining durations). */
export function delayed(): Built {
  const b = project('DELAYED', [
    { id: 'T1', duration_days: 5 }, { id: 'T2', duration_days: 10, predecessors: ['T1'] }, { id: 'T3', duration_days: 8, predecessors: ['T2'] }], { dataDate: '2026-01-20', schedule: false,
    ops: [
      { op: 'build_baseline', name: 'BL', assign_as: 'project', activities: [
        { activity: 'T1', start: '2026-01-05 00:00', finish: '2026-01-12 00:00', duration_days: 5 }, { activity: 'T2', start: '2026-01-12 00:00', finish: '2026-01-26 00:00', duration_days: 10 }, { activity: 'T3', start: '2026-01-26 00:00', finish: '2026-02-05 00:00', duration_days: 8 }] },
      { op: 'update_activity', id: 'T1', actual_start: '2026-01-05 00:00', actual_finish: '2026-01-12 00:00' },
      { op: 'update_activity', id: 'T2', actual_start: '2026-01-12 00:00', remaining_days: 11 },
      { op: 'update_activity', id: 'T3', remaining_days: 10 },
    ] });
  setPhysicalPercent(b, 'T2', 50);
  const r = scheduleProjects(b.db, [b.projId], { dataDate: parseP6Date('2026-01-20 00:00')! });
  if (!r.ok) throw new Error('delayed: ' + JSON.stringify(r.findings));
  return b;
}

/** The two saved updates of the "gaming" fixture and the current schedule. T1 (5 d) -> T2 (10 d). 15 Jan: T1 started 5 Jan, 80%; T2 20% (with no actual start: a file can carry it). 22 Jan: T1 started 7 Jan (a retroactive change), 60% (a decrease);
 *  T2 25%. Current (29 Jan) = the 22 Jan state. Each is a project of its own (a saved update). */
export function gaming(): { history: { snapshot_date: string; build: Built }[]; current: Built } {
  const mk = (dd: string, t1: { start: string; pct: number }, t2pct: number): Built => {
    const b = project('GAMING', [{ id: 'T1', duration_days: 5 }, { id: 'T2', duration_days: 10, predecessors: ['T1'] }], { dataDate: dd, ops: [{ op: 'update_activity', id: 'T1', actual_start: `${t1.start} 00:00` }], schedule: false });
    setPhysicalPercent(b, 'T1', t1.pct); setPhysicalPercent(b, 'T2', t2pct);
    const r = scheduleProjects(b.db, [b.projId], { dataDate: parseP6Date(`${dd} 00:00`)! });
    if (!r.ok) throw new Error('gaming: ' + JSON.stringify(r.findings));
    return b;
  };
  return { history: [{ snapshot_date: '2026-01-15', build: mk('2026-01-15', { start: '2026-01-05', pct: 80 }, 20) }, { snapshot_date: '2026-01-22', build: mk('2026-01-22', { start: '2026-01-07', pct: 60 }, 25) }], current: mk('2026-01-29', { start: '2026-01-07', pct: 60 }, 25) };
}

/** gamingCurrent with an actual start on T2 (20 Jan): the progress is then also out of sequence (T1 is only 60%), as the source's rule reads a progressed T2. */
export function gamingStarted(): Built {
  const b = gaming().current;
  apply(b.db, [{ op: 'update_activity', id: 'T2', actual_start: '2026-01-20 00:00' }]);
  const r = scheduleProjects(b.db, [b.projId], { dataDate: parseP6Date('2026-01-29 00:00')! });
  if (!r.ok) throw new Error('gamingStarted: ' + JSON.stringify(r.findings));
  return b;
}

/** Every logic issue the other fixtures do not have (golden: logicVariety): a lag (C: SS+2), a lead (D: FF-1), SS and FF links, two hard constraints (B Start On = MSO, E Finish On or Before = FNLT; the
 *  soft one on A, Start On or After = SNET, is not hard), and two redundant links of different types (S -> D as SS, D -> F as FS). The source's types map to P6's: milestone = start/finish milestone. */
export const logicVariety = (): Built => project('VARIETY', [
  { id: 'S', duration_days: 0, task_type: 'start_milestone' },
  { id: 'A', duration_days: 4, predecessors: ['S'], constraint: { type: 'start_on_or_after', date: '2026-01-01 00:00' } },
  { id: 'B', duration_days: 4, predecessors: ['A'], constraint: { type: 'start_on', date: '2026-01-15 00:00' } },
  { id: 'C', duration_days: 4, predecessors: ['A:SS+2'] },
  { id: 'D', duration_days: 4, predecessors: ['B', 'C:FF-1', 'S:SS'] },
  { id: 'E', duration_days: 3, predecessors: ['D'], constraint: { type: 'finish_on_or_before', date: '2026-03-01 00:00' } },
  { id: 'F', duration_days: 0, predecessors: ['E', 'D'], task_type: 'milestone' }]);

/** One resource, Crew, with a limit of 1 unit a day, on two concurrent 10-day activities (A, B) and the 5-day C after both. */
export const overAllocated = (): Built => project('OVER', [
  { id: 'A', duration_days: 10, resources: ['Crew'] }, { id: 'B', duration_days: 10, resources: ['Crew'] }, { id: 'C', duration_days: 5, predecessors: ['A', 'B'], resources: ['Crew'] }], { resources: [{ id: 'Crew', max_units_per_day: 1 }] });

/** The planning-horizon fixture (golden: horizon.tasks, the source's tasks with dates): P0 complete before the data date (3-5 Jan), then A..K, resources R on A B D E G I, data date 2026-01-05. Every start and finish is the CPM's
 *  from 5 Jan on the 7-day calendar (so the source's forecast dates and the clone's early dates are the same days). The source's "planned finish" is the project's BASELINE here (a real one, assigned to the project): it was saved from a
 *  schedule in which C had no predecessor A (it finished on day 3), F was 6 days shorter (27 -> 21), I 6 days shorter (10 -> 4) and J 6 days longer (so that J's finish is the same); the project was then changed to what the fixture says and scheduled again, so against the baseline
 *  the forecast finish of C is 10 days later, F 6 and I 6: forecast drift. (The planned dates P6 keeps equal the early dates after a calculation; they are not what drifts.) */
export function horizon(): Built {
  const R = ['A', 'B', 'D', 'E', 'G', 'I'];
  const defs: [string, number, string[]][] = [['A', 10, ['P0']], ['B', 10, ['A']], ['C', 3, ['A']], ['D', 5, ['B', 'C']], ['E', 30, ['D']], ['F', 27, ['D']], ['G', 5, ['E', 'F']], ['H', 10, ['G']], ['I', 10, ['H']], ['J', 20, ['I']], ['K', 5, ['J']]];
  const earlier: Record<string, number> = { F: 21, I: 4, J: 26 }; // (J is 6 days longer there, so that I's change does not move it)
  const b = project('HORIZON', [{ id: 'P0', duration_days: 2 }, ...defs.map(([id, d, p]) => ({ id, duration_days: earlier[id] ?? d, predecessors: id === 'C' ? [] : p, ...(R.includes(id) ? { resources: ['R'] } : {}) }))], {
    start: '2026-01-05', resources: [{ id: 'R', max_units_per_day: 1 }], schedule: false,
    ops: [{ op: 'update_activity', id: 'P0', actual_start: '2026-01-03 00:00', actual_finish: '2026-01-05 00:00' }] });
  const at = { dataDate: parseP6Date('2026-01-05 00:00')! };
  if (!scheduleProjects(b.db, [b.projId], at).ok) throw new Error('horizon: baseline state does not schedule');
  apply(b.db, [{ op: 'save_baseline', name: 'BL', assign_as: 'project' }, { op: 'update_activity', id: 'F', duration_days: 27 }, { op: 'update_activity', id: 'I', duration_days: 10 }, { op: 'update_activity', id: 'J', duration_days: 20 }, { op: 'add_relationship', pred: 'A', succ: 'C', type: 'FS' }]);
  const r = scheduleProjects(b.db, [b.projId], at);
  if (!r.ok) throw new Error('horizon: ' + JSON.stringify(r.findings));
  return b;
}

export const FIXTURES = { cleanChain, withFloat, withLogicIssues, withCycle, delayed, logicVariety, overAllocated } as const;
export type FixtureName = keyof typeof FIXTURES;
/** The status dates the source's tests use with these fixtures. */
export const STATUS_DATE = { delayed: '2026-01-20', gaming: '2026-01-29' } as const;

/** Save a project as an XER file in a folder (a saved update, for the tools that take paths). */
export async function saveXer(b: Built, dir: string, name: string): Promise<string> {
  const { writeXer, NEW_XER_VERSION } = await import('../core/xer/write.ts');
  const path = join(dir, name);
  writeFileSync(path, writeXer(b.db, { version: NEW_XER_VERSION }));
  return path;
}
