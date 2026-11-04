// End-to-end: the AI panel on the embedded platform scheduler agent, with a scripted stand-in model (fake-model.ts)
// so every step is real but the model's choices: the agent loads the app's live tools, reads the open schedule,
// selects an activity on screen, writes a summary file and answers. The panel shows the steps and the answer, the
// activity is selected in the app, and the file asks for a working folder (none chosen yet) and lands in it.
//   node tests/e2e/whiq-panel.ts [--exe <P6 Clone.exe>]   (needs vendor/whiq-agent installed and built)
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeModel, type Req } from './fake-model.ts';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

// the main agent's turn (it is offered load_tools; other seats get a plain answer): one step per tool result so far
const toolResults = (r: Req) => r.messages.filter((m) => m.role === 'tool');
const offered = (r: Req, n: string) => (r.tools ?? []).some((t) => t.function.name === n);
const fake = await fakeModel((r) => {
  if (!offered(r, 'load_tools')) return { text: 'ok' };
  const done = toolResults(r).length;
  if (done === 0) return { call: 'load_tools', args: { names: ['mcp__p6clone_live__*'] } };
  if (done === 1) return { call: 'mcp__p6clone_live__list_projects', args: {} };
  if (done === 2) return { call: 'mcp__p6clone_live__select_activity', args: { activity_id: 'A2410' } };
  if (done === 3) return { call: 'write_doc', args: { path: 'summary.md', format: 'md', content: `# Open projects\n\n${String(toolResults(r)[1]?.content ?? '').slice(0, 400)}\n` } };
  // a Word report and its PDF through the platform's engines
  if (done === 4) return { call: 'load_tools', args: { names: ['mcp__wordcraft__*'] } };
  if (done === 5) return { call: 'mcp__wordcraft__import_markdown', args: { markdown: '# Schedule report\n\nThe open project is CFC Modified.', title: 'Schedule report' } };
  if (done === 6) return { call: 'mcp__wordcraft__save_document', args: { path: 'report.docx' } };
  if (done === 7) return { call: 'mcp__wordcraft__export_pdf', args: { path: 'report.pdf' } };
  return { text: 'Done: I read the open schedule, selected A2410 and wrote **summary.md** and a Word report.' };
});

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6whiqp-'));
const folder = mkdtempSync(join(tmpdir(), 'p6whiq-wd-'));
const exe = process.argv.includes('--exe') ? process.argv[process.argv.indexOf('--exe') + 1] : '';   // the packaged program
const app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args: [...(exe ? [] : [root]), '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
// the folder dialog answers with our folder (the first file asks for one)
await app.evaluate(({ dialog }, f) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
await win.evaluate((u) => (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: u, model: 'fake-1', actions: true }, 'not-a-key'), fake.url);
await win.waitForSelector('.ai-panel', { timeout: 15000 }).catch(async () => { await win.click('.ai-strip'); await win.waitForSelector('.ai-panel'); });
await win.waitForSelector('.ai-head b:has-text("Scheduler Agent")', { timeout: 15000 });
ok(true, 'the panel runs on the platform agent');
await win.fill('.ai-panel textarea', 'List the open projects, select A2410 and write a summary file.');
await win.keyboard.press('Enter');
await win.waitForSelector('.ai-panel .ai-msg:has-text("Done: I read the open schedule")', { timeout: 120000 }).catch(() => {});
const panel = await win.locator('.ai-panel .ai-body').innerText();
ok(/Done: I read the open schedule/.test(panel), 'the agent\'s answer is in the panel');
ok(/On screen: list projects/.test(panel) && /On screen: select activity A2410/.test(panel), 'its steps on the open schedule show as lines');
ok(await win.locator('.grid-row.sel', { hasText: 'A2410' }).count() >= 1 || /A2410/.test(await win.locator('.grid-row.sel').first().innerText().catch(() => '')), 'A2410 is selected in the Activities window');
await win.waitForSelector('.ai-panel .ai-msg:has-text("File: summary.md")', { timeout: 30000 }).catch(() => {});
ok(/File: summary\.md/.test(await win.locator('.ai-panel .ai-body').innerText()), 'the file shows as a chip');
const saved = join(folder, 'AI Outputs', 'summary.md');
ok(existsSync(saved) && /CFC/.test(readFileSync(saved, 'utf8')), `the file is in the working folder: ${saved}`);
ok(/📁 p6whiq-wd-/.test(await win.locator('.ai-panel .ai-input').innerText()), 'the panel names the working folder');
const docx = join(folder, 'AI Outputs', 'report.docx'), pdf = join(folder, 'AI Outputs', 'report.pdf');
for (let i = 0; i < 30 && !(existsSync(docx) && existsSync(pdf)); i++) await win.waitForTimeout(500);
ok(existsSync(docx) && readFileSync(docx).subarray(0, 2).toString() === 'PK', `the Word report made by the Word engine is in the working folder: ${docx}`);
ok(existsSync(pdf) && readFileSync(pdf).subarray(0, 5).toString() === '%PDF-', 'and its PDF export');
ok(/File: report\.docx/.test(await win.locator('.ai-panel .ai-body').innerText()), 'the Word report shows as a chip');
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close();
fake.close();
rmSync(profile, { recursive: true, force: true }); rmSync(folder, { recursive: true, force: true });
