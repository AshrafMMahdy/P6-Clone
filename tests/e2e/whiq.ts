// End-to-end: the embedded platform agent inside the real app. The window's bridge starts it on first use (on
// Electron's own Node), a scheduler chat takes a message, the answer arrives as live events in the window, and quitting
// the app stops both servers.  node tests/e2e/whiq.ts   (needs vendor/whiq-agent installed and built)
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6whiq-'));
const app = await electron.launch({ args: [root, '--user-data', profile], cwd: root });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
// a model and a test key in the AI settings (the provider will refuse the key: the refusal is the answer we wait for)
await win.evaluate(() => (window as any).p6.aiSetConfig({ enabled: true, provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', actions: true }, 'sk-ant-e2e-not-a-key'));
const t0 = Date.now();
const chat = await win.evaluate(() => (window as any).p6.whiq.createChat('e2e'));
ok(chat.ok && /^chat-/.test(chat.data.id), `a scheduler chat on the embedded agent (${Date.now() - t0} ms to start): ${JSON.stringify(chat).slice(0, 160)}`);
const st = await win.evaluate(() => (window as any).p6.whiq.status());
ok(st.ok && st.data.state === 'ready', 'the agent reports ready');
const got = await win.evaluate(async (id: string) => {
  const p6 = (window as any).p6;
  const events: string[] = [];
  const said: string[] = [];
  const off = p6.whiq.onEvent((cid: string, e: any) => { if (cid !== id) return; events.push(e.type); if (e.type === 'message') said.push(JSON.stringify(e.message ?? e)); });
  await p6.whiq.watch(id);
  await p6.whiq.send(id, 'Say hello.');
  for (let i = 0; i < 120 && !events.includes('done'); i++) await new Promise((r) => setTimeout(r, 500));
  off(); await p6.whiq.unwatch(id);
  return { events, said };
}, chat.data.id);
ok(got.events.includes('done'), `live events reached the window: ${[...new Set(got.events)].join(', ')}`);
ok(/provider|key|auth/i.test(got.said.join(' ')), 'the provider\'s refusal is in the chat');
await app.close();
await new Promise((r) => setTimeout(r, 1500));
const { execFileSync } = await import('node:child_process');
const left = process.platform === 'win32' ? execFileSync('powershell', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'server.dist.mjs|LLM Router' } | Measure-Object).Count"], { encoding: 'utf8' }).trim() : '0';
ok(left === '0', `quitting the app stopped both servers (${left} left)`);
rmSync(profile, { recursive: true, force: true });
