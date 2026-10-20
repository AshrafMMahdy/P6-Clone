// Extensions for delay analysis: windows (contemporaneous or half-step) across project updates kept in the database,
// and time impact analysis with a fragnet entered here. Both run on copies; Keep adds the impacted project as a copy.
import { useMemo, useState } from 'react';
import { getDb, mutate, toast, useStore } from '../store.ts';
import { rows } from '../../core/db.ts';
import { parseP6Date } from '../../core/dates.ts';
import { applyOps } from '../../core/project/ops.ts';
import { scheduleProjects } from '../../core/schedule/cpm.ts';
import { baselineOf } from '../../core/analysis/common.ts';
import { timeImpact, windowsAnalysis } from '../../core/analysis/delay.ts';
import { goToActivity } from './AnalysisResults.tsx';

const Id = ({ id }: { id: string }) => <a href="#" onClick={(e) => { e.preventDefault(); goToActivity(id); }}>{id}</a>;
const Ids = ({ ids, max = 12 }: { ids: string[]; max?: number }) => <>{ids.slice(0, max).map((c, i) => <span key={c}>{i ? ', ' : ''}<Id id={c} /></span>)}{ids.length > max ? ` … +${ids.length - max}` : ''}</>;
const box = { display: 'flex', flexDirection: 'column', gap: 6, height: '100%', minHeight: 0 } as const;
const bar = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } as const;
const red = { color: '#b00020' };

export function WindowsPanel() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  // every project and baseline in the database is a candidate update, with its data date
  const all = useMemo(() => rows(db, 'PROJECT').map((p) => ({ id: p.proj_id, name: p.proj_short_name + (p._baseline_of ? ' (baseline)' : ''), dd: p.last_recalc_date?.slice(0, 10) ?? '' })).sort((a, b) => a.dd.localeCompare(b.dd)), [db]);
  const [pick, setPick] = useState<Set<string>>(() => new Set(ui.openProjects.slice(0, 1)));
  const [method, setMethod] = useState<'contemporaneous' | 'half_step'>('contemporaneous');
  const [milestone, setMilestone] = useState('');
  const [res, setRes] = useState<ReturnType<typeof windowsAnalysis> | null>(null);
  const run = () => {
    const ups = all.filter((p) => pick.has(p.id)).map((p) => ({ name: p.name, db: getDb(), projId: p.id }));
    setRes(windowsAnalysis(ups, { method, milestone: milestone.trim() || undefined, hoursPerDay: ui.prefs.hoursPerDay }));
  };
  return (
    <div style={box}>
      <div className="muted">Pick two or more updates of the same project (projects in the database, or baselines), oldest first by data date. Each window compares one update with the next.</div>
      <div style={{ maxHeight: 140, overflow: 'auto', border: '1px solid #c4cfe0', padding: 4 }}>
        {all.map((p) => <label key={p.id} style={{ display: 'block' }}><input type="checkbox" checked={pick.has(p.id)} onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(p.id); else n.delete(p.id); setPick(n); }} /> {p.name} <span className="muted">data date {p.dd || 'not set'}</span></label>)}
      </div>
      <div style={bar}>
        <label>Method <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}><option value="contemporaneous">Contemporaneous (MIP 3.3)</option><option value="half_step">Half-step (MIP 3.4)</option></select></label>
        <label>Milestone <input style={{ width: 90 }} value={milestone} placeholder="completion" onChange={(e) => setMilestone(e.target.value)} /></label>
        <button className="btn primary" onClick={run}>Analyse</button>
      </div>
      {res && !res.ok && <div style={red}>{res.error.message}</div>}
      {res?.ok && <div style={{ overflow: 'auto', flex: 1 }}>
        <div><b>Total slip {res.total_slip_days} working days</b> ({res.measured}){res.total_progress_days != null ? ` · from progress ${res.total_progress_days} · from revisions ${res.total_revision_days}` : ''}</div>
        <table className="tbl"><thead><tr><th>Window</th><th>Finish</th><th>Slip</th>{method === 'half_step' && <th>Progress / revisions</th>}<th>Driving path at start</th><th>Lost time</th><th>Added</th></tr></thead>
          <tbody>{(res.windows as any[]).map((w) => <tr key={w.window} style={{ verticalAlign: 'top' }}>
            <td>{w.from} → {w.to}<div className="muted">{w.data_date_from?.slice(0, 10)} → {w.data_date_to?.slice(0, 10)}</div></td>
            <td>{w.finish_from?.slice(0, 10)} → {w.finish_to?.slice(0, 10)}</td><td>{w.slip_days}</td>
            {method === 'half_step' && <td>{w.half_step.progress_days} / {w.half_step.revision_days}</td>}
            <td><Ids ids={w.driving_path} /></td>
            <td>{w.lost_time.map((l: any) => <div key={l.id}><Id id={l.now ?? l.id} /> {l.lost_days ?? '—'} d <span className="muted">{l.causes.join(', ')}</span></div>)}</td>
            <td><Ids ids={w.added} /></td></tr>)}</tbody></table>
      </div>}
    </div>
  );
}

interface FragAct { id: string; name: string; days: string }
interface FragRel { pred: string; succ: string; type: string; lag: string }

export function TiaPanel() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const cur = rows(db, 'PROJECT').find((p) => p.proj_id === ui.openProjects[0]);
  const [acts, setActs] = useState<FragAct[]>([{ id: 'TIA-01', name: 'Delay event', days: '10' }]);
  const [rels, setRels] = useState<FragRel[]>([{ pred: '', succ: 'TIA-01', type: 'FS', lag: '0' }, { pred: 'TIA-01', succ: '', type: 'FS', lag: '0' }]);
  const [dd, setDd] = useState('');
  const [milestone, setMilestone] = useState('');
  const [bl, setBl] = useState('');
  const [res, setRes] = useState<ReturnType<typeof timeImpact> | null>(null);
  const ops = () => [
    ...acts.filter((a) => a.id.trim()).map((a) => ({ op: 'add_activity', id: a.id.trim(), name: a.name || a.id, duration_days: Number(a.days) || 0 })),
    ...rels.filter((r) => r.pred.trim() && r.succ.trim()).map((r) => ({ op: 'add_relationship', pred: r.pred.trim(), succ: r.succ.trim(), type: r.type, lag_days: Number(r.lag) || 0 })),
  ];
  const run = () => {
    if (!cur) return;
    const b = bl ? baselineOf(getDb(), cur, bl as 'project') : null;
    if (bl && !b) return toast(`The project has no ${bl} baseline.`);
    let bf: number | null = null;
    if (b) for (const t of b.tasks.values()) { if (milestone && t.task_code !== milestone) continue; const v = parseP6Date(t.act_end_date || t.early_end_date || t.target_end_date); if (v != null && (bf == null || v > bf)) bf = v; }
    const d = dd ? parseP6Date(dd.replace('T', ' ')) : undefined;
    setRes(timeImpact(getDb(), [cur.proj_id], ops(), { dataDate: d ?? undefined, milestone: milestone.trim() || undefined, hoursPerDay: ui.prefs.hoursPerDay, baseline: b ? { name: b.name, finish: bf } : undefined }));
  };
  const keep = () => {
    if (!cur) return;
    let id = `${cur.proj_short_name}-TIA`;
    for (let k = 2; rows(getDb(), 'PROJECT').some((p) => p.proj_short_name.toLowerCase() === id.toLowerCase()); k++) id = `${cur.proj_short_name}-TIA${k}`;
    let err = '';
    try { mutate(`TIA ${id}`, (d) => { const x = applyOps(d, [{ op: 'copy_project', from: cur.proj_short_name, id, keep_progress: true }, ...ops().map((o) => ({ ...o, project: id }))], { hoursPerDay: ui.prefs.hoursPerDay }); if (!x.ok) { err = x.error!.message; throw new Error(err); } const p = rows(d, 'PROJECT').find((q) => q.proj_short_name === id)!; scheduleProjects(d, [p.proj_id], dd ? { dataDate: parseP6Date(dd.replace('T', ' ')) ?? undefined } : {}); }); } catch { /* reported */ }
    toast(err ? `Not kept: ${err}` : `Impacted schedule kept as project ${id} (Ctrl+Z undoes).`);
  };
  const setA = (i: number, k: keyof FragAct, v: string) => setActs(acts.map((a, j) => (j === i ? { ...a, [k]: v } : a)));
  const setR = (i: number, k: keyof FragRel, v: string) => setRels(rels.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div style={box}>
      <div className="muted">Time impact analysis (AACE 52R-06): the fragnet is added to a copy of the project and both are scheduled at the same data date; the delay is the change of the completion (or a milestone).</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <table className="tbl"><thead><tr><th>Fragnet activity</th><th>Name</th><th>Days</th></tr></thead>
          <tbody>{acts.map((a, i) => <tr key={i}><td><input style={{ width: 80 }} value={a.id} onChange={(e) => setA(i, 'id', e.target.value)} /></td><td><input value={a.name} onChange={(e) => setA(i, 'name', e.target.value)} /></td><td><input style={{ width: 40 }} value={a.days} onChange={(e) => setA(i, 'days', e.target.value)} /></td></tr>)}</tbody></table>
        <table className="tbl"><thead><tr><th>Predecessor</th><th>Successor</th><th>Type</th><th>Lag d</th></tr></thead>
          <tbody>{rels.map((r, i) => <tr key={i}><td><input style={{ width: 80 }} value={r.pred} onChange={(e) => setR(i, 'pred', e.target.value)} /></td><td><input style={{ width: 80 }} value={r.succ} onChange={(e) => setR(i, 'succ', e.target.value)} /></td><td><select value={r.type} onChange={(e) => setR(i, 'type', e.target.value)}>{['FS', 'SS', 'FF', 'SF'].map((t) => <option key={t}>{t}</option>)}</select></td><td><input style={{ width: 36 }} value={r.lag} onChange={(e) => setR(i, 'lag', e.target.value)} /></td></tr>)}</tbody></table>
      </div>
      <div style={bar}>
        <button className="btn" onClick={() => setActs([...acts, { id: `TIA-${String(acts.length + 1).padStart(2, '0')}`, name: '', days: '1' }])}>Add activity</button>
        <button className="btn" onClick={() => setRels([...rels, { pred: '', succ: '', type: 'FS', lag: '0' }])}>Add link</button>
        <label>Data date <input type="datetime-local" value={dd} onChange={(e) => setDd(e.target.value)} title={`Default: ${cur?.last_recalc_date?.slice(0, 16) || 'the project data date'}`} /></label>
        <label>Milestone <input style={{ width: 90 }} value={milestone} placeholder="completion" onChange={(e) => setMilestone(e.target.value)} /></label>
        <label>Baseline <select value={bl} onChange={(e) => setBl(e.target.value)}><option value="">none</option><option value="project">Project baseline</option><option value="bl1">BL1</option><option value="bl2">BL2</option><option value="bl3">BL3</option></select></label>
        <button className="btn primary" onClick={run}>Analyse</button>
        {res?.ok && <button className="btn" onClick={keep}>Keep impacted copy</button>}
      </div>
      {res && !res.ok && <div style={red}>{res.error.message}</div>}
      {res?.ok && <div style={{ overflow: 'auto', flex: 1 }}>
        <table className="tbl"><tbody>
          <tr><td>Unimpacted finish</td><td>{res.unimpacted_finish?.slice(0, 16)}</td></tr>
          <tr><td>Impacted finish</td><td>{res.impacted_finish?.slice(0, 16)}</td></tr>
          <tr><td><b>Delay</b></td><td><b>{res.delay_days} working days</b>{res.fragnet_on_critical_path ? ' (the fragnet drives the finish)' : ' (the fragnet is off the critical path)'}</td></tr>
          {res.baseline && <tr><td>Against {res.baseline}</td><td>{res.variance_to_baseline_days} working days (baseline finish {res.baseline_finish?.slice(0, 10)})</td></tr>}
          <tr><td>Fragnet path</td><td><Ids ids={res.fragnet_path} max={30} /></td></tr>
          <tr><td>Became critical</td><td><Ids ids={res.became_critical} max={30} /></td></tr>
        </tbody></table>
      </div>}
    </div>
  );
}
