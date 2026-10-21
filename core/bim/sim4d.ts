// 4D simulation: where each linked element stands on a date, from the schedule's own dates (F9: calendars, actuals,
// data date). Sources follow SYNCHRO's "dates to use" in P6 terms: planned (P6 Planned Start/Finish), actual (actual
// dates only), best (actuals up to the data date, the remaining early dates after: P6's Start/Finish), late (late
// dates), or a baseline (any saved baseline by name). Task types follow Navisworks: built elements appear while their
// activity runs and stay; removed ones show while it runs and disappear; temporary ones appear and then disappear.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { baselineOf } from '../analysis/common.ts';
import { isCritical, makeCtx } from '../project/ctx.ts';
import { linkMaps, T4D, type Role } from './link4d.ts';
import type { IfcElement, IfcIndex } from './parse.ts';
import { ordinalOf } from './lookup.ts';

export type State = 'not_started' | 'in_progress' | 'complete' | 'removed' | 'temporary';
export interface Span { start: number | null; finish: number | null }

/** An activity's dates from a source (minutes, P6 style). */
export function spanOf(t: Row | undefined, source: string): Span {
  if (!t) return { start: null, finish: null };
  const d = (s?: string) => parseP6Date(s ?? '');
  switch (source) {
    case 'planned': return { start: d(t.target_start_date || t.early_start_date), finish: d(t.target_end_date || t.early_end_date) };
    case 'actual': return { start: d(t.act_start_date), finish: d(t.act_end_date) };
    case 'late': return { start: d(t.act_start_date || t.late_start_date), finish: d(t.act_end_date || t.late_end_date) };
    default: return { start: d(t.act_start_date || t.restart_date || t.early_start_date || t.target_start_date), finish: d(t.act_end_date || t.reend_date || t.early_end_date || t.target_end_date) };
  }
}

/** The activity rows a source reads: the project's, or a baseline's matched by Activity ID. */
export function sourceTasks(db: Db, projId: string, source: string): { get: (taskId: string) => Row | undefined; label: string; kind: string } {
  const cur = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_id, t]));
  if (['planned', 'actual', 'best', 'late'].includes(source)) return { get: (id) => cur.get(id), label: source, kind: source };
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  const bl = baselineOf(db, proj, source.replace(/^baseline:/i, ''));
  if (!bl) throw new Error(`No baseline "${source.replace(/^baseline:/i, '')}". Use planned, actual, best, late, or a saved baseline's name.`);
  return { get: (id) => { const c = cur.get(id); return c ? bl.tasks.get(c.task_code) : undefined; }, label: `baseline ${bl.name}`, kind: 'baseline' };
}

export function stateAt(span: Span, role: Role, at: number): State {
  const { start, finish } = span;
  if (start == null || at < start) return 'not_started';
  const done = finish != null && at >= finish;
  if (role === 'removed') return done ? 'removed' : 'in_progress';
  if (role === 'temporary') return done ? 'removed' : 'temporary';
  return done ? 'complete' : 'in_progress';
}

/** Element-level progress recorded on site (set_element_status), latest record up to the date. */
function statusOverrides(db: Db, projId: string) {
  const by = new Map<string, { status: string; at: number }[]>();
  for (const r of rows(db, T4D.status).filter((x) => x.proj_id === projId)) { const at = parseP6Date(r.date); if (at != null) (by.get(r.guid) ?? by.set(r.guid, []).get(r.guid)!).push({ status: r.status, at }); }
  for (const l of by.values()) l.sort((a, b) => a.at - b.at);
  return (guid: string, at: number): State | null => { const l = by.get(guid); if (!l) return null; let s: string | null = null; for (const x of l) if (x.at <= at) s = x.status; return s === 'installed' ? 'complete' : s === 'in_progress' ? 'in_progress' : s === 'not_installed' ? 'not_started' : null; };
}

/** One element's state from all its links: a removal or temporary use overrides, else the most advanced built link. */
export function elementState(links: { task_id: string; role: Role }[], get: (id: string) => Row | undefined, source: string, at: number): State {
  let built: State = 'not_started';
  const rank: Record<State, number> = { not_started: 0, in_progress: 1, complete: 2, removed: 3, temporary: 1 };
  for (const l of links) {
    const s = stateAt(spanOf(get(l.task_id), source === 'actual' || source === 'planned' || source === 'late' ? source : 'best'), l.role, at);
    if (l.role !== 'built' && s !== 'not_started') return s;
    if (rank[s] > rank[built]) built = s;
  }
  return built;
}

export interface SimFrame { date: string; counts: Record<State | 'unlinked', number>; by?: Record<string, Partial<Record<State | 'unlinked', number>>>; active: { id: string; name: string; start: string | null; finish: string | null; elements: number; share: number }[] }

/** Element counts by state at each date (from, to, step in days), optionally by storey or class, and the activities
 *  under way in each step. */
export function simulate(db: Db, projId: string, ix: IfcIndex, o: { source?: string; dates: number[]; by?: 'storey' | 'class'; stepDays?: number }): { source: string; frames: SimFrame[] } {
  const src = sourceTasks(db, projId, o.source ?? 'best');
  const { byGuid, byTask } = linkMaps(db, projId);
  const over = statusOverrides(db, projId);
  const tasks = rows(db, 'TASK').filter((t) => t.proj_id === projId);
  const kind = src.kind === 'baseline' ? 'best' : src.kind;
  const frames = o.dates.map((at): SimFrame => {
    const counts = { not_started: 0, in_progress: 0, complete: 0, removed: 0, temporary: 0, unlinked: 0 } as SimFrame['counts'];
    const by: SimFrame['by'] = o.by ? {} : undefined;
    for (const e of ix.elements) {
      const ls = byGuid.get(e.guid);
      let s: State | 'unlinked' = ls ? elementState(ls, src.get, kind, at) : 'unlinked';
      if (ls && (kind === 'actual' || kind === 'best')) s = over(e.guid, at) ?? s;
      counts[s]++;
      if (by) { const k = (o.by === 'storey' ? e.storey : e.ifcClass) || '(none)'; const g = by[k] ?? (by[k] = {}); g[s] = (g[s] ?? 0) + 1; }
    }
    const w0 = at - (o.stepDays ?? 7) * 1440;
    const active = tasks.flatMap((t) => {
      const sp = spanOf(src.get(t.task_id), kind);
      if (!byTask.has(t.task_id) || sp.start == null || sp.finish == null || sp.finish < w0 || sp.start > at) return [];
      return [{ id: t.task_code, name: t.task_name, start: formatP6Date(sp.start), finish: formatP6Date(sp.finish), elements: byTask.get(t.task_id)!.length, share: Math.round(Math.min(1, Math.max(0, (at - sp.start) / Math.max(1, sp.finish - sp.start))) * 100) / 100 }];
    });
    return { date: formatP6Date(at), counts, ...(by ? { by } : {}), active };
  });
  return { source: src.label, frames };
}

export type Compare = 'ahead' | 'on_time' | 'late' | 'not_started' | 'complete';
/** Each element against a baseline on a date (TimeLiner's Early/Late appearance): ahead (further on than the
 *  baseline), late (behind it: by start or by finish, as late_means says), on time, or not started / complete in both. */
export function compareAt(db: Db, projId: string, ix: IfcIndex, o: { at: number; against: string; lateMeans?: 'start' | 'finish'; by?: 'storey' | 'class' | 'wbs' }) {
  const base = sourceTasks(db, projId, o.against);
  const cur = sourceTasks(db, projId, 'best');
  const { byGuid } = linkMaps(db, projId);
  const over = statusOverrides(db, projId);
  const tasks = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_id, t]));
  const wbs = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w.wbs_short_name]));
  const rank: Record<State, number> = { not_started: 0, in_progress: 1, temporary: 1, complete: 2, removed: 2 };
  const result = new Map<string, Compare>();
  const zones: Record<string, Record<Compare, number>> = {};
  const zoneOf = (e: IfcElement, ls: { task_id: string }[]) => (o.by === 'class' ? e.ifcClass : o.by === 'wbs' ? wbs.get(tasks.get(ls[0]?.task_id ?? '')?.wbs_id ?? '') ?? '(none)' : e.storey || '(none)');
  for (const e of ix.elements) {
    const ls = byGuid.get(e.guid);
    if (!ls) continue;
    const b = elementState(ls, base.get, base.kind === 'baseline' ? 'best' : base.kind, o.at);
    const c = over(e.guid, o.at) ?? elementState(ls, cur.get, 'best', o.at);
    let r: Compare;
    if (rank[c] === 0 && rank[b] === 0) r = 'not_started';
    else if (rank[c] === 2 && rank[b] === 2) r = 'complete';
    else if (rank[c] > rank[b]) r = 'ahead';
    else if (rank[c] < rank[b]) r = (o.lateMeans ?? 'start') === 'finish' && rank[b] < 2 ? 'on_time' : 'late';
    else r = 'on_time';
    result.set(e.guid, r);
    const z = zoneOf(e, ls);
    const zz = zones[z] ?? (zones[z] = { ahead: 0, on_time: 0, late: 0, not_started: 0, complete: 0 });
    zz[r]++;
  }
  return { result, zones };
}

/** Critical activities now and in the baseline (by the baseline's own float), for delay narratives. */
export function criticalChanges(db: Db, projId: string, against: string) {
  const ctx = makeCtx(db, { hoursPerDay: 8 });
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  const bl = baselineOf(db, proj, against.replace(/^baseline:/i, ''));
  if (!bl) return null;
  const now = new Set(rows(db, 'TASK').filter((t) => t.proj_id === projId && isCritical(t, ctx)).map((t) => t.task_code));
  const then = new Set([...bl.tasks.values()].filter((t) => isCritical(t, ctx)).map((t) => t.task_code));
  return { became_critical: [...now].filter((c) => !then.has(c)), no_longer_critical: [...then].filter((c) => !now.has(c)) };
}

/** Bytes as base64, in Node and in the desktop's renderer alike. */
export function toBase64(u: Uint8Array): string { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768) as unknown as number[]); return btoa(s); }

/** What the 4D viewer plays: per activity, its dates under each source and its progress; the data date; and the links,
 *  compact enough for millions of elements: the distinct link lists (an activity and a role each) as groups, and per
 *  element ordinal (its place in the model index, which the display tiles count by) its group, as base64 uint32
 *  (0 = unlinked, else group + 1). Site status is by ordinal too. */
export function viewerTimeline(db: Db, projId: string, ix: IfcIndex, sources: string[]) {
  const { byGuid, byTask } = linkMaps(db, projId);
  const tasks = rows(db, 'TASK').filter((t) => t.proj_id === projId);
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  const ctx = makeCtx(db, { hoursPerDay: 8 });
  const src = sources.map((s) => ({ name: s, ...sourceTasks(db, projId, s) }));
  const iso = (m: number | null) => (m == null ? null : formatP6Date(m));
  const activities = tasks.filter((t) => byTask.has(t.task_id)).map((t) => ({
    id: t.task_code, name: t.task_name, task: t.task_id, elements: byTask.get(t.task_id)!.length, pct: Number(t.phys_complete_pct || 0), critical: isCritical(t, ctx),
    spans: Object.fromEntries(src.map((s) => { const sp = spanOf(s.get(t.task_id), s.kind === 'baseline' ? 'best' : s.kind); return [s.name, [iso(sp.start), iso(sp.finish)]]; })),
  }));
  const ordinal = ordinalOf(ix);
  const of = new Uint32Array(ix.elements.length), groups: [string, Role][][] = [], groupNo = new Map<string, number>();
  let linked = 0;
  for (const [guid, ls] of byGuid) {
    const o = ordinal(guid);
    if (o < 0) continue;
    const key = ls.map((l) => `${l.task_id}:${l.role}`).join('|');
    let g = groupNo.get(key);
    if (g == null) { g = groups.length; groups.push(ls.map((l) => [l.task_id, l.role])); groupNo.set(key, g); }
    if (!of[o]) linked++;
    of[o] = g + 1;
  }
  const all = activities.flatMap((a) => Object.values(a.spans).flat()).filter((x): x is string => !!x).sort();
  const status = rows(db, T4D.status).filter((r) => r.proj_id === projId).map((r) => ({ e: ordinal(r.guid), status: r.status, date: r.date })).filter((x) => x.e >= 0);
  return { project: proj.proj_short_name, name: proj.proj_name ?? proj.proj_short_name, dataDate: proj.last_recalc_date || null, start: all[0] ?? null, finish: all.at(-1) ?? null, sources: src.map((s) => ({ name: s.name, label: s.label })), activities, elements: { count: ix.elements.length, linked, groups, of: toBase64(new Uint8Array(of.buffer)) }, status };
}
