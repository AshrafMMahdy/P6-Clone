import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendChat, clearChat, loadChat, moveChat } from '../main/ai-chats.ts';

test('AI chat logs: append-only per project, survive a cut-off line, clear and move', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p6chats-'));
  assert.deepEqual(loadChat(dir, 'a'), []);
  appendChat(dir, 'a', [{ n: 1 }, { n: 2 }]);
  appendChat(dir, 'b', [{ n: 'b1' }]);
  appendChat(dir, 'a', [{ n: 3 }]);
  assert.deepEqual(loadChat(dir, 'a'), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  // a crash in the middle of a write leaves a partial last line: it is skipped
  const fa = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(fa.length, 2);
  for (const f of fa) appendFileSync(join(dir, f), '{"n":');
  assert.deepEqual(loadChat(dir, 'a'), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  // moving onto an existing conversation appends after it; onto a new one renames
  appendChat(dir, '_general', [{ n: 'g' }]);
  moveChat(dir, '_general', 'c');
  assert.deepEqual(loadChat(dir, 'c'), [{ n: 'g' }]);
  assert.deepEqual(loadChat(dir, '_general'), []);
  clearChat(dir, 'a');
  assert.deepEqual(loadChat(dir, 'a'), []);
  assert.deepEqual(loadChat(dir, 'b'), [{ n: 'b1' }]);
});
