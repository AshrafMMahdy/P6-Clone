// End-to-end: Tools > Reports (standard reports, Report Wizard, Run Report outputs), the Earned Value layout, and
// the embedded platform agent creating a report on screen and reading one (a scripted stand-in model).  node tests/e2e/reports.ts
// (needs vendor/whiq-agent: the assistant is the platform's agent)
import { _electron as electron } from 'playwright';
import { fakeModel } from './fake-model.ts';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readXlsx } from '../../core/excel/xlsx.ts';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const pages = (f: string) => (readFileSync(f).toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6rep-'));
const out = mkdtempSync(join(tmpdir(), 'p6rep-out-'));
const app = await electron.launch({ args: [root, '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await app.evaluate(({ dialog }, dir) => { const d = dialog as any; d.showSaveDialog = async (_w: unknown, o: { defaultPath?: string }) => ({ canceled: false, filePath: `${dir}\\${(o?.defaultPath ?? 'out').split(/[\\/]/).pop()}` }); d.showMessageBox = async () => ({ response: 0 }); }, out);
const runMenu = (id: string) => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.getAllWindows().find((w) => w.title.includes('Clone'))?.webContents.send('menu', id); }, id);
const previewPdf = async () => { for (let i = 0; i < 60; i++) { const u = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('.pdf'))?.webContents.getURL() ?? null); if (u) return decodeURIComponent(u.replace(/^file:\/\/\/?/, '')).replace(/\//g, '\\'); await win.waitForTimeout(250); } return null; };
const closePreviews = () => app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().endsWith('.pdf')) w.destroy(); });
const bodyRows = () => win.locator('.report-table tbody tr').count();

// 1. standard reports in P6's groups
await runMenu('tools.reports');
await win.waitForSelector('.report-item');
const groups = await win.locator('.report-list > div > div:first-child').allInnerTexts();
ok(['Schedule', 'Progress', 'Earned Value', 'Cost', 'Resources'].every((g) => groups.includes(g)), 'report groups: ' + groups.join(', '));
await win.click('.report-item:has-text("Milestone Report")');
ok((await win.locator('.report-page h2').innerText()) === 'Milestone Report' && (await bodyRows()) === 44, 'Milestone Report previews 44 milestones');

// 2. Report Wizard by hand
await runMenu('tools.reportWizard');
await win.waitForSelector('.dialog-title:has-text("Report Wizard")');
await win.click('.dialog button:has-text("Next >")'); // subject: activities
await win.click('.dialog button:has-text("Next >")'); // columns: defaults
await win.selectOption('.dialog select[size]', 'critical');
await win.click('.dialog button:has-text("Next >")');
await win.click('.dialog button:has-text("Next >")'); // group and sort
await win.locator('.dialog input').first().fill('E2E Critical');
await win.click('.dialog button:has-text("Next >")');
await win.click('.dialog label:has-text("Run the report")');
await win.click('.dialog button:has-text("Finish")');
await win.waitForTimeout(400);
ok(await win.locator('.report-item:has-text("E2E Critical")').count() === 1, 'the wizard saved the report under My Reports');
ok((await win.locator('.report-page h2').innerText()) === 'E2E Critical' && (await bodyRows()) >= 46, `it previews the critical activities (${await bodyRows()} rows incl. WBS bands)`);
await win.keyboard.press('Control+z'); await win.waitForTimeout(300);
ok(await win.locator('.report-item:has-text("E2E Critical")').count() === 0, 'Ctrl+Z removes the new report');
await win.keyboard.press('Control+y'); await win.waitForTimeout(300);

// 3. Run Report: Print Preview, then Excel
await win.click('.report-item:has-text("Relationship Report")');
await win.click('button:has-text("Run Report...")');
await win.click('.dialog label:has-text("Print Preview")');
await win.click('.dialog button:has-text("OK")');
const pv = await previewPdf();
ok(!!pv && pages(pv) >= 2, `Run Report > Print Preview: ${pv ? pages(pv) : 0} pages`);
await closePreviews();
await win.click('button:has-text("Run Report...")');
await win.click('.dialog label:has-text("Excel Workbook")');
await win.click('.dialog button:has-text("OK")');
let xl = ''; for (let i = 0; i < 40 && !existsSync(xl = join(out, 'Relationship Report.xlsx')); i++) await win.waitForTimeout(250);
ok(existsSync(xl) && (await readXlsx(new Uint8Array(readFileSync(xl))))[0].rows[0][0] === 'Relationship Report', 'Run Report > Excel Workbook saved the report');

// 4. Earned Value layout
await win.getByText('Activities', { exact: true }).first().click(); await win.waitForSelector('.grid-header');
await runMenu('view.layout.open');
await win.waitForSelector('.dialog-title:has-text("Layout")');
await win.locator('.dialog tr', { hasText: 'Earned Value Layout' }).first().click();
await win.locator('.dialog button', { hasText: /^(Open|Apply|OK)$/ }).first().click();
await win.waitForTimeout(400);
const heads = await win.locator('.grid-header').innerText();
ok(/Budget at Completion/.test(heads) && /Earned Value Cost/.test(heads) && /Cost Performance Index/.test(heads), 'the Earned Value Layout shows the earned value columns: ' + heads.replace(/s+/g, ' ').slice(0, 160));

// 5. the agent makes a report on screen and reads one
const steps = [
  { name: 'create_report', args: { name: 'AI Float Watch', subject: 'activities', columns: ['task_code', 'task_name', 'finish', 'total_float'], filter: 'open', group_by: 'none', sort_by: 'total_float' } },
  { name: 'open_report', args: { report: 'Critical Activities' } },
  { name: 'run_report_dialog', args: { report: 'Critical Activities', output: 'excel' } },
];
// the steps through the embedded platform agent (a scripted stand-in model, fake-model.ts): its live tools are the app's (item 26: the panel has no loop of its own)
const results: any[] = [];
const fake = await fakeModel((r) => {
  if (!(r.tools ?? []).some((t) => t.function.name === 'load_tools')) return { text: 'ok' };
  const done = r.messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  results.length = 0; for (const d of done.slice(1)) { try { results.push(JSON.parse(d)); } catch { results.push({ text: d }); } }
  if (done.length === 0) return { call: 'load_tools', args: { names: ['mcp__p6clone_live__*'] } };
  const i = done.length - 1;
  return i < steps.length ? { call: `mcp__p6clone_live__${steps[i].name}`, args: steps[i].args } : { text: 'Report made.' };
});
await win.evaluate((u) => (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: u, model: 'fake-1', actions: true }, 'not-a-key'), fake.url);
await win.waitForSelector('.ai-strip'); await win.waitForTimeout(400); if (!(await win.locator('.ai-panel').count())) await win.click('.ai-strip');
await win.waitForSelector('.ai-head b:has-text("Scheduler Agent")', { timeout: 15000 });
await win.fill('.ai-panel textarea', 'Make me a float report and show me the critical activities'); await win.keyboard.press('Enter');
const seen = new Set<string>();
for (let i = 0; i < 3000 && !(await win.locator('.ai-panel .ai-msg:has-text("Report made.")').count()); i++) {
  const t = await win.locator('.dialog-title').allInnerTexts(); for (const x of t) seen.add(x);
  await win.waitForTimeout(100);
}
ok([...seen].some((x) => x.includes('Report Wizard - Columns')) && [...seen].some((x) => x.includes('Report Wizard - Filter')), 'the wizard pages were shown on screen: ' + [...seen].filter((x) => x.includes('Wizard')).join(', '));
ok(results[0]?.saved === 'AI Float Watch' && await win.locator('.report-item:has-text("AI Float Watch")').count() === 1, 'create_report saved the report: ' + JSON.stringify(results[0]).slice(0, 160));
ok(results[1]?.total_rows === 46 && results[1]?.rows?.[0]?.['Activity ID'], 'open_report returned the rows to read: ' + JSON.stringify(results[1]).slice(0, 120));
ok((await win.locator('.report-page h2').innerText()) === 'Critical Activities', 'open_report showed the report on screen');
ok(await win.locator('.dialog-title:has-text("Run Report")').count() === 1 && await win.locator('.dialog label:has-text("Excel Workbook") input').isChecked(), 'run_report_dialog opened Run Report with Excel chosen, for the user to press OK');
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close(); fake.close();
rmSync(profile, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
