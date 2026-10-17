// Run Report outputs, as in P6's Run Report dialog (Print Preview, Direct to Printer, HTML File, ASCII Text File)
// plus PDF and Excel. Pages come from the same layout engine as schedule printing; Page Setup applies.
import { rows, type Db } from '../../core/db.ts';
import { reportCsv, type Report } from '../../core/report/reports.ts';
import { writeXlsx } from '../../core/excel/xlsx.ts';
import { fmtDate, projectName } from '../model.ts';
import type { Prefs } from '../store.ts';
import { layoutReport, normalizePageSetup, printVars, type Page, type PageSetup } from '../print/layout.ts';

export type ReportOutput = 'preview' | 'printer' | 'pdf' | 'html' | 'text' | 'excel';
export const OUTPUTS: [ReportOutput, string, string][] = [
  ['preview', 'Print Preview', ''], ['printer', 'Direct to Printer', ''], ['pdf', 'PDF File', 'pdf'],
  ['html', 'HTML File', 'html'], ['text', 'ASCII Text File (CSV)', 'csv'], ['excel', 'Excel Workbook', 'xlsx'],
];

export function reportPages(db: Db, projIds: string[], report: Report, setup: PageSetup | Record<string, unknown>, prefs: Prefs, reportName?: string): Page[] {
  const ps = normalizePageSetup(setup);
  // a report has no Gantt chart: the layout name variable shows the report's name
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === projIds[0]);
  const vars = printVars({ projId: projIds.length > 1 ? `${projIds.length} projects` : p?.proj_short_name, projName: p ? projectName(db, p) : '', dataDate: fmtDate(p?.last_recalc_date, prefs), finish: fmtDate(p?.scd_end_date, prefs), layout: reportName ?? report.title, filter: '' });
  return layoutReport(report, ps, vars);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A standalone HTML page (P6's HTML File output). */
export function reportHtml(r: Report, stamp: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>
body { font: 13px Arial, Helvetica, sans-serif; margin: 24px; color: #111; } h1 { font-size: 18px; margin: 0 0 4px; } .sub { color: #555; margin-bottom: 12px; }
table { border-collapse: collapse; } th { background: #dde4ee; border: 1px solid #8a9ab0; padding: 3px 6px; text-align: left; }
td { border: 1px solid #d0d0d0; padding: 2px 6px; white-space: nowrap; } tr.g td { background: #eef2fa; font-weight: bold; } td.n { text-align: right; }
</style></head><body><h1>${esc(r.title)}</h1><div class="sub">${esc([r.subtitle, `Run ${stamp}`].filter(Boolean).join(' · '))}</div>
<table><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
${r.rows.map((x) => `<tr${x.bold ? ' class="g"' : ''}>${x.cells.map((c, i) => `<td${/^[-$]?[\d,]+(\.\d+)?%?$/.test(c) ? ' class="n"' : ''}${i === 0 && x.level ? ` style="padding-left:${6 + x.level * 14}px"` : ''}>${esc(c)}</td>`).join('')}</tr>`).join('\n')}
</tbody></table>${r.text ? `<pre>${esc(r.text)}</pre>` : ''}</body></html>`;
}

/** P6's ASCII Text File output, as comma-separated values (with a byte-order mark, so Excel opens Arabic and other
 *  non-Latin text correctly). */
export const reportText = (r: Report) => '﻿' + reportCsv(r);

/** One worksheet: title, subtitle, column titles, rows (numbers as numbers). */
export async function reportXlsx(r: Report): Promise<Uint8Array> {
  const cell = (c: string) => { const t = c.replace(/[$,]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : c; };
  const sheet = [[r.title], [r.subtitle ?? ''], [], r.columns, ...r.rows.map((x) => x.cells.map((c, i) => (i === 0 && x.level ? '  '.repeat(x.level) + c : cell(c))))];
  const widths = r.columns.map((c, i) => Math.min(50, Math.max(c.length + 2, ...r.rows.slice(0, 300).map((x) => (x.cells[i] ?? '').length + 2))));
  return writeXlsx([{ name: r.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report', rows: sheet, widths, boldRows: 4 }]);
}
