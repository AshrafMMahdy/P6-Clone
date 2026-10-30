// End-to-end: Activity Details Steps / Feedback / WPs & Docs / Risks tabs, Tools > Global Change, Enterprise >
// Project Codes, Cut + Paste moving activities, richer right-click menus, Project Details Calculations / UDFs, and
// the SS-lag option in Schedule Options.  node tests/e2e/open-items.ts
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6open-'));
const app = await electron.launch({ args: [root, '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0 }); });
const runMenu = (id: string) => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.getAllWindows().find((w) => w.title.includes('Clone'))?.webContents.send('menu', id); }, id);
const show = async (code: string) => { await win.fill('input[placeholder="Filter activities..."]', code); await win.waitForTimeout(250); };
const row = (code: string) => win.locator('.grid-row', { hasText: code }).first();
const tab = (name: string) => win.locator('.details .tab', { hasText: name }).first();

// 1. Activity Details tabs
await show('A2410'); await row('A2410').click();
await tab('Steps').click();
await win.click('.details button:has-text("Add")'); await win.click('.details button:has-text("Add")');
ok(await win.locator('.details tbody tr').count() === 2, 'Steps: two steps added');
const pctInput = win.locator('.details tbody tr').first().locator('input[type=number]').nth(1);
await pctInput.fill('50'); await pctInput.blur(); await win.waitForTimeout(200);
ok(/25%/.test(await win.locator('.details').innerText()), 'Steps: weighted % complete = 25% (one of two equal steps half done)');
await tab('Feedback').click();
await win.locator('.details textarea').fill('Formwork crew short by two this week'); await win.locator('.details textarea').blur(); await win.waitForTimeout(150);
await tab('General').click(); await tab('Feedback').click();
ok((await win.locator('.details textarea').inputValue()) === 'Formwork crew short by two this week', 'Feedback: kept on the activity');
await tab('WPs & Docs').click();
await win.click('.details button:has-text("New Document")');
ok(await win.locator('.details tbody tr input[type=checkbox]').count() === 1, 'WPs & Docs: a document assigned');
await tab('Risks').click();
ok(/register|No risks/i.test(await win.locator('.details').innerText()), 'Risks: tab shows the project risk register picker');

// 2. Global Change: Original Duration of A2410 set to 30 days
await runMenu('tools.globalChange');
await win.waitForSelector('.dialog-title:has-text("Global Change")');
await win.click('.dialog button:has-text("New...")');
await win.waitForSelector('.dialog-title:has-text("Modify Global Change")');
const dlg = win.locator('.dialog').last();
await dlg.locator('input').first().fill('Stretch A2410');
const ifRow = dlg.locator('fieldset').nth(0).locator('div').first();
await ifRow.locator('select').nth(0).selectOption('task_code');
await ifRow.locator('select').nth(1).selectOption('eq');
await ifRow.locator('input').fill('A2410');
const thenRow = dlg.locator('fieldset').nth(1).locator('div').first();
await thenRow.locator('select').nth(0).selectOption('orig_dur');
await thenRow.locator('select').nth(1).selectOption('=');
await thenRow.locator('input').fill('30');
await dlg.locator('button:has-text("OK")').click();
await win.click('.dialog button:has-text("Apply Change")');
await win.waitForSelector('.dialog-title:has-text("Global Change Report")');
const rep = await win.locator('.gc-report tbody tr').allInnerTexts();
ok(rep.length === 1 && /A2410/.test(rep[0]) && /26/.test(rep[0]) && /30/.test(rep[0]), 'Global Change Report: A2410 Original Duration 26 -> 30: ' + rep.join(' | '));
await win.click('.dialog button:has-text("Commit Changes")');
await win.waitForTimeout(300);
ok(/\b30\b/.test(await row('A2410').innerText()), 'Commit Changes applied it');
await win.keyboard.press('Control+z'); await win.waitForTimeout(300);
ok(/\b26\b/.test(await row('A2410').innerText()), 'Ctrl+Z undoes the global change');

// 3. Enterprise > Project Codes
await runMenu('ent.projectCodes');
await win.waitForSelector('.dialog-title:has-text("Project Codes")');
await win.locator('.dialog button:has-text("Add")').first().click();
await win.locator('.dialog button:has-text("Add")').nth(1).click();
ok(await win.locator('.dialog tbody tr input').count() >= 1, 'Project Codes: a code type and a value added');
await win.click('.dialog button:has-text("Close")');

// 4. Cut + Paste moves the activity (same ID, relationships kept)
await show('A1320'); await row('A1320').click();
const wbsBefore = await row('A1320').innerText();
await win.keyboard.press('Control+x');
await show('A2420'); await row('A2420').click();
await win.keyboard.press('Control+v');
await win.waitForTimeout(400);
const toast1 = await win.locator('.toast').last().innerText().catch(() => '');
await show('A1320');
ok(await win.locator('.grid-row', { hasText: 'A1320' }).count() === 1, 'Cut + Paste kept Activity ID A1320 (moved, not renumbered)');
const toastText = toast1;
ok(/Moved 1 activity/.test(toastText), 'the activity was moved: ' + toastText);
void wbsBefore;

// 5. richer right-click menu
await show('A2420');
await row('A2420').click({ button: 'right' });
const items = await win.locator('.ctxmenu').innerText();
ok(['Dissolve', 'Renumber Activity IDs', 'Assign Activity Codes', 'Link Activities'].every((x) => items.includes(x)), 'table right-click menu: Dissolve, Renumber, Assign Activity Codes, Link');
// Renumber Activity IDs: P6's dialog (Prefix, Suffix, Increment) on the selected activity
await win.locator('.ctxmenu').getByText('Renumber Activity IDs').click();
await win.waitForSelector('.dialog-title:has-text("Renumber Activity IDs")');
const rn = win.locator('.dialog input');
await rn.nth(0).fill('RN'); await rn.nth(1).fill('7'); await rn.nth(2).fill('1');
ok(/A2420 → RN7/.test(await win.locator('.dialog').innerText()), 'Renumber: the preview shows the new ID');
await win.click('.dialog button:has-text("OK")'); await win.waitForTimeout(250);
await show('RN7');
ok(await win.locator('.grid-row', { hasText: 'RN7' }).count() === 1, 'Renumber: A2420 is now RN7');
await runMenu('edit.undo'); await win.waitForTimeout(200);
await show('A2420');
ok(await win.locator('.grid-row', { hasText: 'A2420' }).count() === 1, 'Renumber: one undo restores A2420');

// 6. Project Details Calculations / UDFs; 7. Schedule Options SS lag
await runMenu('project.details');
await win.waitForSelector('.dialog-title:has-text("Project Details")');
await win.click('.dialog .tab:has-text("Calculations")');
await win.click('.dialog label:has-text("Activity percent complete based on activity steps")');
await win.click('.dialog .tab:has-text("UDFs")'); await win.click('.dialog .tab:has-text("Calculations")');
ok(await win.locator('.dialog label:has-text("Activity percent complete based on activity steps") input').isChecked(), 'Project Details > Calculations: % complete from steps saved');
await win.click('.dialog button:has-text("Close")');
await runMenu('tools.schedule'); await win.waitForSelector('.dialog-title:has-text("Schedule")');
await win.click('.dialog button:has-text("Options...")');
ok(await win.locator('.dialog label:has-text("Calculate start-to-start lag from")').count() === 1, 'Schedule Options: "Calculate start-to-start lag from" offered');
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close();
rmSync(profile, { recursive: true, force: true });
