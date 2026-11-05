// End-to-end: the embedded platform agent's own scheduler tools and code sandbox on the open project, with a scripted
// stand-in model (fake-model.ts): it saves the open project into the working folder (export_project, a live tool),
// imports it into its scheduler (import_schedule_file), reviews it with PQ-VAE (review_programme: the app's ONNX
// engine, no Python), and runs Python in the code sandbox (run_code). Each step's result is checked as the model saw it.
//   node tests/e2e/whiq-tools.ts [--sandbox wsl|pyodide] [--exe <P6 Clone.exe>]   (needs vendor/whiq-agent with pqvae-onnx, and vendor/pyodide)
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeModel, type Req } from './fake-model.ts';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const kind = process.argv.includes('--sandbox') ? process.argv[process.argv.indexOf('--sandbox') + 1] : 'pyodide';

const results = (r: Req) => r.messages.filter((m) => m.role === 'tool').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
const offered = (r: Req, n: string) => (r.tools ?? []).some((t) => t.function.name === n);
let seen: string[] = [];
const fake = await fakeModel((r) => {
  if (!offered(r, 'load_tools')) return { text: 'ok' };
  const done = results(r);
  seen = done;
  if (done.length === 0) return { call: 'load_tools', args: { names: ['mcp__p6clone_live__*', 'import_schedule_file', 'review_programme', 'run_code'] } };
  if (done.length === 1) return { call: 'mcp__p6clone_live__export_project', args: {} };
  if (done.length === 2) return { call: 'import_schedule_file', args: { path: /path\\*"\s*:\s*\\*"([^"\\]+)/.exec(done[1])?.[1] ?? '00_INPUTS/missing.xer' } };
  if (done.length === 3) return { call: 'review_programme', args: { schedule_id: /\bsch_[\w-]+/.exec(done[2])?.[0] ?? 'sch_missing', project_type: 'Office' } };
  if (done.length === 4) return { call: 'run_code', args: { language: 'python', code: 'import numpy, pandas\nprint("sandbox-ok", numpy.__version__, int(pandas.DataFrame({"a": [1, 2, 3]}).a.sum()))' } };
  return { text: 'Done: exported, imported, reviewed and computed.' };
});

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6whiqt-'));
const folder = mkdtempSync(join(tmpdir(), 'p6whiqt-wd-'));
// --exe <P6 Clone.exe>: the packaged program (its resources: agent, engines, models, Pyodide) instead of this checkout
const exe = process.argv.includes('--exe') ? process.argv[process.argv.indexOf('--exe') + 1] : '';
const app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args: [...(exe ? [] : [root]), '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root, chromiumSandbox: true, env: { ...process.env, P6CLONE_SANDBOX: kind } as Record<string, string> });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await app.evaluate(({ dialog }, f) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
await win.evaluate((u) => (window as any).p6.aiSetConfig({ enabled: true, provider: 'openai', baseUrl: u, model: 'fake-1', actions: true }, 'not-a-key'), fake.url);
await win.waitForSelector('.ai-panel', { timeout: 15000 }).catch(async () => { await win.click('.ai-strip'); await win.waitForSelector('.ai-panel'); });
await win.waitForSelector('.ai-head b:has-text("Scheduler Agent")', { timeout: 15000 });
await win.fill('.ai-panel textarea', 'Review the open programme and check a number in Python.');
await win.keyboard.press('Enter');
await win.waitForSelector('.ai-panel .ai-msg:has-text("Done: exported")', { timeout: 300000 }).catch(() => {});
const short = (s?: string) => (s ?? '(none)').slice(0, 300).replace(/\s+/g, ' ');
const xer = join(folder, '00_INPUTS', 'CFC Modified.xer');
ok(existsSync(xer) && readFileSync(xer, 'latin1').startsWith('ERMHDR'), `export_project saved the open project into the working folder: ${short(seen[1])}`);
ok(/sch_/.test(seen[2] ?? ''), `import_schedule_file read it: ${short(seen[2])}`);
ok(/phase_order|kendall|order_vs_random/i.test(seen[3] ?? '') && !/unavailable/i.test(seen[3] ?? ''), `review_programme ran on the PQ-VAE engine: ${short(seen[3])}`);
ok(/sandbox-ok \S+ 6/.test(seen[4] ?? ''), `run_code ran Python in the ${kind} sandbox: ${short(seen[4])}`);
const sb = await win.evaluate(() => (window as any).p6.whiq.sandbox());
ok(sb.ok && sb.data.kind === kind, `the sandbox in use is ${kind}: ${JSON.stringify(sb.data)}`);
// its door answers the agent server only: never a web page (an Origin) or a rebound name (a foreign Host)
const { request } = await import('node:http');
const door = new URL(sb.data.url ?? 'http://127.0.0.1:1');   // (no sandbox: the checks above already failed)
const status = (headers: Record<string, string>) => new Promise<number>((res) => { const q = request({ host: '127.0.0.1', port: Number(door.port), path: '/run', method: 'POST', headers: { 'content-type': 'text/plain', ...headers } }, (x) => { x.resume(); res(x.statusCode ?? 0); }); q.on('error', () => res(0)); q.end('{"id":"x","code":"print(1)"}'); });
ok(await status({ origin: 'https://evil.example' }) === 403 && await status({ host: `evil.example:${door.port}` }) === 403, 'the sandbox door refuses a web page and a rebound name');
ok(/Done: exported/.test(await win.locator('.ai-panel .ai-body').innerText()), 'the answer is in the panel');
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close();
fake.close();
if (process.exitCode) for (const f of ['agent.log', 'pqvae.log', 'sandbox.log']) {   // what the services said, for a failure
  const p = join(profile, 'whiq', 'logs', f);
  if (existsSync(p)) console.log(`--- ${f} (last lines about engines)\n` + readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => /p6clone|engine|error|fail/i.test(l)).slice(-25).join('\n'));
}
rmSync(profile, { recursive: true, force: true }); rmSync(folder, { recursive: true, force: true });
