// A disk cache of text readings (the encoder's unit vectors), so a name, a BOQ line or a claim heading read once is never
// read again: by the next request, after a restart, in another project or module. Exact: a vector comes back bit for
// bit as it was computed. Language-neutral, so the platform's Python sidecar (textenc.py) can keep the same files:
//
//   <root>/<model key>/model.txt        the model id the vectors belong to, one line (the key is sha256(id)[:16] hex)
//   <root>/<model key>/<xx>.bin         xx = the first byte of the text's sha256, in hex (256 shards)
//   a record (1,568 bytes) = sha256 of the text's UTF-8 bytes (32) + 384 float32 little-endian (the unit vector)
//
// Records are only appended; a shard is read whole the first time one of its texts is asked for. A short last record
// (a write cut by a crash) is ignored. A model id names the exact weights (name@revision:variant#sha of the file), so
// vectors of different weights never mix: the Node engine's fp16 ONNX and the Python fp32 model keep their own folders.
// Over the size limit (PQVAE_TEXT_CACHE_MB, default 512) a model's folder is emptied at start and fills again.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const DIM = 384, HASH = 32, RECORD = HASH + DIM * 4;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest();

export class TextCache {
  readonly dir: string;
  private shards = new Map<string, Map<string, Float32Array>>();
  /** what this run added, for the response / logs */
  hits = 0;
  misses = 0;

  constructor(root: string, modelId: string, limitMb = Number(process.env.PQVAE_TEXT_CACHE_MB) || 512) {
    this.dir = join(root, sha(modelId).toString('hex').slice(0, 16));
    mkdirSync(this.dir, { recursive: true });
    const size = readdirSync(this.dir).filter((f) => f.endsWith('.bin')).reduce((n, f) => n + statSync(join(this.dir, f)).size, 0);
    if (size > limitMb * 1048576) for (const f of readdirSync(this.dir)) if (f.endsWith('.bin')) rmSync(join(this.dir, f), { force: true });
    writeFileSync(join(this.dir, 'model.txt'), modelId + '\n');
  }

  private shard(h: Buffer): Map<string, Float32Array> {
    const name = h.subarray(0, 1).toString('hex');
    let m = this.shards.get(name);
    if (m) return m;
    m = new Map();
    const file = join(this.dir, `${name}.bin`);
    if (existsSync(file)) {
      const b = readFileSync(file);
      for (let at = 0; at + RECORD <= b.length; at += RECORD) {
        const v = new Float32Array(DIM);
        for (let d = 0; d < DIM; d++) v[d] = b.readFloatLE(at + HASH + d * 4);
        m.set(b.subarray(at, at + HASH).toString('hex'), v);
      }
    }
    this.shards.set(name, m);
    return m;
  }

  /** Whether a text was read before (no hit or miss counted). */
  has(text: string): boolean { const h = sha(Buffer.from(text, 'utf8')); return this.shard(h).has(h.toString('hex')); }

  /** The stored vector of a text, or undefined. */
  get(text: string): Float32Array | undefined {
    const h = sha(Buffer.from(text, 'utf8')), v = this.shard(h).get(h.toString('hex'));
    if (v) this.hits++; else this.misses++;
    return v;
  }

  /** Stores the vectors of newly read texts (appended, one write per shard). */
  put(entries: Iterable<[string, Float32Array]>): void {
    const out = new Map<string, Buffer[]>();
    for (const [text, v] of entries) {
      const h = sha(Buffer.from(text, 'utf8')), key = h.toString('hex'), m = this.shard(h);
      if (m.has(key) || v.length !== DIM) continue;
      m.set(key, v);
      const rec = Buffer.alloc(RECORD);
      h.copy(rec, 0);
      for (let d = 0; d < DIM; d++) rec.writeFloatLE(v[d], HASH + d * 4);
      const name = key.slice(0, 2);
      (out.get(name) ?? out.set(name, []).get(name)!).push(rec);
    }
    for (const [name, recs] of out) {
      try { appendFileSync(join(this.dir, `${name}.bin`), Buffer.concat(recs)); } catch { /* a cache: a failed write only costs a later re-read */ }
    }
  }
}
