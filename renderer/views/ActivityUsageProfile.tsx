// View > Show on Bottom > Activity Usage Profile / Spreadsheet (P6): cost or units per period for all or the selected
// activities: bars by date and cumulative curves, with the Planned Value and Earned Value curves.
import { useMemo, useState } from 'react';
import { setUi, useStore } from '../store.ts';
import { useCtx } from '../hooks.ts';
import { progressCurves } from '../../core/analysis/curves.ts';

const SERIES = [
  { key: 'pv', cum: 'cum_pv', label: 'Planned Value', color: '#7a7a7a' },
  { key: 'ev', cum: 'cum_ev', label: 'Earned Value', color: '#2c9a4a' },
  { key: 'ac', cum: 'cum_ac', label: 'Actual', color: '#1f5fbf' },
  { key: 'remaining_early', cum: 'cum_forecast_early', label: 'Remaining Early', color: '#2ca02c' },
  { key: 'remaining_late', cum: 'cum_forecast_late', label: 'Remaining Late', color: '#d62728' },
] as const;

export function ActivityUsageProfile({ sheet }: { sheet: boolean }) {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const [units, setUnits] = useState<'cost' | 'hours'>('cost');
  const [period, setPeriod] = useState<'week' | 'month'>('month');
  const [which, setWhich] = useState<'all' | 'selected'>('all');
  const [on, setOn] = useState<Record<string, boolean>>({ pv: true, ev: true, ac: true, remaining_early: true, remaining_late: false });
  const c = useMemo(() => progressCurves(ctx.db, ui.openProjects, { units, period, taskIds: which === 'selected' && ui.selTasks.length ? new Set(ui.selTasks) : undefined }), [ctx, ui.openProjects, units, period, which, ui.selTasks]);
  const fmt = (v: number | null) => (v == null ? '' : units === 'cost' ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toLocaleString());
  return (
    <div className="details">
      <div className="layoutbar" style={{ color: '#000' }}>
        <b>{sheet ? 'Activity Usage Spreadsheet' : 'Activity Usage Profile'}</b>
        <select value={which} onChange={(e) => setWhich(e.target.value as 'all' | 'selected')}><option value="all">All activities</option><option value="selected">Selected activities</option></select>
        <select value={units} onChange={(e) => setUnits(e.target.value as 'cost' | 'hours')}><option value="cost">Cost</option><option value="hours">Units</option></select>
        <label>Timescale <select value={period} onChange={(e) => setPeriod(e.target.value as 'week' | 'month')}><option value="week">Week</option><option value="month">Month</option></select></label>
        {!sheet && SERIES.map((s) => <label key={s.key} style={{ color: s.color }}><input type="checkbox" checked={on[s.key]} onChange={(e) => setOn({ ...on, [s.key]: e.target.checked })} />{s.label}</label>)}
        <span style={{ flex: 1 }} />
        <span className="muted">BAC {fmt(c.totals.bac)} · PV {fmt(c.totals.pv)} · EV {fmt(c.totals.ev)} · AC {fmt(c.totals.ac)}{c.totals.spi != null ? ` · SPI ${c.totals.spi}` : ''}{c.totals.cpi != null ? ` · CPI ${c.totals.cpi}` : ''}</span>
        <button className={`tbtn ${!sheet ? 'on' : ''}`} onClick={() => setUi({ bottom: 'actProfile' })}><span className="lbl">Profile</span></button>
        <button className={`tbtn ${sheet ? 'on' : ''}`} onClick={() => setUi({ bottom: 'actSheet' })}><span className="lbl">Spreadsheet</span></button>
        <button className="tbtn" onClick={() => setUi({ bottom: 'details' })}><span className="lbl">Activity Details</span></button>
      </div>
      {c.warnings.length > 0 && <div className="muted" style={{ padding: '2px 8px', fontSize: 11 }}>{c.warnings.join(' ')}</div>}
      {!c.periods.length ? <div className="empty">No dates to show.</div> : sheet ? <Sheet c={c} fmt={fmt} /> : <Chart c={c} on={on} fmt={fmt} />}
    </div>
  );
}

type C = ReturnType<typeof progressCurves>;

function Chart({ c, on, fmt }: { c: C; on: Record<string, boolean>; fmt: (v: number | null) => string }) {
  const W = Math.max(600, c.periods.length * 28), H = 220, pad = { l: 64, r: 10, t: 10, b: 28 };
  const shown = SERIES.filter((s) => on[s.key]);
  const max = Math.max(1, ...c.periods.flatMap((p) => shown.map((s) => Number((p as unknown as Record<string, unknown>)[s.cum] ?? 0))));
  const maxBar = Math.max(1, ...c.periods.flatMap((p) => shown.map((s) => Number((p as unknown as Record<string, unknown>)[s.key] ?? 0))));
  const x = (i: number) => pad.l + (i + 0.5) * ((W - pad.l - pad.r) / c.periods.length);
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const yb = (v: number) => (v / maxBar) * (H - pad.t - pad.b) * 0.5;
  const bw = Math.max(2, ((W - pad.l - pad.r) / c.periods.length - 4) / Math.max(1, shown.length));
  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <svg width={W} height={H} style={{ display: 'block', font: '10px Tahoma' }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="#e3e7ee" /><text x={pad.l - 4} y={y(max * f) + 3} textAnchor="end">{fmt(max * f)}</text></g>)}
        {c.periods.map((p, i) => <g key={i}>
          {shown.map((s, k) => { const v = Number((p as unknown as Record<string, unknown>)[s.key] ?? 0); return v ? <rect key={s.key} x={x(i) - (bw * shown.length) / 2 + k * bw} y={H - pad.b - yb(v)} width={bw - 1} height={yb(v)} fill={s.color} opacity={0.35}><title>{`${p.start} ${s.label}: ${fmt(v)}`}</title></rect> : null; })}
          {i % Math.ceil(c.periods.length / 16) === 0 && <text x={x(i)} y={H - 10} textAnchor="middle">{p.start.slice(0, 7)}</text>}
        </g>)}
        {shown.map((s) => {
          const pts = c.periods.map((p, i) => [i, (p as unknown as Record<string, unknown>)[s.cum] as number | null] as const).filter(([, v]) => v != null);
          return <polyline key={s.key} fill="none" stroke={s.color} strokeWidth={2} points={pts.map(([i, v]) => `${x(i)},${y(v!)}`).join(' ')}><title>{`${s.label} (cumulative)`}</title></polyline>;
        })}
        {c.data_date && (() => { const i = c.periods.findIndex((p) => p.end > c.data_date!.slice(0, 10)); return i >= 0 ? <line x1={x(i)} x2={x(i)} y1={pad.t} y2={H - pad.b} stroke="#1f5fbf" strokeDasharray="4 3" /> : null; })()}
      </svg>
    </div>
  );
}

function Sheet({ c, fmt }: { c: C; fmt: (v: number | null) => string }) {
  const rowsDef: [string, keyof C['periods'][number]][] = [['Planned Value', 'pv'], ['Earned Value', 'ev'], ['Actual', 'ac'], ['Remaining Early', 'remaining_early'], ['Remaining Late', 'remaining_late'], ['Cum. Planned Value', 'cum_pv'], ['Cum. Earned Value', 'cum_ev'], ['Cum. Actual', 'cum_ac'], ['SPI', 'spi'], ['CPI', 'cpi'], ['Cum. SPI', 'cum_spi'], ['Cum. CPI', 'cum_cpi']];
  return (
    <div className="tblwrap" style={{ flex: 1, overflow: 'auto' }}>
      <table className="tbl"><thead><tr><th></th>{c.periods.map((p) => <th key={p.start}>{p.start}</th>)}</tr></thead>
        <tbody>{rowsDef.map(([label, k]) => <tr key={k}><td><b>{label}</b></td>{c.periods.map((p) => { const v = p[k] as number | null; return <td key={p.start} style={{ textAlign: 'right' }}>{/spi|cpi/.test(String(k)) ? (v ?? '') : fmt(v)}</td>; })}</tr>)}</tbody>
      </table>
    </div>
  );
}
