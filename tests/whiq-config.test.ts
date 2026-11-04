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
