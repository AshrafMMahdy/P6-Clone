// Time the desktop app importing one (large) file through the Import wizard. node scripts/import-big.ts <file.xer>
import { _electron as electron } from 'playwright';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const file = process.argv[2];
const root = join(import.meta.dirname, '..');
const ud = process.env.P6_UD ?? mkdtempSync(join(tmpdir(), 'p6big-')); // reuse a database with P6_UD
const t0 = Date.now();
const lap = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s  ${s}`);
const app = await electron.launch({ args: [root, '--user-data', ud, '--import', file], cwd: root });
const win = await app.firstWindow();
const errors: string[] = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await win.waitForSelector('.dialog .wizard-side', { timeout: 120000 }); lap('import wizard open (file parsed + validated)');
await win.click('button:has-text("Next >")');
await win.click('button:has-text("Finish")');
await win.waitForSelector('.grid-row', { timeout: 300000 }); lap('activities shown');
const mem = await app.evaluate(async ({ app }) => (await app.getAppMetrics()).map((m) => `${m.type}:${Math.round(m.memory.workingSetSize / 1024)}MB`).join(' '));
console.log('  memory', mem);
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(200); }
const rows = await win.locator('.grid-row').count(); console.log('  grid rows rendered', rows);
await win.keyboard.press('F9').catch(() => {});
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu', 'tools.schedule'));
await win.waitForTimeout(1500);
const sched = win.locator('button:has-text("Schedule")').last(); if (await sched.count()) { const t = Date.now(); await sched.click(); await win.waitForTimeout(500); lap(`F9 scheduled (${Date.now() - t} ms click-to-idle)`); }
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu', 'file.commit'));
await win.waitForTimeout(3000);
const dbf = join(ud, 'p6clone-db.json'); lap(`database saved: ${existsSync(dbf) ? (statSync(dbf).size / 1048576).toFixed(0) + ' MB' : 'NOT FOUND'}`);
console.log('  projects in database', await win.evaluate(() => document.body.innerText.match(/(\d+) projects in database/)?.[1]));
console.log(errors.length ? 'ERRORS:\n  ' + errors.slice(0, 5).join('\n  ') : 'no page errors');
await app.close();
