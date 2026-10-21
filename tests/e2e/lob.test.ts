// Extensions > LOB: a new plan of 2 parts × 3 floors, two trades added, a line's end dragged (its duration changes and
// the toast lists what moved), a split at a floor, undo, the LOB activities in the Activities window, their duration
// guarded there, and a save that keeps the plan in the XER.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');

test('LOB: new plan, trades, drag, split, undo, guarded activities', { timeout: 300_000 }, async () => {
  const userData = mkdtempSync(join(tmpdir(), 'p6clone-e2e-lob-'));
  const exe = process.env.P6CLONE_E2E_EXE, data = ['--user-data', userData, '--import', join(ROOT, 'Sample XERs', 'el ezz warehouse.xer')];
  const app = await electron.launch(exe ? { executablePath: exe, args: data } : { args: [ROOT, ...data], cwd: ROOT });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    const menu = (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id);
    const toast = async () => (await win.locator('.toast').allInnerTexts().catch(() => [])).join(' | ');
    await win.waitForSelector('button:has-text("View Diagnostics...")', { timeout: 30_000 });
    await win.click('button:has-text("Next >")');
    await win.click('button:has-text("Finish")');
    await win.waitForSelector('.grid-row:not(.group)', { timeout: 30_000 });
    if (await win.locator('.dialog:has-text("Import Log")').count()) await win.click('.dialog button:has-text("Close")');

    await menu('tools.extensions');
    await win.locator('.dirbtn', { has: win.locator('b', { hasText: /^LOB$/ }) }).click();
    await win.click('button:has-text("New LOB plan")');
    const form = win.locator('span', { has: win.locator('button:has-text("Create")') }).last();
    await form.locator('input').nth(0).fill('TOWER');
    await form.locator('input').nth(1).fill('2026-03-02');
    await form.locator('input').nth(3).fill('2, 3');
    await win.click('button:has-text("Create")');
    await win.waitForSelector('text=Click a line to edit its task', { timeout: 30_000 });
    // two trades from the Add task form
    const add = win.locator('fieldset', { has: win.locator('legend', { hasText: 'Add task' }) });
    for (const [code, name, cons, qty, crew] of [['CS', 'Concrete skeleton', '9', '60', '18'], ['PW', 'Plaster works', '0.5', '1000', '10']]) {
      const inputs = add.locator('input');
      await inputs.nth(0).fill(code); await inputs.nth(1).fill(name); await inputs.nth(2).fill(cons); await inputs.nth(3).fill(qty); await inputs.nth(4).fill(crew);
      await add.locator('button:has-text("Add")').click();
      await win.waitForSelector(`svg text:text-is("${code}")`, { timeout: 30_000 });
    }
    // drag the plaster line's end to the left: a shorter duration, so the crew grows (the crew driver follows), listed in the toast
    const line = win.locator('svg g', { has: win.locator('text:text-is("PW")') }).first();
    await line.locator('polyline').first().waitFor();
    const pts = (await line.locator('polyline').nth(1).getAttribute('points'))!.trim().split(' ').map((p) => p.split(',').map(Number));
    const chart = win.locator('svg', { has: win.locator('text:text-is("PW")') }).first();
    const svgBox = (await chart.boundingBox())!;
    const vb = (await chart.getAttribute('viewBox'))!.split(' ').map(Number);
    const sx = svgBox.width / vb[2], sy = svgBox.height / vb[3];
    const [ex, ey] = pts.at(-1)!;
    await win.mouse.move(svgBox.x + ex * sx, svgBox.y + ey * sy);
    await win.mouse.down();
    await win.mouse.move(svgBox.x + (ex - 200) * sx, svgBox.y + ey * sy, { steps: 5 });
    await win.mouse.up();
    await win.waitForFunction(() => /PW .*duration/.test(document.body.innerText), undefined, { timeout: 15_000 });
    assert.match(await toast(), /PW .*duration/);
    // split plaster at part 2, floor 1 from the task panel
    await win.locator('fieldset', { has: win.locator('legend', { hasText: 'Locations' }) }).locator('tr', { hasText: 'Floor 1' }).nth(1).locator('button:has-text("split")').click();
    await win.waitForSelector('text=/segment 1 of 2/', { timeout: 15_000 });
    // undo takes the split back
    await menu('edit.undo');
    await win.waitForSelector('text=/segment 1 of 1/', { timeout: 15_000 });

    // the plan's activities are ordinary activities; their duration is guarded
    await menu('project.activities');
    // the grid draws the rows in view: scroll down to the LOB project's (after the warehouse project's)
    await win.waitForSelector('.grid-scroll', { timeout: 30_000 });
    for (let k = 0; k < 40 && !(await win.locator('.grid-row:has-text("PW-P1F1")').count()); k++) await win.evaluate(() => { const g = document.querySelector('.grid-scroll')!; g.scrollTop += g.clientHeight * 0.8; });
    await win.waitForSelector('.grid-row:has-text("PW-P1F1")', { timeout: 10_000 });
    const cell = win.locator('.grid-row:has-text("PW-P1F1") .c-orig_dur');
    await cell.dblclick();
    await win.keyboard.type('2');
    await win.keyboard.press('Enter');
    await win.waitForFunction(() => /set by the LOB plan/.test(document.body.innerText), undefined, { timeout: 15_000 });
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    try { rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* the temp cleaner */ }
  }
});
