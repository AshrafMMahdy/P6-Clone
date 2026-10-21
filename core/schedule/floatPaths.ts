// P6's multiple float paths (Schedule Options > Advanced > Calculate multiple float paths), from the scheduled dates:
//  - only activities still to be done that lead to the end activity get a path; completed work and activities that do
//    not lead to it are left blank;
//  - path 1 ends at the end activity: walking back, each step takes the predecessor whose link is most critical
//    (Free Float method: relationship free float, so path 1 is the longest path; Total Float method: relationship total
//    float, then a walk forward from the path's start along the most critical successor links, as Oracle describes);
//  - each next path starts from the unassigned activity whose link into an assigned one is most critical and walks back
//    the same way; each activity belongs to the first path that claims it;
//  - Float Path numbers the paths (1 = most critical), Float Path Order the activities along each path.
// Checked against a real P6 output (Oracle's sample engineering project, in "cairo alex-road.xer", P6 5.0): the same
// paths and orders (P6 5.0 encoded the numbers as 11, 21, 22; current P6 numbers them 1, 2, 3).
import { minOf } from '../arrays.ts';
import { rows, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { makeCtx } from '../project/ctx.ts';
import { calendarResolver, optionsFor, relationshipFloat } from './cpm.ts';
import { WorkCalendar } from '../calendar/calendar.ts';

export interface FloatPathOptions { count?: number; endActivity?: string; method?: 'total_float' | 'free_float' }
export interface FloatPath { path: number; float_hours: number | null; activities: { id: string; name: string; order: number; total_float_hours: number | null }[] }

/** P6's options stored with the project (SCHEDOPTIONS), as FloatPathOptions; null when the option is off. */
export function storedFloatPathOptions(db: Db, projId: string): (FloatPathOptions & { enabled: true }) | null {
  const so = rows(db, 'SCHEDOPTIONS').find((s) => s.proj_id === projId);
  if (!so || so.enable_multiple_longest_path_calc !== 'Y') return null;
  const end = so.key_activity_for_multiple_longest_paths ? rows(db, 'TASK').find((t) => t.task_id === so.key_activity_for_multiple_longest_paths)?.task_code : undefined;
  return { enabled: true, method: so.use_total_float_multiple_longest_paths === 'Y' ? 'total_float' : 'free_float', count: Number(so.max_multiple_longest_path) || 10, ...(end ? { endActivity: end } : {}) };
}

export function computeFloatPaths(db: Db, projIds: string[], o: FloatPathOptions = {}): { end: string | null; method: string; paths: FloatPath[]; assign: Map<string, { path: number; order: number }> } {
  const method = o.method ?? 'free_float', count = Math.max(1, Math.floor(o.count ?? 10));
  const open = new Set(projIds);
  const tasks = rows(db, 'TASK').filter((t) => open.has(t.proj_id) && t.task_type !== 'TT_WBS');
  const ctx = makeCtx(db, { hoursPerDay: 8 });
  const rff = relationshipFloat(db, ctx);
  const rtf = relationshipTotalFloat(db, ctx);
  const key = (r: Row) => (method === 'free_float' ? rff(r) : rtf(r)) ?? Infinity;
  const live = (t: Row) => !t.act_end_date;
  const finish = (t: Row) => parseP6Date(t.reend_date || t.early_end_date) ?? -Infinity;

  // the end activity: the one given, else the open end with the latest finish (the most critical one)
  let end = o.endActivity ? tasks.find((t) => t.task_code === o.endActivity) : undefined;
  if (!end) end = tasks.filter((t) => live(t) && !(ctx.succsOf.get(t.task_id) ?? []).some((r) => open.has(ctx.taskById.get(r.task_id)?.proj_id ?? ''))).sort((a, b) => finish(b) - finish(a) || Number(a.total_float_hr_cnt || 0) - Number(b.total_float_hr_cnt || 0))[0];
  const assign = new Map<string, { path: number; order: number }>();
  if (!end || !live(end)) return { end: end?.task_code ?? null, method, paths: [], assign };

  // the activities still to be done that lead to the end activity
  const U = new Set<string>();
  for (const stack = [end.task_id]; stack.length;) {
    const id = stack.pop()!;
    if (U.has(id)) continue;
    const t = ctx.taskById.get(id);
    if (!t || !open.has(t.proj_id) || !live(t)) continue;
    U.add(id);
    for (const r of ctx.predsOf.get(id) ?? []) stack.push(r.pred_task_id);
  }
  const preds = (id: string) => (ctx.predsOf.get(id) ?? []).filter((r) => U.has(r.pred_task_id) && !assign.has(r.pred_task_id));
  const succs = (id: string) => (ctx.succsOf.get(id) ?? []).filter((r) => U.has(r.task_id) && !assign.has(r.task_id));
  const code = (id: string) => ctx.taskById.get(id)!.task_code;
  const best = (rs: Row[], side: 'pred' | 'succ') => [...rs].sort((a, b) => key(a) - key(b) || code(side === 'pred' ? a.pred_task_id : a.task_id).localeCompare(code(side === 'pred' ? b.pred_task_id : b.task_id)))[0];

  const paths: FloatPath[] = [];
  const claim = (chain: string[]) => {
    const n = paths.length + 1;
    chain.forEach((id, i) => assign.set(id, { path: n, order: i + 1 }));
    const tf = (id: string) => { const v = ctx.taskById.get(id)!.total_float_hr_cnt; return v === '' || v == null ? null : Number(v); };
    const fl = chain.map(tf).filter((x): x is number => x != null);
    paths.push({ path: n, float_hours: fl.length ? minOf(fl) : null, activities: chain.map((id, i) => ({ id: code(id), name: ctx.taskById.get(id)!.task_name, order: i + 1, total_float_hours: tf(id) })) });
  };
  /** Walk back from an activity through unassigned activities along the most critical links; forward order. */
  const walkBack = (from: string) => {
    const chain = [from], seen = new Set([from]);
    for (let cur = from; ;) {
      const r = best(preds(cur).filter((x) => !seen.has(x.pred_task_id)), 'pred');
      if (!r) break;
      cur = r.pred_task_id; seen.add(cur); chain.unshift(cur);
    }
    return chain;
  };

  // path 1
  let chain = walkBack(end.task_id);
  if (method === 'total_float' && chain.length) {
    // Oracle: from the path's start, walk forward along the most critical successor links
    const fwd = [chain[0]], seen = new Set(fwd);
    for (let cur = chain[0]; cur !== end.task_id;) {
      const r = best(succs(cur).filter((x) => !seen.has(x.task_id)), 'succ');
      if (!r) break;
      cur = r.task_id; seen.add(cur); fwd.push(cur);
    }
    if (fwd[fwd.length - 1] === end.task_id) chain = fwd;
  }
  claim(chain);

  // next paths: the unassigned activity with the most critical link into an assigned one
  while (paths.length < count) {
    let pick: { id: string; k: number; at: number } | null = null;
    for (const id of U) {
      if (assign.has(id)) continue;
      for (const r of ctx.succsOf.get(id) ?? []) {
        const a = assign.get(r.task_id);
        if (!a) continue;
        const k = key(r), at = a.path * 1e6 + a.order;
        if (!pick || k < pick.k || (k === pick.k && (at < pick.at || (at === pick.at && code(id) < code(pick.id))))) pick = { id, k, at };
      }
    }
    if (!pick) break;
    claim(walkBack(pick.id));
  }
  return { end: end.task_code, method, paths, assign };
}

/** Write Float Path and Float Path Order on the activities (blank for the others), as P6 does after F9. */
export function writeFloatPaths(db: Db, projIds: string[], assign: Map<string, { path: number; order: number }>): void {
  const T = db.tables.TASK;
  if (!T) return;
  for (const f of ['float_path', 'float_path_order']) if (!T.fields.includes(f)) T.fields.push(f);
  const open = new Set(projIds);
  for (const t of T.rows) {
    if (!open.has(t.proj_id)) continue;
    const a = assign.get(t.task_id);
    const fp = a ? String(a.path) : '', fo = a ? String(a.order) : '';
    if ((t.float_path ?? '') !== fp) t.float_path = fp;
    if ((t.float_path_order ?? '') !== fo) t.float_path_order = fo;
  }
}

/** After F9: compute and write the float paths of each project that has the option on. */
export function applyStoredFloatPaths(db: Db, projIds: string[]): void {
  for (const id of projIds) {
    const o = storedFloatPathOptions(db, id);
    if (o) writeFloatPaths(db, [id], computeFloatPaths(db, [id], o).assign);
  }
}

/** Relationship total float: from the predecessor's early date to the successor's late date, less the lag (minutes). */
function relationshipTotalFloat(db: Db, ctx: ReturnType<typeof makeCtx>): (r: Row) => number | null {
  const cals = calendarResolver(db, []);
  const calOf = (t: Row) => cals.get(t.clndr_id) ?? cals.fallback(ctx.proj.get(t.proj_id)?.clndr_id);
  return (r) => {
    const a = ctx.taskById.get(r.pred_task_id), b = ctx.taskById.get(r.task_id);
    if (!a || !b || b.act_end_date) return null;
    const ty = r.pred_type || 'PR_FS', toFinish = ty === 'PR_FF' || ty === 'PR_SF';
    const from = parseP6Date(ty === 'PR_SS' || ty === 'PR_SF' ? a.act_start_date || a.early_start_date : a.act_end_date || a.early_end_date);
    const to = parseP6Date(toFinish ? b.late_end_date : b.late_start_date);
    if (from == null || to == null) return null;
    const proj = ctx.proj.get(b.proj_id), kind = proj ? optionsFor(db, proj).lagCalendar : 'predecessor';
    const lagCal = kind === 'successor' ? calOf(b) : kind === '24h' ? WorkCalendar.continuous() : kind === 'project' ? cals.fallback(proj?.clndr_id) : calOf(a);
    const lag = Number(r.lag_hr_cnt || 0) * 60;
    return calOf(a).workBetween(lag ? lagCal.addWork(from, lag) : from, to);
  };
}
