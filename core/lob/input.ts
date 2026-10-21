// What an agent (or the desktop) sends, turned into the model: locations as a grid ({levels, counts}), a tree or a flat
// list; tasks in a compact form; and the edit operations that change the structure (locations, tasks, order, links,
// takt) beside the driver-matrix edits of edit.ts. Every operation's changes are collected.
import { edit, type LobEdit } from './edit.ts';
import { check, locationsAt, LobRefused, MAX_LEVELS, type Driver, type LobChange, type LobLink, type LobLocation, type LobModel, type LobTakt, type LobTask, type Timing } from './model.ts';

export interface LocationsInput { levels: string[]; grid?: number[]; tree?: TreeNode[]; list?: LobLocation[] }
interface TreeNode { code: string; name?: string; children?: TreeNode[] }
export interface TaskInput {
  code: string; name: string; trade?: string;
  /** the level it runs at: a level name or number (default the deepest) */
  level?: string | number;
  /** its locations in working order (default every location of its level, in tree order) */
  locations?: string[];
  unit?: string;
  /** hours per unit */
  consumption: number;
  /** the same quantity in every location, or per location */
  quantity?: number; quantities?: Record<string, number>;
  crew_size: number; crews?: number; productivity?: number;
  driver?: Driver; rate?: number; duration_days?: number; timing?: Timing;
  hours_per_day?: number; calendar?: string;
}

/** Locations from a grid (codes P1, P1F2...: the first letter of each level and the number), a tree or a list. */
export function buildLocations(i: LocationsInput): LobLocation[] {
  if (!i.levels?.length || i.levels.length > MAX_LEVELS) throw new LobRefused(`levels: 1 to ${MAX_LEVELS} names, e.g. ["Part", "Floor"].`);
  if (i.list) return i.list;
  const out: LobLocation[] = [];
  if (i.grid) {
    if (i.grid.length !== i.levels.length) throw new LobRefused('grid: one count per level, e.g. {"levels": ["Part", "Floor"], "grid": [2, 9]}.');
    const walk = (parent: LobLocation | null, level: number) => { for (let k = 1; k <= i.grid![level - 1]; k++) { const code = `${parent?.code ?? ''}${i.levels[level - 1][0].toUpperCase()}${k}`; const l = { code, name: `${i.levels[level - 1]} ${k}`, level, parent: parent?.code ?? null }; out.push(l); if (level < i.levels.length) walk(l, level + 1); } };
    walk(null, 1);
    return out;
  }
  const walk = (nodes: TreeNode[], parent: string | null, level: number) => { for (const n of nodes) { out.push({ code: n.code, name: n.name ?? n.code, level, parent }); if (n.children) walk(n.children, n.code, level + 1); } };
  walk(i.tree ?? [], null, 1);
  return out;
}

export function buildTask(m: LobModel, i: TaskInput): LobTask {
  const level = typeof i.level === 'number' ? i.level : typeof i.level === 'string' ? m.levels.findIndex((l) => l.toLowerCase() === i.level!.toString().toLowerCase()) + 1 : m.levels.length;
  if (level < 1 || level > m.levels.length) throw new LobRefused(`Task ${i.code}: no level ${i.level} (levels: ${m.levels.join(', ')}).`);
  const order = i.locations ?? locationsAt(m, level).map((l) => l.code);
  const quantities = order.map((location) => ({ location, quantity: i.quantities?.[location] ?? i.quantity ?? 0 }));
  if (!Number.isFinite(i.consumption) || i.consumption <= 0) throw new LobRefused(`Task ${i.code}: consumption (hours per unit) must be above 0.`);
  const t: LobTask = {
    code: i.code, name: i.name, trade: i.trade ?? i.name, precision: level, order,
    items: [{ name: i.name, unit: i.unit ?? '', consumption: i.consumption, quantities }],
    segments: [{ from: order[0], to: order.at(-1)!, crews: i.crews ?? 1, crewSize: i.crew_size, productivity: i.productivity ?? 1, driver: i.driver ?? 'crew', ...(i.rate ? { rate: i.rate } : {}), ...(i.duration_days ? { duration: i.duration_days } : {}), timing: i.timing ?? 'asap_paced' }],
    ...(i.hours_per_day ? { hoursPerDay: i.hours_per_day } : {}), ...(i.calendar ? { calendar: i.calendar } : {}),
  };
  return t;
}

export type LobOp = LobEdit
  | { op: 'add_location'; code: string; name?: string; parent?: string | null; after?: string }
  | { op: 'remove_location'; code: string }
  | ({ op: 'add_task' } & TaskInput)
  | { op: 'remove_task'; task: string }
  | { op: 'set_order'; task: string; order: string[] }
  | ({ op: 'add_link' } & Partial<LobLink> & { pred: string; succ: string; type?: LobLink['type']; lag_days?: number; location_lag?: number; buffer_days?: number; buffer_locations?: number; pred_location?: string; succ_location?: string })
  | { op: 'remove_link'; pred: string; succ: string }
  | { op: 'set_start'; task: string; segment?: number; date: string | null }
  | ({ op: 'set_takt' } & { takt_days: number; zone_level?: number; zones?: LobTakt['zones']; train?: string[]; buffer_periods?: number });

/** Apply operations in order; the model, every change, and notes. A refused operation refuses the list. */
export function applyLobOps(m0: LobModel, ops: LobOp[]): { model: LobModel; changes: LobChange[]; notes: string[] } {
  let m = structuredClone(m0);
  const changes: LobChange[] = [], notes: string[] = [];
  for (const [k, op] of ops.entries()) {
    try {
      switch (op.op) {
        case 'add_location': {
          if (m.locations.some((l) => l.code === op.code)) throw new LobRefused(`A location ${op.code} exists.`);
          const parent = op.parent ? m.locations.find((l) => l.code === op.parent) ?? (() => { throw new LobRefused(`No location ${op.parent}.`); })() : null;
          const loc = { code: op.code, name: op.name ?? op.code, level: parent ? parent.level + 1 : 1, parent: parent?.code ?? null };
          const at = op.after ? m.locations.findIndex((l) => l.code === op.after) + 1 : m.locations.length;
          m.locations.splice(at || m.locations.length, 0, loc);
          // tasks at that level take it after the location it follows (else at the end), with no quantity yet
          for (const t of m.tasks) if (t.precision === loc.level) { const i = op.after ? t.order.indexOf(op.after) + 1 : t.order.length; t.order.splice(i || t.order.length, 0, loc.code); const last = t.segments.find((s) => s.to === op.after); if (last) last.to = loc.code; else if (!op.after) t.segments.at(-1)!.to = loc.code; changes.push({ task: t.code, location: loc.code, field: 'location', old: null, new: 'added (no quantity yet)' }); }
          break;
        }
        case 'remove_location': {
          const kids = m.locations.filter((l) => l.parent === op.code);
          if (kids.length) throw new LobRefused(`${op.code} has locations under it; remove those first.`);
          for (const t of m.tasks) {
            const i = t.order.indexOf(op.code);
            if (i < 0) continue;
            for (const s of t.segments) { if (s.from === op.code) s.from = t.order[i + 1]; if (s.to === op.code) s.to = t.order[i - 1]; }
            t.segments = t.segments.filter((s) => s.from && s.to && t.order.indexOf(s.from) <= t.order.indexOf(s.to));
            t.order.splice(i, 1);
            for (const it of t.items) it.quantities = it.quantities.filter((q) => q.location !== op.code);
            changes.push({ task: t.code, location: op.code, field: 'location', old: 'present', new: null });
          }
          m.locations = m.locations.filter((l) => l.code !== op.code);
          break;
        }
        case 'add_task': { if (m.tasks.some((t) => t.code === op.code)) throw new LobRefused(`A task ${op.code} exists.`); const { op: _o, ...input } = op; m.tasks.push(buildTask(m, input as TaskInput)); changes.push({ task: op.code, field: 'task', old: null, new: op.name }); break; }
        case 'remove_task': { m.tasks = m.tasks.filter((t) => t.code !== op.task); m.links = m.links.filter((l) => l.pred !== op.task && l.succ !== op.task); changes.push({ task: op.task, field: 'task', old: op.task, new: null }); break; }
        case 'set_order': {
          const t = m.tasks.find((x) => x.code === op.task) ?? (() => { throw new LobRefused(`No task ${op.task}.`); })();
          if ([...op.order].sort().join() !== [...t.order].sort().join()) throw new LobRefused(`set_order gives ${op.task}'s locations in a new order: the same locations, each once.`);
          changes.push({ task: t.code, field: 'order', old: t.order.join(' '), new: op.order.join(' ') });
          t.order = [...op.order];
          t.segments = [{ ...t.segments[0], from: t.order[0], to: t.order.at(-1)! }];
          if (m0.tasks.find((x) => x.code === op.task)!.segments.length > 1) notes.push(`${op.task}: its segments were merged into one by the new order; split it again where needed.`);
          break;
        }
        case 'add_link': {
          const link: LobLink = { kind: op.pred_location || op.succ_location ? 'location' : (op.kind ?? 'task'), pred: op.pred, succ: op.succ, type: op.type ?? 'FS', lagDays: op.lag_days ?? op.lagDays ?? 0, ...(op.precision ? { precision: op.precision } : {}), ...((op.location_lag ?? op.locationLag) ? { locationLag: op.location_lag ?? op.locationLag } : {}), ...((op.buffer_days ?? op.bufferDays) ? { bufferDays: op.buffer_days ?? op.bufferDays } : {}), ...((op.buffer_locations ?? op.bufferLocations) ? { bufferLocations: op.buffer_locations ?? op.bufferLocations } : {}), ...((op.pred_location ?? op.predLocation) ? { predLocation: op.pred_location ?? op.predLocation } : {}), ...((op.succ_location ?? op.succLocation) ? { succLocation: op.succ_location ?? op.succLocation } : {}), ...(op.project ? { project: op.project } : {}) };
          m.links = m.links.filter((l) => !(l.pred === link.pred && l.succ === link.succ && l.kind === link.kind && l.predLocation === link.predLocation && l.succLocation === link.succLocation));
          m.links.push(link);
          changes.push({ task: link.succ, field: 'link', old: null, new: `${link.pred}${link.predLocation ? `@${link.predLocation}` : ''} ${link.type}${link.lagDays ? ` +${link.lagDays}d` : ''}${link.locationLag ? `, location lag ${link.locationLag}` : ''}` });
          break;
        }
        case 'remove_link': { const n = m.links.length; m.links = m.links.filter((l) => !(l.pred === op.pred && l.succ === op.succ)); if (n === m.links.length) throw new LobRefused(`No link ${op.pred} → ${op.succ}.`); changes.push({ task: op.succ, field: 'link', old: op.pred, new: null }); break; }
        case 'set_start': { const t = m.tasks.find((x) => x.code === op.task) ?? (() => { throw new LobRefused(`No task ${op.task}.`); })(); const s = t.segments[(op.segment ?? 1) - 1] ?? (() => { throw new LobRefused(`${op.task} has no segment ${op.segment}.`); })(); changes.push({ task: t.code, segment: op.segment ?? 1, field: 'start', old: s.start ?? null, new: op.date }); if (op.date) s.start = op.date; else delete s.start; break; }
        case 'set_takt': { m.takt = { taktDays: op.takt_days, ...(op.zone_level ? { zoneLevel: op.zone_level } : {}), ...(op.zones ? { zones: op.zones } : {}), ...(op.train ? { train: op.train } : {}), ...(op.buffer_periods != null ? { bufferPeriods: op.buffer_periods } : {}) }; changes.push({ task: '', field: 'takt', old: m0.takt?.taktDays ?? null, new: op.takt_days }); break; }
        default: { const r = edit(m, op as LobEdit); m = r.model; changes.push(...r.changes); if (r.note) notes.push(`${(op as LobEdit).task}: ${r.note}`); }
      }
    } catch (e) { throw new LobRefused(`operation ${k + 1} (${op.op}): ${(e as Error).message}`); }
  }
  const problems = check(m);
  if (problems.length) throw new LobRefused(`The plan would not hold together: ${problems.slice(0, 5).join(' ')}`);
  return { model: m, changes, notes };
}
