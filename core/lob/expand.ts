// The LOB model as ordinary P6 data: one activity per task × location with work (ID "<task>-<location>", so inserting
// or reordering locations never renumbers an activity), relationships for the five logic layers, the Location (a
// hierarchy) and Trade activity codes, and UDFs a P6 user can read. Everything goes through applyOps, so it is one
// journalled change; activities the model no longer has are deleted unless they have progress (then kept and said).
import { rows, type Db, type Row } from '../db.ts';
import { applyOps } from '../project/ops.ts';
import { locationDurations } from './edit.ts';
import { pathOf, type LobLink, type LobModel, type LobTask } from './model.ts';

export const LOB_UDF = { task: 'LOB Task', quantity: 'LOB Quantity', consumption: 'LOB Consumption', crew: 'LOB Crew' } as const;
export const LOB_CODES = { location: 'Location', trade: 'Trade' } as const;
export const activityId = (task: string, location: string) => `${task}-${location}`;

interface Rel { pred: string; succ: string; type: string; lag: number; predProject?: string; succProject?: string }
export interface ExpandResult { ok: boolean; error?: string; added: number; updated: number; deleted: number; keptWithProgress: string[]; relationships: { added: number; updated: number; deleted: number } }

/** The relationships the model implies (layers 1-5, buffers, links to other projects). */
export function lobRelationships(m: LobModel, durations: Map<string, Map<string, number>>, projectCode: string): Rel[] {
  const loc = new Map(m.locations.map((l) => [l.code, l]));
  const tasks = new Map(m.tasks.map((t) => [t.code, t]));
  const has = (t: LobTask, c: string) => durations.get(t.code)?.has(c) ?? false;
  const ancestor = (c: string, level: number): string => { let x = loc.get(c); while (x && x.level > level) x = loc.get(x.parent ?? ''); return x?.code ?? c; };
  const siblings = (c: string) => { const l = loc.get(c)!; return m.locations.filter((x) => x.level === l.level && x.parent === l.parent).map((x) => x.code); };
  const out: Rel[] = [];
  // layer 3: within a task, each location after the one before (locations with no work are passed through)
  for (const t of m.tasks) { const done = t.order.filter((c) => has(t, c)); for (let k = 1; k < done.length; k++) out.push({ pred: activityId(t.code, done[k - 1]), succ: activityId(t.code, done[k]), type: 'FS', lag: 0 }); }
  for (const l of m.links) {
    const p = tasks.get(l.pred), s = tasks.get(l.succ);
    const lag = l.lagDays + (l.bufferDays ?? 0);
    // a link to or from another project: the LOB end is its first (as a successor) or last (as a predecessor) location
    if (l.project && (!p || !s)) {
      if (s) { const first = l.succLocation ?? s.order.find((c) => has(s, c)); if (first) out.push({ pred: l.pred, predProject: l.project, succ: activityId(s.code, first), type: l.type, lag }); }
      else if (p) { const last = l.predLocation ?? [...p.order].reverse().find((c) => has(p, c)); if (last) out.push({ pred: activityId(p.code, last), succ: l.succ, succProject: l.project, type: l.type, lag }); }
      continue;
    }
    if (!p || !s) continue;
    // layer 5: one task-location to another
    if (l.kind === 'location') { if (l.predLocation && l.succLocation && has(p, l.predLocation) && has(s, l.succLocation)) out.push({ pred: activityId(p.code, l.predLocation), succ: activityId(s.code, l.succLocation), type: l.type, lag }); continue; }
    // layers 1, 2 and 4: in every location both share, at the link's level (the coarser of the two by default),
    // shifted by the location lag (+1: the location below must be done) and the buffer in locations
    const level = l.precision ?? Math.min(p.precision, s.precision);
    const shift = (l.locationLag ?? 0) + (l.bufferLocations ?? 0);
    const group = (t: LobTask) => { const g = new Map<string, string[]>(); for (const c of t.order) (g.get(ancestor(c, level)) ?? g.set(ancestor(c, level), []).get(ancestor(c, level))!).push(c); return g; };
    const gp = group(p), gs = group(s);
    for (const [area, succLocs] of gs) {
      let predArea = area;
      if (shift) { const sib = siblings(area), i = sib.indexOf(area) - shift; if (i < 0 || i >= sib.length) continue; predArea = sib[i]; }
      const predLocs = gp.get(predArea);
      if (!predLocs) continue;
      const pw = predLocs.filter((c) => has(p, c)), sw = succLocs.filter((c) => has(s, c));
      // a predecessor with no work in the area passes its logic through from its last location before it
      const before = p.order.slice(0, p.order.indexOf(predLocs[0])).filter((c) => has(p, c));
      const pFirst = pw[0] ?? before.at(-1), pLast = pw.at(-1) ?? before.at(-1);
      if (!sw.length || !pFirst || !pLast) continue;
      const from = l.type === 'SS' || l.type === 'SF' ? pFirst : pLast, to = l.type === 'FF' || l.type === 'SF' ? sw.at(-1)! : sw[0];
      out.push({ pred: activityId(p.code, from), succ: activityId(s.code, to), type: l.type, lag });
    }
  }
  void projectCode;
  // one relationship per pair and type, the longest lag kept
  const seen = new Map<string, Rel>();
  for (const r of out) { const k = `${r.predProject ?? ''}|${r.pred}|${r.succProject ?? ''}|${r.succ}|${r.type}`; const o = seen.get(k); if (!o || r.lag > o.lag) seen.set(k, r); }
  return [...seen.values()];
}

/** Bring the project's activities and relationships in line with the model. */
/** previous: the model as last expanded, so links it had to other projects are taken back when they are gone. */
export function expandLob(db: Db, projId: string, m: LobModel, o: { hoursPerDay: number; previous?: LobModel | null }): ExpandResult {
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  const P = proj.proj_short_name;
  const res: ExpandResult = { ok: true, added: 0, updated: 0, deleted: 0, keptWithProgress: [], relationships: { added: 0, updated: 0, deleted: 0 } };
  const ops: unknown[] = [];
  // codes and UDFs (made once, reused after)
  const codeType = (name: string) => rows(db, 'ACTVTYPE').find((t) => t.actv_code_type === name);
  if (!codeType(LOB_CODES.location)) ops.push({ op: 'add_code_type', name: LOB_CODES.location, max_length: 60 });
  if (!codeType(LOB_CODES.trade)) ops.push({ op: 'add_code_type', name: LOB_CODES.trade, max_length: 60 });
  const values = (type: string) => { const t = codeType(type); return new Set(t ? rows(db, 'ACTVCODE').filter((v) => v.actv_code_type_id === t.actv_code_type_id).map((v) => v.short_name) : []); };
  const haveLoc = values(LOB_CODES.location), haveTrade = values(LOB_CODES.trade);
  const byLevel = [...m.locations].sort((a, b) => a.level - b.level);
  for (const l of byLevel) if (!haveLoc.has(l.code)) ops.push({ op: 'add_code_value', type: LOB_CODES.location, code: l.code, name: l.name, ...(l.parent ? { parent: l.parent } : {}) });
  for (const tr of new Set(m.tasks.map((t) => t.trade))) if (!haveTrade.has(tr)) ops.push({ op: 'add_code_value', type: LOB_CODES.trade, code: tr.slice(0, 60), name: tr });
  const udfs = new Set(rows(db, 'UDFTYPE').filter((u) => u.table_name === 'TASK').map((u) => u.udf_type_label));
  for (const [k, name] of Object.entries(LOB_UDF)) if (!udfs.has(name)) ops.push({ op: 'add_udf', name, subject: 'activity', data_type: k === 'quantity' || k === 'consumption' ? 'number' : 'text' });

  // activities
  const durations = new Map(m.tasks.map((t) => [t.code, locationDurations(m, t)]));
  const ownerUdf = rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label === LOB_UDF.task);
  const owned = new Set(ownerUdf ? rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === ownerUdf.udf_type_id && v.udf_text).map((v) => v.fk_id) : []);
  const existing = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_code, t]));
  const locName = new Map(m.locations.map((l) => [l.code, l.name]));
  const want = new Set<string>();
  for (const t of m.tasks) {
    const seg = (c: string) => t.segments.find((s) => t.order.indexOf(c) >= t.order.indexOf(s.from) && t.order.indexOf(c) <= t.order.indexOf(s.to));
    for (const [c, days] of durations.get(t.code)!) {
      const id = activityId(t.code, c), name = `${t.name}, ${pathOf(m, c).map((x) => locName.get(x)).join(', ')}`.slice(0, 120);
      want.add(id);
      const d = Math.round(days * 1000) / 1000, row = existing.get(id);
      if (!row) { ops.push({ op: 'add_activity', id, name, duration_days: d, project: P, ...(t.calendar ? { calendar: t.calendar } : {}) }); res.added++; }
      else if (Math.abs(Number(row.target_drtn_hr_cnt || 0) / o.hoursPerDay - d) > 0.0005 || row.task_name !== name) { ops.push({ op: 'update_activity', id, project: P, name, duration_days: d }); res.updated++; }
      if (!row || !owned.has(row.task_id)) ops.push({ op: 'set_udf', udf: LOB_UDF.task, value: t.code, activity: id, project: P });
      ops.push({ op: 'assign_code', type: LOB_CODES.location, value: c, activity: id, project: P }, { op: 'assign_code', type: LOB_CODES.trade, value: t.trade.slice(0, 60), activity: id, project: P });
      const q = t.items.reduce((n, it) => n + (it.quantities.find((x) => x.location === c)?.quantity ?? 0), 0), s = seg(c);
      ops.push({ op: 'set_udf', udf: LOB_UDF.quantity, value: q, activity: id, project: P }, { op: 'set_udf', udf: LOB_UDF.consumption, value: t.items[0]?.consumption ?? 0, activity: id, project: P });
      if (s) ops.push({ op: 'set_udf', udf: LOB_UDF.crew, value: `${s.crews} × ${s.crewSize}`, activity: id, project: P });
    }
  }
  for (const [code, row] of existing) {
    if (!owned.has(row.task_id) || want.has(code)) continue;
    if (row.act_start_date) { res.keptWithProgress.push(code); continue; }
    ops.push({ op: 'delete_activity', id: code, project: P }); res.deleted++;
  }

  // relationships: the model's set between its activities (and its links to other projects); others are left alone
  const rels = lobRelationships(m, durations, P);
  const taskById = new Map(rows(db, 'TASK').map((t) => [t.task_id, t]));
  const projCode = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name]));
  const linked = new Set([...m.links, ...(o.previous?.links ?? [])].map((l) => l.project).filter(Boolean));
  const key = (pp: string, pc: string, sp: string, sc: string, ty: string) => `${pp}|${pc}|${sp}|${sc}|${ty}`;
  const ownedRel = (r: Row) => { const a = taskById.get(r.pred_task_id), b = taskById.get(r.task_id); if (!a || !b) return false; const oa = owned.has(a.task_id), ob = owned.has(b.task_id); return (oa && ob) || (oa && linked.has(projCode.get(b.proj_id))) || (ob && linked.has(projCode.get(a.proj_id))); };
  const have = new Map<string, Row>();
  for (const r of rows(db, 'TASKPRED')) if (ownedRel(r)) { const a = taskById.get(r.pred_task_id)!, b = taskById.get(r.task_id)!; have.set(key(projCode.get(a.proj_id)!, a.task_code, projCode.get(b.proj_id)!, b.task_code, r.pred_type.replace('PR_', '')), r); }
  const wantRel = new Set<string>();
  for (const r of rels) {
    const k = key(r.predProject ?? P, r.pred, r.succProject ?? P, r.succ, r.type);
    wantRel.add(k);
    const ex = have.get(k);
    const ends = { pred: r.pred, succ: r.succ, pred_project: r.predProject ?? P, succ_project: r.succProject ?? P, type: r.type };
    if (!ex) { ops.push({ op: 'add_relationship', ...ends, lag_days: r.lag }); res.relationships.added++; }
    else if (Math.abs(Number(ex.lag_hr_cnt || 0) / o.hoursPerDay - r.lag) > 0.0005) { ops.push({ op: 'update_relationship', ...ends, lag_days: r.lag }); res.relationships.updated++; }
  }
  for (const [k, r] of have) {
    if (wantRel.has(k)) continue;
    const a = taskById.get(r.pred_task_id)!, b = taskById.get(r.task_id)!;
    // deleted activities take their relationships with them
    if ((owned.has(a.task_id) && !want.has(a.task_code) && a.proj_id === projId) || (owned.has(b.task_id) && !want.has(b.task_code) && b.proj_id === projId)) continue;
    ops.push({ op: 'delete_relationship', pred: a.task_code, succ: b.task_code, pred_project: projCode.get(a.proj_id), succ_project: projCode.get(b.proj_id), type: r.pred_type.replace('PR_', '') }); res.relationships.deleted++;
  }
  const r = applyOps(db, ops, { hoursPerDay: o.hoursPerDay });
  if (!r.ok) return { ...res, ok: false, error: r.error!.message };
  return res;
}
