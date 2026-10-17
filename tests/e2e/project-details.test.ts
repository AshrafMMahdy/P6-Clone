// Project > Project Details: Notebook (WBSMEMO on the project's root WBS) and Codes (PROJPCAT) tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, type Page } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');

async function withProject(file: string, fn: (win: Page) => Promise<void>) {
  const userData = mkdtempSync(join(tmpdir(), 'p6clone-e2e-projdet-'));
  const app = await electron.launch({ args: [ROOT, '--user-data', userData, '--import', join(ROOT, 'Sample XERs', file)], cwd: ROOT });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    await win.waitForSelector('button:has-text("View Diagnostics...")', { timeout: 30_000 });
    await win.click('button:has-text("Next >")');
    await win.click('button:has-text("Finish")');
    await win.waitForSelector('.grid-row:not(.group)', { timeout: 30_000 });
    if (await win.locator('.dialog:has-text("Import Log")').count()) await win.click('.dialog button:has-text("Close")');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu', 'project.details'));
    await win.waitForSelector('.dialog:has-text("Project Details")');
    await fn(win);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
}

test('project notebook and codes', { timeout: 180_000 }, async () => {
  // CfC: its notebook topic type is for projects and WBS; its memos are on WBS elements, not the project
  await withProject('CfC.xer', async (win) => {
    await win.click('.dialog .tab:has-text("Notebook")');
    await win.waitForSelector('.dialog :text("No notebook topics.")');
    await win.click('.dialog button:has-text("Add")');
    await win.waitForSelector('.dialog td:has-text("WBS Description")');
    assert.equal(await win.locator('.dialog button:has-text("Add")').isDisabled(), true, 'one topic of each type');
    await win.locator('.dialog textarea').fill('Checked by the clone');
    await win.click('.dialog .tab:has-text("General")'); // blur saves
    await win.click('.dialog .tab:has-text("Notebook")');
    assert.equal(await win.locator('.dialog textarea').inputValue(), 'Checked by the clone');
  });
  await withProject('cairo alex-road.xer', async (win) => {
    await win.click('.dialog .tab:has-text("Codes")');
    const row = win.locator('.dialog tr', { hasText: 'Division/Office' });
    assert.equal(await row.locator('select option:checked').innerText(), 'PHX');
    assert.match(await row.innerText(), /Pheonix, AZ Office/);
    await row.locator('select').selectOption({ label: 'SWR' });
    await win.waitForSelector('.dialog tr:has-text("Southwest Region")');
  });
});
