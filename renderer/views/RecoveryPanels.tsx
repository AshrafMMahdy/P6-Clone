// Extensions for recovery: least-cost crashing, many what-ifs at once, and the schedule reasoner (the trained
// optimiser, run by the main process). Each works on a copy until Apply, which is one undoable change.
import { useMemo, useState } from 'react';
import { getDb, toast, useStore } from '../store.ts';
import { rows } from '../../core/db.ts';
import type { FieldData } from '../../core/analysis/whiq-fields.ts';
import type { crashSchedule } from '../../core/analysis/crash.ts';
import { evaluateBatch, type Scenario } from '../../core/analysis/batch.ts';
import { goToActivity } from './AnalysisResults.tsx';
import { ExportButton, numberOf, projectArgs } from './ExportButton.tsx';
import { CHANGED_SINCE, crashArgs, crashStopped, optimizeArgs, optimizeNotes, OPTIMIZE_ADVICE, priorityShown, refusal, type BiggestChange, type PriorityEntry, type RunStamp } from './toolAnswers.ts';
import { useChangedSince, useToolRun } from './toolRun.ts';
import { afterCrash, afterOptimize, applyResult } from './applyResult.ts';
import { RunStatus } from './RunStatus.tsx';

const Id = ({ id, project }: { id: string; project?: string }) => <a href="#" onClick={(e) => { e.preventDefault(); goToActivity(id, project); }}>{id}</a>;
const red = { color: '#b00020', whiteSpace: 'pre-wrap' } as const;
const box = { display: 'flex', flexDirection: 'column', gap: 6, height: '100%', minHeight: 0 } as const;
const bar = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } as const;

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
  const [res, setRes] = useState<(Extract<Awaited<ReturnType<typeof crashSchedule>>, { ok: true }> & { field_data?: FieldData }) | null>(null);
  const [err, setErr] = useState('');
  const [stamp, setStamp] = useState<RunStamp | null>(null);
  const [applyErr, setApplyErr] = useState('');
  const changed = useChangedSince(stamp);
  // the remaining critical activities are where crash data matters
  const crit = useMemo(() => rows(db, 'TASK').filter((t) => ui.openProjects.includes(t.proj_id) && !t.act_end_date && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE' && t.task_type !== 'TT_Mile' && t.task_type !== 'TT_FinMile' && t.total_float_hr_cnt !== '' && Number(t.total_float_hr_cnt) <= 0).slice(0, 300), [db, ui.openProjects]);
  /** crash_schedule's arguments from the panel's settings (Export runs the tool with them too) */
  const toolArgs = () => crashArgs({ mode, days, date, indirect, ld, pct, data });
  // the tool itself, in the Export's child process on the saved database (main/analysis-export-ipc.ts): the window is never held, the run
  // shows the tool's progress, and Cancel stops it at its next step and shows the steps done (stop CANCELLED, nothing applied)
  const crash = useToolRun('crash_schedule', true);
  const run = async () => {
    let a: Record<string, unknown>;
    try { a = { ...toolArgs(), field_data: true }; } catch (e) { return toast((e as Error).message); }
    setErr(''); setApplyErr(''); setRes(null); setStamp(null);
    const r = await crash.start(a);
    if (!r) return;
    const why = refusal(r);
    if (why) return setErr(why);
    setRes(r.out as NonNullable<typeof res>); setStamp(r.stamp);
  };
  // Apply writes the durations the run computed from the project as it was: refused, as text, when the project changed since; a refusal keeps the result
  const apply = () => {
    if (!res || !stamp || res.stop === 'CANCELLED' || !res.ops.length) return;
    const why = applyResult(stamp, 'Crash schedule', res.ops, afterCrash(res, stamp));
    if (why) return setApplyErr(why);
    setApplyErr(''); toast(`Crashed ${res.ops.length} activities; Ctrl+Z undoes.`); setRes(null);
  };
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
        {!crash.running ? <button className="btn primary" onClick={() => void run()}>Crash</button> : <button className="btn" onClick={crash.cancel} title="Stops at the next step and shows the steps done; nothing is applied. A second click ends the run if it does not stop (its work is not kept)">Cancel</button>}
        {crash.running && <RunStatus progress={crash.progress} waiting="Starting the run in a separate process…" asked={crash.asked} />}
        {res && res.stop !== 'CANCELLED' && res.ops.length > 0 && <button className="btn" onClick={apply}>Apply</button>}
        <ExportButton tool="crash_schedule" args={() => ({ ...projectArgs(), ...toolArgs() })} />
      </div>
      {applyErr && <div style={red}>{applyErr}</div>}
      <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ width: 380, overflow: 'auto' }}>
          <div className="muted" style={{ fontSize: 11 }}>Crash data for critical activities (leave empty to use the default cut at equal cost):</div>
          <table className="tbl"><thead><tr><th>Activity</th><th>Rem. d</th><th>Min d</th><th>Cost/day</th></tr></thead>
            <tbody>{crit.map((t) => <tr key={t.task_id}><td title={t.task_name}><Id id={t.task_code} /></td><td style={{ textAlign: 'right' }}>{Math.round((Number(t.remain_drtn_hr_cnt || 0) / ui.prefs.hoursPerDay) * 10) / 10}</td><td><input style={{ width: 44 }} value={data[t.task_code]?.min ?? ''} onChange={(e) => set(t.task_code, 'min', e.target.value)} /></td><td><input style={{ width: 64 }} value={data[t.task_code]?.cost ?? ''} onChange={(e) => set(t.task_code, 'cost', e.target.value)} /></td></tr>)}</tbody></table>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {err ? <div style={{ color: "#b00020", whiteSpace: 'pre-wrap' }}>{err}</div> : !res ? <div className="muted">Least-cost crashing: each step shortens the cheapest set of activities that shortens every path driving the finish, by as much as the next near-critical path allows. Runs on a copy; Apply makes the changes (Ctrl+Z undoes).</div>
            : <>
              {changed && <div className="muted">({CHANGED_SINCE}: Apply is refused)</div>}
              {crashStopped(res) && <div><b>{crashStopped(res)}</b></div>}
              <div><b>{res.stop}</b> · {res.days_gained} working days gained · finish {res.base_finish?.slice(0, 10)} → {res.finish?.slice(0, 10)} · direct cost {res.direct_cost.toLocaleString()} · total {res.total_cost.toLocaleString()}</div>
              {res.notes.map((w) => <div key={w} className="muted">{w}</div>)}
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
  const [res, setRes] = useState<Awaited<ReturnType<typeof evaluateBatch>> | null>(null);
  const set = (i: number, k: keyof Row, v: string) => setList(list.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  /** The scenarios the rows make: rows with the same scenario name form one. */
  const scenarios = (): Scenario[] => {
    const by = new Map<string, Scenario>();
    for (const r of list) {
      if (!r.id.trim() || r.days === '') continue;
      const s = by.get(r.scenario) ?? by.set(r.scenario, { name: r.scenario, overrides: [] }).get(r.scenario)!;
      s.overrides.push({ op: 'update_activity', id: r.id.trim(), duration_days: Number(r.days) });
    }
    if (!by.size) throw new Error('Enter an activity ID and a new duration.');
    return [...by.values()];
  };
  const run = async () => {
    let sc: Scenario[];
    try { sc = scenarios(); } catch (e) { return toast((e as Error).message); }
    // as the evaluate_batch tool calls the engine (days on each activity's calendar), so the screen is what the Export writes
    setRes(await evaluateBatch(getDb(), ui.openProjects, sc, { hoursPerDay: ui.prefs.hoursPerDay }));
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
        <ExportButton tool="evaluate_batch" args={() => ({ ...projectArgs(), scenarios: scenarios() })} />
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

/** optimize_schedule's answer (a plan, nothing applied by the tool): what the panel shows. best_from, mode_trials and notes are there when the tool says them. */
type OptimizeAnswer = {
  activities: number; leveled_activities: number; trajectories: number; crash_cost?: number; cpm_finish?: string; p6_leveled_finish?: string; reasoner_finish?: string; better_than_p6_leveler: boolean | null;
  changes: { id: string; from_days: number; to_days: number }[]; priority: PriorityEntry[]; priority_total: number; ops: unknown[]; biggest_changes: BiggestChange[]; biggest_changes_total?: number;
  best_from?: string; partial?: true; field_data?: FieldData; [k: string]: unknown;
};
const day = (v: string | null | undefined) => (v ?? '').slice(0, 16);
const shift = (v: number | null | undefined) => (v == null ? '' : v > 0 ? `+${v}` : String(v));

export function OptimizePanel() {
  const ui = useStore((s) => s.ui);
  const [samples, setSamples] = useState('');
  const [seed, setSeed] = useState('');
  const [res, setRes] = useState<OptimizeAnswer | null>(null);
  const [err, setErr] = useState('');
  const [stamp, setStamp] = useState<RunStamp | null>(null);
  const [applyErr, setApplyErr] = useState('');
  const changed = useChangedSince(stamp);
  // the tool itself, in the Export's child process on the saved database (main/analysis-export-ipc.ts): a big schedule takes about a minute
  // and never holds the window; the run shows the tool's progress and Cancel stops it at its next step
  const opt = useToolRun('optimize_schedule', true);
  const args = (project: { project?: string }) => optimizeArgs(project, numberOf('Samples', samples), numberOf('Seed', seed));
  const run = async () => {
    let a: Record<string, unknown>;
    try { a = { ...args({}), field_data: true }; } catch (e) { return toast((e as Error).message); }
    setErr(''); setApplyErr(''); setRes(null); setStamp(null);
    const r = await opt.start(a);
    if (!r) return;
    const why = refusal(r);
    if (why) return setErr(why);
    setRes(r.out as OptimizeAnswer); setStamp(r.stamp);
  };
  /** Apply levels in the placement order when activities are on limited resources: the answer carries the whole order (the panel asks
   *  with max_priority 0), so Apply works on a schedule of any size and does what the tool's apply: true does. */
  const apply = () => {
    if (!res || !stamp) return;
    // refused, as text, when the project changed since the run; a refusal keeps the result
    const why = applyResult(stamp, 'Optimize schedule (reasoner)', res.ops, afterOptimize(res, stamp));
    if (why) return setApplyErr(why);
    setApplyErr(''); toast('Applied the reasoner proposal; Ctrl+Z undoes.'); setRes(null);
  };
  const notes = res ? optimizeNotes(res) : null;
  const shown = priorityShown(res?.priority ?? [], res?.priority_total ?? 0);
  return (
    <div style={box}>
      <div style={bar}>
        <label title="Trajectories sampled around the model's answer (default 200, 64 above 120 activities)">Samples <input style={{ width: 50 }} value={samples} disabled={opt.running} onChange={(e) => setSamples(e.target.value)} /></label>
        <label title="Same seed, same answer">Seed <input style={{ width: 70 }} value={seed} disabled={opt.running} onChange={(e) => setSeed(e.target.value)} /></label>
        {!opt.running ? <button className="btn primary" onClick={() => void run()}>Optimise</button> : <button className="btn" onClick={opt.cancel} title="Stops at the next step; nothing is applied. A second click ends the run if it does not stop (its work is not kept)">Cancel</button>}
        {opt.running && <RunStatus progress={opt.progress} waiting="Starting the run in a separate process…" asked={opt.asked} />}
        {res && !res.partial && <><button className="btn" onClick={apply}>Apply</button><span className="muted">{OPTIMIZE_ADVICE}</span></>}
        <ExportButton tool="optimize_schedule" args={() => args(projectArgs())} />
      </div>
      {err && <div style={{ color: "#b00020", whiteSpace: 'pre-wrap' }}>{err}</div>}
      {applyErr && <div style={red}>{applyErr}</div>}
      {!res && !err && <div className="muted">The White Hat IQ schedule reasoner, a trained model running on this computer: it picks a placement priority (and crashed modes, when crash data exists) so the resource-limited schedule finishes soonest. Its proposal is checked with P6 leveling and compared with P6's leveling with the project's leveling settings. Resources need a Max Units/Time limit. The reasoner plans work that has not started: a schedule in progress (an actual start or finish, progress above 0, or a data date after the planned start) is refused. To shorten the remaining work use Crashing; to level resources use Level Resources.</div>}
      {res && notes && <div style={{ overflow: 'auto', flex: 1 }}>
        {changed && <div className="muted" style={{ marginBottom: 4 }}>({CHANGED_SINCE}: Apply is refused)</div>}
        {notes.notes.map((n) => <div key={n} className="muted" style={{ marginBottom: 4 }}>{n}</div>)}
        <table className="tbl"><tbody>
          <tr><td>Without leveling (F9)</td><td>{res.cpm_finish?.slice(0, 16)}</td></tr>
          <tr><td>P6 leveling (the project's leveling settings)</td><td>{res.p6_leveled_finish?.slice(0, 16)}</td></tr>
          <tr><td><b>Reasoner, through the same leveler</b></td><td><b>{res.reasoner_finish?.slice(0, 16)}</b> {res.better_than_p6_leveler ? '(earlier than P6 leveling)' : res.better_than_p6_leveler === false ? '(not earlier than P6 leveling)' : ''}</td></tr>
        </tbody></table>
        <div className="muted">{res.activities} activities · {res.leveled_activities} on limited resources · {res.trajectories} trajectories{res.best_from ? ` · best from ${res.best_from}` : ''}{notes.windows ? ` · ${notes.windows}` : ''}{res.crash_cost ? ` · crash cost ${res.crash_cost.toLocaleString()}` : ''}</div>
        {res.changes.length > 0 && <div>Crashed: {res.changes.map((c, i) => <span key={c.id}>{i ? ', ' : ''}<Id id={c.id} /> {c.from_days}→{c.to_days} d</span>)}</div>}
        {notes.changes && <>
          <div style={{ marginTop: 6 }}><b>{notes.changes}</b>{res.biggest_changes.length < (res.biggest_changes_total ?? 0) ? ' (the largest shift first; Export… lists all)' : ' (the largest shift first)'}</div>
          <table className="tbl"><thead><tr><th>Activity</th><th>Name</th><th>Start before</th><th>Start after</th><th>Finish before</th><th>Finish after</th><th>Start shift (d)</th><th>Finish shift (d)</th></tr></thead>
            <tbody>{res.biggest_changes.map((c) => <tr key={c.id}><td><Id id={c.id} /></td><td>{c.name}</td><td>{day(c.cpm_start)}</td><td>{day(c.reasoner_start)}</td><td>{day(c.cpm_finish)}</td><td>{day(c.reasoner_finish)}</td><td style={{ textAlign: 'right' }}>{shift(c.start_delta_days)}</td><td style={{ textAlign: 'right' }}>{shift(c.finish_delta_days)}</td></tr>)}</tbody></table>
        </>}
        {/* the first ones, as before (Apply levels in the whole order the answer holds, not in these) */}
        <div>{shown.heading}: {shown.entries.map((c, i) => <span key={i}>{i ? ', ' : ''}<Id id={typeof c === 'string' ? c : c.id} project={typeof c === 'string' ? undefined : c.project} /></span>)}</div>
      </div>}
    </div>
  );
}
