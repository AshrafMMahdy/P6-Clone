// Reports in the app: saving the user's reports (Report Wizard) in the database, and running any report to one of
// the Run Report outputs. The save dialogs and the Print button stay with the user.
import { addField, rows, table } from '../../core/db.ts';
import { getDb, getUi, mutate, setUi, toast } from '../store.ts';
import { nowStamp } from '../../core/report/reports.ts';
import { pagesToHtml } from '../print/output.ts';
import { pageSetup } from '../print.ts';
import { listReports, runReport, type ReportSpec } from './engine.ts';
import { OUTPUTS, reportHtml, reportPages, reportText, reportXlsx, type ReportOutput } from './output.ts';

/** Save (or replace, by id or by name) a report definition; returns its id ("custom:N"). */
export function saveReport(spec: ReportSpec, id?: string): string {
  let rid = id?.startsWith('custom:') ? id.slice(7) : '';
  mutate(`${rid ? 'Modify' : 'Add'} Report ${spec.name}`, (d) => {
    const t = table(d, '_REPORT');
    for (const f of ['report_id', 'name', 'json']) addField(t, f);
    const ex = rid ? t.rows.find((r) => r.report_id === rid) : t.rows.find((r) => r.name.toLowerCase() === spec.name.toLowerCase());
    if (ex) { ex.name = spec.name; ex.json = JSON.stringify(spec); rid = ex.report_id; }
    else { rid = String(Math.max(0, ...t.rows.map((r) => Number(r.report_id) || 0)) + 1); t.rows.push({ report_id: rid, name: spec.name, json: JSON.stringify(spec) }); }
  });
  setUi({ view: 'reports', detailTab: `custom:${rid}` });
  return `custom:${rid}`;
}

export function deleteReport(id: string): void {
  const rid = id.slice(7);
  mutate('Delete Report', (d) => { table(d, '_REPORT').rows = rows(d, '_REPORT').filter((r) => r.report_id !== rid); });
  setUi({ detailTab: 'schedule' });
}

/** Run a report to an output. Preview / printer / PDF go through the print engine; files go through a save dialog. */
export async function runReportTo(id: string, output: ReportOutput, weeks?: number): Promise<string | boolean | null> {
  const ui = getUi();
  if (!ui.openProjects.length) { toast('Open a project to run reports.'); return null; }
  const db = getDb();
  const { entry, report } = runReport(db, ui.openProjects, id, { prefs: ui.prefs, weeks });
  const base = entry.name.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'report';
  if (output === 'preview' || output === 'printer' || output === 'pdf') {
    const pages = reportPages(db, ui.openProjects, report, pageSetup(), ui.prefs, entry.name);
    const r = await window.p6.printHtml(pagesToHtml(pages, report.title), output === 'printer' ? 'print' : output, `${base}.pdf`);
    if (output === 'pdf' && r) toast(`Saved ${r} (${pages.length} page${pages.length > 1 ? 's' : ''})`);
    return r;
  }
  const [, label, ext] = OUTPUTS.find((o) => o[0] === output)!;
  const bytes = output === 'excel' ? await reportXlsx(report) : new TextEncoder().encode(output === 'html' ? reportHtml(report, nowStamp()) : reportText(report));
  const path = await window.p6.saveFile(`${base}.${ext}`, bytes, [{ name: label, extensions: [ext] }]);
  if (path) toast(`Saved ${path}`);
  return path;
}

export const reportEntries = () => listReports(getDb());
