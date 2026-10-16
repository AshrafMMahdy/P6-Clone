import { useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, mutate, openDialog, setUi, toast, useStore } from '../store.ts';
import { detectFormat, exportFile, parseFile, type Format, type ParsedFile } from '../io.ts';
import { importIntoDb, type ImportPlan, type ProjectAction, type DictAction } from '../../core/xer/import.ts';
import { EXPORT_VERSIONS, verification } from '../../core/xer/schema.ts';
import { worst } from '../../core/findings.ts';
import { rows } from '../../core/db.ts';
import { ensureEps, projectName } from '../model.ts';
import { openProjects } from '../views/ProjectsView.tsx';

function WizardFrame(p: { title: string; steps: string[]; step: number; children: React.ReactNode; onBack?: () => void; onNext?: () => void; onFinish?: () => void; nextDisabled?: boolean; finishLabel?: string }) {
  return (
    <Dialog title={p.title} className="wizard" bottomButtons buttons={<>
      <button className="btn" disabled={!p.onBack} onClick={p.onBack}>&lt; Back</button>
      <button className="btn" disabled={!p.onNext || p.nextDisabled} onClick={p.onNext}>Next &gt;</button>
      <button className="btn primary" disabled={!p.onFinish || p.nextDisabled} onClick={p.onFinish}>{p.finishLabel ?? 'Finish'}</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
    </>}>
      <div style={{ display: 'flex', height: '100%', margin: -10 }}>
        <div className="wizard-side">
          <div style={{ fontSize: 15, fontWeight: 'bold', marginBottom: 6 }}>{p.title}</div>
          {p.steps.map((s, i) => <div key={s} className={`step ${i === p.step ? 'on' : ''}`}>{i + 1}. {s}</div>)}
        </div>
        <div style={{ flex: 1, padding: 14, overflow: 'auto' }}>{p.children}</div>
      </div>
    </Dialog>
  );
}

const DICTS: [string, string][] = [['CALENDAR', 'Calendars'], ['RSRC', 'Resources'], ['ROLES', 'Roles'], ['ACTVTYPE', 'Activity Codes'], ['UDFTYPE', 'User Defined Fields'], ['ACCOUNT', 'Cost Accounts']];

/** File > Import wizard (P6 steps: format, type, file, projects, update options, finish). */
export function ImportWizard(props: { preload?: { name: string; bytes: Uint8Array } }) {
  const [step, setStep] = useState(props.preload ? 2 : 0);
  const [format, setFormat] = useState<Format>(props.preload ? detectFormat(props.preload.name, props.preload.bytes) : 'xer');
  const [importType, setImportType] = useState('project');
  const [file, setFile] = useState<{ name: string; parsed: ParsedFile } | null>(() => props.preload ? { name: props.preload.name, parsed: parseFile(props.preload.name, props.preload.bytes) } : null);
  const [plan, setPlan] = useState<ImportPlan['projects']>(() => file ? defaultRows(file.parsed) : []);
  const [dict, setDict] = useState<Record<string, DictAction>>({});
  const existing = rows(getDb(), 'PROJECT').filter((p) => !p._baseline_of);
  const eps = getDb().tables.EPS?.rows ?? [];
  const steps = ['Import Format', 'Import Type', 'Import File', 'Projects To Import', 'Update Project Options', 'Finish'];

  function defaultRows(pf: ParsedFile): ImportPlan['projects'] {
    return rows(pf.db, 'PROJECT').map((p) => {
      const match = rows(getDb(), 'PROJECT').find((x) => x.proj_short_name === p.proj_short_name && !x._baseline_of);
      return { srcProjId: p.proj_id, action: (match ? 'replace' : 'new') as ProjectAction, targetProjId: match?.proj_id, epsId: eps[0]?.eps_id ?? '1' };
    });
  }

  const browse = async () => {
    const f = await window.p6.openFile(format === 'xml' ? [{ name: 'Primavera PM/EPPM XML', extensions: ['xml'] }, { name: 'All Files', extensions: ['*'] }] : [{ name: 'Primavera PM (XER)', extensions: ['xer'] }, { name: 'All Files', extensions: ['*'] }], 'Select Import File');
    if (!f) return;
    const parsed = parseFile(f.name, f.bytes, format);
    setFile({ name: f.path, parsed });
    setPlan(defaultRows(parsed));
  };

  const verdict = file ? worst(file.parsed.findings) : null;
  const counts = file ? file.parsed.findings.reduce<Record<string, number>>((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {}) : {};

  const finish = () => {
    if (!file) return;
    const fname = file.name.split(/[\\/]/).pop() ?? file.name;
    setUi({ importLog: { file: fname, findings: file.parsed.findings } });
    if (verdict === 'fatal') {
      closeDialog();
      openDialog('importLog', { failed: true });
      return;
    }
    let ids: string[] = [];
    let extra: typeof file.parsed.findings = [];
    mutate(`Import ${fname}`, (db) => {
      ensureEps(db);
      const res = importIntoDb(db, file.parsed.db, { projects: plan, dict });
      ids = res.projIds;
      extra = res.findings;
    });
    if (extra.length) setUi({ importLog: { file: fname, findings: [...file.parsed.findings, ...extra] } });
    closeDialog();
    if (ids.length) openProjects(ids);
    toast(`Imported ${ids.length} project(s) from ${fname}${verdict === 'error' ? ' — WARNING: real P6 would fail on this file (see Import Log)' : ''}`);
    if (verdict === 'error' || verdict === 'warning') openDialog('importLog', {});
  };

  return (
    <WizardFrame title="Import" steps={steps} step={step}
      onBack={step > 0 ? () => setStep(step - 1) : undefined}
      onNext={step < 5 ? () => setStep(step + 1) : undefined}
      nextDisabled={step === 2 && !file}
      onFinish={file && step >= 3 ? finish : undefined}>
      {step === 0 && <>
        <h3>Select the format of the data you want to import</h3>
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={format === 'xer'} onChange={() => setFormat('xer')} /> Primavera PM - (XER)</label>
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={format === 'xml'} onChange={() => setFormat('xml')} /> Primavera PM/EPPM - (XML)</label>
        <label style={{ display: 'block', margin: '6px 0', color: '#999' }}><input type="radio" disabled /> Microsoft Project (not available in this clone)</label>
        <label style={{ display: 'block', margin: '6px 0', color: '#999' }}><input type="radio" disabled /> Spreadsheet - (XLS) (not available in this clone)</label>
      </>}
      {step === 1 && <>
        <h3>Select the type of data to import</h3>
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={importType === 'project'} onChange={() => setImportType('project')} /> Project</label>
        <label style={{ display: 'block', margin: '6px 0', color: '#999' }}><input type="radio" disabled /> Resource Only</label>
        <label style={{ display: 'block', margin: '6px 0', color: '#999' }}><input type="radio" disabled /> Roles Only</label>
      </>}
      {step === 2 && <>
        <h3>Select the file to import</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <input readOnly value={file?.name ?? ''} style={{ flex: 1, border: '1px solid #7f9db9', height: 21 }} />
          <button className="btn" onClick={browse}>Browse...</button>
        </div>
        {file && <div style={{ marginTop: 12 }}>
          <div>Format: <b>{file.parsed.format.toUpperCase()}</b>{file.parsed.db.header && <> · ERMHDR version <b>{file.parsed.db.header.version}</b> · exported {file.parsed.db.header.exportDate} by {file.parsed.db.header.raw[5] ?? file.parsed.db.header.raw[4]}</>}</div>
          <div>Tables: {Object.keys(file.parsed.db.tables).length} · Projects: {rows(file.parsed.db, 'PROJECT').length} · Activities: {rows(file.parsed.db, 'TASK').length} · Relationships: {rows(file.parsed.db, 'TASKPRED').length}</div>
          <div style={{ marginTop: 8, padding: 8, border: '1px solid #ccc', background: verdict === 'fatal' ? '#fde4e4' : verdict === 'error' ? '#fff0e0' : '#e9f7e9' }}>
            <b>{verdict === 'fatal' ? 'P6 would REJECT this file.' : verdict === 'error' ? 'P6 import would FAIL or drop data.' : 'P6 would import this file.'}</b>
            <div>{['fatal', 'error', 'warning', 'info'].map((s) => counts[s] ? <span key={s} className={`sev-${s}`} style={{ marginRight: 10 }}>{counts[s]} {s}</span> : null)}</div>
            <button className="btn" style={{ marginTop: 6 }} onClick={() => { setUi({ importLog: { file: file.name, findings: file.parsed.findings } }); openDialog('importLog', {}); }}>View Diagnostics...</button>
          </div>
        </div>}
      </>}
      {step === 3 && file && <>
        <h3>Projects to import</h3>
        <div className="tblwrap" style={{ maxHeight: 300 }}>
          <table className="tbl">
            <thead><tr><th>Project ID</th><th>Project Name</th><th>Import Action</th><th>Import To</th></tr></thead>
            <tbody>
              {plan.map((r, i) => {
                const sp = rows(file.parsed.db, 'PROJECT').find((p) => p.proj_id === r.srcProjId)!;
                const upd = (patch: Partial<typeof r>) => setPlan(plan.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <tr key={r.srcProjId}>
                    <td>{sp.proj_short_name}</td>
                    <td>{projectName(file.parsed.db, sp)}</td>
                    <td><select value={r.action} onChange={(e) => upd({ action: e.target.value as ProjectAction, targetProjId: r.targetProjId ?? existing[0]?.proj_id })}>
                      <option value="new">Create New Project</option>
                      <option value="replace" disabled={!existing.length}>Replace Existing Project</option>
                      <option value="update" disabled={!existing.length}>Update Existing Project</option>
                      <option value="skip">Do Not Import</option>
                    </select></td>
                    <td>{r.action === 'new'
                      ? <select value={r.epsId} onChange={(e) => upd({ epsId: e.target.value })}>{(eps.length ? eps : [{ eps_id: '1', eps_name: 'All Initiatives', eps_short_name: 'Enterprise' }]).map((e) => <option key={e.eps_id} value={e.eps_id}>EPS: {e.eps_short_name} {e.eps_name}</option>)}</select>
                      : r.action === 'skip' ? '' : <select value={r.targetProjId} onChange={(e) => upd({ targetProjId: e.target.value })}>{existing.map((p) => <option key={p.proj_id} value={p.proj_id}>{p.proj_short_name} - {projectName(getDb(), p)}</option>)}</select>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted">Replace deletes the existing project's data and loads the file into it (keeping its project ID). Update matches activities by Activity ID and keeps their internal IDs.</p>
      </>}
      {step === 4 && <>
        <h3>Update project options</h3>
        <p className="muted">How should data that already exists in the database (matched by name/ID) be treated?</p>
        <table className="tbl" style={{ maxWidth: 420 }}>
          <thead><tr><th>Data Type</th><th>Action</th></tr></thead>
          <tbody>{DICTS.map(([k, l]) => (
            <tr key={k}><td>{l}</td><td><select value={dict[k] ?? 'keep'} onChange={(e) => setDict({ ...dict, [k]: e.target.value as DictAction })}>
              <option value="keep">Keep Existing</option><option value="update">Update Existing</option><option value="insert">Insert New</option></select></td></tr>
          ))}</tbody>
        </table>
      </>}
      {step === 5 && file && <>
        <h3>Ready to import</h3>
        <p>File: <b>{file.name}</b></p>
        <p>{plan.filter((p) => p.action !== 'skip').length} project(s) will be imported.</p>
        {verdict === 'fatal' && <p className="sev-error">This file has fatal problems; like P6, the import will be refused. The import log will explain why.</p>}
        {verdict === 'error' && <p className="sev-warning">This file has errors that make real P6 fail or drop data. The clone will import what it can so you can inspect it.</p>}
      </>}
    </WizardFrame>
  );
}

/** File > Export wizard. */
export function ExportWizard(props: { projIds?: string[] }) {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const projects = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
  const [step, setStep] = useState(0);
  const [format, setFormat] = useState<Format>('xer');
  const [version, setVersion] = useState('19.12');
  const [sel, setSel] = useState<string[]>(props.projIds ?? (ui.openProjects.length ? ui.openProjects : projects.slice(0, 1).map((p) => p.proj_id)));
  const steps = ['Export Format', 'Export Type', 'Projects To Export', 'File Name'];
  const finish = async () => {
    const bytes = exportFile(getDb(), format, { version, projIds: sel });
    const first = projects.find((p) => p.proj_id === sel[0]);
    const path = await window.p6.saveFile(`${first?.proj_short_name ?? 'export'}.${format}`, bytes, format === 'xml' ? [{ name: 'P6 XML', extensions: ['xml'] }] : [{ name: 'Primavera PM (XER)', extensions: ['xer'] }]);
    if (!path) return;
    closeDialog();
    // self-check: re-import what was written
    const check = parseFile(path, bytes, format);
    const w = worst(check.findings);
    toast(`Exported ${sel.length} project(s) to ${path}. Self-check: ${w === 'fatal' || w === 'error' ? 'PROBLEMS (see Import Log)' : 'OK'}`);
    if (w === 'fatal' || w === 'error') { setUi({ importLog: { file: path, findings: check.findings } }); openDialog('importLog', {}); }
  };
  return (
    <WizardFrame title="Export" steps={steps} step={step} onBack={step > 0 ? () => setStep(step - 1) : undefined} onNext={step < 3 ? () => setStep(step + 1) : undefined}
      nextDisabled={step === 2 && !sel.length} onFinish={sel.length ? finish : undefined} finishLabel="Finish...">
      {step === 0 && <>
        <h3>Select the format of the export file</h3>
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={format === 'xer'} onChange={() => setFormat('xer')} /> Primavera PM - (XER)</label>
        {format === 'xer' && <div style={{ margin: '4px 0 10px 24px' }}>Version: <select value={version} onChange={(e) => setVersion(e.target.value)}>{EXPORT_VERSIONS.map((v) => <option key={v}>{v}</option>)}</select>
          <span className="muted" style={{ marginLeft: 8 }}>Field layout: {verification(version, 'TASK') === 'exact' ? 'verified against real P6 export' : verification(version, 'TASK') === 'modern-build' ? 'from a real modern P6 build' : 'best knowledge'}</span></div>}
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={format === 'xml'} onChange={() => setFormat('xml')} /> Primavera PM/EPPM - (XML)</label>
        <label style={{ display: 'block', margin: '6px 0', color: '#999' }}><input type="radio" disabled /> Microsoft Project (not available)</label>
      </>}
      {step === 1 && <>
        <h3>Select the type of data to export</h3>
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" defaultChecked /> Project</label>
        <label style={{ display: 'block', margin: '6px 0', color: '#999' }}><input type="radio" disabled /> Resource Only</label>
      </>}
      {step === 2 && <>
        <h3>Projects to export</h3>
        <div className="tblwrap" style={{ maxHeight: 300 }}>
          <table className="tbl"><thead><tr><th>Export</th><th>Project ID</th><th>Project Name</th></tr></thead><tbody>
            {projects.map((p) => <tr key={p.proj_id}><td><input type="checkbox" checked={sel.includes(p.proj_id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.proj_id] : sel.filter((x) => x !== p.proj_id))} /></td><td>{p.proj_short_name}</td><td>{projectName(db, p)}</td></tr>)}
          </tbody></table>
        </div>
      </>}
      {step === 3 && <>
        <h3>File name</h3>
        <p>Click <b>Finish...</b> to choose where to save the {format.toUpperCase()} file{format === 'xer' ? ` (version ${version})` : ''}.</p>
        <p className="muted">After writing, the clone re-reads the file and validates it the same way it validates imports.</p>
      </>}
    </WizardFrame>
  );
}
