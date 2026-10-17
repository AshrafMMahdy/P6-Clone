// Tools > Reports: the Run Report dialog (output choice, as in P6) and the Report Wizard (subject area, columns,
// filter, group and sort, title), which saves the user's own reports with the project database.
import { useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, openDialog, toast } from '../store.ts';
import { listReports, parseSpec, reportFilters, subjectColumns, SUBJECTS, REPORT_GROUPS, type ReportSpec, type Subject } from '../reports/engine.ts';
import { OUTPUTS, type ReportOutput } from '../reports/output.ts';
import { runReportTo, saveReport } from '../reports/app.ts';

export function RunReportDialog(props: { reportId: string; weeks?: number; output?: ReportOutput }) {
  const entry = listReports(getDb()).find((e) => e.id === props.reportId);
  const [out, setOut] = useState<ReportOutput>(props.output ?? 'preview');
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { closeDialog(); await runReportTo(props.reportId, out, props.weeks); } finally { setBusy(false); } };
  return (
    <Dialog title="Run Report" width={460} height={330} buttons={<>
      <button className="btn primary" disabled={busy || !entry} onClick={() => void run()}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
      <button className="btn" onClick={() => openDialog('pageSetup')}>Page Setup...</button>
    </>}>
      <p style={{ marginTop: 0 }}>Report: <b>{entry?.name ?? props.reportId}</b></p>
      <fieldset><legend>Output</legend>
        {OUTPUTS.map(([id, label]) => <label key={id} style={{ display: 'block', margin: '3px 0' }}><input type="radio" name="out" checked={out === id} onChange={() => setOut(id)} /> {label}</label>)}
      </fieldset>
      <p className="muted">Print Preview, Direct to Printer and PDF use File &gt; Page Setup (paper, orientation, margins, header and footer).</p>
    </Dialog>
  );
}

const STEPS = ['Subject Area', 'Columns', 'Filter', 'Group and Sort', 'Report Title', 'Finish'];
const mini = { minWidth: 0, padding: '0 6px', height: 18, lineHeight: '16px', fontSize: 11 };

export function ReportWizardDialog(props: { editId?: string; copyFrom?: string; preset?: Partial<ReportSpec>; runAfter?: boolean; onDone?: (id: string) => void }) {
  const db = getDb();
  const src = props.editId ?? props.copyFrom;
  const base = src ? listReports(db).find((e) => e.id === src)?.spec : undefined;
  const init = parseSpec({ name: 'New Report', ...base, ...(props.copyFrom && base ? { name: `${base.name} (copy)`, group: 'My Reports' } : {}), ...props.preset })!;
  const [s, setS] = useState<ReportSpec>(init);
  const [step, setStep] = useState(0);
  const [runAfter, setRunAfter] = useState(props.runAfter ?? true);
  const set = (p: Partial<ReportSpec>) => setS({ ...s, ...p });
  const cols = subjectColumns(db, s.subject);
  const title = new Map(cols.map((c) => [c.id, c.title]));
  const chosen = s.columns.filter((c) => title.has(c));
  const move = (id: string, d: number) => { const a = [...chosen], i = a.indexOf(id), j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; set({ columns: a }); };
  const finish = () => {
    if (!s.name.trim()) { setStep(4); return toast('Give the report a name.'); }
    if (!chosen.length) { setStep(1); return toast('Choose at least one column.'); }
    const id = saveReport({ ...s, columns: chosen, name: s.name.trim() }, props.editId);
    closeDialog();
    toast(`Report "${s.name.trim()}" saved in ${s.group}`);
    props.onDone?.(id);
    if (runAfter) openDialog('runReport', { reportId: id });
  };
  return (
    <Dialog title={`Report Wizard - ${STEPS[step]}`} width={640} height={500} buttons={<>
      <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>&lt; Back</button>
      {step < STEPS.length - 1 ? <button className="btn primary" onClick={() => setStep(step + 1)}>Next &gt;</button> : <button className="btn primary" onClick={finish}>Finish</button>}
      <button className="btn" onClick={closeDialog}>Cancel</button>
    </>}>
      <div style={{ display: 'flex', gap: 12, height: 380 }}>
        <ol style={{ width: 140, margin: 0, paddingLeft: 18, color: '#666' }}>{STEPS.map((x, i) => <li key={x} style={{ fontWeight: i === step ? 'bold' : undefined, color: i === step ? '#0b3a7d' : undefined, margin: '4px 0' }}>{x}</li>)}</ol>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }}>
          {step === 0 && <>
            <p style={{ marginTop: 0 }}>What is the report about? Each subject area has its own columns.</p>
            {(Object.keys(SUBJECTS) as Subject[]).map((k) => <label key={k} style={{ display: 'block', margin: '6px 0' }}><input type="radio" name="subj" checked={s.subject === k} onChange={() => set({ subject: k, columns: SUBJECTS[k].defaultColumns, groupBy: SUBJECTS[k].groupings[0][0], sortBy: '' })} /> {SUBJECTS[k].title}</label>)}
          </>}
          {step === 1 && <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}><b>Selected columns</b>
              <div style={{ height: 330, overflowY: 'auto', overflowX: 'hidden', border: '1px solid #a0a0a0' }}>
                {chosen.map((id) => <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '1px 4px' }}><span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title.get(id)}</span>
                  <button className="btn" style={mini} onClick={() => move(id, -1)}>▲</button><button className="btn" style={mini} onClick={() => move(id, 1)}>▼</button><button className="btn" style={mini} onClick={() => set({ columns: chosen.filter((x) => x !== id) })}>Remove</button></div>)}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}><b>Available columns</b>
              <div style={{ height: 330, overflowY: 'auto', overflowX: 'hidden', border: '1px solid #a0a0a0' }}>
                {cols.filter((c) => !chosen.includes(c.id)).map((c) => <div key={c.id} style={{ display: 'flex', alignItems: 'center', padding: '1px 4px' }}><span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span><button className="btn" style={mini} onClick={() => set({ columns: [...chosen, c.id] })}>Add</button></div>)}
              </div>
            </div>
          </div>}
          {step === 2 && <>
            <p style={{ marginTop: 0 }}>Which {s.subject === 'activities' ? 'activities' : `${SUBJECTS[s.subject].title.toLowerCase()} (by their activities)`} appear? Your own filters (View &gt; Filters) are listed too.</p>
            <select size={14} style={{ width: '100%' }} value={s.filter} onChange={(e) => set({ filter: e.target.value })}>{reportFilters(db).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
          </>}
          {step === 3 && <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
            <label>Group by</label><select value={s.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>{SUBJECTS[s.subject].groupings.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <label>Sort by</label><select value={s.sortBy} onChange={(e) => set({ sortBy: e.target.value })}><option value="">(default order)</option>{chosen.map((id) => <option key={id} value={id}>{title.get(id)}</option>)}</select>
            <label>Order</label><span><label style={{ marginRight: 12 }}><input type="radio" name="ord" checked={!s.sortDesc} onChange={() => set({ sortDesc: false })} /> Ascending</label><label><input type="radio" name="ord" checked={!!s.sortDesc} onChange={() => set({ sortDesc: true })} /> Descending</label></span>
          </div>}
          {step === 4 && <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
            <label>Report name</label><input value={s.name} onChange={(e) => set({ name: e.target.value })} />
            <label>Title on the report</label><input value={s.title ?? ''} placeholder={s.name} onChange={(e) => set({ title: e.target.value || undefined })} />
            <label>Report group</label><select value={s.group} onChange={(e) => set({ group: e.target.value })}>{[...new Set([...REPORT_GROUPS, s.group])].map((g) => <option key={g}>{g}</option>)}</select>
          </div>}
          {step === 5 && <>
            <p style={{ marginTop: 0 }}>The report will be saved with the project:</p>
            <table className="form"><tbody>
              <tr><td>Name</td><td><b>{s.name}</b> ({s.group})</td></tr>
              <tr><td>Subject area</td><td>{SUBJECTS[s.subject].title}</td></tr>
              <tr><td>Columns</td><td>{chosen.map((c) => title.get(c)).join(', ')}</td></tr>
              <tr><td>Filter</td><td>{reportFilters(db).find((f) => f.id === s.filter)?.name ?? s.filter}</td></tr>
              <tr><td>Group / sort</td><td>{SUBJECTS[s.subject].groupings.find((g) => g[0] === s.groupBy)?.[1] ?? s.groupBy}{s.sortBy ? ` / ${title.get(s.sortBy)} ${s.sortDesc ? 'descending' : 'ascending'}` : ''}</td></tr>
            </tbody></table>
            <label style={{ display: 'block', marginTop: 10 }}><input type="checkbox" checked={runAfter} onChange={(e) => setRunAfter(e.target.checked)} /> Run the report when I click Finish</label>
          </>}
        </div>
      </div>
    </Dialog>
  );
}
