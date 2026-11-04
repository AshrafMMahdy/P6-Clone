// numpy's np.random.default_rng(seed).permutation(n), bit for bit: SeedSequence -> PCG64 (XSL-RR 128/64) -> Generator.shuffle
// (Fisher-Yates from the end, each j drawn by masked rejection from 32-bit halves). The shuffle null in /review_schedule uses seed 7.
// tests/pqvae-parity.test.ts checks the stream against numpy's (tests/fixtures/pqvae/rng.json).

const M32 = 0xffffffffn, M64 = (1n << 64n) - 1n, M128 = (1n << 128n) - 1n;
const MULT128 = (2549297995355413924n << 64n) + 4865540595714422341n;   // PCG_DEFAULT_MULTIPLIER_128

const mul32 = (a: number, b: number): number => Number((BigInt(a) * BigInt(b)) & M32);

/** numpy SeedSequence(seed).generate_state(4, uint64) for a non-negative integer seed. */
function seedState(seed: number | bigint): bigint[] {
  const INIT_A = 0x43b0d7e5, MULT_A = 0x931e8875, INIT_B = 0x8b51f9dd, MULT_B = 0x58f38ded, MIX_L = 0xca01f9dd, MIX_R = 0x4973f715;
  const entropy: number[] = [];
  let s = BigInt(seed);
  do { entropy.push(Number(s & M32)); s >>= 32n; } while (s > 0n);
  const pool = [0, 0, 0, 0];
  let hc = INIT_A;
  const hashmix = (value: number): number => {
    value = (value ^ hc) >>> 0;
    hc = mul32(hc, MULT_A);
    value = mul32(value, hc);
    return (value ^ (value >>> 16)) >>> 0;
  };
  const mix = (x: number, y: number): number => {
    const r = (mul32(MIX_L, x) - mul32(MIX_R, y)) >>> 0;
    return (r ^ (r >>> 16)) >>> 0;
  };
  for (let i = 0; i < 4; i++) pool[i] = hashmix(i < entropy.length ? entropy[i] : 0);
  for (let src = 0; src < 4; src++) for (let dst = 0; dst < 4; dst++) if (src !== dst) pool[dst] = mix(pool[dst], hashmix(pool[src]));
  for (let src = 4; src < entropy.length; src++) for (let dst = 0; dst < 4; dst++) pool[dst] = mix(pool[dst], hashmix(entropy[src]));
  hc = INIT_B;
  const words: number[] = [];
  for (let i = 0; i < 8; i++) {
    let v = (pool[i % 4] ^ hc) >>> 0;
    hc = mul32(hc, MULT_B);
    v = mul32(v, hc);
    words.push((v ^ (v >>> 16)) >>> 0);
  }
  const out: bigint[] = [];
  for (let i = 0; i < 8; i += 2) out.push(BigInt(words[i]) | (BigInt(words[i + 1]) << 32n));
  return out;
}

export class Pcg64 {
  private state = 0n;
  private inc: bigint;
  private half: number | null = null;   // the high 32 bits of the last draw, handed out by the next 32-bit request

  constructor(seed: number | bigint) {
    const v = seedState(seed);
    const initstate = (v[0] << 64n) | v[1];
    this.inc = (((v[2] << 64n) | v[3]) << 1n | 1n) & M128;
    this.step();
    this.state = (this.state + initstate) & M128;
    this.step();
  }

  private step(): void { this.state = (this.state * MULT128 + this.inc) & M128; }

  next64(): bigint {
    this.step();
    const rot = this.state >> 122n;
    const x = ((this.state >> 64n) ^ this.state) & M64;
    return ((x >> rot) | (x << ((64n - rot) & 63n))) & M64;
  }

  next32(): number {
    if (this.half !== null) { const h = this.half; this.half = null; return h; }
    const n = this.next64();
    this.half = Number(n >> 32n);
    return Number(n & M32);
  }

  /** A uniform integer in [0, max], numpy's random_interval. */
  interval(max: number): number {
    if (max === 0) return 0;
    let mask = max;
    mask |= mask >>> 1; mask |= mask >>> 2; mask |= mask >>> 4; mask |= mask >>> 8; mask |= mask >>> 16;
    mask >>>= 0;
    for (;;) { const v = (this.next32() & mask) >>> 0; if (v <= max) return v; }
  }

  /** Generator.permutation(n): arange(n) shuffled in place. */
  permutation(n: number): number[] {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i >= 1; i--) { const j = this.interval(i); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
}
