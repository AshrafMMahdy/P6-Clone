// Edit menu commands in the desktop app: Link Activities, Fill Down (Ctrl+E), Find Next (F3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { linesToDb } from '../../core/db-file.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');

test('link activities, fill down, find next', { timeout: 180_000 }, async () => {
  const userData = mkdtempSync(join(tmpdir(), 'p6clone-e2e-cmds-'));
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
    await inputs.nth(0).fill('E2E-CMD');
    await inputs.nth(1).fill('Edit commands');
    await inputs.nth(2).fill('2024-01-08T08:00');
    await win.click('.dialog button:has-text("Finish")');
    await win.waitForSelector('.grid-row.group');
    await win.locator('.grid').first().click();
    for (let i = 0; i < 3; i++) await win.keyboard.press('Insert');
    await win.waitForFunction(() => document.querySelectorAll('.grid-row:not(.group)').length === 3);
    const row = (code: string) => win.locator('.grid-row:not(.group)', { hasText: code });

    // Link Activities: A1000 -> A1010 -> A1020 (selection order)
    await row('A1000').click();
    await row('A1020').click({ modifiers: ['Shift'] });
    await menu('edit.link');
    await win.waitForSelector('.toast:has-text("2 relationships (FS) added")');

    // Fill Down: A1000's Original Duration to the other two (current cell = Original Duration)
    await row('A1000').locator('.c-orig_dur').dblclick();
    await win.keyboard.press('Control+a');
    await win.keyboard.type('7');
    await win.keyboard.press('Enter');
    await row('A1000').locator('.c-orig_dur').click();
    await row('A1020').click({ modifiers: ['Shift'] });
    await win.keyboard.press('Control+e');
    await win.waitForSelector('.toast:has-text("filled down to 2 activities")');
    for (const c of ['A1010', 'A1020']) assert.equal((await row(c).locator('.c-orig_dur').innerText()).trim(), '7');

    // Find Next: Edit > Find finds the next match, F3 moves on to the one after
    await menu('edit.find');
    await win.waitForSelector('.dialog:has-text("Find what")');
    await win.locator('.dialog input').first().fill('A10');
    await win.click('.dialog button:has-text("Find Next")');
    await win.click('.dialog button:has-text("Close")');
    const selected = () => win.locator('.grid-row.sel').first().innerText();
    const first = await selected();
    await win.keyboard.press('F3');
    await win.waitForFunction((f) => document.querySelector('.grid-row.sel')?.textContent !== f, first);
    assert.notEqual(await selected(), first);

    // the links drive the schedule: 7 + 7 working days
    await win.keyboard.press('F9');
    await win.waitForSelector('.dialog:has-text("Current Data Date")');
    await win.click('.dialog button:has-text("Schedule")');
    await win.waitForSelector('.toast:has-text("Scheduled")');
    // Predecessors tab: the FS link from A1010 drives A1020 (zero relationship free float)
    await row('A1020').click();
    await win.click('.tab:has-text("Predecessors")');
    const predRow = win.locator('.tbl tr', { hasText: 'A1010' }).first();
    await predRow.waitFor();
    const cells = await predRow.locator('td').allInnerTexts();
    assert.equal(cells[6], 'Yes', `driving cell in ${cells}`);
    assert.equal(cells[7], '0');

    await win.keyboard.press('Control+s');
    await win.waitForSelector('.toast:has-text("committed")');
    const db = linesToDb(readFileSync(join(userData, 'p6clone-db.json'), 'utf8').split('\n')).db;
    assert.equal(db.tables.TASKPRED.rows.length, 2);
    assert.equal(db.tables.TASK.rows.find((r: Record<string, string>) => r.task_code === 'A1020')!.early_start_date, '2024-01-26 08:00');
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
