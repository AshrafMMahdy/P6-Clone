// Smoke test of the assistant against the REAL provider saved in the app's settings (costs a few requests):
//   node tests/e2e/ai-real.ts
// Copies only the saved AI settings (key stays encrypted; Windows decrypts it for the same user) into a throwaway
// profile, so the user's own database and open app are not touched.
import { _electron as electron } from 'playwright';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const real = join(process.env.APPDATA!, 'p6-clone');
const profile = mkdtempSync(join(tmpdir(), 'p6real-'));
for (const f of ['Local State', 'ai-assistant.json']) copyFileSync(join(real, f), join(profile, f));
const root = join(import.meta.dirname, '..', '..');
const app = await electron.launch({ args: [root, '--user-data', profile, '--import', join(root, 'sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await win.waitForSelector('.ai-strip'); await win.waitForTimeout(400); if (!(await win.locator('.ai-panel').count())) await win.click('.ai-strip');

async function ask(q: string, timeout = 180000): Promise<string> {
  const before = await win.locator('.ai-msg.ai').count();
  await win.fill('.ai-panel textarea', q); await win.keyboard.press('Enter');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout && (await win.locator('.ai-msg.ai').count()) <= before && !(await win.locator('.ai-msg.error').count())) await win.waitForTimeout(250);
  const err = await win.locator('.ai-msg.error').allInnerTexts();
  if (err.length) { console.log('ERROR: ' + err.join(' | ')); return 'ERROR: ' + err.join(' | '); }
  const tools = await win.locator('.ai-msg.tool').allInnerTexts();
  const reply = (await win.locator('.ai-msg.ai').allInnerTexts()).at(-1) ?? '';
  console.log(`\n### ${q}  (${((Date.now() - t0) / 1000).toFixed(1)} s)\n[tools so far: ${tools.join(' · ')}]\n${reply}\n`);
  return reply;
}

const a1 = await ask('What is driving the project finish? Name the critical activities.');
ok(!a1.startsWith('ERROR') && a1.length > 40, 'answers a schedule question from the project data');
const a2 = await ask('How do I add a Start On or After constraint to an activity? Just explain, do not do it.');
ok(/constraint/i.test(a2) && !a2.startsWith('ERROR'), 'explains a how-to');
const a3 = await ask('What was the first thing I asked you?');
ok(/driv|finish|critical/i.test(a3), 'remembers the conversation');
const a4 = await ask('Please schedule the project for me now (F9).');
ok(!a4.startsWith('ERROR') && (await win.locator('.ai-msg.tool').allInnerTexts()).some((t) => /Schedule/i.test(t)), 'operates the app (Tools > Schedule)');
await win.click('.ai-panel button:has-text("Clear context")');
await win.waitForTimeout(300);
ok((await win.locator('.ai-msg.ai').count()) === 0, 'Clear context empties the conversation');
ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await app.close();
