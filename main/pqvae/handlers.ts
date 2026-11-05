// The endpoints of the scheduler agent's PQ-VAE tools, ported from pqvae/sidecar.py (h_encode, h_review_schedule, h_trajectory, h_refclass,
// h_growth). Same request and response JSON, the same rounding; every response gets `calibration` added by the server.
import { PHASES, PROJECT_TYPES } from './schemas.ts';
import { FEATURE_DIM_B, featurizeBatch, featurizePeriod } from './features.ts';
import { normActivities, normPtype } from './normalise.ts';
import { blendDurationBands, describe, flagDurations } from './calib.ts';
import { Pcg64 } from './rng.ts';
import { buildAnchors, forecast, growthParams, loadHorrormap, pct, type Horror, type Ted } from './reference.ts';
import { MAX_PERIODS, type Engines } from './engines.ts';
import { KeyErr, mean, pyFloat, pyRound, pyStr, std, truthy, type Rec } from './pyutil.ts';

const need = (body: Rec, key: string): any => { if (!(key in body)) throw new KeyErr(key); return body[key]; };
const pyInt = (v: unknown, dflt: number): number => (truthy(v) ? Math.trunc(pyFloat(v)) : dflt);

/** Records of one project in start order, as whiqcodes.sequence.build_sequences orders them: grouped by project_id, each group by (position_frac, activity_id). */
interface Seq { project_id: unknown; ptype: string; ptypeIdx: number; codes: Int32Array; records: Rec[] }
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byStart = (a: Rec, b: Rec): number => (a.position_frac - b.position_frac) || cmpStr(String(a.activity_id), String(b.activity_id));

async function buildSequences(e: Engines, acts: Rec[]): Promise<Seq[]> {
  const by = new Map<unknown, Rec[]>();
  for (const a of acts) (by.get(a.project_id) ?? by.set(a.project_id, []).get(a.project_id)!).push(a);
  const out: Seq[] = [];
  for (const [pid, recs] of by) {
    recs.sort(byStart);
    const codes = await e.codesA(await featurizeBatch(recs, e.text));
    out.push({ project_id: pid, ptype: recs[0].ptype, ptypeIdx: PROJECT_TYPES.indexOf(recs[0].ptype), codes, records: recs });
  }
  return out;
}

export async function encode(e: Engines, body: Rec): Promise<Rec> {
  const recs = await normActivities(need(body, 'records'), e.text, e.sem);   // decide-seat batch first, then keyword -> MiniLm -> position per record
  if (!recs.length) throw new Error('need at least one array to stack');
  const codes = await e.codesA(await featurizeBatch(recs, e.text));
  return { codes: Array.from({ length: recs.length }, (_, i) => [codes[3 * i], codes[3 * i + 1], codes[3 * i + 2]]), n: recs.length };
}

/** Names never read before (not on the disk cache either) above which a review shares one reading between names that differ only in their
 *  digits. Reading a name costs about 14 ms on 4 threads (JWM, 9,965 names: 141 s of the 166 s review), so 3,000 names is about 40 s: inside
 *  the platform client's 180 s on a PC several times slower than the build machine. Names read before cost nothing, so a programme reviewed
 *  again is read exactly; after a shared review the engine reads the exact names while it is idle (MiniLm.fill), so the next review is exact.
 *  On the GPU (2,000+ names a second) the same 40 s is 60,000 names: JWM is read exactly. */
const SHARE_ABOVE = (gpu = false): number => Number(process.env.PQVAE_SHARE_ABOVE) || (gpu ? 60000 : 3000);

export async function reviewSchedule(e: Engines, body: Rec): Promise<Rec> {
  const raw: Rec[] = need(body, 'records');
  if (raw.length < 3) return { verdict: 'n/a', reason: 'fewer than 3 activities', activities: [] };
  const names = new Set<string>();
  for (const r of raw) if (r?.name != null) names.add(pyStr(r.name));
  const unread = e.text.unread(names);
  let limit = SHARE_ABOVE();
  if (unread > limit && (await e.settleEncoder()).provider === 'dml') limit = SHARE_ABOVE(true);   // the GPU session is made now: it may still fail and fall back to wasm
  const readings = unread > limit ? e.text.share(names) : names.size;
  if (readings < names.size) e.text.readLater(names);
  try {
    const out = await review(e, body, raw);
    if (readings < names.size) {
      const notice = `This programme has ${names.size} distinct activity names, ${unread} of them never read before: more than the ${limit} the engine reads one by one inside a chat call's time limit. Names that differ only in their digits (Level 3, Level 12) shared one reading, ${readings} readings in all. Every activity is still reviewed, but the text-based parts are approximate for it: the surprise scores, order vs random, and the trade and phase read from the name by meaning (a keyword or the stated trade and phase are not affected). The engine now reads the exact names while it is idle (a few minutes for a programme this size): review it again later for the exact reading.`;
      out.notice = notice;
      out.phase_order.notice = notice;
      out.order_vs_random.notice = notice;
      out.shared_name_readings = { distinct_names: names.size, never_read: unread, readings, limit };
    }
    return out;
  } finally { e.text.unshare(); }
}

async function review(e: Engines, body: Rec, raw: Rec[]): Promise<Rec> {
  const recs = await normActivities(raw, e.text, e.sem);
  recs.sort(byStart);
  const { cal, bands: prior } = e.arData();
  const seq = (await buildSequences(e, recs))[0];
  const n = seq.records.length;
  const nll = await e.nll(seq.codes, seq.ptypeIdx);
  const { bands, used } = await blendDurationBands(prior, body.calib, (rs) => normActivities(rs, e.text, e.sem));   // org-calibration records go through the same seat-first chain
  const dflags = flagDurations(bands, seq.records);
  const mu = cal.clean_nll_mean, sd = cal.clean_nll_std;
  const proj = mean(nll) + mean(dflags);
  const z = (proj - mu) / sd;
  // Per-activity levels are RELATIVE to this programme (self-normalised surprise): "which activities are the odd ones out HERE" is the
  // question a planner can act on; the corpus z is still returned separately.
  const sMean = mean(nll), sSd = std(nll) + 1e-6;
  const acts: Rec[] = seq.records.map((r, i) => {
    const az = (nll[i] - mu) / (sd * 3);   // corpus-relative (informational)
    const rz = (nll[i] - sMean) / sSd;     // programme-relative (drives the level)
    const level = rz > 1.5 || dflags[i] > 0.5 ? 'red' : rz > 0.75 || dflags[i] > 0 ? 'amber' : 'ok';
    return { activity_id: r.activity_id, name: r.name, trade: r.trade, phase: r.phase, duration_days: r.duration_days, position_frac: pyRound(r.position_frac, 3),
      surprise: pyRound(nll[i], 2), surprise_z: pyRound(rz, 2), corpus_z: pyRound(az, 2), duration_flag: dflags[i], level };
  });
  const verdict = z > 2 ? 'red' : z > 1 ? 'amber' : 'ok';
  // SHUFFLE NULL: score k random orderings of the SAME activities; if the real order is not clearly more probable than random, the
  // sequencing carries no information. numpy's default_rng(7).permutation, reproduced exactly (rng.ts).
  // `shuffles` is Python's `int(body.get("shuffles") or 12)`: absent, null and 0 mean the default 12. Below 1 (-1, or the string "0") Python
  // divides by an empty list and answers NaN; here the null is skipped and the answer says so.
  const k = pyInt(body.shuffles, 12);
  const rng = new Pcg64(7);
  const nulls: number[] = [];
  for (let t = 0; t < k; t++) {
    await e.tick();
    const perm = rng.permutation(n);
    const sh = perm.map((j, pos) => ({ ...recs[j], position_frac: pos / Math.max(n - 1, 1) }));
    const s2 = (await buildSequences(e, sh))[0];
    const w = await e.nll(s2.codes, s2.ptypeIdx);
    nulls.push(mean(w.subarray(0, n)));
  }
  const seqScore = mean(nll);
  const betterThan = nulls.length ? nulls.filter((x) => x > seqScore).length / nulls.length : null;   // share of random orders that score WORSE than the real one
  const gap = nulls.length ? (mean(nulls) - seqScore) / (std(nulls) + 1e-6) : null;
  const orderVerdict = betterThan == null ? 'n/a' : betterThan >= 0.9 ? 'ok' : betterThan >= 0.6 ? 'amber' : 'red';
  // PHASE-ORDER CONSISTENCY, no model: does the build phase (as mapped from the names) advance with the start order? Kendall tau between the
  // phase index and the start position over all pairs whose phases differ.
  const ph = seq.records.map((r) => PHASES.indexOf(r.phase)), pos = seq.records.map((r) => pyFloat(r.position_frac));
  let conc = 0, disc = 0, nInv = 0;
  const inversions: Rec[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dp = ph[j] - ph[i];
    if (dp !== 0) {
      const ds = pos[j] - pos[i];
      if (ds !== 0) { if ((dp > 0) === (ds > 0)) conc++; else disc++; }
    }
    if (ph[i] > ph[j] + 1 && pos[i] < pos[j] - 0.05) {   // a LATER phase starting clearly before an EARLIER one
      nInv++;
      if (inversions.length < 10) inversions.push({ later_phase_activity: seq.records[i].name, phase: seq.records[i].phase, starts_before: seq.records[j].name, its_phase: seq.records[j].phase });
    }
  }
  const tau = (conc - disc) / Math.max(conc + disc, 1);
  const phaseVerdict = tau >= 0.6 ? 'ok' : tau >= 0.3 ? 'amber' : 'red';
  const counts: Rec = {};
  for (const lv of ['red', 'amber', 'ok']) counts[lv] = acts.filter((a) => a.level === lv).length;
  const out: Rec = {
    project_score: pyRound(proj, 3), z: pyRound(z, 2), clean_mean: pyRound(mu, 3), verdict, activities: acts,
    calibration_org: describe(body.calib, { duration_bands: used }), counts,
    phase_order: { kendall_tau: pyRound(tau, 2), verdict: phaseVerdict, pairs: conc + disc, inversions, n_inversions: nInv, note: 'no model: build phase (mapped from names) vs start order — the reading to check by eye' },
    order_vs_random: { better_than_random_share: betterThan == null ? null : pyRound(betterThan, 2), sigma_gap: gap == null ? null : pyRound(gap, 2), verdict: orderVerdict, shuffles: nulls.length,
      note: nulls.length ? 'learned grammar (v2-minilm, activity corpus = generator + 5 EPC programmes) vs random orders of the SAME activities; advisory — small programmes give noisy shares, read the phase-order line first'
        : 'no random orders were scored (shuffles < 1), so there is no order-vs-random reading; use the phase-order line' },
    duration_flags: dflags.filter((f) => f > 0).length,
  };
  // The scorer reads 256 positions. Past that the Python sidecar fails (index out of bounds); this one scores overlapping windows of 256.
  if (n > 256) out.windowed_scoring = { window: 256, stride: 128, activities: n, note: 'programme longer than the 256 positions the sequencing model reads: scored in overlapping windows, each starting fresh' };
  return out;
}

export async function trajectory(e: Engines, body: Rec): Promise<Rec> {
  const ps: Rec[] = [...need(body, 'periods')].sort((a, b) => pyFloat(need(a, 'period')) - pyFloat(need(b, 'period')));
  if (ps.length < 2) return { error: 'need at least 2 periods' };
  const ptype = normPtype(body.ptype || ps[0].ptype);
  for (const p of ps) {
    if (!('spi' in p)) p.spi = truthy(p.planned_pct) ? p.actual_pct / p.planned_pct : 1.0;
    if (!('rfi_count' in p)) p.rfi_count = 0;
    if (!('variation_count' in p)) p.variation_count = 0;
    p.ptype = ptype;
  }
  const feats = new Float32Array(ps.length * FEATURE_DIM_B);
  ps.forEach((p, i) => feats.set(featurizePeriod(p), i * FEATURE_DIM_B));
  const codes = await e.codesB(feats);
  const months = ps.length;
  const plannedTotal = pyInt(body.planned_months, Math.max(months, 12));
  // the head reads the first max(2, int(months * months / max(planned, months))) periods: how far into the plan the project is
  const used = Math.min(Math.max(2, Math.trunc(months * (months / Math.max(plannedTotal, months, 1)))), MAX_PERIODS);
  const [lo, ld] = await e.head(codes.subarray(0, used * 3), PROJECT_TYPES.indexOf(ptype));
  const out: Rec = { pred_overrun_x: pyRound(Math.exp(lo), 3), pred_delay_months: pyRound(Math.expm1(ld), 1) };
  if (months > MAX_PERIODS) {
    out.periods_read = used;
    out.notice = used === MAX_PERIODS ? `${months} periods were given; the trajectory model has ${MAX_PERIODS} positions, so it read the first ${MAX_PERIODS} (in period order) and ignored the last ${months - MAX_PERIODS}.`
      : `${months} periods were given; the trajectory model reads the first ${used} of them (the share of the plan elapsed; it has ${MAX_PERIODS} positions at most).`;
  }
  Object.assign(out, { months_observed: months, planned_months: plannedTotal, ptype, observed: ps.map((p) => ({ m: p.period, planned: p.planned_pct, actual: p.actual_pct })) });
  // the company's outcome correction: actual ~ a + b * pred, learned from its finished projects
  const cal = body.calib || {};
  const fit = (cal.outcome_fit_by_ptype ?? {})[ptype] || cal.outcome_fit || null;   // per-type fit first (>= 10 pairs), else global
  if (truthy(fit) && (fit.n ?? 0) >= 3) {
    out.pred_delay_months_adjusted = pyRound(pyFloat(fit.a) + pyFloat(fit.b) * out.pred_delay_months, 1);
    out.calibration_org = describe(body.calib, { outcome_fit: fit });
  } else out.calibration_org = describe(body.calib, { outcome_fit: 'none (fewer than 3 finished-project pairs)' });
  return out;
}

export function refclass(e: Engines, body: Rec): Rec {
  const horror: Horror[] = loadHorrormap(e.read('horrormap.json'));
  const out = forecast(horror, e.read<Ted[]>('ted_winratios.json'), normPtype(body.ptype), pyFloat(body.budget_eur || 0));
  // the company's own finished projects as a SECOND pool, never mixed into the horror map (failure-biased): both are shown
  const oc: Rec[] = body.calib?.outcomes || [];
  const dl = oc.filter((o) => o.delay_months != null).map((o) => o.delay_months as number);
  const ov = oc.filter((o) => truthy(o.overrun_ratio)).map((o) => o.overrun_ratio as number);
  if (dl.length >= 2 || ov.length >= 2) {
    out.company_pool = { n_projects: oc.length, delay_months: dl.length >= 2 ? pct(dl) : null, overrun_ratio: ov.length >= 2 ? pct(ov) : null,
      note: 'the company\'s OWN finished projects (schedules closed out + project_outcome registers) — its real record, not the failure-biased horror map' };
  }
  out.calibration_org = describe(body.calib, { company_pool: oc.length });
  return out;
}

export function growth(e: Engines, body: Rec): Rec {
  return growthParams(buildAnchors(loadHorrormap(e.read('horrormap.json'))), normPtype(body.ptype), body.contract_form || 'lump_sum');
}
