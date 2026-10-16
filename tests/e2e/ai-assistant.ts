import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => console.log((c ? 'PASS ' : 'FAIL ') + m);
// fake OpenAI-compatible provider
const seen: any[] = [];
const srv = createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    const j = JSON.parse(body); seen.push({ auth: req.headers.authorization, xtest: req.headers['x-test'], j });
    const msgs = j.messages, last = msgs[msgs.length - 1];
    const tools = msgs.filter((m: any) => m.role === 'tool');
    let message: any;
    if (!j.tools) message = { role: 'assistant', content: 'OK' };
    else if (last.role === 'user') message = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'project_summary', arguments: '{}' } }] };
    else if (tools.length === 1) message = { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'find_activities', arguments: '{"text":"water","limit":3}' } }] };
    else { const found = JSON.parse(tools[1].content); message = { role: 'assistant', content: `There are **${found.total_matches}** waterproofing activities. The first is ${found.activities[0].id}:\n- starts ${found.activities[0].start}\n- total float ${found.activities[0].total_float_days} days` }; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
}).listen(0);
const port = (srv.address() as any).port;
// End-to-end check of the AI assistant against a fake OpenAI-compatible server: node tests/e2e/ai-assistant.ts (after node scripts/build.mjs)
const root = join(import.meta.dirname, '..', '..'), ud = mkdtempSync(join(tmpdir(), 'p6ai-'));
const app = await electron.launch({ args: [root, '--user-data', ud, '--import', join(root, 'sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
const menu = (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id);
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
ok(await win.locator('.ai-strip').count() === 0, 'assistant hidden until enabled');
await menu('edit.aiSettings'); await win.waitForSelector('.dialog-title:has-text("AI Assistant Settings")');
await win.locator('.dialog input[type=checkbox]').first().check();
await win.selectOption('.dialog select >> nth=0', 'LM Studio (local)');
await win.fill('.dialog input[placeholder="https://..."]', `http://127.0.0.1:${port}/v1`);
await win.fill('.dialog tr:has-text("Model") input', 'fake-model');
await win.fill('.dialog input[type=password]', 'sk-test-abcdef123456');
await win.fill('.dialog textarea[placeholder^="One per line"]', 'X-Test: hello');
const jsonBox = win.locator('.dialog textarea').nth(1);
await jsonBox.fill('{bad');
ok(await win.locator('.dialog button:has-text("OK")').isDisabled(), 'invalid JSON parameters are flagged and OK is disabled');
await jsonBox.fill('{"temperature": 0.3}');
await win.click('.dialog button:has-text("Test Connection")'); await win.waitForSelector('text=Connected.', { timeout: 10000 });
ok(true, 'Test Connection reaches the provider: ' + (await win.locator('text=Connected.').innerText()));
await win.click('.dialog button:has-text("OK")'); await win.waitForTimeout(400);
const cfgFile = readFileSync(join(ud, 'ai-assistant.json'), 'utf8');
ok(!cfgFile.includes('sk-test-abcdef123456'), 'the key on disk is encrypted, not plain text');
ok(seen[0]?.auth === 'Bearer sk-test-abcdef123456', 'the key is sent to the provider as a Bearer token');
ok(seen[0]?.xtest === 'hello' && seen[0]?.j.temperature === 0.3, 'extra header and JSON parameters reach the provider');
ok(await win.locator('.ai-strip').count() === 1, 'enabled: slim strip on the right');
await win.click('.ai-strip'); await win.waitForSelector('.ai-panel');
await win.fill('.ai-panel textarea', 'Which waterproofing activities are there?'); await win.keyboard.press('Enter');
await win.waitForSelector('.ai-msg.ai', { timeout: 15000 });
const tools = await win.locator('.ai-msg.tool').allInnerTexts(); ok(tools.some((t) => t.includes('project summary')) && tools.some((t) => t.includes('Searched activities')), 'tool lookups shown: ' + tools.join(' / '));
const ans = await win.locator('.ai-msg.ai').innerText(); ok(/waterproofing activities/.test(ans), 'answer shown: ' + ans.replace(/\s+/g, ' ').slice(0, 120));
const link = win.locator('.ai-msg.ai .ai-act').first(); const code = await link.innerText(); await link.click(); await win.waitForTimeout(400);
ok((await win.locator('.grid-row.sel').innerText()).includes(code), `clicking ${code} selects that activity`);

// follow-up question: the earlier conversation is sent along; Clear context forgets it
const before = seen.length;
await win.fill('.ai-panel textarea', 'And which of those is critical?'); await win.keyboard.press('Enter');
await win.waitForFunction(() => document.querySelectorAll('.ai-msg.ai').length >= 2, null, { timeout: 15000 });
const users = (n: number) => seen[n].j.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content);
ok(users(before).length === 2 && users(before)[0].includes('waterproofing'), 'a follow-up carries the earlier question: ' + JSON.stringify(users(before)));
ok((await win.locator('.ai-head').innerText()).includes('remembers 2 questions'), 'the panel shows it remembers 2 questions');
await win.click('.ai-head button:has-text("Clear context")');
ok(await win.locator('.ai-msg').count() === 0, 'Clear context empties the conversation');
const b2 = seen.length;
await win.fill('.ai-panel textarea', 'Fresh question'); await win.keyboard.press('Enter');
await win.waitForSelector('.ai-msg.ai', { timeout: 15000 });
ok(users(b2).length === 1 && users(b2)[0] === 'Fresh question', 'after Clear context only the new question is sent');
await win.keyboard.press('Control+Shift+A'); await win.waitForTimeout(300); ok(await win.locator('.ai-panel').count() === 0 && await win.locator('.ai-strip').count() === 1, 'Ctrl+Shift+A minimizes to the strip');
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await app.close(); srv.close();
