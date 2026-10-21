// The LOB model: locations (a tree of up to 6 levels), tasks (a trade's work through its locations, in segments with
// their own crew and driver), quantities, logic and takt. It is the source of the LOB project's structure; expand.ts
// turns it into ordinary activities and relationships, and F9 schedules them. Pure data and arithmetic.

export const MAX_LEVELS = 6;
export type Driver = 'crew' | 'rate' | 'duration';
export type Timing = 'asap' | 'paced' | 'asap_paced';

export interface LobLocation { code: string; name: string; level: number; parent: string | null; factor?: number }
export interface LobQuantity { location: string; quantity: number }
/** A bill-of-quantities item: consumption in hours per unit, quantity per location. */
export interface LobItem { name: string; unit: string; consumption: number; quantities: LobQuantity[] }
/** A stretch of a task's location order (from..to, inclusive) worked by one crew set-up. */
export interface LobSegment {
  from: string; to: string;
  crews: number; crewSize: number; productivity: number;
  driver: Driver;
  /** units of the task's first item per working day, held when driver = rate */
  rate?: number;
  /** total working days of the segment, held when driver = duration */
  duration?: number;
  timing: Timing;
}
export interface LobTask {
  code: string; name: string; trade: string;
  /** the location level the task runs at (1 = the top level) */
  precision: number;
  /** its locations, in the order the crew works them */
  order: string[];
  items: LobItem[];
  segments: LobSegment[];
  /** production factor per location (learning curve, difficulty), default the location's, else 1 */
  factors?: Record<string, number>;
  hoursPerDay?: number;
  calendar?: string;
}
export interface LobLink {
  /** task: in every location both tasks share (layer 1); location: one task-location to another (layer 5) */
  kind: 'task' | 'location';
  pred: string; succ: string;
  type: 'FS' | 'SS' | 'FF' | 'SF';
  lagDays: number;
  /** the level the link holds at, coarser than the tasks (layer 2) */
  precision?: number;
  /** +1: the location below must be done (layer 4) */
  locationLag?: number;
  bufferDays?: number;
  bufferLocations?: number;
  predLocation?: string; succLocation?: string;
  /** a task of another project (a CPM project or another LOB project) */
  project?: string;
}
export interface LobTakt { zoneLevel?: number; zones?: { code: string; locations: string[] }[]; taktDays: number; train?: string[]; bufferPeriods?: number }
export interface LobModel { version: 1; project: string; levels: string[]; locations: LobLocation[]; tasks: LobTask[]; links: LobLink[]; takt?: LobTakt }

export interface LobChange { task: string; segment?: number; location?: string; field: string; old: number | string | null; new: number | string | null }
export class LobRefused extends Error {}

export const emptyModel = (project: string, levels: string[]): LobModel => ({ version: 1, project, levels, locations: [], tasks: [], links: [] });

/** The model is consistent: levels, a tree of known parents, task orders of locations at the task's level, segments
 *  covering the order. Returns the problems (empty = fine). */
export function check(m: LobModel): string[] {
  const out: string[] = [];
  if (!m.levels.length || m.levels.length > MAX_LEVELS) out.push(`A location tree has 1 to ${MAX_LEVELS} levels, not ${m.levels.length}.`);
  const loc = new Map(m.locations.map((l) => [l.code, l]));
  if (loc.size !== m.locations.length) out.push('Two locations share a code.');
  for (const l of m.locations) {
    if (l.level < 1 || l.level > m.levels.length) out.push(`Location ${l.code} is at level ${l.level}; the tree has ${m.levels.length}.`);
    if (l.level > 1 && !(l.parent && loc.get(l.parent)?.level === l.level - 1)) out.push(`Location ${l.code} (level ${l.level}) needs a parent at level ${l.level - 1}.`);
  }
  const codes = new Set<string>();
  for (const t of m.tasks) {
    if (codes.has(t.code)) out.push(`Two tasks share the code ${t.code}.`);
    codes.add(t.code);
    for (const c of t.order) if (loc.get(c)?.level !== t.precision) out.push(`Task ${t.code} runs at level ${t.precision}, but ${c} is not a location of that level.`);
    let at = 0;
    for (const [k, s] of t.segments.entries()) {
      const a = t.order.indexOf(s.from), b = t.order.indexOf(s.to);
      if (a !== at || b < a) out.push(`Task ${t.code} segment ${k + 1} (${s.from}..${s.to}) does not follow on from the one before.`);
      at = b + 1;
    }
    if (t.order.length && at !== t.order.length) out.push(`Task ${t.code}'s segments do not cover its locations.`);
  }
  for (const l of m.links) for (const c of [l.pred, l.succ]) if (!l.project && !codes.has(c)) out.push(`A link names the task ${c}, which the model does not have.`);
  return out;
}

/** The locations of a level, in tree order (depth first, children in their listed order). */
export function locationsAt(m: LobModel, level: number): LobLocation[] {
  const kids = new Map<string | null, LobLocation[]>();
  for (const l of m.locations) (kids.get(l.parent) ?? kids.set(l.parent, []).get(l.parent)!).push(l);
  const out: LobLocation[] = [];
  const walk = (p: string | null) => { for (const l of kids.get(p) ?? []) { if (l.level === level) out.push(l); else walk(l.code); } };
  walk(null);
  return out;
}

/** The location codes from the top down to this one (for codes and the flowline's Y axis). */
export function pathOf(m: LobModel, code: string): string[] {
  const loc = new Map(m.locations.map((l) => [l.code, l]));
  const out: string[] = [];
  for (let c: string | null = code; c; c = loc.get(c)?.parent ?? null) out.unshift(c);
  return out;
}
