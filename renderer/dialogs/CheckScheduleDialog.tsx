// Tools > Check Schedule Report, as in P6: pick the checks and their targets, run, read the report (and save it as HTML).
import { useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, toast, useStore } from '../store.ts';
import { checkSchedule, P6_CHECKS, type CheckScheduleReport } from '../../core/analysis/checkSchedule.ts';
import { analysisReportHtml } from '../../core/analysis/report.ts';
import { nowStamp } from '../../core/report/reports.ts';
import { AnalysisResults } from '../views/AnalysisResults.tsx';

export function CheckScheduleDialog() {
  const ui = useStore((s) => s.ui);
  const [on, setOn] = useState<Record<string, boolean>>(Object.fromEntries(P6_CHECKS.map((c) => [c.id, true])));
  const [targets, setTargets] = useState<Record<string, string>>(Object.fromEntries(P6_CHECKS.map((c) => [c.id, String(c.th.value)])));
  const [days, setDays] = useState('44');
  const [report, setReport] = useState<CheckScheduleReport | null>(null);
  if (!ui.openProjects.length) return <Dialog title="Check Schedule" buttons={<button className="btn" onClick={closeDialog}>Close</button>}><p>Open a project first.</p></Dialog>;
  const run = () => {
    const checks = P6_CHECKS.filter((c) => on[c.id]).map((c) => c.id);
    if (!checks.length) return toast('Select at least one check.');
    const t: Record<string, number> = {};
    for (const c of P6_CHECKS) { const v = Number(targets[c.id]); if (Number.isFinite(v) && v !== c.th.value) t[c.id] = v; }
    const d = Number(days);
    setReport(checkSchedule(getDb(), { projIds: ui.openProjects, hoursPerDay: ui.prefs.hoursPerDay, checks, targets: t, thresholdHours: (Number.isFinite(d) && d > 0 ? d : 44) * ui.prefs.hoursPerDay }));
  };
  const save = async () => {
    if (!report) return;
    const p = await window.p6.saveFile('Check Schedule Report.html', new TextEncoder().encode(analysisReportHtml(report as never, nowStamp())), [{ name: 'HTML', extensions: ['html'] }]);
    if (p) toast(`Saved ${p}`);
  };
  if (report) return (
    <Dialog title="Check Schedule Report" width={820} height={600} buttons={<>
      <button className="btn" onClick={save}>Save Report...</button>
      <button className="btn" onClick={() => setReport(null)}>Back</button>
      <button className="btn" onClick={closeDialog}>Close</button>
    </>}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>
        <div className="muted">{report.projects.map((p) => `${p.id}: data date ${p.data_date ?? 'not set'}, ${p.activities} activities (${p.completed} completed), ${p.relationships} relationships${p.missing_baseline_activities != null ? `, ${p.missing_baseline_activities} not in the baseline` : ''}`).join(' · ')}</div>
        <div><b>{report.summary.failed}</b> failed · {report.summary.passed} passed{report.summary.not_assessed ? ` · ${report.summary.not_assessed} not assessed` : ''}</div>
        <AnalysisResults checks={report.checks} onGo={closeDialog} />
      </div>
    </Dialog>
  );
  return (
    <Dialog title="Check Schedule" width={520} buttons={<>
      <button className="btn primary" onClick={run}>Check Schedule</button>
      <button className="btn" onClick={closeDialog}>Close</button>
    </>}>
      <table className="tbl" style={{ width: '100%' }}>
        <thead><tr><th></th><th>Check</th><th>Target</th></tr></thead>
        <tbody>{P6_CHECKS.map((c) => (
          <tr key={c.id}>
            <td><input type="checkbox" checked={!!on[c.id]} onChange={(e) => setOn({ ...on, [c.id]: e.target.checked })} /></td>
            <td>{c.name}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{c.th.op} <input style={{ width: 52 }} value={targets[c.id]} onChange={(e) => setTargets({ ...targets, [c.id]: e.target.value })} />{c.id === 'bei' ? '' : '%'}</td>
          </tr>
        ))}</tbody>
      </table>
      <div style={{ marginTop: 8 }}>Long lags, large float and large durations: over <input style={{ width: 44 }} value={days} onChange={(e) => setDays(e.target.value)} /> days ({(Number(days) || 44) * ui.prefs.hoursPerDay} hours)</div>
    </Dialog>
  );
}
