// Largest, smallest and append over arrays of any length. Spreading an array into Math.max, Math.min or push passes
// every element as an argument, and V8's stack holds about 100,000 of them: DCMA-14 and lint failed with "Maximum call
// stack size exceeded" at 228,000 activities. These loop instead, with the same answers (-Infinity / Infinity when
// empty, NaN when an element is NaN).
export function maxOf(a: ArrayLike<number>): number { let m = -Infinity; for (let i = 0; i < a.length; i++) { const v = a[i]; if (Number.isNaN(v)) return NaN; if (v > m) m = v; } return m; }
export function minOf(a: ArrayLike<number>): number { let m = Infinity; for (let i = 0; i < a.length; i++) { const v = a[i]; if (Number.isNaN(v)) return NaN; if (v < m) m = v; } return m; }
/** Append every element of b to a (in place); answers a. */
export function pushAll<T>(a: T[], b: Iterable<T>): T[] { for (const x of b) a.push(x); return a; }
