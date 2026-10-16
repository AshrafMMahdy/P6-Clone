// Builds a small schedule by hand in the desktop app and checks the saved database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');

test('create project, add and link activities, edit duration, schedule', { timeout: 180_000 }, async () => {
  const userData = mkdtempSync(join(tmpdir(), 'p6clone-e2e-edit-'));
  const app = await electron.launch({ args: [ROOT, '--user-data', userData], cwd: ROOT });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    const menu = (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id);
    await win.waitForSelector('.dirbar');

    await menu('file.new');
    await win.waitForSelector('.dialog:has-text("Create a New Project")');
    const inputs = win.locator('.dialog input');
    await inputs.nth(0).fill('E2E-1');
    await inputs.nth(1).fill('Hand built');
    await inputs.nth(2).fill('2024-01-08T08:00');
    await win.click('.dialog button:has-text("Finish")');
    await win.waitForSelector('.grid-row.group');

    await win.locator('.grid').first().click();
    await win.keyboard.press('Insert');
    await win.keyboard.press('Insert');
    await win.waitForFunction(() => document.querySelectorAll('.grid-row:not(.group)').length === 2);

    // select A1010, assign A1000 as predecessor
    await win.locator('.grid-row:not(.group)', { hasText: 'A1010' }).click();
    await menu('edit.assignPred');
    await win.waitForSelector('.dialog:has-text("Assign Predecessors")');
    await win.locator('.dialog tr', { hasText: 'A1000' }).click();
    await win.click('.dialog button:has-text("Assign")');

    // edit A1000 original duration to 10 days in the grid
    const row = win.locator('.grid-row:not(.group)', { hasText: 'A1000' });
    await row.locator('.c-orig_dur').dblclick();
    await win.keyboard.press('Control+a');
    await win.keyboard.type('10');
    await win.keyboard.press('Enter');

    await win.keyboard.press('F9');
    await win.waitForSelector('.dialog:has-text("Current Data Date")');
    await win.click('.dialog button:has-text("Schedule")');
    await win.waitForSelector('.toast:has-text("Scheduled")');
    await win.keyboard.press('Control+s');
    await win.waitForSelector('.toast:has-text("committed")');

    const db = JSON.parse(readFileSync(join(userData, 'p6clone-db.json'), 'utf8')).db;
    const t = (c: string) => db.tables.TASK.rows.find((r: Record<string, string>) => r.task_code === c);
    assert.equal(t('A1000').target_drtn_hr_cnt, '80');
    assert.equal(t('A1000').early_start_date, '2024-01-08 08:00');
    assert.equal(t('A1000').early_end_date, '2024-01-19 17:00');
    assert.equal(t('A1010').early_start_date, '2024-01-22 08:00');
    assert.equal(db.tables.TASKPRED.rows.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
});
