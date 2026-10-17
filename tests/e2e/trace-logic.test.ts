// View > Show on Bottom > Trace Logic: boxes for the selected activity's predecessors and successors, driving links solid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');

test('trace logic pane', { timeout: 180_000 }, async () => {
  const userData = mkdtempSync(join(tmpdir(), 'p6clone-e2e-trace-'));
  const app = await electron.launch({ args: [ROOT, '--user-data', userData, '--import', join(ROOT, 'Sample XERs', 'el ezz warehouse.xer')], cwd: ROOT });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    const menu = (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id);
    await win.waitForSelector('button:has-text("View Diagnostics...")', { timeout: 30_000 });
    await win.click('button:has-text("Next >")');
    await win.click('button:has-text("Finish")');
    await win.waitForSelector('.grid-row:not(.group)', { timeout: 30_000 });
    if (await win.locator('.dialog:has-text("Import Log")').count()) await win.click('.dialog button:has-text("Close")');

    await menu('view.bottom.trace');
    await win.waitForSelector('.trace-logic:has-text("Select an activity")');
    // pick an activity with both predecessors and successors
    const rows = win.locator('.grid-row:not(.group)');
    let code = '';
    for (let i = 0; i < Math.min(40, await rows.count()); i++) {
      await rows.nth(i).click();
      await win.waitForSelector('.trace-box.sel');
      const boxes = await win.locator('.trace-box').count();
      if (boxes >= 3 && await win.locator('.trace-link').count() >= 2) { code = (await win.locator('.trace-box.sel').getAttribute('data-code'))!; break; }
    }
    assert.ok(code, 'found an activity with logic on both sides');
    assert.ok(await win.locator('.trace-link.driving').count() >= 1, 'a driving link is drawn');

    // driving relationships only: every drawn link is driving
    await win.locator('.trace-logic label:has-text("Driving relationships only") input').check();
    assert.equal(await win.locator('.trace-link:not(.driving)').count(), 0);
    await win.locator('.trace-logic label:has-text("Driving relationships only") input').uncheck();

    // more levels never show fewer boxes; clicking a box re-centres the trace on it
    const before = await win.locator('.trace-box').count();
    await win.locator('.trace-logic label:has-text("Successor levels") select').selectOption('5');
    assert.ok(await win.locator('.trace-box').count() >= before);
    const other = win.locator('.trace-box:not(.sel)').first();
    const otherCode = await other.getAttribute('data-code');
    await other.click();
    await win.waitForSelector(`.trace-box.sel[data-code="${otherCode}"]`);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
