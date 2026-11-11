// The clone's reading of a project and MPXJ's, compared quantity by quantity (shared by tests/msp-reference.test.ts and the scratch calibration runs).
import assert from 'node:assert/strict';
import { rows, type Db } from '../core/db.ts';
import { projectFromDb } from '../core/msp/shared.ts';
import { slotOfField } from '../core/msp/custom-fields.ts';
import type { MpxjProject } from './mpxj-reference.ts';

// ---------- what each side holds, in the same terms

export interface View {
  tasks: Map<string, { name: string; dur: number; rem: number; total: number; free: number; start: string; finish: string; as: string; af: string; pct: number }>;
  links: { key: string; lagHrs: number }[];
  resources: Map<string, { name: string; rate: number; max: number | null }>;
  /** custom Number and Cost fields of tasks (read from a file: the ones the file's own slots carry), by task UID and slot name (cost1, number2) */
  custom: { kind: 'Number' | 'Cost'; slot: string; uid: string; value: number }[];
  /** the saved baselines read from the file's <Baseline> elements (number 0 is Baseline, 1 is Baseline1 ...) of the tasks in this view */
  baselines: { n: number; uid: string; start: string; finish: string; hours: number }[];
  assigns: Map<string, { material: boolean; cost: number; actual: number; remaining: number; work: number; actualWork: number; remainingWork: number; units: number; qty: number }>;
}
/** The clone's values of a project, by the Microsoft Project UID each task, resource and assignment has (one the file had, or the one the writer gives
 *  it). P6 fields where P6 has them. Dates: for a file read, the row's (what the clone holds of the file's Start / Finish / actuals); for a file written,
 *  the dates the writer puts in the file (projectFromDb); the percent complete is always the writer's own (P6 holds it as durations). */
export function viewOf(db: Db, mode: 'read' | 'write'): View {
  const pid = rows(db, 'PROJECT').find((p) => !p._baseline_of)!.proj_id;
  const m = projectFromDb(db, [pid]);
  const n = (s: string | undefined) => Number(s || 0);
  const v: View = { tasks: new Map(), links: [], resources: new Map(), assigns: new Map(), custom: [], baselines: [] };
  const uidOfTask = new Map<string, string>();
  for (const t of m.tasks) if (t.row && !t.summary) {
    uidOfTask.set(t.row.task_id, t.uid);
    v.tasks.set(t.uid, { name: t.name, dur: n(t.row.target_drtn_hr_cnt), rem: n(t.row.remain_drtn_hr_cnt), total: n(t.row.total_float_hr_cnt), free: n(t.row.free_float_hr_cnt), ...(mode === 'read' ? { start: t.row.target_start_date, finish: t.row.target_end_date, as: t.row.act_start_date, af: t.row.act_end_date } : { start: t.start, finish: t.finish, as: t.actualStart, af: t.actualFinish }), pct: t.pct ?? 0 });
  }
  for (const l of rows(db, 'TASKPRED').filter((x) => x.proj_id === pid)) { const s = uidOfTask.get(l.task_id), p = uidOfTask.get(l.pred_task_id); if (s && p) v.links.push({ key: `${p}->${s}`, lagHrs: n(l.lag_hr_cnt) }); }
  for (const r of m.resources) if (r.row) v.resources.set(r.uid, { name: r.name, rate: r.rate ?? 0, max: r.maxUnits });
  if (mode === 'read') {
    const typeTask = new Map(rows(db, 'UDFTYPE').filter((u) => u.table_name === 'TASK' && u._msp_field).map((u) => [u.udf_type_id, slotOfField(u._msp_field)] as const));
    for (const x of rows(db, 'UDFVALUE')) {
      const slot = typeTask.get(x.udf_type_id), uid = uidOfTask.get(x.fk_id);
      if (slot && uid && (slot.kind === 'Cost' || slot.kind === 'Number') && x.udf_number !== '') v.custom.push({ kind: slot.kind, slot: `${slot.kind.toLowerCase()}${slot.n}`, uid, value: Number(x.udf_number) });
    }
    const byCode = new Map(rows(db, 'TASK').filter((t) => t.proj_id === pid).map((t) => [t.task_code, t]));
    for (const b of rows(db, 'PROJECT').filter((x) => x._baseline_of === pid)) {
      const nm = /- Baseline(\d*)$/.exec(b.proj_short_name); if (!nm) continue;
      for (const t of rows(db, 'TASK').filter((x) => x.proj_id === b.proj_id)) { const o = byCode.get(t.task_code); const uid = o && uidOfTask.get(o.task_id); if (uid) v.baselines.push({ n: nm[1] === '' ? 0 : Number(nm[1]), uid, start: t.target_start_date, finish: t.target_end_date, hours: n(t.target_drtn_hr_cnt) }); }
    }
  }
  const kind = new Map(m.resources.map((r) => [r.uid, r.type]));
  for (const a of m.assignments) if (a.row) {
    const r = a.row;
    v.assigns.set(a.uid, {
      material: kind.get(a.resUid) === 'material', cost: n(r.act_reg_cost) + n(r.act_ot_cost) + n(r.remain_cost) || n(r.target_cost), actual: n(r.act_reg_cost) + n(r.act_ot_cost), remaining: n(r.remain_cost),
      work: n(r.act_reg_qty) + n(r.act_ot_qty) + n(r.remain_qty), actualWork: n(r.act_reg_qty) + n(r.act_ot_qty), remainingWork: n(r.remain_qty), units: n(r.target_qty_per_hr), qty: n(r.act_reg_qty) + n(r.act_ot_qty) + n(r.remain_qty),
    });
  }
  return v;
}

export interface Diff { what: string; key: string; clone: unknown; ref: unknown }
/** The precision the converted file itself carries (stated, not tolerated silently): MPXJ's XML writer rounds a duration or work to whole minutes
 *  (a 27 h 59 min 59.9 s reading in MPXJ is PT28H0M0S in the file), a slack is in tenths of a minute, a units value has 4 decimals, and a material's
 *  quantity is also the file's Work, whole seconds of an hour (a file the clone read and saved again may carry it that way). */
const PRECISION = { hours: 1 / 60 + 1e-9, slack: 1 / 600 + 1e-9, units: 5e-5 + 1e-12, quantity: 1 / 3600 + 1e-9, exact: 1e-9 };
const h = (s: number | undefined | null) => (s == null ? 0 : s / 3600);
const day = (s: string | undefined) => (s ? s.replace('T', ' ').slice(0, 16) : '');

export function compare(ref: MpxjProject, v: View, opts: { exactDurations?: boolean } = {}): { diffs: Diff[]; compared: Record<string, number> } {
  const diffs: Diff[] = [], compared: Record<string, number> = {};
  const eq = (what: string, key: string, clone: number | string, r: number | string, tol = PRECISION.exact) => {
    compared[what] = (compared[what] ?? 0) + 1;
    const same = typeof r === 'number' ? Math.abs(Number(clone) - r) <= tol * Math.max(1, tol === PRECISION.exact ? Math.abs(r) : 1) : String(clone) === r;
    if (!same) diffs.push({ what, key, clone, ref: r });
  };
  const hrs = opts.exactDurations ? PRECISION.exact : PRECISION.hours, slack = opts.exactDurations ? PRECISION.exact : PRECISION.slack, units = opts.exactDurations ? PRECISION.exact : PRECISION.units;
  const pp = ref.property_values as any;
  void pp;
  const tasks = new Map(ref.tasks.map((t) => [String(t.unique_id), t]));
  for (const [uid, t] of v.tasks) {
    const r = tasks.get(uid), k = `task ${uid} ${t.name}`;
    if (!r) { diffs.push({ what: 'task', key: k, clone: 'present', ref: 'absent' }); continue; }
    eq('task duration (h)', k, t.dur, h(r.duration), hrs);
    eq('task remaining duration (h)', k, t.rem, h(r.remaining_duration), hrs);
    eq('task total slack (h)', k, t.total, h(r.total_slack), slack);
    eq('task free slack (h)', k, t.free, h(r.free_slack), slack);
    eq('task start', k, t.start, day(r.start));
    eq('task finish', k, t.finish, day(r.finish));
    eq('task actual start', k, t.as, day(r.actual_start));
    eq('task actual finish', k, t.af, day(r.actual_finish));
    eq('task percent complete', k, t.pct, Number(r.percent_complete ?? 0));
  }
  for (const l of v.links) {
    const [p, s] = l.key.split('->');
    const link = tasks.get(s)?.predecessors?.find((q: any) => String(q.predecessor_task_unique_id) === p);
    if (!link) { diffs.push({ what: 'link', key: l.key, clone: 'present', ref: 'absent' }); continue; }
    // a percentage lag: that percentage of the predecessor's duration (MPXJ holds the percentage x 60 in its seconds)
    const refHrs = /%/.test(link.lag_units ?? '') ? (link.lag / 60 / 100) * h(tasks.get(p)?.duration) : h(link.lag);
    eq('link lag (h)', l.key, l.lagHrs, refHrs, hrs);
  }
  const resources = new Map(ref.resources.map((r) => [String(r.unique_id), r]));
  for (const [uid, r] of v.resources) {
    const m = resources.get(uid);
    if (!m) { diffs.push({ what: 'resource', key: `resource ${uid} ${r.name}`, clone: 'present', ref: 'absent' }); continue; }
    const rate = /^([\d.]+)\/(\w+)$/.exec(m.standard_rate ?? '');
    // MPXJ holds the rate in the unit of its format: per hour is the clone's (and the file's) unit
    if (rate && m.type !== 'MATERIAL') {
      const per = ({ m: 1 / 60, h: 1, d: pp.minutes_per_day / 60, w: pp.minutes_per_week / 60, mo: pp.minutes_per_month / 60, y: pp.minutes_per_year / 60 } as Record<string, number>)[rate[2]];
      eq('resource rate (per hour)', `resource ${uid} ${m.name}`, r.rate, Number(rate[1]) / per, 0.006 / per + PRECISION.exact);
    } else if (m.type !== 'MATERIAL') eq('resource rate (per hour)', `resource ${uid} ${m.name}`, r.rate, 0);
    // (a P6 resource with no max units per hour is written as 100 %: the writer's default for an unknown, named here, not compared; MPXJ holds no max units for a
    // cost or material resource, so only a work resource's are compared)
    if (m.type === 'WORK' && r.max != null) eq('resource max units', `resource ${uid} ${m.name}`, r.max, (m.max_units ?? 0) / 100, units);
  }
  const asg = new Map(ref.assignments.map((a) => [String(a.unique_id), a]));
  for (const [uid, a] of v.assigns) {
    const m = asg.get(uid), k = `assignment ${uid}`;
    if (!m) { diffs.push({ what: 'assignment', key: k, clone: 'present', ref: 'absent' }); continue; }
    eq('assignment cost', k, a.cost, m.cost ?? 0, 1e-6);
    eq('assignment actual cost', k, a.actual, m.actual_cost ?? 0, 1e-6);
    eq('assignment remaining cost', k, a.remaining, m.remaining_cost ?? 0, 1e-6);
    eq('assignment work (h)', k, a.work, h(m.work), hrs);
    eq('assignment actual work (h)', k, a.actualWork, h(m.actual_work), hrs);
    eq('assignment remaining work (h)', k, a.remainingWork, h(m.remaining_work), hrs);
    // Deliberately modelled differently, by name: a material assignment's Microsoft Project units ARE its quantity (500 % = 5 units of the material);
    // the clone's units per hour are the quantity over the duration, as P6's are. So a material's quantity is compared, not its units per hour.
    if (a.material) eq('material assignment quantity', k, a.qty, (m.assignment_units ?? 0) / 100, PRECISION.quantity);
    else eq('assignment units', k, a.units, (m.assignment_units ?? 0) / 100, units);
  }
  // custom Number and Cost fields of tasks: MPXJ's own reading of the slot (cost1 is the amount: the hundredths of the file / 100)
  for (const c of v.custom) { const r = tasks.get(c.uid); eq(`custom ${c.kind.toLowerCase()} field`, `task ${c.uid} ${c.slot}`, c.value, Number(r?.[c.slot] ?? 0), c.kind === 'Cost' ? 1e-6 : PRECISION.exact); }
  // the saved baselines the clone reads (start, finish, duration of each task in each baseline the file has)
  for (const b of v.baselines) {
    const r = tasks.get(b.uid), p = b.n === 0 ? 'baseline' : `baseline${b.n}`, k = `task ${b.uid} baseline ${b.n}`;
    // (what the reference does not hold for a baseline cannot be compared: a baseline it lacks, or one with no duration, where the clone's saved baseline keeps the plan's own)
    if (!r || r[`${p}_start`] == null) continue;
    eq('baseline start', k, b.start, day(r[`${p}_start`]));
    eq('baseline finish', k, b.finish, day(r[`${p}_finish`]));
    if (r[`${p}_duration`] != null) eq('baseline duration (h)', k, b.hours, h(r[`${p}_duration`]), hrs);
  }
  return { diffs, compared };
}

export const report = (name: string, r: { diffs: Diff[]; compared: Record<string, number> }) => {
  const by: Record<string, Diff[]> = {};
  for (const d of r.diffs) (by[d.what] ??= []).push(d);
  return `${name}: ${Object.entries(by).map(([w, l]) => `${w} x${l.length} e.g. ${JSON.stringify(l.slice(0, 2))}`).join('; ') || 'equal'}`;
};
export const compared = (r: { compared: Record<string, number> }, ...what: string[]) => { for (const w of what) assert.ok((r.compared[w] ?? 0) > 0, `${w}: nothing was compared`); };

