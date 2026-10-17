// View > Columns lists the database's activity code and UDF columns (and the remaining-date columns) and shows their values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');

test('activity code, UDF and remaining-date columns', { timeout: 180_000 }, async () => {
  const userData = mkdtempSync(join(tmpdir(), 'p6clone-e2e-cols-'));
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

    await menu('view.columns');
    await win.waitForSelector('.dialog:has-text("Available Options")');
    for (const name of ['Activity Codes: TYPE OF WORK', 'User Defined Fields: (New)', 'Remaining Early Start'])
      await win.locator('.dialog tr', { hasText: name }).dblclick();
    await win.click('.dialog button:has-text("OK")');

    const header = await win.locator('.grid-header').first().innerText();
    for (const h of ['TYPE OF WORK', '(New)', 'Remaining Early Start']) assert.ok(header.includes(h), `header has ${h}`);
    const text = (sel: string) => win.locator(sel).allInnerTexts().then((a) => a.map((s) => s.trim()).filter(Boolean));
    assert.deepEqual(await text('.grid-row:not(.group) [class*="c-udf_"]'), ['$1,000.00']);
    assert.ok((await text('.grid-row:not(.group) [class*="c-code_"]')).length >= 2, 'code values shown');
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
