// Bringing another tool's 4D work into a project: tasks matched to activities (Activity ID, then a unique name),
// element links (GlobalIds, or the design model's express ids for SYNCHRO-renamed elements), selection sets resolved
// against the model, TimeLiner attachments through those sets, and activities to create for tasks that match none.
// Shared by the MCP server and the desktop app (pure: the files are read by read4d.ts).
import { nextId, rows, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { applyOps } from '../project/ops.ts';
import { calendarResolver } from '../schedule/cpm.ts';
import { linkElements, t4d, T4D } from './link4d.ts';
import { resolveSet, type Imported4d } from './exchange4d.ts';
import type { IfcIndex } from './parse.ts';

export interface ImportPlan { proposals: { activity: string; guids: string[] }[]; forNew: Map<string, string[]>; unmatchedTasks: string[]; elementsNotInModel: number; sets: { name: string; guids: string[] }[]; toCreate: Imported4d['tasks']; attachedSets: { name: string; known: boolean }[] }

export function planImport(db: Db, projId: string, imp: Imported4d, ix: IfcIndex | null, o: { createActivities?: boolean } = {}): ImportPlan {
  const tasksOnly = imp.source === 'timeliner_csv' || imp.source === 'nwf', creatable = tasksOnly || imp.source === 'synchro';
  const T = rows(db, 'TASK').filter((t) => t.proj_id === projId && t.task_type !== 'TT_WBS');
  const byId = new Map(T.map((t) => [t.task_code.toLowerCase(), t])), names = new Map<string, Row | null>();
  for (const t of T) { const k = t.task_name.trim().toLowerCase(); names.set(k, names.has(k) ? null : t); }
  const match = (id: string, name?: string) => byId.get(id.toLowerCase()) ?? names.get((name ?? id).trim().toLowerCase()) ?? undefined;
  const inModel = ix ? new Set(ix.elements.map((e) => e.guid)) : null;
  const byExpress = ix ? new Map(ix.elements.map((e) => [e.expressId, e.guid])) : new Map<number, string>();
  const nameOf = new Map(imp.tasks.map((t) => [t.id, t.name]));
  const plan: ImportPlan = { proposals: [], forNew: new Map(), unmatchedTasks: [], elementsNotInModel: 0, sets: [], toCreate: [], attachedSets: [] };
  for (const l of imp.links) {
    const t = match(l.task, nameOf.get(l.task));
    const guids = [...(l.guids ?? []).filter((g) => !inModel || inModel.has(g) || (plan.elementsNotInModel++, false)), ...(l.expressIds ?? []).flatMap((x) => { const g = byExpress.get(x); if (!g) plan.elementsNotInModel++; return g ? [g] : []; })];
    if (!t) { plan.unmatchedTasks.push(l.task); if (guids.length) plan.forNew.set(l.task, guids); continue; }
    if (guids.length) plan.proposals.push({ activity: t.task_code, guids });
  }
  plan.sets = (imp.sets ?? []).map((st) => ({ name: st.name, guids: ix ? resolveSet(ix, st) : [] }));
  const known = new Map([...rows(db, T4D.set).filter((r) => r.proj_id === projId).map((r) => [r.name.toLowerCase(), JSON.parse(r.guids || '[]') as string[]] as const), ...plan.sets.map((s) => [s.name.toLowerCase(), s.guids] as const)]);
  if (creatable) {
    for (const t of imp.tasks) {
      const a = match(t.id, t.name);
      if (!a) { plan.unmatchedTasks.push(t.id); if (o.createActivities) plan.toCreate.push(t); continue; }
      const g = t.attached ? known.get(t.attached.toLowerCase()) : undefined;
      if (g?.length) plan.proposals.push({ activity: a.task_code, guids: g });
    }
  }
  if (tasksOnly) {
    plan.attachedSets = [...new Set(imp.tasks.map((t) => t.attached).filter((x): x is string => !!x))].map((n) => ({ name: n, known: known.has(n.toLowerCase()) }));
  }
  plan.unmatchedTasks = [...new Set(plan.unmatchedTasks)];
  return plan;
}

/** Apply a plan: the sets, the activities to create (TimeLiner tasks: planned dates as duration, a start-on-or-after
 *  constraint), then the links. Run inside one undoable change. */
export function applyImport(db: Db, projId: string, plan: ImportPlan, ix: IfcIndex | null, o: { source: string; hoursPerDay: number; calendarDays: boolean }) {
  if (plan.sets.length) { const S = t4d(db, T4D.set); for (const st of plan.sets) { S.rows = S.rows.filter((r) => !(r.proj_id === projId && r.name === st.name)); S.rows.push({ set_id: String(nextId(db, T4D.set)), proj_id: projId, name: st.name, guids: JSON.stringify(st.guids), source: o.source }); } }
  const created: { id: string; name: string }[] = [];
  const proposals = [...plan.proposals];
  if (plan.toCreate.length) {
    const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
    const cal = calendarResolver(db, []).fallback(proj.clndr_id);
    const hpd = cal.hoursPerDay() || o.hoursPerDay;
    const used = new Set(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => t.task_code));
    const known = new Map(rows(db, T4D.set).filter((r) => r.proj_id === projId).map((r) => [r.name.toLowerCase(), JSON.parse(r.guids || '[]') as string[]]));
    let n = 0;
    const ops = plan.toCreate.map((t) => {
      // the other tool's own ID when it has one that is free, else TL0010, TL0020...
      let id = t.id && t.id !== t.name && t.id.length <= 40 && !used.has(t.id) ? t.id : '';
      while (!id || used.has(id)) id = `TL${String(++n * 10).padStart(4, '0')}`;
      used.add(id);
      const st = parseP6Date(t.start ?? ''), fi = parseP6Date(t.finish ?? '');
      const days = st != null && fi != null ? Math.max(0, Math.round((cal.workBetween(st, fi) / 60 / hpd) * 10) / 10) : 1;
      created.push({ id, name: t.name || t.id });
      const g = [...(t.attached ? known.get(t.attached.toLowerCase()) ?? [] : []), ...(plan.forNew.get(t.id) ?? [])];
      if (g.length) proposals.push({ activity: id, guids: g });
      return { op: 'add_activity', id, name: t.name || t.id, duration_days: days, project: proj.proj_short_name, ...(t.start ? { constraint: { type: 'start_on_or_after', date: t.start } } : {}) };
    });
    const r = applyOps(db, ops, { hoursPerDay: o.hoursPerDay, calendarDays: o.calendarDays });
    if (!r.ok) throw new Error(r.error!.message);
  }
  return { ...(created.length ? { created_activities: created } : {}), ...(proposals.length ? linkElements(db, projId, proposals, 'add', ix) : { added: 0 }) };
}
