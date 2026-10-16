// Drives the real Electron app: import an XER through the wizard, schedule (F9), commit, then
// check the saved database and that its XER export passes the validator.
// Run: npm run e2e   (builds first). Screenshots go to E2E_SHOTS dir if set.
import { linesToDb } from '../../core/db-file.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeXer } from '../../core/xer/write.ts';
import { parseXer } from '../../core/xer/parse.ts';
import { validateXer } from '../../core/xer/validate.ts';
import { worst } from '../../core/findings.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SHOTS = process.env.E2E_SHOTS;

test('import, schedule, commit, export round trip in the desktop app', { timeout: 180_000 }, async () => {
  const userData = mkdtempSync(join(tmpdir(), 'p6clone-e2e-'));
  const file = join(ROOT, 'Sample XERs', 'cairo festival city.xer');
  const app = await electron.launch({ args: [ROOT, '--user-data', userData, '--import', file], cwd: ROOT });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('.dialog .wizard-side', { timeout: 30_000 });
    if (SHOTS) await win.screenshot({ path: join(SHOTS, '01-import-wizard.png') });
    assert.match((await win.textContent('.dialog')) ?? '', /P6 would import this file/);
    await win.click('button:has-text("Next >")');
    await win.click('button:has-text("Finish")');
    await win.waitForSelector('.grid-row', { timeout: 30_000 });
    // close the import log if it popped up
    if (await win.locator('.dialog:has-text("Import Log")').count()) await win.click('.dialog button:has-text("Close")');
    const rowsBefore = await win.locator('.grid-row').count();
    assert.ok(rowsBefore > 10, `activity rows shown (${rowsBefore})`);
    if (SHOTS) await win.screenshot({ path: join(SHOTS, '02-activities.png') });

    await win.keyboard.press('F9');
    await win.waitForSelector('.dialog:has-text("Current Data Date")');
    if (SHOTS) await win.screenshot({ path: join(SHOTS, '03-schedule-dialog.png') });
    await win.click('.dialog button:has-text("Schedule")');
    await win.waitForSelector('.toast:has-text("Scheduled")', { timeout: 30_000 });

    // select first activity and show Status tab
    await win.locator('.grid-row:not(.group)').first().click();
    await win.click('.tab:has-text("Status")');
    if (SHOTS) await win.screenshot({ path: join(SHOTS, '04-status-tab.png') });

    await win.keyboard.press('Control+s');
    await win.waitForSelector('.toast:has-text("committed")');
    const dbFile = join(userData, 'p6clone-db.json');
    assert.ok(existsSync(dbFile));
    const saved = linesToDb(readFileSync(dbFile, 'utf8').split('\n')).db;
    assert.ok(saved.tables.TASK.rows.length > 10);
    assert.ok(saved.tables.TASK.rows.every((r: Record<string, string>) => r.early_start_date), 'all activities scheduled');
    const xer = writeXer(saved, { version: '19.12' });
    const back = parseXer(xer);
    const w = worst(validateXer(back.db, back.findings));
    assert.ok(w !== 'fatal' && w !== 'error', `exported XER validates (${w})`);
  } finally {
    await app.close();
  }
});
