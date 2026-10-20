// Extensions for recovery: least-cost crashing, many what-ifs at once, and the schedule reasoner (the trained
// optimiser, run by the main process). Each works on a copy until Apply, which is one undoable change.
import { useMemo, useState } from 'react';
import { getDb, mutate, toast, useStore } from '../store.ts';
import { rows, type Db } from '../../core/db.ts';
import { applyOps } from '../../core/project/ops.ts';
import { crashSchedule, type CrashActivity } from '../../core/analysis/crash.ts';
import { evaluateBatch, type Scenario } from '../../core/analysis/batch.ts';
import { optimizeSchedule } from '../../core/analysis/hrm.ts';
import { levelResources } from '../../core/level/level.ts';
import { scheduleProjects } from '../../core/schedule/cpm.ts';
import { runSchedule } from '../commands.ts';
import { goToActivity } from './AnalysisResults.tsx';

const Id = ({ id }: { id: string }) => <a href="#" onClick={(e) => { e.preventDefault(); goToActivity(id); }}>{id}</a>;
const box = { display: 'flex', flexDirection: 'column', gap: 6, height: '100%', minHeight: 0 } as const;
const bar = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } as const;

/** Apply edit operations as one undoable change, then F9 (the desktop's fixed hours per day; ops carry hours). */
function applyAndSchedule(label: string, ops: unknown[], after?: (d: Db) => void): boolean {
  let err = '';
  try { mutate(label, (d) => { const r = applyOps(d, ops); if (!r.ok) { err = r.error!.message; throw new Error(err); } }); } catch { /* reported */ }
  if (err) { toast(`Not applied: ${err}`); return false; }
  runSchedule({});
  if (after) mutate(label, after);
  return true;
}

export function CrashPanel() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const [mode, setMode] = useState<'days' | 'date' | 'cost'>('days');
  const [days, setDays] = useState('10');
  const [date, setDate] = useState('');
  const [indirect, setIndirect] = useState('');
  const [ld, setLd] = useState('');
  const [pct, setPct] = useState('30');
  const [data, setData] = useState<Record<string, { min: string; cost: string }>>({});
  const [res, setRes] = useState<ReturnType<typeof crashSchedule> | null>(null);
  // the remaining critical activities are where crash data matters
  const crit = useMemo(() => rows(db, 'TASK').filter((t) => ui.openProjects.includes(t.proj_id) && !t.act_end_date && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE' && t.task_type !== 'TT_Mile' && t.task_type !== 'TT_FinMile' && t.total_float_hr_cnt !== '' && Number(t.total_float_hr_cnt) <= 0).slice(0, 300), [db, ui.openProjects]);
  const run = () => {
    const acts: CrashActivity[] = Object.entries(data).filter(([, v]) => v.min !== '' || v.cost !== '').map(([id, v]) => ({ id, min_days: Number(v.min) || 0, cost_per_day: Number(v.cost) || 0 }));
    setRes(crashSchedule(getDb(), ui.openProjects, {
      targetDays: mode === 'days' ? Number(days) : undefined, targetFinish: mode === 'date' ? date.replace('T', ' ') : undefined,
      indirectPerDay: Number(indirect) || undefined, ldPerDay: Number(ld) || undefined, activities: acts.length ? acts : undefined, defaultMaxPct: Number(pct) || 30, hoursPerDay: ui.prefs.hoursPerDay,
    }));
  };
  const apply = () => { if (res?.ok && res.ops.length && applyAndSchedule('Crash schedule', res.ops)) { toast(`Crashed ${res.ops.length} activities; Ctrl+Z undoes.`); setRes(null); } };
  const set = (id: string, k: 'min' | 'cost', v: string) => setData({ ...data, [id]: { min: data[id]?.min ?? '', cost: data[id]?.cost ?? '', [k]: v } });
  return (
    <div style={box}>
      <div style={bar}>
        <label>Goal <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="days">Gain working days</option><option value="date">Finish by</option><option value="cost">Least total cost</option></select></label>
        {mode === 'days' && <input style={{ width: 50 }} value={days} onChange={(e) => setDays(e.target.value)} />}
        {mode === 'date' && <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />}
        <label>Indirect cost/day <input style={{ width: 70 }} value={indirect} onChange={(e) => setIndirect(e.target.value)} /></label>
        <label>LDs/day <input style={{ width: 70 }} value={ld} onChange={(e) => setLd(e.target.value)} /></label>
        <label title="Used when no crash data is entered below">Default max cut <input style={{ width: 36 }} value={pct} onChange={(e) => setPct(e.target.value)} />%</label>
        <button className="btn primary" onClick={run}>Crash</button>
        {res?.ok && res.ops.length > 0 && <button className="btn" onClick={apply}>Apply</button>}
      </div>
      <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ width: 380, overflow: 'auto' }}>
          <div className="muted" style={{ fontSize: 11 }}>Crash data for critical activities (leave empty to use the default cut at equal cost):</div>
          <table className="tbl"><thead><tr><th>Activity</th><th>Rem. d</th><th>Min d</th><th>Cost/day</th></tr></thead>
            <tbody>{crit.map((t) => <tr key={t.task_id}><td title={t.task_name}><Id id={t.task_code} /></td><td style={{ textAlign: 'right' }}>{Math.round((Number(t.remain_drtn_hr_cnt || 0) / ui.prefs.hoursPerDay) * 10) / 10}</td><td><input style={{ width: 44 }} value={data[t.task_code]?.min ?? ''} onChange={(e) => set(t.task_code, 'min', e.target.value)} /></td><td><input style={{ width: 64 }} value={data[t.task_code]?.cost ?? ''} onChange={(e) => set(t.task_code, 'cost', e.target.value)} /></td></tr>)}</tbody></table>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {!res ? <div className="muted">Least-cost crashing: each step shortens the cheapest set of activities that shortens every path driving the finish, by as much as the next near-critical path allows. Runs on a copy; Apply makes the changes (Ctrl+Z undoes).</div>
            : !res.ok ? <div style={{ color: "#b00020" }}>{res.error.message}</div>
            : <>
              <div><b>{res.stop}</b> · {res.days_gained} working days gained · finish {res.base_finish?.slice(0, 10)} → {res.finish?.slice(0, 10)} · direct cost {res.direct_cost.toLocaleString()} · total {res.total_cost.toLocaleString()}</div>
              {res.note && <div className="muted">{res.note}</div>}
              {res.warnings.map((w) => <div key={w} className="muted">{w}</div>)}
              <table className="tbl" style={{ marginTop: 4 }}><thead><tr><th>Step</th><th>Activities (days)</th><th>Gained</th><th>Cost</th><th>Finish</th><th>Cum. direct</th><th>Total</th></tr></thead>
                <tbody>{res.steps.map((s) => <tr key={s.step}><td>{s.step}</td><td>{s.activities.map((a, i) => <span key={a.id}>{i ? ', ' : ''}<Id id={a.id} /> ({a.days})</span>)}</td><td>{s.days_gained}</td><td>{s.cost.toLocaleString()}</td><td>{s.finish?.slice(0, 10)}</td><td>{s.cumulative_direct_cost.toLocaleString()}</td><td>{s.total_cost.toLocaleString()}</td></tr>)}</tbody></table>
            </>}
        </div>
      </div>
    </div>
  );
}

interface Row { scenario: string; id: string; days: string }

export function WhatIfPanel() {
  const ui = useStore((s) => s.ui);
  const [list, setList] = useState<Row[]>([{ scenario: 'Scenario 1', id: '', days: '' }]);
  const [res, setRes] = useState<ReturnType<typeof evaluateBatch> | null>(null);
  const set = (i: number, k: keyof Row, v: string) => setList(list.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const run = () => {
    const by = new Map<string, Scenario>();
    for (const r of list) {
      if (!r.id.trim() || r.days === '') continue;
      const s = by.get(r.scenario) ?? by.set(r.scenario, { name: r.scenario, overrides: [] }).get(r.scenario)!;
      s.overrides.push({ op: 'update_activity', id: r.id.trim(), duration_days: Number(r.days) });
    }
    if (!by.size) return toast('Enter an activity ID and a new duration.');
    setRes(evaluateBatch(getDb(), ui.openProjects, [...by.values()], { hoursPerDay: ui.prefs.hoursPerDay }));
  };
  return (
    <div style={box}>
      <div className="muted">Each scenario changes activity durations; all are scheduled on copies and compared with the project as it is. Rows with the same scenario name form one scenario.</div>
      <table className="tbl"><thead><tr><th>Scenario</th><th>Activity ID</th><th>New duration (d)</th><th /></tr></thead>
        <tbody>{list.map((r, i) => <tr key={i}><td><input value={r.scenario} onChange={(e) => set(i, 'scenario', e.target.value)} /></td><td><input value={r.id} onChange={(e) => set(i, 'id', e.target.value)} /></td><td><input style={{ width: 60 }} value={r.days} onChange={(e) => set(i, 'days', e.target.value)} /></td><td><button className="btn" onClick={() => setList(list.filter((_, j) => j !== i))}>Remove</button></td></tr>)}</tbody></table>
      <div style={bar}>
        <button className="btn" onClick={() => setList([...list, { scenario: list.at(-1)?.scenario ?? 'Scenario 1', id: '', days: '' }])}>Add change</button>
        <button className="btn" onClick={() => setList([...list, { scenario: `Scenario ${new Set(list.map((r) => r.scenario)).size + 1}`, id: '', days: '' }])}>Add scenario</button>
        <button className="btn primary" onClick={run}>Evaluate</button>
      </div>
      {res && !res.ok && <div style={{ color: "#b00020" }}>{res.error.message}</div>}
      {res?.ok && <div style={{ overflow: 'auto', flex: 1 }}>
        <div>Project as it is: finish {res.base.finish?.slice(0, 10)}, {res.base.critical} critical, cost {res.base.cost.toLocaleString()}{res.best ? <> · best: <b>{res.best}</b></> : null}</div>
        <table className="tbl"><thead><tr><th>Scenario</th><th>Finish</th><th>Δ days</th><th>Critical</th><th>Became critical</th><th>Neg. float</th><th>Δ cost</th></tr></thead>
          <tbody>{res.scenarios.map((s) => <tr key={s.name}><td>{s.name}</td>{s.ok ? <><td>{s.finish?.slice(0, 10)}</td><td>{s.finish_delta_days}</td><td>{s.critical}</td><td>{s.became_critical!.slice(0, 8).map((c, i) => <span key={c}>{i ? ', ' : ''}<Id id={c} /></span>)}{s.became_critical!.length > 8 ? '…' : ''}</td><td>{s.negative_float}</td><td>{s.cost_delta?.toLocaleString()}</td></> : <td colSpan={6} style={{ color: "#b00020" }}>{s.error}</td>}</tr>)}</tbody></table>
      </div>}
    </div>
  );
}

export function OptimizePanel() {
  const ui = useStore((s) => s.ui);
  const [samples, setSamples] = useState('');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Awaited<ReturnType<typeof optimizeSchedule>> | null>(null);
  const [err, setErr] = useState('');
  const run = async () => {
    setBusy(true); setErr(''); setRes(null);
    try {
      const infer = async (x: Parameters<typeof window.p6.hrmInfer>[0]) => { const r = await window.p6.hrmInfer(x); if (!r.ok) throw new Error(r.error); return r.out; };
      const apply = (d: Db, ops: unknown[]) => { const r = applyOps(d, ops); if (!r.ok) throw new Error(r.error!.message); };
      setRes(await optimizeSchedule(getDb(), ui.openProjects, { samples: samples ? Number(samples) : undefined, seed: seed ? Number(seed) : undefined, hoursPerDay: ui.prefs.hoursPerDay }, infer, apply));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const apply = () => {
    if (!res?.ok) return;
    const order = res.order, lev = res.leveled_activities > 0;
    if (applyAndSchedule('Optimize schedule (reasoner)', res.ops, lev ? (d) => { const s = scheduleProjects(d, ui.openProjects, {}); if (s.ok) levelResources(d, ui.openProjects, { first: order }); } : undefined)) { toast('Applied the reasoner proposal; Ctrl+Z undoes.'); setRes(null); }
  };
  return (
    <div style={box}>
      <div style={bar}>
        <label title="Trajectories sampled around the model's answer (default 200, 64 above 120 activities)">Samples <input style={{ width: 50 }} value={samples} onChange={(e) => setSamples(e.target.value)} /></label>
        <label title="Same seed, same answer">Seed <input style={{ width: 70 }} value={seed} onChange={(e) => setSeed(e.target.value)} /></label>
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Thinking…' : 'Optimise'}</button>
        {res?.ok && <button className="btn" onClick={apply}>Apply</button>}
      </div>
      {err && <div style={{ color: "#b00020" }}>{err}</div>}
      {res && !res.ok && <div style={{ color: "#b00020" }}>{res.error.message}</div>}
      {!res && !err && <div className="muted">The White Hat IQ schedule reasoner, a trained model running on this computer: it picks a placement priority (and crashed modes, when crash data exists) so the resource-limited schedule finishes soonest. Its proposal is checked with P6 leveling and compared with P6's default leveling. Resources need a Max Units/Time limit.</div>}
      {res?.ok && <div style={{ overflow: 'auto', flex: 1 }}>
        <table className="tbl"><tbody>
          <tr><td>Without leveling (F9)</td><td>{res.cpm_finish?.slice(0, 16)}</td></tr>
          <tr><td>P6 leveling (early start priority)</td><td>{res.p6_leveled_finish?.slice(0, 16)}</td></tr>
          <tr><td><b>Reasoner, through the same leveler</b></td><td><b>{res.reasoner_finish?.slice(0, 16)}</b> {res.better_than_p6_leveler ? '(earlier than P6 leveling)' : res.better_than_p6_leveler === false ? '(not earlier than P6 leveling)' : ''}</td></tr>
        </tbody></table>
        <div className="muted">{res.activities} activities · {res.leveled_activities} on limited resources · {res.trajectories} trajectories{res.crash_cost ? ` · crash cost ${res.crash_cost.toLocaleString()}` : ''}</div>
        {res.changes.length > 0 && <div>Crashed: {res.changes.map((c, i) => <span key={c.id}>{i ? ', ' : ''}<Id id={c.id} /> {c.from_days}→{c.to_days} d</span>)}</div>}
        <div>Priority (first 100): {res.priority.map((c, i) => <span key={c}>{i ? ', ' : ''}<Id id={c} /></span>)}</div>
      </div>}
    </div>
  );
}
