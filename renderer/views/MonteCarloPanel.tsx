// Extensions > Monte Carlo: the schedule risk analysis of the Risks window (monte_carlo) with its settings, the finish histogram with
// its cumulative curve, the P10 / P50 / P80 / P90 cards, and the criticality and tornado tables, strongest first. The results are
// the Risks window's own (Results, exported from RiskView.tsx); the estimates and risks are the ones set there.
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDb, toast, useStore } from '../store.ts';
import { fmtDate } from '../model.ts';
import { rows } from '../../core/db.ts';
import { formatP6Date } from '../../core/dates.ts';
import { getEstimates, isEstimable, runMonteCarlo, type MonteCarloResult } from '../../core/risk/montecarlo.ts';
import type { RiskPhase } from '../../core/risk/register.ts';
import { ExportButton, projectArgs } from './ExportButton.tsx';
import { Results } from './RiskView.tsx';

const bar = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } as const;
export const card = { background: '#f3f4f6', border: '1px solid #d9dce1', borderRadius: 14, padding: '8px 14px', minWidth: 120 } as const;

export function MonteCarloPanel() {
  const ui = useStore((s) => s.ui);
  const dbVersion = useStore((s) => s.dbVersion);
  const [iterations, setIterations] = useState(500);
  const [seed, setSeed] = useState('');
  const [events, setEvents] = useState<RiskPhase | 'off'>('pre');
  const [run, setRun] = useState<{ done: number; total: number } | null>(null);
  const [res, setRes] = useState<(MonteCarloResult & { dbVersion: number }) | null>(null);
  const [err, setErr] = useState('');
  const ctl = useRef<AbortController | null>(null);
  // a run still going when the panel is switched away from is ended
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ctl.current?.abort(); }; }, []);
  /** The settings as the tool takes them (the same limits as the Risks window). */
  const settings = () => {
    const n = Math.floor(iterations), sd = seed.trim() === '' ? undefined : Number(seed);
    if (!(n >= 10 && n <= 20000)) throw new Error('Iterations must be between 10 and 20,000.');
    if (sd != null && !Number.isInteger(sd)) throw new Error('Seed must be a whole number (or blank for a random seed).');
    return { n, sd };
  };
  const go = async () => {
    let s: ReturnType<typeof settings>;
    try { s = settings(); } catch (e) { return toast((e as Error).message); }
    const c = (ctl.current = new AbortController());
    setErr(''); setRun({ done: 0, total: s.n });
    let last = 0;
    try {
      const r = await runMonteCarlo(getDb(), ui.openProjects, { iterations: s.n, seed: s.sd, riskEvents: events, signal: c.signal, onProgress: (i) => { const now = Date.now(); if (now - last > 80 || i === s.n) { last = now; setRun({ done: i, total: s.n }); } } });
      if (alive.current) setRes({ ...r, dbVersion });
    } catch (e) { if (alive.current) setErr((e as Error).message); } finally { if (alive.current) setRun(null); ctl.current = null; }
  };
  const nEst = useMemo(() => { const ests = getEstimates(getDb()); return rows(getDb(), 'TASK').filter((t) => ui.openProjects.includes(t.proj_id) && ests.has(t.task_id) && isEstimable(t)).length; }, [dbVersion, ui.openProjects]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={bar}>
        <label>Iterations <input type="number" value={iterations} min={10} max={20000} step={100} style={{ width: 70 }} disabled={!!run} onChange={(e) => setIterations(Number(e.target.value))} /></label>
        <label>Seed <input value={seed} placeholder="random" style={{ width: 80 }} disabled={!!run} onChange={(e) => setSeed(e.target.value)} /></label>
        <label>Risk events <select value={events} disabled={!!run} onChange={(e) => setEvents(e.target.value as RiskPhase | 'off')}><option value="pre">Pre-response</option><option value="post">Post-response</option><option value="off">Ignore</option></select></label>
        {!run ? <button className="btn primary" onClick={() => void go()}>Run Monte Carlo</button> : <button className="btn" onClick={() => ctl.current?.abort()}>Cancel</button>}
        {run && <span><progress value={run.done} max={run.total} style={{ width: 140, verticalAlign: 'middle' }} /> {run.done} / {run.total}</span>}
        <ExportButton tool="monte_carlo" args={() => { const s = settings(); return { ...projectArgs(), iterations: s.n, ...(res ? { seed: res.seed } : s.sd != null ? { seed: s.sd } : {}), risk_events: events }; }} />
      </div>
      {err && <div style={{ color: '#b00020' }}>{err}</div>}
      {!res ? <div className="muted">Schedule risk analysis: each iteration samples the remaining durations from their three-point estimates (Risks window, Estimates tab) and the linked risk events, and reschedules the open projects with the CPM scheduler. The project is not changed.{nEst ? '' : ' No activity has an estimate yet: every iteration would equal the deterministic finish.'}</div> : <>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {(['P10', 'P50', 'P80', 'P90'] as const).map((k) => (
            <div key={k} data-p={k} data-iso={formatP6Date(res.percentiles[k])} style={card}>
              <div className="muted" style={{ fontSize: 11 }}>{k}</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{fmtDate(res.percentiles[k], ui.prefs)}</div>
            </div>
          ))}
          <div style={card}><div className="muted" style={{ fontSize: 11 }}>Chance of meeting the deterministic finish</div><div style={{ fontSize: 16, fontWeight: 600 }}>{Math.round(res.probDeterministic * 100)}%</div></div>
          <div className="muted" style={{ alignSelf: 'center' }}>{res.iterations} iterations, seed {res.seed}, {(res.elapsedMs / 1000).toFixed(1)} s{res.dbVersion !== dbVersion ? ' (schedule changed since)' : ''}</div>
        </div>
        <div className="winbody" style={{ border: '1px solid #d9dce1', borderRadius: 14, overflow: 'hidden' }}><Results res={res} prefs={ui.prefs} /></div>
      </>}
    </div>
  );
}
