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
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }

// 8. Admin > Financial Periods (Batch Create) and Tools > Store Period Performance
await runMenu('admin.finPeriods'); await win.waitForSelector('.dialog-title:has-text("Financial Periods")');
const dates = win.locator('.dialog input[type=date]');
await dates.nth(2).fill('2010-01-01'); await dates.nth(3).fill('2010-12-31');
await win.click('.dialog button:has-text("Create")'); await win.waitForTimeout(250);
ok(await win.locator('.dialog tbody tr', { hasText: '2010-06-01' }).count() === 1 && await win.locator('.dialog tbody tr').count() === 12, 'Financial Periods: Batch Create made 12 monthly periods');
await win.click('.dialog button:has-text("Close")');
// a month of progress (Update Progress to 2010-08-01), so July has work to store
await runMenu('tools.progress'); await win.waitForSelector('.dialog-title:has-text("Update Progress")');
await win.fill('.dialog input[type=datetime-local]', '2010-08-01T00:00'); await win.click('.dialog button:has-text("Apply")'); await win.waitForTimeout(400);
for (let i = 0; i < 3 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await runMenu('tools.storePeriod'); await win.waitForSelector('.dialog-title:has-text("Store Period Performance")');
ok(/2010-07-01/.test(await win.locator('.dialog select').first().inputValue()), 'Store Period Performance: the period before the data date is chosen');
await win.click('.dialog button:has-text("Store Now")'); await win.waitForTimeout(300);
const stTxt = await win.locator('.toast').last().innerText().catch(() => '');
ok(/[1-9][0-9]* activities stored in 2010-07-01/.test(stTxt), 'Store Period Performance: stored: ' + stTxt);
await runMenu('admin.finPeriods'); await win.waitForSelector('.dialog-title:has-text("Financial Periods")');
ok(Number((await win.locator('.dialog tbody tr', { hasText: '2010-07-01' }).locator('td').nth(3).innerText()) || 0) > 0, 'Financial Periods: the July period holds stored activities');
await win.click('.dialog button:has-text("Close")');

// 9. Financial period calendars, the Financial Period Value columns, past-period values on the Resources tab, Assign Roles
await runMenu('admin.finPeriods'); await win.waitForSelector('.dialog-title:has-text("Financial Periods")');
await win.fill('.dialog input[placeholder="Calendar name"]', 'Monthly'); await win.click('.dialog .row button:has-text("Add")'); await win.waitForTimeout(200);
ok(await win.locator('.dialog tbody tr').count() === 12, 'Financial period calendars: the first calendar keeps the 12 periods');
await win.fill('.dialog input[placeholder="Calendar name"]', 'Weekly'); await win.click('.dialog .row button:has-text("Add")'); await win.waitForTimeout(200);
ok(/No financial periods/.test(await win.locator('.dialog tbody').innerText()), 'Financial period calendars: a new calendar starts empty');
await win.click('.dialog button:has-text("Close")');
await runMenu('project.details'); await win.waitForSelector('.dialog-title:has-text("Project Details")');
await win.click('.dialog .tab:has-text("Settings")');
ok(/Weekly/.test(await win.locator('.dialog select').last().innerText()), 'Project Details > Settings: the financial period calendar is offered');
await win.click('.dialog button:has-text("Close")');
await runMenu('admin.preferences'); await win.waitForSelector('.dialog-title:has-text("User Preferences")');
const pd = win.locator('.dialog input[type=date]'); await pd.nth(0).fill('2010-07-01'); await pd.nth(1).fill('2010-07-31');
await win.click('.dialog button:has-text("OK")');
await runMenu('view.columns'); await win.waitForSelector('.dialog-title:has-text("Columns")');
await win.locator('.dialog tr', { hasText: '(Monthly 2010-07-01): Actual Expense Cost' }).dblclick();
await win.click('.dialog button:has-text("OK")'); await win.waitForTimeout(200);
await show('');
const started = win.locator('.grid-row:not(.group)').filter({ has: win.locator('.c-start', { hasText: / A$/ }) }).first();
const finCell = started.locator('[class*="_expense_cost"]');
ok(await finCell.count() === 1, 'Financial Period Value column shown in the activity table');
await finCell.dblclick(); await win.keyboard.press('Control+a'); await win.keyboard.type('321'); await win.keyboard.press('Enter'); await win.waitForTimeout(250);
ok(/321/.test(await finCell.innerText()), 'Financial Period Value: a past-period expense cost edited in its cell: ' + await finCell.innerText());
await runMenu('edit.undo'); await win.waitForTimeout(200);
ok(!/321/.test(await finCell.innerText()), 'Financial Period Value: one undo takes the edit back');
// Assign Roles: a role made in Enterprise > Roles, assigned from the table's right-click menu
await runMenu('ent.roles'); await win.waitForSelector('.dialog-title:has-text("Roles")');
await win.click('.dialog button:has-text("Add Root")'); await win.waitForTimeout(150);
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await started.click(); await started.click({ button: 'right' });
await win.locator('.ctxmenu').getByText('Assign Roles...').click();
await win.waitForSelector('.dialog-title:has-text("Assign Roles")');
await win.locator('.dialog tr', { hasText: 'ROLE1' }).click(); await win.click('.dialog button:has-text("Assign")'); await win.waitForTimeout(200);
await tab('Resources').click();
ok(await win.locator('.details tbody tr', { hasText: 'ROLE1' }).count() === 1, 'Assign Roles: a role assignment (no resource) on the activity');
// a past period's Actual Units of that assignment, on Activity Details > Resources
await win.locator('.details span:has-text("Past period") select').selectOption({ label: '2010-07-01' }); await win.waitForTimeout(150);
const roleRow = () => win.locator('.details tbody tr', { hasText: 'ROLE1' });
const unitsIn = roleRow().locator('input[type=number]').nth(3);
await unitsIn.fill('7'); await unitsIn.blur(); await win.waitForTimeout(250);
ok(await roleRow().locator('input[type=number]').nth(3).inputValue() === '7', 'Resources tab: the Actual Units of a past period edited on the assignment');
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close();
rmSync(profile, { recursive: true, force: true });
