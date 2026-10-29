// Conversation memory for the AI assistant: everything is sent again with each question, trimmed to fit.
import type { ChatMsg } from '../../main/ai.ts';

const CONTEXT_CHARS = 240_000; // about 60k tokens of conversation sent per request

/**
 * The conversation is remembered between questions. To stay within the model's limit, older lookup results are
 * shortened first, then the oldest whole questions are dropped (the latest questions are always kept in full).
 */
export function compactHistory(h: ChatMsg[], limit = CONTEXT_CHARS): ChatMsg[] {
  const size = (m: ChatMsg[]) => m.reduce((a, x) => a + (x.content?.length ?? 0) + JSON.stringify((x as { toolCalls?: unknown }).toolCalls ?? '').length + JSON.stringify((x as { raw?: unknown }).raw ?? '').length, 0);
  if (size(h) <= limit) return h;
  const userIdx = h.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const keepFrom = userIdx[Math.max(0, userIdx.length - 2)] ?? 0; // the last two questions stay untouched
  let out = h.map((m, i) => (i < keepFrom && m.role === 'tool' && m.content.length > 400 ? { ...m, content: '(earlier lookup result removed to save space; look it up again if needed)' } : m));
  while (size(out) > limit) {
    const next = out.findIndex((m, i) => i > 0 && m.role === 'user');
    if (next <= 0 || next >= out.length - 1) break;
    out = out.slice(next); // drop the oldest question with its answer and lookups (still starts with a user message)
  }
  return out;
}
