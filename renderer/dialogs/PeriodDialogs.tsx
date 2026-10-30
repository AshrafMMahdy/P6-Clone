// Admin > Financial Periods (with Batch Create, and P6 18.8+'s financial period calendars) and Tools > Store Period
// Performance (P6). Both edit through the core operations (add_financial_period_calendar..., add_financial_periods,
// update_financial_period, delete_financial_period, store_period_performance), so the app, the MCP and the CLI store
// the same thing; each action is one undoable change.
import { useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, getUi, mutate, toast, useStore } from '../store.ts';
import { rows } from '../../core/db.ts';
import { applyOps } from '../../core/project/ops.ts';
import { defaultCalendarId, defaultPeriod, financialPeriods, projectCalendar } from '../../core/progress/period.ts';

/** Run edit operations as one undoable change; the refusal, if any, as a toast. */
function edit(label: string, ops: unknown[]): unknown[] | null {
  let err = '', out: unknown[] = [];
  try {
    mutate(label, (d) => { const r = applyOps(d, ops, { hoursPerDay: getUi().prefs.hoursPerDay }); if (!r.ok) { err = r.error!.message; throw new Error(err); } out = r.results; });
  } catch { toast(err || `${label} failed.`); return null; }
  return out;
}

export function FinancialPeriodsDialog() {
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const cals = rows(db, 'FINTMPL');
  const [calId, setCalId] = useState(defaultCalendarId(db));
  const cal = cals.find((c) => c.fintmpl_id === calId) ?? cals.find((c) => c.fintmpl_id === defaultCalendarId(db));
  const inCal = cal ? { calendar: cal.fintmpl_name } : {};
  const list = financialPeriods(db, cal?.fintmpl_id ?? '');
  const [sel, setSel] = useState<string | null>(null);
  const [calName, setCalName] = useState('');
  const cur = list.find((f) => f.fin_dates_id === sel);
  const [name, setName] = useState(''), [start, setStart] = useState(''), [end, setEnd] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [every, setEvery] = useState('month'), [endsOn, setEndsOn] = useState('fri');
  const stored = (id: string) => rows(db, 'TASKFIN').filter((r) => r.fin_dates_id === id).length;
  return (
    <Dialog title="Financial Periods" width={660} height={580} buttons={<button className="btn primary" onClick={closeDialog}>Close</button>}>
      <div className="row">
        <label>Financial period calendar <select value={cal?.fintmpl_id ?? ''} onChange={(e) => { setCalId(e.target.value); setSel(null); }}>{!cals.length && <option value="">(one list of periods)</option>}{cals.map((c) => <option key={c.fintmpl_id} value={c.fintmpl_id}>{c.fintmpl_name}{c.default_flag === 'Y' ? ' (default)' : ''}</option>)}</select></label>
        <input placeholder="Calendar name" value={calName} onChange={(e) => setCalName(e.target.value)} style={{ width: 130 }} />
        <button className="btn" disabled={!calName} onClick={() => { if (edit('Add Financial Period Calendar', [{ op: 'add_financial_period_calendar', name: calName }])) { setCalId(rows(getDb(), 'FINTMPL').find((c) => c.fintmpl_name === calName)?.fintmpl_id ?? ''); setCalName(''); } }}>Add</button>
        <button className="btn" disabled={!cal || !calName} onClick={() => { if (edit('Rename Financial Period Calendar', [{ op: 'update_financial_period_calendar', name: cal!.fintmpl_name, new_name: calName }])) setCalName(''); }}>Rename</button>
        <button className="btn" disabled={!cal || cal.default_flag === 'Y'} onClick={() => edit('Default Financial Period Calendar', [{ op: 'update_financial_period_calendar', name: cal!.fintmpl_name, default: true }])}>Set Default</button>
        <button className="btn" disabled={!cal} onClick={async () => {
          const n = rows(getDb(), 'TASKFIN').filter((r) => list.some((f) => f.fin_dates_id === r.fin_dates_id)).length;
          if (!(await window.p6.confirm(`Delete calendar ${cal!.fintmpl_name}?`, `Its ${list.length} periods go with it${n ? `, and the period performance stored in them (${n} activity rows)` : ''}.`))) return;
          if (edit('Delete Financial Period Calendar', [{ op: 'delete_financial_period_calendar', name: cal!.fintmpl_name, clear_stored: true }])) setCalId(defaultCalendarId(getDb()));
        }}>Delete</button>
      </div>
      <table className="tbl"><thead><tr><th>Period Name</th><th>Start Date</th><th>End Date</th><th>Stored activities</th></tr></thead><tbody>
        {list.map((f) => (
          <tr key={f.fin_dates_id} className={f.fin_dates_id === sel ? 'sel' : ''} onClick={() => { setSel(f.fin_dates_id); setName(f.fin_dates_name); setStart(f.start_date.slice(0, 10)); setEnd(f.end_date.slice(0, 10)); }}>
            <td>{f.fin_dates_name}</td><td>{f.start_date.slice(0, 10)}</td><td>{f.end_date.slice(0, 10)}</td><td>{stored(f.fin_dates_id) || ''}</td>
          </tr>
        ))}
        {!list.length && <tr><td colSpan={4} className="muted">No financial periods. Add one, or Batch Create.</td></tr>}
      </tbody></table>
      <p><b>Period</b></p>
      <div className="row">
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        <button className="btn" disabled={!name || !start || !end} onClick={() => { if (edit('Add Financial Period', [{ op: 'add_financial_periods', ...inCal, periods: [{ name, start, end }] }])) setSel(null); }}>Add</button>
        <button className="btn" disabled={!cur} onClick={() => edit('Modify Financial Period', [{ op: 'update_financial_period', ...inCal, name: cur!.fin_dates_name, new_name: name, start, end }])}>Modify</button>
        <button className="btn" disabled={!cur} onClick={async () => {
          const n = stored(cur!.fin_dates_id);
          if (n && !(await window.p6.confirm(`Delete ${cur!.fin_dates_name}?`, `Period performance is stored in it for ${n} activities; it is deleted with the period.`))) return;
          if (edit('Delete Financial Period', [{ op: 'delete_financial_period', ...inCal, name: cur!.fin_dates_name, clear_stored: true }])) setSel(null);
        }}>Delete</button>
      </div>
      <p><b>Batch Create</b></p>
      <div className="row">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select value={every} onChange={(e) => setEvery(e.target.value)}><option value="month">Monthly</option><option value="week">Weekly</option></select>
        {every === 'week' && <label>ending <select value={endsOn} onChange={(e) => setEndsOn(e.target.value)}>{['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => <option key={d} value={d}>{d}</option>)}</select></label>}
        <button className="btn" disabled={!from || !to} onClick={() => { const r = edit('Batch Create Financial Periods', [{ op: 'add_financial_periods', ...inCal, from, to, every, ...(every === 'week' ? { week_ends_on: endsOn } : {}) }]); if (r) toast(`${(r[0] as { financial_periods: number }).financial_periods} financial periods created`); }}>Create</button>
      </div>
    </Dialog>
  );
}

export function StorePeriodDialog() {
  const ui = getUi(), db = getDb();
  const projects = rows(db, 'PROJECT').filter((p) => ui.openProjects.includes(p.proj_id) && !p._baseline_of);
  const periods = financialPeriods(db);
  const periodsOf = (p: (typeof projects)[number]) => financialPeriods(db, projectCalendar(db, p));
  const [pick, setPick] = useState<Record<string, { on: boolean; period: string }>>(() => Object.fromEntries(projects.map((p) => [p.proj_id, { on: true, period: defaultPeriod(db, p)?.fin_dates_name ?? '' }])));
  const store = () => {
    const ops = projects.filter((p) => pick[p.proj_id]?.on && pick[p.proj_id].period).map((p) => ({ op: 'store_period_performance', project: p.proj_short_name, period: pick[p.proj_id].period }));
    if (!ops.length) return toast('Select a project and a financial period.');
    const r = edit('Store Period Performance', ops);
    if (!r) return;
    closeDialog();
    toast(r.map((x) => { const s = x as { project: string; period: string; activities: number }; return `${s.project}: ${s.activities} activities stored in ${s.period}`; }).join('; '));
  };
  return (
    <Dialog title="Store Period Performance" width={560} buttons={<>
      <button className="btn primary" disabled={!periods.length} onClick={store}>Store Now</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
    </>}>
      {!periods.length && <p>No financial periods are defined. Define them in Admin &gt; Financial Periods.</p>}
      <table className="tbl"><thead><tr><th>Selected</th><th>Project ID</th><th>Data Date</th><th>Financial Period</th><th>Link actual / this period</th></tr></thead><tbody>
        {projects.map((p) => (
          <tr key={p.proj_id}>
            <td><input type="checkbox" checked={!!pick[p.proj_id]?.on} onChange={(e) => setPick({ ...pick, [p.proj_id]: { ...pick[p.proj_id], on: e.target.checked } })} /></td>
            <td>{p.proj_short_name}</td><td>{(p.last_recalc_date || '').slice(0, 10)}</td>
            <td><select value={pick[p.proj_id]?.period ?? ''} onChange={(e) => setPick({ ...pick, [p.proj_id]: { ...pick[p.proj_id], period: e.target.value } })}>
              <option value="" />{periodsOf(p).map((f) => <option key={f.fin_dates_id} value={f.fin_dates_name}>{f.fin_dates_name} ({f.start_date.slice(0, 10)} - {f.end_date.slice(0, 10)})</option>)}
            </select></td>
            <td>{p.act_this_per_link_flag === 'Y' ? 'Yes' : 'No (Project Details > Calculations)'}</td>
          </tr>
        ))}
      </tbody></table>
      <p className="muted">Stores each activity's and assignment's actuals for the period, with earned value and planned value, then sets Actual This Period to zero. Storing a period again overwrites it.</p>
    </Dialog>
  );
}
