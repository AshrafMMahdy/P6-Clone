// Builds the WBS-banded row list shared by the activity table and the Gantt chart.
import { parseP6Date } from '../../core/dates.ts';
import { rows, type Db, type Row } from '../../core/db.ts';
import { activityPct, isCritical, isMilestone, projectName, statusOf, COLUMN_BY_ID, type Ctx } from '../model.ts';

export interface ActRow {
  key: string;
  kind: 'group' | 'task';
  level: number;
  task?: Row;
  wbs?: Row;
  label?: string;
  hasChildren?: boolean;
  collapsed?: boolean;
  es?: number | null; ef?: number | null; minTf?: number | null;
}

/** Is the date within n days after (n > 0) or before (n < 0) the project's data date? */
function near(d: string | undefined, c: Ctx, n: number, r?: Row): boolean {
  const t = parseP6Date(d);
  if (t == null) return false;
  const dd = parseP6Date((r ? c.proj.get(r.proj_id) : [...c.proj.values()][0])?.last_recalc_date);
  if (dd == null) return false;
  return n > 0 ? t >= dd && t <= dd + n * 1440 : t <= dd && t >= dd + n * 1440;
}

export const FILTERS: Record<string, [string, (r: Row, c: Ctx) => boolean]> = {
  all: ['All Activities', () => true],
  critical: ['Critical', (r, c) => isCritical(r, c)],
  longest: ['Longest Path', (r) => r.driving_path_flag === 'Y'],
  notstarted: ['Not Started', (r) => statusOf(r) === 'TK_NotStart'],
  inprogress: ['In Progress', (r) => statusOf(r) === 'TK_Active'],
  completed: ['Completed', (r) => statusOf(r) === 'TK_Complete'],
  open: ['Not Completed', (r) => statusOf(r) !== 'TK_Complete'],
  milestones: ['Milestones', (r) => isMilestone(r)],
  negfloat: ['Negative Float', (r) => Number(r.total_float_hr_cnt) < 0 && r.total_float_hr_cnt !== ''],
  late: ['Late Activities (finish after baseline, or negative float)', (r, c) => { if (r.act_end_date) return false; const b = c.baseline.get(`${r.task_code}|${r.proj_id}`); const f = parseP6Date(r.early_end_date || r.reend_date), bf = b ? parseP6Date(b.act_end_date || b.target_end_date) : null; return f != null && bf != null ? f > bf : Number(r.total_float_hr_cnt) < 0 && r.total_float_hr_cnt !== ''; }],
  constrained: ['Constrained Activities', (r) => !!r.cstr_type || !!r.cstr_type2],
  started30: ['Started in the Last 30 Days', (r, c) => near(r.act_start_date, c, -30, r)],
  finished30: ['Finished in the Last 30 Days', (r, c) => near(r.act_end_date, c, -30, r)],
  starting30: ['Starting in the Next 30 Days', (r, c) => !r.act_start_date && near(r.early_start_date || r.restart_date, c, 30, r)],
  finishing30: ['Finishing in the Next 30 Days', (r, c) => !r.act_end_date && near(r.early_end_date || r.reend_date, c, 30, r)],
  nopreds: ['Open Ends (no predecessors/successors)', (r, c) => !r.act_end_date && (!(c.predsOf.get(r.task_id)?.length) || !(c.succsOf.get(r.task_id)?.length))],
};

// User filters (View > Filters > New): rows of "column / is / value", all or any must match. Stored in the
// database table _FILTER (filter_id, name, json) like saved layouts; ui.filter = "user:<filter_id>".
export interface UserFilter { any: boolean; rows: { col: string; op: string; value: string }[] }
export const FILTER_OPS: Record<string, string> = {
  eq: 'equals', ne: 'is not equal to', gt: 'is greater than', ge: 'is greater than or equal to', lt: 'is less than', le: 'is less than or equal to',
  contains: 'contains', ncontains: 'does not contain', empty: 'is empty', nempty: 'is not empty',
};
export const userFilters = (db: Db) => rows(db, '_FILTER').map((r) => ({ id: r.filter_id, name: r.name, def: parseUserFilter(r.json) }));
export function parseUserFilter(json: string): UserFilter {
  try {
    const o = JSON.parse(json) as Partial<UserFilter>;
    return { any: !!o.any, rows: Array.isArray(o.rows) ? o.rows.filter((x) => x && typeof x.col === 'string' && typeof x.op === 'string').map((x) => ({ col: x.col, op: x.op, value: String(x.value ?? '') })) : [] };
  } catch { return { any: false, rows: [] }; }
}
/** Test for a user filter. Cells are compared as shown in the table, but with yyyy-mm-dd hh:mm dates (so dates compare as text) and numbers by value. */
export function userFilterTest(f: UserFilter, ctx: Ctx): (r: Row) => boolean {
  const c2: Ctx = { ...ctx, prefs: { ...ctx.prefs, dateFormat: 'yyyy-mm-dd', showTime: true } };
  const norm = (s: string) => s.trim().replace(/( A|\*)$/, '').toLowerCase();
  const asNum = (s: string) => { const t = s.replace(/[$,%\s]/g, ''); return t !== '' && Number.isFinite(Number(t)) ? Number(t) : null; };
  const tests = f.rows.map(({ col, op, value }) => {
    const c = COLUMN_BY_ID.get(col), v = norm(value), vn = asNum(v);
    return (r: Row) => {
      const x = c ? norm(c.get(r, c2)) : '', xn = asNum(x);
      const cmp = xn != null && vn != null ? xn - vn : x === v || x.startsWith(`${v} `) ? 0 : x.localeCompare(v);
      switch (op) {
        case 'eq': return cmp === 0;
        case 'ne': return cmp !== 0;
        case 'gt': return x !== '' && cmp > 0;
        case 'ge': return x !== '' && cmp >= 0;
        case 'lt': return x !== '' && cmp < 0;
        case 'le': return x !== '' && cmp <= 0;
        case 'contains': return x.includes(v);
        case 'ncontains': return !x.includes(v);
        case 'empty': return x === '';
        case 'nempty': return x !== '';
        default: return true;
      }
    };
  });
  if (!tests.length) return () => true;
  return f.any ? (r) => tests.some((t) => t(r)) : (r) => tests.every((t) => t(r));
}

export const taskStart = (r: Row) => parseP6Date(r.act_start_date) ?? parseP6Date(r.early_start_date || r.restart_date || r.target_start_date);
export const taskFinish = (r: Row) => parseP6Date(r.act_end_date) ?? parseP6Date(r.early_end_date || r.reend_date || r.target_end_date);

const SORTS: Record<string, (a: Row, b: Row) => number> = {
  '': (a, b) => (taskStart(a) ?? 0) - (taskStart(b) ?? 0) || a.task_code.localeCompare(b.task_code, undefined, { numeric: true }),
  task_code: (a, b) => a.task_code.localeCompare(b.task_code, undefined, { numeric: true }),
  task_name: (a, b) => a.task_name.localeCompare(b.task_name),
  total_float: (a, b) => Number(a.total_float_hr_cnt || 1e12) - Number(b.total_float_hr_cnt || 1e12),
  finish: (a, b) => (taskFinish(a) ?? 0) - (taskFinish(b) ?? 0),
};

// Column-header sort ("col:<id>" or "col:<id>:desc"): dates and numbers by value, text naturally; ties by start.
const DATE_COL: Record<string, (r: Row) => number | null> = {
  start: taskStart, finish: taskFinish,
  early_start: (r) => parseP6Date(r.early_start_date), early_finish: (r) => parseP6Date(r.early_end_date),
  late_start: (r) => parseP6Date(r.late_start_date), late_finish: (r) => parseP6Date(r.late_end_date),
  act_start: (r) => parseP6Date(r.act_start_date), act_finish: (r) => parseP6Date(r.act_end_date),
  planned_start: (r) => parseP6Date(r.target_start_date), planned_finish: (r) => parseP6Date(r.target_end_date),
  cstr_date: (r) => parseP6Date(r.cstr_date), cstr_date2: (r) => parseP6Date(r.cstr_date2), expect_end: (r) => parseP6Date(r.expect_end_date),
};
const NUM_COL: Record<string, string> = { orig_dur: 'target_drtn_hr_cnt', rem_dur: 'remain_drtn_hr_cnt', total_float: 'total_float_hr_cnt', free_float: 'free_float_hr_cnt' };
function sortFor(sortBy: string, ctx: Ctx): (a: Row, b: Row) => number {
  if (!sortBy.startsWith('col:')) return SORTS[sortBy] ?? SORTS[''];
  const [, id, dir] = sortBy.split(':');
  const s = dir === 'desc' ? -1 : 1;
  const col = COLUMN_BY_ID.get(id);
  const key: (r: Row) => number | string | null = DATE_COL[id] ?? (NUM_COL[id] ? (r) => (r[NUM_COL[id]] === '' || r[NUM_COL[id]] == null ? null : Number(r[NUM_COL[id]])) : (r) => col?.get(r, ctx) ?? '');
  const cache = new Map<Row, number | string | null>();
  const k = (r: Row) => { let v = cache.get(r); if (v === undefined && !cache.has(r)) cache.set(r, (v = key(r))); return v ?? null; };
  return (a, b) => {
    const x = k(a), y = k(b);
    if (x == null || x === '') return y == null || y === '' ? SORTS[''](a, b) : 1; // blanks last either way
    if (y == null || y === '') return -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return c ? s * c : SORTS[''](a, b);
  };
}

/** The Activities toolbar filter box text (kept here so commands such as Select All see the same rows as the table). */
export const toolbarSearch = { text: '' };

export function buildActivityRows(ctx: Ctx, projIds: string[], collapsed: Record<string, boolean>, filter: string, groupBy: string, sortBy: string, search = ''): ActRow[] {
  const uf = filter.startsWith('user:') ? rows(ctx.db, '_FILTER').find((r) => `user:${r.filter_id}` === filter) : undefined;
  const ut = uf ? userFilterTest(parseUserFilter(uf.json), ctx) : null;
  const f = ut ? (r: Row) => ut(r) : FILTERS[filter]?.[1] ?? FILTERS.all[1];
  const q = search.trim().toLowerCase();
  const tasks = [...ctx.taskById.values()].filter((t) => projIds.includes(t.proj_id) && f(t, ctx) && (!q || t.task_code.toLowerCase().includes(q) || t.task_name.toLowerCase().includes(q)));
  const sort = sortFor(sortBy, ctx);
  const out: ActRow[] = [];

  if (groupBy === 'none') {
    for (const t of tasks.sort(sort)) out.push({ key: `t:${t.task_id}`, kind: 'task', level: 0, task: t });
    return out;
  }
  if (groupBy.startsWith('code:')) {
    // group by an activity code type
    const typeId = groupBy.slice(5);
    const codes = new Map<string, Row>();
    for (const c of ctx.db.tables.ACTVCODE?.rows ?? []) if (c.actv_code_type_id === typeId) codes.set(c.actv_code_id, c);
    const byTask = new Map<string, string>();
    for (const a of ctx.db.tables.TASKACTV?.rows ?? []) if (a.actv_code_type_id === typeId || codes.has(a.actv_code_id)) byTask.set(a.task_id, a.actv_code_id);
    const groups = new Map<string, Row[]>();
    for (const t of tasks) { const k = byTask.get(t.task_id) ?? ''; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(t); }
    const keys = [...groups.keys()].sort((a, b) => (codes.get(a)?.short_name ?? '~').localeCompare(codes.get(b)?.short_name ?? '~'));
    for (const k of keys) {
      const gk = `c:${typeId}:${k}`;
      const ts = groups.get(k)!.sort(sort);
      const c = codes.get(k);
      const g: ActRow = { key: gk, kind: 'group', level: 0, label: c ? `${c.short_name}  ${c.actv_code_name}` : 'No Code Assigned', hasChildren: true, collapsed: !!collapsed[gk] };
      summarize(g, ts);
      out.push(g);
      if (!g.collapsed) for (const t of ts) out.push({ key: `t:${t.task_id}`, kind: 'task', level: 1, task: t });
    }
    return out;
  }

  // WBS banding
  const tasksByWbs = new Map<string, Row[]>();
  for (const t of tasks) { if (!tasksByWbs.has(t.wbs_id)) tasksByWbs.set(t.wbs_id, []); tasksByWbs.get(t.wbs_id)!.push(t); }
  const kids = new Map<string, Row[]>();
  const allWbs = [...ctx.wbs.values()];
  for (const w of allWbs) { if (!kids.has(w.parent_wbs_id)) kids.set(w.parent_wbs_id, []); kids.get(w.parent_wbs_id)!.push(w); }
  for (const l of kids.values()) l.sort((a, b) => Number(a.seq_num || 0) - Number(b.seq_num || 0) || a.wbs_short_name.localeCompare(b.wbs_short_name, undefined, { numeric: true }));
  const filtering = filter !== 'all' || !!q;

  const visit = (w: Row, level: number, path: string): { rows: ActRow[]; ts: Row[] } => {
    const childW = (kids.get(w.wbs_id) ?? []).filter((c) => c.proj_id === w.proj_id && c.proj_node_flag !== 'Y');
    const own = (tasksByWbs.get(w.wbs_id) ?? []).sort(sort);
    const gk = `w:${w.wbs_id}`;
    const label = w.proj_node_flag === 'Y' ? `${ctx.proj.get(w.proj_id)?.proj_short_name ?? w.wbs_short_name}  ${projectName(ctx.db, ctx.proj.get(w.proj_id) ?? w)}` : `${path}  ${w.wbs_name}`;
    const g: ActRow = { key: gk, kind: 'group', level, wbs: w, label, collapsed: !!collapsed[gk] };
    const sub: ActRow[] = [];
    const allTs: Row[] = [...own];
    for (const c of childW) {
      const r = visit(c, level + 1, path && w.proj_node_flag !== 'Y' ? `${path}.${c.wbs_short_name}` : c.wbs_short_name);
      allTs.push(...r.ts);
      sub.push(...r.rows);
    }
    g.hasChildren = own.length > 0 || sub.length > 0;
    summarize(g, allTs);
    if (filtering && !allTs.length) return { rows: [], ts: [] };
    const rowsOut: ActRow[] = [g];
    if (!g.collapsed) {
      for (const t of own) rowsOut.push({ key: `t:${t.task_id}`, kind: 'task', level: level + 1, task: t });
      rowsOut.push(...sub);
    }
    return { rows: rowsOut, ts: allTs };
  };

  for (const pid of projIds) {
    const root = allWbs.find((w) => w.proj_id === pid && w.proj_node_flag === 'Y');
    if (!root) {
      for (const t of tasks.filter((x) => x.proj_id === pid).sort(sort)) out.push({ key: `t:${t.task_id}`, kind: 'task', level: 0, task: t });
      continue;
    }
    out.push(...visit(root, 0, '').rows);
    // tasks whose WBS is missing or in another project
    const orphans = tasks.filter((t) => t.proj_id === pid && (!ctx.wbs.has(t.wbs_id) || ctx.wbs.get(t.wbs_id)!.proj_id !== pid));
    for (const t of orphans) out.push({ key: `t:${t.task_id}`, kind: 'task', level: 1, task: t });
  }
  return out;
}

function summarize(g: ActRow, ts: Row[]): void {
  let es = Infinity, ef = -Infinity, tf = Infinity;
  for (const t of ts) {
    const s = taskStart(t), f = taskFinish(t);
    if (s != null && s < es) es = s;
    if (f != null && f > ef) ef = f;
    if (t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null && !t.act_end_date) tf = Math.min(tf, Number(t.total_float_hr_cnt));
  }
  g.es = Number.isFinite(es) ? es : null;
  g.ef = Number.isFinite(ef) ? ef : null;
  g.minTf = Number.isFinite(tf) ? tf : null;
}

export const pctOf = activityPct;
