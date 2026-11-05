// The embedded agent's router config, in the platform's terms: keys only by environment variable, tiers in the
// user's order (the agent's ladder), every chat seat on a tier (the agent's unless set), service seats only when set,
// refusals for a tier or seat naming something that is not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_SEATS, routerConfig } from '../main/whiq-config.ts';

test('router config: keys by environment only; tiers in order; seats default to the agent tier; service seats when set', () => {
  const { config, env } = routerConfig({
    providers: [{ name: 'main', type: 'anthropic', baseUrl: 'https://api.anthropic.com', key: 'sk-test-1' }, { name: 'eyes', type: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', key: 'sk-test-2' }],
    tiers: [{ name: 'Strong', provider: 'main', model: 'claude-opus-5-5' }, { name: 'Quick', provider: 'main', model: 'claude-haiku-5-5' }, { name: 'Eyes', provider: 'eyes', model: 'vlm-1' }],
    seats: { fast_retrieve: 'Quick', vision_ocr: 'Eyes', web_search: 'Eyes' },
  });
  assert.ok(!JSON.stringify(config).includes('sk-test'), 'no key in the file');
  assert.deepEqual(Object.values(env).sort(), ['sk-test-1', 'sk-test-2']);
  assert.deepEqual(config.tierOrder, ['Strong', 'Quick', 'Eyes']);
  const sched = (config.modules as { scheduler: Record<string, string> }).scheduler;
  for (const s of CHAT_SEATS) assert.ok(sched[s], s);
  assert.equal(sched.agent, 'Strong');
  assert.equal(sched.skeptic, 'Strong', 'an unset chat seat sits on the agent tier');
  assert.equal(sched.vision_ocr, 'Eyes');
  assert.equal(sched.web_search, 'Eyes');
  assert.equal(sched.embedding, undefined, 'a service seat is off unless set');
  const roles = config.roles as Record<string, { provider: string; model: string }>;
  assert.equal(roles.fast_retrieve.model, 'claude-haiku-5-5');
  assert.equal(sched.research, 'Strong', 'Researchers have a seat of their own');
  assert.equal(sched.handover, undefined, 'the Handover seat is no router seat');
  // unset seats follow the agent's tier, not the first; the Handover seat goes to the agent server
  const b = routerConfig({ providers: [{ name: 'main', type: 'anthropic', baseUrl: 'x', key: '' }], tiers: [{ name: 'Strong', provider: 'main', model: 'o' }, { name: 'Quick', provider: 'main', model: 'h' }], seats: { agent: 'Quick', handover: 'Strong' } });
  const bs = (b.config.modules as { scheduler: Record<string, string> }).scheduler;
  assert.equal(bs.skeptic, 'Quick'); assert.equal(bs.research, 'Quick');
  assert.deepEqual(b.agentEnv, { WHIQ_HANDOVER_TIER: 'Strong' });
  assert.deepEqual(routerConfig({ providers: [{ name: 'main', type: 'anthropic', baseUrl: 'x', key: '' }], tiers: [{ name: 'A', provider: 'main', model: 'm' }] }).agentEnv, {}, 'no Handover seat: the next tier up');
  const bad = (m: Parameters<typeof routerConfig>[0]) => () => routerConfig(m);
  const p = [{ name: 'main', type: 'anthropic' as const, baseUrl: 'x', key: '' }];
  assert.throws(bad({ providers: p, tiers: [{ name: 'A', provider: 'other', model: 'm' }] }), /no provider "other"/);
  assert.throws(bad({ providers: p, tiers: [{ name: 'A', provider: 'main', model: 'm' }], seats: { agent: 'Nope' } }), /no tier "Nope"/);
  assert.throws(bad({ providers: p, tiers: [] }), /No model tier/);
  assert.throws(bad({ providers: [], tiers: [] }), /No AI provider/);
});

test('router config: extra headers by environment only; any tier name, "constructor" too', () => {
  const { config, env } = routerConfig({
    providers: [{ name: 'gw', type: 'openai-compat', baseUrl: 'https://gw.example/v1', key: '', headers: { 'X-Gateway-Token': 'gw-secret-1' } }],
    tiers: [{ name: 'constructor', provider: 'gw', model: 'm' }, { name: '__proto__x', provider: 'gw', model: 'n' }],
  });
  assert.ok(!JSON.stringify(config).includes('gw-secret-1'), 'no header value in the file');
  const p = (config.providers as Record<string, { headersEnv?: string }>).gw;
  assert.deepEqual(JSON.parse(env[p.headersEnv!]), { 'X-Gateway-Token': 'gw-secret-1' });
  assert.deepEqual(config.tierOrder, ['constructor', '__proto__x']);
});

test('router config: an unset Web search seat sits on the agent tier when its provider can search; Speech to text tells the agent server', () => {
  const tiers = (provider: string) => [{ name: 'Main', provider, model: 'm' }];
  const sched = (provider: { type: 'anthropic' | 'openai-compat' | 'gemini'; baseUrl: string }, seats?: Record<string, string>) =>
    (routerConfig({ providers: [{ name: 'p', key: '', ...provider }], tiers: tiers('p'), seats }).config.modules as { scheduler: Record<string, string> }).scheduler;
  assert.equal(sched({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' }).web_search, 'Main');
  assert.equal(sched({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }).web_search, 'Main');
  assert.equal(sched({ type: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' }).web_search, 'Main');
  assert.equal(sched({ type: 'openai-compat', baseUrl: 'http://localhost:1234/v1' }).web_search, undefined, 'a provider that cannot search: off');
  assert.equal(sched({ type: 'openai-compat', baseUrl: 'https://api.openai.com/v1' }).web_search, undefined);
  // the default follows the AGENT's tier, and a seat the user set wins
  const two = routerConfig({
    providers: [{ name: 'local', type: 'openai-compat', baseUrl: 'http://localhost:1234/v1', key: '' }, { name: 'claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', key: '' }],
    tiers: [{ name: 'Local', provider: 'local', model: 'a' }, { name: 'Claude', provider: 'claude', model: 'b' }],
    seats: { agent: 'Claude' },
  });
  assert.equal((two.config.modules as { scheduler: Record<string, string> }).scheduler.web_search, 'Claude');
  const own = routerConfig({ providers: [{ name: 'claude', type: 'anthropic', baseUrl: 'x', key: '' }, { name: 'l', type: 'openai-compat', baseUrl: 'y', key: '' }], tiers: [{ name: 'Claude', provider: 'claude', model: 'b' }, { name: 'L', provider: 'l', model: 'a' }], seats: { web_search: 'L' } });
  assert.equal((own.config.modules as { scheduler: Record<string, string> }).scheduler.web_search, 'L');
  // speech to text: no default; a set seat is announced to the agent server (it offers transcribe_audio then)
  const none = routerConfig({ providers: [{ name: 'p', type: 'anthropic', baseUrl: 'x', key: '' }], tiers: tiers('p') });
  assert.equal((none.config.modules as { scheduler: Record<string, string> }).scheduler.stt, undefined);
  assert.equal(none.agentEnv.WHIQ_STT_SEAT, undefined);
  const stt = routerConfig({ providers: [{ name: 'p', type: 'anthropic', baseUrl: 'x', key: '' }, { name: 'w', type: 'openai-compat', baseUrl: 'https://api.openai.com/v1', key: '' }], tiers: [{ name: 'Main', provider: 'p', model: 'm' }, { name: 'Whisper', provider: 'w', model: 'whisper-1' }], seats: { stt: 'Whisper' } });
  assert.equal(stt.agentEnv.WHIQ_STT_SEAT, 'on');
});
