// Activity Details tabs P6 has besides the basics: Steps (TASKPROC, with weighted physical % complete when the project
// says "Activity percent complete based on activity steps"), Feedback (TASKFDBK), WPs & Docs (DOCUMENT / TASKDOC)
// and Risks (TASKRISK links to the risk register).
import { useState } from 'react';
import { getDb, mutate, toast, useStore } from '../store.ts';
import { addField, rows, table, type Db, type Row } from '../../core/db.ts';
import { STEP_FIELDS, stepsPercent, syncFromSteps } from '../../core/project/steps.ts';
export { stepsPercent };
import { linkActivity, unlinkActivity, risksOf } from '../../core/risk/register.ts';

const DOC_FIELDS = ['doc_id', 'doc_seq_num', 'deliv_flag', 'doc_name', 'parent_doc_id', 'proj_id', 'doc_short_name', 'version_name', 'author_name', 'private_loc', 'public_loc'];
const TASKDOC_FIELDS = ['taskdoc_id', 'doc_id', 'proj_id', 'wbs_id', 'task_id', 'wp_flag', 'task_wp_flag'];
const ensure = (d: Db, t: string, fs: string[]) => { const T = table(d, t); for (const f of fs) addField(T, f); return T; };
const nextNum = (d: Db, t: string, k: string) => String(Math.max(0, ...rows(d, t).map((r) => Number(r[k]) || 0)) + 1);

export function StepsTab({ t }: { t: Row }) {
  useStore((s) => s.dbVersion);
  const db = getDb();
  const steps = rows(db, 'TASKPROC').filter((s) => s.task_id === t.task_id).sort((a, b) => Number(a.seq_num) - Number(b.seq_num));
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === t.proj_id);
  const [sel, setSel] = useState<string | null>(null);
  const edit = (id: string, patch: Partial<Row>, label = 'Edit Step') => mutate(label, (d) => { const s = rows(d, 'TASKPROC').find((x) => x.proc_id === id); if (s) Object.assign(s, patch); syncFromSteps(d, t.task_id); });
  const add = () => mutate('Add Step', (d) => {
    const T = ensure(d, 'TASKPROC', STEP_FIELDS);
    const id = nextNum(d, 'TASKPROC', 'proc_id');
    T.rows.push({ proc_id: id, task_id: t.task_id, proj_id: t.proj_id, seq_num: String((Math.max(0, ...steps.map((s) => Number(s.seq_num) || 0))) + 10), proc_name: 'New Step', complete_flag: 'N', proc_wt: '1', complete_pct: '0', proc_descr: '' });
    syncFromSteps(d, t.task_id); setSel(id);
  });
  const del = () => sel && mutate('Delete Step', (d) => { table(d, 'TASKPROC').rows = rows(d, 'TASKPROC').filter((x) => x.proc_id !== sel); syncFromSteps(d, t.task_id); setSel(null); });
  const move = (dir: number) => {
    const i = steps.findIndex((s) => s.proc_id === sel), j = i + dir;
    if (i < 0 || j < 0 || j >= steps.length) return;
    mutate('Move Step', (d) => { const a = rows(d, 'TASKPROC').find((x) => x.proc_id === steps[i].proc_id)!, b = rows(d, 'TASKPROC').find((x) => x.proc_id === steps[j].proc_id)!; [a.seq_num, b.seq_num] = [b.seq_num, a.seq_num]; });
  };
  const pct = stepsPercent(steps);
  return (
    <div className="tabbody" style={{ flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
        <button className="btn" onClick={add}>Add</button><button className="btn" disabled={!sel} onClick={del}>Delete</button>
        <button className="btn" disabled={!sel} onClick={() => move(-1)}>▲</button><button className="btn" disabled={!sel} onClick={() => move(1)}>▼</button>
        <span className="muted" style={{ marginLeft: 8 }}>Steps % complete (weighted): <b>{pct == null ? '-' : `${Math.round(pct * 10) / 10}%`}</b>
          {proj?.step_complete_flag === 'Y' ? (t.complete_pct_type === 'CP_Phys' ? ' (sets the activity % complete)' : ' (the activity % complete type is not Physical)') : ''}</span>
        <label style={{ marginLeft: 'auto' }}><input type="checkbox" checked={proj?.step_complete_flag === 'Y'} onChange={(e) => mutate('Project: % complete from steps', (d) => { const p = rows(d, 'PROJECT').find((x) => x.proj_id === t.proj_id)!; addField(table(d, 'PROJECT'), 'step_complete_flag'); p.step_complete_flag = e.target.checked ? 'Y' : 'N'; syncFromSteps(d, t.task_id); })} /> Activity percent complete based on activity steps</label>
      </div>
      <table className="tbl"><thead><tr><th style={{ width: 30 }}>#</th><th>Step Name</th><th style={{ width: 70 }}>Weight</th><th style={{ width: 80 }}>% Complete</th><th style={{ width: 70 }}>Completed</th><th>Description</th></tr></thead><tbody>
        {steps.map((s, i) => <tr key={s.proc_id} className={sel === s.proc_id ? 'sel' : ''} onMouseDown={() => setSel(s.proc_id)}>
          <td>{i + 1}</td>
          <td><input style={{ width: '100%' }} defaultValue={s.proc_name} onBlur={(e) => e.target.value !== s.proc_name && (e.target.value.trim() ? edit(s.proc_id, { proc_name: e.target.value.trim() }) : toast('A step needs a name.'))} /></td>
          <td><input type="number" min={0} style={{ width: 60 }} defaultValue={s.proc_wt} onBlur={(e) => e.target.value !== s.proc_wt && Number(e.target.value) >= 0 && edit(s.proc_id, { proc_wt: String(Number(e.target.value)) })} /></td>
          <td><input type="number" min={0} max={100} style={{ width: 70 }} defaultValue={s.complete_pct || '0'} onBlur={(e) => { const v = Number(e.target.value); if (v >= 0 && v <= 100 && e.target.value !== s.complete_pct) edit(s.proc_id, { complete_pct: String(v), complete_flag: v >= 100 ? 'Y' : s.complete_flag === 'Y' && v < 100 ? 'N' : s.complete_flag }); }} /></td>
          <td style={{ textAlign: 'center' }}><input type="checkbox" checked={s.complete_flag === 'Y'} onChange={(e) => edit(s.proc_id, { complete_flag: e.target.checked ? 'Y' : 'N', complete_pct: e.target.checked ? '100' : s.complete_pct === '100' ? '0' : s.complete_pct })} /></td>
          <td><input style={{ width: '100%' }} defaultValue={s.proc_descr} onBlur={(e) => e.target.value !== s.proc_descr && edit(s.proc_id, { proc_descr: e.target.value })} /></td>
        </tr>)}
        {!steps.length && <tr><td colSpan={6} className="muted">No steps. Add steps to break the activity into weighted parts.</td></tr>}
      </tbody></table>
    </div>
  );
}

export function FeedbackTab({ t }: { t: Row }) {
  useStore((s) => s.dbVersion);
  const fb = rows(getDb(), 'TASKFDBK').find((x) => x.task_id === t.task_id);
  return (
    <div className="tabbody" style={{ flexDirection: 'column' }}>
      <p className="muted" style={{ margin: '0 0 4px' }}>Feedback from the people doing the work (in P6, entered through timesheets and Team Member).</p>
      <textarea key={t.task_id} style={{ flex: 1, minHeight: 80, font: '12px Tahoma' }} defaultValue={fb?.task_fdbk ?? ''} onBlur={(e) => {
        if (e.target.value === (fb?.task_fdbk ?? '')) return;
        mutate('Edit Feedback', (d) => { const T = ensure(d, 'TASKFDBK', ['task_id', 'proj_id', 'task_fdbk']); const r = T.rows.find((x) => x.task_id === t.task_id); if (r) r.task_fdbk = e.target.value; else T.rows.push({ task_id: t.task_id, proj_id: t.proj_id, task_fdbk: e.target.value }); });
      }} />
    </div>
  );
}

export function DocsTab({ t }: { t: Row }) {
  useStore((s) => s.dbVersion);
  const db = getDb();
  const docs = new Map(rows(db, 'DOCUMENT').map((d) => [d.doc_id, d]));
  const links = rows(db, 'TASKDOC').filter((l) => l.task_id === t.task_id);
  const available = rows(db, 'DOCUMENT').filter((d) => d.proj_id === t.proj_id && !links.some((l) => l.doc_id === d.doc_id));
  const [pick, setPick] = useState('');
  const assign = (docId: string) => mutate('Assign Document', (d) => { const T = ensure(d, 'TASKDOC', TASKDOC_FIELDS); T.rows.push({ taskdoc_id: nextNum(d, 'TASKDOC', 'taskdoc_id'), doc_id: docId, proj_id: t.proj_id, wbs_id: '', task_id: t.task_id, wp_flag: rows(d, 'DOCUMENT').find((x) => x.doc_id === docId)?.deliv_flag === 'Y' ? 'Y' : 'N', task_wp_flag: 'N' }); });
  const create = () => mutate('Add Document', (d) => {
    const D = ensure(d, 'DOCUMENT', DOC_FIELDS);
    const id = nextNum(d, 'DOCUMENT', 'doc_id');
    D.rows.push({ doc_id: id, doc_seq_num: String(D.rows.length + 1), deliv_flag: 'N', doc_name: 'New Document', parent_doc_id: '', proj_id: t.proj_id, doc_short_name: '', version_name: '', author_name: '', private_loc: '', public_loc: '' });
    const T = ensure(d, 'TASKDOC', TASKDOC_FIELDS);
    T.rows.push({ taskdoc_id: nextNum(d, 'TASKDOC', 'taskdoc_id'), doc_id: id, proj_id: t.proj_id, wbs_id: '', task_id: t.task_id, wp_flag: 'N', task_wp_flag: 'N' });
  });
  const editDoc = (id: string, patch: Partial<Row>) => mutate('Edit Document', (d) => { const x = rows(d, 'DOCUMENT').find((r) => r.doc_id === id); if (x) Object.assign(x, patch); });
  return (
    <div className="tabbody" style={{ flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <button className="btn" onClick={create}>New Document</button>
        <select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Assign an existing project document...</option>{available.map((d) => <option key={d.doc_id} value={d.doc_id}>{d.doc_short_name ? `${d.doc_short_name} - ` : ''}{d.doc_name}</option>)}</select>
        <button className="btn" disabled={!pick} onClick={() => { assign(pick); setPick(''); }}>Assign</button>
      </div>
      <table className="tbl"><thead><tr><th>Title</th><th style={{ width: 110 }}>Reference No.</th><th style={{ width: 90 }}>Work Product</th><th>File / URL</th><th style={{ width: 60 }} /></tr></thead><tbody>
        {links.map((l) => { const d = docs.get(l.doc_id); return d ? <tr key={l.taskdoc_id}>
          <td><input style={{ width: '100%' }} defaultValue={d.doc_name} onBlur={(e) => e.target.value.trim() && e.target.value !== d.doc_name && editDoc(d.doc_id, { doc_name: e.target.value.trim() })} /></td>
          <td><input style={{ width: '100%' }} defaultValue={d.doc_short_name} onBlur={(e) => e.target.value !== d.doc_short_name && editDoc(d.doc_id, { doc_short_name: e.target.value })} /></td>
          <td style={{ textAlign: 'center' }}><input type="checkbox" checked={l.wp_flag === 'Y'} onChange={(e) => mutate('Work Product', (x) => { const r = rows(x, 'TASKDOC').find((q) => q.taskdoc_id === l.taskdoc_id); if (r) r.wp_flag = e.target.checked ? 'Y' : 'N'; })} /></td>
          <td><input style={{ width: '100%' }} defaultValue={d.private_loc || d.public_loc} placeholder="path or link" onBlur={(e) => e.target.value !== (d.private_loc || d.public_loc) && editDoc(d.doc_id, { private_loc: e.target.value })} /></td>
          <td><button className="btn" onClick={() => mutate('Unassign Document', (x) => { table(x, 'TASKDOC').rows = rows(x, 'TASKDOC').filter((q) => q.taskdoc_id !== l.taskdoc_id); })}>Remove</button></td>
        </tr> : null; })}
        {!links.length && <tr><td colSpan={5} className="muted">No work products or documents assigned.</td></tr>}
      </tbody></table>
    </div>
  );
}

export function RisksTab({ t }: { t: Row }) {
  useStore((s) => s.dbVersion);
  const db = getDb();
  const all = risksOf(db, [t.proj_id]);
  const linked = new Set(rows(db, 'TASKRISK').filter((l) => l.task_id === t.task_id).map((l) => l.proj_risk_id));
  const [pick, setPick] = useState('');
  return (
    <div className="tabbody" style={{ flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Assign a risk from the project's register...</option>{all.filter((r) => !linked.has(r.proj_risk_id)).map((r) => <option key={r.proj_risk_id} value={r.proj_risk_id}>{r.risk_code} - {r.risk_name}</option>)}</select>
        <button className="btn" disabled={!pick} onClick={() => { mutate('Assign Risk', (d) => { const r = linkActivity(d, pick, t.task_id); if (typeof r === 'string') throw new Error(r); }); setPick(''); }}>Assign</button>
        {!all.length && <span className="muted">The project has no risks yet (Risks window).</span>}
      </div>
      <table className="tbl"><thead><tr><th style={{ width: 90 }}>Risk ID</th><th>Risk Name</th><th style={{ width: 90 }}>Status</th><th style={{ width: 60 }} /></tr></thead><tbody>
        {all.filter((r) => linked.has(r.proj_risk_id)).map((r) => <tr key={r.proj_risk_id}><td>{r.risk_code}</td><td>{r.risk_name}</td><td>{r.status_code}</td>
          <td><button className="btn" onClick={() => mutate('Remove Risk', (d) => unlinkActivity(d, r.proj_risk_id, t.task_id))}>Remove</button></td></tr>)}
        {!linked.size && <tr><td colSpan={4} className="muted">No risks assigned to this activity.</td></tr>}
      </tbody></table>
    </div>
  );
}
