// The decide seat (pqvae/decide_client.py and the seat pre-pass in sidecar.py): the platform's LLM Router answers, per activity name, which
// trade performs it and which build phase it belongs to. An improvement, never a dependency: no seat (424), router down, timeout or a
// malformed reply -> no answer, and the caller keeps its keyword -> MiniLM -> position chain.
//   POST {LLM_ROUTER_URL or http://127.0.0.1:5009}/api/decide  { state, questions: { key: { type: 'choice', instructions, criteria } } }
//     -> { answers: { key: { choice, probabilities, confidence } } }
import { PHASES, TRADES } from './schemas.ts';
import { PHASE_PROTO, TRADE_PROTO } from './tables.ts';
import { pyStr, truthy, type Rec } from './pyutil.ts';

const DEFAULT_ROUTER_URL = 'http://127.0.0.1:5009';
const TIMEOUT_MS = 10_000;   // Jev answers in tens of milliseconds; the bound is for a cold or absent router
const MIN_CONFIDENCE = 0.5;   // below this the caller keeps its own fallback for that question
const CHUNK = 100;            // 200 questions per call
const BACKOFF_MS = 60_000;    // after a failed call the seat is skipped for a minute: no stall on every pulse

type Question = { type: 'choice'; instructions: string; criteria: Record<string, string> };
type Answers = Record<string, Rec>;

const routerUrl = (): string => (process.env.LLM_ROUTER_URL || DEFAULT_ROUTER_URL).replace(/\/+$/, '');
const choice = (instructions: string, criteria: Record<string, string>): Question => ({ type: 'choice', instructions, criteria: { ...criteria } });

let warned = false;
function skip(reason: string): null {
  if (!warned) { warned = true; console.error(`[decide] no decision (${reason}) - the caller keeps its own path. This message appears once.`); }
  return null;
}

/** Ask the decide seat. The answers (keyed like `questions`) or null; never throws. */
export async function decide(state: string, questions: Record<string, Question>, timeoutMs = TIMEOUT_MS): Promise<Answers | null> {
  if (!Object.keys(questions).length || !truthy(state)) return skip(Object.keys(questions).length ? 'empty state' : 'no questions');
  let payload: unknown;
  try {
    const r = await fetch(`${routerUrl()}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }), signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 424) return skip('no decide seat configured');
    if (!r.ok) return skip(`router ${r.status}`);
    if (r.status !== 200) return skip(`router ${r.status}`);
    payload = await r.json();
  } catch (e) { return skip(`request failed: ${(e as Error).message}`); }   // refused, timeout, bad JSON
  const answers = payload && typeof payload === 'object' ? (payload as Rec).answers : null;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return skip('router returned no answers');
  for (const k of Object.keys(questions)) {
    const a = answers[k];
    if (!a || typeof a !== 'object' || Array.isArray(a)) return skip(`answer '${k}' missing`);
    if (!('choice' in a)) return skip(`answer '${k}' has no choice`);
  }
  return answers as Answers;
}

/** The option a choice answer picked: highest probability wins; null below MIN_CONFIDENCE or when the pick is not one of `options`. */
export function winner(answer: unknown, options: string[]): string | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const a = answer as Rec;
  const probs: Rec = a.probabilities && typeof a.probabilities === 'object' && !Array.isArray(a.probabilities) ? a.probabilities : {};
  const known: Record<string, number> = {};
  for (const [k, v] of Object.entries(probs)) if (options.includes(k) && typeof v === 'number') known[k] = v;
  const keys = Object.keys(known);
  let pick: unknown = a.choice;
  if (keys.length) { pick = keys[0]; for (const k of keys) if (known[k] > known[pick as string]) pick = k; }
  let conf = a.confidence;
  if (typeof conf !== 'number') conf = keys.length ? known[pick as string] ?? 0 : 0;
  if (typeof pick !== 'string' || !options.includes(pick) || conf < MIN_CONFIDENCE) return null;
  return pick;
}

// ── batched trade / phase pre-pass ─────────────────────────────────────────────
const TRADE_CRITERIA = Object.fromEntries(Object.entries(TRADE_PROTO).map(([k, ps]) => [k, ps.join('; ')]));   // the prototypes MiniLM compares against
const PHASE_CRITERIA = Object.fromEntries(Object.entries(PHASE_PROTO).map(([k, ps]) => [k, ps.join('; ')]));
const Q_TRADE = (i: number): string => `Activity a${i} in the state: which construction trade performs it? Pick the single best trade; activity names may be in Finnish, Swedish, German or English.`;
const Q_PHASE = (i: number): string => `Activity a${i} in the state: which build phase of the project does it belong to? Pick the single best phase; activity names may be in Finnish, Swedish, German or English.`;

export type SeatHit = { trade: string | null; phase: string | null };
const cache = new Map<string, SeatHit>();   // activity name -> the seat's pick (null = unsure -> fallback), for the life of the process
let downUntil = 0;

const line = (i: number, r: Rec): string => {
  const ctx = ['wbs', 'wbs_name', 'parent', 'parent_name'].filter((k) => truthy(r?.[k])).map((k) => pyStr(r[k])).join(' / ');
  return `a${i}: ${truthy(r?.name) ? pyStr(r.name) : ''}` + (ctx ? `  [wbs: ${ctx}]` : '');
};

/** Trade + phase per activity name from the decide seat; {} (keep the old chain) when it answers nothing. `tick` runs between router calls (the
 *  server's abort check); `key` maps a name to the one asked in its place (names that share a reading share the seat's answer too). */
export async function seatTradePhase(recs: Rec[], tick: () => Promise<void> = async () => undefined, key: (s: string) => string = (s) => s): Promise<Map<string, SeatHit>> {
  const pending = new Map<string, Rec>();
  for (const r of recs) {
    const nm = truthy(r?.name) ? key(pyStr(r.name)) : '';
    if (nm && !cache.has(nm) && !pending.has(nm)) pending.set(nm, r);
  }
  if (pending.size && Date.now() >= downUntil) {
    const items = [...pending];
    for (let at = 0; at < items.length; at += CHUNK) {
      await tick();
      const chunk = items.slice(at, at + CHUNK);
      const state = chunk.map(([, r], i) => line(i, r)).join('\n');
      const qs: Record<string, Question> = {};
      for (let i = 0; i < chunk.length; i++) { qs[`a${i}_trade`] = choice(Q_TRADE(i), TRADE_CRITERIA); qs[`a${i}_phase`] = choice(Q_PHASE(i), PHASE_CRITERIA); }
      const ans = await decide(state, qs);
      if (!ans) { downUntil = Date.now() + BACKOFF_MS; break; }
      chunk.forEach(([nm], i) => cache.set(nm, { trade: winner(ans[`a${i}_trade`], TRADES), phase: winner(ans[`a${i}_phase`], PHASES) }));
    }
  }
  const out = new Map<string, SeatHit>();
  for (const r of recs) { const nm = truthy(r?.name) ? pyStr(r.name) : ''; const h = cache.get(key(nm)); if (h) out.set(nm, h); }
  return out;
}
