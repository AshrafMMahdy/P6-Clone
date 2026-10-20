// The assistant keeps each project's conversation across restarts until Clear context:
//   node tests/e2e/ai-history.ts   (after node scripts/build.mjs)
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
// fake provider: answers "echo: <question>" and remembers how many messages it was sent
let lastCount = 0;
const srv = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  const j = JSON.parse(b), user = j.messages.filter((m: { role: string }) => m.role === 'user');
  lastCount = user.length;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `echo: ${user[user.length - 1]?.content}` }, finish_reason: 'stop' }] }));
}); }).listen(0);
const port = (srv.address() as { port: number }).port;
const root = join(import.meta.dirname, '..', '..'), ud = mkdtempSync(join(tmpdir(), 'p6hist-'));
const A = 'cairo festival city.xer', B = '31 buidings.xer';

async function launch(xer?: string) {
  const app = await electron.launch({ args: [root, '--user-data', ud, ...(xer ? ['--import', join(root, 'Sample XERs', xer)] : [])], cwd: root });
  const win = await app.firstWindow();
  if (xer) {
    await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
    for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
  }
  return { app, win, menu: (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id) };
}
const openPanel = async (win: Awaited<ReturnType<typeof launch>>['win']) => { await win.waitForSelector('.ai-strip'); await win.waitForTimeout(400); if (!(await win.locator('.ai-panel').count())) await win.click('.ai-strip'); await win.waitForSelector('.ai-panel'); await win.waitForTimeout(300); };
const say = async (win: Awaited<ReturnType<typeof launch>>['win'], q: string) => { const n = await win.locator('.ai-msg.ai').count(); await win.fill('.ai-panel textarea', q); await win.keyboard.press('Enter'); await win.waitForFunction((n) => document.querySelectorAll('.ai-msg.ai').length > n, n); };
const texts = (win: Awaited<ReturnType<typeof launch>>['win']) => win.locator('.ai-msg.user, .ai-msg.ai').allInnerTexts();
const openProject = async (win: Awaited<ReturnType<typeof launch>>['win'], id: RegExp) => { await win.click('.dirbtn:has-text("Projects")'); await win.locator('.grid-row', { hasText: id }).first().dblclick(); await win.waitForTimeout(600); };

// 1. project A: turn the assistant on, ask two questions
let { app, win, menu } = await launch(A);
await menu('edit.aiSettings'); await win.waitForSelector('.dialog-title:has-text("AI Assistant Settings")');
await win.locator('.dialog input[type=checkbox]').first().check();
await win.selectOption('.dialog select >> nth=0', 'LM Studio (local)');
await win.fill('.dialog input[placeholder="https://..."]', `http://127.0.0.1:${port}/v1`);
await win.fill('.dialog tr:has-text("Model") input', 'fake-model');
await win.click('.dialog button:has-text("OK")');
await openPanel(win);
await say(win, 'first about A'); await say(win, 'second about A');
const aBefore = await texts(win);
ok(aBefore.length === 4, `project A conversation: ${aBefore.join(' | ')}`);
await app.close();

// 2. restart: A's conversation is back, and the model is sent it again
({ app, win, menu } = await launch());
await openPanel(win);
const aAfter = await texts(win);
ok(JSON.stringify(aAfter) === JSON.stringify(aBefore), 'after a restart the conversation of the open project is shown');
await say(win, 'third about A');
ok(lastCount === 3, `the model gets the earlier questions too (${lastCount} user messages)`);
await app.close();

// 3. import project B: its own (empty) conversation; back on A, A's is there
({ app, win, menu } = await launch(B));
await openPanel(win);
ok((await texts(win)).length === 0, 'a different project starts with its own empty conversation');
await say(win, 'only about B');
await openProject(win, /CFC Modified/);
const aAgain = await texts(win);
ok(aAgain.length === 6 && aAgain[4] === 'third about A', 'switching back to A shows A\'s conversation');
await openProject(win, /e.hussien-1/);
const b = await texts(win);
ok(b.length === 2 && b[0] === 'only about B', 'and B keeps its own');

// 4. Clear context deletes B's log for good; A's stays
await win.click('.ai-head button:has-text("Clear context")');
ok((await texts(win)).length === 0, 'Clear context empties it');
await app.close();
({ app, win, menu } = await launch());
await openPanel(win);
ok((await texts(win)).length === 0, 'cleared stays cleared after a restart');
await openProject(win, /CFC Modified/);
ok((await texts(win)).length === 6, 'other projects\' conversations are untouched');
await app.close();
srv.close();
