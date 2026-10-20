// Reports as P6 makes them (Tools > Reports): a report is a subject area (activities, resource assignments, WBS,
// resources, relationships), its columns, a filter, grouping and sorting, and a title. The Report Wizard creates
// them; P6's standard reports are the same definitions shipped with the application, plus a few fixed-format ones
// (schedule by WBS, cost by account, resource usage by month). Pure (no store): the app, the AI assistant, the CLI
// and the MCP server all run reports through here.
import { groupBy as groupRows, rows, type Db, type Row } from '../../core/db.ts';
import { parseP6Date } from '../../core/dates.ts';
import { activityCosts, earnedValue, sumLines, type CostLine } from '../../core/cost/rollup.ts';
import { relationshipFloat } from '../../core/schedule/cpm.ts';
import { spreadUsage } from '../../core/resource/usage.ts';
import { REPORTS, type Report } from '../../core/report/reports.ts';
import { dayHours, type DayHours } from '../../core/project/units.ts';
import { COLUMNS, extraColumns, fmtDate, makeCtx, projectName, type Column, type Ctx } from '../model.ts';
import type { Prefs } from '../store.ts';
import { buildActivityRows, FILTERS, userFilters } from '../views/activityRows.ts';

export type Subject = 'activities' | 'assignments' | 'wbs' | 'resources' | 'relationships';
export interface ReportSpec {
  name: string; group: string; subject: Subject;
  columns: string[]; filter: string; groupBy: string; sortBy: string; sortDesc?: boolean;
  title?: string; description?: string;
}
export interface ReportEntry { id: string; name: string; group: string; kind: 'standard' | 'custom'; description?: string; spec?: ReportSpec }
export interface RunOptions { prefs: Prefs; weeks?: number }
export type { Report };

const money = (n: number) => (n ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00');
const num2 = (n: number) => String(Math.round(n * 100) / 100);
const days = (h: string | number | undefined, hpd: number) => (h === '' || h == null ? '' : num2(Number(h) / hpd));
const n = (s: string | undefined) => Number(s || 0) || 0;
type Col<T> = { id: string; title: string; align?: 'right'; get: (x: T, env: Env) => string };
/** dh: days per activity (core/project/units.ts) */
interface Env { db: Db; ctx: Ctx; prefs: Prefs; ev: Map<string, ReturnType<typeof earnedValue>>; projIds: string[]; dh: DayHours }

// ---------------------------------------------------------------- subject areas and their columns
const ASSIGNMENT_COLS: Col<Row>[] = [
  { id: 'task_code', title: 'Activity ID', get: (a, e) => e.ctx.taskById.get(a.task_id)?.task_code ?? '' },
  { id: 'task_name', title: 'Activity Name', get: (a, e) => e.ctx.taskById.get(a.task_id)?.task_name ?? '' },
  { id: 'rsrc_id', title: 'Resource ID', get: (a, e) => e.ctx.rsrc.get(a.rsrc_id)?.rsrc_short_name ?? '' },
  { id: 'rsrc_name', title: 'Resource Name', get: (a, e) => e.ctx.rsrc.get(a.rsrc_id)?.rsrc_name ?? '' },
  { id: 'rsrc_type', title: 'Resource Type', get: (a, e) => ({ RT_Labor: 'Labor', RT_Equip: 'Nonlabor', RT_Mat: 'Material' } as Record<string, string>)[e.ctx.rsrc.get(a.rsrc_id)?.rsrc_type ?? ''] ?? '' },
  { id: 'target_qty', title: 'Budgeted Units', align: 'right', get: (a) => num2(n(a.target_qty)) },
  { id: 'act_qty', title: 'Actual Units', align: 'right', get: (a) => num2(n(a.act_reg_qty) + n(a.act_ot_qty)) },
  { id: 'remain_qty', title: 'Remaining Units', align: 'right', get: (a) => num2(n(a.remain_qty)) },
  { id: 'atc_qty', title: 'At Completion Units', align: 'right', get: (a) => num2(n(a.act_reg_qty) + n(a.act_ot_qty) + n(a.remain_qty)) },
  { id: 'target_cost', title: 'Budgeted Cost', align: 'right', get: (a) => money(n(a.target_cost)) },
  { id: 'act_cost', title: 'Actual Cost', align: 'right', get: (a) => money(n(a.act_reg_cost) + n(a.act_ot_cost)) },
  { id: 'remain_cost', title: 'Remaining Cost', align: 'right', get: (a) => money(n(a.remain_cost)) },
  { id: 'atc_cost', title: 'At Completion Cost', align: 'right', get: (a) => money(n(a.act_reg_cost) + n(a.act_ot_cost) + n(a.remain_cost)) },
  { id: 'start', title: 'Start', get: (a, e) => fmtDate(a.act_start_date || a.restart_date || a.target_start_date, e.prefs) + (a.act_start_date ? ' A' : '') },
  { id: 'finish', title: 'Finish', get: (a, e) => fmtDate(a.act_end_date || a.reend_date || a.target_end_date, e.prefs) + (a.act_end_date ? ' A' : '') },
];
/** minTf: the lowest total float, in days (env.dh) */
interface WbsRow { w: Row; level: number; path: string; line: CostLine; start: number | null; finish: number | null; count: number; minTf: number | null }
const WBS_COLS: Col<WbsRow>[] = [
  { id: 'wbs_code', title: 'WBS Code', get: (x) => x.path },
  { id: 'wbs_name', title: 'WBS Name', get: (x) => x.w.wbs_name },
  { id: 'activities', title: 'Activities', align: 'right', get: (x) => String(x.count) },
  { id: 'start', title: 'Start', get: (x, e) => fmtDate(x.start, e.prefs) },
  { id: 'finish', title: 'Finish', get: (x, e) => fmtDate(x.finish, e.prefs) },
  { id: 'total_float', title: 'Total Float', align: 'right', get: (x) => (x.minTf == null ? '' : days(x.minTf, 1)) },
  { id: 'budget', title: 'Budgeted Total Cost', align: 'right', get: (x) => money(x.line.budget) },
  { id: 'actual', title: 'Actual Total Cost', align: 'right', get: (x) => money(x.line.actual) },
  { id: 'remaining', title: 'Remaining Total Cost', align: 'right', get: (x) => money(x.line.remaining) },
  ...(['bac', 'pv', 'ev', 'ac', 'sv', 'cv', 'spi', 'cpi', 'etc', 'eac', 'vac'] as const).map((k): Col<WbsRow> => ({
    id: `ev_${k}`, title: ({ bac: 'Budget at Completion', pv: 'Planned Value Cost', ev: 'Earned Value Cost', ac: 'Actual Cost (ACWP)', sv: 'Schedule Variance', cv: 'Cost Variance', spi: 'Schedule Performance Index', cpi: 'Cost Performance Index', etc: 'Estimate To Complete', eac: 'Estimate At Completion', vac: 'Variance At Completion' })[k],
    align: 'right', get: (x) => { const v = earnedValue(x.line)[k]; return k === 'spi' || k === 'cpi' ? (v ? v.toFixed(2) : '') : money(v); },
  })),
];
const RESOURCE_COLS: Col<Row>[] = [
  { id: 'rsrc_id', title: 'Resource ID', get: (r) => r.rsrc_short_name },
  { id: 'rsrc_name', title: 'Resource Name', get: (r) => r.rsrc_name },
  { id: 'rsrc_type', title: 'Resource Type', get: (r) => ({ RT_Labor: 'Labor', RT_Equip: 'Nonlabor', RT_Mat: 'Material' } as Record<string, string>)[r.rsrc_type] ?? r.rsrc_type },
  { id: 'max_units', title: 'Max Units / Day', align: 'right', get: (r, e) => { const x = rows(e.db, 'RSRCRATE').find((q) => q.rsrc_id === r.rsrc_id); return x?.max_qty_per_hr ? num2(n(x.max_qty_per_hr) * e.prefs.hoursPerDay) : ''; } },
  { id: 'price', title: 'Price / Unit', align: 'right', get: (r, e) => { const x = rows(e.db, 'RSRCRATE').find((q) => q.rsrc_id === r.rsrc_id); return x?.cost_per_qty ? money(n(x.cost_per_qty)) : ''; } },
  { id: 'calendar', title: 'Calendar', get: (r, e) => rows(e.db, 'CALENDAR').find((c) => c.clndr_id === r.clndr_id)?.clndr_name ?? '' },
  { id: 'assignments', title: 'Assignments', align: 'right', get: (r, e) => String(asgOf(e).get(r.rsrc_id)?.length ?? 0) },
  { id: 'target_qty', title: 'Budgeted Units', align: 'right', get: (r, e) => num2((asgOf(e).get(r.rsrc_id) ?? []).reduce((s, a) => s + n(a.target_qty), 0)) },
  { id: 'act_qty', title: 'Actual Units', align: 'right', get: (r, e) => num2((asgOf(e).get(r.rsrc_id) ?? []).reduce((s, a) => s + n(a.act_reg_qty) + n(a.act_ot_qty), 0)) },
  { id: 'remain_qty', title: 'Remaining Units', align: 'right', get: (r, e) => num2((asgOf(e).get(r.rsrc_id) ?? []).reduce((s, a) => s + n(a.remain_qty), 0)) },
  { id: 'target_cost', title: 'Budgeted Cost', align: 'right', get: (r, e) => money((asgOf(e).get(r.rsrc_id) ?? []).reduce((s, a) => s + n(a.target_cost), 0)) },
];
const asgCache = new WeakMap<Env, Map<string, Row[]>>();
const asgOf = (e: Env) => { let m = asgCache.get(e); if (!m) { m = groupRows(rows(e.db, 'TASKRSRC').filter((a) => e.projIds.includes(a.proj_id)), 'rsrc_id'); asgCache.set(e, m); } return m; };
const REL_LABEL: Record<string, string> = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };
const relFloatCache = new WeakMap<Env, (r: Row) => number | null>();
const RELATIONSHIP_COLS: Col<Row>[] = [
  { id: 'pred_code', title: 'Predecessor', get: (p, e) => e.ctx.taskById.get(p.pred_task_id)?.task_code ?? '' },
  { id: 'pred_name', title: 'Predecessor Name', get: (p, e) => e.ctx.taskById.get(p.pred_task_id)?.task_name ?? '' },
  { id: 'succ_code', title: 'Successor', get: (p, e) => e.ctx.taskById.get(p.task_id)?.task_code ?? '' },
  { id: 'succ_name', title: 'Successor Name', get: (p, e) => e.ctx.taskById.get(p.task_id)?.task_name ?? '' },
  { id: 'type', title: 'Relationship Type', get: (p) => REL_LABEL[p.pred_type] ?? p.pred_type },
  { id: 'lag', title: 'Lag', align: 'right', get: (p, e) => days(p.lag_hr_cnt || '0', e.dh.rel(p)) },
  { id: 'free_float', title: 'Relationship Free Float', align: 'right', get: (p, e) => { let f = relFloatCache.get(e); if (!f) { f = relationshipFloat(e.db, e.ctx); relFloatCache.set(e, f); } const v = f(p); return v == null ? '' : days(v, e.dh.rel(p)); } },
  { id: 'driving', title: 'Driving', get: (p, e) => { let f = relFloatCache.get(e); if (!f) { f = relationshipFloat(e.db, e.ctx); relFloatCache.set(e, f); } return f(p) === 0 ? 'Yes' : ''; } },
];

export const SUBJECTS: Record<Subject, { title: string; groupings: [string, string][]; defaultColumns: string[] }> = {
  activities: { title: 'Activities', groupings: [['wbs', 'WBS'], ['none', 'No grouping']], defaultColumns: ['task_code', 'task_name', 'orig_dur', 'rem_dur', 'start', 'finish', 'total_float'] },
  assignments: { title: 'Resource Assignments', groupings: [['resource', 'Resource'], ['activity', 'Activity'], ['none', 'No grouping']], defaultColumns: ['task_code', 'task_name', 'rsrc_id', 'target_qty', 'act_qty', 'remain_qty', 'start', 'finish'] },
  wbs: { title: 'WBS', groupings: [['wbs', 'WBS hierarchy']], defaultColumns: ['wbs_code', 'wbs_name', 'start', 'finish', 'budget', 'actual', 'remaining'] },
  resources: { title: 'Resources', groupings: [['none', 'No grouping'], ['type', 'Resource Type']], defaultColumns: ['rsrc_id', 'rsrc_name', 'rsrc_type', 'assignments', 'target_qty', 'target_cost'] },
  relationships: { title: 'Relationships', groupings: [['none', 'No grouping'], ['pred', 'Predecessor']], defaultColumns: ['pred_code', 'pred_name', 'succ_code', 'succ_name', 'type', 'lag', 'free_float', 'driving'] },
};

/** The columns a subject area offers (activities: every activity column, codes and UDFs included). */
export function subjectColumns(db: Db, subject: Subject): { id: string; title: string }[] {
  const pick = (c: { id: string; title: string }) => ({ id: c.id, title: c.title });
  if (subject === 'activities') return [...COLUMNS, ...extraColumns(db)].map(pick);
  return ({ assignments: ASSIGNMENT_COLS, wbs: WBS_COLS, resources: RESOURCE_COLS, relationships: RELATIONSHIP_COLS } as Record<string, Col<never>[]>)[subject].map(pick);
}
/** Filters a report can use: P6's default activity filters and the user's own (View > Filters). */
export const reportFilters = (db: Db): { id: string; name: string }[] => [...Object.entries(FILTERS).map(([id, [name]]) => ({ id, name })), ...userFilters(db).map((f) => ({ id: `user:${f.id}`, name: f.name }))];

/** Group bands with no activity under them (after filtering) are left out, as P6 does. One pass from the end. */
function dropEmptyBands(list: Report['rows']): Report['rows'] {
  const keep = new Array<boolean>(list.length);
  const bound: number[] = []; // per level: index of the next band at that level or above
  let nextContent = Infinity;
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i], lv = r.level ?? 0;
    if (!r.bold) { keep[i] = true; nextContent = i; continue; }
    keep[i] = nextContent < (bound[lv] ?? Infinity);
    for (let l = lv; l < 32; l++) bound[l] = i;
  }
  return list.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------- running a definition
function sortRows<T>(list: T[], get: (x: T) => string, desc?: boolean): T[] {
  const key = (s: string) => { const v = Number(s.replace(/[,$%]/g, '').replace(/ A$/, '')); return s !== '' && Number.isFinite(v) ? v : null; };
  return list.sort((a, b) => {
    const x = get(a), y = get(b), nx = key(x), ny = key(y);
    const d = nx != null && ny != null ? nx - ny : (parseP6Date(x) ?? 0) && (parseP6Date(y) ?? 0) ? (parseP6Date(x)! - parseP6Date(y)!) : x.localeCompare(y);
    return desc ? -d : d;
  });
}

export function runSpec(db: Db, projIds: string[], spec: ReportSpec, o: RunOptions): Report {
  const prefs = o.prefs;
  const ctx = makeCtx(db, prefs);
  const env: Env = { db, ctx, prefs, ev: new Map(), projIds, dh: dayHours(db, prefs.hoursPerDay, !!prefs.calendarDays) };
  const titleOf = spec.title || spec.name;
  const sub = projIds.map((id) => { const p = ctx.proj.get(id); return p ? `${p.proj_short_name} - ${projectName(db, p)}` : ''; }).join('; ');
  const filterName = spec.filter && spec.filter !== 'all' ? reportFilters(db).find((f) => f.id === spec.filter)?.name ?? spec.filter : '';
  const subtitle = [sub, filterName && `Filter: ${filterName}`].filter(Boolean).join(' · ');
  const out: Report['rows'] = [];

  if (spec.subject === 'activities') {
    const all = new Map([...COLUMNS, ...extraColumns(db)].map((c) => [c.id, c]));
    const cols = spec.columns.map((id) => all.get(id)).filter((c): c is Column => !!c);
    const sort = spec.sortBy ? `col:${spec.sortBy}${spec.sortDesc ? ':desc' : ''}` : '';
    for (const r of buildActivityRows(ctx, projIds, {}, spec.filter || 'all', spec.groupBy === 'none' ? 'none' : spec.groupBy || 'wbs', sort)) {
      if (r.kind === 'group') out.push({ cells: cols.map((c, i) => (i === 0 ? r.label ?? '' : c.id === 'start' ? fmtDate(r.es, prefs) : c.id === 'finish' ? fmtDate(r.ef, prefs) : '')), level: r.level, bold: true });
      else out.push({ cells: cols.map((c) => c.get(r.task!, ctx)), level: r.level });
    }
    // drop group bands left without activities by the filter
    return { title: titleOf, subtitle, columns: cols.map((c) => c.title), rows: spec.filter && spec.filter !== 'all' ? dropEmptyBands(out) : out };
  }

  const activityOk = (() => {
    if (!spec.filter || spec.filter === 'all') return () => true;
    const ids = new Set(buildActivityRows(ctx, projIds, {}, spec.filter, 'none', '').filter((r) => r.task).map((r) => r.task!.task_id));
    return (taskId: string) => ids.has(taskId);
  })();

  if (spec.subject === 'assignments') {
    const cols = spec.columns.map((id) => ASSIGNMENT_COLS.find((c) => c.id === id)).filter((c): c is Col<Row> => !!c);
    let list = rows(db, 'TASKRSRC').filter((a) => projIds.includes(a.proj_id) && activityOk(a.task_id));
    if (spec.sortBy) { const c = ASSIGNMENT_COLS.find((x) => x.id === spec.sortBy); if (c) list = sortRows(list, (a) => c.get(a, env), spec.sortDesc); }
    const g = spec.groupBy === 'resource' ? (a: Row) => a.rsrc_id : spec.groupBy === 'activity' ? (a: Row) => a.task_id : null;
    if (!g) for (const a of list) out.push({ cells: cols.map((c) => c.get(a, env)) });
    else for (const [k, as] of list.reduce((m, a) => { const k = g(a); const l = m.get(k); if (l) l.push(a); else m.set(k, [a]); return m; }, new Map<string, Row[]>())) {
      const label = spec.groupBy === 'resource' ? `${ctx.rsrc.get(k)?.rsrc_short_name ?? ''}  ${ctx.rsrc.get(k)?.rsrc_name ?? ''}` : `${ctx.taskById.get(k)?.task_code ?? ''}  ${ctx.taskById.get(k)?.task_name ?? ''}`;
      out.push({ cells: cols.map((_, i) => (i === 0 ? label : '')), bold: true, level: 0 });
      for (const a of as) out.push({ cells: cols.map((c) => c.get(a, env)), level: 1 });
    }
    return { title: titleOf, subtitle, columns: cols.map((c) => c.title), rows: out };
  }

  if (spec.subject === 'wbs') {
    const cols = spec.columns.map((id) => WBS_COLS.find((c) => c.id === id)).filter((c): c is Col<WbsRow> => !!c);
    const costs = activityCosts(db, projIds);
    const tasksBy = groupRows(rows(db, 'TASK').filter((t) => projIds.includes(t.proj_id) && activityOk(t.task_id)), 'wbs_id');
    const kids = groupRows(rows(db, 'PROJWBS'), 'parent_wbs_id');
    const walk = (w: Row, level: number, path: string): WbsRow => {
      const own = tasksBy.get(w.wbs_id) ?? [];
      const me: WbsRow = { w, level, path, line: sumLines([]), start: null, finish: null, count: 0, minTf: null };
      const idx = out.length; out.push({ cells: [] });
      const children = (kids.get(w.wbs_id) ?? []).filter((c) => c.proj_id === w.proj_id && c.proj_node_flag !== 'Y').sort((a, b) => n(a.seq_num) - n(b.seq_num)).map((c) => walk(c, level + 1, path ? `${path}.${c.wbs_short_name}` : c.wbs_short_name));
      me.line = sumLines([...own.map((t) => costs.get(t.task_id)!).filter(Boolean), ...children.map((c) => c.line)]);
      me.count = own.length + children.reduce((s, c) => s + c.count, 0);
      for (const t of own) {
        const s = parseP6Date(t.act_start_date || t.early_start_date || t.restart_date), f = parseP6Date(t.act_end_date || t.early_end_date || t.reend_date);
        if (s != null && (me.start == null || s < me.start)) me.start = s;
        if (f != null && (me.finish == null || f > me.finish)) me.finish = f;
        const tf = n(t.total_float_hr_cnt) / env.dh.task(t);
        if (!t.act_end_date && t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null && (me.minTf == null || tf < me.minTf)) me.minTf = tf;
      }
      for (const c of children) {
        if (c.start != null && (me.start == null || c.start < me.start)) me.start = c.start;
        if (c.finish != null && (me.finish == null || c.finish > me.finish)) me.finish = c.finish;
        if (c.minTf != null && (me.minTf == null || c.minTf < me.minTf)) me.minTf = c.minTf;
      }
      out[idx] = { cells: cols.map((c) => c.get(me, env)), level, bold: level === 0 || children.length > 0 };
      return me;
    };
    for (const pid of projIds) { const root = rows(db, 'PROJWBS').find((w) => w.proj_id === pid && w.proj_node_flag === 'Y'); if (root) walk(root, 0, ctx.proj.get(pid)?.proj_short_name ?? root.wbs_short_name); }
    return { title: titleOf, subtitle, columns: cols.map((c) => c.title), rows: out.filter((r, i) => i === 0 || r.cells.length) };
  }

  if (spec.subject === 'resources') {
    const cols = spec.columns.map((id) => RESOURCE_COLS.find((c) => c.id === id)).filter((c): c is Col<Row> => !!c);
    let list = [...rows(db, 'RSRC')];
    if (spec.filter && spec.filter !== 'all') list = list.filter((r) => (asgOf(env).get(r.rsrc_id) ?? []).some((a) => activityOk(a.task_id)));
    if (spec.sortBy) { const c = RESOURCE_COLS.find((x) => x.id === spec.sortBy); if (c) list = sortRows(list, (r) => c.get(r, env), spec.sortDesc); }
    if (spec.groupBy === 'type') for (const [k, rs] of groupRows(list, 'rsrc_type')) { out.push({ cells: cols.map((_, i) => (i === 0 ? ({ RT_Labor: 'Labor', RT_Equip: 'Nonlabor', RT_Mat: 'Material' } as Record<string, string>)[k] ?? k : '')), bold: true }); for (const r of rs) out.push({ cells: cols.map((c) => c.get(r, env)), level: 1 }); }
    else for (const r of list) out.push({ cells: cols.map((c) => c.get(r, env)) });
    return { title: titleOf, subtitle, columns: cols.map((c) => c.title), rows: out };
  }

  // relationships
  const cols = spec.columns.map((id) => RELATIONSHIP_COLS.find((c) => c.id === id)).filter((c): c is Col<Row> => !!c);
  const inProj = new Set(rows(db, 'TASK').filter((t) => projIds.includes(t.proj_id)).map((t) => t.task_id));
  let list = rows(db, 'TASKPRED').filter((p) => (inProj.has(p.task_id) || inProj.has(p.pred_task_id)) && (activityOk(p.task_id) || activityOk(p.pred_task_id)));
  const c0 = RELATIONSHIP_COLS.find((x) => x.id === (spec.sortBy || 'pred_code'));
  if (c0) list = sortRows(list, (p) => c0.get(p, env), spec.sortDesc);
  if (spec.groupBy === 'pred') for (const [k, ps] of groupRows(list, 'pred_task_id')) { out.push({ cells: cols.map((_, i) => (i === 0 ? `${ctx.taskById.get(k)?.task_code ?? ''}  ${ctx.taskById.get(k)?.task_name ?? ''}` : '')), bold: true }); for (const p of ps) out.push({ cells: cols.map((c) => c.get(p, env)), level: 1 }); }
  else for (const p of list) out.push({ cells: cols.map((c) => c.get(p, env)) });
  return { title: titleOf, subtitle, columns: cols.map((c) => c.title), rows: out };
}

// ---------------------------------------------------------------- P6's standard reports
const spec = (name: string, group: string, subject: Subject, columns: string[], o: Partial<ReportSpec> = {}): ReportSpec => ({ name, group, subject, columns, filter: 'all', groupBy: subject === 'activities' ? 'wbs' : 'none', sortBy: '', ...o });
const STD_SPECS: Record<string, ReportSpec> = {
  'std-late': spec('Late Activities', 'Schedule', 'activities', ['task_code', 'task_name', 'bl_finish', 'finish', 'var_bl_finish', 'total_float'], { filter: 'late', description: 'Activities finishing after their baseline finish (or with negative float when there is no baseline).' }),
  'std-notstarted': spec('Activities Not Started', 'Schedule', 'activities', ['task_code', 'task_name', 'orig_dur', 'start', 'finish', 'total_float'], { filter: 'notstarted' }),
  'std-inprogress': spec('Activities In Progress', 'Schedule', 'activities', ['task_code', 'task_name', 'pct', 'rem_dur', 'act_start', 'finish', 'total_float'].filter((c) => COLUMNS.some((x) => x.id === c)), { filter: 'inprogress' }),
  'std-completed': spec('Completed Activities', 'Schedule', 'activities', ['task_code', 'task_name', 'start', 'finish', 'orig_dur'], { filter: 'completed' }),
  'std-started30': spec('Activities Started in the Last 30 Days', 'Progress', 'activities', ['task_code', 'task_name', 'start', 'pct', 'rem_dur', 'finish'], { filter: 'started30', groupBy: 'none', sortBy: 'start' }),
  'std-finished30': spec('Activities Finished in the Last 30 Days', 'Progress', 'activities', ['task_code', 'task_name', 'start', 'finish', 'orig_dur'], { filter: 'finished30', groupBy: 'none', sortBy: 'finish' }),
  'std-starting30': spec('Activities Starting in the Next 30 Days', 'Progress', 'activities', ['task_code', 'task_name', 'orig_dur', 'start', 'finish', 'total_float'], { filter: 'starting30', groupBy: 'none', sortBy: 'start' }),
  'std-milestones': spec('Milestone Report', 'Schedule', 'activities', ['task_code', 'task_name', 'start', 'finish', 'bl_finish', 'var_bl_finish', 'total_float'], { filter: 'milestones', groupBy: 'none', sortBy: 'finish' }),
  'std-float': spec('Total Float Report', 'Schedule', 'activities', ['task_code', 'task_name', 'rem_dur', 'start', 'finish', 'total_float'], { filter: 'open', groupBy: 'none', sortBy: 'total_float' }),
  'std-negfloat': spec('Negative Float Report', 'Schedule', 'activities', ['task_code', 'task_name', 'start', 'finish', 'total_float'], { filter: 'negfloat', groupBy: 'none', sortBy: 'total_float' }),
  'std-constraints': spec('Constraint Report', 'Schedule', 'activities', ['task_code', 'task_name', 'cstr_type', 'cstr_date', 'start', 'finish', 'total_float'].filter((c) => COLUMNS.some((x) => x.id === c)), { filter: 'constrained', groupBy: 'none' }),
  'std-openends': spec('Open Ends Report', 'Schedule', 'activities', ['task_code', 'task_name', 'preds', 'succs', 'start', 'finish'], { filter: 'nopreds', groupBy: 'none' }),
  'std-relationships': spec('Relationship Report', 'Schedule', 'relationships', SUBJECTS.relationships.defaultColumns),
  'std-evactivity': spec('Earned Value by Activity', 'Earned Value', 'activities', ['task_code', 'task_name', 'ev_bac', 'ev_pv', 'ev_ev', 'ev_ac', 'ev_sv', 'ev_cv', 'ev_spi', 'ev_cpi', 'ev_eac', 'ev_vac']),
  'std-evwbs': spec('Earned Value by WBS', 'Earned Value', 'wbs', ['wbs_code', 'wbs_name', 'ev_bac', 'ev_pv', 'ev_ev', 'ev_ac', 'ev_sv', 'ev_cv', 'ev_spi', 'ev_cpi', 'ev_eac', 'ev_vac'], { groupBy: 'wbs' }),
  'std-actcost': spec('Activity Cost Report', 'Cost', 'activities', ['task_code', 'task_name', 'bud_cost', 'act_cost', 'rem_cost', 'ev_eac', 'ev_vac']),
  'std-wbscost': spec('WBS Cost Summary', 'Cost', 'wbs', ['wbs_code', 'wbs_name', 'start', 'finish', 'budget', 'actual', 'remaining', 'ev_eac'], { groupBy: 'wbs' }),
  'std-resources': spec('Resource List', 'Resources', 'resources', SUBJECTS.resources.defaultColumns, { groupBy: 'type' }),
  'std-asgactivity': spec('Resource Assignments by Activity', 'Resources', 'assignments', ['task_code', 'task_name', 'rsrc_id', 'rsrc_name', 'target_qty', 'remain_qty', 'target_cost'], { groupBy: 'activity' }),
};
const FIXED_GROUP: Record<string, string> = { schedule: 'Schedule', critical: 'Schedule', lookahead: 'Progress', variance: 'Schedule', assignments: 'Resources', costWbs: 'Earned Value', costAccount: 'Cost' };
export const REPORT_GROUPS = ['Schedule', 'Progress', 'Earned Value', 'Cost', 'Resources', 'My Reports'];

/** Every report: P6's standard ones, then the user's (Report Wizard), saved in the database table _REPORT. */
export function listReports(db: Db): ReportEntry[] {
  const fixed: ReportEntry[] = REPORTS.map((r) => ({ id: r.id, name: r.title, group: FIXED_GROUP[r.id] ?? r.group, kind: 'standard' }));
  const usage: ReportEntry = { id: 'usageMonth', name: 'Resource Usage by Month', group: 'Resources', kind: 'standard', description: 'Actual and remaining units of each resource per month.' };
  const std = Object.entries(STD_SPECS).map(([id, s]): ReportEntry => ({ id, name: s.name, group: s.group, kind: 'standard', description: s.description, spec: s }));
  const custom = rows(db, '_REPORT').map((r): ReportEntry | null => { const s = parseSpec(r.json); return s ? { id: `custom:${r.report_id}`, name: s.name, group: s.group || 'My Reports', kind: 'custom', description: s.description, spec: s } : null; }).filter((x): x is ReportEntry => !!x);
  const order = (e: ReportEntry) => REPORT_GROUPS.indexOf(e.group) < 0 ? 99 : REPORT_GROUPS.indexOf(e.group);
  return [...fixed, usage, ...std, ...custom].sort((a, b) => order(a) - order(b));
}

export function parseSpec(json: string | unknown): ReportSpec | null {
  try {
    const o = (typeof json === 'string' ? JSON.parse(json) : json) as Partial<ReportSpec> & Record<string, unknown>;
    const subject = (['activities', 'assignments', 'wbs', 'resources', 'relationships'] as const).find((s) => s === o.subject) ?? 'activities';
    if (typeof o.name !== 'string' || !o.name.trim()) return null;
    return {
      name: o.name.trim(), group: typeof o.group === 'string' && o.group ? o.group : 'My Reports', subject,
      columns: Array.isArray(o.columns) && o.columns.length ? o.columns.filter((c): c is string => typeof c === 'string') : SUBJECTS[subject].defaultColumns,
      filter: typeof o.filter === 'string' ? o.filter : 'all', groupBy: typeof (o.groupBy ?? o.group_by) === 'string' ? String(o.groupBy ?? o.group_by) : SUBJECTS[subject].groupings[0][0],
      sortBy: typeof (o.sortBy ?? o.sort_by) === 'string' ? String(o.sortBy ?? o.sort_by) : '', sortDesc: !!(o.sortDesc ?? o.sort_desc),
      title: typeof o.title === 'string' ? o.title : undefined, description: typeof o.description === 'string' ? o.description : undefined,
    };
  } catch { return null; }
}

/** Run a report by id (standard or custom:N) or by name. */
export function runReport(db: Db, projIds: string[], idOrName: string, o: RunOptions): { entry: ReportEntry; report: Report } {
  const all = listReports(db);
  const key = String(idOrName).toLowerCase();
  const entry = all.find((e) => e.id.toLowerCase() === key) ?? all.find((e) => e.name.toLowerCase() === key) ?? all.find((e) => e.name.toLowerCase().includes(key));
  if (!entry) throw new Error(`No report "${idOrName}". Reports: ${all.map((e) => e.name).join(', ')}`);
  if (entry.spec) return { entry, report: runSpec(db, projIds, entry.spec, o) };
  if (entry.id === 'usageMonth') return { entry, report: usageReport(db, projIds, o) };
  const def = REPORTS.find((r) => r.id === entry.id)!;
  return { entry, report: def.build(db, projIds, { hoursPerDay: o.prefs.hoursPerDay, fmtDate: (s) => fmtDate(s, o.prefs), weeks: o.weeks, dayHours: dayHours(db, o.prefs.hoursPerDay, !!o.prefs.calendarDays) }) };
}

function usageReport(db: Db, projIds: string[], o: RunOptions): Report {
  const tasks = rows(db, 'TASK').filter((t) => projIds.includes(t.proj_id));
  let lo = Infinity, hi = -Infinity;
  for (const t of tasks) { const s = parseP6Date(t.act_start_date || t.early_start_date || t.restart_date), f = parseP6Date(t.act_end_date || t.early_end_date || t.reend_date); if (s != null && s < lo) lo = s; if (f != null && f > hi) hi = f; }
  if (!Number.isFinite(lo) || hi <= lo) return { title: 'Resource Usage by Month', columns: ['Resource'], rows: [] };
  const u = spreadUsage(db, projIds, { start: lo, end: hi, bucket: 'month' });
  const rsrc = new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r]));
  const months = u.buckets.slice(0, 60).map((b) => { const d = new Date(b * 60000); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}`; });
  const out: Report['rows'] = [];
  for (const r of u.rows) {
    const tot = r.actual.map((a, i) => a + r.remaining[i]);
    if (!tot.some((v) => v > 0.001)) continue;
    out.push({ cells: [rsrc.get(r.rsrcId)?.rsrc_short_name ?? r.rsrcId, num2(tot.reduce((s, v) => s + v, 0)), ...tot.slice(0, 60).map((v) => (v ? num2(v) : ''))] });
  }
  return { title: 'Resource Usage by Month', subtitle: `Units (hours) per month, actual + remaining · ${o.prefs.hoursPerDay} h/day`, columns: ['Resource', 'Total', ...months], rows: out };
}
