// UI tour: import a file, then open every window and dialog via menu commands, capturing page errors and screenshots.
// node scripts/tour.ts <shotsDir> [xerFile]
import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [shots, file = join(import.meta.dirname, '..', 'Sample XERs', 'DHBL-24FEB13_VER-7.0.xer')] = process.argv.slice(2);
const root = join(import.meta.dirname, '..');
const app = await electron.launch({ args: [root, '--user-data', mkdtempSync(join(tmpdir(), 'p6tour-')), '--import', file], cwd: root });
const win = await app.firstWindow();
const errors: string[] = [];
win.on('pageerror', (e) => errors.push(e.stack ?? e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const menu = (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id);
const shot = async (name: string) => { await win.waitForTimeout(400); await win.screenshot({ path: join(shots, `${name}.png`) }); };
const closeDialogs = async () => { for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); } };

await win.waitForSelector('.dialog .wizard-side', { timeout: 30000 });
await win.click('button:has-text("Next >")');
await win.click('button:has-text("Finish")');
await win.waitForSelector('.grid-row', { timeout: 60000 });
await closeDialogs();

const steps: [string, string][] = [
  ['tools.schedule', 'schedule'], ['tools.schedLog', 'schedlog'], ['tools.importLog', 'importlog'],
  ['project.wbs', 'view-wbs'], ['project.assignments', 'view-assignments'], ['ent.resources', 'view-resources'], ['tools.reports', 'view-reports'],
  ['report.costWbs', 'report-cost'], ['report.lookahead', 'report-lookahead'], ['file.open', 'view-projects'], ['project.activities', 'view-activities'],
  ['view.columns', 'dlg-columns'], ['view.filters', 'dlg-filters'], ['view.timescale', 'dlg-timescale'], ['view.layout.saveAs', 'dlg-layout'],
  ['project.details', 'dlg-details'], ['project.baselines', 'dlg-baselines'], ['ent.eps', 'dlg-eps'], ['ent.calendars', 'dlg-calendars'],
  ['ent.codes', 'dlg-codes'], ['ent.udfs', 'dlg-udfs'], ['ent.obs', 'dlg-obs'], ['ent.accounts', 'dlg-accounts'], ['ent.roles', 'dlg-roles'],
  ['ent.currencies', 'dlg-currencies'], ['tools.level', 'dlg-level'], ['tools.progress', 'dlg-progress'], ['edit.preferences', 'dlg-prefs'],
  ['file.pageSetup', 'dlg-pagesetup'], ['file.export', 'dlg-export'], ['file.new', 'dlg-new'], ['help.about', 'dlg-about'],
  ['project.risks', 'view-risks'], ['tools.timesheets', 'view-timesheets'], ['ent.portfolios', 'view-portfolios'], ['tools.applyActuals', 'apply-actuals'],
  ['tools.riskAnalysis', 'dlg-risk-analysis'], ['file.import', 'dlg-import'], ['tools.validate', 'dlg-validate'], ['project.expenses', 'view-expenses'],
];
for (const [id, name] of steps) {
  const before = errors.length;
  await menu(id);
  await shot(name);
  if (errors.length > before) console.log(`ERROR after ${id}:\n  ${errors.slice(before).join('\n  ')}`);
  await closeDialogs();
}
// interact: select first activity, cycle details tabs
await menu('project.activities');
await win.locator('.grid-row:not(.group)').first().click();
for (const tab of ['General', 'Status', 'Resources', 'Relationships', 'Codes', 'Notebook', 'Expenses', 'Summary']) {
  const before = errors.length;
  await win.click(`.tab:has-text("${tab}")`);
  await win.waitForTimeout(150);
  if (errors.length > before) console.log(`ERROR on tab ${tab}:\n  ${errors.slice(before).join('\n  ')}`);
}
await shot('tab-relationships');
console.log(errors.length ? `${errors.length} error(s)` : 'no page errors');
await app.close();
