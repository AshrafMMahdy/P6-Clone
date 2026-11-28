import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRequest, parseReply, AiStore, type ChatRequest } from '../main/ai.ts';
import { runTool } from '../core/query/tools.ts';
import { parseXer } from '../core/xer/parse.ts';
import { makeCtx } from '../renderer/model.ts';
import { realSamples } from './helpers.ts';

// the one direct model call left in the app: a tier's Test button (the assistant is the platform's agent; item 26 removed the panel's own loop)
const req: ChatRequest = { system: 'sys', messages: [{ role: 'user', content: 'hi' }] };

test('Anthropic and OpenAI-compatible requests and replies: one question, the reply\'s text', () => {
  const a = buildRequest({ enabled: true, provider: 'anthropic', baseUrl: 'https://api.anthropic.com/', model: 'm' }, 'k', req) as any;
  assert.equal(a.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(a.headers['x-api-key'], 'k');
  assert.equal(a.headers['anthropic-version'], '2026-10-21');
  assert.equal(a.body.system, 'sys');
  assert.deepEqual(a.body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal('tools' in a.body, false);
  assert.deepEqual(parseReply({ provider: 'anthropic' } as any, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hello' }], stop_reason: 'end_turn' }), { content: 'Hello', stop: 'end_turn' });
  const o = buildRequest({ enabled: true, provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'local' }, '', req) as any;
  assert.equal(o.url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(o.headers.authorization, undefined); // LM Studio needs no key
  assert.deepEqual(o.body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.deepEqual(parseReply({ provider: 'openai' } as any, { choices: [{ message: { content: 'ready.' }, finish_reason: 'stop' }] }), { content: 'ready.', stop: 'stop' });
});

test('the API key is stored encrypted and never in the public config', () => {
  const box = { available: () => true, encrypt: (s: string) => 'ENC:' + Buffer.from(s).toString('base64'), decrypt: (s: string) => Buffer.from(s.slice(4), 'base64').toString() };
  const store = new AiStore(join(mkdtempSync(join(tmpdir(), 'ai-')), 'ai.json'), box);
  const pub = store.save({ enabled: true, provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'x' }, 'sk-secret-123456');
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keyHint, '…3456');
  assert.ok(!JSON.stringify(pub).includes('secret'));
  assert.equal(store.key(), 'sk-secret-123456');
  store.save({ ...pub, model: 'y' }); // saving without a key keeps it
  assert.equal(store.key(), 'sk-secret-123456');
  store.save(pub, '');
  assert.equal(store.publicConfig().hasKey, false);
});

test('project lookup tools answer from the database', () => {
  const db = parseXer(realSamples().find((s) => s.name === 'cairo festival city.xer')!.bytes).db;
  const ctx = makeCtx(db, { hoursPerDay: 8, dateFormat: 'dd-MMM-yy', showTime: false, durationDecimals: 0 });
  const ids = db.tables.PROJECT.rows.map((p) => p.proj_id);
  const sum = runTool('project_summary', {}, db, ctx, ids, 8) as any;
  assert.equal(sum.activities, db.tables.TASK.rows.length);
  const found = runTool('find_activities', { text: 'water', limit: 5 }, db, ctx, ids, 8) as any;
  assert.ok(found.total_matches > 0 && found.activities.length <= 5);
  const one = runTool('get_activity', { activity_id: found.activities[0].id }, db, ctx, ids, 8) as any;
  assert.equal(one.id, found.activities[0].id);
  assert.ok(Array.isArray(one.predecessors));
  const health = runTool('schedule_health', {}, db, ctx, ids, 8) as any;
  assert.equal(typeof health.missing_predecessors.count, 'number');
  assert.ok((runTool('list_wbs', {}, db, ctx, ids, 8) as any).wbs.length > 0);
  assert.match((runTool('get_activity', { activity_id: 'NOPE' }, db, ctx, ids, 8) as any).error, /^Refused: no activity with ID "NOPE"/);
});

test('extra headers and request parameters are merged, validated, and headers stored encrypted', () => {
  const cfg = { enabled: true, provider: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'm', extraHeaders: 'anthropic-beta: tools-2026\n# comment\nX-Gateway: abc', extraBody: '{"temperature": 0.2, "top_p": 0.9, "max_tokens": 8000}' };
  const r = buildRequest(cfg, 'k', req) as any;
  assert.equal(r.headers['anthropic-beta'], 'tools-2026');
  assert.equal(r.headers['X-Gateway'], 'abc');
  assert.equal(r.headers['x-api-key'], 'k');
  assert.equal(r.body.temperature, undefined); // API version 2026-10-21 refuses sampling parameters: an old saved setting is not sent
  assert.equal(r.body.top_p, undefined);
  assert.equal(r.body.max_tokens, 8000); // overrides the default
  const o = buildRequest({ ...cfg, provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }, 'k', req) as any;
  assert.equal(o.body.temperature, 0.2); // OpenAI-compatible hosts still take them
  assert.deepEqual(r.body.messages, req.messages); // the assistant's own fields are kept
  assert.throws(() => buildRequest({ ...cfg, extraBody: '{"messages": []}' }, 'k', req), /cannot set messages/);
  assert.throws(() => buildRequest({ ...cfg, extraBody: '[1]' }, 'k', req), /JSON object/);
  assert.throws(() => buildRequest({ ...cfg, extraHeaders: 'not a header' }, 'k', req), /line 1/);

  const box = { available: () => true, encrypt: (s: string) => 'ENC:' + Buffer.from(s).toString('base64'), decrypt: (s: string) => Buffer.from(s.slice(4), 'base64').toString() };
  const file = join(mkdtempSync(join(tmpdir(), 'ai-')), 'ai.json');
  const store = new AiStore(file, box);
  const saved = { ...cfg, extraBody: '{"max_tokens": 8000}' };
  store.save({ ...saved, extraHeaders: 'X-Gateway-Token: very-secret' });
  assert.ok(!readFileSync(file, 'utf8').includes('very-secret'));
  assert.equal(store.publicConfig().extraHeaders, 'X-Gateway-Token: very-secret');
  assert.equal(store.config().extraBody, saved.extraBody);
  assert.throws(() => store.save({ ...cfg, extraBody: '{bad' }), /not valid JSON/);
  assert.throws(() => store.save({ ...cfg, extraBody: '{"temperature": 0.2}' }), /removed them in version 2026-10-21/);
  assert.doesNotThrow(() => store.save({ ...cfg, provider: 'openai', extraBody: '{"temperature": 0.2}' }));
});

test('a mistyped extra header is refused in words, never rewritten: a space, a typographic dash, an invisible character, "=" for ":"', async () => {
  const { parseExtraHeaders } = await import('../main/ai-extras.ts');
  for (const [line, why] of [['WORKSPACE ID: w', /contains " ", U\+0020, a space/], ['WORKSPACE\u2011ID: w', /contains "\u2011", U\+2011/], ['\u200bX-A: w', /contains "\u200b", U\+200B/], ['X-A = w', /write it as "Header-Name: value"/], ['X(A): b', /contains "\("/], ['no separator', /line 1/]] as const)
    assert.throws(() => parseExtraHeaders(line), why, line);
  assert.deepEqual(parseExtraHeaders('X-A: b=c:d\n# a comment\n'), { 'X-A': 'b=c:d' });
});

test('Anthropic reads its workspace from anthropic-workspace-id only: another spelling is refused with the right name; the right one in any case is sent', () => {
  const base = { enabled: true, provider: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'm' };
  for (const name of ['WORKSPACE-ID', 'workspace_id', 'Workspace'])
    assert.throws(() => buildRequest({ ...base, extraHeaders: `${name}: wrkspc_01ab` }, 'k', req), new RegExp(`Anthropic does not read "${name}"; its workspace header is anthropic-workspace-id \\(write "anthropic-workspace-id: wrkspc_01ab"\\)`), name);
  for (const name of ['Anthropic-Workspace-ID', 'anthropic-workspace-id']) assert.equal(buildRequest({ ...base, extraHeaders: `${name}: w` }, 'k', req).headers[name], 'w');
  assert.equal(buildRequest({ ...base, provider: 'openai', extraHeaders: 'WORKSPACE-ID: w' }, 'k', req).headers['WORKSPACE-ID'], 'w', 'another provider: its own header names');
});

test("Anthropic max_tokens is the model's own output limit (models.dev), never a fixed smaller number", async () => {
  const { __setModelsDevForTest } = await import('../main/modelsDev.ts');
  const { anthropicMaxTokens, outputLimitFromRefusal, ANTHROPIC_FALLBACK_OUTPUT } = await import('../main/ai.ts');
  __setModelsDevForTest({ anthropic: { models: { 'claude-opus-5-5': { limit: { output: 128000 } } } }, other: { models: { 'claude-cross': { limit: { output: 64000 } } } } });
  const cfg = { enabled: true, provider: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5' };
  assert.equal((buildRequest(cfg, 'k', req) as any).body.max_tokens, 128000);
  assert.equal(anthropicMaxTokens('claude-cross'), 64000); // listed under another provider
  assert.equal(anthropicMaxTokens('claude-unknown'), ANTHROPIC_FALLBACK_OUTPUT); // models.dev does not know it
  assert.equal(outputLimitFromRefusal('max_tokens: 32768 > 8192, which is the maximum allowed number of output tokens for claude-x', 32768), 8192);
  assert.equal(outputLimitFromRefusal('invalid x-api-key', 32768), null);
  __setModelsDevForTest(null);
  assert.equal((buildRequest(cfg, 'k', req) as any).body.max_tokens, ANTHROPIC_FALLBACK_OUTPUT); // not loaded yet
});
