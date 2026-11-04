// Per-company calibration at inference time (pqvae/whiqcodes/org_calib.py, the parts the scheduler's tools use): the company's own activity
// durations pull the corpus duration bands toward them with weight w = n / (n + 40); every blended answer says what was used.
import { percentile, pyFloat, pyRound, truthy, type Rec } from './pyutil.ts';

const N0 = 40;   // corpus pseudo-count
export const weight = (n: number): number => (n > 0 ? n / (n + N0) : 0);

export type Bands = Record<string, Rec>;
type Normalise = (recs: Rec[]) => Promise<Rec[]>;

const pools = new Map<string, Map<string, number[]>>();   // (orgId, builtAt) -> durations per "trade|phase", from the company's programmes

/** Durations per trade|phase from the company's programmes, trade/phase inferred by the sidecar's own mapper. Cached per (org, builtAt). */
async function programmeDurations(calib: Rec, normalise: Normalise): Promise<Map<string, number[]>> {
  const key = JSON.stringify([calib.orgId ?? null, calib.builtAt ?? null]);
  const hit = pools.get(key);
  if (hit) return hit;
  const pool = new Map<string, number[]>();
  for (const prog of calib.programmes ?? []) {
    const recs: Rec[] = prog?.records ?? [];
    if (recs.length < 5) continue;
    try {
      for (const r of await normalise(recs)) {
        const d = truthy(r.duration_days) ? pyFloat(r.duration_days) : 0;
        if (d > 0 && truthy(r.trade) && truthy(r.phase)) { const k = `${r.trade}|${r.phase}`; (pool.get(k) ?? pool.set(k, []).get(k)!).push(d); }
      }
    } catch { continue; }
  }
  if (pools.size > 32) pools.clear();
  pools.set(key, pool);
  return pool;
}

/** The corpus bands blended with the company's durations; with no company durations, the prior itself and an empty `used`. */
export async function blendDurationBands(prior: Bands, calib: Rec | null | undefined, normalise: Normalise): Promise<{ bands: Bands; used: Rec }> {
  const dur = new Map<string, number[]>();
  for (const [k, v] of Object.entries((calib?.duration ?? {}) as Rec)) dur.set(k, v);
  if (calib && truthy(calib.programmes)) for (const [k, v] of await programmeDurations(calib, normalise)) dur.set(k, [...(dur.get(k) ?? []), ...v]);
  if (!dur.size) return { bands: prior, used: {} };
  const out: Bands = { ...prior };
  const used: Rec = {};
  for (const [key, days] of dur) {
    const d = (days as unknown[]).filter((x) => truthy(x) && pyFloat(x) > 0).map(pyFloat);
    if (d.length < 5) continue;
    const w = weight(d.length);
    const p05 = percentile(d, 5), p95 = percentile(d, 95);
    const base = prior[key];
    out[key] = base
      ? { p05: pyRound((1 - w) * base.p05 + w * p05, 2), p95: pyRound((1 - w) * base.p95 + w * p95, 2), n: (base.n ?? 0) + d.length, org_w: pyRound(w, 2) }
      : { p05: pyRound(p05, 2), p95: pyRound(p95, 2), n: d.length, org_w: pyRound(w, 2) };
    used[key] = { n: d.length, w: pyRound(w, 2) };
  }
  return { bands: out, used };
}

/** Per-record magnitude flag: 0 inside the p05-p95 band of its trade|phase, else the ratio outside (3 places). */
export function flagDurations(bands: Bands, recs: Rec[]): number[] {
  return recs.map((r) => {
    const b = bands[`${r.trade}|${r.phase}`];
    if (!b) return 0;
    const d = r.duration_days as number;
    if (d > b.p95) return pyRound(d / b.p95 - 1, 3);
    if (d < b.p05) return pyRound(b.p05 / Math.max(d, 0.1) - 1, 3);
    return 0;
  });
}

/** What the answer says about the company's data: a note, or the org, its build time, the counts and what was used. */
export function describe(calib: Rec | null | undefined, used: Rec): string | Rec {
  if (!truthy(calib)) return 'none — corpus bands only';
  return { orgId: calib!.orgId ?? null, builtAt: calib!.builtAt ?? null, company_data: truthy(calib!.counts) ? calib!.counts : {}, used };
}
