// End-to-end: Page Setup, Print Preview of the whole schedule, Save as PDF, Excel export and import, and the embedded
// platform agent preparing a printout (native save/open/confirm dialogs are answered by the test).  node tests/e2e/print.ts
// (needs vendor/whiq-agent: the assistant is the platform's agent)
import { _electron as electron } from 'playwright';
import { fakeModel } from './fake-model.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readXlsx, writeXlsx } from '../../core/excel/xlsx.ts';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const box = (f: string) => /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(readFileSync(f).toString('latin1'))?.slice(1).map((v) => Math.round(Number(v)));
const pages = (f: string) =>(readFileSync(f).toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6print-'));
const out = mkdtempSync(join(tmpdir(), 'p6print-out-'));
const app = await electron.launch({ args: [root, '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
// native dialogs answered by the test
await app.evaluate(({ dialog }, dir) => {
  const d = dialog as any;
  d.showSaveDialog = async (_w: unknown, o: { defaultPath?: string }) => ({ canceled: false, filePath: `${dir}\\${(o?.defaultPath ?? 'out').split(/[\\/]/).pop()}` });
  d.showOpenDialog = async () => ({ canceled: false, filePaths: [`${dir}\\edited.xlsx`] });
  d.showMessageBox = async () => ({ response: 0 });
}, out);
const runMenu = (id: string) => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.getAllWindows().find((w) => w.title.includes('Clone'))?.webContents.send('menu', id); }, id);
const previewPdf = async (): Promise<string | null> => {
  for (let i = 0; i < 60; i++) {
    const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Print Preview') || w.webContents.getURL().endsWith('.pdf'))?.webContents.getURL() ?? null);
    if (url) return decodeURIComponent(url.replace(/^file:\/\/\/?/, '')).replace(/\//g, '\\');
    await win.waitForTimeout(250);
  }
  return null;
};
const closePreviews = () => app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().endsWith('.pdf')) w.destroy(); });

// 1. Page Setup: Gantt only, relationship lines, A4 portrait
await runMenu('file.pageSetup');
await win.waitForSelector('.dialog-title:has-text("Page Setup")');
await win.selectOption('.dialog select', 'A4');
await win.click('label:has-text("Portrait")');
await win.click('.tab:has-text("Content"), [role=tab]:has-text("Content"), .tabs >> text=Content');
await win.click('label:has-text("Gantt chart only")');
await win.click('label:has-text("Relationship lines")');
await win.click('.dialog button:has-text("OK")');
const saved = await win.evaluate(() => JSON.parse(localStorage.getItem('p6clone.pageSetup') ?? '{}'));
ok(saved.paper === 'A4' && saved.landscape === false && saved.content === 'gantt' && saved.showLinks === true, 'Page Setup saved paper, orientation, content and links: ' + JSON.stringify({ p: saved.paper, l: saved.landscape, c: saved.content, k: saved.showLinks }));

// 2. Print Preview prints every activity, not only the rows on screen
await runMenu('file.printPreview');
const pv = await previewPdf();
ok(!!pv && existsSync(pv), 'Print Preview opened a PDF: ' + pv);
const n1 = pv ? pages(pv) : 0;
ok(n1 >= 3, `the preview has all the pages (${n1}) for 93 activities on A4 portrait`);
ok(JSON.stringify(pv ? box(pv) : null) === '[595,842]', `the preview pages are A4 portrait: ${JSON.stringify(pv ? box(pv) : null)}`);
await closePreviews();

// 3. Save as PDF (columns and Gantt chart, A3 landscape)
await win.evaluate(() => localStorage.setItem('p6clone.pageSetup', JSON.stringify({ paper: 'A3', landscape: true, content: 'both' })));
await runMenu('file.pdf');
let pdf = ''; for (let i = 0; i < 40 && !existsSync(pdf = join(out, 'CFC Modified.pdf')); i++) await win.waitForTimeout(250);
ok(existsSync(pdf) && pages(pdf) >= 2, `Save as PDF wrote ${existsSync(pdf) ? pages(pdf) : 0} pages`);
ok(JSON.stringify(existsSync(pdf) ? box(pdf) : null) === JSON.stringify([1191, 842]), `the PDF pages are A3 landscape: ${JSON.stringify(existsSync(pdf) ? box(pdf) : null)}`);

// 4. Excel export, edit, import
await runMenu('file.exportXlsx');
// the Export to Excel dialog (P6's template: subject areas and columns), its defaults, then Export...
await win.click('.dialog button:has-text("Export...")');
let xlsx = ''; for (let i = 0; i < 40 && !existsSync(xlsx = join(out, 'CFC Modified.xlsx')); i++) await win.waitForTimeout(250);
ok(existsSync(xlsx), 'Export to Excel wrote the workbook');
if (existsSync(xlsx)) {
  const sheets = await readXlsx(new Uint8Array(readFileSync(xlsx)));
  const t = sheets[0], id = t.rows[0].indexOf('task_code'), name = t.rows[0].indexOf('task_name');
  t.rows.find((r) => r[id] === 'A1020')![name] = 'Mobilization (from Excel)';
  writeFileSync(join(out, 'edited.xlsx'), await writeXlsx(sheets));
  await runMenu('file.importXlsx');
  await win.waitForTimeout(1500);
  ok(await win.locator('.grid-row', { hasText: 'Mobilization (from Excel)' }).count() > 0, 'Import from Excel changed the activity name');
  await win.keyboard.press('Control+z'); await win.waitForTimeout(300);
  ok(!(await win.locator('.grid-row', { hasText: 'Mobilization (from Excel)' }).count()), 'Ctrl+Z undoes the import');
}

// 5. the agent prepares a printout and opens the preview
const steps = [
  { name: 'set_print_options', args: { settings: { content: 'table', columns: ['task_code', 'task_name', 'start', 'finish'], paper: 'A4', landscape: true, footer: { right: 'Sheet [Page]/[Pages]' } } } },
  { name: 'ui_menu', args: { path: 'File > Print Preview' } },
];
// the steps through the embedded platform agent (a scripted stand-in model, fake-model.ts): its live tools are the app's (item 26: the panel has no loop of its own)
const results: any[] = [];
const fake = await fakeModel((r) => {
  if (!(r.tools ?? []).some((t) => t.function.name === 'load_tools')) return { text: 'ok' };
  const done = r.messages.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  results.length = 0; for (const d of done.slice(1)) { try { results.push(JSON.parse(d)); } catch { results.push({ text: d }); } }
  if (done.length === 0) return { call: 'load_tools', args: { names: ['mcp__p6clone_live__*'] } };
  const i = done.length - 1;
  return i < steps.length ? { call: `mcp__p6clone_live__${steps[i].name}`, args: steps[i].args } : { text: 'Printout prepared.' };
});
await win.evaluate((u) => (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: u, model: 'fake-1', actions: true }, 'not-a-key'), fake.url);
await win.waitForSelector('.ai-strip'); await win.waitForTimeout(400); if (!(await win.locator('.ai-panel').count())) await win.click('.ai-strip');
await win.waitForSelector('.ai-head b:has-text("Scheduler Agent")', { timeout: 15000 });
await win.fill('.ai-panel textarea', 'Print just the activity list on A4'); await win.keyboard.press('Enter');
await win.waitForSelector('.ai-panel .ai-msg:has-text("Printout prepared.")', { timeout: 300000 }).catch(() => {});
ok(results[0]?.settings?.content === 'table' && results[0]?.pages >= 1 && results[0]?.printable_columns?.includes('total_float'), 'set_print_options applied the settings and reported pages: ' + JSON.stringify({ c: results[0]?.settings?.content, p: results[0]?.pages }));
const pv2 = await previewPdf();
ok(!!pv2, 'the assistant opened Print Preview for the user');
await closePreviews();
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close(); fake.close();
rmSync(profile, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
