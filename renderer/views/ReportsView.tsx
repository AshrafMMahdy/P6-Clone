import { useEffect, useMemo, useState } from 'react';
import { getUi, setUi, toast, useStore } from '../store.ts';
import { REPORTS, reportCsv, nowStamp } from '../../core/report/reports.ts';
import { fmtDate } from '../model.ts';
import { printView } from '../print.ts';
import { findingsText } from '../io.ts';

const PAGE = 1000;

export function ReportsView() {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  const v = useStore((s) => s.dbVersion);
  const [weeks, setWeeks] = useState(3);
  const [showAll, setShowAll] = useState(false); // big reports draw the first PAGE rows until asked
  useEffect(() => setShowAll(false), [ui.detailTab]);
  const id = REPORTS.some((r) => r.id === ui.detailTab) || ui.detailTab === 'schedLog' || ui.detailTab === 'importLog' ? ui.detailTab : 'schedule';
  const def = REPORTS.find((r) => r.id === id);
  const report = useMemo(() => def && ui.openProjects.length ? def.build(db, ui.openProjects, { hoursPerDay: ui.prefs.hoursPerDay, fmtDate: (s) => fmtDate(s, ui.prefs), weeks }) : null, [def, db, v, ui.openProjects, ui.prefs, weeks]);
  const text = id === 'schedLog' ? ui.scheduleLog ?? 'No schedule log yet. Run Tools > Schedule (F9).' : id === 'importLog' ? (ui.importLog ? findingsText(ui.importLog.file, ui.importLog.findings) : 'No import log yet.') : null;
  const groups = [...new Set(REPORTS.map((r) => r.group))];
  return (
    <div className="winbody" style={{ flexDirection: 'row' }}>
      <div style={{ width: 240, borderRight: '1px solid #a0a0a0', background: '#f7f7f7', overflow: 'auto', padding: 6 }} className="report-list">
        {groups.map((g) => <div key={g} style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 'bold', color: '#0b3a7d', margin: '4px 0' }}>{g}</div>
          {REPORTS.filter((r) => r.group === g).map((r) => <div key={r.id} className={`dirbtn ${id === r.id ? 'on' : ''}`} style={{ flexDirection: 'row', textAlign: 'left', fontSize: 11 }} onClick={() => setUi({ detailTab: r.id })}>{r.title}</div>)}
        </div>)}
        <div style={{ fontWeight: 'bold', color: '#0b3a7d', margin: '4px 0' }}>Logs</div>
        <div className={`dirbtn ${id === 'schedLog' ? 'on' : ''}`} style={{ flexDirection: 'row', fontSize: 11 }} onClick={() => setUi({ detailTab: 'schedLog' })}>Schedule Log</div>
        <div className={`dirbtn ${id === 'importLog' ? 'on' : ''}`} style={{ flexDirection: 'row', fontSize: 11 }} onClick={() => setUi({ detailTab: 'importLog' })}>Import Log</div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="layoutbar">
          <button className="btn" onClick={() => printView('print')}>Print...</button>
          <button className="btn" onClick={() => printView('pdf')}>Save as PDF...</button>
          {report && <button className="btn" onClick={async () => { const p = await window.p6.saveFile(`${def!.id}.csv`, new TextEncoder().encode(reportCsv(report)), [{ name: 'CSV', extensions: ['csv'] }]); if (p) toast(`Saved ${p}`); }}>Export CSV...</button>}
          {id === 'lookahead' && <>Weeks: <input className="opt" type="number" min={1} max={26} value={weeks} onChange={(e) => setWeeks(Number(e.target.value) || 3)} style={{ width: 50 }} /></>}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 16, background: '#fff' }} className="report-page">
          {text != null ? <pre className="log">{text}</pre> : !ui.openProjects.length ? <div className="empty">Open a project to run reports.</div> : report && <>
            <h2 style={{ margin: '0 0 2px', fontSize: 16 }}>{report.title}</h2>
            <div className="muted" style={{ marginBottom: 10 }}>{report.subtitle} · Run {nowStamp()} · Data date {fmtDate(db.tables.PROJECT?.rows.find((p) => p.proj_id === getUi().openProjects[0])?.last_recalc_date, ui.prefs)}</div>
            <table className="tbl" style={{ userSelect: 'text' }}>
              <thead><tr>{report.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{(showAll ? report.rows : report.rows.slice(0, PAGE)).map((r, i) => <tr key={i} style={{ fontWeight: r.bold ? 'bold' : undefined, background: r.bold ? '#eef2fa' : undefined }}>{r.cells.map((c, j) => <td key={j} style={{ paddingLeft: j === 0 ? 4 + (r.level ?? 0) * 12 : 4 }}>{c}</td>)}</tr>)}
                {!report.rows.length && <tr><td colSpan={report.columns.length} className="muted">No rows.</td></tr>}</tbody>
            </table>
            {!showAll && report.rows.length > PAGE && <div style={{ padding: 8 }} className="muted">Showing {PAGE.toLocaleString()} of {report.rows.length.toLocaleString()} rows (Print, PDF and CSV include all). <button className="btn" onClick={() => setShowAll(true)}>Show All</button></div>}
          </>}
        </div>
      </div>
    </div>
  );
}
