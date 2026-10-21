// What an LOB plan looks like once scheduled, in a form an agent reads at a glance: each trade's locations with their
// dates and float, the trades on the critical path, where two trades share a location at the same time (collisions),
// and where a crew waits between locations (gaps). Also the guard that keeps the plan's structure in the LOB tools.
import { minOf } from '../arrays.ts';
import { rows, type Db, type Row } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { calendarResolver } from '../schedule/cpm.ts';
import { activityId, LOB_CODES, LOB_UDF } from './expand.ts';
import { locationDurations } from './edit.ts';
import type { LobModel } from './model.ts';

export interface LobView {
  finish: string | null; dataDate: string | null; critical: string[];
  tasks: { code: string; name: string; trade: string; start: string | null; finish: string | null; floatDays: number | null; segments: { from: string; to: string; crew: string; driver: string; timing: string; rate: number | null }[]; locations: [string, string, string, number][] }[];
  collisions: { location: string; a: string; b: string; from: string; to: string }[];
  gaps: { task: string; after: string; before: string; days: number }[];
}

export function lobView(db: Db, projId: string, m: LobModel, o: { hoursPerDay: number; limit?: number }): LobView {
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  const cal = calendarResolver(db, []).fallback(proj.clndr_id);
  const acts = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_code, t]));
  const day = (s: string) => (s ? s.slice(0, 10) : '');
  const out: LobView = { finish: null, dataDate: proj.last_recalc_date || null, critical: [], tasks: [], collisions: [], gaps: [] };
  const limit = o.limit ?? 200;
  const spans: { task: string; loc: string; s: number; f: number }[] = [];
  for (const t of m.tasks) {
    const d = locationDurations(m, t);
    const locs = t.order.filter((c) => d.has(c)).map((c) => acts.get(activityId(t.code, c))).filter((a): a is NonNullable<typeof a> => !!a);
    const start = (a: (typeof locs)[number]) => a.act_start_date || a.early_start_date, finish = (a: (typeof locs)[number]) => a.act_end_date || a.early_end_date;
    const floats = locs.map((a) => (a.total_float_hr_cnt === '' ? null : Number(a.total_float_hr_cnt) / o.hoursPerDay)).filter((x): x is number => x != null);
    const minFloat = floats.length ? minOf(floats) : null;
    if (minFloat != null && minFloat <= 0) out.critical.push(t.code);
    out.tasks.push({
      code: t.code, name: t.name, trade: t.trade,
      start: locs.length ? day(locs.map(start).sort()[0]) : null, finish: locs.length ? day(locs.map(finish).sort().at(-1)!) : null,
      floatDays: minFloat == null ? null : Math.round(minFloat * 10) / 10,
      segments: t.segments.map((s) => ({ from: s.from, to: s.to, crew: `${s.crews} × ${s.crewSize}${s.productivity !== 1 ? ` at ${s.productivity}` : ''}`, driver: s.driver, timing: s.timing, rate: s.rate ?? null })),
      locations: locs.slice(0, limit).map((a) => [a.task_code.slice(t.code.length + 1), day(start(a)), day(finish(a)), a.total_float_hr_cnt === '' ? NaN : Math.round((Number(a.total_float_hr_cnt) / o.hoursPerDay) * 10) / 10]),
    });
    for (let k = 1; k < locs.length; k++) {
      const gap = cal.workBetween(parseP6Date(finish(locs[k - 1]))!, parseP6Date(start(locs[k]))!) / 60 / o.hoursPerDay;
      if (gap > 0.01) out.gaps.push({ task: t.code, after: locs[k - 1].task_code, before: locs[k].task_code, days: Math.round(gap * 10) / 10 });
    }
    for (const a of locs) spans.push({ task: t.code, loc: a.task_code.slice(t.code.length + 1), s: parseP6Date(start(a))!, f: parseP6Date(finish(a))! });
  }
  out.finish = out.tasks.map((t) => t.finish ?? '').sort().at(-1) || null;
  // two trades in one location (or one inside the other) at the same time
  const parent = new Map(m.locations.map((l) => [l.code, l.parent]));
  const within = (a: string, b: string) => { for (let x: string | null | undefined = a; x; x = parent.get(x)) if (x === b) return true; return false; };
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
    const a = spans[i], b = spans[j];
    if (a.task === b.task || !(within(a.loc, b.loc) || within(b.loc, a.loc))) continue;
    const from = Math.max(a.s, b.s), to = Math.min(a.f, b.f);
    if (cal.workBetween(from, to) > 0) out.collisions.push({ location: a.loc.length >= b.loc.length ? a.loc : b.loc, a: a.task, b: b.task, from: new Date(from * 60000).toISOString().slice(0, 10), to: new Date(to * 60000).toISOString().slice(0, 10) });
  }
  out.gaps = out.gaps.slice(0, limit); out.collisions = out.collisions.slice(0, limit);
  return out;
}

/** An edit (MCP edit, the Activities window, Global Change) may not change what the LOB plan sets: an LOB activity's
 *  duration, logic, location or trade, or delete it. Progress, notes, resources and other codes are fine. Returns the
 *  refusal, or null. */
export function lobGuard(db: Db, ops: unknown[]): string | null {
  const udf = rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label === LOB_UDF.task)?.udf_type_id;
  if (!udf) return null;
  const owned = new Set(rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === udf && v.udf_text).map((v) => v.fk_id));
  if (!owned.size) return null;
  const projOf = new Map(rows(db, 'PROJECT').map((p) => [p.proj_short_name.toLowerCase(), p.proj_id]));
  const only = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
  const isLob = (id: unknown, project: unknown) => { const pid = project != null ? projOf.get(String(project).toLowerCase()) : only.length === 1 ? only[0].proj_id : undefined; return rows(db, 'TASK').some((t) => t.task_code === String(id) && (pid == null || t.proj_id === pid) && owned.has(t.task_id)); };
  const msg = (id: unknown) => `${id} is set by the LOB plan: edit it in Extensions > LOB (or lob_edit).`;
  const STRUCT = ['duration_days', 'remaining_days', 'remaining_hours', 'new_id', 'constraint', 'secondary_constraint', 'type', 'calendar', 'wbs', 'start', 'finish'];
  for (const raw of ops) {
    const op = raw as Record<string, unknown>;
    switch (op.op) {
      case 'update_activity': {
        if (!isLob(op.id, op.project)) break;
        // progress is free (L-2): on a started activity (or one this op starts) the remaining duration and the start /
        // finish (its actuals) are progress, not the plan
        const pid = op.project != null ? projOf.get(String(op.project).toLowerCase()) : undefined;
        const started = op.actual_start != null || rows(db, 'TASK').some((t) => t.task_code === String(op.id) && (pid == null || t.proj_id === pid) && t.act_start_date);
        const PROGRESS = ['remaining_days', 'remaining_hours', 'start', 'finish'];
        if (STRUCT.some((k) => op[k] !== undefined && !(started && PROGRESS.includes(k)))) return msg(op.id);
        break;
      }
      case 'delete_activity': case 'dissolve_activity': if (isLob(op.id, op.project)) return msg(op.id); break;
      case 'add_relationship': case 'delete_relationship': case 'update_relationship':
        if (isLob(op.pred, op.pred_project ?? op.project) && isLob(op.succ, op.succ_project ?? op.project)) return msg(`The relationship ${op.pred} → ${op.succ}`); break;
      case 'set_predecessors': if (isLob(op.activity, op.project)) return msg(op.activity); break;
      case 'assign_code': if ((op.type === LOB_CODES.location || op.type === LOB_CODES.trade) && op.activity != null && isLob(op.activity, op.project)) return msg(op.activity); break;
      case 'set_udf': if (typeof op.udf === 'string' && Object.values(LOB_UDF).includes(op.udf as never) && op.activity != null) return msg(op.activity); break;
    }
  }
  return null;
}

/** The same rule for an activity row changed in place (the Activities window, Activity Details, Global Change): a
 *  change to an LOB activity's duration (before it starts), ID, type, calendar, constraint or WBS is refused. */
export function lobRowGuard(db: Db, before: Row, after: Row): string | null {
  const udf = rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label === LOB_UDF.task)?.udf_type_id;
  if (!udf || !rows(db, 'UDFVALUE').some((v) => v.udf_type_id === udf && v.fk_id === before.task_id && v.udf_text)) return null;
  const fields = ['task_code', 'task_type', 'clndr_id', 'cstr_type', 'cstr_date', 'wbs_id', ...(before.act_start_date ? [] : ['target_drtn_hr_cnt', 'remain_drtn_hr_cnt'])];
  return fields.some((f) => (before[f] ?? '') !== (after[f] ?? '')) ? `${before.task_code} is set by the LOB plan: edit it in Extensions > LOB.` : null;
}

/** The Activity IDs an LOB plan owns (crash_schedule leaves them to the plan). */
export function lobActivityCodes(db: Db): string[] {
  const udf = rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label === LOB_UDF.task)?.udf_type_id;
  if (!udf) return [];
  const owned = new Set(rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === udf && v.udf_text).map((v) => v.fk_id));
  return rows(db, 'TASK').filter((t) => owned.has(t.task_id)).map((t) => t.task_code);
}
