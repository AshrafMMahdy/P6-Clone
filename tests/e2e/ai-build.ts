// End-to-end check of the assistant building a schedule from an empty app (fake provider scripts the steps):
//   node tests/e2e/ai-build.ts
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
// 15 rounds of edits (more than the 12 rounds allowed without progress), the first one creating the project
const steps: any[] = [
  { name: 'edit_project', args: { operations: [{ op: 'add_project', id: 'B5', name: 'Five-story building', start: '2026-11-02' }, { op: 'add_wbs', code: 'STR', name: 'Structure' }, { op: 'add_activity', id: 'A1000', name: 'Start', type: 'start_milestone', wbs: 'STR' }] } },
  ...Array.from({ length: 12 }, (_, i) => ({ name: 'edit_project', args: { operations: [{ op: 'add_activity', id: `A${1010 + i * 10}`, name: `Level ${i + 1} frame`, wbs: 'STR', duration_days: 5 }, { op: 'add_relationship', pred: `A${1000 + i * 10}`, succ: `A${1010 + i * 10}` }] } })),
  { name: 'edit_project', args: { operations: [{ op: 'add_activity', id: 'A9999', name: 'Finish', type: 'finish_milestone' }, { op: 'add_relationship', pred: 'A1120', succ: 'A9999' }] } },
  { name: 'ui_menu', args: { path: 'Tools > Schedule...' } },
  { name: 'ui_click', args: { target: 'Schedule' } },
];
const results: any[] = [];
const srv = createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    const j = JSON.parse(body);
    const tools = j.messages.filter((m: any) => m.role === 'tool'); if (tools.length) results.push(JSON.parse(tools[tools.length - 1].content));
    if (tools.length === 0) results.push({ guide: j.tools.find((t: any) => t.function.name === 'edit_project')?.function.description ?? '' });
    const i = tools.length;
    const message = i < steps.length ? { role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: steps[i].name, arguments: JSON.stringify(steps[i].args) } }] } : { role: 'assistant', content: 'Built and scheduled B5.' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
}).listen(0);
const port = (srv.address() as any).port;
const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6build-'));
const app = await electron.launch({ args: [root, '--user-data', profile], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('.ai-strip, .workspace');
await win.evaluate(async (port) => { await (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake', actions: true }); }, port);
await win.waitForSelector('.ai-strip'); await win.click('.ai-strip');
await win.fill('.ai-panel textarea', 'Create a schedule for a five-story building'); await win.keyboard.press('Enter');
const t0 = Date.now();
while (Date.now() - t0 < 60000 && !(await win.locator('.ai-msg.ai').count()) && !(await win.locator('.ai-msg.error').count())) await win.waitForTimeout(100);
ok(/add_project: id, start/.test(results[0]?.guide) && /lag_days/.test(results[0]?.guide), 'edit_project tells the model the operation fields');
ok(results[1]?.ok === true, 'the first call created the project: ' + JSON.stringify(results[1]).slice(0, 200));
ok(results.slice(2, 15).every((r) => r?.ok === true), 'later calls needed no "project" field: ' + JSON.stringify(results.slice(2, 15).find((r) => !r?.ok) ?? '').slice(0, 200));
ok(results[16]?.clicked === 'Schedule', 'scheduled on screen');
ok(!(await win.locator('.ai-msg.error').count()), 'no "stopped after many steps" (15 rounds of edits) ' + (await win.locator('.ai-msg.error').allInnerTexts()).join(' | '));
ok((await win.locator('.ai-msg.ai').innerText().catch(() => '')).includes('Built'), 'final answer shown');
ok(await win.evaluate(() => (document.querySelector('.grid-row') ? document.querySelectorAll('.grid-row').length : 0)) >= 14, 'the new project is open in the Activities window');
ok(await win.locator('.grid-row', { hasText: 'A9999' }).count() > 0, 'the finish milestone is shown');
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close(); srv.close();
rmSync(profile, { recursive: true, force: true });
