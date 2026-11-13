// Extensions for the analysis tools that had no screen: Check schedule, Float paths, Progress curves, Resource histogram, Level resources
// (a report on a copy: nothing is changed), Evaluate one change, Compare and Review. Each computes with the core function its MCP tool
// calls, with the options the tool passes, so the screen and the tool agree; Export… runs the tool itself (ExportButton.tsx). Level
// resources, too heavy for the window on a big schedule, runs the tool itself in Export's child process (main/analysis-export-ipc.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDb, getUi, saveNow, toast, useStore } from '../store.ts';
import { rows, type Db } from '../../core/db.ts';
import { parseP6Date } from '../../core/dates.ts';
import { checkSchedule, P6_CHECKS, type CheckScheduleReport } from '../../core/analysis/checkSchedule.ts';
import { progressCurves, resourceHistograms, type ProgressCurves, type ResourceHistogram } from '../../core/analysis/curves.ts';
import type { computeFloatPaths } from '../../core/schedule/floatPaths.ts';
import { compareComputed, evaluate } from '../../core/query/evaluate.ts';
import { compareSchedules, type ScheduleChange } from '../../core/diff.ts';
import { reviewSchedule, type Review } from '../../core/query/review.ts';
import { baselineOf } from '../../core/analysis/common.ts';
import { parseFileAsync } from '../io.ts';
import { onlyProjects } from '../analysisDb.ts';
import { AnalysisResults, goToActivity } from './AnalysisResults.tsx';
import { ExportButton, errorText, numberOf, projectArgs } from './ExportButton.tsx';
import { card } from './MonteCarloPanel.tsx';
import { betweenCount, CHANGED_SINCE, floatPathsArgs, refusal, wasCancelled, type RunStamp } from './toolAnswers.ts';
import { stampNow, useChangedSince, useToolRun } from './toolRun.ts';

const Id = ({ id }: { id: string }) => <a href="#" onClick={(e) => { e.preventDefault(); goToActivity(id); }}>{id}</a>;
const Ids = ({ ids, max = 30 }: { ids: string[]; max?: number }) => <>{ids.slice(0, max).map((c, i) => <span key={c}>{i ? ', ' : ''}<Id id={c} /></span>)}{ids.length > max ? ` … +${ids.length - max}` : ''}</>;
const box = { display: 'flex', flexDirection: 'column', gap: 6, height: '100%', minHeight: 0 } as const;
const bar = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } as const;
const red = { color: '#b00020' };
const cards = { display: 'flex', gap: 10, flexWrap: 'wrap' } as const;
const Card = ({ label, value, id }: { label: string; value: string; id?: string }) => <div data-card={id ?? label} style={card}><div className="muted" style={{ fontSize: 11 }}>{label}</div><div style={{ fontSize: 16, fontWeight: 600 }}>{value}</div></div>;
const panel = { border: '1px solid #d9dce1', borderRadius: 14, background: '#fff', overflow: 'auto', flex: 1, minHeight: 0, padding: 8 } as const;
const n1 = (v: number | null | undefined, d = 2) => (v == null ? '-' : (Math.round(v * 10 ** d) / 10 ** d).toLocaleString());
const date = (s: string | null | undefined) => s?.slice(0, 10) ?? '-';
/** A date field's value as the tools read a date ("YYYY-MM-DD HH:MM"), null when empty or not a date. */
const dt = (v: string) => (v ? parseP6Date(v.replace('T', ' ')) : null);

// ---------------------------------------------------------------- Check schedule (check_schedule)
export function CheckSchedulePanel() {
  const ui = useStore((s) => s.ui);
  const [on, setOn] = useState<Record<string, boolean>>(Object.fromEntries(P6_CHECKS.map((c) => [c.id, true])));
  const [targets, setTargets] = useState<Record<string, string>>(Object.fromEntries(P6_CHECKS.map((c) => [c.id, String(c.th.value)])));
  const [days, setDays] = useState('44');
  const [report, setReport] = useState<CheckScheduleReport | null>(null);
  /** The settings as the tool's arguments: the checks, the targets that differ from P6's, the long lag / large float limit. */
  const settings = () => {
    const checks = P6_CHECKS.filter((c) => on[c.id]).map((c) => c.id);
    if (!checks.length) throw new Error('Select at least one check.');
    const t: Record<string, number> = {};
    for (const c of P6_CHECKS) { const v = numberOf(`The target of ${c.name}`, targets[c.id], true)!; if (v !== c.th.value) t[c.id] = v; }
    const d = numberOf('The number of days for long lags, large float and large durations', days, true)!;
    if (!(d > 0)) throw new Error('The number of days for long lags, large float and large durations must be more than 0.');
    return { checks, targets: t, threshold_days: d };
  };
  const run = () => {
    let s: ReturnType<typeof settings>;
    try { s = settings(); } catch (e) { return toast((e as Error).message); }
    setReport(checkSchedule(getDb(), { projIds: ui.openProjects, hoursPerDay: ui.prefs.hoursPerDay, checks: s.checks, targets: s.targets, thresholdHours: s.threshold_days * ui.prefs.hoursPerDay }));
  };
  return (
    <div style={box}>
      <div style={bar}>
        <label>Long lags, large float and large durations: over <input style={{ width: 44 }} value={days} onChange={(e) => setDays(e.target.value)} /> days</label>
        <button className="btn primary" onClick={run}>Check schedule</button>
        <ExportButton tool="check_schedule" args={() => ({ ...projectArgs(), ...settings() })} />
      </div>
      <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ width: 330, overflow: 'auto' }}>
          <table className="tbl"><thead><tr><th /><th>Check</th><th>Target</th></tr></thead>
            <tbody>{P6_CHECKS.map((c) => <tr key={c.id}><td><input type="checkbox" checked={!!on[c.id]} onChange={(e) => setOn({ ...on, [c.id]: e.target.checked })} /></td><td>{c.name}</td><td style={{ whiteSpace: 'nowrap' }}>{c.th.op} <input style={{ width: 46 }} value={targets[c.id]} onChange={(e) => setTargets({ ...targets, [c.id]: e.target.value })} />{c.id === 'bei' ? '' : '%'}</td></tr>)}</tbody></table>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {!report ? <div className="muted">P6's Tools &gt; Check Schedule Report: each check with P6's own population and target. Late activities and BEI need the project baseline.</div> : <>
            <div className="muted">{report.projects.map((p) => `${p.id}: data date ${p.data_date ?? 'not set'}, ${p.activities} activities (${p.completed} completed), ${p.relationships} relationships`).join(' · ')}</div>
            <div><b>{report.summary.failed}</b> failed · {report.summary.passed} passed{report.summary.not_assessed ? ` · ${report.summary.not_assessed} not assessed` : ''}</div>
            <AnalysisResults checks={report.checks} />
          </>}
        </div>
      </div>
    </div>
  );
}

let levelRuns = 0;
// ---------------------------------------------------------------- Float paths (float_paths)
/** float_paths' answer (the Float Path columns are not written by the screen). */
type FloatAnswer = { end: string | null; method: string; paths: ReturnType<typeof computeFloatPaths>['paths']; near_critical: { id: string; name: string; total_float_days: number }[]; between?: { from: string; to: string; paths: { duration_days: number; min_float_days: number | null; activities: string[] }[]; paths_total: number | string; truncated?: boolean } };
export function FloatPathsPanel() {
  const ui = useStore((s) => s.ui);
  const [count, setCount] = useState('10');
  const [end, setEnd] = useState('');
  const [method, setMethod] = useState<'free_float' | 'total_float'>('free_float');
  const [near, setNear] = useState('10');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [most, setMost] = useState('');
  const [res, setRes] = useState<FloatAnswer | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState(''); // a cancelled run: a status line, not a failure
  const [stamp, setStamp] = useState<RunStamp | null>(null);
  const changed = useChangedSince(stamp);
  // the tool itself, in the Export's child process on the saved database (main/analysis-export-ipc.ts), as Level resources runs: a large `max` on
  // a dense network is refused by the tool in words before it starts (how many paths fit), a loop in the logic comes back as its error, and
  // the window is never held. Cancel ends the process (there is nothing the tool keeps).
  const fp = useToolRun('float_paths', false);
  const hpd = ui.prefs.hoursPerDay;
  /** The settings; a number that is not one is refused. between (the tool's between): when either activity is given. */
  const opts = () => {
    const f = from.trim(), t = to.trim(), max = numberOf('The most paths between', most);
    return { count: numberOf('The number of paths', count), endActivity: end.trim() || undefined, method, nearDays: numberOf('The near-critical float', near) ?? 10, between: f || t ? { from: f, to: t, ...(max != null ? { max } : {}) } : undefined };
  };
  const args = () => floatPathsArgs(opts(), projectArgs());
  const run = async () => {
    let a: Record<string, unknown>;
    try { a = floatPathsArgs(opts(), {}); } catch (e) { return toast((e as Error).message); }
    setErr(''); setNote(''); setRes(null); setStamp(null);
    const r = await fp.start(a);
    if (!r) return;
    const why = refusal(r);
    if (why) return wasCancelled(r) ? setNote(why) : setErr(why);
    setRes(r.out as FloatAnswer); setStamp(r.stamp);
  };
  return (
    <div style={box}>
      <div style={bar}>
        <label>Paths <input style={{ width: 40 }} value={count} onChange={(e) => setCount(e.target.value)} /></label>
        <label>End activity <input style={{ width: 90 }} value={end} placeholder="latest finish" onChange={(e) => setEnd(e.target.value)} /></label>
        <label>Method <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}><option value="free_float">Free float (longest path first)</option><option value="total_float">Total float</option></select></label>
        <label>Near critical: up to <input style={{ width: 36 }} value={near} onChange={(e) => setNear(e.target.value)} /> days of float</label>
        <label title="Every logic path from one activity to another, longest first; at most that many of them (blank: the tool's 25)">Between <input style={{ width: 80 }} value={from} placeholder="from" onChange={(e) => setFrom(e.target.value)} /> and <input style={{ width: 80 }} value={to} placeholder="to" onChange={(e) => setTo(e.target.value)} />, at most <input style={{ width: 36 }} value={most} placeholder="25" onChange={(e) => setMost(e.target.value)} /></label>
        {!fp.running ? <button className="btn primary" onClick={() => void run()}>Find paths</button> : <><button className="btn" onClick={fp.cancel} title="Ends the run; nothing is changed">Cancel</button><span className="muted">Finding the paths in a separate process…</span></>}
        <ExportButton tool="float_paths" args={args} />
      </div>
      {note && !err && <div className="muted">{note}</div>}
      {err ? <div style={{ ...red, whiteSpace: 'pre-wrap' }}>{err}</div> : !res ? <div className="muted">P6's multiple float paths: path 1 follows the most critical links back from the end activity, each next path is the unassigned chain with the most critical link into the paths found. The Float Path columns are not written here.</div> : (
        <div style={panel}>
          <div className="muted">Paths end at {res.end ?? '-'} (method {res.method.replace('_', ' ')}).{changed ? ` (${CHANGED_SINCE})` : ''}</div>
          <table className="tbl" style={{ marginTop: 4 }}><thead><tr><th>Path</th><th>Float (d)</th><th>Activities</th><th>Listed in order</th></tr></thead>
            <tbody>{res.paths.map((p) => <tr key={p.path} style={{ verticalAlign: 'top' }}><td>{p.path}</td><td>{p.float_hours == null ? '-' : n1(p.float_hours / hpd, 1)}</td><td>{p.activities.length}</td><td style={{ whiteSpace: 'normal' }}><Ids ids={p.activities.map((a) => a.id)} /></td></tr>)}</tbody></table>
          {res.between && <div data-between style={{ marginTop: 10, border: '1px solid #e3e5e8', borderRadius: 14, background: '#f7f8f9', padding: 8 }}>
            <div><b>Paths between {res.between.from} and {res.between.to}</b> ({betweenCount(res.between)}{res.between.truncated ? ': raise max to list more' : ''})</div>
            {!res.between.paths.length ? <div className="muted">No logic path leads from {res.between.from} to {res.between.to}.</div> :
              <table className="tbl" style={{ marginTop: 4 }}><thead><tr><th>Path</th><th>Duration (d)</th><th>Lowest float (d)</th><th>Activities</th></tr></thead>
                <tbody>{res.between.paths.map((p, i) => <tr key={i} style={{ verticalAlign: 'top' }}><td>{i + 1}</td><td style={{ textAlign: 'right' }}>{p.duration_days}</td><td style={{ textAlign: 'right' }}>{p.min_float_days ?? '-'}</td><td style={{ whiteSpace: 'normal' }}><Ids ids={p.activities} /></td></tr>)}</tbody></table>}
          </div>}
          <div style={{ marginTop: 8 }}><b>Near critical</b> ({res.near_critical.length})</div>
          <table className="tbl"><thead><tr><th>Activity</th><th>Name</th><th>Total float (d)</th></tr></thead><tbody>{res.near_critical.slice(0, 200).map((x) => <tr key={x.id}><td><Id id={x.id} /></td><td>{x.name}</td><td style={{ textAlign: 'right' }}>{x.total_float_days}</td></tr>)}</tbody></table>
          {res.near_critical.length > 200 && <div className="muted">{res.near_critical.length - 200} more: Export… lists all.</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Progress curves (progress_curves)
function Lines({ labels, series }: { labels: string[]; series: { name: string; color: string; dash?: string; v: (number | null)[] }[] }) {
  const W = 760, H = 230, L = 54, R = 10, T = 10, B = 24;
  const max = Math.max(1, ...series.flatMap((s) => s.v.map((x) => x ?? 0)));
  const x = (i: number) => L + (labels.length > 1 ? (i / (labels.length - 1)) * (W - L - R) : 0), y = (v: number) => T + (1 - v / max) * (H - T - B);
  return (
    <svg viewBox={`0 0 ${W} ${H + 8}`} style={{ width: '100%', maxWidth: 900, background: '#fff' }}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="#e3e5e8" /><text x={L - 4} y={y(max * f) + 3} fontSize="10" textAnchor="end" fill="#666">{n1(max * f, 0)}</text></g>)}
      {labels.map((l, i) => (i % Math.max(1, Math.ceil(labels.length / 8)) === 0 ? <text key={i} x={x(i)} y={H - 10} fontSize="10" textAnchor="middle" fill="#666">{l}</text> : null))}
      {series.map((s) => <polyline key={s.name} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} points={s.v.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ')} />)}
      {series.map((s, i) => <g key={s.name}><line x1={L + 8 + i * 130} x2={L + 28 + i * 130} y1={H + 2} y2={H + 2} stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} /><text x={L + 32 + i * 130} y={H + 5} fontSize="10" fill="#444">{s.name}</text></g>)}
    </svg>
  );
}

export function ProgressCurvesPanel() {
  const ui = useStore((s) => s.ui);
  const [period, setPeriod] = useState<'week' | 'month'>('month');
  const [units, setUnits] = useState<'cost' | 'hours'>('cost');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [res, setRes] = useState<ProgressCurves | null>(null);
  const bad = () => { if ((from && dt(from) == null) || (to && dt(to) == null)) throw new Error('Enter valid dates.'); };
  const run = () => { try { bad(); } catch (e) { return toast((e as Error).message); } setRes(progressCurves(getDb(), ui.openProjects, { period, units, from: dt(from) ?? undefined, to: dt(to) ?? undefined })); };
  const t = res?.totals;
  return (
    <div style={box}>
      <div style={bar}>
        <label>Period <select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}><option value="month">Month</option><option value="week">Week</option></select></label>
        <label>Units <select value={units} onChange={(e) => setUnits(e.target.value as typeof units)}><option value="cost">Cost</option><option value="hours">Hours</option></select></label>
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn primary" onClick={run}>Calculate curves</button>
        <ExportButton tool="progress_curves" args={() => { bad(); return { ...projectArgs(), period, units, ...(from ? { from: from.replace('T', ' ') } : {}), ...(to ? { to: to.replace('T', ' ') } : {}) }; }} />
      </div>
      {!res || !t ? <div className="muted">S-curves as the Activity Usage Profile: planned value (baseline), earned value and actual cost to the data date, remaining along the early and late dates, with SPI and CPI. CPI is blank when no actual cost is recorded.</div> : (
        <div style={panel}>
          <div style={cards}>{([['BAC', t.bac], ['PV', t.pv], ['EV', t.ev], ['AC', t.ac], ['EAC', t.eac], ['VAC', t.vac]] as const).map(([k, v]) => <Card key={k} label={k} value={n1(v, 0)} />)}<Card label="SPI" value={n1(t.spi)} /><Card label="CPI" value={n1(t.cpi)} /><Card label="TCPI" value={n1(t.tcpi)} /></div>
          <div className="muted" style={{ margin: '6px 0' }}>Data date {date(res.data_date)} · {res.baseline ? `baseline ${res.baseline}` : 'no baseline: current budget and planned dates'} · {res.units}</div>
          <Lines labels={res.periods.map((p) => date(p.start))} series={[
            { name: 'Cum. planned', color: '#8a8f98', v: res.periods.map((p) => p.cum_pv) },
            { name: 'Cum. earned', color: '#2f6f4f', v: res.periods.map((p) => p.cum_ev) },
            { name: 'Cum. actual', color: '#a14b4b', v: res.periods.map((p) => p.cum_ac) },
            { name: 'Forecast (early)', color: '#4a6fa5', dash: '5 3', v: res.periods.map((p) => p.cum_forecast_early) },
          ]} />
          {res.notes.map((w) => <div key={w} className="muted">{w}</div>)}
          <table className="tbl" style={{ marginTop: 6 }}><thead><tr><th>Start</th><th>PV</th><th>EV</th><th>AC</th><th>Remaining (early)</th><th>Cum. PV</th><th>Cum. EV</th><th>Cum. AC</th><th>SPI</th><th>CPI</th></tr></thead>
            <tbody>{res.periods.map((p) => <tr key={p.start}><td>{date(p.start)}</td><td>{n1(p.pv, 0)}</td><td>{n1(p.ev, 0)}</td><td>{n1(p.ac, 0)}</td><td>{n1(p.remaining_early, 0)}</td><td>{n1(p.cum_pv, 0)}</td><td>{n1(p.cum_ev, 0)}</td><td>{n1(p.cum_ac, 0)}</td><td>{n1(p.spi)}</td><td>{n1(p.cpi)}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Resource histogram (resource_histogram)
function Bars({ r }: { r: ResourceHistogram }) {
  const W = 760, H = 190, L = 50, B = 22, T = 8;
  const max = Math.max(1, ...r.periods.map((p) => Math.max(p.actual + p.remaining_early, p.limit ?? 0)));
  const bw = (W - L - 6) / Math.max(1, r.periods.length), y = (v: number) => T + (1 - v / max) * (H - T - B);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 900, background: '#fff' }}>
      {[0, 0.5, 1].map((f) => <g key={f}><line x1={L} x2={W - 6} y1={y(max * f)} y2={y(max * f)} stroke="#e3e5e8" /><text x={L - 4} y={y(max * f) + 3} fontSize="10" textAnchor="end" fill="#666">{n1(max * f, 0)}</text></g>)}
      {r.periods.map((p, i) => { const v = p.actual + p.remaining_early; return <g key={p.start}><rect x={L + i * bw + 1} y={y(v)} width={Math.max(1, bw - 2)} height={Math.max(0, y(0) - y(v))} fill={p.over_allocated > 0 ? '#a14b4b' : '#8a9bb3'} /><title>{`${date(p.start)}: ${n1(v)} (limit ${p.limit == null ? 'none' : n1(p.limit)})`}</title></g>; })}
      <polyline fill="none" stroke="#333" strokeWidth="1.5" strokeDasharray="4 3" points={r.periods.map((p, i) => (p.limit == null ? null : `${L + i * bw},${y(p.limit)} ${L + (i + 1) * bw},${y(p.limit)}`)).filter(Boolean).join(' ')} />
      {r.periods.map((p, i) => (i % Math.max(1, Math.ceil(r.periods.length / 8)) === 0 ? <text key={p.start} x={L + i * bw + bw / 2} y={H - 6} fontSize="10" textAnchor="middle" fill="#666">{date(p.start)}</text> : null))}
    </svg>
  );
}

export function ResourceHistogramPanel() {
  const ui = useStore((s) => s.ui);
  const [period, setPeriod] = useState<'week' | 'month'>('week');
  const [cost, setCost] = useState(false);
  const [list, setList] = useState('');
  const [threshold, setThreshold] = useState('');
  const [res, setRes] = useState<ReturnType<typeof resourceHistograms> | null>(null);
  const [pick, setPick] = useState('');
  const ids = () => list.split(',').map((x) => x.trim()).filter(Boolean);
  const run = () => {
    let th: number | undefined;
    try { th = numberOf('The threshold', threshold); } catch (e) { return toast((e as Error).message); }
    const r = resourceHistograms(getDb(), ui.openProjects, { resources: ids().length ? ids() : undefined, period, cost, threshold: th });
    if (ids().length && !r.resources.length) return toast(`No assignments for ${ids().join(', ')}. Use resource IDs that are assigned in this project.`);
    setRes(r); setPick(r.resources[0]?.resource ?? '');
  };
  const cur = res?.resources.find((r) => r.resource === pick);
  return (
    <div style={box}>
      <div style={bar}>
        <label>Period <select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}><option value="week">Week</option><option value="month">Month</option></select></label>
        <label>Resources <input style={{ width: 150 }} value={list} placeholder="all (IDs, comma separated)" onChange={(e) => setList(e.target.value)} /></label>
        <label><input type="checkbox" checked={cost} onChange={(e) => setCost(e.target.checked)} /> Cost instead of hours</label>
        <label title="Over-allocated when demand is more than the limit times this (default 1)">Threshold <input style={{ width: 40 }} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
        <button className="btn primary" onClick={run}>Show histogram</button>
        <ExportButton tool="resource_histogram" args={() => ({ ...projectArgs(), ...(ids().length ? { resources: ids() } : {}), period, cost, ...(numberOf('The threshold', threshold) != null ? { threshold: numberOf('The threshold', threshold) } : {}) })} />
      </div>
      {!res ? <div className="muted">Resource Usage Profile per resource and period: budgeted, actual and remaining units against the resource's Max Units/Time limit, with the over-allocation and its severity.</div> : (
        <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
          <div style={{ ...panel, flex: 'none', width: 430 }}>
            <table className="tbl"><thead><tr><th>Resource</th><th>Peak</th><th>Limit</th><th>Over-alloc. periods</th><th>Severity</th></tr></thead>
              <tbody>{res.resources.map((r) => <tr key={r.resource} className={pick === r.resource ? 'sel' : ''} style={{ cursor: 'pointer' }} onMouseDown={() => setPick(r.resource)}><td title={r.name}>{r.resource}</td><td style={{ textAlign: 'right' }}>{n1(r.peak?.demand)}</td><td style={{ textAlign: 'right' }}>{n1(r.peak?.limit)}</td><td style={{ textAlign: 'right' }}>{r.over_allocated_periods}</td><td>{r.severity}</td></tr>)}</tbody></table>
          </div>
          <div style={panel}>{cur ? <>
            <div><b>{cur.resource}</b> {cur.name} <span className="muted">({cur.units}; bars are actual plus remaining, the dashed line is the limit, red bars are over-allocated)</span></div>
            <Bars r={cur} />
            <table className="tbl"><thead><tr><th>Start</th><th>Budgeted</th><th>Actual</th><th>Remaining early</th><th>Remaining late</th><th>Limit</th><th>Over</th></tr></thead>
              <tbody>{cur.periods.map((p) => <tr key={p.start}><td>{date(p.start)}</td><td>{n1(p.budgeted)}</td><td>{n1(p.actual)}</td><td>{n1(p.remaining_early)}</td><td>{n1(p.remaining_late)}</td><td>{n1(p.limit)}</td><td>{p.over_allocated ? n1(p.over_allocated) : ''}</td></tr>)}</tbody></table>
          </> : null}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Level resources (level_resources, report only)
const PRIORITY = { early_start: 'es', total_float: 'tf', priority: 'priority' } as const;
/** level_resources' answer (a dry run): what the panel shows. */
type LevelAnswer = { delayed: number; moved: { id: string; from: string; start: string; finish: string }[]; peaks: { resource: string; peak: number; limit: number; day: string | null; overallocated: boolean }[]; report: string };
export function LevelPanel() {
  const [withinFloat, setWithinFloat] = useState(false);
  const [pct, setPct] = useState('');
  const [by, setBy] = useState<keyof typeof PRIORITY>('early_start');
  const [rs, setRs] = useState('');
  const [first, setFirst] = useState('');
  const [res, setRes] = useState<LevelAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState<RunStamp | null>(null);
  const changed = useChangedSince(stamp);
  // the run: going while it is (until its answer is in), stop when Cancel was clicked or the panel switched away from (a run still
  // going then is ended, as Monte Carlo's); only this panel's run is cancelled, never an Export of the tool
  const going = useRef(false), stop = useRef(false), mounted = useRef(true), runId = useRef('');
  const cancel = () => { stop.current = true; void window.p6.analysisCancel({ id: runId.current }); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (going.current) cancel(); }; }, []);
  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const allIds = (d: Db) => rows(d, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id);
  /** The panel's refusals before anything runs, in its words (the tool refuses the same, in its own). */
  const check = (d: Db) => {
    const R = rows(d, 'RSRC'), T = rows(d, 'TASK').filter((t) => allIds(d).includes(t.proj_id));
    for (const c of list(rs)) if (!R.some((r) => r.rsrc_short_name.toLowerCase() === c.toLowerCase())) throw new Error(`No resource "${c}". Use resource IDs.`);
    for (const c of list(first)) if (!T.some((t) => t.task_code === c)) throw new Error(`No activity "${c}". Use Activity IDs.`);
    const p = numberOf('The over-allocation allowed', pct);
    if (p != null && !(p >= 0)) throw new Error('Over-allocation must be 0 or more, e.g. 10 for 10 %.');
  };
  /** level_resources' arguments from the settings, as a dry run (it levels every project of the database; nothing is changed). */
  const args = () => {
    check(getDb());
    return { dry_run: true, within_float: withinFloat, ...(numberOf('The over-allocation allowed', pct) != null ? { over_allocation_pct: numberOf('The over-allocation allowed', pct) } : {}), priority_by: by, ...(list(rs).length ? { resources: list(rs) } : {}), ...(list(first).length ? { activity_priority: list(first) } : {}) };
  };
  // the tool itself, in the Export's child process on the saved database (main/analysis-export-ipc.ts): leveling a big schedule never
  // holds the window, and the screen is what Export… writes
  const run = async () => {
    let a: Record<string, unknown>;
    try { a = args(); } catch (e) { return toast((e as Error).message); }
    setBusy(true); going.current = true; stop.current = false;
    const started = stampNow();
    try {
      if (!(await saveNow())) return toast('The project changed while it was being saved, so nothing was leveled. Click Level (report) again.');
      if (stop.current) { if (mounted.current) toast('The level_resources run was cancelled; nothing was changed.'); return; } // (before its child started)
      runId.current = `level_resources#${++levelRuns}`; // (this panel's own run: another panel's Cancel never ends it)
      const r = await window.p6.analysisRun('level_resources', a, getUi().prefs.hoursPerDay, undefined, undefined, runId.current);
      if (!mounted.current) return;
      const code = r.out.error?.code;
      if (code === 'export_busy' || code === 'cancelled') return toast(String(r.out.error.message));
      if (r.isError) return toast(`Level resources failed: ${errorText(r.out)}`);
      setRes(r.out as LevelAnswer); setStamp(started);
    } catch (e) { if (mounted.current) toast(`Level resources failed: ${(e as Error).message}`); } finally { going.current = false; if (mounted.current) setBusy(false); }
  };
  return (
    <div style={box}>
      <div style={bar}>
        <label><input type="checkbox" checked={withinFloat} disabled={busy} onChange={(e) => setWithinFloat(e.target.checked)} /> Only within total float</label>
        <label>Over-allocation allowed <input style={{ width: 40 }} value={pct} placeholder="0" disabled={busy} onChange={(e) => setPct(e.target.value)} /> %</label>
        <label>Priority <select value={by} disabled={busy} onChange={(e) => setBy(e.target.value as typeof by)}><option value="early_start">Early start</option><option value="total_float">Total float</option><option value="priority">Activity priority</option></select></label>
        <label>Resources <input style={{ width: 130 }} value={rs} placeholder="all with a limit" disabled={busy} onChange={(e) => setRs(e.target.value)} /></label>
        <label>Placed first <input style={{ width: 130 }} value={first} placeholder="activity IDs" disabled={busy} onChange={(e) => setFirst(e.target.value)} /></label>
        {!busy ? <button className="btn primary" onClick={() => void run()}>Level (report)</button> : <><button className="btn" onClick={cancel}>Cancel</button><span className="muted">Leveling in a separate process…</span></>}
        <ExportButton tool="level_resources" args={args} />
      </div>
      {!res ? <div className="muted">Resource leveling on a copy of the database: which activities it would delay and the peak of each leveled resource afterwards. Nothing is changed here, and Level (report) and Export… run the tool as a dry run, in a separate process. Resources need a Max Units/Time limit.</div> : (
        <div style={panel}>
          <div style={cards}><Card label="Activities delayed" value={String(res.delayed)} /><Card label="Moved" value={String(res.moved.length)} /></div>
          {changed && <div className="muted">({CHANGED_SINCE})</div>}
          <div className="muted" style={{ margin: '6px 0', whiteSpace: 'pre-wrap' }}>{res.report}</div>
          <table className="tbl"><thead><tr><th>Resource</th><th>Peak (unit-hours/day)</th><th>Limit</th><th>Peak day</th><th>Over-allocated</th></tr></thead>
            <tbody>{res.peaks.map((p) => <tr key={p.resource}><td>{p.resource}</td><td style={{ textAlign: 'right' }}>{n1(p.peak)}</td><td style={{ textAlign: 'right' }}>{n1(p.limit)}</td><td>{date(p.day)}</td><td>{p.overallocated ? 'yes' : ''}</td></tr>)}</tbody></table>
          <table className="tbl" style={{ marginTop: 8 }}><thead><tr><th>Activity</th><th>Early start before</th><th>Start after</th><th>Finish after</th></tr></thead>
            <tbody>{res.moved.slice(0, 500).map((m) => <tr key={m.id}><td><Id id={m.id} /></td><td>{m.from.slice(0, 16)}</td><td>{m.start.slice(0, 16)}</td><td>{m.finish.slice(0, 16)}</td></tr>)}</tbody></table>
          {res.moved.length > 500 && <div className="muted">{res.moved.length - 500} more: Export… lists all.</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Evaluate one change (evaluate)
export function EvaluatePanel() {
  const ui = useStore((s) => s.ui);
  const [id, setId] = useState('');
  const [field, setField] = useState<'duration_days' | 'remaining_days'>('duration_days');
  const [value, setValue] = useState('');
  const [dd, setDd] = useState('');
  const [res, setRes] = useState<ReturnType<typeof evaluate> | null>(null);
  /** The change as the tool's edit operation. */
  const overrides = () => {
    if (!id.trim()) throw new Error('Enter an activity ID and a number of days.');
    const v = numberOf('The number of days', value, true)!;
    if (dd && dt(dd) == null) throw new Error('Enter a valid data date.');
    return [{ op: 'update_activity', id: id.trim(), [field]: v }];
  };
  const run = () => {
    let o: ReturnType<typeof overrides>;
    try { o = overrides(); } catch (e) { return toast((e as Error).message); }
    // a copy: the evaluation schedules and edits a scratch state, and the project stays as it is
    setRes(evaluate(structuredClone(getDb()), ui.openProjects, { overrides: o, dataDate: dt(dd) ?? undefined, hoursPerDay: ui.prefs.hoursPerDay }));
  };
  const rowsOut = useMemo(() => (res?.ok ? (res.changed as { id: string; [k: string]: unknown }[]).flatMap((c) => (c.deleted ? [{ id: c.id, field: '(deleted)', before: '', after: '' }] : Object.entries(c).filter(([, v]) => Array.isArray(v)).map(([f, v]) => ({ id: c.id, field: f, before: String((v as unknown[])[0] ?? ''), after: String((v as unknown[])[1] ?? '') })))) : []), [res]);
  return (
    <div style={box}>
      <div style={bar}>
        <label>Activity <input style={{ width: 90 }} value={id} placeholder="Activity ID" onChange={(e) => setId(e.target.value)} /></label>
        <label>Set <select value={field} onChange={(e) => setField(e.target.value as typeof field)}><option value="duration_days">Duration</option><option value="remaining_days">Remaining duration</option></select></label>
        <label>to <input style={{ width: 54 }} value={value} onChange={(e) => setValue(e.target.value)} /> days</label>
        <label>Data date <input type="datetime-local" value={dd} onChange={(e) => setDd(e.target.value)} title="Default: the project's data date" /></label>
        <button className="btn primary" onClick={run}>Evaluate</button>
        <ExportButton tool="evaluate" args={() => ({ ...projectArgs(), overrides: overrides(), ...(dd ? { data_date: dd.replace('T', ' ') } : {}) })} />
      </div>
      {res && !res.ok && <div style={red}>{res.error.message}</div>}
      {!res && <div className="muted">What-if without changing the project: schedules a scratch copy as it is and with the change, and shows what moved.</div>}
      {res?.ok && <div style={panel}>
        <div style={cards}><Card label="Finish as it is" value={date(res.base_finish)} id="base" /><Card label="Finish with the change" value={date(res.finish)} id="finish" /><Card label="Change (working days)" value={String(res.finish_delta_days ?? '-')} id="delta" /><Card label="Critical" value={String(res.critical.length)} /></div>
        <div style={{ margin: '6px 0' }}>Became critical: {res.became_critical.length ? <Ids ids={res.became_critical} /> : 'none'} · No longer critical: {res.no_longer_critical.length ? <Ids ids={res.no_longer_critical} /> : 'none'}</div>
        {res.notes.map((w) => <div key={w} className="muted">{w}</div>)}
        <table className="tbl"><thead><tr><th>Activity</th><th>Field</th><th>Before</th><th>After</th></tr></thead>
          <tbody>{rowsOut.map((r, i) => <tr key={i}><td><Id id={r.id} /></td><td>{r.field}</td><td>{r.before}</td><td>{r.after}</td></tr>)}</tbody></table>
        {res.changed_total > res.changed.length && <div className="muted">{res.changed_total - res.changed.length} more activities changed: Export… lists all.</div>}
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------- Compare (compare)
type Compared = { mode: 'all' | 'computed'; changes: Record<string, unknown>[]; summary?: Record<string, { added: number; deleted: number; changed: number }>; became: string[]; no_longer: string[]; only_a: string[]; only_b: string[]; title: string };
export function ComparePanel() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const projects = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
  const cur = projects.find((p) => p.proj_id === ui.openProjects[0]);
  const others = projects.filter((p) => p.proj_id !== cur?.proj_id);
  const [source, setSource] = useState<'project' | 'file' | 'baseline'>('project');
  const [other, setOther] = useState('');
  const [file, setFile] = useState<{ path: string; name: string; db: Db } | null>(null);
  const [baseline, setBaseline] = useState('project');
  const [mode, setMode] = useState<'all' | 'computed'>('computed');
  const [res, setRes] = useState<Compared | null>(null);
  const [err, setErr] = useState('');
  const otherId = other || others[0]?.proj_id || '';
  const hpd = ui.prefs.hoursPerDay;
  const pick = async () => {
    const f = await window.p6.openFile([{ name: 'Schedules', extensions: ['xer', 'xml', 'mpx', 'mpp'] }], 'Compare with a file');
    if (!f) return;
    try { setFile({ path: f.path, name: f.name, db: (await parseFileAsync(f.name, f.bytes, undefined, window.p6)).db }); setErr(''); } catch (e) { setErr((e as Error).message); }
  };
  const run = () => {
    setErr(''); setRes(null);
    if (!cur) return;
    try {
      if (source === 'baseline') {
        const bl = baselineOf(db, cur, baseline as 'project');
        if (!bl) throw new Error(`The project has no ${baseline} baseline in this file.`);
        const c = compareComputed(db, db, hpd, { aProjIds: [bl.projId], bProjIds: [cur.proj_id] });
        return setRes({ mode: 'computed', changes: c.changes, became: c.became_critical, no_longer: c.no_longer_critical, only_a: c.only_in_a, only_b: c.only_in_b, title: `${cur.proj_short_name} against its baseline ${bl.name}` });
      }
      const a = onlyProjects(db, [cur.proj_id]);
      let b: Db, title: string;
      if (source === 'project') { if (!otherId) throw new Error('There is no other project in the database to compare with.'); b = onlyProjects(db, [otherId]); title = `${cur.proj_short_name} against ${others.find((p) => p.proj_id === otherId)?.proj_short_name}`; }
      else { if (!file) throw new Error('Choose a file to compare with.'); b = file.db; title = `${cur.proj_short_name} against ${file.name}`; }
      if (mode === 'computed') { const c = compareComputed(a, b, hpd); return setRes({ mode, changes: c.changes, became: c.became_critical, no_longer: c.no_longer_critical, only_a: c.only_in_a, only_b: c.only_in_b, title }); }
      const cs: ScheduleChange[] = compareSchedules(a, b, hpd, true);
      const count = (o: string, k: string) => cs.filter((c) => c.object === o && c.kind === k).length;
      setRes({ mode, changes: cs as unknown as Record<string, unknown>[], summary: Object.fromEntries(['project', 'wbs', 'activity', 'relationship'].map((o) => [o, { added: count(o, 'added'), deleted: count(o, 'deleted'), changed: new Set(cs.filter((c) => c.object === o && c.kind === 'changed').map((c) => c.id)).size }])), became: [], no_longer: [], only_a: [], only_b: [], title });
    } catch (e) { setErr((e as Error).message); }
  };
  /** The tool's arguments, and the sessions it needs: this project (and the other one) alone, as a file each. */
  const spec = (): { args: Record<string, unknown>; parts: { scope?: string[]; others?: Record<string, string[]> } } => {
    if (!cur) throw new Error('Open a project first.');
    if (source === 'baseline') return { args: { baseline, project: cur.proj_short_name }, parts: {} };
    if (source === 'file') { if (!file) throw new Error('Choose a file to compare with.'); return { args: { path: file.path, mode }, parts: { scope: [cur.proj_id] } }; }
    if (!otherId) throw new Error('There is no other project in the database to compare with.');
    return { args: { other_handle: '@other', mode }, parts: { scope: [cur.proj_id], others: { other: [otherId] } } };
  };
  const cols = res ? [...new Set(res.changes.slice(0, 500).flatMap((c) => Object.keys(c)))] : [];
  return (
    <div style={box}>
      <div style={bar}>
        <span>Compare <b>{cur?.proj_short_name ?? '-'}</b> with</span>
        <select value={source} onChange={(e) => { setSource(e.target.value as typeof source); setRes(null); }}><option value="project">another project of the database</option><option value="file">a file</option><option value="baseline">a baseline</option></select>
        {source === 'project' && <select value={otherId} onChange={(e) => setOther(e.target.value)}>{others.map((p) => <option key={p.proj_id} value={p.proj_id}>{p.proj_short_name}</option>)}</select>}
        {source === 'file' && <><button className="btn" onClick={() => void pick()}>Choose file…</button><span className="muted">{file?.name ?? 'none chosen'}</span></>}
        {source === 'baseline' && <select value={baseline} onChange={(e) => setBaseline(e.target.value)}><option value="project">Project baseline</option><option value="bl1">BL1</option><option value="bl2">BL2</option><option value="bl3">BL3</option>{rows(db, 'PROJECT').filter((b) => b._baseline_of === cur?.proj_id).map((b) => <option key={b.proj_id} value={b.proj_short_name}>{b.proj_short_name}</option>)}</select>}
        {source !== 'baseline' && <label>Compare <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="computed">what the schedule computes</option><option value="all">everything</option></select></label>}
        <button className="btn primary" onClick={run}>Compare</button>
        <ExportButton tool="compare" args={() => spec().args} parts={() => spec().parts} />
      </div>
      {err && <div style={red}>{err}</div>}
      {!res && !err && <div className="muted">Like P6's Claim Digger: projects by Project ID, WBS by code path, activities by Activity ID, relationships by predecessor, successor and type. Against a baseline, or on what the schedule computes: duration, start and finish shifts, float and critical-path changes.</div>}
      {res && <div style={panel}>
        <div><b>{res.title}</b> · {res.changes.length} changes{res.mode === 'computed' ? ` · ${res.became.length} became critical · ${res.no_longer.length} no longer critical · ${res.only_a.length} only before · ${res.only_b.length} only after` : ''}</div>
        {res.summary && <table className="tbl" style={{ width: 'auto', margin: '4px 0' }}><thead><tr><th /><th>Added</th><th>Deleted</th><th>Changed</th></tr></thead><tbody>{Object.entries(res.summary).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.added}</td><td>{v.deleted}</td><td>{v.changed}</td></tr>)}</tbody></table>}
        {res.mode === 'computed' && res.became.length > 0 && <div>Became critical: <Ids ids={res.became} /></div>}
        {res.mode === 'computed' && res.no_longer.length > 0 && <div>No longer critical: <Ids ids={res.no_longer} /></div>}
        <table className="tbl" style={{ marginTop: 4 }}><thead><tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
          <tbody>{res.changes.slice(0, 500).map((c, i) => <tr key={i}>{cols.map((k) => <td key={k}>{c[k] == null ? '' : String(c[k])}</td>)}</tr>)}</tbody></table>
        {res.changes.length > 500 && <div className="muted">{res.changes.length - 500} more: Export… lists all.</div>}
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------- Review (review)
const GRADE = { pass: '#1d6b2d', warn: '#a06a00', fail: '#a01818' } as const;
export function ReviewPanel() {
  const ui = useStore((s) => s.ui);
  const [res, setRes] = useState<Review | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // as the tool works it: every project of the database, days of each activity's own calendar, 10 examples a check
  const run = () => { const r = reviewSchedule(getDb(), { hoursPerDay: ui.prefs.hoursPerDay, calendarDays: true, examples: 0 }); setRes(r); setOpen(r.checks.find((c) => c.grade === 'fail')?.id ?? null); };
  return (
    <div style={box}>
      <div style={bar}>
        <button className="btn primary" onClick={run}>Review schedule</button>
        <ExportButton tool="review" args={() => ({})} />
      </div>
      {!res ? <div className="muted">A schedule quality review of the whole database: missing logic, leads, lags, relationship types, hard constraints, float, long durations, invalid dates, resources, out-of-sequence work, and whether the saved dates are the ones P6 would calculate. Each check passes, warns or fails.</div> : (
        <div style={panel}>
          <div style={cards}><Card label="Overall" value={res.grade.toUpperCase()} /><Card label="Open activities" value={String(res.openActivities)} /><Card label="Relationships" value={String(res.relationships)} /></div>
          <div className="muted" style={{ margin: '6px 0' }}>{res.projects.join(', ')}</div>
          <table className="tbl"><thead><tr><th>Check</th><th>Result</th><th>Found</th><th>Of</th><th>%</th><th>Limit</th></tr></thead>
            <tbody>{res.checks.map((c) => [
              <tr key={c.id} className={open === c.id ? 'sel' : ''} style={{ cursor: 'pointer' }} onMouseDown={() => setOpen(open === c.id ? null : c.id)}><td>{c.title}</td><td style={{ color: open === c.id ? undefined : GRADE[c.grade], fontWeight: c.grade === 'fail' ? 'bold' : undefined }}>{c.grade}</td><td>{c.count}</td><td>{c.of}</td><td>{c.percent ?? '-'}</td><td>{c.limit}</td></tr>,
              open === c.id && <tr key={`${c.id}:d`}><td colSpan={6} style={{ whiteSpace: 'normal', background: '#f7f8fa' }}>{c.detail}{c.examples.length > 0 && <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{(c.id === 'saved_dates' ? c.examples : c.examples.slice(0, 10)).map((x) => <li key={x}>{x}</li>)}</ul>}{c.examples_total != null && c.examples_total > 10 && <div className="muted">{c.examples_total - 10} more: Export… lists all.</div>}</td></tr>,
            ])}</tbody></table>
        </div>
      )}
    </div>
  );
}
