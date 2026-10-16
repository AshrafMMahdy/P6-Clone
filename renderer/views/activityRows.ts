// Builds the WBS-banded row list shared by the activity table and the Gantt chart.
import { parseP6Date } from '../../core/dates.ts';
import type { Row } from '../../core/db.ts';
import { activityPct, isCritical, isMilestone, projectName, statusOf, type Ctx } from '../model.ts';

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
  nopreds: ['Open Ends (no predecessors/successors)', (r, c) => !r.act_end_date && (!(c.predsOf.get(r.task_id)?.length) || !(c.succsOf.get(r.task_id)?.length))],
};

export const taskStart = (r: Row) => parseP6Date(r.act_start_date) ?? parseP6Date(r.early_start_date || r.restart_date || r.target_start_date);
export const taskFinish = (r: Row) => parseP6Date(r.act_end_date) ?? parseP6Date(r.early_end_date || r.reend_date || r.target_end_date);

const SORTS: Record<string, (a: Row, b: Row) => number> = {
  '': (a, b) => (taskStart(a) ?? 0) - (taskStart(b) ?? 0) || a.task_code.localeCompare(b.task_code, undefined, { numeric: true }),
  task_code: (a, b) => a.task_code.localeCompare(b.task_code, undefined, { numeric: true }),
  task_name: (a, b) => a.task_name.localeCompare(b.task_name),
  total_float: (a, b) => Number(a.total_float_hr_cnt || 1e12) - Number(b.total_float_hr_cnt || 1e12),
  finish: (a, b) => (taskFinish(a) ?? 0) - (taskFinish(b) ?? 0),
};

export function buildActivityRows(ctx: Ctx, projIds: string[], collapsed: Record<string, boolean>, filter: string, groupBy: string, sortBy: string, search = ''): ActRow[] {
  const f = FILTERS[filter]?.[1] ?? FILTERS.all[1];
  const q = search.trim().toLowerCase();
  const tasks = [...ctx.taskById.values()].filter((t) => projIds.includes(t.proj_id) && f(t, ctx) && (!q || t.task_code.toLowerCase().includes(q) || t.task_name.toLowerCase().includes(q)));
  const sort = SORTS[sortBy] ?? SORTS[''];
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
