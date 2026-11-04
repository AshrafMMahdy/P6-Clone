// Featurizers (pqvae/whiqcodes/features.py and vocab_b.featurize_period): a normalised record -> the float vector the tokenizer reads.
import { PHASES, PROJECT_TYPES, TRADES } from './schemas.ts';
import { TEXT_DIM, type MiniLm } from './minilm.ts';
import { pyFloat, type Rec } from './pyutil.ts';

export const FEATURE_DIM = 9 + TRADES.length + PHASES.length + PROJECT_TYPES.length + TEXT_DIM;   // 420
export const FEATURE_DIM_B = 6 + PROJECT_TYPES.length;   // 17

/** Vocab A: 9 numbers, trade / phase / project-type one-hots, the name's text vector. */
export async function featurizeBatch(recs: Rec[], text: MiniLm): Promise<Float32Array> {
  await text.warm(recs.map((r) => r.name));   // one batched encode instead of one per record
  const out = new Float32Array(recs.length * FEATURE_DIM);
  recs.forEach((r, i) => {
    const o = i * FEATURE_DIM;
    out[o] = Math.log1p(pyFloat(r.duration_days)) / 5.0;
    out[o + 1] = Math.log1p(pyFloat(r.crew_size)) / 4.0;
    out[o + 2] = pyFloat(r.position_frac);
    out[o + 3] = pyFloat(r.n_predecessors) / 4.0;
    out[o + 4] = pyFloat(r.n_successors) / 4.0;
    out[o + 5] = pyFloat(r.rel_fs_frac);
    out[o + 6] = pyFloat(r.zone) / Math.max(pyFloat(r.project_zones), 1);
    out[o + 7] = Math.log1p(pyFloat(r.project_size_eur)) / 25.0;
    out[o + 8] = pyFloat(r.project_zones) / 15.0;
    const t = TRADES.indexOf(r.trade), p = PHASES.indexOf(r.phase), y = PROJECT_TYPES.indexOf(r.ptype);
    if (t >= 0) out[o + 9 + t] = 1;
    if (p >= 0) out[o + 9 + TRADES.length + p] = 1;
    if (y >= 0) out[o + 9 + TRADES.length + PHASES.length + y] = 1;
    out.set(text.vec(r.name), o + 9 + TRADES.length + PHASES.length + PROJECT_TYPES.length);
  });
  return out;
}

/** Vocab B: one monthly period state -> 17 numbers (planned, actual, SPI, RFIs, variations, month, project-type one-hot). */
export function featurizePeriod(p: Rec): Float32Array {
  const v = new Float32Array(FEATURE_DIM_B);
  v[0] = pyFloat(p.planned_pct);
  v[1] = pyFloat(p.actual_pct);
  v[2] = Math.min(pyFloat(p.spi), 2.0) / 2.0;
  v[3] = Math.log1p(pyFloat(p.rfi_count)) / 4.0;
  v[4] = Math.log1p(pyFloat(p.variation_count)) / 3.0;
  v[5] = Math.min(pyFloat(p.period), 120) / 120.0;
  const y = PROJECT_TYPES.indexOf(p.ptype);
  if (y >= 0) v[6 + y] = 1;
  return v;
}
