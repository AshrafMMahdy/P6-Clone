// Scheduling an LOB project: the clone's F9 over everything (LOB with one location is CPM), then continuity. A paced
// trade's earlier locations move later until each finishes as the next starts (the crew never waits), its last
// location staying where F9 put it (Vico's ASAP + Paced). The moves are written as start-on-or-after constraints on
// those activities, so real P6 schedules the exported XER to the same dates; F9 runs again until nothing moves.
import { rows, type Db } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { applyOps } from '../project/ops.ts';
import { calendarResolver, scheduleProjects } from '../schedule/cpm.ts';
import { activityId, LOB_UDF } from './expand.ts';
import { locationDurations } from './edit.ts';
import type { LobModel } from './model.ts';

export interface PaceResult { ok: boolean; error?: string; passes: number; paced: number; unpaced: string[] }

/** F9 and continuity for these projects; models: the LOB model of each LOB project (by proj_id). */
export function scheduleLob(db: Db, projIds: string[], models: Map<string, LobModel>, o: { hoursPerDay: number }): PaceResult {
  const cal = calendarResolver(db, []);
  // the constraints continuity wrote last time are recomputed from scratch: clear them on LOB activities not started
  const ownerUdf = rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label === LOB_UDF.task);
  const owned = new Set(ownerUdf ? rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === ownerUdf.udf_type_id && v.udf_text).map((v) => v.fk_id) : []);
  for (const t of rows(db, 'TASK')) if (owned.has(t.task_id) && models.has(t.proj_id) && !t.act_start_date && t.cstr_type === 'CS_MSOA') { t.cstr_type = ''; t.cstr_date = ''; }
  let moved: string[] = [], paced = 0;
  for (let pass = 1; pass <= 20; pass++) {
    const s = scheduleProjects(db, projIds, {});
    if (!s.ok) return { ok: false, error: s.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' ') || 'the schedule failed', passes: pass, paced, unpaced: [] };
    const ops: unknown[] = [];
    moved = [];
    for (const [projId, m] of models) {
      const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId);
      if (!proj) continue;
      const byCode = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_code, t]));
      for (const t of m.tasks) {
        const d = locationDurations(m, t);
        for (const seg of t.segments) {
          if (seg.timing === 'asap') continue;
          const locs = t.order.slice(t.order.indexOf(seg.from), t.order.indexOf(seg.to) + 1).filter((c) => d.has(c));
          // from the last location back: each finishes as the next starts
          for (let k = locs.length - 2; k >= 0; k--) {
            const a = byCode.get(activityId(t.code, locs[k])), b = byCode.get(activityId(t.code, locs[k + 1]));
            if (!a || !b || a.act_start_date) continue;
            const c = cal.get(a.clndr_id) ?? cal.fallback(proj.clndr_id);
            const nextStart = parseP6Date(b.act_start_date || b.early_start_date), start = parseP6Date(a.early_start_date);
            if (nextStart == null || start == null) continue;
            const want = c.subWork(nextStart, Number(a.remain_drtn_hr_cnt || a.target_drtn_hr_cnt || 0) * 60);
            if (c.workBetween(start, want) <= 0) continue; // already continuous (or later than it needs to be)
            const date = formatP6Date(c.nextWorkStart(want));
            ops.push({ op: 'update_activity', id: a.task_code, project: proj.proj_short_name, constraint: { type: 'start_on_or_after', date } });
            // the activity moves now, so the one before it is measured against its new start in this same pass
            a.early_start_date = date;
            moved.push(t.code);
          }
        }
      }
    }
    if (!ops.length) return { ok: true, passes: pass, paced: (paced = new Set([...models.values()].flatMap((m) => m.tasks.filter((t) => t.segments.some((g) => g.timing !== 'asap')).map((t) => t.code))).size), unpaced: [] };
    const r = applyOps(db, ops, { hoursPerDay: o.hoursPerDay });
    if (!r.ok) return { ok: false, error: r.error!.message, passes: pass, paced, unpaced: [] };
  }
  // still moving after 20 passes: continuity fights the logic (e.g. a link back from a later trade); it yields
  return { ok: true, passes: 20, paced, unpaced: [...new Set(moved)] };
}
