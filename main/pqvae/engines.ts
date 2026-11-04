// The models, loaded lazily on first use and kept warm (a chat that never asks for a forecast never pays for the trajectory head).
// File names are the ones scripts/pqvae-export.py writes; the engine names are the ones the Python sidecar reports in /health.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSession, ort, type Session } from './runtime.ts';
import { Tokenizer } from './tokenizer.ts';
import { MiniLm } from './minilm.ts';
import { Semantic } from './normalise.ts';
import { FEATURE_DIM, FEATURE_DIM_B } from './features.ts';
import type { Rec } from './pyutil.ts';

const MAX_LEN = 256;      // the AR scorer's position table (ar_model.MAX_LEN)
const WINDOW_STRIDE = 128;
const WINDOWS_PER_RUN = 8;
export const MAX_PERIODS = 120;   // the trajectory head's position table (train_traj.MAX_P)

/** Thrown between batches when the client of the running request has gone. */
export class Aborted extends Error { constructor() { super('request abandoned by its client'); } }

export class Engines {
  readonly dir: string;
  readonly loaded = new Set<string>();
  readonly text: MiniLm;
  readonly sem: Semantic;
  /** The running request's abort signal (requests run one at a time); the server sets it. */
  signal: AbortSignal | null = null;
  private tok: Tokenizer | null = null;
  private sessions = new Map<string, Promise<Session>>();
  private json = new Map<string, unknown>();

  constructor(dir: string) {
    this.dir = dir;
    this.tick = this.tick.bind(this);
    // the tokenizer and the encoder are loaded the first time a text is embedded
    this.text = new MiniLm(() => (this.tok ??= new Tokenizer(JSON.parse(readFileSync(join(this.dir, 'tokenizer.json'), 'utf8')))), () => this.session('minilm.onnx'), this.tick);
    this.sem = new Semantic(this.text);
  }

  /** Called between batches: yields to the event loop (a closed socket is only seen there, a synchronous wasm run never gives it a turn), then stops the request if its client has gone. */
  async tick(): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, 0));
    if (this.signal?.aborted) throw new Aborted();
  }

  /** A JSON file of the model folder, parsed once. */
  read<T = any>(name: string): T {
    if (!this.json.has(name)) {
      const f = join(this.dir, name);
      if (!existsSync(f)) throw new Error(`model data missing: ${f} (run scripts/pqvae-export.py)`);
      this.json.set(name, JSON.parse(readFileSync(f, 'utf8')));
    }
    return this.json.get(name) as T;
  }

  session(file: string): Promise<Session> {
    let s = this.sessions.get(file);
    if (!s) { s = loadSession(join(this.dir, file)); this.sessions.set(file, s); s.catch(() => this.sessions.delete(file)); }
    return s;
  }

  private async codes(file: string, engine: string, feats: Float32Array, dim: number): Promise<Int32Array> {
    const [o, s] = await Promise.all([ort(), this.session(file)]);
    this.loaded.add(engine);
    const n = feats.length / dim;
    const r = await s.run({ features: new o.Tensor('float32', feats, [n, dim]) });
    return Int32Array.from(r.codes.data as BigInt64Array, Number);
  }

  /** (n, 3) residual codes of activity features (vocab A); flat, row-major. */
  codesA(feats: Float32Array): Promise<Int32Array> { return this.codes('vocab_a_codes.onnx', 'tok_a', feats, FEATURE_DIM); }
  /** (n, 3) residual codes of period features (vocab B). */
  codesB(feats: Float32Array): Promise<Int32Array> { return this.codes('vocab_b_codes.onnx', 'traj', feats, FEATURE_DIM_B); }

  /** Per-activity NLL of a code sequence (n, 3) under the AR scorer. A programme longer than its 256 positions is scored in overlapping windows
   *  (starting fresh each), several windows to one run: the scorer is causal, so zeros after a short last window change nothing before it. */
  async nll(codes: Int32Array, ptype: number): Promise<Float64Array> {
    const n = codes.length / 3;
    if (n <= MAX_LEN) return this.arRun([codes], ptype).then((r) => r[0]);
    const starts: number[] = [];
    for (let s = 0; ; s += WINDOW_STRIDE) { starts.push(s); if (Math.min(s + MAX_LEN, n) === n) break; }
    const out = new Float64Array(n);
    for (let at = 0; at < starts.length; at += WINDOWS_PER_RUN) {
      await this.tick();
      const group = starts.slice(at, at + WINDOWS_PER_RUN);
      const ws = await this.arRun(group.map((s) => codes.subarray(s * 3, Math.min(s + MAX_LEN, n) * 3)), ptype);
      group.forEach((s, g) => { const e = Math.min(s + MAX_LEN, n); for (let p = s === 0 ? 0 : s + WINDOW_STRIDE; p < e; p++) out[p] = ws[g][p - s]; });
    }
    return out;
  }

  /** One AR run over sequences (zero-padded to the longest): each one's NLL per activity. */
  private async arRun(seqs: Int32Array[], ptype: number): Promise<Float64Array[]> {
    const [o, s] = await Promise.all([ort(), this.session('ar_nll.onnx')]);
    this.loaded.add('ar');
    const len = Math.max(...seqs.map((c) => c.length / 3));
    const flat = new BigInt64Array(seqs.length * len * 3);
    seqs.forEach((c, i) => c.forEach((v, j) => { flat[i * len * 3 + j] = BigInt(v); }));
    const r = await s.run({ codes: new o.Tensor('int64', flat, [seqs.length, len, 3]), ptype: new o.Tensor('int64', new BigInt64Array(seqs.length).fill(BigInt(ptype)), [seqs.length]) });
    const d = r.nll.data as Float32Array;
    return seqs.map((c, i) => Float64Array.from(d.subarray(i * len, i * len + c.length / 3)));
  }

  /** The trajectory head on (n, 3) period codes: [log overrun, log1p delay] as float32. */
  async head(codes: Int32Array, ptype: number): Promise<[number, number]> {
    const [o, s] = await Promise.all([ort(), this.session('trajectory_head.onnx')]);
    this.loaded.add('traj');
    const n = codes.length / 3;
    const r = await s.run({ codes: new o.Tensor('int64', BigInt64Array.from(codes, BigInt), [1, n, 3]), ptype: new o.Tensor('int64', BigInt64Array.of(BigInt(ptype)), [1]) });
    const d = r.pred.data as Float32Array;
    return [d[0], d[1]];
  }

  /** ar_calibration.json, duration_bands.json: read with the AR scorer (engine "ar"). */
  arData(): { cal: { clean_nll_mean: number; clean_nll_std: number }; bands: Record<string, Rec> } {
    return { cal: this.read('ar_calibration.json'), bands: this.read('duration_bands.json') };
  }
}
