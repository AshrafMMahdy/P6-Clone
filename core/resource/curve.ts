// P6 resource curves (RSRCCURVDATA): pct_usage_0 is the share placed at the start instant, pct_usage_1..20 the
// shares of twenty equal 5% slices of the assignment's work time. Units are spread by cumulative share.
import type { Row } from '../db.ts';

export type Curve = number[]; // 21 percentages

export function curveOf(row: Row | undefined): Curve | null {
  if (!row) return null;
  const c = Array.from({ length: 21 }, (_, i) => Number(row[`pct_usage_${i}`] || 0));
  const sum = c.reduce((a, x) => a + x, 0);
  if (!(sum > 0)) return null;
  return c.map((x) => (x * 100) / sum); // normalise in case the stored points do not add up to exactly 100
}

/** Cumulative fraction (0..1) of units used by elapsed work-time fraction f (0..1). */
export function cumulative(curve: Curve, f: number): number {
  if (f <= 0) return f < 0 ? 0 : curve[0] / 100;
  if (f >= 1) return 1;
  const x = f * 20;
  const k = Math.floor(x);
  let s = curve[0];
  for (let i = 1; i <= k; i++) s += curve[i];
  s += curve[k + 1] * (x - k);
  return s / 100;
}

/** Share of the units falling in the work-time fraction window [fa, fb] (the start instant belongs to fa = 0). */
export function shareBetween(curve: Curve | null, fa: number, fb: number): number {
  if (!curve) return Math.max(0, Math.min(1, fb) - Math.max(0, fa));
  const lo = fa <= 0 ? 0 : cumulative(curve, fa);
  return cumulative(curve, fb) - (fa <= 0 ? 0 : lo);
}
