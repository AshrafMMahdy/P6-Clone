// Durations and edits of an LOB model. A location's duration = its work ÷ (crews × crew size × productivity × hours per
// day) × its production factor; work = Σ quantity × consumption. Each segment holds one value (its driver: crew, rate
// or duration) and the rest are derived from it, so an edit sets one value, everything else is derived again, and the
// changes are exactly the difference: nothing moves without being reported (the fix for Vico's silent rate/crew swaps).
import { LobRefused, type Driver, type LobChange, type LobModel, type LobSegment, type LobTask, type Timing } from './model.ts';

const r1 = (x: number) => Math.round(x * 10) / 10;
const hpdOf = (t: LobTask) => t.hoursPerDay ?? 8;

/** Work (hours) per location of a task, in its order; a location with no work is absent. */
export function workOf(t: LobTask): Map<string, number> {
  const w = new Map<string, number>();
  for (const it of t.items) for (const q of it.quantities) if (q.quantity > 0) w.set(q.location, (w.get(q.location) ?? 0) + q.quantity * it.consumption);
  return new Map(t.order.filter((c) => (w.get(c) ?? 0) > 0).map((c) => [c, w.get(c)!]));
}
const factorOf = (m: LobModel, t: LobTask, loc: string) => t.factors?.[loc] ?? m.locations.find((l) => l.code === loc)?.factor ?? 1;
const segmentOf = (t: LobTask, loc: string) => { const i = t.order.indexOf(loc); return t.segments.findIndex((s) => i >= t.order.indexOf(s.from) && i <= t.order.indexOf(s.to)); };
const segLocations = (t: LobTask, s: LobSegment) => t.order.slice(t.order.indexOf(s.from), t.order.indexOf(s.to) + 1);
/** the first item's units per working day for one person-hour per hour of the crew */
const unitsPerCrewDay = (t: LobTask, s: LobSegment) => (s.crews * s.crewSize * s.productivity * hpdOf(t)) / (t.items[0]?.consumption || 1);

/** Derive what the driver does not hold: crew size from a held rate or duration (rounded up to whole people), then
 *  the rate. Mutates the segment; returns the duration asked for when rounding means it cannot be met exactly. */
function derive(m: LobModel, t: LobTask, s: LobSegment): void {
  const work = workOf(t);
  const weighted = segLocations(t, s).reduce((n, c) => n + (work.get(c) ?? 0) * factorOf(m, t, c), 0);
  const perPerson = s.crews * s.productivity * hpdOf(t);
  if (s.driver === 'rate' && s.rate) s.crewSize = Math.max(1, Math.ceil((s.rate * (t.items[0]?.consumption || 1)) / perPerson - 1e-9));
  if (s.driver === 'duration' && s.duration) s.crewSize = Math.max(1, Math.ceil(weighted / perPerson / s.duration - 1e-9));
  if (s.driver !== 'rate') s.rate = r1(unitsPerCrewDay(t, s));
}

/** Duration (working days) per location of a task, in its order; a location with no work is absent. */
export function locationDurations(m: LobModel, t: LobTask): Map<string, number> {
  const work = workOf(t), out = new Map<string, number>();
  for (const [c, w] of work) { const s = t.segments[segmentOf(t, c)]; if (!s) continue; out.set(c, (w / (s.crews * s.crewSize * s.productivity * hpdOf(t))) * factorOf(m, t, c)); }
  return out;
}
export const segmentDuration = (m: LobModel, t: LobTask, k: number) => { const d = locationDurations(m, t); return segLocations(t, t.segments[k]).reduce((n, c) => n + (d.get(c) ?? 0), 0); };

/** What can be read and compared about a task, for the change list. */
function snapshot(m: LobModel, t: LobTask): Map<string, number | string | null> {
  const o = new Map<string, number | string | null>();
  t.segments.forEach((s, k) => {
    o.set(`${k}|crews`, s.crews); o.set(`${k}|crew_size`, s.crewSize); o.set(`${k}|productivity`, s.productivity); o.set(`${k}|rate`, s.rate ?? null);
    o.set(`${k}|driver`, s.driver); o.set(`${k}|timing`, s.timing); o.set(`${k}|duration`, r1(segmentDuration(m, t, k)));
  });
  for (const [c, d] of locationDurations(m, t)) o.set(`@${c}|duration`, r1(d));
  for (const c of t.order) o.set(`@${c}|factor`, factorOf(m, t, c));
  for (const it of t.items) { o.set(`#${it.name}|consumption`, it.consumption); for (const q of it.quantities) o.set(`#${it.name}@${q.location}|quantity`, q.quantity); }
  return o;
}
function diff(task: string, a: Map<string, number | string | null>, b: Map<string, number | string | null>): LobChange[] {
  const out: LobChange[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? null, y = b.get(k) ?? null;
    if (x === y) continue;
    const [where, field] = k.split('|');
    const c: LobChange = { task, field, old: x, new: y };
    if (where.startsWith('@')) c.location = where.slice(1);
    else if (where.startsWith('#')) { const [item, loc] = where.slice(1).split('@'); c.field = `${field} (${item})`; if (loc) c.location = loc; }
    else c.segment = Number(where) + 1;
    out.push(c);
  }
  return out;
}

export type LobEdit =
  | { op: 'set_crew'; task: string; segment?: number; crews?: number; crew_size?: number; productivity?: number }
  | { op: 'set_rate'; task: string; segment?: number; rate: number }
  | { op: 'set_duration'; task: string; segment?: number; days: number }
  | { op: 'set_driver'; task: string; segment?: number; driver: Driver }
  | { op: 'set_timing'; task: string; segment?: number; timing: Timing }
  | { op: 'set_quantity'; task: string; item?: string; location: string; quantity: number }
  | { op: 'set_consumption'; task: string; item?: string; consumption: number }
  | { op: 'set_location_duration'; task: string; location: string; days: number }
  | { op: 'set_factor'; task: string; location: string; factor: number }
  | { op: 'split'; task: string; at: string }
  | { op: 'merge'; task: string; at: string };

const held: Record<Driver, string> = { crew: 'the crew is held; change the driver or the crew', rate: 'the rate is held; change the driver or the rate', duration: 'the duration is held; change the driver or the duration' };

/** Apply one edit to a copy of the model: the new model and every value that moved (old → new). Refusals throw
 *  LobRefused with the driver's wording. */
export function edit(m0: LobModel, op: LobEdit): { model: LobModel; changes: LobChange[]; note?: string } {
  // compare against the model as derived, so only what this edit moves is reported
  const m = structuredClone(m0);
  const t = m.tasks.find((x) => x.code === op.task) ?? fail(`No task ${op.task}.`);
  for (const s of t.segments) derive(m, t, s);
  const before = snapshot(m, t);
  const seg = (k?: number) => t.segments[(k ?? 1) - 1] ?? fail(`Task ${t.code} has no segment ${k}.`);
  const item = (name?: string) => (name ? t.items.find((i) => i.name === name) : t.items[0]) ?? fail(`Task ${t.code} has no item ${name ?? ''}.`);
  let note: string | undefined;
  switch (op.op) {
    case 'set_crew': {
      const s = seg(op.segment);
      if (s.driver !== 'crew') throw new LobRefused(held[s.driver]);
      if (op.crews != null) s.crews = positive(op.crews, 'crews', true);
      if (op.crew_size != null) s.crewSize = positive(op.crew_size, 'crew_size', true);
      if (op.productivity != null) s.productivity = positive(op.productivity, 'productivity');
      break;
    }
    case 'set_rate': { const s = seg(op.segment); if (s.driver !== 'rate') throw new LobRefused(held[s.driver]); s.rate = positive(op.rate, 'rate'); break; }
    case 'set_duration': {
      const s = seg(op.segment);
      // dragging a line's end: under the crew driver the crew follows (the driver stays crew)
      if (s.driver === 'rate') throw new LobRefused(held.rate);
      const days = positive(op.days, 'days');
      if (s.driver === 'crew') { s.driver = 'duration'; s.duration = days; derive(m, t, s); s.driver = 'crew'; delete s.duration; } else { s.duration = days; }
      derive(m, t, s);
      const got = segmentDuration(m, t, t.segments.indexOf(s));
      if (Math.abs(got - days) > 0.05) note = `asked ${r1(days)} days, got ${r1(got)}: the crew is whole people`;
      break;
    }
    case 'set_driver': { const s = seg(op.segment); s.driver = op.driver; if (op.driver === 'duration') s.duration = r1(segmentDuration(m, t, t.segments.indexOf(s))); if (op.driver === 'rate') s.rate = r1(unitsPerCrewDay(t, s)); break; }
    case 'set_timing': seg(op.segment).timing = op.timing; break;
    case 'set_quantity': {
      if (!t.order.includes(op.location)) fail(`Task ${t.code} does not run in ${op.location}.`);
      const it = item(op.item), q = it.quantities.find((x) => x.location === op.location);
      const v = nonNegative(op.quantity, 'quantity');
      if (q) q.quantity = v; else it.quantities.push({ location: op.location, quantity: v });
      break;
    }
    case 'set_consumption': item(op.item).consumption = positive(op.consumption, 'consumption'); break;
    case 'set_location_duration': {
      const base = locationDurations({ ...m, tasks: [{ ...t, factors: { ...t.factors, [op.location]: 1 } }] }, { ...t, factors: { ...t.factors, [op.location]: 1 } }).get(op.location);
      if (!base) fail(`Task ${t.code} has no work in ${op.location}: set a quantity there first.`);
      (t.factors ??= {})[op.location] = positive(op.days, 'days') / base;
      break;
    }
    case 'set_factor': { if (!t.order.includes(op.location)) fail(`Task ${t.code} does not run in ${op.location}.`); (t.factors ??= {})[op.location] = positive(op.factor, 'factor'); break; }
    case 'split': {
      const i = t.order.indexOf(op.at);
      const k = segmentOf(t, op.at);
      if (i <= 0 || k < 0 || t.segments[k].from === op.at) fail(`Split ${t.code} at a location inside a segment (not its first): ${op.at} is not one.`);
      const s = t.segments[k];
      t.segments.splice(k + 1, 0, { ...structuredClone(s), from: op.at });
      s.to = t.order[i - 1];
      break;
    }
    case 'merge': {
      const k = t.segments.findIndex((s) => s.from === op.at);
      if (k <= 0) fail(`Merge at the first location of a segment that has one before it: ${op.at} is not one.`);
      t.segments[k - 1].to = t.segments[k].to;
      t.segments.splice(k, 1);
      break;
    }
  }
  for (const s of t.segments) derive(m, t, s);
  return { model: m, changes: diff(t.code, before, snapshot(m, t)), ...(note ? { note } : {}) };
}

function fail(msg: string): never { throw new LobRefused(msg); }
const positive = (v: number, what: string, whole = false) => { if (!(Number.isFinite(v) && v > 0) || (whole && !Number.isInteger(v))) fail(`${what} must be a ${whole ? 'whole number above 0' : 'number above 0'}.`); return v; };
const nonNegative = (v: number, what: string) => { if (!(Number.isFinite(v) && v >= 0)) fail(`${what} must be 0 or more.`); return v; };
