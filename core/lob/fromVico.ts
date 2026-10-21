// A Vico Schedule Planner project as an LOB model: its location breakdown (the single root dropped), its tasks with
// their quantities, consumption and crews, one segment per Vico line with that line's start, and its calendar (work
// week and yearly holidays) as operations that create it. Vico's files carry no logic in the samples seen; the
// reader's notes say so and travel with the import.
import { maxOf, minOf } from '../arrays.ts';
import type { VicoCalendar, VicoProject } from './vico.ts';
import type { LobLocation, LobModel, LobTask } from './model.ts';

const DAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The holidays of a Vico calendar for the years given, as dates. */
export function vicoHolidays(c: VicoCalendar, from: number, to: number): string[] {
  const out: string[] = [];
  for (let y = from; y <= to; y++) for (const h of c.holidays) {
    if (h.rule === 'fixed') out.push(iso(new Date(Date.UTC(y, h.month - 1, h.day))));
    else if (h.rule === 'weekdayOnOrAfter' && h.weekday != null) { const d = new Date(Date.UTC(y, h.month - 1, h.day)); while ((d.getUTCDay() + 6) % 7 !== h.weekday) d.setUTCDate(d.getUTCDate() + 1); out.push(iso(d)); }
  }
  return [...new Set(out)].sort();
}

/** The calendar operation (add_calendar) for a Vico calendar. */
export function vicoCalendarOp(c: VicoCalendar, name: string, years: [number, number]): Record<string, unknown> {
  const work_week = Object.fromEntries(c.week.map((w, k) => { const [h, m] = w.start.split(':').map(Number), s = h * 60 + m; return [DAY[k], w.hours ? [[hm(s), hm(s + w.hours * 60)]] : []]; }));
  return { op: 'add_calendar', name, work_week, holidays: vicoHolidays(c, years[0], years[1]) };
}

export function lobFromVico(v: VicoProject, project: string): { model: LobModel; hoursPerDay: number; calendar?: VicoCalendar; notes: string[] } {
  const notes = [...v.notes];
  // a single root location (the building) is the project itself: its children are the top level
  const roots = v.locations.filter((l) => !l.parent);
  const dropRoot = roots.length === 1;
  const shift = dropRoot ? 1 : 0, minLevel = minOf(v.locations.map((l) => l.level));
  const locations: LobLocation[] = v.locations.filter((l) => !(dropRoot && l === roots[0])).map((l) => ({ code: l.code, name: /^\d+$/.test(l.name) ? `${(v.levels[l.level] ?? 'Location').replace(/s$/, '')} ${l.name}` : l.name, level: l.level - minLevel + 1 - shift, parent: dropRoot && l.parent === roots[0].code ? null : l.parent }));
  const levels = v.levels.slice(minLevel + shift);
  const level = new Map(locations.map((l) => [l.code, l.level]));
  const kids = (code: string) => locations.filter((l) => l.parent === code).map((l) => l.code);
  const leavesUnder = (code: string): string[] => { const k = kids(code); return k.length ? k.flatMap(leavesUnder) : [code]; };
  const cal = (v.calendars as VicoCalendar[] | undefined)?.[0];
  const hoursPerDay = cal?.week.find((w) => w.hours)?.hours ?? 8;
  const tasks: LobTask[] = v.tasks.map((t) => {
    // the task runs where its quantities are (Vico's lines go through the floors of their part)
    const qLocs = [...new Set(t.items.flatMap((i) => i.quantities.map((q) => q.location)))].filter((c) => level.has(c));
    const precision = qLocs.length ? maxOf(qLocs.map((c) => level.get(c)!)) : (level.get(t.locations[0]) ?? 1);
    const lines = t.lines?.length ? t.lines : t.locations.map((location) => ({ location, start: t.start }));
    const order: string[] = [];
    const factors: Record<string, number> = {};
    const first = t.items[0];
    const segments = lines.map((ln) => {
      const locs = (level.get(ln.location) === precision ? [ln.location] : leavesUnder(ln.location)).filter((c) => level.get(c) === precision);
      order.push(...locs);
      // Vico's hours: quantity × base consumption ÷ the line's productivity factor; the clone's: quantity × the
      // task's consumption × the location's factor
      const lf = Number((ln as { factor?: number }).factor) || 0;
      if (lf && first?.baseConsumption && first.consumption) for (const c of locs) factors[c] = first.baseConsumption / (lf * first.consumption);
      return { from: locs[0], to: locs.at(-1)!, crews: 1, crewSize: t.crew?.size ?? 1, productivity: 1, driver: 'crew' as const, timing: 'asap_paced' as const, ...(ln.start ? { start: ln.start } : {}) };
    }).filter((s) => s.from);
    return { code: t.code, name: t.name.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a: string, b: string) => a + b.toLowerCase()), trade: t.crew?.name ?? t.code, precision, order, items: t.items.map((i) => ({ name: i.name, unit: i.unit, consumption: i.consumption, quantities: i.quantities.filter((q) => level.get(q.location) === precision) })), segments, hoursPerDay, ...(Object.keys(factors).length ? { factors } : {}) };
  });
  if (!cal) notes.push('no calendar decoded: the project calendar is used');
  return { model: { version: 1, project, levels, locations, tasks, links: v.links.map((l) => ({ kind: 'task', pred: l.pred, succ: l.succ, type: (['FS', 'SS', 'FF', 'SF'].includes(l.type) ? l.type : 'FS') as 'FS', lagDays: l.lagDays, ...(l.locationLag ? { locationLag: l.locationLag } : {}), ...(l.bufferDays ? { bufferDays: l.bufferDays } : {}) })) }, hoursPerDay, ...(cal ? { calendar: cal } : {}), notes };
}
