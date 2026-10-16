// Built-in reports: tabular data that the UI renders, prints and exports to CSV.
import { groupBy, indexBy, rows, type Db, type Row } from '../db.ts';
import { formatP6Date, parseP6Date, MIN_PER_DAY } from '../dates.ts';
import { activityCosts, sumLines, spi, cpi, percentComplete, type CostLine } from '../cost/rollup.ts';

export interface ReportOpts { hoursPerDay: number; fmtDate: (s: string | number | null | undefined) => string; weeks?: number }
export interface Report { title: string; subtitle?: string; columns: string[]; rows: { cells: string[]; level?: number; bold?: boolean }[]; text?: string }
export interface ReportDef { id: string; title: string; group: string; build: (db: Db, projIds: string[], o: ReportOpts) => Report }

const days = (h: string | number | undefined, o: ReportOpts) => (h === '' || h == null ? '' : String(Math.round((Number(h) / o.hoursPerDay) * 10) / 10));
const money = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ratio = (v: number) => (v ? v.toFixed(2) : '');
const start = (t: Row, o: ReportOpts) => (t.act_start_date ? `${o.fmtDate(t.act_start_date)} A` : o.fmtDate(t.early_start_date || t.target_start_date));
const finish = (t: Row, o: ReportOpts) => (t.act_end_date ? `${o.fmtDate(t.act_end_date)} A` : o.fmtDate(t.early_end_date || t.target_end_date));
const pctTxt = (t: Row, a: Row[]) => `${Math.round(percentComplete(t, a) * 1000) / 10}%`;

function wbsWalk(db: Db, projIds: string[], visit: (w: Row, level: number, path: string) => void): void {
  const kids = groupBy(rows(db, 'PROJWBS'), 'parent_wbs_id');
  const go = (w: Row, level: number, path: string) => {
    visit(w, level, path);
    const ch = (kids.get(w.wbs_id) ?? []).filter((c) => c.proj_id === w.proj_id && c.proj_node_flag !== 'Y').sort((a, b) => Number(a.seq_num || 0) - Number(b.seq_num || 0));
    for (const c of ch) go(c, level + 1, w.proj_node_flag === 'Y' ? c.wbs_short_name : `${path}.${c.wbs_short_name}`);
  };
  for (const pid of projIds) { const root = rows(db, 'PROJWBS').find((w) => w.proj_id === pid && w.proj_node_flag === 'Y'); if (root) go(root, 0, ''); }
}

const projTitle = (db: Db, projIds: string[]) => projIds.map((id) => rows(db, 'PROJECT').find((p) => p.proj_id === id)?.proj_short_name).join(', ');

export const REPORTS: ReportDef[] = [
  {
    id: 'schedule', group: 'Schedule', title: 'Schedule Report (by WBS)',
    build: (db, projIds, o) => {
      const tasksBy = groupBy(rows(db, 'TASK').filter((t) => projIds.includes(t.proj_id)), 'wbs_id');
      const asg = groupBy(rows(db, 'TASKRSRC'), 'task_id');
      const out: Report['rows'] = [];
      wbsWalk(db, projIds, (w, level, path) => {
        out.push({ cells: [w.proj_node_flag === 'Y' ? w.wbs_short_name : path, w.wbs_name, '', '', '', '', '', '', ''], level, bold: true });
        for (const t of (tasksBy.get(w.wbs_id) ?? []).sort((a, b) => (a.early_start_date || a.act_start_date).localeCompare(b.early_start_date || b.act_start_date)))
          out.push({ cells: [t.task_code, t.task_name, days(t.target_drtn_hr_cnt, o), days(t.remain_drtn_hr_cnt, o), pctTxt(t, asg.get(t.task_id) ?? []), start(t, o), finish(t, o), days(t.total_float_hr_cnt, o), t.driving_path_flag === 'Y' ? 'Yes' : ''], level: level + 1 });
      });
      return { title: 'Schedule Report', subtitle: projTitle(db, projIds), columns: ['Activity ID', 'Activity Name', 'Orig Dur', 'Rem Dur', '% Comp', 'Start', 'Finish', 'Total Float', 'Longest Path'], rows: out };
    },
  },
  {
    id: 'critical', group: 'Schedule', title: 'Critical Activities',
    build: (db, projIds, o) => {
      const projs = indexBy(rows(db, 'PROJECT'), 'proj_id');
      const ts = rows(db, 'TASK').filter((t) => projIds.includes(t.proj_id) && !t.act_end_date && t.total_float_hr_cnt !== '' &&
        (projs.get(t.proj_id)?.critical_path_type === 'CT_DrivPath' ? t.driving_path_flag === 'Y' : Number(t.total_float_hr_cnt) <= Number(projs.get(t.proj_id)?.critical_drtn_hr_cnt || 0)));
      ts.sort((a, b) => (a.early_start_date || '').localeCompare(b.early_start_date || ''));
      return { title: 'Critical Activities', subtitle: projTitle(db, projIds), columns: ['Activity ID', 'Activity Name', 'Rem Dur', 'Start', 'Finish', 'Total Float'], rows: ts.map((t) => ({ cells: [t.task_code, t.task_name, days(t.remain_drtn_hr_cnt, o), start(t, o), finish(t, o), days(t.total_float_hr_cnt, o)] })) };
    },
  },
  {
    id: 'lookahead', group: 'Schedule', title: 'Lookahead (activities in the next weeks)',
    build: (db, projIds, o) => {
      const p = rows(db, 'PROJECT').find((x) => projIds.includes(x.proj_id));
      const dd = parseP6Date(p?.last_recalc_date) ?? Date.now() / 60000;
      const end = dd + (o.weeks ?? 3) * 7 * MIN_PER_DAY;
      const ts = rows(db, 'TASK').filter((t) => projIds.includes(t.proj_id) && !t.act_end_date).filter((t) => {
        const s = parseP6Date(t.early_start_date) ?? Infinity;
        return s <= end;
      }).sort((a, b) => (a.early_start_date || '').localeCompare(b.early_start_date || ''));
      return { title: `${o.weeks ?? 3}-Week Lookahead`, subtitle: `from data date ${o.fmtDate(dd)} to ${o.fmtDate(end)}`, columns: ['Activity ID', 'Activity Name', 'Status', 'Start', 'Finish', 'Rem Dur', 'Total Float'], rows: ts.map((t) => ({ cells: [t.task_code, t.task_name, t.act_start_date ? 'In Progress' : 'Not Started', start(t, o), finish(t, o), days(t.remain_drtn_hr_cnt, o), days(t.total_float_hr_cnt, o)] })) };
    },
  },
  {
    id: 'variance', group: 'Schedule', title: 'Baseline Variance',
    build: (db, projIds, o) => {
      const out: Report['rows'] = [];
      for (const pid of projIds) {
        const p = rows(db, 'PROJECT').find((x) => x.proj_id === pid);
        const bl = new Map(rows(db, 'TASK').filter((t) => t.proj_id === p?.sum_base_proj_id).map((t) => [t.task_code, t]));
        for (const t of rows(db, 'TASK').filter((x) => x.proj_id === pid)) {
          const b = bl.get(t.task_code);
          const bf = parseP6Date(b?.act_end_date || b?.target_end_date), f = parseP6Date(t.act_end_date || t.early_end_date);
          out.push({ cells: [t.task_code, t.task_name, b ? o.fmtDate(b.act_start_date || b.target_start_date) : '', b ? o.fmtDate(b.act_end_date || b.target_end_date) : '', start(t, o), finish(t, o), bf != null && f != null ? String(Math.round((bf - f) / MIN_PER_DAY)) : ''] });
        }
      }
      return { title: 'Baseline Variance', subtitle: 'Variance in calendar days (negative = later than baseline)', columns: ['Activity ID', 'Activity Name', 'BL Start', 'BL Finish', 'Start', 'Finish', 'Finish Var (d)'], rows: out };
    },
  },
  {
    id: 'assignments', group: 'Resources', title: 'Resource Assignments by Resource',
    build: (db, projIds, o) => {
      const tasks = indexBy(rows(db, 'TASK'), 'task_id');
      const by = groupBy(rows(db, 'TASKRSRC').filter((a) => projIds.includes(a.proj_id)), 'rsrc_id');
      const out: Report['rows'] = [];
      for (const r of rows(db, 'RSRC')) {
        const list = by.get(r.rsrc_id);
        if (!list?.length) continue;
        out.push({ cells: [r.rsrc_short_name, r.rsrc_name, '', '', '', '', '', ''], bold: true });
        for (const a of list) {
          const t = tasks.get(a.task_id);
          out.push({ cells: [t?.task_code ?? '', t?.task_name ?? '', a.target_qty, String(Number(a.act_reg_qty || 0) + Number(a.act_ot_qty || 0)), a.remain_qty, t ? start(t, o) : '', t ? finish(t, o) : '', money(Number(a.target_cost || 0))], level: 1 });
        }
      }
      return { title: 'Resource Assignments', subtitle: projTitle(db, projIds), columns: ['Activity ID', 'Activity Name', 'Budgeted Units', 'Actual Units', 'Remaining Units', 'Start', 'Finish', 'Budgeted Cost'], rows: out };
    },
  },
  {
    id: 'costWbs', group: 'Cost', title: 'Cost and Earned Value by WBS',
    build: (db, projIds) => {
      const costs = activityCosts(db, projIds);
      const tasksBy = groupBy(rows(db, 'TASK').filter((t) => projIds.includes(t.proj_id)), 'wbs_id');
      const kids = groupBy(rows(db, 'PROJWBS'), 'parent_wbs_id');
      const total = (w: Row): CostLine => sumLines([...(tasksBy.get(w.wbs_id) ?? []).map((t) => costs.get(t.task_id)!), ...(kids.get(w.wbs_id) ?? []).filter((c) => c.proj_id === w.proj_id && c.proj_node_flag !== 'Y').map(total)]);
      const out: Report['rows'] = [];
      wbsWalk(db, projIds, (w, level, path) => {
        const l = total(w);
        out.push({ cells: [w.proj_node_flag === 'Y' ? w.wbs_short_name : path, w.wbs_name, money(l.bac), money(l.actual), money(l.remaining), money(l.eac), money(l.pv), money(l.ev), ratio(spi(l)), ratio(cpi(l))], level, bold: level === 0 });
      });
      return { title: 'Cost and Earned Value by WBS', subtitle: projTitle(db, projIds), columns: ['WBS', 'Name', 'Budget (BAC)', 'Actual', 'Remaining', 'At Completion', 'Planned Value', 'Earned Value', 'SPI', 'CPI'], rows: out };
    },
  },
  {
    id: 'costAccount', group: 'Cost', title: 'Cost by Cost Account',
    build: (db, projIds) => {
      const by = new Map<string, { bud: number; act: number; rem: number }>();
      const add = (acct: string, bud: number, act: number, rem: number) => { const v = by.get(acct) ?? { bud: 0, act: 0, rem: 0 }; v.bud += bud; v.act += act; v.rem += rem; by.set(acct, v); };
      for (const a of rows(db, 'TASKRSRC').filter((x) => projIds.includes(x.proj_id))) add(a.acct_id || '', Number(a.target_cost || 0), Number(a.act_reg_cost || 0) + Number(a.act_ot_cost || 0), Number(a.remain_cost || 0));
      for (const e of rows(db, 'PROJCOST').filter((x) => projIds.includes(x.proj_id))) add(e.acct_id || '', Number(e.target_cost || 0), Number(e.act_cost || 0), Number(e.remain_cost || 0));
      const accts = indexBy(rows(db, 'ACCOUNT'), 'acct_id');
      return { title: 'Cost by Cost Account', subtitle: projTitle(db, projIds), columns: ['Cost Account', 'Name', 'Budgeted', 'Actual', 'Remaining', 'At Completion'],
        rows: [...by].map(([k, v]) => ({ cells: [accts.get(k)?.acct_short_name ?? (k ? k : '(none)'), accts.get(k)?.acct_name ?? '', money(v.bud), money(v.act), money(v.rem), money(v.act + v.rem)] })) };
    },
  },
];

export function reportCsv(r: Report): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [r.columns.map(q).join(','), ...r.rows.map((x) => x.cells.map(q).join(','))].join('\r\n');
}

export const nowStamp = () => formatP6Date(Date.now() / 60000);
