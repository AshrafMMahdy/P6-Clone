// Extensions: what the clone does beyond P6, usable without the AI agent (DCMA 14-point, lint, crashing, what-ifs,
// the schedule reasoner, windows analysis and TIA; 4D follows). Each extension is a panel on the right.
import { useState } from 'react';
import { getDb, setUi, toast, useStore } from '../store.ts';
import { rows } from '../../core/db.ts';
import { parseP6Date } from '../../core/dates.ts';
import { dcma14, DCMA_PROFILES, type DcmaReport } from '../../core/analysis/dcma.ts';
import { analysisReportHtml } from '../../core/analysis/report.ts';
import { nowStamp } from '../../core/report/reports.ts';
import { AnalysisResults } from './AnalysisResults.tsx';
import { lintSchedule, type Fix, type LintReport } from '../../core/analysis/lint.ts';
import { applyOps } from '../../core/project/ops.ts';
import { mutate } from '../store.ts';
import { runSchedule } from '../commands.ts';
import { CrashPanel, OptimizePanel, WhatIfPanel } from './RecoveryPanels.tsx';
import { TiaPanel, WindowsPanel } from './DelayPanels.tsx';

export const EXTENSIONS: { id: string; title: string; blurb: string }[] = [
  { id: 'dcma', title: 'DCMA 14-point', blurb: 'The 14 DCMA schedule checks, with the critical path test, CPLI and BEI.' },
  { id: 'lint', title: 'Schedule lint', blurb: 'Logic and modelling problems P6 accepts, with fixes you can apply.' },
  { id: 'crash', title: 'Crashing', blurb: 'Least-cost crashing to a date, a number of days, or the cheapest total.' },
  { id: 'whatif', title: 'What-ifs', blurb: 'Many duration changes compared at once, on copies.' },
  { id: 'optimize', title: 'Schedule reasoner', blurb: 'The trained optimiser: a leveling order (and crash modes) that finishes sooner.' },
  { id: 'windows', title: 'Windows analysis', blurb: 'Slip per update window on the driving path, with the half-step split.' },
  { id: 'tia', title: 'Time impact analysis', blurb: 'A fragnet added to a copy: the delay it causes at the data date.' },
];

export function ExtensionsView() {
  const ui = useStore((s) => s.ui);
  const cur = EXTENSIONS.find((e) => e.id === ui.extension) ?? EXTENSIONS[0];
  return (
    <>
      <div className="layoutbar"><span>Extensions</span><span className="muted">Capabilities beyond P6, for planners and the AI assistant alike.</span></div>
      <div className="winbody" style={{ flexDirection: 'row' }}>
        <div style={{ width: 200, borderRight: '1px solid #c4cfe0', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {EXTENSIONS.map((e) => <div key={e.id} className={`dirbtn ${cur.id === e.id ? 'on' : ''}`} style={{ flexDirection: 'column', alignItems: 'flex-start', padding: 6 }} onClick={() => setUi({ extension: e.id })}><b>{e.title}</b><span className="muted" style={{ fontSize: 11, whiteSpace: 'normal' }}>{e.blurb}</span></div>)}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 8, minWidth: 0 }}>
          {!ui.openProjects.length ? <div className="muted">Open a project first (Projects window, double-click).</div> : cur.id === 'dcma' ? <DcmaPanel /> : cur.id === 'lint' ? <LintPanel /> : cur.id === 'crash' ? <CrashPanel /> : cur.id === 'whatif' ? <WhatIfPanel /> : cur.id === 'optimize' ? <OptimizePanel /> : cur.id === 'windows' ? <WindowsPanel /> : cur.id === 'tia' ? <TiaPanel /> : null}
        </div>
      </div>
    </>
  );
}

function DcmaPanel() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  const [profile, setProfile] = useState('pam200');
  const [baseline, setBaseline] = useState<'project' | 'bl1' | 'bl2' | 'bl3'>('project');
  const [status, setStatus] = useState('');
  const [target, setTarget] = useState('');
  const [slip, setSlip] = useState('600');
  const [dynamic, setDynamic] = useState(false);
  const [report, setReport] = useState<DcmaReport | null>(null);
  const run = () => {
    const sd = status ? parseP6Date(status.replace('T', ' ')) : null, tf = target ? parseP6Date(target.replace('T', ' ')) : null;
    if ((status && sd == null) || (target && tf == null)) return toast('Enter valid dates.');
    setReport(dcma14(getDb(), { projIds: ui.openProjects, hoursPerDay: ui.prefs.hoursPerDay, profile, baseline, statusDate: sd, targetFinish: tf, cptSlipDays: Number(slip) || 600, limitDays: dynamic ? 'dynamic' : 44 }));
  };
  const save = async () => {
    if (!report) return;
    const path = await window.p6.saveFile('DCMA 14-Point Assessment.html', new TextEncoder().encode(analysisReportHtml(report as never, nowStamp())), [{ name: 'HTML', extensions: ['html'] }]);
    if (path) toast(`Saved ${path}`);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%' }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>Profile <select value={profile} onChange={(e) => setProfile(e.target.value)}>{Object.entries(DCMA_PROFILES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>Baseline <select value={baseline} onChange={(e) => setBaseline(e.target.value as typeof baseline)}><option value="project">Project baseline</option><option value="bl1">BL1</option><option value="bl2">BL2</option><option value="bl3">BL3</option></select></label>
        <label>Status date <input type="datetime-local" value={status} onChange={(e) => setStatus(e.target.value)} title={`Default: the data date (${p?.last_recalc_date?.slice(0, 16) || 'not set'})`} /></label>
        <label>Contract finish <input type="datetime-local" value={target} onChange={(e) => setTarget(e.target.value)} title={`Default: Must Finish By (${p?.plan_end_date?.slice(0, 16) || 'not set'})`} /></label>
        <label>Test delay <input style={{ width: 48 }} value={slip} onChange={(e) => setSlip(e.target.value)} /> days</label>
        <label><input type="checkbox" checked={dynamic} onChange={(e) => setDynamic(e.target.checked)} /> Dynamic 44-day limit</label>
        <button className="btn primary" onClick={run}>Run assessment</button>
        {report && <button className="btn" onClick={save}>Save Report...</button>}
      </div>
      {report && <div><b>{report.summary.failed}</b> failed · {report.summary.passed} passed{report.summary.not_assessed ? ` · ${report.summary.not_assessed} not assessed` : ''} · {report.tasks} tasks, {report.relationships} relationships · status date {report.status_date?.slice(0, 16) ?? 'not set'}{report.baseline ? ` · baseline ${report.baseline.name}${/project baseline$/.test(report.baseline.how) ? '' : ` (${report.baseline.how})`}` : ' · no baseline'}</div>}
      {report ? <AnalysisResults checks={report.checks} /> : <div className="muted">Runs the 14 DCMA checks on the open project(s). The critical path test runs on a copy; the project is not changed.</div>}
    </div>
  );
}

function LintPanel() {
  const ui = useStore((s) => s.ui);
  const [profile, setProfile] = useState<'p6' | 'platform'>('p6');
  const [report, setReport] = useState<LintReport | null>(null);
  const run = () => setReport(lintSchedule(getDb(), { projIds: ui.openProjects, hoursPerDay: ui.prefs.hoursPerDay, profile }));
  const apply = (f: Fix) => {
    let err = '';
    // a refused fix rolls back inside mutate (nothing recorded) and is reported
    try { mutate(`Lint fix: ${f.fix}`, (d) => { const r = applyOps(d, f.ops, { hoursPerDay: ui.prefs.hoursPerDay }); if (!r.ok) { err = r.error!.message; throw new Error(err); } }); } catch { /* reported below */ }
    if (err) return toast(`Not applied: ${err}`);
    const r = runSchedule({});
    toast(`Applied: ${f.fix}${r?.ok ? ' (rescheduled; Ctrl+Z undoes)' : ''}`);
    run();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <label>Profile <select value={profile} onChange={(e) => setProfile(e.target.value as 'p6' | 'platform')}><option value="p6">P6 checks</option><option value="platform">P6 checks + network score (White Hat IQ)</option></select></label>
        <button className="btn primary" onClick={run}>Run lint</button>
      </div>
      {report && <div>{report.score != null ? <><b>Score {report.score}</b> (grade {report.grade}) · </> : null}{report.checks.filter((c) => c.band === 'fail').length} failing · {report.checks.filter((c) => c.band === 'warn').length} warnings · {report.work_activities} work activities, {report.relationships} relationships</div>}
      {report ? <AnalysisResults checks={report.checks} onApplyFix={apply} /> : <div className="muted">Finds logic and modelling problems P6 schedules without complaint. Fixes are edit operations: Apply makes the change, reschedules, and can be undone with Ctrl+Z.</div>}
    </div>
  );
}
