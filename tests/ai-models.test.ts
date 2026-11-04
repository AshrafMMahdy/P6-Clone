// AI settings as the platform's AI Providers page has them, for one user: providers each with its own key (sealed, kept
// across a rename by its id), tiers in order, seats on tiers; old single-provider settings read once into that shape;
// the simple one-model setup keeps everything else; a broken setup is refused with nothing saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiStore, type PublicModels } from '../main/ai.ts';

const box = { available: () => true, encrypt: (s: string) => `enc:${Buffer.from(s).toString('base64')}`, decrypt: (s: string) => Buffer.from(s.slice(4), 'base64').toString() };
const fresh = () => join(mkdtempSync(join(tmpdir(), 'aimodels-')), 'ai-assistant.json');

test('old single-provider settings are read as provider "main" and tier "Main"', () => {
  const f = fresh();
  writeFileSync(f, JSON.stringify({ enabled: true, provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'gpt-x', key: box.encrypt('sk-old-12345678'), keyEnc: true, keyHint: '…5678' }));
  const s = new AiStore(f, box);
  const m = s.publicModels();
  assert.deepEqual(m.providers.map((p) => [p.id, p.kind, p.hasKey]), [['main', 'openai', true]]);
  assert.deepEqual(m.tiers, [{ name: 'Main', provider: 'main', model: 'gpt-x' }]);
  assert.equal(s.key(), 'sk-old-12345678');
  assert.equal(s.publicConfig().model, 'gpt-x');
  const a = s.agentModels();
  assert.deepEqual(a.providers, [{ name: 'main', type: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', key: 'sk-old-12345678', headers: {} }]);
});

test('several providers, tiers and seats; keys by id survive a rename; refusals save nothing', () => {
  const f = fresh(), s = new AiStore(f, box);
  const m: PublicModels = {
    enabled: true, actions: true, encrypted: true, seats: { vision_ocr: 'Eyes', skeptic: 'Quick' },
    providers: [
      { id: 'p1', name: 'Anthropic', kind: 'anthropic', baseUrl: '', extraHeaders: '', extraBody: '', hasKey: false, keyHint: '' },
      { id: 'p2', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', extraHeaders: 'X-Title: P6', extraBody: '', hasKey: false, keyHint: '' },
    ],
    tiers: [{ name: 'Strong', provider: 'p1', model: 'claude-opus-5-5' }, { name: 'Quick', provider: 'p1', model: 'claude-haiku-5-5', params: '{"temperature": 0.2}' }, { name: 'Eyes', provider: 'p2', model: 'vlm-1' }],
  };
  s.saveModels(m, { p1: 'sk-ant-1111aaaa', p2: 'sk-or-2222bbbb' });
  assert.ok(!readFileSync(f, 'utf8').includes('sk-ant-1111aaaa') && !readFileSync(f, 'utf8').includes('X-Title'), 'keys and headers sealed on disk');
  const a = s.agentModels();
  assert.deepEqual(a.providers.map((p) => [p.name, p.type, p.key]), [['p1', 'anthropic', 'sk-ant-1111aaaa'], ['p2', 'openai-compat', 'sk-or-2222bbbb']]);
  assert.equal(a.providers[0].baseUrl, 'https://api.anthropic.com', 'an empty endpoint is the kind\'s own');
  assert.deepEqual(a.tiers.map((t) => t.name), ['Strong', 'Quick', 'Eyes']);
  assert.deepEqual(a.tiers[1].params, { temperature: 0.2 });
  assert.deepEqual(a.seats, { vision_ocr: 'Eyes', skeptic: 'Quick' });
  assert.equal(s.publicModels().providers[1].extraHeaders, 'X-Title: P6');
  assert.deepEqual(a.providers[1].headers, { 'X-Title': 'P6' }, 'extra headers reach the agent');
  // a rename keeps the key (by id); no key given keeps it
  const renamed = s.publicModels(); renamed.providers[0].name = 'Claude';
  s.saveModels(renamed);
  assert.equal(s.agentModels().providers[0].key, 'sk-ant-1111aaaa');
  // refusals: nothing saved
  const before = readFileSync(f, 'utf8');
  const bad = (change: (x: PublicModels) => void, re: RegExp) => { const x = s.publicModels(); change(x); assert.throws(() => s.saveModels(x), re); assert.equal(readFileSync(f, 'utf8'), before); };
  bad((x) => { x.tiers[0].provider = 'nope'; }, /names no provider/);
  bad((x) => { x.seats.agent = 'Nope'; }, /names no tier/);
  bad((x) => { x.tiers[1].name = 'Strong'; }, /Two tiers/);
  bad((x) => { x.providers[1].name = 'claude'; }, /Two providers/);
  bad((x) => { x.tiers[0].params = '[1]'; }, /JSON object/);
  // the simple setup changes the main agent's provider and tier only
  s.save({ enabled: true, provider: 'anthropic', baseUrl: '', model: 'claude-opus-6', actions: true });
  const after = s.publicModels();
  assert.deepEqual(after.tiers.map((t) => `${t.name}:${t.model}`), ['Strong:claude-opus-6', 'Quick:claude-haiku-5-5', 'Eyes:vlm-1']);
  assert.equal(after.providers.length, 2);
  assert.equal(s.agentModels().providers[1].key, 'sk-or-2222bbbb');
});
