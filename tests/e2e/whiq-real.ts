// End-to-end with the REAL model the owner set up (not a stand-in): the app runs on a fresh profile holding only a copy
// of the owner's AI settings (ai-assistant.json, its key still encrypted, and Chromium's "Local State" that unlocks it on
// this Windows account), so their projects and chats are never touched. The agent does planner's work on the open
// project: reads it and works on screen, reviews it with its own scheduler tools (export, import, PQ-VAE review), runs
// Python in the code sandbox and writes a Word report into the working folder. Costs the owner a little API credit.
//   node tests/e2e/whiq-real.ts [--exe <P6 Clone.exe>]
import { copyOwnerSettings } from './owner-settings.ts';
import { _electron as electron } from 'playwright';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6whiq-real-'));
// the project's own folder in the data folder (Data/Projects/<Project ID>): the default working folder, no prompt
const folder = join(profile, 'Data', 'Projects', 'CFC Modified');
if (!copyOwnerSettings(profile)) { console.log('SKIP no AI settings of the owner'); process.exit(0); }
const exe = process.argv.includes('--exe') ? process.argv[process.argv.indexOf('--exe') + 1] : '';
const app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args: [...(exe ? [] : [root]), '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root, chromiumSandbox: true });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await app.evaluate(({ dialog }, f) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
await win.waitForSelector('.ai-panel', { timeout: 15000 }).catch(async () => { await win.click('.ai-strip'); await win.waitForSelector('.ai-panel'); });
await win.waitForSelector('.ai-head b:has-text("Scheduler Agent")', { timeout: 15000 });
const body = () => win.locator('.ai-panel .ai-body').innerText();
/** One message, then the panel until the agent is done (its Stop button gone) or the time is up. */
const ask = async (text: string, minutes: number): Promise<{ text: string; s: number }> => {
  const before = (await body()).length, t0 = Date.now();
  await win.fill('.ai-panel textarea', text); await win.keyboard.press('Enter');
  await win.waitForTimeout(3000);
  while (Date.now() - t0 < minutes * 60_000) {
    // done: no Stop button for 5 s in a row (between two steps the panel can be idle for a moment)
    let idle = 0;
    while (idle < 5 && !(await win.locator('.ai-panel .ai-send.stop').count())) { idle++; await win.waitForTimeout(1000); }
    if (idle >= 5) break;
    await win.waitForTimeout(2000);
  }
  return { text: (await body()).slice(before), s: Math.round((Date.now() - t0) / 1000) };
};
const show = (t: string) => t.replace(/\s+/g, ' ').slice(0, 900);

// the events of the questions, for a failure: type, message id, and the panel's text 50 ms after each
await win.evaluate(() => (window as any).p6.whiq.onEvent((_id: string, e: any) => { const tag = `${e.type}${e.messageId ? '#' + String(e.messageId).slice(-5) : ''}${e.type === 'token' ? ':' + String(e.delta ?? '').slice(0, 15) : ''}${e.type === 'message' ? ':' + e.message?.role + '#' + String(e.message?.id ?? '').slice(-5) + (e.message?.uiKind ? '/' + e.message.uiKind : '') : ''}`; setTimeout(() => ((window as any).__ev ??= []).push(tag + ' => ' + ((document.querySelector('.ai-panel .ai-body') as HTMLElement)?.innerText ?? '').replace(/\s+/g, ' ').slice(-50)), 50); }));
const a = await ask('Which activities in the open project are critical? Select the first critical activity on screen, then tell me in two sentences what drives the finish date.', 6);
console.log(`--- answer 1 (${a.s} s): ${show(a.text)}`);
ok(/critical/i.test(a.text) && !/stopped with an error|did not start/i.test(a.text), 'a real answer about the critical path');
ok(await win.locator('.grid-row.sel').count() >= 1, 'it selected an activity on screen');

const b = await ask('Review this programme with your programme review tool (export the open project, import it, then review_programme) and write a one-page Word report of the findings into the working folder.', 15);
console.log(`--- answer 2 (${b.s} s): ${show(b.text)}`);
const outs = existsSync(join(folder, 'AI Outputs')) ? readdirSync(join(folder, 'AI Outputs'), { recursive: true }) as string[] : [];
ok(existsSync(join(folder, '00_INPUTS')) && readdirSync(join(folder, '00_INPUTS')).some((f) => /\.(xer|xml)$/i.test(f)), 'the open project was exported for its scheduler tools');
ok(/review programme|review_programme/i.test(b.text), 'it ran the programme review');
ok(outs.some((f) => /\.docx$/i.test(f)), `a Word report is in the working folder: ${outs.join(', ')}`);

const c = await ask('Using Python in your code sandbox, compute the average and the longest original duration of the activities in the imported schedule, and tell me both numbers.', 8);
console.log(`--- answer 3 (${c.s} s): ${show(c.text)}`);
ok(/run code|run_code|python/i.test(c.text) && /\d/.test(c.text), 'it ran Python and gave numbers');
if (process.exitCode) {   // what the agent itself has for the last turn (its messages, with their hidden marks)
  for (const t of (await win.evaluate(() => (window as any).__ev ?? [])).filter((t: string) => !/^token/.test(t) || /=> $/.test(t)).slice(0, 80)) console.log('  ev ' + t);
  const chats = await win.evaluate(() => JSON.parse(localStorage.getItem('p6clone.whiq.chats') ?? '{}'));
  for (const id of Object.values(chats) as string[]) {
    const r = await win.evaluate((i) => (window as any).p6.whiq.chat(i), id);
    for (const m of (r.data?.messages ?? []).slice(-6)) console.log(`  [${m.role}${m.uiKind ? ' ' + m.uiKind : ''}] ${String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 300)} ${(m.toolCalls ?? []).map((t: any) => `{${t.toolName} ${t.status} ${String(t.result ?? t.error ?? '').slice(0, 200)}}`).join(' ')}`);
  }
}
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close();
const logs = join(profile, 'whiq', 'logs');
if (process.exitCode && existsSync(logs)) console.log('logs kept in ' + logs);
else { rmSync(profile, { recursive: true, force: true }); }
