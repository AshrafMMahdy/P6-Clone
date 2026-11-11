// What an apply writes down beside each activity it changed (owner 2026-11-10, run rule 2026-11-11): user-defined fields P6 can show as columns, so the
// plan's reader sees which durations a run changed, from what, and why, without the chat. One rule for every apply that writes them (optimize_schedule,
// crash_schedule, the Optimise and Crashing screens' Apply): each run's numbers become the current ones and the numbers they replace move into
// WHIQ original duration (d) (an activity's first change) or a column per run (WHIQ run <N> duration (d)), the same field names and types as the
// platform's stored-schedule apply, so a file applied by either is continued correctly by the other. Written in the same undoable change as the apply
// itself, so undo takes them back. A field that is not in the project yet is added.
// In a file with several projects the run number is the file's, not the project's: a project's run can skip numbers, and "WHIQ run N duration (d)" holds the
// duration an activity had before the file's run N+1 was applied to it.
import { rows, type Db, type Row } from '../db.ts';
import { dayHours } from '../project/units.ts';
import { applyOps } from '../project/ops.ts';
import { isWbs } from './common.ts';
import { baselineProjectIds } from '../progress/baseline.ts';

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
export function whiqFieldClash(db: Db, o: { changes: unknown[]; ranks?: unknown[]; projIds?: string[] }): { field: string; found: string; needed: string; message: string; hint: string } | undefined {
  const writes: (keyof typeof FIELDS)[] = [...(o.changes.length ? (['original', 'change', 'note'] as const) : []), ...(o.ranks?.length ? (['rank'] as const) : [])];
  // a run that is not the project's first also writes the column of the run before it (a number field)
  const wanted: { label: string; type: 'number' | 'integer' | 'text'; is: RegExp }[] = writes.map((k) => ({ label: FIELDS[k], ...NEEDS[k] }));
  if (o.changes.length) for (const k of new Set(runNumbers(db, runProjects(db, o as RunInput)).values())) if (k >= 2) wanted.push({ label: runFieldName(k - 1), type: 'number', is: /^FT_FLOAT/ });
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

/** What a run hands to whoever applies it so the fields can be written (the tool answers it under `field_data: true`; the desktop screens pass that). */
/** `ranks`: the order a run gave the leveler (optimize_schedule: every activity it ranked, an empty list when it ranked none). A run that gives no order (crash_schedule: no `ranks`) leaves every rank an earlier run wrote as it is. */
export interface FieldData { changes: FieldChange[]; ranks?: FieldRank[]; who: string }
/** Write the fields into `d` (inside the apply's own undoable change): the one function the tools' apply and the screens' Apply both call.
 *  Returns what it wrote (fields_written); throws an Error in words when a field of the project has another data type (nothing is written). */
export function writeWhiqFields(d: Db, data: FieldData, o: { hoursPerDay?: number; calendarDays?: boolean; projIds?: string[] } = {}) {
  const clash = whiqFieldClash(d, { ...data, projIds: o.projIds });
  if (clash) throw new Error(`${clash.message} ${clash.hint}`);
  const w = whiqRunOps(d, { ...data, on: today(), projIds: o.projIds, hoursPerDay: o.hoursPerDay });
  const r = applyOps(d, w.ops, { hoursPerDay: o.hoursPerDay, calendarDays: o.calendarDays });
  if (!r.ok) throw new Error(r.error!.message);
  return w.fields_written;
}

// ── the run rule (owner 2026-11-11): the same field names and types as the platform's stored-schedule apply ──────────────────────
/** The column the numbers a run replaces move into: `WHIQ run <N> duration (d)` (a number field of the activities), N = the run before the one applied. */
export const runFieldName = (n: number): string => `WHIQ run ${n} duration (d)`;
const RUN_FIELD = /^WHIQ run (\d+) duration \(d\)$/;
type RunInput = { changes: FieldChange[]; ranks?: FieldRank[]; projIds?: string[] };
/** The projects a run writes into: the ones it was given, else those of the activities it changed or ranked. A baseline project (baselineProjectIds) is never
 *  one of them: its activities get no field, and no number is decided for it. */
function runProjects(db: Db, o: RunInput): string[] {
  const baselines = baselineProjectIds(db);
  if (o.projIds) return o.projIds.filter((id) => !baselines.has(id));
  const changed = new Set([...o.changes.map((c) => c.task_id), ...(o.ranks ?? []).map((r) => r.task_id)]);
  return [...new Set(rows(db, 'TASK').filter((t) => changed.has(t.task_id)).map((t) => t.proj_id))].filter((id) => !baselines.has(id));
}
/** The number K of the run an apply is, for each project (proj_id → K), decided from what the file declares BEFORE this apply writes anything.
 *  A project's FIRST run is 1 and declares no numbered field: the file does not declare `WHIQ original duration (d)` (the platform's isReasonerCopy test),
 *  or, when the file holds several projects (custom fields are global to the file, the values are the activities'), none of the project's activities carries
 *  an original. Any later run is K = (highest N among the file's declared `WHIQ run <N> duration (d)` fields, 0 when none) + 2, and declares the column K-1.
 *  Every later run of any project declares a column at least as high as its own K-1, so the next K of any project is above it: a number is never repeated
 *  for a project (the column numbers are the file's, so a project that skipped some keeps its own gaps). */
export function runNumbers(db: Db, projIds: string[]): Map<string, number> {
  const original = typeOf(db, FIELDS.original);
  // (a project with baselines is ONE project: the saved baselines of a project are copies of it, not further projects of the file)
  const baselines = baselineProjectIds(db);
  const several = rows(db, 'PROJECT').filter((p) => !baselines.has(p.proj_id)).length > 1;
  const carrying = new Set<string>();
  if (original && several) {
    const has = new Set(rows(db, 'UDFVALUE').filter((v) => v.udf_type_id === original.udf_type_id && v.udf_number !== '' && v.udf_number != null).map((v) => v.fk_id));
    for (const t of rows(db, 'TASK')) if (has.has(t.task_id)) carrying.add(t.proj_id);
  }
  const top = rows(db, 'UDFTYPE').reduce((m, u) => { const k = u.table_name === 'TASK' ? RUN_FIELD.exec(u.udf_type_label) : null; return k ? Math.max(m, Number(k[1])) : m; }, 0);
  return new Map(projIds.map((id) => [id, !original || (several && !carrying.has(id)) ? 1 : top + 2]));
}

/** The edit operations of an apply (optimize_schedule, crash_schedule), written AFTER its duration changes are made. The run's number becomes the activity's duration; the OLD
 *  number moves into `WHIQ original duration (d)` when the activity has none yet (never changed once set), else into `WHIQ run <K-1> duration (d)`; an activity
 *  the run does not change moves nothing (its cell stays empty). A project's first run declares no numbered field; a later run declares its column whether or
 *  not any cell is filled (runNumbers). `WHIQ duration change (d)` is the current duration minus the original on every activity that has one (recomputed, so a
 *  duration edited by hand between runs shows). The note and the rank are the latest run's: an activity the run does not change keeps its note; a rank the run
 *  does not give is removed (a run that gives no `ranks` at all, crash_schedule, leaves the ranks as they are). For an activity under way (it has an actual start) the duration is its remaining duration, the number crash_schedule changes. A run that changes no duration is no run in the numbering: it declares no numbered field. Returns the ops and fields_written. */
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
    if (rk) put.rank.push({ ...at, value: rk.rank }); else if (o.ranks && had.rank.has(t.task_id)) dropRank.push({ ...at, value: '' });
    if (original != null) {
      const now = c ? r2(c.to_days) : r2(Number(t.remain_drtn_hr_cnt || 0) / hours.task(t));
      const value = r2(now - original);
      // (an activity under way: its remaining duration shrinks with progress, which is no edit, so its change is written only when a run changes it)
      if (c || (!t.act_start_date && numberOf(had.change.get(t.task_id)) !== value)) put.change.push({ ...at, value });
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
/** Why the schedule reasoner refuses these projects (undefined: it may run). "In progress" is read by ONE rule, the same one the White Hat IQ platform's import
 *  applies to a file (its taskProgress), so a file and the schedule imported from it always get the same answer: an activity (not a WBS summary) whose status is
 *  in progress or complete (TK_Active, TK_Progress, TK_Complete), or that has an actual start or an actual finish, or whose percent complete is above 0 — the
 *  percent as P6 defines it for the activity's own percent-complete type: a Duration or Units type activity that has not started is at 0 whatever numbers the
 *  row holds (a remaining duration below the original is no progress, nor is a physical percent left on it); any other type reads the physical percent (else
 *  complete_pct). OR a project whose data date (last_recalc_date) is after its planned start (plan_start_date), compared as days, strictly after. */
export function reasonerRefusal(db: Db, projIds: string[]): { code: 'schedule_in_progress'; message: string; hint: string } | undefined {
  const baselines = baselineProjectIds(db), inRun = new Set(projIds.filter((id) => !baselines.has(id)));
  const isDate = (v: string | undefined) => !!v && /\d{4}-\d{2}-\d{2}/.test(v), pct = (v: string | undefined) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
  let n = 0;
  for (const t of rows(db, 'TASK')) {
    if (!inRun.has(t.proj_id) || isWbs(t)) continue;
    const type = (t.complete_pct_type ?? '').trim(), byType = type === 'CP_Drtn' || type === 'CP_Units' ? 0 : pct(t.phys_complete_pct) ?? pct(t.complete_pct) ?? 0;
    if (t.status_code === 'TK_Complete' || t.status_code === 'TK_Active' || t.status_code === 'TK_Progress' || isDate(t.act_start_date) || isDate(t.act_end_date) || byType > 0) n++;
  }
  const late = rows(db, 'PROJECT').filter((p) => inRun.has(p.proj_id) && p.last_recalc_date && p.plan_start_date && p.last_recalc_date.slice(0, 10) > p.plan_start_date.slice(0, 10))
    .map((p) => `${p.last_recalc_date.slice(0, 10)} is after the planned start ${p.plan_start_date.slice(0, 10)}${inRun.size > 1 ? ` (project ${p.proj_short_name})` : ''}`);
  if (!n && !late.length) return undefined;
  const why = [n ? `${n} activit${n === 1 ? 'y has' : 'ies have'} actual dates or progress` : '', ...late.map((l) => `the data date ${l}`)].filter(Boolean).join('; ');
  return {
    code: 'schedule_in_progress',
    message: `optimize_schedule: nothing was run. The schedule is in progress (${why}), and the schedule reasoner plans only work that has not started.`,
    hint: 'To shorten the remaining work of a schedule in progress, use crash_schedule. To level resources on work in progress, use level_resources.',
  };
}
