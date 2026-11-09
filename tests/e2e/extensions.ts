// The Extensions panels for the analysis tools (Monte Carlo, Check schedule, Review, Float paths, Progress curves, Resource histogram,
// Level resources, Evaluate one change, Compare) and Export… on every analysis panel and the Risks window: the real tool writes
// <tool>.json and <tool>-<table>.csv into a folder (the folder dialog is replaced from here).
//   node tests/e2e/extensions.ts [screenshot dir]   (after node scripts/build.mjs)
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const shots = process.argv[2];
const root = join(import.meta.dirname, '..', '..'), ud = mkdtempSync(join(tmpdir(), 'p6ext-'));
const sample = join(root, 'Sample XERs', 'cairo festival city.xer');
for (const f of [join(root, 'dist', 'main.cjs'), join(root, 'dist', 'p6clone-mcp-app.cjs'), sample]) if (!existsSync(f)) throw new Error(`${f} is missing: node scripts/build.mjs first`);
let app = await electron.launch({ args: [root, '--user-data', ud, '--import', sample], cwd: root });
// the harness never takes the front of the screen and never shows a modal error box
await app.evaluate(({ dialog }) => { dialog.showErrorBox = () => {}; process.on('uncaughtException', () => process.exit(1)); });
let win = await app.firstWindow();
await win.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
const menu = (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id);
/** The folder (or file) the next open dialog answers with. */
const pickPath = (p: string) => app.evaluate(({ dialog }, p) => { const g = globalThis as any; g.__pick = p; g.__dialogs ??= 0; dialog.showOpenDialog = (async () => { g.__dialogs++; return { canceled: false, filePaths: [g.__pick] }; }) as never; }, p);
const dialogs = () => app.evaluate(() => (globalThis as any).__dialogs as number);
const exportDirs = () => readdirSync(tmpdir()).filter((f) => f.startsWith('p6export-'));
const shot = async (name: string) => { if (shots) await win.screenshot({ path: join(shots, name) }); };
const panel = async (title: string) => { await win.locator('.dirbtn', { has: win.locator('b', { hasText: new RegExp(`^${title}$`) }) }).click(); await win.waitForTimeout(150); };
const toastText = async () => (await win.locator('.toast').allInnerTexts().catch(() => [])).join(' | ');

/** Export… of the open panel into a fresh folder: the tool's files are there (or the tool's own message is shown). */
async function exportFiles(tool: string, what: string, expectFiles: string[] = []): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `p6ext-${tool}-`));
  await pickPath(dir);
  await shot(`export-${what.replace(/[^A-Za-z0-9]+/g, '-')}.png`);
  await win.locator('button:has-text("Export…")').click();
  await win.waitForFunction(([t, d]) => { const x = document.querySelector('.toast')?.textContent ?? ''; return x.includes(d) || new RegExp(`Export of ${t} failed`).test(x); }, [tool, dir], { timeout: 240_000 });
  const files = readdirSync(dir);
  ok(files.includes(`${tool}.json`), `${what}: Export… wrote ${tool}.json (${files.join(', ') || 'no files'}; toast: ${await toastText()})`);
  ok(files.some((f) => f.startsWith(`${tool}-`) && f.endsWith('.csv')), `${what}: Export… wrote ${tool}-<table>.csv files`);
  for (const f of expectFiles) ok(files.includes(f), `${what}: ${f} was written`);
  const csv = files.find((f) => f.endsWith('.csv'));
  if (csv) ok(readFileSync(join(dir, csv)).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${what}: the CSV starts with a BOM, as the tool writes it`);
  return dir;
}
/** Export… that the tool refuses: its own message is on the screen. */
async function exportRefused(tool: string, what: string, message: RegExp) {
  const dir = mkdtempSync(join(tmpdir(), `p6ext-${tool}-`));
  await pickPath(dir);
  await win.locator('button:has-text("Export…")').click();
  await win.waitForFunction((t) => new RegExp(`Export of ${t} failed`).test(document.querySelector('.toast')?.textContent ?? ''), tool, { timeout: 120_000 });
  const t = await toastText();
  ok(message.test(t), `${what}: the tool's own message is shown (${t})`);
  ok(!readdirSync(dir).some((f) => f.startsWith(`${tool}.json`)), `${what}: nothing was written`);
}

await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }

// ---- Risks window: estimates, a seeded run, Export…
await menu('project.risks'); await win.waitForSelector('.tab:has-text("Estimates")');
await win.click('.tab:has-text("Estimates")'); await win.click('button:has-text("Set defaults")'); await win.waitForSelector('text=/Estimates set for \\d+ activities/');
await win.click('.tab:has-text("Analysis")');
await win.locator('label:has-text("Iterations") input').fill('300'); await win.locator('label:has-text("Seed") input').fill('42');
await win.click('button:has-text("Run Risk Analysis")'); await win.waitForSelector('text=/Last run: 300 iterations, seed 42/', { timeout: 120_000 });
const riskDir = await exportFiles('monte_carlo', 'Risks window', ['monte_carlo-iterations.csv', 'monte_carlo-histogram.csv', 'monte_carlo-percentiles.csv', 'monte_carlo-criticality.csv', 'monte_carlo-sensitivity.csv']);
const exported = Object.fromEntries(readFileSync(join(riskDir, 'monte_carlo-percentiles.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')).map((c) => [c[0], c[1]]));
if (shots) await win.screenshot({ path: join(shots, 'risks-export-toast.png') });

// ---- Extensions > Monte Carlo
await menu('tools.extensions'); await win.waitForSelector('text=DCMA 14-point');
await panel('Monte Carlo');
await win.locator('label:has-text("Iterations") input').fill('300'); await win.locator('label:has-text("Seed") input').fill('42');
await win.click('button:has-text("Run Monte Carlo")'); await win.waitForSelector('[data-p="P90"]', { timeout: 120_000 });
const cards = await win.locator('[data-p]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-p'), e.getAttribute('data-iso')])));
ok(['P10', 'P50', 'P80', 'P90'].every((k) => !!cards[k]), `Monte Carlo: P10, P50, P80 and P90 cards (${JSON.stringify(cards)})`);
ok(await win.locator('canvas').count() >= 1 && /Criticality Index/.test(await win.locator('.winbody').last().innerText()) && /Duration Sensitivity/.test(await win.locator('.winbody').last().innerText()), 'Monte Carlo: the finish histogram with its curve, the criticality table and the tornado are shown');
ok(['P10', 'P50', 'P80', 'P90'].every((k) => cards[k] === exported[k]), `Monte Carlo: the exported P-values equal the cards for the same seed (${['P10', 'P50', 'P80', 'P90'].map((k) => `${k} ${exported[k]}`).join(', ')})`);
await shot('monte-carlo.png');
const mcDir = await exportFiles('monte_carlo', 'Monte Carlo panel');
const mcExp = Object.fromEntries(readFileSync(join(mcDir, 'monte_carlo-percentiles.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')).map((c) => [c[0], c[1]]));
ok(['P10', 'P50', 'P80', 'P90'].every((k) => cards[k] === mcExp[k]), 'Monte Carlo panel: its own Export… equals its cards');
// a run with a blank (random) seed: Export… passes the result's seed, so the export equals the cards
await win.locator('label:has-text("Seed") input').fill('');
await win.click('button:has-text("Run Monte Carlo")'); await win.waitForSelector('text=/seed \\d+/', { timeout: 120_000 });
await win.waitForFunction(() => !document.querySelector('progress'));
const cards2 = await win.locator('[data-p]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-p'), e.getAttribute('data-iso')])));
const mcDir2 = await exportFiles('monte_carlo', 'Monte Carlo panel (blank seed)');
const mcExp2 = Object.fromEntries(readFileSync(join(mcDir2, 'monte_carlo-percentiles.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')).map((c) => [c[0], c[1]]));
ok(['P10', 'P50', 'P80', 'P90'].every((k) => cards2[k] === mcExp2[k]), `Monte Carlo panel: with a blank seed box the export equals the cards (${JSON.stringify(cards2)})`);
// one export at a time, cancel, and nothing left behind
await win.locator('label:has-text("Iterations") input').fill('20000');
const d0 = await dialogs();
await win.locator('button:has-text("Export…")').click();
await win.waitForSelector('button:has-text("Cancel export")', { timeout: 60_000 });
await win.waitForFunction(() => true); await win.waitForTimeout(1500);
ok(exportDirs().length === 1, `Export: a private temporary folder exists while it runs (${exportDirs().join(', ')})`);
await panel('Review');
ok(await win.locator('button:has-text("Export…")').count() === 1, 'Export: other panels still offer Export…');
await win.locator('button:has-text("Export…")').click();
await win.waitForFunction(() => /already running/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 20_000 });
ok(/monte_carlo/.test(await toastText()) && (await dialogs()) === d0 + 1, `Export: a second export is refused naming the running tool, with no dialog (${await toastText()})`);
await panel('Monte Carlo');
ok(await win.locator('button:has-text("Cancel export")').count() === 1, 'Export: the panel switched away from and back still shows the running export');
await win.locator('button:has-text("Cancel export")').click();
await win.waitForFunction(() => /cancelled/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 30_000 });
ok(/Nothing was written|Already written/.test(await toastText()), `Export: cancelling says what was written (${await toastText()})`);
ok(exportDirs().length === 0 && await win.locator('button:has-text("Export…")').count() === 1, 'Export: after the cancel the temporary folder is gone and the button is back');
// a number that is not one is refused, before running and before exporting
await panel('Float paths');
await win.locator('label:has-text("Paths") input').fill('abc');
await win.click('button:has-text("Find paths")');
await win.waitForFunction(() => /must be a number/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 10_000 });
ok(/The number of paths must be a number/.test(await toastText()), 'Float paths: text that is not a number is refused before running');
const d1 = await dialogs();
await win.locator('button:has-text("Export…")').click(); await win.waitForTimeout(800);
ok((await dialogs()) === d1 && /must be a number/.test(await toastText()), 'Float paths: and before exporting (no dialog)');
await win.locator('label:has-text("Paths") input').fill('10');

// ---- the other new panels
await panel('Check schedule'); await win.click('button:has-text("Check schedule")'); await win.waitForSelector('text=/\\d+ failed/');
ok(/Logic/.test(await win.locator('.tbl >> nth=1').innerText()), 'Check schedule: runs and lists the checks'); await shot('check-schedule.png');
await exportFiles('check_schedule', 'Check schedule', ['check_schedule-checks.csv']);
await panel('Review'); await win.click('button:has-text("Review schedule")'); await win.waitForSelector('text=Open activities');
ok(/Missing logic/.test(await win.locator('.tbl').first().innerText()), 'Review: runs and lists the checks'); await shot('review.png');
await exportFiles('review', 'Review', ['review-checks.csv', 'review-activities.csv']);
await panel('Float paths'); await win.click('button:has-text("Find paths")'); await win.waitForSelector('text=/Paths end at/');
ok(await win.locator('.tbl >> nth=0 >> tbody tr').count() >= 1, 'Float paths: runs and lists the paths'); await shot('float-paths.png');
await exportFiles('float_paths', 'Float paths', ['float_paths-paths.csv', 'float_paths-near_critical.csv']);
await panel('Progress curves'); await win.click('button:has-text("Calculate curves")'); await win.waitForSelector('[data-card="BAC"]');
ok(await win.locator('svg polyline').count() >= 3, 'Progress curves: runs, the cards and the S-curves are shown'); await shot('progress-curves.png');
await exportFiles('progress_curves', 'Progress curves', ['progress_curves-periods.csv', 'progress_curves-totals.csv']);
await panel('Resource histogram'); await win.click('button:has-text("Show histogram")'); await win.waitForSelector('th:has-text("Over-alloc. periods")');
ok(await win.locator('tbody tr').count() >= 1, 'Resource histogram: runs and lists the resources'); await shot('resource-histogram.png');
await exportFiles('resource_histogram', 'Resource histogram', ['resource_histogram-resources.csv', 'resource_histogram-periods.csv']);
await panel('Level resources'); await win.click('button:has-text("Level (report)")'); await win.waitForSelector('[data-card="Activities delayed"]');
ok(true, 'Level resources: runs on a copy and reports'); await shot('level-resources.png');
const lvDir = await exportFiles('level_resources', 'Level resources', ['level_resources-moved.csv', 'level_resources-peaks.csv']);
ok(JSON.parse(readFileSync(join(lvDir, 'level_resources.json'), 'utf8')).dry_run === true, 'Level resources: Export… ran the tool as a dry run (the project is not changed)');
await panel('Evaluate one change');
await win.locator('label:has-text("Activity") input').fill('A1020'); await win.locator('label:has-text("to") input').fill('20');
await win.click('button:has-text("Evaluate")'); await win.waitForSelector('[data-card="finish"]');
ok(/\d{4}-\d\d-\d\d/.test(await win.locator('[data-card="finish"]').innerText()), 'Evaluate one change: shows the finish with the change'); await shot('evaluate.png');
await exportFiles('evaluate', 'Evaluate one change', ['evaluate-changed.csv', 'evaluate-critical_changes.csv']);

// ---- Export… on the existing panels
await panel('DCMA 14-point'); await win.click('button:has-text("Run assessment")'); await win.waitForSelector('text=failed');
await exportFiles('dcma_14', 'DCMA 14-point', ['dcma_14-checks.csv', 'dcma_14-failing_activities.csv']);
await panel('Schedule lint'); await win.click('button:has-text("Run lint")'); await win.waitForSelector('text=failing');
await exportFiles('lint', 'Schedule lint', ['lint-checks.csv', 'lint-findings.csv', 'lint-fixes.csv']);
// Crashing, What-ifs and Time impact analysis call the engine as their tools do: the screen is what the Export writes
const exportedJson = (dir: string, tool: string) => JSON.parse(readFileSync(join(dir, `${tool}.json`), 'utf8'));
await panel('Crashing'); await win.click('button:has-text("Crash")'); await win.waitForSelector('text=working days gained');
const crashLine = await win.locator('text=working days gained').innerText();
const crash = exportedJson(await exportFiles('crash_schedule', 'Crashing', ['crash_schedule-steps.csv']), 'crash_schedule');
ok(crashLine.includes(`${crash.days_gained} working days gained`) && crashLine.includes(`→ ${crash.finish.slice(0, 10)}`) && await win.locator('.tbl >> nth=1 >> tbody tr').count() === crash.steps.length, `Crashing: the screen is the Export (${crashLine}; exported ${crash.days_gained} days, finish ${crash.finish}, ${crash.steps.length} steps)`);
await panel('What-ifs'); await win.locator('td input >> nth=1').fill('A1020'); await win.locator('td input >> nth=2').fill('20');
await win.click('button:has-text("Evaluate")'); await win.waitForSelector('text=Project as it is');
const whatIfRow = (await win.locator('.tbl >> nth=1 >> tbody tr').first().locator('td').allInnerTexts());
const batch = exportedJson(await exportFiles('evaluate_batch', 'What-ifs', ['evaluate_batch-scenarios.csv', 'evaluate_batch-dates_moved.csv']), 'evaluate_batch');
ok(whatIfRow[1] === batch.scenarios[0].finish.slice(0, 10) && whatIfRow[2] === String(batch.scenarios[0].finish_delta_days) && whatIfRow[3] === String(batch.scenarios[0].critical), `What-ifs: the screen is the Export (${whatIfRow.join(' | ')}; exported finish ${batch.scenarios[0].finish}, ${batch.scenarios[0].finish_delta_days} days, ${batch.scenarios[0].critical} critical)`);
await panel('Schedule reasoner');
await exportFiles('optimize_schedule', 'Schedule reasoner', ['optimize_schedule-activities.csv', 'optimize_schedule-priority.csv']);
await panel('Time impact analysis');
await win.locator('td input >> nth=3').fill('A2060'); await win.locator('td input >> nth=7').fill('A2070');
await win.click('button:has-text("Analyse")'); await win.waitForSelector('text=Impacted finish');
const tiaScreen = await win.locator('.tbl >> nth=2').innerText();
const tia = exportedJson(await exportFiles('tia', 'Time impact analysis', ['tia-summary.csv', 'tia-fragnet_path.csv']), 'tia');
ok(tiaScreen.includes(`${tia.delay_days} working days`) && tiaScreen.includes(tia.impacted_finish.slice(0, 16)) && tiaScreen.includes(tia.unimpacted_finish.slice(0, 16)), `Time impact analysis: the screen is the Export (exported ${tia.delay_days} days, ${tia.unimpacted_finish} → ${tia.impacted_finish})`);
await win.click('button:has-text("Keep impacted copy")'); await win.waitForFunction(() => /kept as project/.test(document.querySelector('.toast')?.textContent ?? ''), undefined, { timeout: 30_000 });
await panel('Windows analysis'); await win.locator('label:has-text("-TIA") input').check();
await win.click('button:has-text("Analyse")'); await win.waitForSelector('text=Total slip');
const slip = /Total slip (\d+)/.exec(await win.locator('text=Total slip').innerText())?.[1];
const wDir = await exportFiles('windows_analysis', 'Windows analysis', ['windows_analysis-windows.csv', 'windows_analysis-driving_path.csv']);
ok(JSON.parse(readFileSync(join(wDir, 'windows_analysis.json'), 'utf8')).total_slip_days === Number(slip) && slip === '10', `Windows analysis: the exported slip equals the screen's (${slip} working days)`);

// ---- Compare: another project (the TIA copy), a file, a baseline
await panel('Compare');
await win.locator('select').nth(1).selectOption(await win.locator('select').nth(1).locator('option', { hasText: '-TIA' }).getAttribute('value') as string);
await win.click('.btn.primary:has-text("Compare")');
await win.waitForSelector('text=/\\d+ changes/');
ok(/against .*TIA/.test(await win.locator('.winbody').last().innerText()), 'Compare: the project against its TIA copy lists what changed'); await shot('compare.png');
await exportFiles('compare', 'Compare (another project)', ['compare-changes.csv', 'compare-only_in_one.csv']);
await win.locator('select').first().selectOption({ label: 'a file' }); await pickPath(sample);
await win.click('button:has-text("Choose file…")'); await win.waitForSelector('text=cairo festival city.xer');
await win.click('.btn.primary:has-text("Compare")'); await win.waitForSelector('text=/against cairo festival city.xer/');
await exportFiles('compare', 'Compare (a file)', ['compare-changes.csv']);
await win.locator('select').first().selectOption({ label: 'a baseline' });
await win.click('.btn.primary:has-text("Compare")'); await win.waitForSelector('text=/has no project baseline/');
await exportRefused('compare', 'Compare (a baseline)', /baseline/i);

// ---- LOB: a plan in the warehouse sample (as tests/e2e/lob.test.ts), then its Export…
await app.close();
app = await electron.launch({ args: [root, '--user-data', mkdtempSync(join(tmpdir(), 'p6ext-lob-')), '--import', join(root, 'Sample XERs', 'el ezz warehouse.xer')], cwd: root });
await app.evaluate(({ dialog }) => { dialog.showErrorBox = () => {}; process.on('uncaughtException', () => process.exit(1)); });
win = await app.firstWindow(); win.on('pageerror', (e) => errors.push(e.message));
await win.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row:not(.group)');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await menu('tools.extensions'); await win.waitForSelector('text=DCMA 14-point');
await panel('LOB'); await win.click('button:has-text("New LOB plan")');
const form = win.locator('span', { has: win.locator('button:has-text("Create")') }).last();
await form.locator('input').nth(0).fill('TOWER'); await form.locator('input').nth(1).fill('2026-03-02'); await form.locator('input').nth(3).fill('2, 3');
await win.click('button:has-text("Create")'); await win.waitForSelector('text=Click a line to edit its task', { timeout: 30_000 });
const add = win.locator('fieldset', { has: win.locator('legend', { hasText: 'Add task' }) });
const inputs = add.locator('input');
await inputs.nth(0).fill('CS'); await inputs.nth(1).fill('Concrete skeleton'); await inputs.nth(2).fill('9'); await inputs.nth(3).fill('60'); await inputs.nth(4).fill('18');
await add.locator('button:has-text("Add")').click(); await win.waitForSelector('svg text:text-is("CS")', { timeout: 30_000 });
await exportFiles('lob_view', 'LOB', ['lob_view-trades.csv', 'lob_view-locations.csv']);
await panel('4D');
ok(await win.locator('button:has-text("Export…")').count() === 0, '4D: no Export… button (no 4D tool has export)');
ok(exportDirs().length === 0, 'no temporary export folder is left behind');
ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await app.close();
