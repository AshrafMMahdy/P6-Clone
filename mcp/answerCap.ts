/**
 * The answer-size rule (item 26, owner 2026-11-28: "Answer Size - Agreed, unify it"): the White Hat IQ platform's own long-result
 * rule, copied from its shared/chat-engine/server/resultCap.ts so that the clone holds the same rule when it runs without the
 * platform (the desktop app, an outside agent on its MCP). An answer over the limit is cut BY STRUCTURE — lists to their first
 * items with a count of the rest, long text clipped in the middle — and the whole answer is in a file whose path the answer names.
 * Behind the platform an answer the clone has cut already fits the platform's rule, so it is never cut twice.
 */

const MORE = (n: number): string => `… +${n} more (the whole answer is in the file named by result_truncated)`;

/** One structural pass: arrays longer than `arrayKeep` lose their tail, strings longer than `stringKeep` their middle. */
function shrink(value: unknown, arrayKeep: number, stringKeep: number): unknown {
  if (typeof value === 'string') {
    if (value.length <= stringKeep) return value;
    const head = Math.floor(stringKeep * 0.75), tail = stringKeep - head;
    return `${value.slice(0, head)} …[${value.length - stringKeep} characters cut]… ${value.slice(-tail)}`;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, arrayKeep).map((v) => shrink(v, arrayKeep, stringKeep));
    return value.length > arrayKeep ? [...kept, MORE(value.length - arrayKeep)] : kept;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shrink(v, arrayKeep, stringKeep);
    return out;
  }
  return value;
}

/** The platform's ladder (resultCap.ts): lists 50 → 20 → 8 → 3 → 1 items, text 4,000 → 1,500 → 500 → 200 → 80 characters, the
 *  first step that fits is taken; nothing fits (one enormous text, a flat object with thousands of keys): a plain cut of the JSON,
 *  never under the platform's floor of 8,192 characters. */
const LADDER: Array<[number, number]> = [[50, 4000], [20, 1500], [8, 500], [3, 200], [1, 80]];
const FLOOR_CHARS = 8 * 1024;

export interface CutAnswer { value: unknown; keptChars: number; itemsKept: number }

/** `out` (its JSON `text` is over `maxChars`) cut to at most `maxChars` characters of JSON, by structure. */
export function cutAnswer(out: unknown, text: string, maxChars: number): CutAnswer {
  for (const [arrayKeep, stringKeep] of LADDER) {
    const cut = shrink(out, arrayKeep, stringKeep);
    const s = JSON.stringify(cut);
    if (s.length <= maxChars) return { value: cut, keptChars: s.length, itemsKept: arrayKeep };
  }
  // the cut text goes into the answer as a string: its quotes and backslashes are escaped there, so the slice is sized by its
  // escaped length (a flat object of 20,000 keys came back at 172,838 characters: blind review, item 26)
  const limit = Math.max(FLOOR_CHARS, maxChars) - 200;
  let n = Math.min(text.length, limit);
  for (let esc = JSON.stringify(text.slice(0, n)).length; esc > limit && n > 0; esc = JSON.stringify(text.slice(0, n)).length) n = Math.max(0, Math.floor((n * limit) / esc) - 16);
  const plain = `${text.slice(0, n)} …[${text.length - n} characters cut]`;
  return { value: plain, keptChars: JSON.stringify(plain).length, itemsKept: 0 };
}

/** The note a cut answer carries, so the caller knows it is partial and where the whole answer is (the platform's wording). */
export function truncationNote(originalChars: number, cut: CutAnswer, fullPath: string | null, ask: string): Record<string, unknown> {
  return {
    original_chars: originalChars,
    kept_chars: cut.keptChars,
    ...(fullPath ? { full_result_path: fullPath } : { full_result_missing: 'the whole answer could not be written to a file' }),
    note: `This answer was ${Math.round(originalChars / 1024)} KB — too large to read in one turn, so ${cut.itemsKept ? `lists were cut to their first ${cut.itemsKept} items and long text clipped` : 'it was cut to its first part'}.`
      + (fullPath ? ` The whole answer is saved at ${fullPath}: read the file for the rest${ask}.`
        : ` The whole answer could NOT be saved, so the cut part is not available anywhere: do not treat this as the whole answer${ask || ' — ask the tool for less'}.`),
  };
}
