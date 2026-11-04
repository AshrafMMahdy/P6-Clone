// Reference-class data and the cost-growth parameters (pqvae/whiqcodes/reference_class.py, anchors.py, growth_export.py). No model: percentile
// tables over the horror map (documented troubled public projects) and the TED award ratios, and lognormal parameters of the cost growth.
import { percentile, pyRound, type Rec } from './pyutil.ts';

export interface Horror { ptype: string; size_eur: number; overrun_ratio: number | null; delay_months: number | null; confidence: string }
export interface Ted { country: string; cpv_div: string; estimated: number; ratio: number }

const TYPE_MAP: Record<string, string> = { Tram: 'Metro' };   // horror-map types -> project types (a tram rides with metro)
const RECOVERABILITY: Record<string, number> = { lump_sum: 1.0, remeasured: 0.4, cost_plus: 0.1 };

/** anchors.load_horrormap: rows with an original budget; the overrun is final / original when a final cost is known. */
export function loadHorrormap(raw: Rec[]): Horror[] {
  const out: Horror[] = [];
  for (const r of raw) {
    if (!r.originalBudget) continue;
    out.push({ ptype: TYPE_MAP[r.type] ?? r.type, size_eur: Number(r.originalBudget), overrun_ratio: r.finalCost ? r.finalCost / r.originalBudget : null,
      delay_months: r.delayMonths ?? null, confidence: r.confidence ?? 'Estimated' });
  }
  return out;
}

/** The percentile table, rounded to 3 places. */
export function pct(values: number[], ps: number[] = [10, 25, 50, 75, 80, 90]): Rec {
  const o: Rec = {};
  for (const p of ps) o[`p${p}`] = pyRound(percentile(values, p), 3);
  return o;
}

export function forecast(rows: Horror[], ted: Ted[], ptype: string, budget: number): Rec {
  let pool = rows.filter((r) => r.ptype === ptype);
  let label = `${pool.length} ${ptype} projects`;
  if (pool.length < 2) { pool = rows; label = `all ${rows.length} projects (too few ${ptype} records — global pool)`; }
  const overruns = pool.filter((r) => r.overrun_ratio).map((r) => r.overrun_ratio as number);
  const delays = pool.filter((r) => r.delay_months != null).map((r) => r.delay_months as number);
  const ov = overruns.length ? pct(overruns) : null;
  const dl = delays.length ? pct(delays) : null;
  const award = ted.length ? pct(ted.map((t) => t.ratio)) : null;
  const out: Rec = {
    pool: label,
    caveat: "Horror-map pool is FAILURE-BIASED: these are documented troubled projects, not the population. Read as 'the shape of trouble when it hits', not 'your expected outcome'.",
    overrun_ratio: ov, delay_months: dl, award_vs_estimate_ted: award,
    n_outcome_records: pool.length, n_ted_records: ted.length,
    matched_projects: pool.map((r) => ({ ptype: r.ptype, size_eur: r.size_eur, overrun_ratio: r.overrun_ratio ? pyRound(r.overrun_ratio, 2) : null, delay_months: r.delay_months, confidence: r.confidence })),
  };
  if (ov && budget) {
    out.uplift_p50_eur = pyRound(budget * (ov.p50 - 1));
    out.uplift_p80_eur = pyRound(budget * (ov.p80 - 1));
  }
  return out;
}

// ── growth ──────────────────────────────────────────────────────────────────────
interface Pack { n: number; overrun_lognorm: { mu: number; sigma: number } | null }

function lognormParams(values: Array<number | null>): { mu: number; sigma: number } | null {
  const logs = values.filter((v): v is number => !!v && v > 0).map(Math.log);
  if (!logs.length) return null;
  const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
  const v = logs.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(logs.length - 1, 1);
  return { mu, sigma: Math.sqrt(v) };
}

/** Anchor packs: per project type where the horror map has at least 2 records, plus the global pool. */
export function buildAnchors(rows: Horror[]): Record<string, Pack> {
  const by = new Map<string, Horror[]>();
  for (const r of rows) (by.get(r.ptype) ?? by.set(r.ptype, []).get(r.ptype)!).push(r);
  const pack = (rs: Horror[]): Pack => ({ n: rs.length, overrun_lognorm: lognormParams(rs.map((r) => r.overrun_ratio)) });
  const a: Record<string, Pack> = { _global: pack(rows) };
  for (const [t, rs] of by) if (rs.length >= 2) a[t] = pack(rs);
  return a;
}

export function growthParams(anchors: Record<string, Pack>, ptype: string, form: string): Rec {
  const a = anchors[ptype] ?? anchors._global;
  const ln = a.overrun_lognorm ?? anchors._global.overrun_lognorm!;
  const { mu, sigma } = ln;
  if (!(form in RECOVERABILITY)) throw new Error(`'${form}'`);   // KeyError, as Python
  const rho = RECOVERABILITY[form];
  const eg = Math.exp(mu + sigma ** 2 / 2);
  const varg = (Math.exp(sigma ** 2) - 1) * Math.exp(2 * mu + sigma ** 2);
  return {
    ptype, contract_form: form, rho, lognorm: { mu, sigma },
    growth_mean: pyRound(eg, 4), growth_var: pyRound(varg, 5),
    eaten_mean: pyRound(1 + rho * (eg - 1), 4), eaten_var: pyRound(rho ** 2 * varg, 5),
    n_records: a.n, pooled_global: !(ptype in anchors),
    source: 'horrormap+TED',
    caveat: 'failure-biased outcome sample - shape of trouble, not population base rate',
  };
}
