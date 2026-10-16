import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const file = process.argv[2], root = join(import.meta.dirname, '..');
const app = await electron.launch({ args: [root, '--user-data', mkdtempSync(join(tmpdir(), 'p6w-')), '--import', file], cwd: root });
const win = await app.firstWindow();
let t = Date.now(); const lap = (s: string) => { console.log(`${String(Date.now() - t).padStart(6)} ms  ${s}`); t = Date.now(); };
await win.waitForSelector('.dialog .wizard-side', { timeout: 120000 }); lap('wizard visible'); await win.waitForSelector('button:has-text("View Diagnostics...")', { timeout: 120000 }); lap('file read + checked (progress shown meanwhile)');
for (const s of ['Next >', 'Next >', 'Next >', '< Back', 'Next >']) { await win.click(`button:has-text("${s}")`); await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))); lap(`click ${s}`); }
await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row', { timeout: 300000 }); lap('Finish -> activities visible');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(100); }
await win.waitForTimeout(500); t = Date.now();
const row = win.locator('.grid-row').nth(3); await row.click(); await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))); lap('select a row');
// scroll test: wheel in the table, sample scrollTop over time
const body = await win.evaluate(() => { const els = [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 100; }); return els.map((e) => `${e.className}:${e.scrollHeight}`).join(' | '); });
console.log('scrollables:', body);
const box = await row.boundingBox(); await win.mouse.move(box!.x + 50, box!.y + 50);
await win.evaluate(() => { (window as any).__s = []; const els = [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 100; }); const t0 = performance.now(); const tick = () => { (window as any).__s.push([Math.round(performance.now() - t0), ...els.map((e) => e.scrollTop)]); if (performance.now() - t0 < 3000) requestAnimationFrame(tick); }; tick(); });
for (let i = 0; i < 5; i++) { await win.mouse.wheel(0, 300); await win.waitForTimeout(60); }
await win.waitForTimeout(3200);
const s = await win.evaluate(() => (window as any).__s as number[][]);
let flips = 0; for (let i = 2; i < s.length; i++) for (let c = 1; c < s[i].length; c++) if (Math.sign(s[i][c] - s[i - 1][c]) * Math.sign(s[i - 1][c] - s[i - 2][c]) < 0) flips++;
console.log('scroll samples', s.length, 'direction reversals', flips, 'last', JSON.stringify(s[s.length - 1]), 'sample', JSON.stringify(s.filter((_, i) => i % 15 === 0).slice(0, 12)));
await app.close();
