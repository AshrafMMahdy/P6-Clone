import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRequest, parseReply, AiStore, type ChatRequest } from '../main/ai.ts';
import { runTool, TOOLS } from '../core/query/tools.ts';
import { parseXer } from '../core/xer/parse.ts';
import { makeCtx } from '../renderer/model.ts';
import { realSamples } from './helpers.ts';

const req: ChatRequest = { system: 'sys', tools: [TOOLS[0]], messages: [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'checking', toolCalls: [{ id: 't1', name: 'project_summary', args: {} }, { id: 't2', name: 'critical_path', args: { limit: 3 } }] },
  { role: 'tool', toolCallId: 't1', name: 'project_summary', content: '{"a":1}' },
  { role: 'tool', toolCallId: 't2', name: 'critical_path', content: '{"b":2}' },
] };

test('Anthropic and OpenAI-compatible requests and replies', () => {
  const a = buildRequest({ enabled: true, provider: 'anthropic', baseUrl: 'https://api.anthropic.com/', model: 'm' }, 'k', req) as any;
  assert.equal(a.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(a.headers['x-api-key'], 'k');
  assert.equal(a.body.system, 'sys');
  assert.equal(a.body.messages.length, 3); // the two tool results share one user message
  assert.deepEqual(a.body.messages[2].content.map((b: any) => b.tool_use_id), ['t1', 't2']);
  assert.equal(a.body.tools[0].input_schema.type, 'object');
  const ar = parseReply({ provider: 'anthropic' } as any, { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'x', name: 'get_activity', input: { activity_id: 'A1' } }], stop_reason: 'tool_use' });
  assert.deepEqual(ar, { content: 'Hello', toolCalls: [{ id: 'x', name: 'get_activity', args: { activity_id: 'A1' } }], stop: 'tool_use' });

  const o = buildRequest({ enabled: true, provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'local' }, '', req) as any;
  assert.equal(o.url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(o.headers.authorization, undefined); // LM Studio needs no key
  assert.equal(o.body.messages[0].role, 'system');
  assert.equal(o.body.messages[2].tool_calls[1].function.arguments, '{"limit":3}');
  assert.equal(o.body.messages[3].role, 'tool');
  const or = parseReply({ provider: 'openai' } as any, { choices: [{ message: { content: null, tool_calls: [{ id: 'c', function: { name: 'find_activities', arguments: '{"text":"pour"}' } }] }, finish_reason: 'tool_calls' }] });
  assert.deepEqual(or.toolCalls, [{ id: 'c', name: 'find_activities', args: { text: 'pour' } }]);
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
  assert.match((runTool('get_activity', { activity_id: 'NOPE' }, db, ctx, ids, 8) as any).error, /No activity/);
});

test('extra headers and request parameters are merged, validated, and headers stored encrypted', () => {
  const cfg = { enabled: true, provider: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'm', extraHeaders: 'anthropic-beta: tools-2026\n# comment\nX-Gateway: abc', extraBody: '{"temperature": 0.2, "top_p": 0.9, "max_tokens": 8000}' };
  const r = buildRequest(cfg, 'k', req) as any;
  assert.equal(r.headers['anthropic-beta'], 'tools-2026');
  assert.equal(r.headers['X-Gateway'], 'abc');
  assert.equal(r.headers['x-api-key'], 'k');
  assert.equal(r.body.temperature, 0.2);
  assert.equal(r.body.max_tokens, 8000); // overrides the default
  assert.equal(r.body.messages.length, 3); // the assistant's own fields are kept
  assert.throws(() => buildRequest({ ...cfg, extraBody: '{"messages": []}' }, 'k', req), /cannot set messages/);
  assert.throws(() => buildRequest({ ...cfg, extraBody: '[1]' }, 'k', req), /JSON object/);
  assert.throws(() => buildRequest({ ...cfg, extraHeaders: 'not a header' }, 'k', req), /line 1/);

  const box = { available: () => true, encrypt: (s: string) => 'ENC:' + Buffer.from(s).toString('base64'), decrypt: (s: string) => Buffer.from(s.slice(4), 'base64').toString() };
  const file = join(mkdtempSync(join(tmpdir(), 'ai-')), 'ai.json');
  const store = new AiStore(file, box);
  store.save({ ...cfg, extraHeaders: 'X-Gateway-Token: very-secret' });
  assert.ok(!readFileSync(file, 'utf8').includes('very-secret'));
  assert.equal(store.publicConfig().extraHeaders, 'X-Gateway-Token: very-secret');
  assert.equal(store.config().extraBody, cfg.extraBody);
  assert.throws(() => store.save({ ...cfg, extraBody: '{bad' }), /not valid JSON/);
});
