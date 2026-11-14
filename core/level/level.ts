// Tools > Level Resources, as P6 does it (the sources are in the platform's ledger, "P6 RESEARCH II, 2026-11-14").
// THE LEVELER DECIDES THE DELAYS, THE SCHEDULER DATES EVERYTHING:
//  - One activity at a time: an activity is taken once all its predecessors are placed; among those ready, the Leveling Priorities list decides, then the
//    Activity ID. Activities with a mandatory constraint are taken first and are not delayed.
//  - An activity is delayed, whole (never split or stretched), until every day of it fits under each leveled resource's Max Units/Time (the limit in
//    force that day). An activity that alone needs more than the limit cannot be leveled: it stays where it is and is listed.
//  - "Level resources only within activity Total Float" (it preserves the scheduled dates): an activity is delayed only up to its late date less the
//    float to preserve; if it does not fit, it is tried once more against the limit raised by "Max percent to over-allocate"; if it still does not fit
//    it stays where the schedule put it.
//  - The start each leveled activity is given goes to the scheduler as its earliest start, and the scheduler calculates the dates of every activity from
//    there by its own rules (calendars, milestones, resource dependent activities, level of effort and WBS summary spans, constraints, lags).
//  - "Preserve scheduled early and late dates" ticked (P6's default): those dates go to the Remaining Early dates (Start / Finish) and the planned dates
//    of the activities leveling delayed; Early, Late and Total Float stay as they were. Unticked: every date and float is the calculation's, and a
//    backward leveling brings the late dates of activities forward where their resources do not allow them (the leveling reversed).
import { addField, rows, table, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date, MIN_PER_DAY } from '../dates.ts';
import type { Finding } from '../findings.ts';
import { activityWork, calendarResolver, optionsFor, p6num, scheduleProjects, type LagCalendar, type SchedOptions } from '../schedule/cpm.ts';
import { WorkCalendar } from '../calendar/calendar.ts';
import { noResourceAssigned, notJudgedNotes } from '../notes.ts';
import { limitsOverTime, notJudged, resourceLimits } from '../resource/usage.ts';
import { logicRelationships } from '../progress/snapshots.ts';
import { syncAssignmentDates } from '../resource/assign.ts';
import { inLoopCheck, loopsOfLinks } from '../xer/validate.ts';

/** One row of P6's Leveling Priorities: a column of the activity (or `priority_num`, the project's leveling priority), ascending unless `desc`. */
export interface LevelPriority { field: string; desc?: boolean }
export interface LevelOptions {
  /** Preserve scheduled early and late dates (default: the project's stored setting; P6's default is ticked). */
  preserve?: boolean;
  /** Level resources only within activity Total Float (it preserves the scheduled dates). */
  withinFloat?: boolean;
  /** Preserve minimum float when leveling, in hours (used within float). */
  minFloatHrs?: number;
  /** Max percent to over-allocate resources (used within float, for an activity that does not fit in its float). */
  overAllocPct?: number;
  /** The Leveling Priorities, the first deciding (default: the project's stored list; P6's default is the Activity Leveling Priority, ascending). */
  priorities?: LevelPriority[];
  /** Level all resources (default: the project's stored setting; off: only the resources marked to be leveled). */
  allResources?: boolean;
  /** Level only these resources. */
  rsrcIds?: string[];
  /** These activities (task ids) are placed first, in this order, ahead of the priority rule. */
  first?: string[];
  /** The schedule options of the calculation the leveling follows, when they are not the project's stored ones (schedule's options for one run). */
  schedule?: Partial<SchedOptions>;
}
export interface LevelSettings { preserve: boolean; withinFloat: boolean; minFloatHrs: number; overAllocPct: number; priorities: LevelPriority[] }
/** moved: activities whose Start is later than before (why: its own resources, or a predecessor that was delayed); cannot: activities left where they
 *  were, over the limit; peaks: per leveled resource, the highest use in a day after leveling (unit-hours) against its limit that day (Max Units/Time
 *  x the hours of the day on the calendars of the activities using it). */
export interface LevelResult {
  /** the leveling report as the desktop dialog shows it, the notes included */ log: string; /** the settings and the counts of the report (a tool answer lists the activities itself) */ report: string;
  delayed: number; findings: Finding[]; /** what the run did not do, in words (also in `log`): a resource with no limit is not leveled */ notes: string[];
  moved: { taskId: string; code: string; from: string; start: string; finish: string; why: 'resource' | 'predecessor' }[];
  cannot: { taskId: string; code: string; why: string }[];
  peaks: { rsrcId: string; code: string; peak: number; limit: number; day: string; overallocated: boolean }[];
  /** the settings the run used */ settings: LevelSettings;
  /** how many resources were leveled */ leveled: number;
  /** nothing was leveled and nothing changed, and why (a loop in the logic; activities with no dates; a schedule that cannot be calculated) */ refused?: string;
}

const PRIO: Record<string, number> = { PT_Top: 1, PT_High: 2, PT_Normal: 3, PT_Low: 4, PT_Lowest: 5 };
const MANDATORY = new Set(['CS_MANDSTART', 'CS_MANDFIN']);
const EPS = 1e-6;

/** The Leveling Priorities by P6's names (level_resources priority_by takes them in small letters with underscores). */
export const PRIORITY_NAMES: Record<string, string> = {
  priority_type: 'Activity Leveling Priority', task_code: 'Activity ID', early_start_date: 'Early Start', early_end_date: 'Early Finish', late_start_date: 'Late Start', late_end_date: 'Late Finish',
  total_float_hr_cnt: 'Total Float', free_float_hr_cnt: 'Free Float', target_drtn_hr_cnt: 'Original Duration', remain_drtn_hr_cnt: 'Remaining Duration', target_start_date: 'Planned Start',
  target_end_date: 'Planned Finish', priority_num: 'Project Leveling Priority',
};

/** The Leveling Priorities a project stores (SCHEDOPTIONS.LevelPriorityList: one "column,ASC|DESC" a line, the line break written as two DEL characters as
 *  everywhere in an XER). No stored options: P6's default for a new project, the Activity Leveling Priority ascending. An empty list: none (the Activity ID decides). */
export function storedPriorities(so: Row | undefined): LevelPriority[] {
  if (!so || so.LevelPriorityList == null) return [{ field: 'priority_type' }];
  return so.LevelPriorityList.split(/\x7f\x7f|\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [field, dir] = l.split(','); return { field: field.trim(), ...(/^desc/i.test((dir ?? '').trim()) ? { desc: true } : {}) }; });
}
/** The leveling settings a project stores (Tools > Level Resources keeps them with the project). */
export function storedLevelOptions(db: Db, projId: string): LevelSettings & { allResources: boolean } {
  const so = rows(db, 'SCHEDOPTIONS').find((r) => r.proj_id === projId);
  return {
    preserve: so?.level_keep_sched_date_flag !== 'N', withinFloat: so?.level_within_float_flag === 'Y', minFloatHrs: Number(so?.level_float_thrs_cnt || 0) || 0,
    overAllocPct: Number(so?.level_over_alloc_pct || 0) || 0, priorities: storedPriorities(so), allResources: so?.level_all_rsrc_flag !== 'N',
  };
}

export function levelResources(db: Db, projIds: string[], opts: LevelOptions): LevelResult {
  const findings: Finding[] = [];
  const cals = calendarResolver(db, findings);
  const projects = new Map(rows(db, 'PROJECT').filter((p) => projIds.includes(p.proj_id)).map((p) => [p.proj_id, p]));
  const tasks = rows(db, 'TASK').filter((t) => projects.has(t.proj_id));
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  // the settings: what the call gives, else what the first project stores (P6 asks whose settings to use when several projects are open)
  const stored = storedLevelOptions(db, projIds[0]);
  const withinFloat = opts.withinFloat ?? stored.withinFloat;
  const settings: LevelSettings = {
    withinFloat, preserve: withinFloat ? true : opts.preserve ?? stored.preserve, minFloatHrs: opts.minFloatHrs ?? stored.minFloatHrs,
    overAllocPct: opts.overAllocPct ?? stored.overAllocPct, priorities: opts.priorities ?? stored.priorities,
  };
  const sched = new Map([...projects].map(([id, p]) => [id, optionsFor(db, p, opts.schedule ?? {})]));

  // the limit of each resource (units per hour) on each day; a resource with no limit set cannot be overallocated, so it is not leveled (it is listed)
  const rsrcs = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r]));
  const cap = resourceLimits(db); // the one predicate for "has a limit" (resource_histogram and schedule_index use it too)
  const limitAt = limitsOverTime(db, cap);
  const leveled = (id: string) => (opts.rsrcIds ? opts.rsrcIds.includes(id) : (opts.allResources ?? stored.allResources) || rsrcs.get(id)?.level_flag === 'Y') && cap.has(id);
  const assigns = new Map<string, Row[]>();
  for (const a of rows(db, 'TASKRSRC')) if (byId.has(a.task_id) && leveled(a.rsrc_id)) { if (!assigns.has(a.task_id)) assigns.set(a.task_id, []); assigns.get(a.task_id)!.push(a); }
  const leveledIds = [...new Set([...assigns.values()].flat().map((a) => a.rsrc_id))];

  // the calendar an activity's remaining work runs on and its remaining duration, as the schedule reads them (a resource dependent activity: its resource's calendar)
  const work = activityWork(db, cals), worked = new Map<string, { cal: WorkCalendar; dur: number }>();
  const workOf = (t: Row) => { let w = worked.get(t.task_id); if (!w) { const x = work(t, cals.fallback(projects.get(t.proj_id)?.clndr_id)); worked.set(t.task_id, (w = { cal: x.cal, dur: t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile' ? 0 : Math.max(0, Math.round((Number.isFinite(x.hrs) ? x.hrs : 0) * 60)) })); } return w; };
  const calOf = (t: Row): WorkCalendar => workOf(t).cal;
  // the lag of a relationship runs on the calendar the project's schedule options name, as in the schedule
  const lagCalOf = (pred: Row, succ: Row): WorkCalendar => {
    const kind: LagCalendar = sched.get(succ.proj_id)!.lagCalendar;
    return kind === 'successor' ? calOf(succ) : kind === '24h' ? WorkCalendar.continuous() : kind === 'project' ? cals.fallback(projects.get(succ.proj_id)?.clndr_id) : calOf(pred);
  };
  const shift = (cal: WorkCalendar, t: number, minutes: number) => (minutes > 0 ? cal.addWork(t, minutes) : minutes < 0 ? cal.subWork(t, -minutes) : t);
  const preds = new Map<string, Row[]>(), succsOf = new Map<string, Row[]>();
  for (const r of logicRelationships(db)) if (byId.has(r.task_id) && byId.has(r.pred_task_id)) {
    if (!preds.has(r.task_id)) preds.set(r.task_id, []);
    preds.get(r.task_id)!.push(r);
    if (!succsOf.has(r.pred_task_id)) succsOf.set(r.pred_task_id, []);
    succsOf.get(r.pred_task_id)!.push(r);
  }
  const lagOf = (r: Row) => Math.round(Number(r.lag_hr_cnt || 0) * 60);
  const durOf = (t: Row) => workOf(t).dur;
  const open = (t: Row) => !t.act_end_date && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE';
  const remStart = (t: Row) => parseP6Date(t.restart_date || t.early_start_date), remFinish = (t: Row) => parseP6Date(t.reend_date || t.early_end_date);

  // what an activity needs of each of its leveled resources on each day of [s, f): the hours of the activity's calendar that day x the remaining units per
  // hour of its assignments of that resource (a resource assigned twice counts with both)
  const demand = (t: Row, s: number, f: number): Map<string, Map<number, number>> => {
    const cal = calOf(t), out = new Map<string, Map<number, number>>();
    for (const a of assigns.get(t.task_id) ?? []) {
      const rate = Number(a.remain_qty_per_hr || a.target_qty_per_hr || 0) || (Number(t.remain_drtn_hr_cnt) ? Number(a.remain_qty || 0) / Number(t.remain_drtn_hr_cnt) : 0);
      let m = out.get(a.rsrc_id);
      if (!m) out.set(a.rsrc_id, (m = new Map()));
      for (let d = Math.floor(s / MIN_PER_DAY); d * MIN_PER_DAY < f; d++) {
        const h = cal.workBetween(Math.max(s, d * MIN_PER_DAY), Math.min(f, (d + 1) * MIN_PER_DAY)) / 60;
        if (h > 0) m.set(d, (m.get(d) ?? 0) + h * rate);
      }
    }
    return out;
  };
  const dayHours = (cal: WorkCalendar, day: number) => cal.shiftsOn(day).reduce((x, s) => x + s.end - s.start, 0) / 60;
  /** A tally of use per resource and day, with the hours of that day the limit is measured over (the longest day of the calendars of the activities using it). */
  type Tally = { use: Map<string, Map<number, number>>; hours: Map<string, Map<number, number>> };
  const tally = (): Tally => ({ use: new Map(), hours: new Map() });
  const at = (m: Map<string, Map<number, number>>, rid: string) => { let x = m.get(rid); if (!x) m.set(rid, (x = new Map())); return x; };
  const add = (u: Tally, t: Row, s: number, f: number) => {
    const cal = calOf(t);
    for (const [rid, days] of demand(t, s, f)) { const use = at(u.use, rid), hrs = at(u.hours, rid); for (const [d, h] of days) { use.set(d, (use.get(d) ?? 0) + h); hrs.set(d, Math.max(hrs.get(d) ?? 0, dayHours(cal, d))); } }
  };
  type Clash = { day: number; /** the activity alone is over the limit that day: what it needs (h) against the limit (h) */ alone?: { need: number; limit: number } };
  /** The day of [s, f) on which the activity does not fit (the earliest, or with `latest` the latest). */
  const clashOf = (u: Tally, t: Row, s: number, f: number, raise: number, latest = false): Clash | null => {
    const cal = calOf(t);
    let out: Clash | null = null;
    for (const [rid, days] of demand(t, s, f)) {
      const have = at(u.use, rid);
      for (const [d, h] of days) {
        const lim = limitAt(rid, d * MIN_PER_DAY) * dayHours(cal, d) * raise;
        if ((have.get(d) ?? 0) + h <= lim + EPS) continue;
        const alone = h > lim + EPS ? { need: h, limit: lim } : undefined;
        if (!out || (latest ? d > out.day : d < out.day)) out = { day: d, alone };
        else if (d === out.day && alone) out.alone = alone;
      }
    }
    return out;
  };
  /** A limit of a resource of the activity is higher at some time after `day` (or, `earlier`, before it) than on that day: another place can fit what is over the limit alone there. */
  const higherLimit = (t: Row, day: number, earlier = false) => (assigns.get(t.task_id) ?? []).some((a) => limitAt.changes(a.rsrc_id).some((c) => (earlier ? c.at < day * MIN_PER_DAY : c.at > day * MIN_PER_DAY) && c.perHour > limitAt(a.rsrc_id, day * MIN_PER_DAY)));
  const hours = (v: number) => p6num(Math.round(v * 100) / 100);

  // A completed activity has no load left. An activity in progress is leveled like one not started, as P6 does (R. Winter, "Leveling in P6": P6 delays the
  // remaining work of a started activity): its remaining work is what is placed, and delayed whole.
  const placed = new Map<string, { s: number; f: number }>();
  const done = new Map<string, { s: number; f: number }>();
  for (const t of tasks) if (t.act_end_date) done.set(t.task_id, { s: parseP6Date(t.act_start_date)!, f: parseP6Date(t.act_end_date)! });
  const pending = tasks.filter((t) => !done.has(t.task_id) && open(t));
  // "Its predecessors first" follows the logic as the calculation does: also through completed activities (retained logic carries a predecessor's delay through
  // an activity completed out of sequence). before: the activities to place that come before one; after: those that come after it.
  const toPlace = new Set(pending.map((t) => t.task_id));
  const comesBefore = new Map<string, Set<string>>(), comesAfter = new Map<string, Set<string>>(pending.map((t) => [t.task_id, new Set<string>()]));
  const upOf = (id0: string): Set<string> => {
    const stack = [id0], onPath = new Set<string>();
    while (stack.length) {
      const id = stack[stack.length - 1];
      if (comesBefore.has(id)) { stack.pop(); continue; }
      const ps = (preds.get(id) ?? []).map((r) => r.pred_task_id);
      const need = ps.filter((q) => done.has(q) && !comesBefore.has(q) && !onPath.has(q));
      if (need.length) { onPath.add(id); stack.push(...need); continue; }
      const out = new Set<string>();
      for (const q of ps) { if (toPlace.has(q)) out.add(q); else if (done.has(q)) for (const x of comesBefore.get(q) ?? []) out.add(x); }
      comesBefore.set(id, out);
      stack.pop();
    }
    return comesBefore.get(id0)!;
  };
  for (const t of pending) for (const q of upOf(t.task_id)) comesAfter.get(q)!.add(t.task_id);

  // ---- what stops a leveling before anything is done
  const loops = loopsOfLinks([...preds.values()].flat().filter((r) => inLoopCheck(byId.get(r.task_id)!.task_type) && inLoopCheck(byId.get(r.pred_task_id)!.task_type)).map((r): [string, string] => [r.pred_task_id, r.task_id]))
    .map((l) => l.map((id) => byId.get(id)!.task_code));
  const undated = pending.filter((t) => remStart(t) == null);
  let refused: string | undefined = loops.length ? `the logic has ${loops.length === 1 ? 'a loop' : `${loops.length} loops`} (${loops.map((l) => l.join(', ')).join('; ')}): a schedule with a loop is not leveled; change or delete one relationship of ${loops.length === 1 ? 'the loop' : 'each loop'}`
    : undated.length ? `${undated.length === 1 ? `activity ${undated[0].task_code} has` : `${undated.length} activities have`} no calculated dates: run schedule first` : undefined;
  if (loops.length) findings.push({ severity: 'error', code: 'LEVEL_LOOP', message: `Not leveled: ${refused}.`, p6: 'P6 cannot level a network with loops.' });

  // ---- the order: the priorities list, then the Activity ID (blanks last)
  const T = table(db, 'TASK');
  const taskFields = new Set(T.fields);
  const unread = settings.priorities.filter((p) => p.field !== 'priority_num' && !taskFields.has(p.field)).map((p) => p.field);
  const priorities = settings.priorities.filter((p) => !unread.includes(p.field));
  type Key = number | string | null;
  const valueOf = (t: Row, field: string): Key => {
    const v = field === 'priority_num' ? projects.get(t.proj_id)?.priority_num : t[field];
    if (v == null || v === '') return null;
    if (field === 'priority_type') return PRIO[v] ?? null;
    if (/_date2?$/.test(field)) return parseP6Date(v);
    return field !== 'task_code' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  };
  const keys = new Map(pending.map((t) => [t.task_id, priorities.map((p) => valueOf(t, p.field))]));
  // (numbers before text; text as P6 sorts an Activity ID column, character by character: A10 before A9)
  const text = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const cmp = (x: Key, y: Key): number => (x === y ? 0 : typeof x === 'number' && typeof y === 'number' ? x - y : typeof x === 'number' ? -1 : typeof y === 'number' ? 1 : text(String(x), String(y)));
  const firstAt = new Map((opts.first ?? []).map((id, i) => [id, i]));
  // (a constraint is not applied to an activity that has started)
  const mandatory = (t: Row) => !t.act_start_date && (MANDATORY.has(t.cstr_type) || MANDATORY.has(t.cstr_type2));
  const before = (a: Row, b: Row): number => {
    const fa = firstAt.get(a.task_id), fb = firstAt.get(b.task_id);
    if (fa != null || fb != null) return fa == null ? 1 : fb == null ? -1 : fa - fb;
    if (mandatory(a) !== mandatory(b)) return mandatory(a) ? -1 : 1;
    const x = keys.get(a.task_id)!, y = keys.get(b.task_id)!;
    for (let i = 0; i < priorities.length; i++) {
      // (a blank is after every value, ascending or descending)
      const c = x[i] == null || y[i] == null ? (x[i] == null ? (y[i] == null ? 0 : 1) : -1) : priorities[i].desc ? cmp(y[i], x[i]) : cmp(x[i], y[i]);
      if (c) return c;
    }
    return text(a.task_code, b.task_code) || Number(a.task_id) - Number(b.task_id);
  };
  const heapOf = (lt: (a: Row, b: Row) => number) => {
    const heap: Row[] = [];
    return {
      get size() { return heap.length; },
      push(t: Row) { heap.push(t); let i = heap.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (lt(heap[i], heap[q]) >= 0) break; [heap[i], heap[q]] = [heap[q], heap[i]]; i = q; } },
      pop(): Row { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && lt(heap[l], heap[m]) < 0) m = l; if (r < heap.length && lt(heap[r], heap[m]) < 0) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; },
    };
  };

  // ---- forward: the start each leveled activity can have (from where it stands, and from its predecessors by the leveler's own arithmetic), then the dates the
  // scheduler gives from those starts. Where the scheduler's logic puts a leveled activity later than the leveler placed it, the placing is done again from the
  // scheduler's dates, until the two agree (each round only moves activities later, and what comes first in the logic is settled first).
  let cannot: LevelResult['cannot'] = [];
  const floors = new Map<string, number>(), byResource = new Set<string>();
  const dated = new Map<string, Row>();
  let finishOf: Record<string, { finish: number | null }> = {};
  let assumed: string[] = []; // (no data date: the planned start the calculation used, said as schedule says it)
  let stands = new Map(pending.map((t) => [t.task_id, { s: remStart(t)!, f: remFinish(t) }]));
  // As Late As Possible is not applied in a leveling, as in P6 (Ten Six, "Primavera P6 and the As Late As Possible constraint": "the ALAP constraint is ignored
  // when resource leveling"; R. Winter: P6 levels from the current dates and does not calculate the schedule again). Such an activity is leveled from where the
  // schedule put it and does not follow a finish that the leveling moves.
  const alap = pending.filter((t) => !t.act_start_date && (t.cstr_type === 'CS_ALAP' || t.cstr_type2 === 'CS_ALAP'));
  // A leveling goes on from the dates as they stand, an earlier leveling's delays among them (R. Winter: P6 does not calculate the schedule again when it
  // levels). Our calculation dates everything after the delays, so the dates as they stand must be ones it gives: held to every start as it stands, it must
  // return those starts and finishes. Where it does not (an edit since the last schedule, a file changed after its last calculation), a leveling would mix
  // recalculated dates with saved ones and call a recalculation a delay: refused, with the call that settles it.
  if (!refused && leveledIds.length) {
    const got = new Map<string, Row>();
    const run = scheduleProjects(db, projIds, { ...(opts.schedule ?? {}), startFloor: new Map(pending.filter((t) => !mandatory(t)).map((t) => [t.task_id, stands.get(t.task_id)!.s])) }, (row, values) => { if (row.task_code != null) got.set(row.task_id, { ...(got.get(row.task_id) ?? {}), ...values }); });
    if (!run.ok) refused = `the dates cannot be calculated: ${run.findings.filter((x) => x.severity === 'error').map((x) => x.message.replace(/\.$/, '')).join('; ')}`;
    else {
      const off = pending.filter((t) => {
        const v = got.get(t.task_id), st = stands.get(t.task_id)!, cal = calOf(t), s = parseP6Date(v?.restart_date), f = parseP6Date(v?.reend_date);
        return (s != null && cal.workBetween(st.s, s) > 0) || (f != null && st.f != null && cal.workBetween(st.f, f) !== 0);
      });
      if (off.length) refused = `the saved dates of ${off.length === 1 ? `activity ${off[0].task_code} are` : `${off.length} activities are`} not what the calculation gives: run schedule first, or schedule with level_resources: true to calculate and level in one call`;
    }
  }
  const alapIds = new Set(alap.map((t) => t.task_id));
  // (the order the activities are placed in; the backward leveling takes them in the reverse of it)
  const rank = new Map<string, number>();
  // (no resource to level: nothing is placed, calculated or written)
  while (!refused && leveledIds.length) {
    cannot = []; floors.clear(); placed.clear(); for (const [k, v] of done) placed.set(k, v);
    const usage = tally();
    const pushedOn = new Set<string>();
    const remaining = new Set(pending.map((t) => t.task_id));
    const waiting = new Map<string, number>();
    for (const t of pending) waiting.set(t.task_id, comesBefore.get(t.task_id)!.size);
    const queued = new Set<string>();
    const ready = heapOf(before);
    // (an activity with a mandatory constraint is taken first, whatever its logic)
    for (const t of pending) if (!waiting.get(t.task_id) || mandatory(t)) { ready.push(t); queued.add(t.task_id); }
    rank.clear();
    while (remaining.size && ready.size) {
      const t = ready.pop();
      remaining.delete(t.task_id);
      rank.set(t.task_id, rank.size);
      for (const sid of comesAfter.get(t.task_id)!) {
        if (!remaining.has(sid) || queued.has(sid)) continue;
        const n = waiting.get(sid)! - 1;
        waiting.set(sid, n);
        if (n === 0) { ready.push(byId.get(sid)!); queued.add(sid); }
      }
      const cal = calOf(t), dur = durOf(t);
      // where it stands: its Remaining Early dates (a leveling goes on from an earlier one), which after a calculation are the schedule's own dates
      const { s: s0, f: f0 } = stands.get(t.task_id)!;
      // The dates already honour all logic; only a predecessor that leveling moved can push this one.
      let s = s0;
      for (const r of preds.get(t.task_id) ?? []) {
        const p = placed.get(r.pred_task_id);
        if (!p || !pushedOn.has(r.pred_task_id)) continue;
        const byStart = r.pred_type === 'PR_SS' || r.pred_type === 'PR_SF';
        if (byStart && byId.get(r.pred_task_id)!.act_start_date) continue; // a started predecessor's start is its actual start: delaying its remaining work does not move it
        const from = byStart ? p.s : p.f;
        let v = shift(lagCalOf(byId.get(r.pred_task_id)!, t), from, lagOf(r));
        if (r.pred_type === 'PR_FF' || r.pred_type === 'PR_SF') v = dur ? cal.subWork(v, dur) : v;
        s = Math.max(s, v);
      }
      const pushed = s > s0;
      // (a finish milestone sits on its predecessor's finish, at the end of a work period; everything else starts in work time)
      if (pushed && t.task_type !== 'TT_FinMile') s = cal.nextWorkStart(s);
      let f = !pushed && f0 != null ? f0 : dur ? cal.addWork(s, dur) : s; // not pushed: its own finish stands
      const here = { s, f };
      if ((assigns.get(t.task_id) ?? []).length) {
        // within float: only up to its late date (the late finish for finish float, the late start for start float) less the float to preserve
        const kind = sched.get(t.proj_id)!.floatType, hold = Math.round(settings.minFloatHrs * 60);
        const ls = parseP6Date(t.late_start_date), lf = parseP6Date(t.late_end_date);
        const inFloat = (ss: number, ff: number): boolean => {
          if (!settings.withinFloat) return true;
          const okF = lf == null || ff <= shift(cal, lf, -hold), okS = ls == null || ss <= shift(cal, ls, -hold);
          return kind === 'finish' ? okF : kind === 'start' ? okS : okF && okS;
        };
        // Delay until every day of the activity fits. The next try starts on the next working day after the LATEST day that does not fit: every start up to
        // that day still has the activity on it. (The search ends: a day without room is a day something is placed on, or a day the activity alone is over a
        // limit that never rises.)
        const search = (raise: number): { s: number; f: number } | string => {
          let ss = here.s, ff = here.f;
          for (;;) {
            const clash = clashOf(usage, t, ss, ff, raise, true);
            if (!clash) return { s: ss, f: ff };
            if (clash.alone && !higherLimit(t, clash.day)) return `alone it needs ${hours(clash.alone.need)} h in a day against the limit of ${hours(clash.alone.limit)} h`;
            if (mandatory(t)) return 'it has a mandatory constraint, so it is not delayed';
            const ns = cal.nextWorkStart((Math.max(clash.day, Math.floor(ss / MIN_PER_DAY)) + 1) * MIN_PER_DAY), nf = dur ? cal.addWork(ns, dur) : ns;
            if (!inFloat(ns, nf)) return 'it does not fit within its total float';
            ss = ns; ff = nf;
          }
        };
        let got = search(1);
        // within float only: tried once more against the limit raised by the percent to over-allocate
        if (typeof got === 'string' && settings.withinFloat && settings.overAllocPct > 0) { const again = search(1 + settings.overAllocPct / 100); if (typeof again !== 'string') got = again; }
        if (typeof got === 'string') cannot.push({ taskId: t.task_id, code: t.task_code, why: got });
        else { if (got.s > s + 1) byResource.add(t.task_id); s = got.s; f = got.f; }
        add(usage, t, s, f);
        if (!mandatory(t)) floors.set(t.task_id, s);
      }
      // (As Late As Possible is not applied in a leveling: an activity held late by it, with no resource to level, stays where it stands)
      else if (alapIds.has(t.task_id)) floors.set(t.task_id, s);
      placed.set(t.task_id, { s, f });
      if (s > s0 + 1) pushedOn.add(t.task_id);
    }
    // the dates: the scheduler's, from the starts the leveler gave (nothing is written by this calculation; what is written is chosen below)
    if (!byResource.size && settings.preserve) break;
    dated.clear();
    const run = scheduleProjects(db, projIds, { ...(opts.schedule ?? {}), startFloor: floors }, (row, values) => { const id = row.task_code != null ? row.task_id : ''; if (id) dated.set(id, { ...(dated.get(id) ?? {}), ...values }); });
    assumed = run.findings.filter((x) => x.code === 'NO_DATA_DATE').map((x) => x.message);
    if (!run.ok) { refused = `the dates after leveling cannot be calculated: ${run.findings.filter((x) => x.severity === 'error').map((x) => x.message.replace(/\.$/, '')).join('; ')}`; break; }
    finishOf = run.projects;
    const startOf = (id: string) => parseP6Date(dated.get(id)?.restart_date);
    if (![...floors].some(([id, s]) => { const v = startOf(id); return v != null && v > s + 1; })) break;
    stands = new Map(pending.map((t) => { const v = dated.get(t.task_id), s = parseP6Date(v?.restart_date), f = parseP6Date(v?.reend_date); return [t.task_id, s == null ? stands.get(t.task_id)! : { s, f }]; }));
  }
  const movedList: LevelResult['moved'] = [];
  const written = new Set<string>();
  if (!refused && dated.size) {
    for (const fld of ['early_start_date', 'early_end_date', 'late_start_date', 'late_end_date', 'restart_date', 'reend_date', 'rem_late_start_date', 'rem_late_end_date', 'total_float_hr_cnt', 'free_float_hr_cnt', 'target_start_date', 'target_end_date', 'driving_path_flag']) addField(T, fld);
    for (const t of tasks) {
      const v = dated.get(t.task_id);
      if (!v || t.act_end_date) { if (v && !settings.preserve) Object.assign(t, v); continue; }
      const was = remStart(t), now = parseP6Date(v.restart_date), later = was != null && now != null && now > was + 1;
      if (later && open(t)) movedList.push({ taskId: t.task_id, code: t.task_code, from: formatP6Date(was!), start: v.restart_date, finish: v.reend_date, why: byResource.has(t.task_id) ? 'resource' : 'predecessor' });
      if (!settings.preserve) { Object.assign(t, v); written.add(t.task_id); continue; }
      // preserved: leveling only delays. The Remaining Early dates (the activity's Start and Finish) and, not started, the planned dates of what it delayed;
      // a level of effort or WBS summary activity takes the span the delayed activities give it. Early, late and float are not touched.
      const span = !open(t) && (v.restart_date !== t.restart_date || v.reend_date !== t.reend_date);
      if (!later && !span) continue;
      Object.assign(t, { restart_date: v.restart_date, reend_date: v.reend_date }, v.target_start_date != null ? { target_start_date: v.target_start_date, target_end_date: v.target_end_date } : {}, span && v.remain_drtn_hr_cnt != null ? { remain_drtn_hr_cnt: v.remain_drtn_hr_cnt } : {}, span && v.target_drtn_hr_cnt != null ? { target_drtn_hr_cnt: v.target_drtn_hr_cnt } : {});
      written.add(t.task_id);
    }
    if (!settings.preserve) { addField(table(db, 'PROJECT'), 'scd_end_date'); for (const [id, p] of projects) { const f = finishOf[id]?.finish; if (f != null) p.scd_end_date = formatP6Date(f); } }
  }

  movedList.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  // ---- backward (the scheduled dates are not preserved): the calculation's late dates are the latest the logic allows; where the resources do not allow an
  // activity there, it is advanced to an earlier date, and with it the activities before it. The leveling reversed: the last of the forward order first.
  if (!refused && !settings.preserve && dated.size) {
    const todo = pending;
    const back = tally();
    const adjusted = new Map<string, { s: number; f: number }>();
    const left = new Set(todo.map((t) => t.task_id)), wait = new Map<string, number>();
    for (const t of todo) wait.set(t.task_id, comesAfter.get(t.task_id)!.size);
    const readyB = heapOf((a, b) => (rank.get(b.task_id) ?? 0) - (rank.get(a.task_id) ?? 0));
    for (const t of todo) if (!wait.get(t.task_id)) readyB.push(t);
    while (left.size && readyB.size) {
      const t = readyB.pop();
      left.delete(t.task_id);
      for (const pid of comesBefore.get(t.task_id)!) {
        if (!left.has(pid)) continue;
        const n = wait.get(pid)! - 1;
        wait.set(pid, n);
        if (n === 0) readyB.push(byId.get(pid)!);
      }
      const cal = calOf(t), dur = durOf(t);
      const ls0 = parseP6Date(t.late_start_date), lf0 = parseP6Date(t.late_end_date);
      if (ls0 == null || lf0 == null) continue;
      let s = ls0, f = lf0;
      // a successor that was advanced pulls this one with it, by the relationship between them
      for (const r of succsOf.get(t.task_id) ?? []) {
        const q = adjusted.get(r.task_id);
        if (!q) continue;
        let v = shift(lagCalOf(t, byId.get(r.task_id)!), r.pred_type === 'PR_FF' || r.pred_type === 'PR_SF' ? q.f : q.s, -lagOf(r));
        if (r.pred_type === 'PR_SS' || r.pred_type === 'PR_SF') v = dur ? cal.addWork(v, dur) : v;
        if (v < f) { f = t.task_type === 'TT_Mile' && cal.nextWorkStart(v) === v ? v : cal.prevWorkEnd(v); s = dur ? cal.subWork(f, dur) : f; }
      }
      if ((assigns.get(t.task_id) ?? []).length) {
        if (!mandatory(t)) for (;;) {
          const clash = clashOf(back, t, s, f, 1); // the earliest day without room: every finish from that day on still has the activity on it
          if (!clash || (clash.alone && !higherLimit(t, clash.day, true))) break;
          f = cal.prevWorkEnd(Math.min(clash.day, Math.floor((f - 1) / MIN_PER_DAY)) * MIN_PER_DAY);
          s = dur ? cal.subWork(f, dur) : f;
        }
        add(back, t, s, f);
      }
      if (f === lf0 && s === ls0) continue;
      adjusted.set(t.task_id, { s, f });
      const es = parseP6Date(t.early_start_date), ef = parseP6Date(t.early_end_date), kind = sched.get(t.proj_id)!.floatType;
      const fin = ef == null ? null : cal.workBetween(ef, f), st = es == null ? null : cal.workBetween(es, s);
      const tf = kind === 'finish' ? fin : kind === 'start' ? st : fin == null || st == null ? fin ?? st : Math.min(fin, st);
      const lss = formatP6Date(s), lfs = formatP6Date(f);
      Object.assign(t, { late_start_date: lss, late_end_date: lfs, rem_late_start_date: lss, rem_late_end_date: lfs }, tf == null ? {} : { total_float_hr_cnt: p6num(tf / 60) });
    }
  }
  // the assignments follow their activities (remaining, late and planned dates)
  if (written.size) syncAssignmentDates(db, written);

  // ---- what is still over its limit, and each resource's peak day: read from the dates as they now stand
  const final = tally();
  if (!refused) for (const t of pending) { const s = remStart(t), f = remFinish(t); if (s != null && f != null) add(final, t, s, f); }
  const still: string[] = [];
  const peaks: LevelResult['peaks'] = [];
  for (const [rid, u] of final.use) {
    const hrs = final.hours.get(rid)!, lim = (d: number) => limitAt(rid, d * MIN_PER_DAY) * (hrs.get(d) ?? 0);
    let worst = 0, day = 0, peak = 0, pday = 0;
    for (const [d, h] of u) { if (h - lim(d) > worst) { worst = h - lim(d); day = d; } if (h > peak) { peak = h; pday = d; } }
    if (worst > 0.01) still.push(`      Resource ${rsrcs.get(rid)?.rsrc_short_name ?? rid} still overallocated by ${hours(worst)} h on ${formatP6Date(day * MIN_PER_DAY).slice(0, 10)}`);
    // (a resource still over its limit: the day it is most over, which need not be its highest day when the limit changes by date)
    const over = worst > 0.01, at = over ? day : pday;
    peaks.push({ rsrcId: rid, code: rsrcs.get(rid)?.rsrc_short_name ?? rid, peak: Math.round((u.get(at) ?? 0) * 100) / 100, limit: Math.round(lim(at) * 100) / 100, day: formatP6Date(at * MIN_PER_DAY).slice(0, 10), overallocated: over });
  }
  peaks.sort((a, b) => a.code.localeCompare(b.code));
  // what was not leveled, and why (a resource with no limit is not leveled: said every time it applies)
  const notes: string[] = [];
  const inScope = new Set<string>();
  for (const a of rows(db, 'TASKRSRC')) if (byId.has(a.task_id) && a.rsrc_id && (!opts.rsrcIds || opts.rsrcIds.includes(a.rsrc_id))) inScope.add(a.rsrc_id);
  const limited = [...inScope].filter((id) => cap.has(id));
  if (refused) notes.push(`Not leveled: ${refused}.`);
  if (!refused) notes.push(...assumed);
  notes.push(...notJudgedNotes(notJudged(db, inScope)));
  if (!inScope.size) notes.push(opts.rsrcIds ? 'None of the resources named is assigned to an activity: nothing to level.' : noResourceAssigned('level'));
  if (inScope.size && !limited.length) notes.push('No resource is judged for over-allocation: nothing to level.');
  if (inScope.size && limited.length && !leveledIds.length) notes.push('Nothing was leveled: "Level all resources" is off in the project\'s leveling settings and no resource that has a limit is marked to be leveled.');
  if (!refused && alap.length && (movedList.length || (!settings.preserve && dated.size))) notes.push(`As in P6, an As Late As Possible constraint is not applied in a leveling: ${alap.map((t) => t.task_code).join(', ')} ${alap.length === 1 ? 'stays' : 'stay'} where the schedule put ${alap.length === 1 ? 'it' : 'them'} unless the leveling delays ${alap.length === 1 ? 'it' : 'them'}.`);
  if (unread.length) notes.push(`The leveling priorities name ${unread.map((f) => `"${f}"`).join(', ')}, which ${unread.length === 1 ? 'is not a column' : 'are not columns'} of the activities in this file: left out of the order.`);
  if (cannot.some((c) => /^alone it needs/.test(c.why))) notes.push('An activity that alone needs more than the limit of its resource cannot be fitted by a delay: lower its assignment (edit update_assignment) or raise the limit (edit update_resource max_units_per_day).');
  const line = (id: string) => { const t = byId.get(id)!; return `      Project: ${projects.get(t.proj_id)?.proj_short_name ?? ''} Activity: ${t.task_code} ${t.task_name ?? ''}`.trimEnd(); };
  const dots = (label: string, n: number | string) => ` ${label}${'.'.repeat(Math.max(2, 64 - label.length))}${n}`;
  const byRes = movedList.filter((m) => m.why === 'resource'), byPred = movedList.filter((m) => m.why === 'predecessor');
  const report = (full: boolean) => ['Leveling Report', '',
    dots('Preserve scheduled early and late dates', settings.preserve ? 'Yes' : 'No'), dots('Level resources only within activity Total Float', settings.withinFloat ? 'Yes' : 'No'),
    ...(settings.withinFloat ? [dots('Preserve minimum float when leveling', `${p6num(settings.minFloatHrs)}h`), dots('Max percent to over-allocate resources', `${p6num(settings.overAllocPct)}%`)] : []),
    dots('Leveling priorities', priorities.length ? priorities.map((p) => `${PRIORITY_NAMES[p.field] ?? p.field} ${p.desc ? 'Descending' : 'Ascending'}`).join(', ') : 'Activity ID'),
    dots('Resources to be leveled', leveledIds.length), ...leveledIds.map((id) => `      Resource: ${rsrcs.get(id)?.rsrc_short_name ?? id} ${rsrcs.get(id)?.rsrc_name ?? ''}`.trimEnd()),
    ...(full && notes.length ? ['', ...notes] : []), '',
    dots('Activities delayed due to resource leveling', byRes.length), ...(full ? byRes.map((m) => `${line(m.taskId)} (from ${m.from} to ${m.start})`) : []),
    dots('Activities delayed due to predecessor delay', byPred.length), ...(full ? byPred.map((m) => `${line(m.taskId)} (from ${m.from} to ${m.start})`) : []),
    dots('Activities that cannot be leveled', cannot.length), ...(full ? cannot.map((c) => `${line(c.taskId)} (${c.why})`) : []),
    ...(still.length ? ['', ...still] : []), '', 'End of report'].join('\r\n');
  // log: the whole report as the desktop dialog shows it; report: its settings and counts (a tool answer lists the activities itself, once)
  return { log: report(true), report: report(false), delayed: movedList.length, findings, notes, moved: movedList, cannot, peaks, settings: { ...settings, priorities }, leveled: leveledIds.length, ...(refused ? { refused: `Not leveled: ${refused}.` } : {}) };
}
