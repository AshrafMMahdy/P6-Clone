// File > Export to Excel / Import from Excel: P6-style spreadsheets (core/excel). Import shows what will change and
// applies it as one undoable step.
import { exportSheets, planImport } from '../core/excel/p6sheets.ts';
import { readXlsx, writeXlsx } from '../core/excel/xlsx.ts';
import { applyOps } from '../core/project/ops.ts';
import { rows } from '../core/db.ts';
import { getDb, getUi, mutate, toast } from './store.ts';

const XLSX = [{ name: 'Excel Workbook', extensions: ['xlsx'] }];

export async function exportExcel(): Promise<void> {
  const ui = getUi();
  if (!ui.openProjects.length) return void toast('Open a project first.');
  const p = rows(getDb(), 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  const bytes = await writeXlsx(exportSheets(getDb(), ui.openProjects, ui.prefs.hoursPerDay));
  const path = await window.p6.saveFile(`${p?.proj_short_name ?? 'schedule'}.xlsx`, bytes, XLSX);
  if (path) toast(`Saved ${path}`);
}

export async function importExcel(): Promise<void> {
  const ui = getUi();
  const p = rows(getDb(), 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  if (!p) return void toast('Open the project to update first, then import the spreadsheet into it.');
  const f = await window.p6.openFile(XLSX, 'Import from Excel');
  if (!f) return;
  let plan;
  try { plan = planImport(getDb(), await readXlsx(f.bytes), p.proj_short_name, ui.prefs.hoursPerDay); }
  catch (e) { return void toast(`Could not read ${f.name}: ${(e as Error).message}`); }
  const s = plan.summary;
  const lines = [
    `Activities: ${s.activitiesAdded} new, ${s.activitiesUpdated} changed, ${s.activitiesDeleted} deleted`,
    `Relationships: ${s.relationshipsAdded} new, ${s.relationshipsUpdated} changed, ${s.relationshipsDeleted} deleted`,
    `Resources: ${s.resourcesAdded} new; assignments: ${s.assignmentsAdded} new, ${s.assignmentsDeleted} removed`,
    `${s.unchanged} rows unchanged. Calculated columns (status, start, finish, float) are not imported.`,
    ...plan.warnings.slice(0, 8).map((w) => `Warning: ${w}`),
  ];
  if (!plan.ops.length) return void toast(`Nothing to change: ${f.name} matches project ${p.proj_short_name}.`);
  if (!(await window.p6.confirm(`Import ${f.name} into ${p.proj_short_name}?`, lines.join('\n') + '\n\nYou can undo the import with Ctrl+Z.'))) return;
  let err = '';
  mutate(`Import ${f.name}`, (d) => { const r = applyOps(d, plan.ops, { hoursPerDay: ui.prefs.hoursPerDay }); if (!r.ok) { err = `Row ${r.error!.index + 1} (${(r.error!.op as { op?: string; id?: string })?.op} ${(r.error!.op as { id?: string })?.id ?? ''}): ${r.error!.message}`; throw new Error(err); } });
  toast(err ? `Import stopped, nothing changed. ${err}` : `Imported ${f.name}: ${plan.ops.length} change(s). Press F9 to reschedule.`);
}
