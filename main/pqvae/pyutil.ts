// Python and numpy behaviours the sidecar's answers depend on: round() (exact, half to even), np.percentile, np.mean/np.std, truthiness, str().
// Same numbers as the Python sidecar to the rounding it shows.

export type Rec = Record<string, any>;

/** A Python KeyError: the message is the repr of the key, as the Python sidecar's HTTP 500 shows it. */
export class KeyErr extends Error { constructor(key: string) { super(`'${key}'`); } }

/** Python's round(x, nd): the exact decimal value of the double, ties to even. */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0 || Object.is(x, -0);
  const s = Math.abs(x).toFixed(100);   // the exact expansion: a double has at most ~1075 digits, a tie shows within 100
  const dot = s.indexOf('.');
  const int = s.slice(0, dot), frac = s.slice(dot + 1);
  const rest = frac.slice(nd);
  let up = false;
  if (rest[0] > '5') up = true;
  else if (rest[0] === '5') {
    if (/[1-9]/.test(rest.slice(1))) up = true;
    else { const last = (int + frac.slice(0, nd)).slice(-1); up = (Number(last) & 1) === 1; }   // an exact tie: to the even digit
  }
  const n = (BigInt(int + frac.slice(0, nd)) + (up ? 1n : 0n)).toString().padStart(nd + 1, '0');
  const v = Number(nd ? `${n.slice(0, -nd)}.${n.slice(-nd)}` : n);
  return neg ? -v : v;
}

/** np.percentile(values, p), linear interpolation (numpy's lerp form). */
export function percentile(values: number[], p: number): number {
  const v = Float64Array.from(values).sort();
  const n = v.length;
  const virt = (n - 1) * (p / 100);
  const lo = Math.floor(virt), hi = Math.min(lo + 1, n - 1);
  const t = virt - lo;
  const a = v[lo], b = v[hi], d = b - a;
  return t >= 0.5 ? b - d * (1 - t) : a + d * t;
}

export const mean = (v: ArrayLike<number>): number => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i]; return s / v.length; };
/** np.std (population, ddof 0). */
export const std = (v: ArrayLike<number>): number => { const m = mean(v); let s = 0; for (let i = 0; i < v.length; i++) s += (v[i] - m) ** 2; return Math.sqrt(s / v.length); };

/** Python truthiness: None, False, 0, "", [] and {} are false. */
export function truthy(v: unknown): boolean {
  if (v == null || v === false || v === 0 || v === '') return false;
  if (typeof v === 'number' && Number.isNaN(v)) return true;   // float('nan') is true in Python
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/** Python's str() for the values an activity record carries. */
export function pyStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Python's float(x) for a JSON value: numbers and numeric strings; anything else throws as Python's ValueError/TypeError would. */
export function pyFloat(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'string' && /^\s*[+-]?(inf|infinity|nan)\s*$/i.test(v)) return Number(v.replace(/inf(inity)?/i, 'Infinity').replace(/nan/i, 'NaN'));
  throw new TypeError(typeof v === 'string' ? `could not convert string to float: '${v}'` : `float() argument must be a string or a real number, not '${v == null ? 'NoneType' : typeof v}'`);
}

/** The dict entries whose value is not None, as `{k: v for k, v in r.items() if v is not None}`. */
export const dropNull = (r: Rec): Rec => { const o: Rec = {}; for (const k of Object.keys(r)) if (r[k] != null) o[k] = r[k]; return o; };
