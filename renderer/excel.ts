// File > Export to Excel / Import from Excel: P6-style spreadsheets (core/excel). Export lays the workbook out by a
// template (dialogs/ExcelExportDialog.tsx, P6's Modify Template); import shows what will change, applies it as one
// undoable step, and lists the rows P6 would refuse (skipped, the rest applied), as P6's import log does.
import { applyImport, exportSheets, planImport, type ExportTemplate } from '../core/excel/p6sheets.ts';
import { readXlsx, writeXlsx } from '../core/excel/xlsx.ts';
import { rows } from '../core/db.ts';
import { getDb, getUi, mutate, openDialog, toast } from './store.ts';

const XLSX = [{ name: 'Excel Workbook', extensions: ['xlsx'] }];
const TEMPLATES_KEY = 'p6clone.excelTemplates';

/** The saved spreadsheet templates (kept with the app's other settings on this computer). */
export function excelTemplates(): Record<string, ExportTemplate> {
  try { const v = JSON.parse(localStorage.getItem(TEMPLATES_KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export function saveExcelTemplates(all: Record<string, ExportTemplate>): void {
  try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(all)); } catch { /* not kept: a private window */ }
}

export async function exportExcel(template: ExportTemplate = {}): Promise<void> {
  const ui = getUi();
  if (!ui.openProjects.length) return void toast('Open a project first.');
  const p = rows(getDb(), 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  const bytes = await writeXlsx(exportSheets(getDb(), ui.openProjects, ui.prefs.hoursPerDay, !!ui.prefs.calendarDays, template));
  const path = await window.p6.saveFile(`${p?.proj_short_name ?? 'schedule'}.xlsx`, bytes, XLSX);
  if (path) toast(`Saved ${path}`);
}

export async function importExcel(): Promise<void> {
  const ui = getUi();
  const p = rows(getDb(), 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  if (!p) return void toast('Open the project to update first, then import the spreadsheet into it.');
  const f = await window.p6.openFile(XLSX, 'Import from Excel');
  if (!f) return;
  const opts = { hoursPerDay: ui.prefs.hoursPerDay, calendarDays: !!ui.prefs.calendarDays };
  let plan;
  try { plan = planImport(getDb(), await readXlsx(f.bytes), p.proj_short_name, opts.hoursPerDay, opts.calendarDays); }
  catch (e) { return void toast(`Could not read ${f.name}: ${(e as Error).message}`); }
  const s = plan.summary;
  const lines = [
    `Activities: ${s.activitiesAdded} new, ${s.activitiesUpdated} changed, ${s.activitiesDeleted} deleted`,
    `Relationships: ${s.relationshipsAdded} new, ${s.relationshipsUpdated} changed, ${s.relationshipsDeleted} deleted`,
    `Expenses: ${s.expensesAdded} new, ${s.expensesUpdated} changed, ${s.expensesDeleted} deleted`,
    `Resources: ${s.resourcesAdded} new, ${s.resourcesUpdated} changed`,
    `Assignments: ${s.assignmentsAdded} new, ${s.assignmentsUpdated} changed, ${s.assignmentsDeleted} removed`,
    `${s.unchanged} rows unchanged. Calculated columns ((*) titles) are not imported.`,
    ...plan.warnings.slice(0, 8).map((w) => `Warning: ${w}`),
    ...(plan.warnings.length > 8 ? [`(${plan.warnings.length - 8} more warnings in the import log)`] : []),
  ];
  if (!plan.ops.length) {
    if (plan.warnings.length) openDialog('log', { title: 'Spreadsheet Import Log', text: plan.warnings.join('\n') });
    return void toast(`Nothing to change: ${f.name} matches project ${p.proj_short_name}.`);
  }
  if (!(await window.p6.confirm(`Import ${f.name} into ${p.proj_short_name}?`, lines.join('\n') + '\n\nA row P6 would refuse is skipped and listed; the rest is applied. You can undo the import with Ctrl+Z.'))) return;
  let res!: ReturnType<typeof applyImport>;
  mutate(`Import ${f.name}`, (d) => { res = applyImport(d, plan, opts); });
  const log = [
    ...res.refused.map((x) => `Refused: ${x.sheet} row ${x.row} (${x.op.op}): ${x.message}`),
    ...[...plan.warnings, ...res.warnings].map((w) => `Warning: ${w}`),
  ];
  if (log.length) openDialog('log', { title: 'Spreadsheet Import Log', text: log.join('\n') });
  toast(res.applied ? `Imported ${f.name}: ${res.applied} change(s)${res.refused.length ? `, ${res.refused.length} row(s) refused (see the log)` : ''}. Press F9 to reschedule.` : `Nothing imported: every changed row was refused (see the log).`);
}
