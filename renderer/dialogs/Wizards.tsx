import { useEffect, useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, mutate, openDialog, setUi, toast, useStore } from '../store.ts';
import { bridgeMessage, detectFormat, exportFile, FORMAT_INFO, isMspFormat, MSP_FORMATS, parseFile, parseFileAsync, type Format, type ParsedFile } from '../io.ts';
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

/** "Microsoft Project (MPP, MPX, XML)" radio with its file-type sub-choice, used by both wizards. */
function MspFormatChoice(p: { format: Format; setFormat: (f: Format) => void; note?: string }) {
  const on = isMspFormat(p.format);
  return <>
    <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={on} onChange={() => p.setFormat('mspdi')} /> Microsoft Project (MPP, MPX, XML)</label>
    {on && <div style={{ margin: '2px 0 10px 24px' }}>
      {MSP_FORMATS.map((f) => <label key={f} style={{ display: 'block', margin: '3px 0' }}><input type="radio" checked={p.format === f} onChange={() => p.setFormat(f)} /> {FORMAT_INFO[f].label}</label>)}
      {p.format === 'mpp' && <div className="muted" style={{ marginTop: 4 }}>Like Primavera P6, .mpp files are converted by an installed Microsoft Project (it runs hidden in the background).</div>}
      {p.note && <div className="muted" style={{ marginTop: 4 }}>{p.note}</div>}
    </div>}
  </>;
}

const DICTS: [string, string][] = [['CALENDAR', 'Calendars'], ['RSRC', 'Resources'], ['ROLES', 'Roles'], ['ACTVTYPE', 'Activity Codes'], ['UDFTYPE', 'User Defined Fields'], ['ACCOUNT', 'Cost Accounts']];

/** File > Import wizard (P6 steps: format, type, file, projects, update options, finish). */
export function ImportWizard(props: { preload?: { name: string; bytes: Uint8Array } }) {
  const existing = rows(getDb(), 'PROJECT').filter((p) => !p._baseline_of);
  const eps = getDb().tables.EPS?.rows ?? [];
  const [step, setStep] = useState(props.preload ? 2 : 0);
  const [format, setFormat] = useState<Format>(props.preload ? detectFormat(props.preload.name, props.preload.bytes) : 'xer');
  const [importType, setImportType] = useState('project');
  const preloadMpp = !!props.preload && detectFormat(props.preload.name, props.preload.bytes) === 'mpp';
  const [file, setFile] = useState<{ name: string; parsed: ParsedFile } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan['projects']>([]);
  // show each stage of reading a big file (the window repaints between stages)
  const stage = async (msg: string) => { setBusy(msg); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); };
  const [dict, setDict] = useState<Record<string, DictAction>>({});
  const steps = ['Import Format', 'Import Type', 'Import File', 'Projects To Import', 'Update Project Options', 'Finish'];

  function defaultRows(pf: ParsedFile): ImportPlan['projects'] {
    return rows(pf.db, 'PROJECT').map((p) => {
      const match = rows(getDb(), 'PROJECT').find((x) => x.proj_short_name === p.proj_short_name && !x._baseline_of);
      return { srcProjId: p.proj_id, action: (match ? 'replace' : 'new') as ProjectAction, targetProjId: match?.proj_id, epsId: eps[0]?.eps_id ?? '1' };
    });
  }

  const load = async (path: string, name: string, bytes: Uint8Array, fmt: Format) => {
    setBridgeError(null);
    if (fmt !== 'mpp') {
      setFile(null);
      try {
        const parsed = fmt === 'xer' || fmt === 'xml' ? await parseFileAsync(name, bytes, fmt, undefined, stage) : parseFile(name, bytes, fmt);
        setFile({ name: path, parsed });
        setPlan(defaultRows(parsed));
      } finally { setBusy(null); }
      return;
    }
    setFile(null);
    setBusy('Converting the .mpp file with Microsoft Project...');
    try {
      const parsed = await parseFileAsync(name, bytes, 'mpp', window.p6);
      setFile({ name: path, parsed });
      setPlan(defaultRows(parsed));
    } catch (e) {
      setBridgeError(bridgeMessage(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (props.preload) void load(props.preload.name, props.preload.name, props.preload.bytes, preloadMpp ? 'mpp' : detectFormat(props.preload.name, props.preload.bytes));
  }, []);

  const browse = async () => {
    const msp = isMspFormat(format);
    const filters = msp
      ? [{ name: 'Microsoft Project (*.mpp, *.mpx, *.xml)', extensions: ['mpp', 'mpx', 'xml'] }, FORMAT_INFO[format].filter, { name: 'All Files', extensions: ['*'] }]
      : [FORMAT_INFO[format].filter, { name: 'All Files', extensions: ['*'] }];
    const f = await window.p6.openFile(filters, 'Select Import File');
    if (!f) return;
    // Within the Microsoft Project family the file decides (an .mpx picked while "XML" is selected is still read as MPX).
    const detected = detectFormat(f.name, f.bytes);
    const fmt = msp && isMspFormat(detected) ? detected : format;
    if (fmt !== format) setFormat(fmt);
    await load(f.path, f.name, f.bytes, fmt);
  };

  const verdict = file ? worst(file.parsed.findings) : null;
  const counts = file ? file.parsed.findings.reduce<Record<string, number>>((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {}) : {};

  const finish = async () => {
    if (!file) return;
    await stage(`Importing ${(file.parsed.db.tables.TASK?.rows.length ?? 0).toLocaleString()} activities...`);
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
      nextDisabled={(step === 2 && !file) || !!busy}
      onFinish={file && step >= 3 && !busy ? finish : undefined}>
      {step === 0 && <>
        <h3>Select the format of the data you want to import</h3>
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={format === 'xer'} onChange={() => setFormat('xer')} /> Primavera PM - (XER)</label>
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={format === 'xml'} onChange={() => setFormat('xml')} /> Primavera PM/EPPM - (XML)</label>
        <MspFormatChoice format={format} setFormat={setFormat} />
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
          <button className="btn" onClick={browse} disabled={!!busy}>Browse...</button>
        </div>
        {busy && <div style={{ marginTop: 12, padding: 8, border: '1px solid #ccc', background: '#f4f4f4' }}>{busy}</div>}
        {bridgeError && <div style={{ marginTop: 12, padding: 8, border: '1px solid #ccc', background: '#fde4e4' }}>
          <b>The .mpp file could not be imported.</b>
          <div style={{ marginTop: 4 }}>{bridgeError}</div>
          <div className="muted" style={{ marginTop: 4 }}>You can save the file from Microsoft Project as XML or MPX and import that instead.</div>
        </div>}
        {file && <div style={{ marginTop: 12 }}>
          <div>Format: <b>{isMspFormat(file.parsed.format) ? FORMAT_INFO[file.parsed.format].label : file.parsed.format.toUpperCase()}</b>{file.parsed.db.header && <> · ERMHDR version <b>{file.parsed.db.header.version}</b> · exported {file.parsed.db.header.exportDate} by {file.parsed.db.header.raw[5] ?? file.parsed.db.header.raw[4]}</>}</div>
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
        {busy && <div style={{ marginBottom: 8, padding: 8, border: '1px solid #ccc', background: '#f4f4f4' }}>{busy}</div>}
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const steps = ['Export Format', 'Export Type', 'Projects To Export', 'File Name'];
  const msp = isMspFormat(format);
  const finish = async () => {
    // A Microsoft Project file holds one project (P6 exports one project per MS Project file).
    const ids = msp ? sel.slice(0, 1) : sel;
    const bytes = exportFile(getDb(), format, { version, projIds: ids });
    const first = projects.find((p) => p.proj_id === ids[0]);
    const base = (first?.proj_short_name ?? 'export').replace(/[\\/:*?"<>|]/g, '_');
    setError(null);
    let path: string | null;
    if (format === 'mpp') {
      setBusy('Saving the .mpp file with Microsoft Project...');
      try {
        path = await window.p6.xmlToMpp(`${base}.mpp`, bytes);
      } catch (e) {
        setError(bridgeMessage(e));
        return;
      } finally {
        setBusy(null);
      }
    } else {
      path = await window.p6.saveFile(`${base}.${FORMAT_INFO[format].ext}`, bytes, [FORMAT_INFO[format].filter]);
    }
    if (!path) return;
    closeDialog();
    // self-check: re-import what was written (for .mpp, the XML handed to Microsoft Project)
    const check = parseFile(path, bytes, format === 'mpp' ? 'mspdi' : format);
    const w = worst(check.findings);
    toast(`Exported ${ids.length} project(s) to ${path}. Self-check: ${w === 'fatal' || w === 'error' ? 'PROBLEMS (see Import Log)' : 'OK'}`);
    if (w === 'fatal' || w === 'error') { setUi({ importLog: { file: path, findings: check.findings } }); openDialog('importLog', {}); }
  };
  return (
    <WizardFrame title="Export" steps={steps} step={step} onBack={step > 0 ? () => setStep(step - 1) : undefined} onNext={step < 3 ? () => setStep(step + 1) : undefined}
      nextDisabled={(step === 2 && !sel.length) || !!busy} onFinish={sel.length && !busy ? finish : undefined} finishLabel="Finish...">
      {step === 0 && <>
        <h3>Select the format of the export file</h3>
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={format === 'xer'} onChange={() => setFormat('xer')} /> Primavera PM - (XER)</label>
        {format === 'xer' && <div style={{ margin: '4px 0 10px 24px' }}>Version: <select value={version} onChange={(e) => setVersion(e.target.value)}>{EXPORT_VERSIONS.map((v) => <option key={v}>{v}</option>)}</select>
          <span className="muted" style={{ marginLeft: 8 }}>Field layout: {verification(version, 'TASK') === 'exact' ? 'verified against real P6 export' : verification(version, 'TASK') === 'modern-build' ? 'from a real modern P6 build' : 'best knowledge'}</span></div>}
        <label style={{ display: 'block', margin: '6px 0' }}><input type="radio" checked={format === 'xml'} onChange={() => setFormat('xml')} /> Primavera PM/EPPM - (XML)</label>
        <MspFormatChoice format={format} setFormat={setFormat} note="A Microsoft Project file holds one project; with several selected, the first one is exported." />
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
        <p>Click <b>Finish...</b> to choose where to save the {msp ? FORMAT_INFO[format].label : format.toUpperCase()} file{format === 'xer' ? ` (version ${version})` : ''}.</p>
        {msp && sel.length > 1 && <p className="sev-warning">{sel.length} projects are selected; a Microsoft Project file holds one project, so only the first one is exported.</p>}
        <p className="muted">After writing, the clone re-reads the file and validates it the same way it validates imports.</p>
        {busy && <div style={{ marginTop: 8, padding: 8, border: '1px solid #ccc', background: '#f4f4f4' }}>{busy}</div>}
        {error && <div style={{ marginTop: 8, padding: 8, border: '1px solid #ccc', background: '#fde4e4' }}><b>The .mpp file could not be saved.</b><div style={{ marginTop: 4 }}>{error}</div><div className="muted" style={{ marginTop: 4 }}>Microsoft Project XML or MPX can be exported without Microsoft Project.</div></div>}
      </>}
    </WizardFrame>
  );
}
