// End-to-end check of the assistant learning from a past project and (optionally) copying it as a starting point
// (fake provider scripts the steps):  node tests/e2e/ai-copy.ts
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
let past = '';
const steps = (): any[] => [
  { name: 'list_projects', args: {} },
  { name: 'list_wbs', args: { project: past, depth: 1 } },
  { name: 'edit_project', args: { operations: [{ op: 'copy_project', from: past, id: 'NEW5', name: 'Adapted copy', start: '2027-01-04' }, { op: 'delete_activity', id: 'A1000' }] } },
  { name: 'edit_project', args: { operations: [{ op: 'delete_activity', id: 'A1010' }] } },
];
const results: any[] = [];
const srv = createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    const j = JSON.parse(body);
    const tools = j.messages.filter((m: any) => m.role === 'tool'); if (tools.length) results.push(JSON.parse(tools[tools.length - 1].content));
    if (!tools.length) results.push({ prompt: j.messages.find((m: any) => m.role === 'system')?.content ?? '' });
    if (!past && results[1]?.projects) past = results[1].projects[0].id;
    const s = steps(), i = tools.length;
    const message = i < s.length ? { role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: s[i].name, arguments: JSON.stringify(s[i].args) } }] } : { role: 'assistant', content: 'Copied and adapted.' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
}).listen(0);
const port = (srv.address() as any).port;
const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6copy-'));
const app = await electron.launch({ args: [root, '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
const before = await win.locator('.grid-row').count();
// the imported project is the "past project"
await win.evaluate(async (port) => { await (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake', actions: true }); }, port);
await win.waitForSelector('.ai-strip'); await win.waitForTimeout(400); if (!(await win.locator('.ai-panel').count())) await win.click('.ai-strip');
// first ask only lists projects, to learn the past project's ID
await win.fill('.ai-panel textarea', 'Plan a similar project'); await win.keyboard.press('Enter');
const t0 = Date.now();
while (Date.now() - t0 < 60000 && !(await win.locator('.ai-msg.ai').count()) && !(await win.locator('.ai-msg.error').count())) {
  await win.waitForTimeout(100);
}
ok(/list_projects/.test(results[0]?.prompt) && /OPTIONAL/.test(results[0]?.prompt), 'the instructions mention past projects and that copying is optional');
ok(results[1]?.projects?.length === 1 && results[1].projects[0].activities > 0, 'list_projects lists the past project: ' + JSON.stringify(results[1]).slice(0, 160));
ok(Array.isArray(results[2]?.wbs ?? results[2]?.nodes ?? results[2]) || !results[2]?.error, 'list_wbs read the past project by ID: ' + JSON.stringify(results[2]).slice(0, 160));
ok(results[3]?.ok === true, 'copy_project + delete in one call, no confirmation needed: ' + JSON.stringify(results[3]).slice(0, 200));
ok(results[4]?.ok === true, 'a later delete in the copy needs no confirmation either: ' + JSON.stringify(results[4]).slice(0, 200));
ok(!(await win.locator('.ai-msg.error').count()), 'finished without an error');
const after = await win.locator('.grid-row').count();
ok(after > 0 && !(await win.locator('.grid-row', { hasText: 'A1010' }).count()), `the copy is open on screen without the deleted activities (${before} rows before, ${after} now)`);
await win.click('.ai-panel button:has-text("Clear context")');
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close(); srv.close();
rmSync(profile, { recursive: true, force: true });
