// Printed pages of the Activities layout from a database: the one entry point used by the app (current layout),
// the AI assistant, the CLI `print` command and the MCP `export_pdf` tool.
import type { Db } from '../../core/db.ts';
import { rows as tableRows } from '../../core/db.ts';
import { parseP6Date } from '../../core/dates.ts';
import { COLUMNS, extraColumns, fmtDate, isCritical, makeCtx, projectName, type Column } from '../model.ts';
import type { Prefs } from '../store.ts';
import { buildActivityRows, FILTERS, taskFinish, taskStart, userFilters } from '../views/activityRows.ts';
import { layoutSchedule, normalizePageSetup, printVars, type Page, type PageSetup } from './layout.ts';

export const DEFAULT_PRINT_COLUMNS = ['task_code', 'task_name', 'orig_dur', 'rem_dur', 'pct', 'start', 'finish', 'total_float'];
export const DEFAULT_PREFS: Prefs = { hoursPerDay: 8, dateFormat: 'dd-MMM-yy', showTime: false, durationDecimals: 0 };

export interface PrintRequest {
  projIds: string[];
  setup?: Partial<PageSetup> | Record<string, unknown>;
  /** the layout being printed (defaults: the classic layout) */
  columns?: string[]; colWidths?: Record<string, number>;
  filter?: string; groupBy?: string; sortBy?: string; collapsed?: Record<string, boolean>; search?: string;
  layoutName?: string; prefs?: Prefs; base?: PageSetup;
}

export function printPages(db: Db, req: PrintRequest): { pages: Page[]; title: string; activities: number; unknownColumns: string[] } {
  const prefs = req.prefs ?? DEFAULT_PREFS;
  const ps = normalizePageSetup(req.setup ?? {}, req.base);
  const ctx = makeCtx(db, prefs);
  const rows = buildActivityRows(ctx, req.projIds, req.collapsed ?? {}, req.filter ?? 'all', req.groupBy ?? 'wbs', req.sortBy ?? '', req.search ?? '');
  const ids = ps.columns.length ? ps.columns : req.columns?.length ? req.columns : DEFAULT_PRINT_COLUMNS;
  const all = new Map([...COLUMNS, ...extraColumns(db)].map((c) => [c.id, c]));
  const unknownColumns = ids.filter((id) => !all.has(id));
  const cols = ids.map((id) => { const c = all.get(id); return c && req.colWidths?.[id] ? { ...c, width: req.colWidths[id] } : c; }).filter((c): c is Column => c != null);
  const proj = tableRows(db, 'PROJECT').find((p) => p.proj_id === req.projIds[0]);
  const filterName = req.filter?.startsWith('user:') ? userFilters(db).find((f) => `user:${f.id}` === req.filter)?.name ?? '' : req.filter && req.filter !== 'all' ? FILTERS[req.filter]?.[0] ?? '' : 'All Activities';
  const dd = parseP6Date(proj?.last_recalc_date);
  const vars = printVars({
    projId: req.projIds.length > 1 ? `${req.projIds.length} projects` : proj?.proj_short_name, projName: proj ? projectName(db, proj) : '',
    dataDate: fmtDate(proj?.last_recalc_date, prefs), finish: fmtDate(proj?.scd_end_date, prefs), layout: req.layoutName ?? 'Classic Schedule Layout', filter: filterName,
  });
  const pages = layoutSchedule({
    rows, cols, ctx, ps, vars, dataDate: dd != null && Number.isFinite(dd) ? dd : null,
    fmtDate: (v) => fmtDate(v, prefs), taskStart, taskFinish, isCritical: (t) => isCritical(t, ctx),
  });
  return { pages, title: `${proj?.proj_short_name ?? 'Schedule'} - ${proj ? projectName(db, proj) : ''}`, activities: rows.filter((r) => r.kind === 'task').length, unknownColumns };
}

/** Column ids that can be printed, with their titles (for Page Setup, the AI assistant and MCP). */
export const printableColumns = (db: Db): { id: string; title: string }[] => [...COLUMNS, ...extraColumns(db)].map((c) => ({ id: c.id, title: c.title }));
