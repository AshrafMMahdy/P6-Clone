// End-to-end check of the assistant operating the app (fake provider scripts the steps): node tests/e2e/ai-live.ts
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const steps: any[] = [
  { name: 'ui_menu', args: { path: 'Tools > Schedule...' } },
  { name: 'ui_screen', args: {} },
  { name: 'ui_click', args: { target: 'Schedule' } },
  { name: 'edit_project', args: { operations: [{ op: 'add_activity', id: 'AI-1', name: 'Added by the assistant', duration_days: 3 }] } },
];
const results: any[] = [];
const srv = createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    const j = JSON.parse(body);
    const tools = j.messages.filter((m: any) => m.role === 'tool'); if (tools.length) results.push(JSON.parse(tools[tools.length - 1].content));
    const i = tools.length;
    const message = i < steps.length ? { role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: steps[i].name, arguments: JSON.stringify(steps[i].args) } }] } : { role: 'assistant', content: 'Done: I scheduled the project and added AI-1.' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
}).listen(0);
const port = (srv.address() as any).port;
const root = join(import.meta.dirname, '..', '..');
const app = await electron.launch({ args: [root, '--user-data', mkdtempSync(join(tmpdir(), 'p6live-')), '--import', join(root, 'sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await win.evaluate(async (port) => { await (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake', actions: true }); }, port);
await win.waitForSelector('.ai-strip'); await win.waitForTimeout(400); if (!(await win.locator('.ai-panel').count())) await win.click('.ai-strip');
const t0 = Date.now();
await win.fill('.ai-panel textarea', 'Schedule the project and add an activity'); await win.keyboard.press('Enter');
let sawCursor = false, sawMenu = false, sawDialog = false;
while (Date.now() - t0 < 30000 && !(await win.locator('.ai-msg.ai').count())) {
  sawCursor ||= await win.locator('.ai-cursor.on').count() > 0; sawMenu ||= await win.locator('.ai-menu .ai-menu-col .pick').count() > 0; sawDialog ||= await win.locator('.dialog-title:has-text("Schedule")').count() > 0;
  await win.waitForTimeout(60);
}
ok(sawMenu, 'the menu opened on screen with the chosen item highlighted');
ok(sawDialog, 'Tools > Schedule opened the Schedule dialog');
ok(sawCursor, 'the assistant cursor moved on screen');
ok(results[1]?.dialog?.buttons?.includes('Schedule'), 'ui_screen saw the dialog buttons: ' + JSON.stringify(results[1]?.dialog?.buttons));
ok(results[2]?.clicked === 'Schedule' && !(await win.locator('.dialog-title:has-text("Schedule")').count()), 'ui_click pressed Schedule and the dialog closed');
ok(results[3]?.ok === true && (await win.locator('.grid-row.sel').innerText()).includes('AI-1'), 'edit_project added AI-1 and selected it');
ok((await win.locator('.ai-msg.ai').innerText()).includes('Done'), 'final answer shown');
await win.keyboard.press('Control+Shift+A'); await win.locator('.grid-row').first().click(); await win.keyboard.press('Control+z'); await win.waitForTimeout(300);
ok(!(await win.locator('.grid-row', { hasText: 'AI-1' }).count()), 'Ctrl+Z undoes the assistant change');
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close(); srv.close();
