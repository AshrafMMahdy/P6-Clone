// The multilingual text block of every featurizer (pqvae/whiqcodes/textenc.py): paraphrase-multilingual-MiniLM-L12-v2, 384-d, mean pooling
// over the tokens, L2 normalised, cached per distinct string. The transformer is minilm.onnx (hidden states); the pooling is done here.
import type { Tokenizer } from './tokenizer.ts';
import { ort, type Session } from './runtime.ts';

export const TEXT_DIM = 384;
const BATCH = 32;

export class MiniLm {
  private cache = new Map<string, Float32Array>();
  private tok: () => Tokenizer;
  private session: () => Promise<Session>;
  constructor(tok: () => Tokenizer, session: () => Promise<Session>) { this.tok = tok; this.session = session; }

  /** Embeds the strings not cached yet, in batches of similar length. */
  async warm(strings: Iterable<string>): Promise<void> {
    const todo = [...new Set([...strings].map(String))].filter((s) => !this.cache.has(s)).sort();
    if (!todo.length) return;
    const tok = this.tok();
    const enc = todo.map((s) => ({ s, ids: tok.encode(s) })).sort((a, b) => a.ids.length - b.ids.length);
    const [o, sess] = await Promise.all([ort(), this.session()]);
    for (let at = 0; at < enc.length; at += BATCH) {
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
    const v = this.cache.get(String(s));
    if (!v) throw new Error(`text not embedded yet: ${JSON.stringify(s)}`);
    return v;
  }
}
