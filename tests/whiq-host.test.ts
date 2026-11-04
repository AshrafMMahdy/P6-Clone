// The embedded platform agent end to end through WhiqHost: both servers start on ports of their own, a scheduler
// chat takes a message and the agent's answer arrives on the event stream (here the provider's refusal of a test key,
// in the platform's own words), the key is never written to disk, and stop() leaves nothing running.
// Runs only where the agent is installed (node scripts/fetch-whiq-agent.mjs --install --build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WhiqHost, type AgentEvent } from '../main/whiq-host.ts';

const vendor = join(import.meta.dirname, '..', 'vendor', 'whiq-agent');
const installed = existsSync(join(vendor, '03 Shared Platform Agents', 'app', 'server.dist.mjs')) && existsSync(join(vendor, 'node_modules'));

test('the platform agent runs embedded: chat, message, streamed answer, no key on disk, clean stop', { skip: !installed && 'platform agent not installed', timeout: 180_000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), 'whiq-host-'));
  let ports = { router: 0, agent: 0 };
  const host = new WhiqHost({ vendor, data }, () => ({
    providers: [{ name: 'main', type: 'anthropic', baseUrl: 'https://api.anthropic.com', key: 'sk-ant-not-a-real-key-123' }],
    tiers: [{ name: 'Strong', provider: 'main', model: 'claude-opus-5-5' }],
  }));
  try {
    const chat = await host.api('POST', '/api/chats', { title: 'test', module: 'scheduler' }) as { id: string };
    assert.match(chat.id, /^chat-/);
    const wd = mkdtempSync(join(tmpdir(), 'whiq-wd-'));
    assert.deepEqual(await host.api('POST', '/api/working-dir/set', { chatId: chat.id, path: wd }), { ok: true, path: wd });
    const events: AgentEvent[] = [];
    const stop = await host.stream(chat.id, (e) => events.push(e));
    await host.api('POST', '/api/agent/send', { chatId: chat.id, content: 'Say hello.' });
    for (let i = 0; i < 120 && !events.some((e) => e.type === 'done'); i++) await new Promise((r) => setTimeout(r, 500));
    stop();
    assert.ok(events.some((e) => e.type === 'done'), `no done event: ${events.map((e) => e.type).join(', ')}`);
    const said = events.filter((e) => e.type === 'message').map((e) => JSON.stringify(e)).join('\n');
    assert.match(said, /provider|key|auth/i, 'the provider refusal reaches the chat');
    for (const f of readdirSync(data, { recursive: true }) as string[]) {
      const p = join(data, f);
      try { assert.ok(!readFileSync(p, 'utf8').includes('sk-ant-not-a-real-key-123'), `the key is in ${f}`); } catch (e) { if ((e as { code?: string }).code !== 'EISDIR') throw e; }
    }
  } finally {
    ports = host.ports;
    host.stop();
  }
  assert.equal(host.status.state, 'off');
  await new Promise((r) => setTimeout(r, 500));
  for (const port of [ports.router, ports.agent]) await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }), `port ${port} still answers after stop`);
});

test('the servers answer the app only; a stop during a start ends it; a settings save restarts only on a change', { skip: !installed && 'platform agent not installed', timeout: 180_000 }, async () => {
  const { request } = await import('node:http');
  const get = (port: number, headers: Record<string, string>) => new Promise<number>((res, rej) => { const r = request({ host: '127.0.0.1', port, path: '/api/health', headers }, (x) => { x.resume(); res(x.statusCode ?? 0); }); r.on('error', rej); r.end(); });
  const data = mkdtempSync(join(tmpdir(), 'whiq-host-'));
  let model = 'claude-opus-5-5', slow = true;
  const host = new WhiqHost({ vendor, data }, () => ({
    providers: [{ name: 'main', type: 'anthropic', baseUrl: 'https://api.anthropic.com', key: 'sk-ant-not-a-real-key-123' }],
    tiers: [{ name: 'Strong', provider: 'main', model }],
  }), async () => [], async () => { if (slow) await new Promise((r) => setTimeout(r, 1500)); return {}; });
  const downs: string[] = [];
  host.onDown = (why) => downs.push(why);
  // a stop while the start waits for its services: the start ends, nothing of it is left running
  const first = host.start().catch((e: Error) => e);
  await new Promise((r) => setTimeout(r, 300));
  host.stop();
  assert.match(String(await first), /stopped while it was starting/);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(host.status.state, 'off');
  assert.deepEqual(host.ports, { router: 0, agent: 0 }, 'no server was started for the stopped start');
  slow = false;
  try {
    await host.start();
    const { router, agent } = host.ports;
    for (const port of [router, agent]) {
      assert.equal(await get(port, {}), 200, 'the app reaches it');
      assert.equal(await get(port, { origin: 'https://evil.example' }), 403, 'a web page does not');
      assert.equal(await get(port, { host: `evil.example:${port}` }), 403, 'nor a rebound name');
    }
    host.stopIfChanged('changed');
    assert.equal(host.status.state, 'ready', 'a save that changed nothing of the agent keeps it running');
    model = 'claude-sonnet-5-5';
    host.stopIfChanged('the models changed');
    assert.equal(host.status.state, 'off');
    assert.deepEqual(downs, ['the models changed'], 'the window is told the running agent went (once)');
  } finally { host.stop(); }
});
