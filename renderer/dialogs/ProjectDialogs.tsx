import { useState } from 'react';
import { Dialog, Tabs } from '../components/Layout.tsx';
import { closeDialog, getDb, mutate, openDialog, setUi, toast, useStore } from '../store.ts';
import { addField, nextId, rows, table, type Row } from '../../core/db.ts';
import { formatP6Date, parseP6Date } from '../../core/dates.ts';
import { deleteProject } from '../../core/xer/import.ts';
import { saveBaseline, assignBaseline, deleteBaseline, restoreBaseline } from '../../core/progress/baseline.ts';
import { CSTR_TYPES, DUR_TYPES, PCT_TYPES, TASK_TYPES, ensureEps, fmtDate, memoHtml, memoText, newProject, projectName } from '../model.ts';
import { openProjects } from '../views/ProjectsView.tsx';

const dt = (s: string) => (s ? s.replace(' ', 'T').slice(0, 16) : '');
const fromDt = (s: string) => (s ? formatP6Date(parseP6Date(s.replace('T', ' '))!) : '');
void CSTR_TYPES;

export function NewProjectDialog() {
  const db = getDb();
  const eps = db.tables.EPS?.rows ?? [];
  const [id, setId] = useState(`PROJ-${rows(db, 'PROJECT').length + 1}`);
  const [name, setName] = useState('New Project');
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10) + 'T08:00');
  const [epsId, setEps] = useState(eps[0]?.eps_id ?? '1');
  const create = () => {
    if (!id.trim()) return toast('Project ID is required.');
    if (rows(db, 'PROJECT').some((p) => p.proj_short_name === id.trim())) return toast(`Project ID ${id} already exists.`);
    let pid = '';
    mutate('New Project', (d) => { pid = newProject(d, { id: id.trim(), name, start: fromDt(start), epsId }); });
    closeDialog();
    openProjects([pid]);
  };
  return (
    <Dialog title="Create a New Project" width={500} buttons={<><button className="btn primary" onClick={create}>Finish</button><button className="btn" onClick={closeDialog}>Cancel</button></>}>
      <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
        <label>EPS</label><select value={epsId} onChange={(e) => setEps(e.target.value)}>{(eps.length ? eps : [{ eps_id: '1', eps_short_name: 'Enterprise', eps_name: 'All Initiatives' }]).map((e) => <option key={e.eps_id} value={e.eps_id}>{e.eps_short_name} - {e.eps_name}</option>)}</select>
        <label>Project ID</label><input value={id} onChange={(e) => setId(e.target.value)} />
        <label>Project Name</label><input value={name} onChange={(e) => setName(e.target.value)} />
        <label>Planned Start</label><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
    </Dialog>
  );
}

export function ProjectDetailsDialog(props: { projId?: string }) {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const pid = props.projId ?? ui.selProject ?? ui.openProjects[0];
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === pid);
  const [tab, setTab] = useState('general');
  if (!p) return <Dialog title="Project Details" buttons={<button className="btn" onClick={closeDialog}>Close</button>}><p>No project selected.</p></Dialog>;
  const root = rows(db, 'PROJWBS').find((w) => w.proj_id === pid && w.proj_node_flag === 'Y');
  const set = (field: string, v: string, label = 'Edit Project') => mutate(label, (d) => {
    const r = d.tables.PROJECT.rows.find((x) => x.proj_id === pid)!;
    if (!d.tables.PROJECT.fields.includes(field)) d.tables.PROJECT.fields.push(field);
    r[field] = v;
  });
  const flag = (field: string, label: string) => <label style={{ display: 'block', margin: '3px 0' }}><input type="checkbox" checked={p[field] === 'Y'} onChange={(e) => set(field, e.target.checked ? 'Y' : 'N')} /> {label}</label>;
  const cals = rows(db, 'CALENDAR').filter((c) => !c.proj_id || c.proj_id === pid).filter((c) => c.clndr_type !== 'CA_Rsrc');
  const eps = db.tables.EPS?.rows ?? [];
  return (
    <Dialog title={`Project Details - ${p.proj_short_name}`} width={720} height={430} buttons={<button className="btn" onClick={closeDialog}>Close</button>}>
      <Tabs tabs={[['general', 'General'], ['notebook', 'Notebook'], ['dates', 'Dates'], ['defaults', 'Defaults'], ['settings', 'Settings'], ['calculations', 'Calculations'], ['codes', 'Codes'], ['udfs', 'UDFs']]} value={tab} onChange={setTab} />
      <div style={{ padding: 10, border: '1px solid #a0a0a0', borderTop: 'none', background: '#f0f0f0' }}>
        {tab === 'general' && <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Project ID</label><input defaultValue={p.proj_short_name} onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v || v === p.proj_short_name) return;
            if (rows(db, 'PROJECT').some((x) => x.proj_id !== pid && x.proj_short_name === v)) return toast('Project ID already exists.');
            mutate('Rename Project', (d) => { d.tables.PROJECT.rows.find((x) => x.proj_id === pid)!.proj_short_name = v; const w = d.tables.PROJWBS.rows.find((x) => x.proj_id === pid && x.proj_node_flag === 'Y'); if (w) w.wbs_short_name = v; });
          }} />
          <label>Project Name</label><input defaultValue={projectName(db, p)} onBlur={(e) => mutate('Rename Project', (d) => { const w = d.tables.PROJWBS.rows.find((x) => x.proj_id === pid && x.proj_node_flag === 'Y'); if (w) w.wbs_name = e.target.value; else d.tables.PROJECT.rows.find((x) => x.proj_id === pid)!._name = e.target.value; })} />
          <label>EPS</label><select value={p._eps_id || eps[0]?.eps_id} onChange={(e) => set('_eps_id', e.target.value, 'Move Project')}>{eps.map((e) => <option key={e.eps_id} value={e.eps_id}>{e.eps_short_name} - {e.eps_name}</option>)}</select>
          <label>Status</label><select value={root?.status_code || 'WS_Open'} onChange={(e) => mutate('Project Status', (d) => { const w = d.tables.PROJWBS.rows.find((x) => x.proj_id === pid && x.proj_node_flag === 'Y'); if (w) w.status_code = e.target.value; })}><option value="WS_Planned">Planned</option><option value="WS_Open">Active</option><option value="WS_Closed">Inactive</option><option value="WS_Whatif">What-If</option></select>
          <label>Internal ID</label><input readOnly value={p.proj_id} />
        </div>}
        {tab === 'dates' && <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Project Planned Start</label><input type="datetime-local" value={dt(p.plan_start_date)} onChange={(e) => set('plan_start_date', fromDt(e.target.value))} />
          <label>Must Finish By</label><input type="datetime-local" value={dt(p.plan_end_date)} onChange={(e) => set('plan_end_date', fromDt(e.target.value))} />
          <label>Data Date</label><input type="datetime-local" value={dt(p.last_recalc_date)} onChange={(e) => set('last_recalc_date', fromDt(e.target.value))} />
          <label>Scheduled Finish</label><input readOnly value={fmtDate(p.scd_end_date, ui.prefs, true)} />
        </div>}
        {tab === 'defaults' && <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Duration Type</label><select value={p.def_duration_type || 'DT_FixedDUR2'} onChange={(e) => set('def_duration_type', e.target.value)}>{Object.entries(DUR_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <label>Percent Complete Type</label><select value={p.def_complete_pct_type || 'CP_Drtn'} onChange={(e) => set('def_complete_pct_type', e.target.value)}>{Object.entries(PCT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <label>Activity Type</label><select value={p.def_task_type || 'TT_Task'} onChange={(e) => set('def_task_type', e.target.value)}>{Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <label>Calendar</label><select value={p.clndr_id} onChange={(e) => set('clndr_id', e.target.value)}>{cals.map((c) => <option key={c.clndr_id} value={c.clndr_id}>{c.clndr_name}</option>)}</select>
          <label>Activity ID Prefix</label><input defaultValue={p.task_code_prefix} onBlur={(e) => set('task_code_prefix', e.target.value)} />
          <label>Activity ID Suffix</label><input type="number" defaultValue={p.task_code_base} onBlur={(e) => set('task_code_base', e.target.value)} />
          <label>Increment</label><input type="number" defaultValue={p.task_code_step} onBlur={(e) => set('task_code_step', e.target.value)} />
        </div>}
        {tab === 'settings' && <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Define critical activities as</label>
          <select value={p.critical_path_type || 'CT_TotFloat'} onChange={(e) => set('critical_path_type', e.target.value)}><option value="CT_TotFloat">Total Float less than or equal to</option><option value="CT_DrivPath">Longest Path</option></select>
          <label>Critical float (hours)</label><input type="number" defaultValue={p.critical_drtn_hr_cnt || '0'} onBlur={(e) => set('critical_drtn_hr_cnt', e.target.value)} />
          <label>Financial period calendar</label>
          <select value={p.fintmpl_id || ''} onChange={(e) => set('fintmpl_id', e.target.value, 'Assign Financial Period Calendar')}><option value="">(the default calendar)</option>{rows(db, 'FINTMPL').map((c) => <option key={c.fintmpl_id} value={c.fintmpl_id}>{c.fintmpl_name}{c.default_flag === 'Y' ? ' (default)' : ''}</option>)}</select>
        </div>}
        {tab === 'notebook' && root && <ProjectNotebook pid={pid} wbsId={root.wbs_id} />}
        {tab === 'codes' && <ProjectCodes pid={pid} />}
        {tab === 'udfs' && <ProjectUdfs pid={pid} />}
        {tab === 'calculations' && <div>
          <fieldset><legend>Activities</legend>
            <div className="form" style={{ gridTemplateColumns: 'auto 120px' }}>
              <label>Default Price / Unit for activities without resource or role Price / Units</label><input type="number" min={0} defaultValue={p.def_cost_per_qty || '0'} onBlur={(e) => Number(e.target.value) >= 0 && set('def_cost_per_qty', String(Number(e.target.value)))} />
            </div>
            {flag('step_complete_flag', 'Activity percent complete based on activity steps')}
            {flag('act_this_per_link_flag', 'Link actual to date and actual this period units and costs')}
            {flag('act_pct_link_flag', 'Link percent complete with actuals')}
            {flag('reset_planned_flag', 'Reset Original Duration and Units to Remaining')}
          </fieldset>
          <fieldset><legend>Resource Assignments</legend>
            <div style={{ marginBottom: 4 }}>When updating actual units or costs:{' '}
              <label style={{ marginRight: 10 }}><input type="radio" name="actrem" checked={p.add_act_remain_flag === 'Y'} onChange={() => set('add_act_remain_flag', 'Y')} /> Add Actual to Remaining</label>
              <label><input type="radio" name="actrem" checked={p.add_act_remain_flag !== 'Y'} onChange={() => set('add_act_remain_flag', 'N')} /> Subtract Actual from At Completion</label></div>
            {flag('cost_qty_recalc_flag', 'Recalculate Actual Units and Cost when duration % complete changes')}
            {flag('rem_target_link_flag', 'Link Budget and At Completion for not started activities')}
          </fieldset>
          <p className="muted">Stored in the project's P6 fields (def_cost_per_qty, step_complete_flag, act_this_per_link_flag, act_pct_link_flag, reset_planned_flag, add_act_remain_flag, cost_qty_recalc_flag, rem_target_link_flag), so they travel with XER and P6 XML.</p>
        </div>}
      </div>
    </Dialog>
  );
}

/** Project notebook: P6 keeps project notebook topics as WBSMEMO rows on the project's root WBS node. */
function ProjectNotebook({ pid, wbsId }: { pid: string; wbsId: string }) {
  const db = getDb();
  const types = rows(db, 'MEMOTYPE');
  const memos = rows(db, 'WBSMEMO').filter((m) => m.wbs_id === wbsId);
  const [sel, setSel] = useState<string | null>(memos[0]?.wbs_memo_id ?? null);
  const cur = memos.find((m) => m.wbs_memo_id === sel);
  const free = types.filter((x) => x.proj_flag === 'Y' && !memos.some((m) => m.memo_type_id === x.memo_type_id));
  return (
    <div style={{ display: 'flex', gap: 8, height: 300 }}>
      <div style={{ width: 200, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="tblwrap" style={{ flex: 1, background: '#fff' }}>
          <table className="tbl"><thead><tr><th>Notebook Topic</th></tr></thead><tbody>
            {memos.map((m) => <tr key={m.wbs_memo_id} className={sel === m.wbs_memo_id ? 'sel' : ''} onMouseDown={() => setSel(m.wbs_memo_id)}><td>{types.find((x) => x.memo_type_id === m.memo_type_id)?.memo_type ?? `Topic ${m.memo_type_id}`}</td></tr>)}
          </tbody></table>
        </div>
        <button className="btn" disabled={!free.length} title={free.length ? '' : 'No unused notebook topic for projects in the database (MEMOTYPE with proj_flag Y)'} onClick={() => mutate('Add Project Notebook Topic', (d) => {
          const WM = table(d, 'WBSMEMO');
          for (const f of ['wbs_memo_id', 'proj_id', 'memo_type_id', 'wbs_id', 'wbs_memo']) addField(WM, f);
          const id = String(nextId(d, 'WBSMEMO'));
          WM.rows.push({ wbs_memo_id: id, proj_id: pid, memo_type_id: free[0].memo_type_id, wbs_id: wbsId, wbs_memo: '' });
          setSel(id);
        })}>Add</button>
      </div>
      {cur ? <textarea style={{ flex: 1, font: '11px Tahoma', border: '1px solid #7f9db9' }} key={cur.wbs_memo_id} defaultValue={memoText(cur.wbs_memo)}
        onBlur={(e) => { const html = memoHtml(e.target.value); if (memoText(html) !== memoText(cur.wbs_memo)) mutate('Edit Project Notebook', (d) => { d.tables.WBSMEMO.rows.find((m) => m.wbs_memo_id === cur.wbs_memo_id)!.wbs_memo = html; }); }} />
        : <div className="muted">No notebook topics.</div>}
    </div>
  );
}

/** Project UDFs (UDFTYPE with subject area Project; values in UDFVALUE keyed by the project). */
function ProjectUdfs({ pid }: { pid: string }) {
  const db = getDb();
  const types = rows(db, 'UDFTYPE').filter((u) => u.table_name === 'PROJECT');
  const vals = rows(db, 'UDFVALUE').filter((v) => v.fk_id === pid);
  const fieldOf = (t: string) => (/DATE/.test(t) ? 'udf_date' : /INT|FLOAT|MONEY|NUM/.test(t) ? 'udf_number' : 'udf_text');
  const setVal = (ty: Row, v: string) => mutate('Edit Project UDF', (d) => {
    const T = table(d, 'UDFVALUE'); for (const f of ['udf_type_id', 'fk_id', 'proj_id', 'udf_date', 'udf_number', 'udf_text', 'udf_code_id']) addField(T, f);
    const f = fieldOf(ty.logical_data_type);
    T.rows = T.rows.filter((x) => !(x.udf_type_id === ty.udf_type_id && x.fk_id === pid));
    if (v !== '') T.rows.push({ udf_type_id: ty.udf_type_id, fk_id: pid, proj_id: pid, udf_date: '', udf_number: '', udf_text: '', udf_code_id: '', [f]: f === 'udf_date' ? fromDt(v) : v });
  });
  if (!types.length) return <div className="muted">No project UDFs. Create them in Enterprise &gt; User Defined Fields (subject area Projects).</div>;
  return (
    <table className="tbl" style={{ background: '#fff' }}><thead><tr><th>User Defined Field</th><th>Type</th><th>Value</th></tr></thead><tbody>
      {types.map((ty) => { const f = fieldOf(ty.logical_data_type), cur = vals.find((v) => v.udf_type_id === ty.udf_type_id)?.[f] ?? '';
        return <tr key={ty.udf_type_id}><td>{ty.udf_type_label}</td><td>{(ty.logical_data_type || '').replace(/^FT_/, '')}</td>
          <td>{f === 'udf_date' ? <input type="datetime-local" defaultValue={dt(cur)} onBlur={(e) => e.target.value !== dt(cur) && setVal(ty, e.target.value)} /> : <input type={f === 'udf_number' ? 'number' : 'text'} defaultValue={cur} onBlur={(e) => e.target.value !== cur && setVal(ty, e.target.value)} />}</td></tr>; })}
    </tbody></table>
  );
}

/** Project codes (PCATTYPE / PCATVAL, assigned in PROJPCAT). */
function ProjectCodes({ pid }: { pid: string }) {
  const db = getDb();
  const types = rows(db, 'PCATTYPE'), vals = rows(db, 'PCATVAL'), assigned = rows(db, 'PROJPCAT').filter((a) => a.proj_id === pid);
  const setCode = (typeId: string, valId: string) => mutate('Assign Project Code', (d) => {
    const PA = table(d, 'PROJPCAT');
    for (const f of ['proj_id', 'proj_catg_type_id', 'proj_catg_id']) addField(PA, f);
    PA.rows = PA.rows.filter((a) => !(a.proj_id === pid && a.proj_catg_type_id === typeId));
    if (valId) PA.rows.push({ proj_id: pid, proj_catg_type_id: typeId, proj_catg_id: valId });
  });
  if (!types.length) return <div className="muted">No project code types in the database.</div>;
  return (
    <table className="tbl" style={{ background: '#fff' }}>
      <thead><tr><th>Project Code</th><th>Code Value</th><th>Description</th></tr></thead>
      <tbody>
        {types.map((ty) => {
          const cur = assigned.find((a) => a.proj_catg_type_id === ty.proj_catg_type_id);
          const mine = vals.filter((v) => v.proj_catg_type_id === ty.proj_catg_type_id);
          return (
            <tr key={ty.proj_catg_type_id}>
              <td>{ty.proj_catg_type}</td>
              <td><select value={cur?.proj_catg_id ?? ''} onChange={(e) => setCode(ty.proj_catg_type_id, e.target.value)}>
                <option value="" />{mine.map((v) => <option key={v.proj_catg_id} value={v.proj_catg_id}>{v.proj_catg_short_name}</option>)}</select></td>
              <td>{mine.find((v) => v.proj_catg_id === cur?.proj_catg_id)?.proj_catg_name ?? (cur ? `(missing value ${cur.proj_catg_id})` : '')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DeleteProjectDialog(props: { projId: string }) {
  const db = getDb();
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === props.projId);
  const n = rows(db, 'TASK').filter((t) => t.proj_id === props.projId).length;
  return (
    <Dialog title="Confirm" width={420} buttons={<>
      <button className="btn" onClick={() => {
        mutate(`Delete Project ${p?.proj_short_name}`, (d) => {
          for (const b of rows(d, 'PROJECT').filter((x) => x._baseline_of === props.projId)) deleteProject(d, b.proj_id);
          deleteProject(d, props.projId);
        });
        setUi((u) => ({ openProjects: u.openProjects.filter((x) => x !== props.projId), selProject: undefined }));
        closeDialog();
      }}>Yes</button>
      <button className="btn primary" onClick={closeDialog}>No</button>
    </>}>
      <p>Delete project <b>{p?.proj_short_name}</b> and its {n} activities? (Edit &gt; Undo can restore it.)</p>
    </Dialog>
  );
}

/** Project > Assign Baselines: which saved baseline is the project baseline (P6 also has user baselines). */
export function AssignBaselinesDialog(props: { projId?: string }) {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const pid = props.projId ?? ui.openProjects[0] ?? ui.selProject;
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === pid);
  const [sel, setSel] = useState(p?.sum_base_proj_id ?? '');
  if (!p) return <Dialog title="Assign Baselines" buttons={<button className="btn" onClick={closeDialog}>Close</button>}><p>Open a project first.</p></Dialog>;
  const bls = rows(db, 'PROJECT').filter((x) => x._baseline_of === pid);
  return (
    <Dialog title="Assign Baselines" width={520} height={240} buttons={<>
      <button className="btn primary" onClick={() => { mutate('Assign Baseline', (d) => assignBaseline(d, pid!, sel)); closeDialog(); }}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
      <button className="btn" onClick={() => openDialog('baselines', { projId: pid })}>Maintain Baselines...</button>
    </>}>
      <p>Project: <b>{p.proj_short_name}</b></p>
      <label style={{ display: 'block', margin: '8px 0' }}>Project Baseline{' '}
        <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ minWidth: 300 }}>
          <option value="">&lt;Current Project&gt;</option>
          {bls.map((b) => <option key={b.proj_id} value={b.proj_id}>{b.proj_short_name}</option>)}
        </select>
      </label>
      {!bls.length && <p className="muted">The project has no saved baselines yet. Use Maintain Baselines to add one.</p>}
    </Dialog>
  );
}

export function BaselinesDialog(props: { projId?: string }) {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const pid = props.projId ?? ui.openProjects[0] ?? ui.selProject;
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === pid);
  const [sel, setSel] = useState<string | null>(null);
  if (!p) return <Dialog title="Maintain Baselines" buttons={<button className="btn" onClick={closeDialog}>Close</button>}><p>Open a project first.</p></Dialog>;
  const bls = rows(db, 'PROJECT').filter((x) => x._baseline_of === pid);
  return (
    <Dialog title="Maintain Baselines" width={640} height={380} buttons={<>
      <button className="btn" onClick={() => mutate('Add Baseline', (d) => { const id = saveBaseline(d, pid); if (!rows(d, 'PROJECT').find((x) => x.proj_id === pid)!.sum_base_proj_id) assignBaseline(d, pid, id); })}>Add</button>
      <button className="btn" disabled={!sel} onClick={() => sel && mutate('Assign Baseline', (d) => assignBaseline(d, pid, sel))}>Assign as Project Baseline</button>
      <button className="btn" disabled={!sel} onClick={() => sel && mutate('Restore Baseline', (d) => restoreBaseline(d, sel))}>Restore</button>
      <button className="btn" disabled={!sel} onClick={async () => { if (sel && (await window.p6.confirm('Delete the selected baseline?', 'The baseline copy of the project is removed from the database.'))) { mutate('Delete Baseline', (d) => deleteBaseline(d, sel)); setSel(null); } }}>Delete</button>
      <button className="btn" onClick={closeDialog}>Close</button>
    </>}>
      <p>Project: <b>{p.proj_short_name}</b> · Project baseline: <b>{bls.find((b) => b.proj_id === p.sum_base_proj_id)?.proj_short_name ?? '(none: current project)'}</b></p>
      <div className="tblwrap" style={{ height: 250 }}>
        <table className="tbl"><thead><tr><th>Baseline</th><th>Saved</th><th>Activities</th><th>Data Date</th></tr></thead><tbody>
          {bls.map((b) => <tr key={b.proj_id} className={sel === b.proj_id ? 'sel' : ''} onMouseDown={() => setSel(b.proj_id)}><td>{b.proj_short_name}{p.sum_base_proj_id === b.proj_id ? ' (Project Baseline)' : ''}</td><td>{fmtDate(b._baseline_date, ui.prefs, true)}</td><td>{rows(db, 'TASK').filter((t) => t.proj_id === b.proj_id).length}</td><td>{fmtDate(b.last_recalc_date, ui.prefs)}</td></tr>)}
          {!bls.length && <tr><td colSpan={4} className="muted">No baselines. Click Add to save a copy of the current schedule.</td></tr>}
        </tbody></table>
      </div>
      <p className="muted">Baselines appear as yellow bars in the Gantt chart and in the BL Project Start/Finish columns.</p>
    </Dialog>
  );
}

export function EpsDialog() {
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const eps = db.tables.EPS?.rows ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const depth = (e: (typeof eps)[number]): number => { let d = 0; for (let p = eps.find((x) => x.eps_id === e.parent_eps_id); p && d < 20; p = eps.find((x) => x.eps_id === p!.parent_eps_id)) d++; return d; };
  const ordered: typeof eps = [];
  const visit = (parent: string) => { for (const e of eps.filter((x) => x.parent_eps_id === parent)) { ordered.push(e); visit(e.eps_id); } };
  visit('');
  const edit = (id: string, f: string, v: string) => mutate('Edit EPS', (d) => { d.tables.EPS.rows.find((x) => x.eps_id === id)![f] = v; });
  return (
    <Dialog title="Enterprise Project Structure" width={640} height={420} buttons={<>
      <button className="btn" onClick={() => mutate('Add EPS', (d) => { ensureEps(d); const E = d.tables.EPS; const id = String(Math.max(...E.rows.map((r) => Number(r.eps_id))) + 1); E.rows.push({ eps_id: id, parent_eps_id: sel ?? E.rows[0].eps_id, eps_short_name: `EPS${id}`, eps_name: 'New EPS Node', seq_num: id }); })}>Add</button>
      <button className="btn" disabled={!sel} onClick={() => {
        if (!sel) return;
        const hasKids = eps.some((e) => e.parent_eps_id === sel) || rows(db, 'PROJECT').some((p) => p._eps_id === sel);
        if (hasKids) return toast('Move or delete the projects and EPS nodes under this node first.');
        if (!eps.find((e) => e.eps_id === sel)?.parent_eps_id) return toast('The root EPS node cannot be deleted.');
        mutate('Delete EPS', (d) => { d.tables.EPS.rows = d.tables.EPS.rows.filter((e) => e.eps_id !== sel); });
        setSel(null);
      }}>Delete</button>
      <button className="btn" onClick={closeDialog}>Close</button>
    </>}>
      <div className="tblwrap" style={{ height: 330 }}>
        <table className="tbl"><thead><tr><th>EPS ID</th><th>EPS Name</th><th>Parent</th></tr></thead><tbody>
          {ordered.map((e) => <tr key={e.eps_id} className={sel === e.eps_id ? 'sel' : ''} onMouseDown={() => setSel(e.eps_id)}>
            <td style={{ paddingLeft: 4 + depth(e) * 14 }}><input defaultValue={e.eps_short_name} onBlur={(x) => x.target.value !== e.eps_short_name && edit(e.eps_id, 'eps_short_name', x.target.value)} /></td>
            <td><input defaultValue={e.eps_name} onBlur={(x) => x.target.value !== e.eps_name && edit(e.eps_id, 'eps_name', x.target.value)} /></td>
            <td><select value={e.parent_eps_id} disabled={!e.parent_eps_id} onChange={(x) => x.target.value !== e.eps_id && edit(e.eps_id, 'parent_eps_id', x.target.value)}>{eps.filter((o) => o.eps_id !== e.eps_id).map((o) => <option key={o.eps_id} value={o.eps_id}>{o.eps_short_name}</option>)}{!e.parent_eps_id && <option value="">(root)</option>}</select></td>
          </tr>)}
        </tbody></table>
      </div>
    </Dialog>
  );
}
