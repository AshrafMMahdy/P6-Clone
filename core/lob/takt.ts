// Takt as options on an LOB plan: zones (a location level, or sets of locations), a takt time, the train (trades in
// order) and buffer periods. The check names every trade × zone that does not fit the takt and what would make it
// fit; apply sizes each trade's crew to fit, holds every zone to exactly one takt period (production factors), paces
// the trades, and links the train zone by zone with the buffer. Every value it moves is reported.
import { edit, locationDurations } from './edit.ts';
import { locationsAt, type LobChange, type LobLink, type LobModel, type LobTask } from './model.ts';

export interface TaktMisfit { task: string; zone: string; days: number; takt: number; fix: string }

/** The zones: given, else the locations of the zone level (default the coarsest level the trades run at). */
export function taktZones(m: LobModel): { code: string; locations: string[] }[] {
  const k = m.takt;
  if (k?.zones?.length) return k.zones;
  const level = k?.zoneLevel ?? Math.min(...m.tasks.map((t) => t.precision));
  const parent = new Map(m.locations.map((l) => [l.code, l.parent]));
  const zoneOf = (c: string) => { let x: string | null = c; while (x && m.locations.find((l) => l.code === x)!.level > level) x = parent.get(x) ?? null; return x ?? c; };
  return locationsAt(m, level).map((z) => ({ code: z.code, locations: m.locations.filter((l) => zoneOf(l.code) === z.code).map((l) => l.code) }));
}
const zoneDays = (m: LobModel, t: LobTask, zone: string[]) => { const d = locationDurations(m, t); return zone.reduce((n, c) => n + (d.get(c) ?? 0), 0); };
const trainOf = (m: LobModel) => (m.takt?.train?.length ? m.takt.train : m.tasks.map((t) => t.code)).map((c) => m.tasks.find((t) => t.code === c)).filter((t): t is LobTask => !!t);

export function taktCheck(m: LobModel): { fits: boolean; misfits: TaktMisfit[] } {
  const takt = m.takt?.taktDays;
  if (!takt) throw new Error('No takt time set (takt.taktDays).');
  const misfits: TaktMisfit[] = [];
  for (const t of trainOf(m)) for (const z of taktZones(m)) {
    const days = zoneDays(m, t, z.locations);
    if (days <= takt + 0.005) continue;
    const s = t.segments.find((g) => z.locations.includes(g.from) || z.locations.some((c) => t.order.indexOf(c) >= t.order.indexOf(g.from) && t.order.indexOf(c) <= t.order.indexOf(g.to)))!;
    const need = Math.ceil((s.crewSize * days) / takt - 1e-9);
    misfits.push({ task: t.code, zone: z.code, days: Math.round(days * 100) / 100, takt, fix: `crew ${s.crewSize} → ${need} people, or split ${z.code} into smaller zones` });
  }
  return { fits: !misfits.length, misfits };
}

/** Make the plan run on the takt: crews sized to fit, each zone one takt period, trades paced and linked as a train. */
export function taktApply(m0: LobModel): { model: LobModel; changes: LobChange[] } {
  const takt = m0.takt?.taktDays;
  if (!takt) throw new Error('No takt time set (takt.taktDays).');
  let m = structuredClone(m0);
  const changes: LobChange[] = [];
  const run = (op: Parameters<typeof edit>[1]) => { const r = edit(m, op); m = r.model; changes.push(...r.changes); };
  const zones = taktZones(m);
  for (const t0 of trainOf(m)) {
    // crews: the size the slowest zone needs (whole people), on each segment
    for (const [k, s] of t0.segments.entries()) {
      if (s.driver !== 'crew') run({ op: 'set_driver', task: t0.code, segment: k + 1, driver: 'crew' });
      const t = m.tasks.find((x) => x.code === t0.code)!, seg = t.segments[k];
      const worst = Math.max(...zones.map((z) => zoneDays(m, t, z.locations.filter((c) => t.order.indexOf(c) >= t.order.indexOf(seg.from) && t.order.indexOf(c) <= t.order.indexOf(seg.to)))));
      if (worst > takt + 0.005) run({ op: 'set_crew', task: t.code, segment: k + 1, crew_size: Math.ceil((seg.crewSize * worst) / takt - 1e-9) });
      if (t.segments[k].timing !== 'paced') run({ op: 'set_timing', task: t.code, segment: k + 1, timing: 'paced' });
    }
    // each zone exactly one takt period: its locations stretched in proportion
    const t = m.tasks.find((x) => x.code === t0.code)!;
    for (const z of zones) {
      const d = locationDurations(m, t), days = zoneDays(m, t, z.locations);
      if (!days || Math.abs(days - takt) < 0.005) continue;
      for (const c of z.locations) if (d.has(c)) run({ op: 'set_location_duration', task: t.code, location: c, days: (d.get(c)! * takt) / days });
    }
  }
  // the train: each trade after the one before, zone by zone, with the buffer in takt periods
  const train = trainOf(m), level = m.takt?.zoneLevel ?? Math.min(...m.tasks.map((t) => t.precision));
  for (let k = 1; k < train.length; k++) {
    const pred = train[k - 1].code, succ = train[k].code, lagDays = (m.takt?.bufferPeriods ?? 0) * takt;
    const link: LobLink = { kind: 'task', pred, succ, type: 'FS', lagDays, precision: level };
    const i = m.links.findIndex((l) => l.kind === 'task' && l.pred === pred && l.succ === succ);
    if (i < 0) { m.links.push(link); changes.push({ task: succ, field: 'link', old: null, new: `${pred} FS +${lagDays}d by zone` }); }
    else if (m.links[i].lagDays !== lagDays || m.links[i].precision !== level) { changes.push({ task: succ, field: 'link', old: `${pred} ${m.links[i].type} +${m.links[i].lagDays}d`, new: `${pred} FS +${lagDays}d by zone` }); m.links[i] = link; }
  }
  return { model: m, changes };
}
