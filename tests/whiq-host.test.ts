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
