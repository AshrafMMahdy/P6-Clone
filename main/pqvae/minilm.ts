// The multilingual text block of every featurizer (pqvae/whiqcodes/textenc.py): paraphrase-multilingual-MiniLM-L12-v2, 384-d, mean pooling
// over the tokens, L2 normalised, cached per distinct string. The transformer is minilm.onnx (hidden states); the pooling is done here.
import type { Tokenizer } from './tokenizer.ts';
import { ort, type Session } from './runtime.ts';

export const TEXT_DIM = 384;
const BATCH = 32;

/** A name with its digit runs and spaces normalised: "Pour slab L12 - bay 3" and "Pour slab L7 - bay 10" are one pattern. */
const pattern = (s: string): string => s.replace(/\p{Nd}+/gu, '#').replace(/\s+/g, ' ').trim();

export class MiniLm {
  private cache = new Map<string, Float32Array>();
  private alias: Map<string, string> | null = null;
  private tok: () => Tokenizer;
  private session: () => Promise<Session>;
  /** Awaited before every batch: the server's yield-and-abort check (engines.tick). */
  readonly tick: () => Promise<void>;
  constructor(tok: () => Tokenizer, session: () => Promise<Session>, tick: () => Promise<void> = async () => undefined) { this.tok = tok; this.session = session; this.tick = tick; }

  /** For the length of one request, names that differ only in their digits share the first such name's vector (the first in `names`' order).
   *  Returns how many distinct vectors the names need. Large programmes only: it is not what the Python engine does. */
  share(names: Iterable<string>): number {
    const first = new Map<string, string>(), alias = new Map<string, string>();
    for (const s of names) { const p = pattern(s); alias.set(s, first.get(p) ?? first.set(p, s).get(p)!); }
    this.alias = alias;
    return first.size;
  }
  unshare(): void { this.alias = null; }
  /** The string whose vector stands for `s` (itself unless names are shared). */
  key(s: string): string { return this.alias?.get(s) ?? s; }

  /** Embeds the strings not cached yet, in batches of similar length. */
  async warm(strings: Iterable<string>): Promise<void> {
    const todo = [...new Set([...strings].map((s) => this.key(String(s))))].filter((s) => !this.cache.has(s)).sort();
    if (!todo.length) return;
    const tok = this.tok();
    const enc = todo.map((s) => ({ s, ids: tok.encode(s) })).sort((a, b) => a.ids.length - b.ids.length);
    const [o, sess] = await Promise.all([ort(), this.session()]);
    for (let at = 0; at < enc.length; at += BATCH) {
      await this.tick();
      const batch = enc.slice(at, at + BATCH);
      const len = batch[batch.length - 1].ids.length;
      const ids = new BigInt64Array(batch.length * len).fill(1n), mask = new BigInt64Array(batch.length * len);
      batch.forEach((b, i) => b.ids.forEach((t, j) => { ids[i * len + j] = BigInt(t); mask[i * len + j] = 1n; }));
      const r = await sess.run({ input_ids: new o.Tensor('int64', ids, [batch.length, len]), attention_mask: new o.Tensor('int64', mask, [batch.length, len]) });
      const h = r.hidden.data as Float32Array;
      batch.forEach((b, i) => {
        const v = new Float64Array(TEXT_DIM);
        for (let j = 0; j < b.ids.length; j++) for (let d = 0; d < TEXT_DIM; d++) v[d] += h[(i * len + j) * TEXT_DIM + d];
        let n = 0;
        for (let d = 0; d < TEXT_DIM; d++) { v[d] /= b.ids.length; n += v[d] * v[d]; }
        n = Math.max(Math.sqrt(n), 1e-12);
        this.cache.set(b.s, Float32Array.from(v, (x) => x / n));
      });
    }
  }

  /** The unit vector of a string; warm() must have seen it. */
  vec(s: string): Float32Array {
    const v = this.cache.get(this.key(String(s)));
    if (!v) throw new Error(`text not embedded yet: ${JSON.stringify(s)}`);
    return v;
  }
}
