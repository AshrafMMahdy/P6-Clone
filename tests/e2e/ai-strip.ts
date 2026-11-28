// The assistant's strip and panel: node tests/e2e/ai-strip.ts [screenshot dir] (after node scripts/build.mjs)
// - a glowing strip stays on the right; the panel opens beside it and the window makes room (nothing is covered)
// - the panel opens by itself the first time only, later only with "Open on startup" ticked
// - the send button sits inside the message box
import { fillOneProvider } from './ai-settings.ts';
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const shots = process.argv[2];
const srv = createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })); }); }).listen(0);
const port = (srv.address() as { port: number }).port;
const root = join(import.meta.dirname, '..', '..'), ud = mkdtempSync(join(tmpdir(), 'p6strip-'));

async function launch(importFile = false) {
  const app = await electron.launch({ env: { ...process.env, P6CLONE_WHIQ: 'off' } as Record<string, string>, args: [root, '--user-data', ud, ...(importFile ? ['--import', join(root, 'Sample XERs/cairo festival city.xer')] : [])], cwd: root });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1400, height: 850 }).catch(() => {});
  return { app, win, menu: (id: string) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('menu', id), id) };
}

// first start: import a project, then turn the assistant on (its first availability)
let { app, win, menu } = await launch(true);
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await menu('edit.aiSettings'); await win.waitForSelector('.dialog-title:has-text("AI Assistant Settings")');
await fillOneProvider(win, { url: `http://127.0.0.1:${port}/v1`, model: 'fake-model' });
await win.click('.dialog button:has-text("OK")');
await win.waitForSelector('.ai-panel', { timeout: 5000 }).catch(() => {});
ok(await win.locator('.ai-panel').count() === 1, 'first time: the panel opens by itself');
const strip = await win.locator('.ai-strip').boundingBox(), panel = await win.locator('.ai-panel').boundingBox(), body = await win.locator('.winbody').boundingBox();
ok(!!strip && !!panel && Math.abs(panel.x + panel.width - strip.x) <= 2, 'the strip stays visible to the right of the open panel');
ok(!!body && !!panel && body.x + body.width <= panel.x + 1, 'the window makes room: nothing under the panel is covered');
// the agent turned off (P6CLONE_WHIQ=off): the panel says it is not available and why (item 26: the panel has no loop of its own)
ok((await win.locator('.ai-panel .ai-body').innerText()).includes('The Scheduler Agent is not available, so the assistant cannot answer: Turned off (P6CLONE_WHIQ=off).'), 'the panel says the agent is off and why');
ok(await win.locator('.ai-panel textarea').count() === 0, 'no message box of its own');
ok(!(await win.locator('.ai-auto input').isChecked()), '"Open on startup" is off by default');
if (shots) await win.screenshot({ path: join(shots, 'ai-open.png') });
// a view with its own inner body (Projects), panel widened: room is made once, not twice
await win.click('.dirbtn:has-text("Projects")'); await win.click('.ai-head button[title="Widen"]'); await win.waitForTimeout(300);
const inner = win.locator('.winbody .winbody').first();
ok(await inner.count() === 1 && (await inner.evaluate((e) => getComputedStyle(e).marginRight)) === '0px', 'an inner window body gets no extra room for the panel');
const ib = await inner.boundingBox(), wp = await win.locator('.ai-panel').boundingBox();
ok(!!ib && !!wp && Math.abs(ib.x + ib.width - wp.x) <= 2, 'Projects view runs right up to the widened panel (no blank band)');
if (shots) await win.screenshot({ path: join(shots, 'ai-projects-wide.png') });
await win.click('.ai-head button[title="Narrow"]'); await win.click('.dirbtn:has-text("Activities")'); await win.waitForTimeout(300);
await win.keyboard.press('Control+Shift+A'); await win.waitForTimeout(300);
ok(await win.locator('.ai-panel').count() === 0 && await win.locator('.ai-strip').count() === 1, 'Ctrl+Shift+A closes it back to the strip');
const glow = await win.locator('.ai-strip').evaluate((e) => getComputedStyle(e).animationName);
ok(glow === 'ai-glow', 'the closed strip glows');
const body2 = await win.locator('.winbody').boundingBox();
ok(!!body2 && !!strip && Math.abs(body2.x + body2.width - strip.x) <= 2, 'closed: the window runs up to the strip');
if (shots) await win.screenshot({ path: join(shots, 'ai-closed.png') });
await app.close();

// second start, box unticked: stays closed; the strip opens it
({ app, win, menu } = await launch());
await win.waitForSelector('.ai-strip'); await win.waitForTimeout(800);
ok(await win.locator('.ai-panel').count() === 0, 'second start, box unticked: stays closed');
await win.click('.ai-strip'); await win.waitForSelector('.ai-panel');
ok(true, 'clicking the strip opens it');
await win.locator('.ai-auto input').check();
await app.close();

// third start, box ticked: opens by itself
({ app, win, menu } = await launch());
await win.waitForSelector('.ai-strip'); await win.waitForSelector('.ai-panel', { timeout: 3000 }).catch(() => {});
ok(await win.locator('.ai-panel').count() === 1, 'with "Open on startup" ticked it opens by itself');
ok(await win.locator('.ai-auto input').isChecked(), 'the box stays ticked');
await app.close();
srv.close();
