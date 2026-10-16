import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory } from '../renderer/ai/context.ts';
import type { ChatMsg } from '../main/ai.ts';

test('conversation memory: kept whole while small, trimmed oldest-first when large, always valid', () => {
  const turn = (q: string, big: number): ChatMsg[] => [
    { role: 'user', content: q },
    { role: 'assistant', content: '', toolCalls: [{ id: q, name: 'find_activities', args: {} }] },
    { role: 'tool', toolCallId: q, name: 'find_activities', content: 'x'.repeat(big) },
    { role: 'assistant', content: `answer to ${q}` },
  ];
  const small = [...turn('q1', 100), ...turn('q2', 100)];
  assert.equal(compactHistory(small), small); // unchanged: follow-ups see everything
  const big = [...turn('q1', 50_000), ...turn('q2', 50_000), ...turn('q3', 50_000), ...turn('q4', 50_000)];
  const c = compactHistory(big, 120_000);
  assert.equal(c[0].role, 'user'); // still starts with a question
  assert.ok(c.some((m) => m.role === 'user' && m.content === 'q4') && c.some((m) => m.role === 'user' && m.content === 'q3')); // latest two kept
  const last = c.filter((m) => m.role === 'tool').slice(-2);
  assert.ok(last.every((m) => m.content.length === 50_000)); // latest lookups intact
  assert.ok(c.reduce((a, m) => a + (m.content?.length ?? 0), 0) <= 120_000 + 1000);
});
