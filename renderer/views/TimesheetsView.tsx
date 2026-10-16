// Timesheets window: the resource's weekly timesheet (Progress Reporter style), the Timesheet Approval list,
// timesheet period maintenance (Admin > Timesheet Dates) and Apply Actuals.
import { useMemo, useState, type ReactNode } from 'react';
import { Grid, type EditorSpec, type GridItem } from '../components/Grid.tsx';
import { Dialog, Tabs } from '../components/Layout.tsx';
import { getDb, mutate, setUi, toast, useStore } from '../store.ts';
import { fmtDate } from '../model.ts';
import { rows, type Row } from '../../core/db.ts';
import { dayStart, parseP6Date, weekday, MIN_PER_DAY } from '../../core/dates.ts';
import {
  applyApprovedTimesheets, approve, createPeriods, deletePeriod, deletePeriodError, formatApplySummary, getTimesheet, hasPendingActuals, isEditable,
  listPeriods, periodDays, periodRange, periodTimesheets, reject, setHours, setLineComplete, statusError, submit, timesheetFor, timesheetLines,
  validateHours, TS_STATUS, type ApplySummary, type TsStatus,
} from '../../core/timesheet/timesheet.ts';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtH = (n: number) => (n ? String(Math.round(n * 100) / 100) : '');
const fmtH0 = (n: number) => String(Math.round(n * 100) / 100);
const statusName = (h: Row | undefined) => (h ? TS_STATUS[h.status_code as TsStatus] ?? h.status_code : 'Not Created');
const STATUS_COLOR: Record<string, string> = { TS_Active: '#000', TS_Submit: '#0046d5', TS_Approve: '#1a7f1a', TS_Reject: '#c00000' };

function dayLabel(t: number): string {
  const d = new Date(t * 60000);
  return `${DOW[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}`;
}

/** Run a core change as one undoable edit, reporting validation errors as a toast. */
function run(label: string, check: () => string | null, fn: (db: ReturnType<typeof getDb>) => void): boolean {
  const err = check();
  if (err) { toast(err); return false; }
  try {
    mutate(label, fn);
    return true;
  } catch (e) {
    toast((e as Error).message);
    return false;
  }
}

export function TimesheetsView() {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  const v = useStore((s) => s.dbVersion);
  const prefs = ui.prefs;
  const [tab, setTab] = useState('sheet');
  const [tsPick, setTsPick] = useState('');
  const [rsrcPick, setRsrcPick] = useState(ui.selRsrc ?? '');
  const [showOT, setShowOT] = useState(false);
  const [note, setNote] = useState('');
  const [periodsDlg, setPeriodsDlg] = useState(false);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [approvalFilter, setApprovalFilter] = useState('');

  const periods = useMemo(() => listPeriods(db), [db, v]);
  const resources = useMemo(() => rows(db, 'RSRC').filter((r) => r.rsrc_type !== 'RT_Mat')
    .sort((a, b) => (a.rsrc_short_name || '').localeCompare(b.rsrc_short_name || '', undefined, { numeric: true })), [db, v]);

  // default period: the one containing the data date of the first open project, else today, else the latest
  const period = useMemo(() => {
    const hit = periods.find((p) => p.ts_id === tsPick);
    if (hit) return hit;
    const dd = parseP6Date(rows(db, 'PROJECT').find((p) => p.proj_id === ui.openProjects[0])?.last_recalc_date);
    const now = Math.floor(Date.now() / 60000) - new Date().getTimezoneOffset();
    for (const t of [dd, now]) {
      if (t == null) continue;
      const p = periods.find((x) => { const r = periodRange(x); return t >= r.start && t < r.end; });
      if (p) return p;
    }
    return periods.at(-1);
  }, [periods, tsPick, db, v, ui.openProjects]);
  const tsId = period?.ts_id ?? '';
  const rsrc = resources.find((r) => r.rsrc_id === rsrcPick) ?? resources[0];
  const rsrcId = rsrc?.rsrc_id ?? '';
  const header = tsId && rsrcId ? getTimesheet(db, rsrcId, tsId) : undefined;
  const editable = isEditable(header);
  const days = useMemo(() => (period ? periodDays(period) : []), [period]);
  const lines = useMemo(() => (tsId && rsrcId ? timesheetLines(db, rsrcId, tsId) : []), [db, v, tsId, rsrcId]);
  const projById = useMemo(() => new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p])), [db, v]);

  const cols = useMemo(() => [
    { id: 'code', title: 'Activity ID', width: 100 },
    { id: 'name', title: 'Activity Name', width: 230 },
    { id: 'proj', title: 'Project', width: 80 },
    ...days.map((d, i) => ({ id: `d${i}`, title: dayLabel(d), width: 54, align: 'right' as const })),
    { id: 'total', title: 'Total', width: 56, align: 'right' as const },
    { id: 'rem', title: 'Remaining Units', width: 66, align: 'right' as const },
    { id: 'done', title: 'Complete', width: 60, align: 'center' as const },
  ], [days]);

  const weekend = (i: number) => { const w = weekday(days[i] ?? 0); return w === 0 || w === 6; };
  const dayCell = (n: number, i: number): ReactNode => (weekend(i) ? <span style={{ color: '#777' }}>{fmtH(n)}</span> : fmtH(n));

  const items = useMemo(() => {
    const out: GridItem[] = [];
    const tot = Array(days.length).fill(0), totOt = Array(days.length).fill(0);
    for (const l of lines) {
      const cells: Record<string, ReactNode> = {
        code: l.task?.task_code ?? `[${l.taskId}]`, name: l.task?.task_name ?? '(activity missing)', proj: projById.get(l.projId)?.proj_short_name ?? '',
        total: fmtH0(l.total), rem: l.assignment ? fmtH0(Number(l.assignment.remain_qty || 0)) : '',
        done: <input type="checkbox" checked={l.complete} disabled={!editable} title="Mark the activity complete for this resource"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => { const c = e.target.checked; run(c ? 'Mark Timesheet Line Complete' : 'Clear Timesheet Line Complete', () => null, (d) => setLineComplete(d, tsId, l.taskrsrcId, c)); }} />,
      };
      l.hours.forEach((h, i) => { cells[`d${i}`] = dayCell(h, i); tot[i] += h; });
      out.push({ key: `r:${l.taskrsrcId}`, kind: 'row', level: 0, cells });
      if (showOT) {
        const oc: Record<string, ReactNode> = { name: <span style={{ color: '#a86500', paddingLeft: 14 }}>Overtime</span>, total: fmtH0(l.otTotal) };
        l.ot.forEach((h, i) => { oc[`d${i}`] = dayCell(h, i); totOt[i] += h; });
        out.push({ key: `o:${l.taskrsrcId}`, kind: 'row', level: 0, cells: oc, style: { background: '#fffaf0' } });
      } else l.ot.forEach((h, i) => { totOt[i] += h; });
    }
    if (lines.length) {
      const tc: Record<string, ReactNode> = { name: 'Total Regular Hours', total: fmtH0(tot.reduce((a, b) => a + b, 0)) };
      tot.forEach((h, i) => { tc[`d${i}`] = fmtH0(h); });
      out.push({ key: 'tot', kind: 'row', level: 0, cells: tc, style: { background: 'var(--wbs3)', fontWeight: 'bold' } });
      const oc: Record<string, ReactNode> = { name: 'Total Overtime Hours', total: fmtH0(totOt.reduce((a, b) => a + b, 0)) };
      totOt.forEach((h, i) => { oc[`d${i}`] = fmtH(h); });
      out.push({ key: 'tot-ot', kind: 'row', level: 0, cells: oc, style: { background: 'var(--wbs3)', fontWeight: 'bold' } });
    }
    return out;
  }, [lines, days, showOT, editable, projById, tsId]);

  const totalReg = lines.reduce((a, l) => a + l.total, 0), totalOt = lines.reduce((a, l) => a + l.otTotal, 0);

  const getEditor = (key: string, col: string): EditorSpec | null => {
    if (!editable || !/^[ro]:/.test(key) || !/^d\d+$/.test(col)) return null;
    const l = lines.find((x) => x.taskrsrcId === key.slice(2));
    if (!l?.assignment) return null;
    const i = Number(col.slice(1));
    return { type: 'number', value: fmtH((key[0] === 'o' ? l.ot : l.hours)[i] ?? 0) };
  };
  const onCommit = (key: string, col: string, val: string) => {
    const id = key.slice(2), ot = key[0] === 'o', i = Number(col.slice(1));
    const n = val.trim() === '' ? 0 : Number(val);
    const l = lines.find((x) => x.taskrsrcId === id);
    if (!l || (ot ? l.ot : l.hours)[i] === n) return;
    run(ot ? 'Edit Timesheet Overtime' : 'Edit Timesheet Hours', () => validateHours(getDb(), tsId, id, i, n, ot), (d) => setHours(d, tsId, id, i, n, ot));
  };

  const doStatus = (to: TsStatus, rid = rsrcId) => {
    const label = to === 'TS_Submit' ? 'Submit Timesheet' : to === 'TS_Approve' ? 'Approve Timesheet' : 'Reject Timesheet';
    const fn = to === 'TS_Submit' ? submit : to === 'TS_Approve' ? approve : reject;
    if (run(label, () => statusError(getDb(), tsId, rid, to), (d) => { fn(d, tsId, rid, { note }); })) {
      setNote('');
      toast(`Timesheet ${TS_STATUS[to].toLowerCase()}: ${rows(getDb(), 'RSRC').find((r) => r.rsrc_id === rid)?.rsrc_short_name ?? rid}, ${period ? `${fmtDate(period.start_date, prefs, false)} - ${fmtDate(period.end_date, prefs, false)}` : ''}`);
    }
  };

  const applyActuals = () => {
    const ids = ui.openProjects;
    if (!ids.length) return toast('Open the projects to update first (Projects window). Apply Actuals updates the open projects.');
    if (!hasPendingActuals(getDb(), ids)) return toast('No approved timesheet hours to apply for the open projects.');
    let s: ApplySummary | undefined;
    run('Apply Actuals', () => null, (d) => { s = applyApprovedTimesheets(d, ids); });
    if (s) toast(formatApplySummary(s));
  };

  const createSheet = () => run('Create Timesheet', () => (tsId && rsrcId ? null : 'Select a period and a resource.'), (d) => { timesheetFor(d, rsrcId, tsId); });

  const sheets = useMemo(() => (tsId ? periodTimesheets(db, tsId) : []), [db, v, tsId]);
  const rsrcById = useMemo(() => new Map(rows(db, 'RSRC').map((r) => [r.rsrc_id, r])), [db, v]);

  const periodLabel = (p: Row) => `${fmtDate(p.start_date, prefs, false)} - ${fmtDate(p.end_date, prefs, false)}`;
  const status = header?.status_code as TsStatus | undefined;

  return (
    <>
      <div className="layoutbar">
        <span>Timesheet Period:</span>
        <select className="opt" value={tsId} onChange={(e) => setTsPick(e.target.value)} disabled={!periods.length}>
          {!periods.length && <option value="">(no periods)</option>}
          {periods.map((p) => <option key={p.ts_id} value={p.ts_id}>{periodLabel(p)}</option>)}
        </select>
        <button className="btn" style={{ minWidth: 24 }} title="Previous period" disabled={!period || periods[0] === period} onClick={() => setTsPick(periods[periods.indexOf(period!) - 1].ts_id)}>&lt;</button>
        <button className="btn" style={{ minWidth: 24 }} title="Next period" disabled={!period || periods.at(-1) === period} onClick={() => setTsPick(periods[periods.indexOf(period!) + 1].ts_id)}>&gt;</button>
        <button className="btn" onClick={() => setPeriodsDlg(true)}>Timesheet Periods...</button>
        {tab === 'sheet' && <>
          <span>Resource:</span>
          <select className="opt" value={rsrcId} onChange={(e) => { setRsrcPick(e.target.value); setUi({ selRsrc: e.target.value }); }} disabled={!resources.length}>
            {!resources.length && <option value="">(no labor resources)</option>}
            {resources.map((r) => <option key={r.rsrc_id} value={r.rsrc_id}>{r.rsrc_short_name} - {r.rsrc_name}</option>)}
          </select>
          <label><input type="checkbox" checked={showOT} onChange={(e) => setShowOT(e.target.checked)} /> Overtime</label>
        </>}
      </div>
      <Tabs tabs={[['sheet', 'Timesheet'], ['approval', 'Timesheet Approval']]} value={tab} onChange={setTab} />
      <div className="winbody">
        {!periods.length ? (
          <div className="empty">No timesheet periods are defined. Click <b>Timesheet Periods...</b> to batch-create weekly periods.</div>
        ) : tab === 'sheet' ? (
          !rsrc ? <div className="empty">The resource dictionary has no labor or nonlabor resources.</div> : (
            <Grid cols={cols} items={items} selected={new Set(selKey ? [selKey] : [])} onSelect={(k) => setSelKey(k)}
              getEditor={getEditor} onCommit={onCommit}
              onActivate={(k) => { const l = lines.find((x) => x.taskrsrcId === k.slice(2)); if (l?.task) setUi({ openProjects: ui.openProjects.includes(l.projId) ? ui.openProjects : [...ui.openProjects, l.projId], selTask: l.taskId, selTasks: [l.taskId], view: 'activities' }); }}
              emptyText={`${rsrc.rsrc_short_name} has no activities in progress or planned in this period. Assign the resource to activities whose dates overlap the period.`} />
          )
        ) : (
          <Approval sheets={sheets.filter((x) => !approvalFilter || x.header.status_code === approvalFilter)} rsrcById={rsrcById} prefs={prefs} filter={approvalFilter} setFilter={setApprovalFilter}
            total={sheets.length}
            onOpen={(rid) => { setRsrcPick(rid); setTab('sheet'); }}
            onApprove={(rid) => doStatus('TS_Approve', rid)} onReject={(rid) => doStatus('TS_Reject', rid)}
            onApproveAll={() => {
              const subs = sheets.filter((x) => x.header.status_code === 'TS_Submit');
              if (!subs.length) return toast('No submitted timesheets in this period.');
              run(`Approve ${subs.length} Timesheets`, () => null, (d) => { for (const x of subs) approve(d, tsId, x.rsrcId, { note }); });
              setNote('');
              toast(`Approved ${subs.length} timesheet${subs.length === 1 ? '' : 's'}.`);
            }} />
        )}
      </div>
      <div className="layoutbar" style={{ borderTop: '1px solid var(--border-light)', borderBottom: 'none' }}>
        {tab === 'sheet' && rsrc && period && <>
          <span>Status: <b style={{ color: STATUS_COLOR[status ?? ''] ?? '#555' }}>{statusName(header)}</b></span>
          {header?.status_date && <span>{fmtDate(header.status_date, prefs, true)}</span>}
          <span>Regular: <b>{fmtH0(totalReg)}h</b></span>
          <span>Overtime: <b>{fmtH0(totalOt)}h</b></span>
          {!editable && <span className="muted">(read-only)</span>}
          {!header && <button className="btn" onClick={createSheet}>Create Timesheet</button>}
        </>}
        <span style={{ flex: 1 }} />
        <input className="opt" style={{ width: 200 }} placeholder="Notes (sent with Submit / Approve / Reject)" value={note} onChange={(e) => setNote(e.target.value)} />
        {tab === 'sheet' && <>
          <button className="btn" disabled={!rsrc || !period || !!statusError(db, tsId, rsrcId, 'TS_Submit')} onClick={() => doStatus('TS_Submit')}>Submit</button>
          <button className="btn" disabled={!header || status !== 'TS_Submit'} onClick={() => doStatus('TS_Approve')}>Approve</button>
          <button className="btn" disabled={!header || status !== 'TS_Submit'} onClick={() => doStatus('TS_Reject')}>Reject</button>
        </>}
        <button className="btn primary" title="Apply approved timesheet hours to the open projects" onClick={applyActuals}>Apply Actuals</button>
      </div>
      {header?.ts_notes && tab === 'sheet' && <div className="layoutbar" style={{ borderBottom: 'none' }}><span className="muted">Notes:</span><span style={{ color: '#000' }}>{header.ts_notes}</span></div>}
      {periodsDlg && <PeriodsDialog onClose={() => setPeriodsDlg(false)} onPick={(id) => setTsPick(id)} />}
    </>
  );
}

function Approval(p: {
  sheets: ReturnType<typeof periodTimesheets>; total: number; rsrcById: Map<string, Row>; prefs: Parameters<typeof fmtDate>[1];
  filter: string; setFilter: (s: string) => void;
  onOpen: (rsrcId: string) => void; onApprove: (rsrcId: string) => void; onReject: (rsrcId: string) => void; onApproveAll: () => void;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const list = [...p.sheets].sort((a, b) => (p.rsrcById.get(a.rsrcId)?.rsrc_short_name ?? '').localeCompare(p.rsrcById.get(b.rsrcId)?.rsrc_short_name ?? '', undefined, { numeric: true }));
  const sum = (f: (x: (typeof list)[number]) => number) => fmtH0(list.reduce((a, x) => a + f(x), 0));
  return (
    <div className="tabbody flush" style={{ flex: 1 }}>
      <div style={{ padding: '3px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <span>Show:</span>
        <select value={p.filter} onChange={(e) => p.setFilter(e.target.value)}>
          <option value="">All timesheets</option>
          {Object.entries(TS_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="btn" onClick={p.onApproveAll}>Approve All Submitted</button>
        <span className="muted">{p.total} timesheet{p.total === 1 ? '' : 's'} in this period. Double-click a row to open the timesheet.</span>
      </div>
      <div className="tblwrap" style={{ flex: 1, margin: '0 6px 6px' }}>
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 110 }}>Resource ID</th><th style={{ width: 200 }}>Resource Name</th><th style={{ width: 80 }}>Status</th><th style={{ width: 110 }}>Status Date</th>
            <th style={{ width: 70 }}>Regular Hours</th><th style={{ width: 70 }}>Overtime Hours</th><th style={{ width: 70 }}>Applied Hours</th><th style={{ width: 70 }}>Pending Hours</th>
            <th style={{ width: 130 }}>Review</th><th>Notes</th>
          </tr></thead>
          <tbody>
            {list.map((x) => {
              const r = p.rsrcById.get(x.rsrcId);
              const st = x.header.status_code;
              return (
                <tr key={x.rsrcId} className={sel === x.rsrcId ? 'sel' : ''} onMouseDown={() => setSel(x.rsrcId)} onDoubleClick={() => p.onOpen(x.rsrcId)}>
                  <td>{r?.rsrc_short_name ?? `[${x.rsrcId}]`}</td><td>{r?.rsrc_name ?? ''}</td>
                  <td style={{ color: sel === x.rsrcId ? undefined : STATUS_COLOR[st] }}>{statusName(x.header)}</td>
                  <td>{fmtDate(x.header.status_date, p.prefs, true)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtH0(x.hours)}</td><td style={{ textAlign: 'right' }}>{fmtH0(x.ot)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtH0(x.applied)}</td><td style={{ textAlign: 'right' }}>{fmtH0(st === 'TS_Approve' ? x.pending : 0)}</td>
                  <td>{st === 'TS_Submit' && <>
                    <button className="btn" style={{ minWidth: 0, height: 17 }} onClick={() => p.onApprove(x.rsrcId)}>Approve</button>{' '}
                    <button className="btn" style={{ minWidth: 0, height: 17 }} onClick={() => p.onReject(x.rsrcId)}>Reject</button>
                  </>}</td>
                  <td title={x.header.ts_notes}>{x.header.ts_notes}</td>
                </tr>
              );
            })}
            {list.length > 0 && <tr style={{ fontWeight: 'bold' }}><td colSpan={4}>Total ({list.length})</td>
              <td style={{ textAlign: 'right' }}>{sum((x) => x.hours)}</td><td style={{ textAlign: 'right' }}>{sum((x) => x.ot)}</td>
              <td style={{ textAlign: 'right' }}>{sum((x) => x.applied)}</td><td style={{ textAlign: 'right' }}>{sum((x) => (x.header.status_code === 'TS_Approve' ? x.pending : 0))}</td><td /><td /></tr>}
            {!list.length && <tr><td colSpan={10} className="muted">No timesheets{p.filter ? ` with status ${TS_STATUS[p.filter as TsStatus]}` : ''} in this period. Resources create timesheets on the Timesheet tab.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Admin > Timesheet Dates: batch-create and delete periods. */
function PeriodsDialog({ onClose, onPick }: { onClose: () => void; onPick: (tsId: string) => void }) {
  const db = useStore((s) => s.db);
  const v = useStore((s) => s.dbVersion);
  const prefs = useStore((s) => s.ui.prefs);
  const periods = useMemo(() => listPeriods(db), [db, v]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of rows(db, 'TIMESHT')) m.set(h.ts_id, (m.get(h.ts_id) ?? 0) + 1);
    return m;
  }, [db, v]);
  const [sel, setSel] = useState<string | null>(null);
  const defStart = useMemo(() => {
    const last = periods.at(-1);
    if (last) return periodRange(last).end;
    const today = dayStart(Math.floor(Date.now() / 60000) - new Date().getTimezoneOffset());
    return today - ((weekday(today) + 6) % 7) * MIN_PER_DAY; // Monday of this week
  }, [periods]);
  const iso = (t: number) => new Date(t * 60000).toISOString().slice(0, 10);
  const [start, setStart] = useState(iso(defStart));
  const [count, setCount] = useState('4');
  const [len, setLen] = useState('7');

  const create = () => {
    const s = parseP6Date(start), n = Number(count), l = Number(len);
    if (s == null) return toast('Enter the start date of the first period.');
    let made = 0;
    const err = n >= 1 && Number.isInteger(n) && n <= 520 ? (l >= 1 && Number.isInteger(l) && l <= 31 ? null : 'Period length must be 1 to 31 days.') : 'Number of periods must be 1 to 520.';
    if (err) return toast(err);
    const creatable = (() => { const probe = { tables: { TSDATES: structuredClone(getDb().tables.TSDATES ?? { name: 'TSDATES', fields: [], rows: [] }) } }; return createPeriods(probe, s, n, l).length; })();
    if (creatable && !run('Create Timesheet Periods', () => null, (d) => { made = createPeriods(d, s, n, l).length; })) return;
    toast(made ? `Created ${made} timesheet period${made === 1 ? '' : 's'}${made < n ? ` (${n - made} overlapped existing periods)` : ''}.` : 'No periods created: they overlap existing periods.');
    const after = listPeriods(getDb());
    if (after.length) setStart(iso(periodRange(after.at(-1)!).end));
  };
  const remove = () => {
    if (!sel) return;
    if (run('Delete Timesheet Period', () => deletePeriodError(getDb(), sel), (d) => deletePeriod(d, sel))) setSel(null);
  };
  return (
    <Dialog title="Timesheet Periods" width={560} onClose={onClose} buttons={<>
      <button className="btn" onClick={onClose}>Close</button>
      <button className="btn" disabled={!sel} onClick={() => { if (sel) { onPick(sel); onClose(); } }}>Open Period</button>
      <button className="btn" disabled={!sel} onClick={remove}>Delete</button>
    </>}>
      <fieldset>
        <legend>Batch create</legend>
        <div className="form" style={{ gridTemplateColumns: 'auto 1fr auto 1fr' }}>
          <label>First period starts</label><input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <label>Number of periods</label><input type="number" min={1} value={count} onChange={(e) => setCount(e.target.value)} />
          <label>Period length (days)</label>
          <select value={len} onChange={(e) => setLen(e.target.value)}>
            <option value="7">7 (weekly)</option><option value="14">14 (every two weeks)</option><option value="1">1 (daily)</option>
          </select>
          <span /><button className="btn" onClick={create}>Batch Create</button>
        </div>
      </fieldset>
      <div className="tblwrap" style={{ height: 240 }}>
        <table className="tbl">
          <thead><tr><th>Start Date</th><th>End Date</th><th>Days</th><th>Timesheets</th></tr></thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.ts_id} className={sel === p.ts_id ? 'sel' : ''} onMouseDown={() => setSel(p.ts_id)} onDoubleClick={() => { onPick(p.ts_id); onClose(); }}>
                <td>{fmtDate(p.start_date, prefs, false)}</td><td>{fmtDate(p.end_date, prefs, false)}</td>
                <td style={{ textAlign: 'right' }}>{periodRange(p).days}</td><td style={{ textAlign: 'right' }}>{counts.get(p.ts_id) ?? 0}</td>
              </tr>
            ))}
            {!periods.length && <tr><td colSpan={4} className="muted">No periods. Use Batch Create.</td></tr>}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
