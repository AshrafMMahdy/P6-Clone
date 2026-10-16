import { _electron as electron } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const file = process.argv[2], root = join(import.meta.dirname, '..');
const app = await electron.launch({ args: [root, '--user-data', mkdtempSync(join(tmpdir(), 'p6r-')), '--import', file], cwd: root });
const win = await app.firstWindow();
await win.waitForSelector('.dialog .wizard-side', { timeout: 120000 });
await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")');
await win.waitForSelector('.grid-row', { timeout: 300000 });
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(100); }
await win.waitForTimeout(2000);
const cdp = await win.context().newCDPSession(win);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
const row = win.locator('.grid-row').nth(3); await row.click(); await win.waitForTimeout(400);
const box = await row.boundingBox(); await win.mouse.move(box!.x + 50, box!.y + 50);
for (let i = 0; i < 5; i++) { await win.mouse.wheel(0, 300); await win.waitForTimeout(60); }
await win.waitForTimeout(2500);
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map((n: any) => [n.id, n])); const self = new Map<string, number>();
profile.samples!.forEach((id: number, i: number) => { const n: any = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas![i] ?? 0)); });
[...self].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, us]) => console.log(`${(us / 1000).toFixed(0).padStart(6)} ms  ${k}`));
await app.close();
