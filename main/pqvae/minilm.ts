// The multilingual text block of every featurizer (pqvae/whiqcodes/textenc.py): paraphrase-multilingual-MiniLM-L12-v2, 384-d, mean pooling
// over the tokens, L2 normalised, cached per distinct string: in memory, and on disk when the engine has a text cache (textCache.ts: a
// text read once is never read again, by any request, project or later run). The transformer is minilm.onnx (hidden states); the
// pooling is done here.
import type { Tokenizer } from './tokenizer.ts';
import { ort, type Session } from './runtime.ts';
import type { TextCache } from './textCache.ts';

export const TEXT_DIM = 384;
export const BATCH = 32;       // wasm: texts per run
export const BATCH_GPU = 256;  // DirectML: 32 per run reads 870 texts/s, 256 reads 2,700 (the GPU wants big runs)

/** A name with its digit runs and spaces normalised: "Pour slab L12 - bay 3" and "Pour slab L7 - bay 10" are one pattern. */
const pattern = (s: string): string => s.replace(/\p{Nd}+/gu, '#').replace(/\s+/g, ' ').trim();

export class MiniLm {
  private cache = new Map<string, Float32Array>();
  private alias: Map<string, string> | null = null;
  private tok: () => Tokenizer;
  private session: () => Promise<Session>;
  private disk: TextCache | null;
  /** texts per run: set by the engine from the provider */
  batch = Number(process.env.PQVAE_BATCH) || BATCH;
  /** counts the swaps of the disk cache: a warm() that began before one starts over (its readings came from the other provider) */
  private gen = 0;
  /** names a shared review stood in for: read exactly when the engine is idle (fill), so the next review is exact */
  private later = new Set<string>();
  /** Awaited before every batch: the server's yield-and-abort check (engines.tick). */
  readonly tick: () => Promise<void>;
  constructor(tok: () => Tokenizer, session: () => Promise<Session>, tick: () => Promise<void> = async () => undefined, disk: TextCache | null = null) { this.tok = tok; this.session = session; this.tick = tick; this.disk = disk; }

  /** For the length of one request, names that differ only in their digits share the first such name's vector (the first in `names`' order).
   *  Returns how many distinct vectors the names need. Large programmes only: it is not what the Python engine does. */
  share(names: Iterable<string>): number {
    const first = new Map<string, string>(), alias = new Map<string, string>();
    for (const s of names) { const p = pattern(s); alias.set(s, first.get(p) ?? first.set(p, s).get(p)!); }
    this.alias = alias;
    return first.size;
  }
  unshare(): void { this.alias = null; }
  /** The text encoder fell back to another provider: its readings are kept in another folder (textCache.ts), and nothing read so far is reused. */
  useDisk(d: TextCache | null): void { this.disk = d; this.cache.clear(); this.gen++; }
  /** The disk cache's folder and how often it answered since the engine started (/health), or null without one. */
  cacheStats(): { dir: string; hits: number; misses: number } | null { return this.disk ? { dir: this.disk.dir, hits: this.disk.hits, misses: this.disk.misses } : null; }
  /** How many of these texts were never read (neither in memory nor on disk). */
  unread(texts: Iterable<string>): number { let n = 0; for (const s of texts) if (!this.cache.has(s) && !this.disk?.has(s)) n++; return n; }
  /** Remembers texts to read exactly when the engine is idle. */
  readLater(texts: Iterable<string>): void { for (const s of texts) this.later.add(s); }
  /** Texts still waiting for their exact reading. */
  pending(): number { for (const s of this.later) if (this.cache.has(s) || this.disk?.has(s)) this.later.delete(s); return this.later.size; }
  /** Reads the waiting texts exactly (stopped by the engine's tick when a request comes: what was read is kept, the rest waits). */
  async fill(): Promise<void> { if (this.pending()) await this.warm([...this.later]); this.pending(); }
  /** The string whose vector stands for `s` (itself unless names are shared). */
  key(s: string): string { return this.alias?.get(s) ?? s; }

  /** Embeds the strings not cached yet, in batches of similar length. */
  async warm(strings: Iterable<string>): Promise<void> {
    let todo = [...new Set([...strings].map((s) => this.key(String(s))))].filter((s) => !this.cache.has(s)).sort();
    // what was read before (another request, project or run) comes from the disk, bit for bit
    if (this.disk) todo = todo.filter((s) => { const v = this.disk!.get(s); if (v) this.cache.set(s, v); return !v; });
    if (!todo.length) return;
    const tok = this.tok();
    const enc = todo.map((s) => ({ s, ids: tok.encode(s) })).sort((a, b) => a.ids.length - b.ids.length);
    const gen = this.gen;
    const [o, sess] = await Promise.all([ort(), this.session()]);
    if (gen !== this.gen) return this.warm(strings);   // the provider changed while the session loaded
    for (let at = 0; at < enc.length; at += this.batch) {
      await this.tick();
      const batch = enc.slice(at, at + this.batch);
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
      this.disk?.put(batch.map((b) => [b.s, this.cache.get(b.s)!] as [string, Float32Array]));   // each batch kept at once: an aborted request keeps its work
    }
  }

  /** The unit vector of a string; warm() must have seen it. */
  vec(s: string): Float32Array {
    const v = this.cache.get(this.key(String(s)));
    if (!v) throw new Error(`text not embedded yet: ${JSON.stringify(s)}`);
    return v;
  }
}
