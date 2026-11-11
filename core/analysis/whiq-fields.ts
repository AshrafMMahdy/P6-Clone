// What an apply writes down beside each activity it changed (owner 2026-11-10): user-defined fields P6 can show as columns, so the
// plan's reader sees which durations the reasoner or the crashing changed, from what, and why, without the chat. Written in the same
// undoable change as the apply itself, so undo takes them back. A field that is not in the project yet is added. The ORIGINAL duration is
// written once: an activity that already holds one keeps it (a second apply must not turn "10" into the crashed "6"), the change is
// always the latest duration minus that original, the note the latest change, the rank the latest order. Values an earlier run wrote on
// activities this run did not touch stay (nothing is cleared); fields_written says how many (kept_from_earlier).
// That is crash_schedule's rule. The schedule reasoner's apply (optimize_schedule, and the Optimise screen's Apply) follows the owner's run rule of
// 2026-11-11 instead (whiqRunOps, below; FieldData.reasoner): each run's numbers become the current ones and the numbers they replace move into a
// column per run (WHIQ run <N> duration (d)), the same field names and types as the platform's stored-schedule apply, so a file applied by either is
// continued correctly by the other.
import { rows, type Db, type Row } from '../db.ts';
import { dayHours } from '../project/units.ts';
import { applyOps } from '../project/ops.ts';
import { percentComplete } from '../cost/rollup.ts';
import { isWbs } from './common.ts';

/** An activity whose duration the run changed: its task_id, Activity ID, its project's ID, the remaining days before and after (of its
 *  own calendar's days, to 2 decimals), the crash cost. */
export interface FieldChange { task_id: string; id: string; project: string; from_days: number; to_days: number; cost: number }
/** An activity the leveler was given in a placement order: 1 = placed first. */
export interface FieldRank { task_id: string; id: string; project: string; rank: number }

const FIELDS = { original: 'WHIQ original duration (d)', change: 'WHIQ duration change (d)', note: 'WHIQ change note', rank: 'WHIQ leveling rank' } as const;
/** Today's date as YYYY-MM-DD, on the clock of the machine the clone runs on. */
export const today = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const r2 = (v: number) => Math.round(v * 100) / 100;
/** An activity's change as the fields show it, from the HOURS: the remaining hours before and the hours actually written, in days of the
 *  activity's own calendar, to 2 decimals. One function for crash_schedule and optimize_schedule, so both say the same of the same write. */
export function fieldChange(db: Db, task: Row, project: string | undefined, fromHours: number, toHours: number, cost: number, hoursPerDay: number): FieldChange {
  const h = dayHours(db, hoursPerDay, true).task(task);
  return { task_id: task.task_id, id: task.task_code, project: project as string, from_days: r2(fromHours / h), to_days: r2(toHours / h), cost: r2(cost) };
}
const money = (v: number) => r2(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** The UDF data type each field needs, as add_udf names it (made as that when it does not exist), and the logical types of the file that hold it. */
const NEEDS: Record<keyof typeof FIELDS, { type: 'number' | 'integer' | 'text'; is: RegExp }> = {
  original: { type: 'number', is: /^FT_FLOAT/ }, change: { type: 'number', is: /^FT_FLOAT/ }, note: { type: 'text', is: /^FT_TEXT$/ }, rank: { type: 'integer', is: /^(FT_INT$|FT_FLOAT)/ }, // (a whole-number rank fits a number field exactly: an integer field comes back from Microsoft Project as one)
};
const typeOf = (db: Db, label: string) => rows(db, 'UDFTYPE').find((u) => u.table_name === 'TASK' && u.udf_type_label.toLowerCase() === label.toLowerCase());
const typeWords = (logical: string) => (/^FT_FLOAT/.test(logical) ? 'number' : logical === 'FT_INT' ? 'integer' : logical === 'FT_TEXT' ? 'text' : logical === 'FT_MONEY' ? 'cost' : /DATE/.test(logical) ? 'date' : logical === 'FT_STATICTYPE' ? 'indicator' : logical.replace(/^FT_/, '').toLowerCase());

/** A field of the project that has one of the fields' labels with another data type: an apply would fail half way (a text value into a
 *  number field), so it is refused before anything is changed. Only the fields this run would write are looked at. */
export function whiqFieldClash(db: Db, o: { changes: unknown[]; ranks?: unknown[]; reasoner?: boolean; projIds?: string[] }): { field: string; found: string; needed: string; message: string; hint: string } | undefined {
  const writes: (keyof typeof FIELDS)[] = [...(o.changes.length ? (['original', 'change', 'note'] as const) : []), ...(o.ranks?.length ? (['rank'] as const) : [])];
  // a reasoner run that is not the project's first also writes the column of the run before it (a number field)
  const wanted: { label: string; type: 'number' | 'integer' | 'text'; is: RegExp }[] = writes.map((k) => ({ label: FIELDS[k], ...NEEDS[k] }));
  if (o.reasoner && o.changes.length) for (const k of new Set(runNumbers(db, runProjects(db, o as RunInput)).values())) if (k >= 2) wanted.push({ label: runFieldName(k - 1), type: 'number', is: /^FT_FLOAT/ });
  for (const w of wanted) {
    const u = typeOf(db, w.label);
    if (!u || w.is.test(u.logical_data_type)) continue;
    const found = typeWords(u.logical_data_type);
    return { field: u.udf_type_label, found, needed: w.type,
      message: `The project already has an activity field "${u.udf_type_label}" of type ${found}; the apply writes ${w.type === 'text' ? 'text' : `a ${w.type}`} into a field of that name, and nothing was changed.`,
      hint: `Rename or remove that field with the edit tool (update_udf {"udf": "${u.udf_type_label}", "new_name": ...} or delete_udf {"udf": "${u.udf_type_label}"}) and apply again, or apply the proposal's ops with the edit tool without these fields.` };
  }
  return undefined;
}

/** The edit operations that write the fields, and what they write (`fields_written`: each field with the number of activities written
 *  now, and kept_from_earlier: the activities that still hold a value an earlier run wrote and this one did not).
 *  who: how the note names the run ("Crashed by the schedule reasoner"); on: the date of the run (YYYY-MM-DD). */
export function whiqFieldOps(db: Db, o: { changes: FieldChange[]; ranks?: FieldRank[]; who: string; on: string; projIds?: string[] }) {
  const ops: Record<string, unknown>[] = [], written: { name: string; activities: number; kept_from_earlier: number }[] = [];
  /** the value each activity holds of a field now (empty = none) */
  const mine = o.projIds ? new Set(rows(db, 'TASK').filter((t) => o.projIds!.includes(t.proj_id)).map((t) => t.task_id)) : null; // the run's own projects (a file can hold others: their values are not this run's to count)
  const held = (label: string) => { const u = typeOf(db, label); return new Map(u ? rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === u.udf_type_id && (!mine || mine.has(v.fk_id))).map((v) => [v.fk_id, v] as const) : []); };
  const field = (key: keyof typeof FIELDS, values: { task_id: string; id: string; project: string; value: string | number }[]) => {
    const name = FIELDS[key], now = new Set(values.map((v) => v.task_id));
    const kept = [...held(name).keys()].filter((fk) => !now.has(fk)).length;
    if (values.length) {
      if (!typeOf(db, name)) ops.push({ op: 'add_udf', name, subject: 'activity', data_type: NEEDS[key].type });
      for (const v of values) ops.push({ op: 'set_udf', udf: name, value: v.value, activity: v.id, project: v.project });
    }
    if (values.length || kept) written.push({ name, activities: values.length, kept_from_earlier: kept });
  };
  const had = held(FIELDS.original);
  const origin = (c: FieldChange) => { const v = had.get(c.task_id); return v && v.udf_number !== '' && v.udf_number != null ? Number(v.udf_number) : undefined; };
  // the original: only where the activity has none yet (the first change's "before"); every later one is measured against it
  field('original', o.changes.filter((c) => origin(c) == null).map((c) => ({ task_id: c.task_id, id: c.id, project: c.project, value: r2(c.from_days) })));
  field('change', o.changes.map((c) => ({ task_id: c.task_id, id: c.id, project: c.project, value: r2(c.to_days - (origin(c) ?? c.from_days)) })));
  field('note', o.changes.map((c) => { const og = origin(c); return { task_id: c.task_id, id: c.id, project: c.project, value: `${o.who} ${o.on}: ${r2(c.from_days)} d to ${r2(c.to_days)} d, cost ${money(c.cost)}${og != null && og !== r2(c.from_days) ? ` (original ${r2(og)} d)` : ''}` }; }));
  field('rank', (o.ranks ?? []).map((r) => ({ task_id: r.task_id, id: r.id, project: r.project, value: r.rank })));
  return { ops, fields_written: written };
}

/** What a run hands to whoever applies it so the fields can be written (the tool answers it under `field_data: true`; the desktop screens pass that). */
export interface FieldData { changes: FieldChange[]; ranks?: FieldRank[]; who: string; /** the schedule reasoner's run rule (whiqRunOps) instead of crash_schedule's (whiqFieldOps) */ reasoner?: true }
/** Write the fields into `d` (inside the apply's own undoable change): the one function the tools' apply and the screens' Apply both call.
 *  Returns what it wrote (fields_written); throws an Error in words when a field of the project has another data type (nothing is written). */
export function writeWhiqFields(d: Db, data: FieldData, o: { hoursPerDay?: number; calendarDays?: boolean; projIds?: string[] } = {}) {
  const clash = whiqFieldClash(d, { ...data, projIds: o.projIds });
  if (clash) throw new Error(`${clash.message} ${clash.hint}`);
  const w = data.reasoner ? whiqRunOps(d, { ...data, on: today(), projIds: o.projIds, hoursPerDay: o.hoursPerDay }) : whiqFieldOps(d, { ...data, on: today(), projIds: o.projIds });
  const r = applyOps(d, w.ops, { hoursPerDay: o.hoursPerDay, calendarDays: o.calendarDays });
  if (!r.ok) throw new Error(r.error!.message);
  return w.fields_written;
}

// ── the schedule reasoner's run rule (owner 2026-11-11): the same field names and types as the platform's stored-schedule apply ──────────────────────
/** The column the numbers a run replaces move into: `WHIQ run <N> duration (d)` (a number field of the activities), N = the run before the one applied. */
export const runFieldName = (n: number): string => `WHIQ run ${n} duration (d)`;
const RUN_FIELD = /^WHIQ run (\d+) duration \(d\)$/;
type RunInput = { changes: FieldChange[]; ranks?: FieldRank[]; projIds?: string[] };
/** The projects a run writes into: the ones it was given, else those of the activities it changed or ranked. */
function runProjects(db: Db, o: RunInput): string[] {
  if (o.projIds) return o.projIds;
  const changed = new Set([...o.changes.map((c) => c.task_id), ...(o.ranks ?? []).map((r) => r.task_id)]);
  return [...new Set(rows(db, 'TASK').filter((t) => changed.has(t.task_id)).map((t) => t.proj_id))];
}
/** The number K of the run an apply is, for each project (proj_id → K), decided from what the file declares BEFORE this apply writes anything.
 *  A project's FIRST run is 1 and declares no numbered field: the file does not declare `WHIQ original duration (d)` (the platform's isReasonerCopy test),
 *  or, when the file holds several projects (custom fields are global to the file, the values are the activities'), none of the project's activities carries
 *  an original. Any later run is K = (highest N among the file's declared `WHIQ run <N> duration (d)` fields, 0 when none) + 2, and declares the column K-1.
 *  Every later run of any project declares a column at least as high as its own K-1, so the next K of any project is above it: a number is never repeated
 *  for a project (the column numbers are the file's, so a project that skipped some keeps its own gaps). */
export function runNumbers(db: Db, projIds: string[]): Map<string, number> {
  const original = typeOf(db, FIELDS.original);
  const several = rows(db, 'PROJECT').filter((p) => !p._baseline_of).length > 1;
  const carrying = new Set<string>();
  if (original && several) {
    const has = new Set(rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === original.udf_type_id && v.udf_number !== '' && v.udf_number != null).map((v) => v.fk_id));
    for (const t of rows(db, 'TASK')) if (has.has(t.task_id)) carrying.add(t.proj_id);
  }
  const top = rows(db, 'UDFTYPE').reduce((m, u) => { const k = u.table_name === 'TASK' ? RUN_FIELD.exec(u.udf_type_label) : null; return k ? Math.max(m, Number(k[1])) : m; }, 0);
  return new Map(projIds.map((id) => [id, !original || (several && !carrying.has(id)) ? 1 : top + 2]));
}

/** The edit operations of the schedule reasoner's apply, written AFTER its duration changes are made. The run's number becomes the activity's duration; the OLD
 *  number moves into `WHIQ original duration (d)` when the activity has none yet (never changed once set), else into `WHIQ run <K-1> duration (d)`; an activity
 *  the run does not change moves nothing (its cell stays empty). A project's first run declares no numbered field; a later run declares its column whether or
 *  not any cell is filled (runNumbers). `WHIQ duration change (d)` is the current duration minus the original on every activity that has one (recomputed, so a
 *  duration edited by hand between runs shows). The note and the rank are the latest run's: an activity the run does not change keeps its note; a rank the run
 *  does not give is removed. A run that changes no duration is no run in the numbering: it declares no numbered field. Returns the ops and fields_written. */
export function whiqRunOps(db: Db, o: { changes: FieldChange[]; ranks?: FieldRank[]; who: string; on: string; projIds?: string[]; hoursPerDay?: number }) {
  const ops: Record<string, unknown>[] = [], written: { name: string; activities: number; kept_from_earlier: number }[] = [];
  const projIds = runProjects(db, o), inRun = new Set(projIds);
  const runNo = runNumbers(db, projIds);
  const short = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name]));
  const tasks = rows(db, 'TASK').filter((t) => inRun.has(t.proj_id)), mine = new Set(tasks.map((t) => t.task_id));
  const hours = dayHours(db, o.hoursPerDay ?? 8, true);
  const held = (label: string) => { const u = typeOf(db, label); return new Map(u ? rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === u.udf_type_id && mine.has(v.fk_id)).map((v) => [v.fk_id, v] as const) : []); };
  const numberOf = (v: Row | undefined) => (v && v.udf_number !== '' && v.udf_number != null ? Number(v.udf_number) : undefined);
  const had = { original: held(FIELDS.original), change: held(FIELDS.change), note: held(FIELDS.note), rank: held(FIELDS.rank) };
  const changeOf = new Map(o.changes.map((c) => [c.task_id, c])), rankOf = new Map((o.ranks ?? []).map((r) => [r.task_id, r]));
  type Cell = { task_id: string; id: string; project: string; value: string | number };
  const put: Record<'original' | 'change' | 'note' | 'rank', Cell[]> = { original: [], change: [], note: [], rank: [] };
  const runCells = new Map<number, Cell[]>(); // column number -> cells
  const dropRank: Cell[] = [];
  for (const t of tasks) {
    const c = changeOf.get(t.task_id), k = runNo.get(t.proj_id) ?? 1;
    const at = { task_id: t.task_id, id: t.task_code, project: short.get(t.proj_id) as string };
    let original = numberOf(had.original.get(t.task_id));
    if (c) {
      const from = r2(c.from_days);
      if (original == null) { put.original.push({ ...at, value: from }); original = from; }
      else if (k >= 2) (runCells.get(k - 1) ?? runCells.set(k - 1, []).get(k - 1)!).push({ ...at, value: from });
      put.note.push({ ...at, value: `${o.who} ${o.on}: ${from} d to ${r2(c.to_days)} d, cost ${money(c.cost)}${original !== from ? ` (original ${r2(original)} d)` : ''}` });
    }
    const rk = rankOf.get(t.task_id);
    if (rk) put.rank.push({ ...at, value: rk.rank }); else if (had.rank.has(t.task_id)) dropRank.push({ ...at, value: '' });
    if (original != null) {
      const now = c ? r2(c.to_days) : r2(Number(t.remain_drtn_hr_cnt || 0) / hours.task(t));
      const value = r2(now - original);
      if (c || numberOf(had.change.get(t.task_id)) !== value) put.change.push({ ...at, value });
    }
  }
  // the columns this run declares: one per later-run project that changed an activity, whether or not a cell is filled
  const columns = new Set<number>();
  for (const id of projIds) { const k = runNo.get(id) ?? 1; if (k >= 2 && o.changes.some((c) => tasks.some((t) => t.task_id === c.task_id && t.proj_id === id))) columns.add(k - 1); }
  const emit = (name: string, type: 'number' | 'integer' | 'text', cells: Cell[], keptHeld: Map<string, Row>, declare: boolean) => {
    if (declare && !typeOf(db, name)) ops.push({ op: 'add_udf', name, subject: 'activity', data_type: type });
    for (const v of cells) ops.push({ op: 'set_udf', udf: name, value: v.value, activity: v.id, project: v.project });
    const now = new Set(cells.map((v) => v.task_id));
    const kept = [...keptHeld.keys()].filter((fk) => !now.has(fk)).length;
    if (cells.length || kept || declare) written.push({ name, activities: cells.length, kept_from_earlier: kept });
  };
  emit(FIELDS.original, 'number', put.original, had.original, put.original.length > 0);
  emit(FIELDS.change, 'number', put.change, had.change, put.change.length > 0);
  emit(FIELDS.note, 'text', put.note, had.note, put.note.length > 0);
  // the rank: the ranks of this run, and none held from an earlier run for an activity this run does not rank
  if (put.rank.length) emit(FIELDS.rank, 'integer', put.rank, new Map(), true);
  for (const v of dropRank) ops.push({ op: 'set_udf', udf: FIELDS.rank, value: null, activity: v.id, project: v.project });
  if (dropRank.length && !put.rank.length) written.push({ name: FIELDS.rank, activities: 0, kept_from_earlier: 0 });
  for (const n of [...columns].sort((a, b) => a - b)) emit(runFieldName(n), 'number', runCells.get(n) ?? [], held(runFieldName(n)), true);
  return { ops, fields_written: written };
}

// ── the reasoner plans work that has not started only (owner 2026-11-11) ─────────────────────────────────────────────────────────────────────────────
/** Why the schedule reasoner refuses these projects (undefined: it may run). "In progress" is read as: any activity (not a WBS summary) whose status_code is
 *  not "not started" (TK_NotStart; an empty one is not read), or that has an actual start or an actual finish, or whose percent complete is above 0 — the percent
 *  of its own type as the clone's earned value reads it (percentComplete in core/cost/rollup.ts: physical, duration, units), here without that function's rule
 *  that an activity with no actual start is 0 — or whose physical percent is above 0 whatever its type; OR a project whose data date (last_recalc_date) is after
 *  its planned start (plan_start_date), compared as days, strictly after. */
export function reasonerRefusal(db: Db, projIds: string[]): { code: 'schedule_in_progress'; message: string; hint: string } | undefined {
  const inRun = new Set(projIds), asg = new Map<string, Row[]>();
  for (const a of rows(db, 'TASKRSRC')) (asg.get(a.task_id) ?? asg.set(a.task_id, []).get(a.task_id)!).push(a);
  let n = 0;
  for (const t of rows(db, 'TASK')) {
    if (!inRun.has(t.proj_id) || isWbs(t)) continue;
    // (a duration percent needs a stated remaining duration: an empty one is not "100 % done")
    const byType = t.complete_pct_type === 'CP_Phys' || t.complete_pct_type === 'CP_Units' || (t.remain_drtn_hr_cnt ?? '') !== '' ? percentComplete({ ...t, act_start_date: t.act_start_date || 'none yet', act_end_date: '' }, asg.get(t.task_id) ?? []) : 0;
    if ((t.status_code ?? '') !== '' && t.status_code !== 'TK_NotStart' || t.act_start_date || t.act_end_date || byType > 0 || (Number(t.phys_complete_pct) || 0) > 0) n++;
  }
  const late = rows(db, 'PROJECT').filter((p) => inRun.has(p.proj_id) && p.last_recalc_date && p.plan_start_date && p.last_recalc_date.slice(0, 10) > p.plan_start_date.slice(0, 10))
    .map((p) => `${p.last_recalc_date.slice(0, 10)} is after the planned start ${p.plan_start_date.slice(0, 10)}${projIds.length > 1 ? ` (project ${p.proj_short_name})` : ''}`);
  if (!n && !late.length) return undefined;
  const why = [n ? `${n} activit${n === 1 ? 'y has' : 'ies have'} actual dates or progress` : '', ...late.map((l) => `the data date ${l}`)].filter(Boolean).join('; ');
  return {
    code: 'schedule_in_progress',
    message: `optimize_schedule: nothing was run. The schedule is in progress (${why}), and the schedule reasoner plans only work that has not started.`,
    hint: 'To shorten the remaining work of a schedule in progress, use crash_schedule. To level resources on work in progress, use level_resources.',
  };
}
