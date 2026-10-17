// Tools > Reports: report groups (P6's standard reports and the user's own), with the selected report previewed.
// Run Report... chooses the output; Report Wizard... creates a report; Modify / Copy / Delete as in P6.
import { useEffect, useMemo, useState } from 'react';
import { getUi, openDialog, setUi, toast, useStore } from '../store.ts';
import { nowStamp } from '../../core/report/reports.ts';
import { fmtDate } from '../model.ts';
import { findingsText } from '../io.ts';
import { listReports, runReport, REPORT_GROUPS } from '../reports/engine.ts';
import { deleteReport } from '../reports/app.ts';

const PAGE = 1000;

export function ReportsView() {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  const v = useStore((s) => s.dbVersion);
  const [weeks, setWeeks] = useState(3);
  const [showAll, setShowAll] = useState(false); // big reports draw the first PAGE rows until asked
  useEffect(() => setShowAll(false), [ui.detailTab]);
  const entries = useMemo(() => listReports(db), [db, v]);
  const id = entries.some((r) => r.id === ui.detailTab) || ui.detailTab === 'schedLog' || ui.detailTab === 'importLog' ? ui.detailTab : 'schedule';
  const entry = entries.find((r) => r.id === id);
  const result = useMemo(() => {
    if (!entry || !ui.openProjects.length) return null;
    try { return runReport(db, ui.openProjects, entry.id, { prefs: ui.prefs, weeks }).report; } catch (e) { return { title: entry.name, columns: ['Error'], rows: [{ cells: [(e as Error).message] }] }; }
  }, [entry, db, v, ui.openProjects, ui.prefs, weeks]);
  const text = id === 'schedLog' ? ui.scheduleLog ?? 'No schedule log yet. Run Tools > Schedule (F9).' : id === 'importLog' ? (ui.importLog ? findingsText(ui.importLog.file, ui.importLog.findings) : 'No import log yet.') : null;
  const groups = [...new Set([...REPORT_GROUPS, ...entries.map((r) => r.group)])].filter((g) => entries.some((r) => r.group === g));
  const custom = entry?.kind === 'custom';
  return (
    <div className="winbody" style={{ flexDirection: 'row' }}>
      <div style={{ width: 260, borderRight: '1px solid #a0a0a0', background: '#f7f7f7', overflow: 'auto', padding: 6 }} className="report-list">
        {groups.map((g) => <div key={g} style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 'bold', color: '#0b3a7d', margin: '4px 0' }}>{g}</div>
          {entries.filter((r) => r.group === g).map((r) => <div key={r.id} title={r.description ?? r.name} className={`dirbtn report-item ${id === r.id ? 'on' : ''}`} style={{ flexDirection: 'row', textAlign: 'left', fontSize: 11 }}
            onClick={() => setUi({ detailTab: r.id })} onDoubleClick={() => openDialog('runReport', { reportId: r.id, weeks })}>{r.name}{r.kind === 'custom' ? ' *' : ''}</div>)}
        </div>)}
        <div style={{ fontWeight: 'bold', color: '#0b3a7d', margin: '4px 0' }}>Logs</div>
        <div className={`dirbtn ${id === 'schedLog' ? 'on' : ''}`} style={{ flexDirection: 'row', fontSize: 11 }} onClick={() => setUi({ detailTab: 'schedLog' })}>Schedule Log</div>
        <div className={`dirbtn ${id === 'importLog' ? 'on' : ''}`} style={{ flexDirection: 'row', fontSize: 11 }} onClick={() => setUi({ detailTab: 'importLog' })}>Import Log</div>
        <p className="muted" style={{ fontSize: 10 }}>* your reports (Report Wizard). Double-click a report to run it.</p>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="layoutbar">
          <button className="btn" disabled={!entry} onClick={() => openDialog('runReport', { reportId: id, weeks })}>Run Report...</button>
          <button className="btn" onClick={() => openDialog('reportWizard', {})}>Report Wizard...</button>
          <button className="btn" disabled={!custom} onClick={() => openDialog('reportWizard', { editId: id })}>Modify...</button>
          <button className="btn" disabled={!entry?.spec} title="A copy you can change (standard reports themselves are read-only)" onClick={() => openDialog('reportWizard', { copyFrom: id })}>Copy</button>
          <button className="btn" disabled={!custom} onClick={async () => { if (await window.p6.confirm(`Delete the report "${entry!.name}"?`)) { deleteReport(id); toast('Report deleted (Ctrl+Z to undo)'); } }}>Delete</button>
          {id === 'lookahead' && <>Weeks: <input className="opt" type="number" min={1} max={26} value={weeks} onChange={(e) => setWeeks(Number(e.target.value) || 3)} style={{ width: 50 }} /></>}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 16, background: '#fff' }} className="report-page">
          {text != null ? <pre className="log">{text}</pre> : !ui.openProjects.length ? <div className="empty">Open a project to run reports.</div> : result && <>
            <h2 style={{ margin: '0 0 2px', fontSize: 16 }}>{result.title}</h2>
            <div className="muted" style={{ marginBottom: 10 }}>{[result.subtitle, `Run ${nowStamp()}`, `Data date ${fmtDate(db.tables.PROJECT?.rows.find((p) => p.proj_id === getUi().openProjects[0])?.last_recalc_date, ui.prefs)}`].filter(Boolean).join(' · ')}</div>
            <table className="tbl report-table" style={{ userSelect: 'text' }}>
              <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
              <tbody>{(showAll ? result.rows : result.rows.slice(0, PAGE)).map((r, i) => <tr key={i} style={{ fontWeight: r.bold ? 'bold' : undefined, background: r.bold ? '#eef2fa' : undefined }}>{r.cells.map((c, j) => <td key={j} style={j === 0 && r.level ? { paddingLeft: 4 + r.level * 12 } : undefined}>{c}</td>)}</tr>)}
                {!result.rows.length && <tr><td colSpan={result.columns.length} className="muted">No rows.</td></tr>}</tbody>
            </table>
            {!showAll && result.rows.length > PAGE && <div style={{ padding: 8 }} className="muted">Showing {PAGE.toLocaleString()} of {result.rows.length.toLocaleString()} rows (Run Report includes all). <button className="btn" onClick={() => setShowAll(true)}>Show all</button></div>}
          </>}
        </div>
      </div>
    </div>
  );
}
