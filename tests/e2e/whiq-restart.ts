// End-to-end: the AI panel after the AI settings change (scripted stand-in model, fake-model.ts). A save that changes
// the agent's model restarts the agent, and the next message is answered in the same panel; a save that changes
// nothing of the agent's (the "Let it operate the app" switch) keeps it running, and with that switch off the agent's
// on-screen tools are refused.
//   node tests/e2e/whiq-restart.ts   (needs vendor/whiq-agent installed and built)
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeModel, type Req } from './fake-model.ts';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const users = (r: Req) => r.messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content ?? '')).join(' ');
const lastToolText = (r: Req) => { const t = r.messages.filter((m) => m.role === 'tool').pop(); return t ? JSON.stringify(t.content ?? '') : ''; };
let menuResult = '';
const fake = await fakeModel((r) => {
  if (!(r.tools ?? []).some((t) => t.function.name === 'load_tools')) return { text: 'ok' };
  const u = users(r), tools = r.messages.filter((m) => m.role === 'tool').length;
  // the turn: the question asked last (the platform's own context text may hold any word)
  const turn = ['first question', 'second question', 'third question'].sort((a, b) => u.lastIndexOf(b) - u.lastIndexOf(a))[0];
  if (turn === 'third question') {
    if (tools === 0) return { call: 'load_tools', args: { names: ['mcp__p6clone_live__*'] } };
    if (tools === 1) return { call: 'mcp__p6clone_live__ui_menu', args: { path: 'View > Zoom > Zoom In' } };
    menuResult = lastToolText(r);
    return { text: 'Answer three.' };
  }
  if (turn === 'second question') return { text: 'Answer two.' };
  return { text: 'Answer one.' };
});

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6whiqr-'));
const app = await electron.launch({ args: [root, '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
const cfg = (model: string, actions: boolean) => win.evaluate(([u, m, a]) => (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: u, model: m, actions: a }, 'not-a-key'), [fake.url, model, actions] as const);
await cfg('fake-1', true);
await win.waitForSelector('.ai-panel', { timeout: 15000 }).catch(async () => { await win.click('.ai-strip'); await win.waitForSelector('.ai-panel'); });
await win.waitForSelector('.ai-head b:has-text("Scheduler Agent")', { timeout: 15000 });
const ask = async (text: string, answer: string) => {
  await win.fill('.ai-panel textarea', text); await win.keyboard.press('Enter');
  await win.waitForSelector(`.ai-panel .ai-msg:has-text("${answer}")`, { timeout: 120000 }).catch(() => {});
  return (await win.locator('.ai-panel .ai-body').innerText()).includes(answer);
};
ok(await ask('first question', 'Answer one.'), 'the first answer arrives');
await cfg('fake-2', true);   // the agent's model changed: it restarts
ok((await win.evaluate(() => (window as any).p6.whiq.status())).data.state === 'off', 'a changed model stops the agent');
ok(await ask('second question', 'Answer two.'), 'after the settings changed, the next message is answered in the same panel');
ok(fake.requests.some((r) => r.model === 'fake-2'), 'with the new model');
ok(!(await win.locator('.ai-panel .ai-send.stop').count()), 'the panel is not left busy');
await cfg('fake-2', false);  // only the operate switch: the agent keeps running
ok((await win.evaluate(() => (window as any).p6.whiq.status())).data.state === 'ready', 'a save that changes nothing of the agent keeps it running');
ok(await ask('third question', 'Answer three.'), 'the third answer arrives');
ok(/turned off/i.test(menuResult), `with "Let it operate the app" off, an on-screen tool is refused: ${menuResult.slice(0, 160)}`);
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close();
fake.close();
rmSync(profile, { recursive: true, force: true });
