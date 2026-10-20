// What-if on an open project without changing it (MCP evaluate): the project as it is and the project with the
// overrides (edit operations) are both scheduled with the same data date and options, inside a journal that is rolled
// back, so nothing is kept and no undo entry is made. Answers the finish of each, the critical set, the activities
// that became or stopped being critical, and the rows whose computed fields changed.
import { rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { record, rollback } from '../journal.ts';
import { applyOps } from '../project/ops.ts';
import { isCritical, makeCtx } from '../project/ctx.ts';
import { dayHours } from '../project/units.ts';
import { calendarResolver, scheduleProjects, type SchedOptions } from '../schedule/cpm.ts';

export interface EvaluateOptions { overrides?: unknown[]; options?: Partial<SchedOptions>; dataDate?: number; hoursPerDay?: number; maxRows?: number }
const FIELDS = ['start', 'finish', 'early_start', 'early_finish', 'late_start', 'late_finish', 'orig_days', 'rem_days', 'total_float_days', 'free_float_days', 'critical'] as const;
type Snap = Record<(typeof FIELDS)[number], string | number | boolean | null>;

/** Each activity's computed fields (days on its own calendar), by task id. */
export function computedFields(db: Db, projIds: string[], hpd = 8): Map<string, { code: string; f: Snap }> {
  const dh = dayHours(db, hpd, true), ctx = makeCtx(db, { hoursPerDay: hpd });
  const d = (s?: string) => (s ? s.slice(0, 16) : null);
  const days = (t: Row, h?: string) => (h === '' || h == null ? null : Math.round((Number(h) / dh.task(t)) * 100) / 100);
  const out = new Map<string, { code: string; f: Snap }>();
  for (const t of rows(db, 'TASK')) {
    if (!projIds.includes(t.proj_id)) continue;
    out.set(t.task_id, { code: t.task_code, f: {
      start: d(t.act_start_date || t.early_start_date), finish: d(t.act_end_date || t.early_end_date), early_start: d(t.early_start_date), early_finish: d(t.early_end_date),
      late_start: d(t.late_start_date), late_finish: d(t.late_end_date), orig_days: days(t, t.target_drtn_hr_cnt), rem_days: days(t, t.remain_drtn_hr_cnt),
      total_float_days: t.act_end_date ? null : days(t, t.total_float_hr_cnt), free_float_days: t.act_end_date ? null : days(t, t.free_float_hr_cnt), critical: isCritical(t, ctx),
    } });
  }
  return out;
}

export type EvaluateAnswer = { ok: true; data_date: string | null; base_finish: string | null; finish: string | null; finish_delta_days: number | null; critical: string[]; became_critical: string[]; no_longer_critical: string[]; changed: Record<string, unknown>[]; changed_total: number; loops: string[][]; warnings: string[] }
  | { ok: false; error: { code: string; message: string; index?: number; loops?: string[][] } };

export function evaluate(db: Db, projIds: string[], o: EvaluateOptions = {}): EvaluateAnswer {
  let answer!: EvaluateAnswer;
  const hpd = o.hoursPerDay ?? 8;
  const over: Partial<SchedOptions> = { ...(o.options ?? {}), ...(o.dataDate != null ? { dataDate: o.dataDate } : {}) };
  const j = record(db, (d) => {
    const base = scheduleProjects(d, projIds, over);
    if (!base.ok) { answer = { ok: false, error: { code: 'schedule_failed', message: `The project as it is cannot be scheduled: ${base.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' ')}`, ...(base.loops?.length ? { loops: base.loops } : {}) } }; return; }
    const before = computedFields(d, projIds, hpd);
    const r = applyOps(d, o.overrides ?? [], { hoursPerDay: hpd, calendarDays: true });
    if (!r.ok) { answer = { ok: false, error: { code: 'op_failed', message: r.error!.message, index: r.error!.index } }; return; }
    const s = scheduleProjects(d, projIds, over);
    if (!s.ok) { answer = { ok: false, error: { code: 'schedule_failed', message: s.findings.filter((f) => f.severity === 'error').map((f) => f.message).join(' '), ...(s.loops?.length ? { loops: s.loops } : {}) } }; return; }
    const after = computedFields(d, projIds, hpd);
    const crit = (m: typeof after) => new Set([...m.values()].filter((x) => x.f.critical).map((x) => x.code));
    const cb = crit(before), ca = crit(after);
    const changed: Record<string, unknown>[] = [];
    for (const [id, x] of after) {
      const y = before.get(id);
      const diff: Record<string, unknown> = {};
      for (const f of FIELDS) if (!y || y.f[f] !== x.f[f]) diff[f] = [y?.f[f] ?? null, x.f[f]];
      if (Object.keys(diff).length) changed.push({ id: x.code, ...(y ? {} : { added: true }), ...diff });
    }
    for (const [id, y] of before) if (!after.has(id)) changed.push({ id: y.code, deleted: true });
    const dh = dayHours(d, hpd, true), p0 = rows(d, 'PROJECT').find((p) => p.proj_id === projIds[0]);
    const iso = (t: number | null) => (t == null ? null : formatP6Date(t));
    // working days of the project's calendar between the two finishes
    const pc = calendarResolver(d, []).fallback(p0?.clndr_id ?? '');
    const delta = base.stats.finish != null && s.stats.finish != null ? Math.round((pc.workBetween(base.stats.finish, s.stats.finish) / 60 / dh.cal(p0?.clndr_id)) * 100) / 100 : null;
    answer = {
      ok: true, data_date: iso(s.stats.dataDate), base_finish: iso(base.stats.finish), finish: iso(s.stats.finish), finish_delta_days: delta,
      critical: [...ca], became_critical: [...ca].filter((c) => !cb.has(c)), no_longer_critical: [...cb].filter((c) => !ca.has(c)),
      changed: changed.slice(0, o.maxRows ?? 500), changed_total: changed.length, loops: s.loops ?? [], warnings: [...(r.warnings ?? [])],
    };
  });
  rollback(j);
  return answer;
}

/** compare mode "computed": only what the schedule computes, activity by activity (matched by Project ID and Activity
 *  ID): duration and remaining duration deltas, start / finish shifts and total float delta (working days of the
 *  activity's own calendar in b), and became / no longer critical. Activities only in one file are listed by ID. */
export function compareComputed(a: Db, b: Db, hpd = 8) {
  const ids = (d: Db) => rows(d, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id);
  const keyed = (d: Db) => {
    const proj = new Map(rows(d, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name.toUpperCase()]));
    const tasks = new Map(rows(d, 'TASK').map((t) => [t.task_id, t]));
    const f = computedFields(d, ids(d), hpd);
    return new Map([...f].map(([id, x]) => [`${proj.get(tasks.get(id)!.proj_id)}|${x.code}`, { ...x, t: tasks.get(id)! }]));
  };
  const A = keyed(a), B = keyed(b);
  const cals = calendarResolver(b, []), dh = dayHours(b, hpd, true);
  const P = (s: unknown) => (typeof s === 'string' ? parseP6Date(s) : null);
  const shift = (t: Row, x: unknown, y: unknown) => { const p = P(x), q = P(y); if (p == null || q == null) return null; const c = cals.get(t.clndr_id) ?? cals.fallback(''); return Math.round((c.workBetween(p, q) / 60 / dh.task(t)) * 100) / 100; };
  const num = (x: unknown, y: unknown) => (typeof x === 'number' && typeof y === 'number' ? Math.round((y - x) * 100) / 100 : null);
  const changes: Record<string, unknown>[] = [];
  for (const [k, y] of B) {
    const x = A.get(k);
    if (!x) continue;
    const c: Record<string, unknown> = {
      id: y.code, duration_delta_days: num(x.f.orig_days, y.f.orig_days), remaining_delta_days: num(x.f.rem_days, y.f.rem_days),
      start_shift_days: shift(y.t, x.f.start, y.f.start), finish_shift_days: shift(y.t, x.f.finish, y.f.finish), total_float_delta_days: num(x.f.total_float_days, y.f.total_float_days),
      ...(y.f.critical && !x.f.critical ? { became_critical: true } : {}), ...(x.f.critical && !y.f.critical ? { no_longer_critical: true } : {}),
    };
    for (const f of Object.keys(c)) if (c[f] === 0 || c[f] === null) delete c[f];
    if (Object.keys(c).length > 1) changes.push(c);
  }
  return {
    changes, only_in_a: [...A.keys()].filter((k) => !B.has(k)).map((k) => A.get(k)!.code), only_in_b: [...B.keys()].filter((k) => !A.has(k)).map((k) => B.get(k)!.code),
    became_critical: changes.filter((c) => c.became_critical).map((c) => c.id as string), no_longer_critical: changes.filter((c) => c.no_longer_critical).map((c) => c.id as string),
  };
}
