// End-to-end: the app's data in the install folder's Data (main/dataPaths.ts). A profile in the AppData layout (the
// database, the AI settings, the agent's logs, the panel's chats at its top) is moved into Data\Database, Data\Settings,
// Data\Logs and Data\Agent on the first start: the projects open, the settings read back, and each original is kept
// beside as "<name>.moved". A second start moves nothing more.
//   node tests/e2e/data-folders.ts
import { _electron as electron } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const root = join(import.meta.dirname, '..', '..');
const launch = (profile: string, more: string[] = []) => electron.launch({ args: [root, '--user-data', profile, ...more], cwd: root });

// a project and AI settings, made by the app itself (in the new layout), to build an old-layout profile from
const made = mkdtempSync(join(tmpdir(), 'p6data-made-'));
let app = await launch(made, ['--import', join(root, 'Sample XERs/cairo festival city.xer')]);
let win = await app.firstWindow();
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
await win.evaluate(() => (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm-1', actions: true }, 'sk-test-data-folders'));
await win.waitForTimeout(2500);   // the database saves on a short delay
await app.close();
ok(existsSync(join(made, 'Data', 'Database', 'p6clone-db.json')) && existsSync(join(made, 'Data', 'Settings', 'ai-assistant.json')), 'a new profile keeps its data in Data\\Database and Data\\Settings');

const old = mkdtempSync(join(tmpdir(), 'p6data-old-'));
copyFileSync(join(made, 'Data', 'Database', 'p6clone-db.json'), join(old, 'p6clone-db.json'));
copyFileSync(join(made, 'Data', 'Settings', 'ai-assistant.json'), join(old, 'ai-assistant.json'));
if (existsSync(join(made, 'Local State'))) copyFileSync(join(made, 'Local State'), join(old, 'Local State'));   // unlocks the encrypted key
mkdirSync(join(old, 'whiq', 'logs'), { recursive: true }); writeFileSync(join(old, 'whiq', 'logs', 'agent.log'), 'old log\n');
mkdirSync(join(old, 'whiq', 'runtime'), { recursive: true }); writeFileSync(join(old, 'whiq', 'runtime', 'memory.json'), '{"version":1,"items":[]}');
mkdirSync(join(old, 'ai-chats'), { recursive: true }); writeFileSync(join(old, 'ai-chats', 'x.jsonl'), '{}\n');

app = await launch(old);
win = await app.firstWindow();
await win.waitForSelector('.grid-row, button:has-text("Open Project")', { timeout: 30000 }).catch(() => {});
const data = join(old, 'Data');
ok(existsSync(join(data, 'Database', 'p6clone-db.json')) && existsSync(join(old, 'p6clone-db.json.moved')), 'the database moved to Data\\Database, the original kept as .moved');
ok(existsSync(join(data, 'Settings', 'ai-assistant.json')) && existsSync(join(old, 'ai-assistant.json.moved')), 'the AI settings moved to Data\\Settings');
ok(existsSync(join(data, 'Logs', 'agent.log')), 'the agent\'s logs moved to Data\\Logs');
ok(existsSync(join(data, 'Agent', 'runtime', 'memory.json')) && !existsSync(join(data, 'Agent', 'logs')), 'the agent\'s files moved to Data\\Agent (its logs not twice)');
ok(existsSync(join(data, 'Agent', 'panel-chats', 'x.jsonl')), 'the panel\'s own chats moved to Data\\Agent\\panel-chats');
await win.waitForTimeout(3000);
ok(/CFC Modified/.test(await win.locator('body').innerText()), 'its projects are there (CFC Modified)');
const models = await win.evaluate(() => (window as any).p6.aiGetModels());
ok(models.providers.length === 1 && models.providers[0].hasKey && models.tiers[0]?.model === 'm-1', 'the moved settings read back, the key still there');
await app.close();

app = await launch(old);   // a second start: nothing left to move, nothing moved twice
win = await app.firstWindow();
await win.waitForTimeout(1500);
ok(!existsSync(join(data, 'Database', 'p6clone-db.json.moved')) && existsSync(join(old, 'p6clone-db.json.moved')), 'a second start moves nothing again');
await app.close();
rmSync(made, { recursive: true, force: true }); rmSync(old, { recursive: true, force: true });
