// Record normalisation (sidecar.py norm_*): platform data is not the generator's data. Defaults for what a programme row lacks, and the trade and
// phase of each activity from, in order: the decide seat (confidence >= 0.5) -> the English/Finnish/Swedish/German keyword table -> the
// multilingual encoder against English prototype phrases (zero-shot, cosine >= 0.35) -> what the record states -> the position in the programme.
import { PHASES, PROJECT_TYPES, TRADES } from './schemas.ts';
import { PHASE_KW, PHASE_PROTO, TRADE_KW, TRADE_PROTO } from './tables.ts';
import { seatTradePhase, type SeatHit } from './decide.ts';
import { dropNull, pyFloat, pyStr, truthy, type Rec } from './pyutil.ts';
import type { MiniLm } from './minilm.ts';

const ACT_DEFAULTS: Rec = { zone: 0, crew_size: 6, n_predecessors: 1, n_successors: 1, rel_fs_frac: 1.0, project_zones: 1, project_size_eur: 20e6, position_frac: null, duration_days: 5.0 };

export function normPtype(p: unknown): string {
  const s = truthy(p) ? pyStr(p).trim() : '';
  for (const t of PROJECT_TYPES) if (t.toLowerCase() === s.toLowerCase()) return t;
  const low = s.toLowerCase();
  for (const t of PROJECT_TYPES) if (low.includes(t.toLowerCase())) return t;
  return ['logistic', 'warehouse', 'plant', 'factory', 'data'].some((k) => low.includes(k)) ? 'Industrial' : 'Office';
}

/** First keyword of the table found in the lower-cased text, else the default. */
function kw<D>(text: unknown, table: Array<[string, string]>, dflt: D): string | D {
  const low = (truthy(text) ? pyStr(text) : '').toLowerCase();
  for (const [k, v] of table) if (low.includes(k)) return v;
  return dflt;
}

/** The encoder's side of the resolver: prototype phrases of a table embedded once, then a name is matched by cosine. */
export class Semantic {
  private text: MiniLm;
  private mats = new Map<Record<string, string[]>, { labels: string[]; vecs: Float32Array[] }>();
  constructor(text: MiniLm) { this.text = text; }

  /** The strings infer() will read: warm them in one batch before a run of normActivity calls. */
  protoPhrases(): string[] { return [TRADE_PROTO, PHASE_PROTO].flatMap((t) => Object.values(t).flat()); }

  private matrix(table: Record<string, string[]>): { labels: string[]; vecs: Float32Array[] } {
    let m = this.mats.get(table);
    if (!m) {
      const labels: string[] = [], vecs: Float32Array[] = [];
      for (const [lab, ps] of Object.entries(table)) for (const p of ps) { labels.push(lab); vecs.push(this.text.vec(p)); }
      m = { labels, vecs };
      this.mats.set(table, m);
    }
    return m;
  }

  /** Zero-shot class of an activity name; null when nothing is close (or the encoder is not ready). */
  infer(name: string, table: Record<string, string[]>, minSim = 0.35): string | null {
    try {
      const { labels, vecs } = this.matrix(table);
      const v = this.text.vec(name);
      let best = -1, bi = 0;
      vecs.forEach((m, i) => { let s = 0; for (let d = 0; d < v.length; d++) s += m[d] * v[d]; if (s > best) { best = s; bi = i; } });
      return best >= minSim ? labels[bi] : null;
    } catch { return null; }
  }
}

const byPosition = (pf: number): string => (pf < 0.08 ? 'mobilization' : pf < 0.3 ? 'substructure' : pf < 0.5 ? 'superstructure'
  : pf < 0.62 ? 'envelope' : pf < 0.78 ? 'rough_in' : pf < 0.92 ? 'finishes' : 'commissioning');

const nameOf = (o: Rec): string => (o.name != null ? pyStr(o.name) : '');

/** One record, merged over the defaults. `seat` is the decide seat's answer per name (seatTradePhase), `sem` the encoder. */
export function normActivity(r: Rec, i: number, n: number, seat: Map<string, SeatHit>, sem: Semantic): Rec {
  const out: Rec = { ...ACT_DEFAULTS, ...dropNull(r) };
  let pf = out.position_frac;
  const ok = pf != null && (() => { try { const f = pyFloat(pf); return f >= 0 && f <= 1; } catch { return false; } })();
  if (!ok) out.position_frac = i / Math.max(n - 1, 1);
  const hit = seat.get(truthy(out.name) ? pyStr(out.name) : '') ?? { trade: null, phase: null };
  const name = nameOf(out);
  const tr = (truthy(out.trade) ? pyStr(out.trade) : '').toLowerCase();
  const kwt = hit.trade || kw(name, TRADE_KW, null) || sem.infer(name, TRADE_PROTO);
  out.trade = kwt || (TRADES.includes(tr) ? tr : kw(tr, TRADE_KW, 'general'));
  const ph = (truthy(out.phase) ? pyStr(out.phase) : '').toLowerCase();
  pf = truthy(out.position_frac) ? pyFloat(out.position_frac) : 0;
  const kwp = hit.phase || kw(name, PHASE_KW, null) || sem.infer(name, PHASE_PROTO);
  out.phase = kwp || (PHASES.includes(ph) ? ph : kw(ph, PHASE_KW, byPosition(pf)));
  out.ptype = normPtype(out.ptype);
  if (out.project_id == null) out.project_id = 'P';
  if (out.activity_id == null) out.activity_id = String(i);
  if (out.name == null) out.name = `activity ${i}`;
  out.duration_days = Math.max(pyFloat(out.duration_days), 0.5);
  return out;
}

/** Whole-list normalisation: one decide-seat batch for the list, the names the keywords miss embedded in one batch, then the per-record chain. */
export async function normActivities(recs: Rec[], text: MiniLm, sem: Semantic): Promise<Rec[]> {
  const seat = await seatTradePhase(recs, text.tick, (s) => text.key(s));
  const need = new Set<string>();
  for (const r of recs) {
    const o = { ...ACT_DEFAULTS, ...dropNull(r ?? {}) };
    const hit = seat.get(truthy(o.name) ? pyStr(o.name) : '');
    const name = nameOf(o);
    if (!hit?.trade && kw(name, TRADE_KW, null) == null) need.add(name);
    if (!hit?.phase && kw(name, PHASE_KW, null) == null) need.add(name);
  }
  if (need.size) await text.warm([...need, ...sem.protoPhrases()]);
  return recs.map((r, i) => normActivity(r, i, recs.length, seat, sem));
}
