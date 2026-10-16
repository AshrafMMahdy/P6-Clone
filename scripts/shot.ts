// Launch the built app, print console errors and save a screenshot.
// node scripts/shot.ts <out.png> [--import file] [--wait ms]
import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const out = args[0] ?? 'shot.png';
const imp = args.includes('--import') ? args[args.indexOf('--import') + 1] : undefined;
const wait = args.includes('--wait') ? Number(args[args.indexOf('--wait') + 1]) : 3000;
const root = join(import.meta.dirname, '..');
const app = await electron.launch({ args: [root, '--user-data', mkdtempSync(join(tmpdir(), 'p6shot-')), ...(imp ? ['--import', imp] : [])], cwd: root });
const win = await app.firstWindow();
win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text()}`); });
win.on('pageerror', (e) => console.log('[pageerror]', e.stack ?? e.message));
await win.setViewportSize({ width: 1440, height: 860 }).catch(() => {});
await win.waitForTimeout(wait);
await win.screenshot({ path: out });
console.log('saved', out, 'title:', await win.title());
await app.close();
