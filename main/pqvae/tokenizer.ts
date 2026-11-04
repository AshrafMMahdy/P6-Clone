// The MiniLM tokenizer (XLM-R SentencePiece Unigram) from its tokenizer.json, with the Hugging Face `tokenizers` behaviour for this file:
//   added tokens (<s> <pad> </s> <unk> <mask>) cut out of the raw text -> Precompiled normaliser (SentencePiece's nmt_nfkc character map, a
//   double-array trie, applied per grapheme) -> WhitespaceSplit -> Metaspace (every word gets a leading "▁", split again at each "▁")
//   -> Unigram Viterbi per piece (unknown characters fused into one <unk>) -> <s> ... </s>, at most 128 ids.
// tests/pqvae-parity.test.ts checks the ids against the Python tokenizer on ~3,400 texts (tests/fixtures/pqvae/tokenizer.json).

interface TokenizerJson {
  added_tokens: Array<{ id: number; content: string }>;
  normalizer: { type: string; precompiled_charsmap?: string };
  model: { type: string; unk_id: number; vocab: Array<[string, number]> };
  truncation?: { max_length: number } | null;
}

const WHITESPACE = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;   // Unicode White_Space, as Rust's char::is_whitespace
const SPECIAL = /(<s>|<pad>|<\/s>|<unk>|<mask>)/;
const K_UNK_PENALTY = 10;
const UNDERSCORE = '\u2581';

/** SentencePiece's precompiled character map: a darts-clone double array over UTF-8 bytes, then a pool of NUL-ended replacement strings. */
class CharsMap {
  private units: Uint32Array;
  private pool: Buffer;
  private segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  constructor(b64: string) {
    const b = Buffer.from(b64, 'base64');
    const size = b.readUInt32LE(0);
    this.units = new Uint32Array(size / 4);
    for (let i = 0; i < this.units.length; i++) this.units[i] = b.readUInt32LE(4 + 4 * i);
    this.pool = b.subarray(4 + size);
  }

  /** The pool offsets of every key that is a prefix of `key`, shortest first (darts-clone commonPrefixSearch). */
  private prefixes(key: Buffer): number[] {
    const u = this.units, out: number[] = [];
    let pos = 0, unit = u[pos];
    pos ^= ((unit >>> 10) << ((unit & 0x200) >>> 6)) >>> 0;
    for (let i = 0; i < key.length; i++) {
      const c = key[i];
      if (c === 0) break;
      pos = (pos ^ c) >>> 0;
      unit = u[pos];
      if (unit === undefined || (unit & 0x800000ff) >>> 0 !== c) return out;
      pos = (pos ^ (((unit >>> 10) << ((unit & 0x200) >>> 6)) >>> 0)) >>> 0;
      if ((unit >>> 8) & 1) out.push(u[pos] & 0x7fffffff);
    }
    return out;
  }

  private transform(chunk: string): string | null {
    const r = this.prefixes(Buffer.from(chunk, 'utf8'));
    if (!r.length) return null;
    let end = r[0];
    while (end < this.pool.length && this.pool[end] !== 0) end++;
    return this.pool.toString('utf8', r[0], end);
  }

  normalize(text: string): string {
    let out = '';
    for (const { segment: g } of this.segmenter.segment(text)) {
      if (Buffer.byteLength(g, 'utf8') < 6) { const t = this.transform(g); if (t !== null) { out += t; continue; } }
      for (const ch of g) out += this.transform(ch) ?? ch;
    }
    return out;
  }
}

export class Tokenizer {
  private cm: CharsMap | null;
  private ids = new Map<string, number>();
  private scores: number[] = [];
  private maxLen = 1;
  private minScore = Infinity;
  private unk: number;
  private special = new Map<string, number>();
  readonly maxTokens: number;

  constructor(json: TokenizerJson) {
    if (json.model.type !== 'Unigram') throw new Error(`tokenizer.json: model type ${json.model.type} is not Unigram`);
    this.cm = json.normalizer?.type === 'Precompiled' && json.normalizer.precompiled_charsmap ? new CharsMap(json.normalizer.precompiled_charsmap) : null;
    this.unk = json.model.unk_id;
    json.model.vocab.forEach(([tok, score], id) => {
      this.ids.set(tok, id);
      this.scores.push(score);
      if (score < this.minScore) this.minScore = score;
      const n = [...tok].length;
      if (n > this.maxLen) this.maxLen = n;
    });
    for (const t of json.added_tokens) this.special.set(t.content, t.id);
    this.maxTokens = json.truncation?.max_length ?? 128;
  }

  /** Viterbi over one pre-token (tokenizers' Unigram::encode_optimized). Returns the pieces; an unknown run is one piece. */
  private unigram(piece: string): number[] {
    const ch = [...piece], n = ch.length;
    const best = new Float64Array(n + 1), from = new Int32Array(n + 1).fill(-1), id = new Int32Array(n + 1);
    const unkScore = this.minScore - K_UNK_PENALTY;
    for (let s = 0; s < n; s++) {
      const base = best[s];
      let single = false;
      for (let len = 1; len <= Math.min(this.maxLen, n - s); len++) {
        const tid = this.ids.get(len === 1 ? ch[s] : ch.slice(s, s + len).join(''));
        if (tid === undefined) continue;
        const e = s + len, cand = this.scores[tid] + base;
        if (from[e] < 0 || cand > best[e]) { best[e] = cand; from[e] = s; id[e] = tid; }
        if (len === 1) single = true;
      }
      if (!single) {
        const cand = unkScore + base;
        if (from[s + 1] < 0 || cand > best[s + 1]) { best[s + 1] = cand; from[s + 1] = s; id[s + 1] = this.unk; }
      }
    }
    const out: number[] = [];
    let run: string[] = [];
    const flush = (): void => { if (run.length) { out.push(this.ids.get(run.reverse().join('')) ?? this.unk); run = []; } };
    for (let e = n; e > 0;) {
      const s = from[e];
      if (id[e] === this.unk) run.push(ch.slice(s, e).join(''));
      else { flush(); out.push(id[e]); }
      e = s;
    }
    flush();
    return out.reverse();
  }

  private body(text: string): number[] {
    const norm = this.cm ? this.cm.normalize(text) : text;
    const out: number[] = [];
    for (const w of norm.split(WHITESPACE)) {
      if (!w) continue;
      const s = w.startsWith(UNDERSCORE) ? w : UNDERSCORE + w;
      // split at every "▁", each piece keeping the one it starts with
      for (const p of s.split(UNDERSCORE).slice(1)) out.push(...this.unigram(UNDERSCORE + p));
    }
    return out;
  }

  /** <s> ids </s>, the ids cut to maxTokens - 2 (LongestFirst truncation of one sequence). */
  encode(text: string): number[] {
    const ids: number[] = [];
    for (const part of String(text).split(SPECIAL)) {
      if (!part) continue;
      const sp = this.special.get(part);
      if (sp !== undefined) ids.push(sp); else ids.push(...this.body(part));
    }
    const room = this.maxTokens - 2;
    return [this.special.get('<s>') ?? 0, ...ids.slice(0, room), this.special.get('</s>') ?? 2];
  }
}
