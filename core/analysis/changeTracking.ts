// change_tracking: what changed between a series of updates, on the open file's own tables. Ported from our copy of the Bellator Schedule Intelligence benchmark ("Bellatorsi API/src/endpoints/forensics/
// changeTracking.ts"): field-level changes between consecutive updates in six categories (baseline dates, actual dates, forecast dates, logic, resources, percent complete), each with the source's materiality, and the
// source's gaming flags. The clone reuses what it has: compareSchedules (actual dates, start / finish, relationships with type and lag) and progressIntegrity (retroactive actual dates, percent decreases by percent
// type, status regressions) of core/diff.ts; the assignment diff, the baseline-date diff and the percent diff are small pure functions beside them. Activities are matched by Activity ID as compareSchedules matches them;
// dates are compared in working days of the activity's calendar. Where an input is absent (an update with no baseline) the category of that period is not assessed, with the reason.
import { rows, type Db, type Row } from '../db.ts';
import { cap, tidyNotes } from '../notes.ts';
import { formatP6Date, parseP6Date } from '../dates.ts';
import { assignmentChanges, baselineDateChanges, compareSchedules, percentChanges, progressIntegrity, type IntegrityFinding, type ScheduleChange } from '../diff.ts';
import { dayHours } from '../project/units.ts';
import type { Update } from './delay.ts';
import { baselineOf, baselineFinish, dataDateUsedNotes, makeScope, type Scope } from './common.ts';
import { referenceStart, updateDate, updateView } from './forensic.ts';
import { logicRelationships } from '../progress/snapshots.ts';

export type Mode = 'latest' | 'all_periods';
/** The two modes of the source (changeTracking.ts:81, :86: `latest` compares the last update with the current one, `all_periods` every consecutive pair); its third value specific_dates is accepted by its schema and does nothing different, so it is not carried over. */
export const MODES: Mode[] = ['latest', 'all_periods'];
/** A date change is material from this many working days (the source's 1 calendar day: changeTracking.ts:82, :246; the source's number, not yet agreed with the owner: ledger item 26). */
export const DATE_MATERIAL_DAYS = 1;
/** A percent complete change is material from this many points (the source's 5: changeTracking.ts:83, :138; the source's number, not yet agreed with the owner: ledger item 26). */
export const PROGRESS_MATERIAL_POINTS = 5;

export type Category = 'baseline_dates' | 'actual_dates' | 'forecast_dates' | 'logic' | 'resources' | 'progress';
export const CATEGORIES: Category[] = ['baseline_dates', 'actual_dates', 'forecast_dates', 'logic', 'resources', 'progress'];

export interface Counted { result: 'assessed'; total: number; material: number; not_material: number; [detail: string]: number | string }
/** `note` (the reason) is carried while the periods are worked out; the answer drops it: it is said once, in the notes. */
export type CategoryResult = (Counted & { note?: string }) | { result: 'not_assessed'; note?: string };

/** A changed date or percent (the date and progress categories), one row. change: working days (dates) or points (percent), null when one side has no value. */
export interface ChangeRow { period: number; from_update: string; to_update: string; category: 'baseline_dates' | 'actual_dates' | 'forecast_dates' | 'progress'; id: string; name: string; field: string; from: string | number | null; to: string | number | null; change: number | null; unit: 'working days' | 'points'; material: boolean; basis?: string }
export interface LogicRow { period: number; from_update: string; to_update: string; id: string; predecessor: string; change: 'added' | 'removed' | 'type_changed' | 'lag_changed'; from: string | null; to: string | null; material: true }
export interface ResourceRow { period: number; from_update: string; to_update: string; id: string; name: string; resource: string; change: 'added' | 'removed'; material: true }
export interface GamingRow { period: number; from_update: string; to_update: string; id: string; name: string; field: string; from: string | number | null; to: string | number | null; note?: string }

export interface Period {
  period: number; from: string; to: string; data_date_from: string | null; data_date_to: string | null;
  /** activities in the later update that the earlier one does not have, and the other way (their changes are not tracked: there is nothing to compare them with) */
  activities_added: number; activities_deleted: number;
  categories: Record<Category, CategoryResult>;
}
export interface Flag { flag: 'retroactive_actual_dates' | 'progress_decreases' | 'baseline_dates_revised' | 'status_regressions'; severity: 'high' | 'medium'; count: number; activities_total: number; what: string; table: string }
export interface ChangeTrackingResult {
  report: 'Change tracking';
  status: 'fail' | 'warning' | 'pass';
  /** what could not be assessed, with its reason, each sentence once */
  notes: string[];
  mode: Mode;
  /** the series in the data-date order used (in mode latest, the last two), with the one that is the open project marked */
  updates: { name: string; data_date: string | null; open_project: boolean }[];
  totals: { changes: number; material: number; not_material: number };
  categories: Record<Category, CategoryResult>;
  flags: Flag[];
  periods: Period[];
  changes: ChangeRow[]; logic_changes: LogicRow[]; resource_changes: ResourceRow[];
  retroactive_actuals: GamingRow[]; progress_decreases: GamingRow[]; status_regressions: GamingRow[];
}


const minutes = (v: string | undefined | null) => (v ? parseP6Date(v) : null);
const text = (m: number | null) => (m == null ? null : formatP6Date(m));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The date change in working days of a calendar (exact; null when a side has no date) and whether it is material. */
function dateChange(s: Scope, t: Row | undefined, a: number | null, b: number | null): { change: number | null; material: boolean } {
  if (a == null || b == null) return { change: null, material: true };
  const cal = t ? s.cal(t) : s.projs[0] ? s.projCal(s.projs[0]) : null;
  if (!cal) return { change: null, material: true };
  const hrs = cal.hoursPerDay() || s.hpd, lo = Math.min(a, b), hi = Math.max(a, b);
  const days = (a <= b ? 1 : -1) * (cal.workBetween(lo, hi) / 60 / hrs);
  return { change: r2(days), material: Math.abs(days) >= DATE_MATERIAL_DAYS };
}

const counted = (rowsIn: { material: boolean }[], detail: Record<string, number> = {}): Counted => { const material = rowsIn.filter((r) => r.material).length; return { result: 'assessed', total: rowsIn.length, material, not_material: rowsIn.length - material, ...detail }; };

/** The relationship rows of compareSchedules read as logic changes: added, removed, lag changed, and an added + removed pair of the same two activities (one relationship, another type) as one type change. */
function logicChanges(changes: ScheduleChange[], a: Db, b: Db, hpd: number, both: Set<string>, period: number, from: string, to: string): LogicRow[] {
  const parse = (id: string) => { const m = /^(.*) -> (.*) (FS|SS|FF|SF)$/.exec(id); return m ? { pred: m[1], succ: m[2], type: m[3] } : null; };
  const lagText = (d: Db, dh: ReturnType<typeof dayHours>) => {
    const tasks = new Map(rows(d, 'TASK').map((t) => [t.task_id, t.task_code]));
    return new Map(logicRelationships(d).map((r) => [`${tasks.get(r.pred_task_id)} -> ${tasks.get(r.task_id)} ${(r.pred_type ?? '').replace(/^PR_/, '')}`, r2(Number(r.lag_hr_cnt || 0) / dh.rel(r))]));
  };
  const lagsA = lagText(a, dayHours(a, hpd, true)), lagsB = lagText(b, dayHours(b, hpd, true));
  const show = (type: string, lag: number | undefined) => `${type}${lag ? ` ${lag > 0 ? '+' : ''}${lag}d` : ''}`;
  const rels = changes.filter((c) => c.object === 'relationship').map((c) => ({ c, p: parse(c.id) })).filter((x) => x.p && both.has(x.p.succ)) as { c: ScheduleChange; p: NonNullable<ReturnType<typeof parse>> }[];
  const base = { period, from_update: from, to_update: to, material: true as const };
  const out: LogicRow[] = [];
  const dropped = new Map<string, typeof rels>(), added = new Map<string, typeof rels>();
  for (const x of rels) {
    if (x.c.kind === 'changed') out.push({ ...base, id: x.p.succ, predecessor: x.p.pred, change: 'lag_changed', from: show(x.p.type, lagsA.get(x.c.id)), to: show(x.p.type, lagsB.get(x.c.id)) });
    else { const m = x.c.kind === 'added' ? added : dropped, k = `${x.p.pred} -> ${x.p.succ}`; (m.get(k) ?? m.set(k, []).get(k)!).push(x); }
  }
  for (const [k, ds] of dropped) {
    const as = added.get(k);
    if (as && ds.length === 1 && as.length === 1) { out.push({ ...base, id: ds[0].p.succ, predecessor: ds[0].p.pred, change: 'type_changed', from: show(ds[0].p.type, lagsA.get(ds[0].c.id)), to: show(as[0].p.type, lagsB.get(as[0].c.id)) }); added.delete(k); continue; }
    for (const d of ds) out.push({ ...base, id: d.p.succ, predecessor: d.p.pred, change: 'removed', from: show(d.p.type, lagsA.get(d.c.id)), to: null });
  }
  for (const as of added.values()) for (const x of as) out.push({ ...base, id: x.p.succ, predecessor: x.p.pred, change: 'added', from: null, to: show(x.p.type, lagsB.get(x.c.id)) });
  return out;
}

const gaming = (f: IntegrityFinding, period: number, from: string, to: string, note?: string): GamingRow => ({ period, from_update: from, to_update: to, id: f.id, name: f.name ?? '', field: f.field, from: f.a ?? null, to: f.b ?? null, ...(note ? { note } : {}) });

export function changeTracking(o: { updates: Update[]; mode?: Mode; hoursPerDay?: number }): ChangeTrackingResult {
  const hpd = o.hoursPerDay ?? 8, mode = o.mode ?? 'all_periods';
  const ordered = [...o.updates].sort((x, y) => (updateDate(x) ?? 0) - (updateDate(y) ?? 0));
  const series = mode === 'latest' ? ordered.slice(-2) : ordered;
  const periods: Period[] = [], changeRows: ChangeRow[] = [], logicRows: LogicRow[] = [], resourceRows: ResourceRow[] = [], retro: GamingRow[] = [], down: GamingRow[] = [], back: GamingRow[] = [];
  for (let i = 1; i < series.length; i++) {
    const A = series[i - 1], B = series[i], period = i, from = A.name, to = B.name;
    const va = updateView(A), vb = updateView(B);
    const changes = compareSchedules(va, vb, hpd, true);
    const tasks = (d: Db) => { const main = new Set(rows(d, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id)); return new Map(rows(d, 'TASK').filter((t) => main.has(t.proj_id)).map((t) => [t.task_code, t])); };
    const ta = tasks(va), tb = tasks(vb);
    const both = new Set([...ta.keys()].filter((c) => tb.has(c)));
    const sb = makeScope(vb, { hoursPerDay: hpd, calendarDays: true });
    const acts = changes.filter((c) => c.object === 'activity' && c.kind === 'changed' && both.has(c.id));
    const date = (category: ChangeRow['category'], id: string, name: string, field: string, x: number | null, y: number | null): ChangeRow => {
      const d = dateChange(sb, tb.get(id), x, y);
      return { period, from_update: from, to_update: to, category, id, name, field, from: text(x), to: text(y), change: d.change, unit: 'working days', material: d.material };
    };
    // baseline dates: the baseline each update carries
    const proj = (u: Update) => rows(u.db, 'PROJECT').find((p) => p.proj_id === u.projId)!;
    const blA = baselineOf(A.db, proj(A), 'project'), blB = baselineOf(B.db, proj(B), 'project');
    let baseline: CategoryResult;
    if (!blA || !blB) baseline = { result: 'not_assessed', note: `${!blA && !blB ? `neither ${from} nor ${to} carries` : !blA ? `${from} does not carry` : `${to} does not carry`} a project baseline; assign one with edit assign_baseline on that update\u2019s project` };
    else {
      const rowsB = baselineDateChanges(blA.tasks, blB.tasks, referenceStart, baselineFinish).map((c) => date('baseline_dates', c.id, c.name, c.field, c.a, c.b));
      changeRows.push(...rowsB);
      baseline = counted(rowsB);
    }
    // actual dates: actual start and finish (the date that appears or is cleared is a change)
    const actual = acts.filter((c) => c.field === 'actual_start' || c.field === 'actual_finish').map((c) => date('actual_dates', c.id, tb.get(c.id)?.task_name ?? '', c.field!, minutes(c.a), minutes(c.b)));
    // forecast dates: the start of work not started and the finish of work not finished on either side (the compare's start / finish are the actual date, else the early date)
    const forecast = acts.filter((c) => (c.field === 'start' && !ta.get(c.id)!.act_start_date && !tb.get(c.id)!.act_start_date) || (c.field === 'finish' && !ta.get(c.id)!.act_end_date && !tb.get(c.id)!.act_end_date))
      .map((c) => date('forecast_dates', c.id, tb.get(c.id)?.task_name ?? '', c.field === 'start' ? 'forecast_start' : 'forecast_finish', minutes(c.a), minutes(c.b)));
    // percent complete
    const pcts = percentChanges(va, vb).filter((p) => both.has(p.id));
    const progress: ChangeRow[] = pcts.map((p) => ({ period, from_update: from, to_update: to, category: 'progress', id: p.id, name: p.name, field: 'percent_complete', from: p.a, to: p.b, change: r2(p.b - p.a), unit: 'points', material: Math.abs(p.b - p.a) >= PROGRESS_MATERIAL_POINTS, basis: p.kind }));
    // logic and resources
    const logic = logicChanges(changes, va, vb, hpd, both, period, from, to);
    const res = assignmentChanges(va, vb).filter((r) => both.has(r.id)).map((r): ResourceRow => ({ period, from_update: from, to_update: to, id: r.id, name: r.name, resource: r.resource, change: r.kind, material: true }));
    // the integrity findings of this pair
    const pi = progressIntegrity(va, vb, changes);
    const keep = (f: IntegrityFinding) => both.has(f.id);
    retro.push(...pi.retroactive_actuals.filter(keep).map((f) => gaming(f, period, from, to)));
    down.push(...pi.progress_decreases.filter(keep).map((f) => gaming(f, period, from, to, f.via)));
    back.push(...pi.status_regressions.filter(keep).map((f) => gaming(f, period, from, to)));
    changeRows.push(...actual, ...forecast, ...progress);
    logicRows.push(...logic); resourceRows.push(...res);
    const pd = pi.progress_decreases.filter(keep).length;
    periods.push({
      period, from, to, data_date_from: text(updateDate(A)), data_date_to: text(updateDate(B)),
      activities_added: changes.filter((c) => c.object === 'activity' && c.kind === 'added').length, activities_deleted: changes.filter((c) => c.object === 'activity' && c.kind === 'deleted').length,
      categories: {
        baseline_dates: baseline, actual_dates: counted(actual), forecast_dates: counted(forecast),
        logic: counted(logic, { added: logic.filter((l) => l.change === 'added').length, removed: logic.filter((l) => l.change === 'removed').length, type_changed: logic.filter((l) => l.change === 'type_changed').length, lag_changed: logic.filter((l) => l.change === 'lag_changed').length }),
        resources: counted(res, { added: res.filter((r) => r.change === 'added').length, removed: res.filter((r) => r.change === 'removed').length }),
        progress: counted(progress, { decreased: pd }),
      },
    });
  }
  // overall: the sum over the periods where the category could be assessed
  const categories = Object.fromEntries(CATEGORIES.map((k) => {
    const ok = periods.map((p) => p.categories[k]).filter((c): c is Counted => c.result === 'assessed'), skipped = periods.filter((p) => p.categories[k].result === 'not_assessed').map((p) => p.period);
    if (!ok.length) return [k, { result: 'not_assessed' as const, note: periods.length ? (periods[0].categories[k] as { note: string }).note : 'there is no period to compare' }];
    const sum: Counted = { result: 'assessed', total: 0, material: 0, not_material: 0 };
    for (const c of ok) for (const [d, v] of Object.entries(c)) if (typeof v === 'number') sum[d] = ((sum[d] as number) ?? 0) + v;
    return [k, skipped.length ? { ...sum, note: `not assessed in period ${skipped.join(', ')}: ${(periods.find((p) => p.period === skipped[0])!.categories[k] as { note: string }).note}` } : sum];
  })) as Record<Category, CategoryResult>;
  const totals = (() => { let n = 0, m = 0; for (const c of Object.values(categories)) if (c.result === 'assessed') { n += c.total; m += c.material; } return { changes: n, material: m, not_material: n - m }; })();
  const uniq = (l: GamingRow[]) => new Set(l.map((x) => x.id)).size;
  const baselineRevised = changeRows.filter((c) => c.category === 'baseline_dates' && c.material);
  const flags: Flag[] = [
    ...(retro.length ? [{ flag: 'retroactive_actual_dates' as const, severity: 'high' as const, count: retro.length, activities_total: uniq(retro), what: 'an actual start or finish the earlier update held, changed or cleared in the later one (DECM 06A504a / b)', table: 'retroactive_actuals' }] : []),
    ...(down.length ? [{ flag: 'progress_decreases' as const, severity: 'medium' as const, count: down.length, activities_total: uniq(down), what: 'a percent complete that went down between two updates (a correction, or an inflated earlier update)', table: 'progress_decreases' }] : []),
    ...(baselineRevised.length ? [{ flag: 'baseline_dates_revised' as const, severity: 'high' as const, count: baselineRevised.length, activities_total: new Set(baselineRevised.map((c) => c.id)).size, what: 'a baseline start or finish that moved by a material amount between two updates (GAO BP-10)', table: 'changes' }] : []),
    ...(back.length ? [{ flag: 'status_regressions' as const, severity: 'medium' as const, count: back.length, activities_total: uniq(back), what: 'a status that went back (complete to under way or not started, under way to not started)', table: 'status_regressions' }] : []),
  ];
  const status = retro.length || baselineRevised.length ? 'fail' : totals.material ? 'warning' : 'pass';
  const label = (k: Category) => k.replace(/_/g, ' ');
  const notes = tidyNotes([...dataDateUsedNotes(series.map((u) => rows(u.db, 'PROJECT').find((x) => x.proj_id === u.projId)).filter((p): p is Row => !!p)), ...periods.flatMap((p) => CATEGORIES.flatMap((k) => { const c = p.categories[k]; return c.result === 'not_assessed' && c.note ? [`${cap(label(k))} not assessed in period ${p.from} to ${p.to}: ${c.note}.`] : []; }))]);
  const bare = (c: CategoryResult): CategoryResult => { const { note: _n, ...rest } = c; return rest as CategoryResult; };
  const bareCats = (m: Record<Category, CategoryResult>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, bare(v)])) as Record<Category, CategoryResult>;
  return {
    report: 'Change tracking',
    status, notes,
    mode, updates: series.map((u) => ({ name: u.name, data_date: text(updateDate(u)), open_project: !!u.open })),
    totals, categories: bareCats(categories), flags, periods: periods.map((p) => ({ ...p, categories: bareCats(p.categories) })),
    changes: changeRows, logic_changes: logicRows, resource_changes: resourceRows, retroactive_actuals: retro, progress_decreases: down, status_regressions: back,
  };
}

/** The answer (every list cut to the clone's list rule, with its true total beside it), the whole result, and the result tables. */
export function shapeChanges(r: ChangeTrackingResult, first: <T>(l: T[]) => T[]) {
  const lists = ['changes', 'logic_changes', 'resource_changes', 'retroactive_actuals', 'progress_decreases', 'status_regressions'] as const;
  const answer: Record<string, unknown> = { ...r };
  for (const k of lists) { answer[k] = first(r[k] as unknown[]); answer[`${k}_total`] = r[k].length; }
  const whole: Record<string, unknown> = { ...r };
  for (const k of lists) whole[`${k}_total`] = r[k].length;
  const lead = ['period', 'from_update', 'to_update'];
  const tables = [
    { name: 'changes', columns: [...lead, 'category', 'id', 'name', 'field', 'from', 'to', 'change', 'unit', 'material', 'basis'], rows: r.changes },
    { name: 'retroactive_actuals', columns: [...lead, 'id', 'name', 'field', 'from', 'to', 'note'], rows: r.retroactive_actuals },
    { name: 'progress_decreases', columns: [...lead, 'id', 'name', 'field', 'from', 'to', 'note'], rows: r.progress_decreases },
    { name: 'status_regressions', columns: [...lead, 'id', 'name', 'field', 'from', 'to'], rows: r.status_regressions },
    { name: 'logic_changes', columns: [...lead, 'id', 'predecessor', 'change', 'from', 'to', 'material'], rows: r.logic_changes },
    { name: 'resource_changes', columns: [...lead, 'id', 'name', 'resource', 'change', 'material'], rows: r.resource_changes },
  ];
  return { answer: answer as unknown as ChangeTrackingResult & Record<string, unknown>, whole, tables };
}
