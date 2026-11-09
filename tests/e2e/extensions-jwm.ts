// Scale of the Extensions panels and their Export… on JWM (11,426 activities): seconds from the click to the result, and the longest
// time the window's UI thread was blocked meanwhile (a 20 ms heartbeat in the page; a gap is time the page could not run).
//   node tests/e2e/extensions-jwm.ts   (after node scripts/build.mjs; runs in the background, no window in front)
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = join(import.meta.dirname, '..', '..'), ud = mkdtempSync(join(tmpdir(), 'p6jwm-'));
const jwm = join(root, 'Sample XERs', 'Copy of JWM - Baseline Programme Rev 05A.xer');
for (const f of [join(root, 'dist', 'main.cjs'), join(root, 'dist', 'p6clone-mcp-app.cjs'), jwm]) if (!existsSync(f)) throw new Error(`${f} is missing`);
// an activity to change: the first task with a duration, read from the file
const text = readFileSync(jwm, 'latin1'), at = text.indexOf('%T\tTASK'), head = text.slice(at).split(/\r?\n/);
const cols = head[1].split('\t'), ci = (n: string) => cols.indexOf(n);
let code = '', code2 = '';
for (const l of head.slice(2)) { if (l.startsWith('%T')) break; const c = l.split('\t'); if (c[ci('task_type')] === 'TT_Task' && Number(c[ci('target_drtn_hr_cnt')]) > 80 && !c[ci('act_end_date')]) { if (!code) code = c[ci('task_code')]; else { code2 = c[ci('task_code')]; break; } } }
const app = await electron.launch({ args: [root, '--user-data', ud, '--import', jwm], cwd: root });
await app.evaluate(({ dialog }) => { dialog.showErrorBox = () => {}; process.on('uncaughtException', () => process.exit(1)); });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
const menu = (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id);
const pick = (p: string) => app.evaluate(({ dialog }, p) => { (globalThis as any).__pick = p; dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [(globalThis as any).__pick] })) as never; }, p);
const panel = async (t: string) => { await win.locator('.dirbtn', { has: win.locator('b', { hasText: new RegExp(`^${t}$`) }) }).click(); await win.waitForTimeout(200); };
const rows: string[] = [];
/** Runs `go`, waits for `done` in the page, and reports the seconds and the longest block of the UI thread. */
async function timed(name: string, go: () => Promise<unknown>, done: () => Promise<unknown>) {
  await win.evaluate(() => { const w = window as any; w.__max = 0; w.__t = performance.now(); clearInterval(w.__iv); w.__iv = setInterval(() => { const n = performance.now(); w.__max = Math.max(w.__max, n - w.__t - 20); w.__t = n; }, 20); });
  const t0 = Date.now();
  let status = 'ok';
  let extra = '';
  try { await go(); extra = String(await done() ?? ''); } catch (e) { status = `FAILED: ${(e as Error).message.split('\n')[0].slice(0, 90)}`; await win.screenshot({ path: join(tmpdir(), 'p6jwm-failed.png') }); }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const blocked = await win.evaluate(() => { const w = window as any; clearInterval(w.__iv); return Math.round(w.__max); });
  const line = `${name.padEnd(34)} ${secs.padStart(7)} s   UI blocked ${String(blocked).padStart(6)} ms   ${status} ${extra}`;
  console.log(line); rows.push(line);
}
const toast = (re: RegExp, ms = 900_000) => win.waitForFunction((s) => new RegExp(s).test(document.querySelector('.toast')?.textContent ?? ''), re.source, { timeout: ms });
let n = 0;
/** Export… of the open panel into a fresh folder, to the toast that says it is done (or failed). */
const exp = (name: string) => timed(`Export: ${name}`, async () => { const d = mkdtempSync(join(tmpdir(), `p6jwm-x${++n}-`)); await pick(d); await win.locator('button:has-text("Export…")').click(); }, async () => { await toast(/Exported \d+ files|Export of .* failed|cancelled|already running|changed while/); return (await win.locator('.toast').innerText()).replace(/to C:.*/, '').slice(0, 110); });

await timed('Open JWM (import wizard)', async () => { await win.waitForSelector('button:has-text("View Diagnostics...")', { timeout: 600_000 }); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); }, async () => { await win.waitForSelector('.grid-row', { timeout: 900_000 }); });
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
console.log(`activity used for Evaluate: ${code}`);
await menu('tools.extensions'); await win.waitForSelector('text=DCMA 14-point');

await timed('Risks: Set defaults', async () => { await menu('project.risks'); await win.waitForSelector('.tab:has-text("Estimates")'); await win.click('.tab:has-text("Estimates")'); await win.click('button:has-text("Set defaults")'); }, () => win.waitForSelector('text=/Estimates set for \\d+ activities/', { timeout: 600_000 }));
await menu('tools.extensions');
await panel('Monte Carlo');
await win.locator('label:has-text("Iterations") input').fill('200'); await win.locator('label:has-text("Seed") input').fill('7');
await timed('Monte Carlo (200 iterations)', () => win.click('button:has-text("Run Monte Carlo")'), () => win.waitForSelector('[data-p="P90"]', { timeout: 900_000 }));
await exp('monte_carlo');
await panel('Check schedule');
await timed('Check schedule', () => win.click('button:has-text("Check schedule")'), () => win.waitForSelector('text=/\\d+ failed/', { timeout: 600_000 }));
await exp('check_schedule');
await panel('Review');
await timed('Review', () => win.click('button:has-text("Review schedule")'), () => win.waitForSelector('text=Open activities', { timeout: 600_000 }));
await exp('review');
await panel('Float paths');
await timed('Float paths', () => win.click('button:has-text("Find paths")'), () => win.waitForSelector('text=/Paths end at/', { timeout: 600_000 }));
await exp('float_paths');
await panel('Progress curves');
await timed('Progress curves', () => win.click('button:has-text("Calculate curves")'), () => win.waitForSelector('[data-card="BAC"]', { timeout: 600_000 }));
await exp('progress_curves');
await panel('Resource histogram');
await timed('Resource histogram', () => win.click('button:has-text("Show histogram")'), () => win.waitForSelector('th:has-text("Over-alloc. periods")', { timeout: 600_000 }));
await exp('resource_histogram');
await panel('Level resources');
await timed('Level resources (report)', () => win.click('button:has-text("Level (report)")'), () => win.waitForSelector('[data-card="Activities delayed"]', { timeout: 900_000 }));
await exp('level_resources');
await panel('Evaluate one change');
await win.locator('label:has-text("Activity") input').fill(code); await win.locator('label:has-text("to") input').fill('5');
await timed('Evaluate one change', () => win.click('button:has-text("Evaluate")'), () => win.waitForSelector('[data-card="finish"], div[style*="b00020"]', { timeout: 120_000 }));
await exp('evaluate');
await panel('Compare');
await win.locator('select').first().selectOption({ label: 'a file' }); await pick(jwm);
await timed('Compare: choose file (parse)', () => win.click('button:has-text("Choose file…")'), () => win.waitForSelector('text=Copy of JWM', { timeout: 600_000 }));
await timed('Compare with the file', () => win.click('.btn.primary:has-text("Compare")'), () => win.waitForSelector('text=/\\d+ changes/', { timeout: 900_000 }));
await exp('compare');
await panel('DCMA 14-point');
await timed('DCMA 14-point (existing)', () => win.click('button:has-text("Run assessment")'), () => win.waitForSelector('text=failed', { timeout: 600_000 }));
await exp('dcma_14');
await panel('Schedule lint');
await timed('Lint (existing)', () => win.click('button:has-text("Run lint")'), () => win.waitForSelector('text=failing', { timeout: 600_000 }));
await exp('lint');
await panel('Crashing'); await exp('crash_schedule');
await panel('What-ifs'); await win.locator('td input >> nth=1').fill(code); await win.locator('td input >> nth=2').fill('5'); await exp('evaluate_batch');
await panel('Schedule reasoner'); await exp('optimize_schedule');
await panel('Time impact analysis'); await win.locator('td input >> nth=3').fill(code); await win.locator('td input >> nth=7').fill(code2); await exp('tia');
console.log('\n' + rows.join('\n'));
await app.close();
