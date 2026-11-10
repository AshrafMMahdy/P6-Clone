// Extensions > Monte Carlo: the schedule risk analysis of the Risks window (monte_carlo) with its settings, the finish histogram with
// its cumulative curve, the P10 / P50 / P80 / P90 cards, and the criticality and tornado tables, strongest first. The results are
// the Risks window's own (Results, exported from RiskView.tsx); the estimates and risks are the ones set there.
import { useMemo, useState } from 'react';
import { getDb, toast, useStore } from '../store.ts';
import { fmtDate } from '../model.ts';
import { rows } from '../../core/db.ts';
import { formatP6Date } from '../../core/dates.ts';
import { getEstimates, isEstimable, type MonteCarloResult } from '../../core/risk/montecarlo.ts';
import type { RiskPhase } from '../../core/risk/register.ts';
import { ExportButton, projectArgs } from './ExportButton.tsx';
import { Results } from './RiskView.tsx';
import { monteCarloArgs, monteCarloResult, monteCarloStopped, refusal } from './toolAnswers.ts';
import { taskIdLookup, useToolRun } from './toolRun.ts';
import { RunStatus } from './RunStatus.tsx';

const bar = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } as const;
export const card = { background: '#f3f4f6', border: '1px solid #d9dce1', borderRadius: 14, padding: '8px 14px', minWidth: 120 } as const;

export function MonteCarloPanel() {
  const ui = useStore((s) => s.ui);
  const dbVersion = useStore((s) => s.dbVersion);
  const [iterations, setIterations] = useState(500);
  const [seed, setSeed] = useState('');
  const [events, setEvents] = useState<RiskPhase | 'off'>('pre');
  const [res, setRes] = useState<(MonteCarloResult & { dbVersion: number }) | null>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const [err, setErr] = useState('');
  // the tool itself, in the Export's child process on the saved database (main/analysis-export-ipc.ts): the window is never held, a
  // run that does not fit in memory is refused by the tool in words before it starts, and Cancel keeps the iterations done (the tool's
  // partial answer). A run still going when the panel is switched away from is cancelled.
  const mc = useToolRun('monte_carlo', true);
  const run = mc.running;
  /** The settings as the tool takes them: the iterations as typed (the tool refuses what is not a whole number of 10 or more). */
  const settings = () => {
    const sd = seed.trim() === '' ? undefined : Number(seed);
    if (sd != null && !Number.isInteger(sd)) throw new Error('Seed must be a whole number (or blank for a random seed).');
    return { n: iterations, sd };
  };
  const go = async () => {
    let a: Record<string, unknown>;
    try { const s = settings(); a = monteCarloArgs({ iterations: s.n, seed: s.sd, riskEvents: events, project: projectArgs() }); } catch (e) { return toast((e as Error).message); }
    setErr(''); setStopped(null);
    const r = await mc.start(a);
    if (!r) return;
    const why = refusal(r);
    if (why) return setErr(why);
    setRes({ ...monteCarloResult(r.out, taskIdLookup()), dbVersion }); setStopped(monteCarloStopped(r.out));
  };
  const nEst = useMemo(() => { const ests = getEstimates(getDb()); return rows(getDb(), 'TASK').filter((t) => ui.openProjects.includes(t.proj_id) && ests.has(t.task_id) && isEstimable(t)).length; }, [dbVersion, ui.openProjects]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={bar}>
        <label>Iterations <input type="number" value={iterations} min={10} step={100} style={{ width: 70 }} disabled={run} onChange={(e) => setIterations(Number(e.target.value))} /></label>
        <label>Seed <input value={seed} placeholder="random" style={{ width: 80 }} disabled={run} onChange={(e) => setSeed(e.target.value)} /></label>
        <label>Risk events <select value={events} disabled={run} onChange={(e) => setEvents(e.target.value as RiskPhase | 'off')}><option value="pre">Pre-response</option><option value="post">Post-response</option><option value="off">Ignore</option></select></label>
        {!run ? <button className="btn primary" onClick={() => void go()}>Run Monte Carlo</button> : <button className="btn" onClick={mc.cancel} title="Stops the run and shows the iterations done">Cancel</button>}
        {run && <RunStatus progress={mc.progress} waiting="Starting the run in a separate process…" />}
        <ExportButton tool="monte_carlo" args={() => { const s = settings(); return { ...projectArgs(), iterations: s.n, ...(res ? { seed: res.seed } : s.sd != null ? { seed: s.sd } : {}), risk_events: events }; }} />
      </div>
      {err && <div style={{ color: '#b00020', whiteSpace: 'pre-wrap' }}>{err}</div>}
      {stopped && !err && <div className="muted">{stopped}</div>}
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
