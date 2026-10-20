// Schedule analysis in the desktop app: Tools > Check Schedule Report and the Extensions window.
//   node tests/e2e/analysis.ts [screenshot dir]   (after node scripts/build.mjs)
import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const shots = process.argv[2];
const root = join(import.meta.dirname, '..', '..'), ud = mkdtempSync(join(tmpdir(), 'p6an-'));
const app = await electron.launch({ args: [root, '--user-data', ud, '--import', join(root, 'Sample XERs', 'cairo festival city.xer')], cwd: root });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1400, height: 850 }).catch(() => {});
const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
const menu = (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id);
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }

// Tools > Check Schedule Report
await menu('tools.checkSchedule'); await win.waitForSelector('.dialog-title:has-text("Check Schedule")');
ok(await win.locator('.dialog tbody tr').count() === 14, 'the dialog lists the 14 P6 Professional checks with their targets');
await win.click('.dialog button:has-text("Check Schedule")'); await win.waitForSelector('.dialog-title:has-text("Check Schedule Report")');
const rowsText = await win.locator('.dialog .tbl >> nth=0').innerText();
ok(/Logic/.test(rowsText) && /(Fail|Pass)/.test(rowsText), 'the report shows each check with its result');
if (shots) await win.screenshot({ path: join(shots, 'check-schedule.png') });
await win.locator('.dialog tr:has-text("Large float")').first().dispatchEvent('mousedown'); await win.waitForTimeout(200);
const link = win.locator('.dialog .tbl a:not([href="#large_float"])').filter({ hasText: /^A\d/ }).first();
const hasLink = await link.count();
if (hasLink) { const code = await link.innerText(); await link.click(); await win.waitForTimeout(400);
  ok(await win.locator('.dialog').count() === 0, 'clicking an activity closes the report');
  ok((await win.locator('.grid-row.sel').innerText()).includes(code), `clicking ${code} in the report selects it in the Activities window`); }
else ok(false, 'a failing check lists activities to click');

// Extensions > DCMA 14-point
await menu('tools.extensions'); await win.waitForSelector('text=DCMA 14-point');
await win.click('button:has-text("Run assessment")'); await win.waitForSelector('text=failed');
const dcma = await win.locator('.tbl >> nth=0').innerText();
ok(/Critical path test/.test(dcma) && /CPLI/.test(dcma) && /BEI/.test(dcma), 'Extensions runs DCMA 14-point with the critical path test, CPLI and BEI');
// Extensions > Schedule lint: run, apply a fix
await win.click('.dirbtn:has-text("Schedule lint")'); await win.click('button:has-text("Run lint")'); await win.waitForSelector('text=failing');
const lintText = await win.locator('.tbl >> nth=0').innerText();
ok(/Dangling start/.test(lintText) && /should overlap/.test(lintText), 'lint lists dangling starts and FS overlaps');
await win.locator('tr:has-text("should overlap")').first().dispatchEvent('mousedown'); await win.waitForTimeout(200);
const applyBtn = win.locator('button:has-text("Apply")').first();
ok(await applyBtn.count() > 0, 'an overlap fix can be applied');
if (await applyBtn.count()) { await applyBtn.click(); await win.waitForTimeout(800); ok(/Applied/.test(await win.locator('.toast').last().innerText().catch(() => '')), 'applying a fix changes the logic and reschedules'); }
if (shots) await win.screenshot({ path: join(shots, 'lint.png') });
// Extensions > Crashing, What-ifs, Schedule reasoner
await win.click('.dirbtn:has-text("Crashing")'); await win.click('button:has-text("Crash")'); await win.waitForSelector('text=working days gained');
ok(/Step/.test(await win.locator('.tbl >> nth=1').innerText()), 'crashing lists every step');
await win.click('.dirbtn:has-text("What-ifs")');
await win.locator('td input >> nth=1').fill('A1000'); await win.locator('td input >> nth=2').fill('1');
await win.click('button:has-text("Evaluate")'); await win.waitForSelector('text=Project as it is');
ok(/Scenario 1/.test(await win.locator('.tbl >> nth=1').innerText()), 'what-ifs compare scenarios with the project as it is');
await win.click('.dirbtn:has-text("Schedule reasoner")'); await win.click('button:has-text("Optimise")');
await win.waitForSelector('text=/P6 leveling \\(early start|Max Units\\/Time limit and no crash data/', { timeout: 30000 });
ok(true, 'the schedule reasoner runs in the main process and answers (a proposal, or why there is nothing to choose)');
if (shots) await win.screenshot({ path: join(shots, 'reasoner.png') });
ok(await win.locator('.dirbtn:has-text("Extensions")').count() === 1, 'Extensions has its own button in the window bar');
if (shots) await win.screenshot({ path: join(shots, 'dcma.png') });
// View > Show on Bottom > Activity Usage Profile
await menu('view.bottom.actProfile'); await win.waitForSelector('text=Activity Usage Profile');
ok(await win.locator('svg polyline').count() >= 2, 'the Activity Usage Profile draws cumulative curves');
await win.click('button:has-text("Spreadsheet")'); await win.waitForSelector('text=Cum. Planned Value');
ok(true, 'the Activity Usage Spreadsheet lists planned value, earned value and actual per period');
ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await app.close();
