import { useMemo, useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, mutate, setUi, toast, useStore, DEFAULT_COLUMNS, type Prefs } from '../store.ts';
import { COLUMNS, COLUMN_BY_ID, RSRC_TYPES, addRelationship, extraColumns, fmtDate } from '../model.ts';
import { rows } from '../../core/db.ts';
import { assignResource } from '../../core/resource/assign.ts';
import { applyOps } from '../../core/project/ops.ts';
import { findingsText, parseFile } from '../io.ts';
import type { Finding } from '../../core/findings.ts';

export function ColumnsDialog() {
  const ui = useStore((s) => s.ui);
  const [sel, setSel] = useState<string[]>(ui.columns);
  const [pickA, setPickA] = useState<string | null>(null);
  const [pickS, setPickS] = useState<string | null>(null);
  const avail = [...COLUMNS, ...extraColumns(getDb())].filter((c) => !sel.includes(c.id)).map((c) => (c.group ? { ...c, title: `${c.group}: ${c.title}` } : c));
  const move = (d: number) => { if (!pickS) return; const i = sel.indexOf(pickS), j = i + d; if (j < 0 || j >= sel.length) return; const n = [...sel]; [n[i], n[j]] = [n[j], n[i]]; setSel(n); };
  const list = (items: { id: string; title: string }[], pick: string | null, setPick: (s: string) => void, onDbl: (id: string) => void) => (
    <div className="tblwrap" style={{ width: 230, height: 320 }}>
      <table className="tbl"><tbody>{items.map((c) => <tr key={c.id} className={pick === c.id ? 'sel' : ''} onMouseDown={() => setPick(c.id)} onDoubleClick={() => onDbl(c.id)}><td>{c.title}</td></tr>)}</tbody></table>
    </div>
  );
  return (
    <Dialog title="Columns" width={640} buttons={<>
      <button className="btn primary" onClick={() => { setUi({ columns: sel.length ? sel : DEFAULT_COLUMNS }); closeDialog(); }}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
      <button className="btn" onClick={() => setSel(DEFAULT_COLUMNS)}>Default</button>
    </>}>
      <div className="row">
        <div><div>Available Options</div>{list(avail, pickA, setPickA, (id) => setSel([...sel, id]))}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center', paddingTop: 20 }}>
          <button className="btn" disabled={!pickA} onClick={() => pickA && setSel([...sel, pickA])}>&gt;</button>
          <button className="btn" disabled={!pickS} onClick={() => pickS && setSel(sel.filter((x) => x !== pickS))}>&lt;</button>
          <button className="btn" onClick={() => move(-1)}>Up</button>
          <button className="btn" onClick={() => move(1)}>Down</button>
        </div>
        <div><div>Selected Options</div>{list(sel.map((id) => COLUMN_BY_ID.get(id)!).filter(Boolean), pickS, setPickS, (id) => setSel(sel.filter((x) => x !== id)))}</div>
      </div>
    </Dialog>
  );
}

export function LogDialog(props: { title: string; text: string }) {
  return (
    <Dialog title={props.title} width={820} height={560} buttons={<>
      <button className="btn" onClick={() => window.p6.saveFile(`${props.title.replace(/\W+/g, '_')}.txt`, new TextEncoder().encode(props.text), [{ name: 'Text', extensions: ['txt'] }])}>Save As...</button>
      <button className="btn primary" onClick={closeDialog}>Close</button>
    </>}>
      <pre className="log" style={{ height: '100%', overflow: 'auto' }}>{props.text || 'No log available yet.'}</pre>
    </Dialog>
  );
}

export function ImportLogDialog(props: { failed?: boolean }) {
  const log = useStore((s) => s.ui.importLog);
  const [sev, setSev] = useState('all');
  const findings: Finding[] = log?.findings ?? [];
  const shown = findings.filter((f) => sev === 'all' || f.severity === sev);
  const counts = findings.reduce<Record<string, number>>((a, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {});
  return (
    <Dialog title={`Import Log${log ? ' - ' + log.file : ''}`} width={1000} height={600} buttons={<>
      <button className="btn" disabled={!log} onClick={() => log && window.p6.saveFile('import_log.txt', new TextEncoder().encode(findingsText(log.file, findings)), [{ name: 'Text', extensions: ['txt'] }])}>Save As...</button>
      <button className="btn" disabled={!log} onClick={() => log && navigator.clipboard.writeText(JSON.stringify(findings, null, 2)).then(() => toast('Findings copied as JSON'))}>Copy JSON</button>
      <button className="btn primary" onClick={closeDialog}>Close</button>
    </>}>
      {!log ? <p>No import has been run in this session.</p> : <>
        {props.failed && <p className="sev-error" style={{ fontSize: 13 }}>Import failed. Like P6, the file was not imported because of fatal problems listed below.</p>}
        <div style={{ marginBottom: 6, display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>Show:</span>
          <select value={sev} onChange={(e) => setSev(e.target.value)}><option value="all">All ({findings.length})</option>{['fatal', 'error', 'warning', 'info'].map((s) => <option key={s} value={s}>{s} ({counts[s] ?? 0})</option>)}</select>
          <span className="muted">fatal = P6 rejects the file · error = P6 import fails or drops data · warning = P6 imports with a substitution · info = harmless difference</span>
        </div>
        <div className="tblwrap" style={{ height: 'calc(100% - 60px)' }}>
          <table className="tbl" style={{ userSelect: 'text' }}>
            <thead><tr><th>Severity</th><th>Code</th><th>Table</th><th>Row</th><th>Field</th><th>Key</th><th>Message</th><th>What P6 does</th></tr></thead>
            <tbody>{shown.map((f, i) => <tr key={i}><td className={`sev-${f.severity}`}>{f.severity}</td><td>{f.code}</td><td>{f.table}</td><td>{f.row}</td><td>{f.field}</td><td>{f.key}</td><td style={{ whiteSpace: 'normal' }}>{f.message}</td><td style={{ whiteSpace: 'normal' }} className="muted">{f.p6}</td></tr>)}
              {!shown.length && <tr><td colSpan={8} className="muted">No findings.</td></tr>}</tbody>
          </table>
        </div>
      </>}
    </Dialog>
  );
}

/** Assign predecessors/successors to the selected activity. */
export function AssignDialog(props: { which: 'pred' | 'succ' }) {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const cur = ui.selTask;
  const list = useMemo(() => rows(db, 'TASK').filter((t) => (ui.openProjects.includes(t.proj_id) || q.length > 1) && t.task_id !== cur && (!q || (t.task_code + ' ' + t.task_name).toLowerCase().includes(q.toLowerCase()))).slice(0, 2000), [db, ui.openProjects, q, cur]);
  if (!cur) return <Dialog title="Assign" buttons={<button className="btn" onClick={closeDialog}>Close</button>}><p>Select an activity first.</p></Dialog>;
  const assign = () => {
    const errs: string[] = [];
    mutate(props.which === 'pred' ? 'Assign Predecessors' : 'Assign Successors', (d) => {
      for (const id of sel) { const e = props.which === 'pred' ? addRelationship(d, id, cur) : addRelationship(d, cur, id); if (e) errs.push(e); }
    });
    if (errs.length) toast(errs[0]);
    closeDialog();
  };
  return (
    <Dialog title={props.which === 'pred' ? 'Assign Predecessors' : 'Assign Successors'} width={640} height={480} buttons={<><button className="btn primary" disabled={!sel.length} onClick={assign}>Assign</button><button className="btn" onClick={closeDialog}>Close</button></>}>
      <input placeholder="Search Activity ID or name (type 2+ characters to search all projects)" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 6, border: '1px solid #7f9db9', height: 21 }} autoFocus />
      <div className="tblwrap" style={{ height: 360 }}>
        <table className="tbl"><thead><tr><th>Activity ID</th><th>Activity Name</th><th>Start</th><th>Finish</th><th>Project</th></tr></thead><tbody>
          {list.map((t) => <tr key={t.task_id} className={sel.includes(t.task_id) ? 'sel' : ''} onMouseDown={(e) => setSel(e.ctrlKey ? (sel.includes(t.task_id) ? sel.filter((x) => x !== t.task_id) : [...sel, t.task_id]) : [t.task_id])} onDoubleClick={() => { setSel([t.task_id]); }}>
            <td>{t.task_code}</td><td>{t.task_name}</td><td>{fmtDate(t.act_start_date || t.early_start_date, ui.prefs)}</td><td>{fmtDate(t.act_end_date || t.early_end_date, ui.prefs)}</td><td>{rows(db, 'PROJECT').find((p) => p.proj_id === t.proj_id)?.proj_short_name}</td>
          </tr>)}
        </tbody></table>
      </div>
    </Dialog>
  );
}

export function AssignResourceDialog() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const rs = rows(db, 'RSRC').filter((r) => !q || (r.rsrc_short_name + ' ' + r.rsrc_name).toLowerCase().includes(q.toLowerCase()));
  const targets = ui.selTasks.length ? ui.selTasks : ui.selTask ? [ui.selTask] : [];
  return (
    <Dialog title="Assign Resources" width={600} height={460} buttons={<>
      <button className="btn primary" disabled={!sel || !targets.length} onClick={() => {
        mutate('Assign Resource', (d) => { for (const id of targets) { const t = d.tables.TASK.rows.find((x) => x.task_id === id); if (t && !rows(d, 'TASKRSRC').some((a) => a.task_id === id && a.rsrc_id === sel)) assignResource(d, t, sel!); } });
        closeDialog();
      }}>Assign</button>
      <button className="btn" onClick={() => setUi({ view: 'resources' })}>Resources...</button>
      <button className="btn" onClick={closeDialog}>Close</button>
    </>}>
      {!targets.length && <p className="sev-warning">Select one or more activities first.</p>}
      <input placeholder="Search resources" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 6, border: '1px solid #7f9db9', height: 21 }} />
      <div className="tblwrap" style={{ height: 340 }}>
        <table className="tbl"><thead><tr><th>Resource ID</th><th>Resource Name</th><th>Type</th><th>Default Units/Time</th></tr></thead><tbody>
          {rs.map((r) => <tr key={r.rsrc_id} className={sel === r.rsrc_id ? 'sel' : ''} onMouseDown={() => setSel(r.rsrc_id)}><td>{r.rsrc_short_name}</td><td>{r.rsrc_name}</td><td>{RSRC_TYPES[r.rsrc_type] ?? r.rsrc_type}</td><td>{Number(r.def_qty_per_hr || 1) * 8}h/d</td></tr>)}
          {!rs.length && <tr><td colSpan={4} className="muted">No resources. Create them in Enterprise &gt; Resources.</td></tr>}
        </tbody></table>
      </div>
    </Dialog>
  );
}

/** Assign Roles (P6): a role on the selected activities with no resource yet, priced by the role's rate (core assign_role). */
export function AssignRoleDialog() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const roles = rows(db, 'ROLES').filter((r) => !q || (r.role_short_name + ' ' + r.role_name).toLowerCase().includes(q.toLowerCase()));
  const targets = ui.selTasks.length ? ui.selTasks : ui.selTask ? [ui.selTask] : [];
  const assign = () => {
    const role = rows(db, 'ROLES').find((r) => r.role_id === sel)!;
    const short = new Map(rows(db, 'PROJECT').map((p) => [p.proj_id, p.proj_short_name]));
    let err = '';
    try {
      mutate('Assign Role', (d) => {
        const ops = targets.map((id) => rows(d, 'TASK').find((t) => t.task_id === id)).filter((t): t is NonNullable<typeof t> => !!t).map((t) => ({ op: 'assign_role', activity: t.task_code, project: short.get(t.proj_id), role: role.role_short_name }));
        const r = applyOps(d, ops, { hoursPerDay: ui.prefs.hoursPerDay });
        if (!r.ok) { err = r.error!.message; throw new Error(err); }
      });
    } catch { toast(err); return; }
    closeDialog();
  };
  return (
    <Dialog title="Assign Roles" width={560} height={440} buttons={<>
      <button className="btn primary" disabled={!sel || !targets.length} onClick={assign}>Assign</button>
      <button className="btn" onClick={closeDialog}>Close</button>
    </>}>
      {!targets.length && <p className="sev-warning">Select one or more activities first.</p>}
      <input placeholder="Search roles" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 6, border: '1px solid #7f9db9', height: 21 }} />
      <div className="tblwrap" style={{ height: 320 }}>
        <table className="tbl"><thead><tr><th>Role ID</th><th>Role Name</th></tr></thead><tbody>
          {roles.map((r) => <tr key={r.role_id} className={sel === r.role_id ? 'sel' : ''} onMouseDown={() => setSel(r.role_id)}><td>{r.role_short_name}</td><td>{r.role_name}</td></tr>)}
          {!roles.length && <tr><td colSpan={2} className="muted">No roles. Create them in Enterprise &gt; Roles.</td></tr>}
        </tbody></table>
      </div>
    </Dialog>
  );
}

export function PreferencesDialog() {
  const prefs = useStore((s) => s.ui.prefs);
  const [p, setP] = useState<Prefs>(prefs);
  return (
    <Dialog title="User Preferences" width={460} buttons={<><button className="btn primary" onClick={() => { setUi({ prefs: p }); closeDialog(); }}>OK</button><button className="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset><legend>Time Units</legend>
        <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Hours per day (duration display)</label><input type="number" value={p.hoursPerDay} onChange={(e) => setP({ ...p, hoursPerDay: Number(e.target.value) || 8 })} />
          <label>Decimals</label><select value={p.durationDecimals} onChange={(e) => setP({ ...p, durationDecimals: Number(e.target.value) })}><option value={0}>0</option><option value={1}>1</option><option value={2}>2</option></select>
        </div>
      </fieldset>
      <fieldset><legend>Dates</legend>
        <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Date format</label><select value={p.dateFormat} onChange={(e) => setP({ ...p, dateFormat: e.target.value as Prefs['dateFormat'] })}><option value="dd-MMM-yy">dd-MMM-yy</option><option value="yyyy-mm-dd">yyyy-mm-dd</option><option value="mm/dd/yy">mm/dd/yy</option><option value="dd/mm/yy">dd/mm/yy</option></select>
          <label>Show time</label><input type="checkbox" checked={p.showTime} onChange={(e) => setP({ ...p, showTime: e.target.checked })} />
        </div>
      </fieldset>
      <fieldset><legend>Financial Period Columns</legend>
        <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Periods starting from</label><input type="date" value={p.finPeriodFrom ?? ''} onChange={(e) => setP({ ...p, finPeriodFrom: e.target.value || undefined })} />
          <label>to</label><input type="date" value={p.finPeriodTo ?? ''} onChange={(e) => setP({ ...p, finPeriodTo: e.target.value || undefined })} />
        </div>
        <p className="muted">The Financial Period Value columns of these periods (past-period actuals, earned and planned value) are offered in View &gt; Columns.</p>
      </fieldset>
    </Dialog>
  );
}

export function AboutDialog() {
  return (
    <Dialog title="About" width={460} buttons={<button className="btn primary" onClick={closeDialog}>OK</button>}>
      <h3 style={{ marginTop: 0 }}>P6 Clone</h3>
      <p>A local, open re-implementation of a Primavera P6 Professional-style scheduler for testing XER / P6 XML files produced by scheduling agents.</p>
      <p className="muted">Not affiliated with Oracle. Primavera is a trademark of Oracle Corporation.</p>
    </Dialog>
  );
}

/** Tools > Validate XER File: diagnostics without importing. */
export async function validateFileTool(): Promise<void> {
  const f = await window.p6.openFile([{ name: 'XER / P6 XML', extensions: ['xer', 'xml'] }, { name: 'All Files', extensions: ['*'] }], 'Validate File');
  if (!f) return;
  const parsed = parseFile(f.name, f.bytes);
  setUi({ importLog: { file: f.path, findings: parsed.findings } });
}
