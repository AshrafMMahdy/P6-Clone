import { useState, type ReactNode } from 'react';
import { Tabs } from '../components/Layout.tsx';
import { getDb, mutate, openDialog, setUi, toast, useStore } from '../store.ts';
import { useCtx } from '../hooks.ts';
import { CSTR_TYPES, DUR_TYPES, PCT_TYPES, REL_TYPES, RSRC_TYPES, TASK_TYPES, activityPct, daysToHours, fmtDate, fmtDur, isCritical, isMilestone, setActual, setPercent, statusOf, STATUS, wbsPath, type Ctx } from '../model.ts';
import { addField, nextId, rows, table, type Row } from '../../core/db.ts';
import { formatP6Date, parseP6Date } from '../../core/dates.ts';
import { p6num } from '../../core/schedule/cpm.ts';
import { durationPct } from '../../core/progress/update.ts';
import { recalcAssignment, priceOf } from '../../core/resource/assign.ts';

const TABS: [string, string][] = [['general', 'General'], ['status', 'Status'], ['resources', 'Resources'], ['relationships', 'Relationships'], ['preds', 'Predecessors'], ['succs', 'Successors'], ['codes', 'Codes'], ['notebook', 'Notebook'], ['expenses', 'Expenses'], ['summary', 'Summary']];

export function updateTask(taskId: string, label: string, fn: (r: Row, db: ReturnType<typeof getDb>) => string | void): void {
  const t = rows(getDb(), 'TASK').find((x) => x.task_id === taskId);
  if (!t) return;
  const copy = { ...t };
  const err = fn(copy, getDb());
  if (err) { toast(err); return; }
  mutate(label, (db) => {
    const r = db.tables.TASK.rows.find((x) => x.task_id === taskId)!;
    Object.assign(r, copy, { update_date: formatP6Date(Date.now() / 60000) });
  });
}

const dt = (s: string) => (s ? s.replace(' ', 'T').slice(0, 16) : '');
const fromDt = (s: string) => (s ? formatP6Date(parseP6Date(s.replace('T', ' '))!) : '');

export function ActivityDetails() {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const t = ui.selTask ? ctx.taskById.get(ui.selTask) : undefined;
  return (
    <div className="details">
      <Tabs tabs={TABS} value={ui.detailTab} onChange={(id) => setUi({ detailTab: id })} />
      {!t ? <div className="tabbody muted">Select an activity to see its details.</div> : (
        <>
          <div style={{ padding: '3px 10px', background: '#e8e8e8', borderBottom: '1px solid #ccc' }}>
            <b>Activity</b> {t.task_code} &nbsp; {t.task_name} &nbsp; <span className="muted">Project {ctx.proj.get(t.proj_id)?.proj_short_name}</span>
          </div>
          <TabBody tab={ui.detailTab} t={t} ctx={ctx} />
        </>
      )}
    </div>
  );
}

function TabBody({ tab, t, ctx }: { tab: string; t: Row; ctx: Ctx }) {
  switch (tab) {
    case 'general': return <General t={t} ctx={ctx} />;
    case 'status': return <Status t={t} ctx={ctx} />;
    case 'resources': return <Resources t={t} ctx={ctx} />;
    case 'relationships': return <div className="tabbody flush" style={{ flexDirection: 'row' }}><Rels t={t} ctx={ctx} which="pred" /><Rels t={t} ctx={ctx} which="succ" /></div>;
    case 'preds': return <div className="tabbody flush"><Rels t={t} ctx={ctx} which="pred" /></div>;
    case 'succs': return <div className="tabbody flush"><Rels t={t} ctx={ctx} which="succ" /></div>;
    case 'codes': return <Codes t={t} ctx={ctx} />;
    case 'notebook': return <Notebook t={t} />;
    case 'expenses': return <Expenses t={t} ctx={ctx} />;
    default: return <Summary t={t} ctx={ctx} />;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <><label>{label}</label>{children}</>;
}

function General({ t, ctx }: { t: Row; ctx: Ctx }) {
  const wbsOpts = [...ctx.wbs.values()].filter((w) => w.proj_id === t.proj_id);
  const cals = [...ctx.cal.values()].filter((c) => !c.proj_id || c.proj_id === t.proj_id).filter((c) => c.clndr_type !== 'CA_Rsrc');
  return (
    <div className="tabbody">
      <div className="form">
        <Field label="Activity ID"><input defaultValue={t.task_code} key={t.task_id + t.task_code} onBlur={(e) => e.target.value !== t.task_code && updateTask(t.task_id, 'Edit Activity ID', (r, db) => {
          const v = e.target.value.trim();
          if (!v) return 'Activity ID cannot be blank.';
          if (rows(db, 'TASK').some((x) => x.task_id !== r.task_id && x.proj_id === r.proj_id && x.task_code === v)) return `Activity ID ${v} already exists.`;
          r.task_code = v;
        })} /></Field>
        <Field label="Activity Name"><input defaultValue={t.task_name} key={t.task_id + t.task_name} onBlur={(e) => e.target.value !== t.task_name && updateTask(t.task_id, 'Edit Activity Name', (r) => { r.task_name = e.target.value; })} /></Field>
        <Field label="Project"><input readOnly value={ctx.proj.get(t.proj_id)?.proj_short_name ?? ''} /></Field>
        <Field label="WBS"><select value={t.wbs_id} onChange={(e) => updateTask(t.task_id, 'Change WBS', (r) => { r.wbs_id = e.target.value; })}>
          {wbsOpts.map((w) => <option key={w.wbs_id} value={w.wbs_id}>{wbsPath(w.wbs_id, ctx)} {w.proj_node_flag === 'Y' ? '' : w.wbs_name}</option>)}
        </select></Field>
        <Field label="Activity Type"><select value={t.task_type} onChange={(e) => updateTask(t.task_id, 'Change Activity Type', (r) => { r.task_type = e.target.value; if (isMilestone(r)) { r.target_drtn_hr_cnt = '0'; r.remain_drtn_hr_cnt = '0'; } })}>
          {Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Duration Type"><select value={t.duration_type} onChange={(e) => updateTask(t.task_id, 'Change Duration Type', (r) => { r.duration_type = e.target.value; })}>
          {Object.entries(DUR_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="% Complete Type"><select value={t.complete_pct_type} onChange={(e) => updateTask(t.task_id, 'Change % Complete Type', (r) => { r.complete_pct_type = e.target.value; })}>
          {Object.entries(PCT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Calendar"><select value={t.clndr_id} onChange={(e) => updateTask(t.task_id, 'Change Calendar', (r) => { r.clndr_id = e.target.value; })}>
          {!ctx.cal.has(t.clndr_id) && <option value={t.clndr_id}>(missing calendar {t.clndr_id})</option>}
          {cals.map((c) => <option key={c.clndr_id} value={c.clndr_id}>{c.clndr_name}{c.proj_id ? ' (project)' : ''}</option>)}</select></Field>
        <Field label="Priority"><select value={t.priority_type || 'PT_Normal'} onChange={(e) => updateTask(t.task_id, 'Change Priority', (r) => { r.priority_type = e.target.value; })}>
          {['PT_Top', 'PT_High', 'PT_Normal', 'PT_Low', 'PT_Lowest'].map((k) => <option key={k} value={k}>{k.slice(3)}</option>)}</select></Field>
        <Field label="Primary Resource"><select value={t.rsrc_id || ''} onChange={(e) => updateTask(t.task_id, 'Change Primary Resource', (r) => { r.rsrc_id = e.target.value; })}>
          <option value="">&lt;None&gt;</option>
          {(ctx.rsrcByTask.get(t.task_id) ?? []).map((a) => <option key={a.rsrc_id} value={a.rsrc_id}>{ctx.rsrc.get(a.rsrc_id)?.rsrc_name}</option>)}</select></Field>
      </div>
    </div>
  );
}

function Status({ t, ctx }: { t: Row; ctx: Ctx }) {
  const p = ctx.prefs;
  const st = statusOf(t);
  const dd = ctx.proj.get(t.proj_id)?.last_recalc_date ?? '';
  const durInput = (field: 'target_drtn_hr_cnt' | 'remain_drtn_hr_cnt', label: string, disabled = false) => (
    <Field label={label}><input type="number" step="0.5" disabled={disabled || (field === 'remain_drtn_hr_cnt' && st === 'TK_Complete')} defaultValue={fmtDur(t[field], p)} key={t.task_id + field + t[field]}
      onBlur={(e) => {
        const h = daysToHours(Number(e.target.value), p);
        if (p6num(h) === t[field]) return;
        updateTask(t.task_id, `Edit ${label}`, (r) => {
          if (!(h >= 0)) return 'Duration must be zero or greater.';
          if (isMilestone(r) && h > 0) return 'Milestones have zero duration.';
          r[field] = p6num(h);
          if (st === 'TK_NotStart') { r.target_drtn_hr_cnt = p6num(h); r.remain_drtn_hr_cnt = p6num(h); }
        });
      }} /></Field>
  );
  return (
    <div className="tabbody">
      <div className="row">
        <fieldset style={{ width: 230 }}><legend>Duration</legend>
          <div className="form" style={{ gridTemplateColumns: 'auto 70px' }}>
            {durInput('target_drtn_hr_cnt', 'Original')}
            <Field label="Actual"><input readOnly value={st === 'TK_NotStart' ? '0' : fmtDur(Math.max(0, Number(t.target_drtn_hr_cnt || 0) - Number(t.remain_drtn_hr_cnt || 0)), p)} /></Field>
            {durInput('remain_drtn_hr_cnt', 'Remaining')}
            <Field label="At Completion"><input readOnly value={fmtDur(st === 'TK_Complete' ? t.target_drtn_hr_cnt : Math.max(0, Number(t.target_drtn_hr_cnt || 0) - Number(t.remain_drtn_hr_cnt || 0)) + Number(t.remain_drtn_hr_cnt || 0), p)} /></Field>
          </div>
        </fieldset>
        <fieldset style={{ width: 330 }}><legend>Status</legend>
          <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
            <label><input type="checkbox" checked={!!t.act_start_date} onChange={(e) => updateTask(t.task_id, e.target.checked ? 'Start Activity' : 'Clear Actual Start', (r) => {
              if (!e.target.checked) { if (r.act_end_date) return 'Clear Finished first.'; r.act_start_date = ''; r.remain_drtn_hr_cnt = r.target_drtn_hr_cnt; r.status_code = 'TK_NotStart'; return; }
              return setActual(r, 'start', r.early_start_date || r.target_start_date || dd);
            })} /> Started</label>
            <input type="datetime-local" disabled={!t.act_start_date} value={dt(t.act_start_date)} onChange={(e) => updateTask(t.task_id, 'Edit Actual Start', (r) => setActual(r, 'start', fromDt(e.target.value)))} />
            <label><input type="checkbox" checked={!!t.act_end_date} disabled={!t.act_start_date} onChange={(e) => updateTask(t.task_id, e.target.checked ? 'Finish Activity' : 'Clear Actual Finish', (r) => {
              if (!e.target.checked) return setActual(r, 'finish', '');
              const ef = r.early_end_date && r.early_end_date >= r.act_start_date ? r.early_end_date : r.act_start_date;
              return setActual(r, 'finish', ef);
            })} /> Finished</label>
            <input type="datetime-local" disabled={!t.act_end_date} value={dt(t.act_end_date)} onChange={(e) => updateTask(t.task_id, 'Edit Actual Finish', (r) => setActual(r, 'finish', fromDt(e.target.value)))} />
            <Field label="Exp Finish"><input type="datetime-local" value={dt(t.expect_end_date)} onChange={(e) => updateTask(t.task_id, 'Edit Expected Finish', (r) => { r.expect_end_date = fromDt(e.target.value); })} /></Field>
            <Field label="Suspend"><input type="datetime-local" disabled={st !== 'TK_Active'} value={dt(t.suspend_date)} onChange={(e) => updateTask(t.task_id, 'Edit Suspend', (r) => { r.suspend_date = fromDt(e.target.value); })} /></Field>
            <Field label="Resume"><input type="datetime-local" disabled={!t.suspend_date} value={dt(t.resume_date)} onChange={(e) => updateTask(t.task_id, 'Edit Resume', (r) => { r.resume_date = fromDt(e.target.value); })} /></Field>
          </div>
        </fieldset>
        <fieldset style={{ width: 230 }}><legend>% Complete</legend>
          <div className="form" style={{ gridTemplateColumns: 'auto 70px' }}>
            <Field label={`Activity % (${PCT_TYPES[t.complete_pct_type] ?? 'Duration'})`}><input type="number" min={0} max={100} defaultValue={Math.round(activityPct(t, ctx) * 10) / 10} key={t.task_id + t.remain_drtn_hr_cnt + t.phys_complete_pct}
              onBlur={(e) => { const v = Number(e.target.value); if (Math.abs(v - activityPct(t, ctx)) > 0.01) updateTask(t.task_id, 'Edit % Complete', (r) => setPercent(r, v)); }} /></Field>
            <Field label="Duration %"><input readOnly value={`${Math.round(durationPct(t) * 10) / 10}%`} /></Field>
            <Field label="Status"><input readOnly value={STATUS[st]} /></Field>
            <Field label="Total Float"><input readOnly value={fmtDur(t.total_float_hr_cnt, p)} /></Field>
            <Field label="Free Float"><input readOnly value={fmtDur(t.free_float_hr_cnt, p)} /></Field>
          </div>
        </fieldset>
        <fieldset style={{ width: 300 }}><legend>Constraints</legend>
          <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
            <Field label="Primary"><select value={t.cstr_type || ''} onChange={(e) => updateTask(t.task_id, 'Edit Primary Constraint', (r) => { r.cstr_type = e.target.value; if (!e.target.value) r.cstr_date = ''; else if (!r.cstr_date && e.target.value !== 'CS_ALAP') r.cstr_date = /MEO|FIN/.test(e.target.value) ? r.early_end_date : r.early_start_date; })}>
              {Object.entries(CSTR_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Date"><input type="datetime-local" disabled={!t.cstr_type || t.cstr_type === 'CS_ALAP'} value={dt(t.cstr_date)} onChange={(e) => updateTask(t.task_id, 'Edit Constraint Date', (r) => { r.cstr_date = fromDt(e.target.value); })} /></Field>
            <Field label="Secondary"><select value={t.cstr_type2 || ''} onChange={(e) => updateTask(t.task_id, 'Edit Secondary Constraint', (r) => { r.cstr_type2 = e.target.value; if (!e.target.value) r.cstr_date2 = ''; else if (!r.cstr_date2) r.cstr_date2 = r.early_end_date; })}>
              {Object.entries(CSTR_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Date"><input type="datetime-local" disabled={!t.cstr_type2} value={dt(t.cstr_date2)} onChange={(e) => updateTask(t.task_id, 'Edit Secondary Constraint Date', (r) => { r.cstr_date2 = fromDt(e.target.value); })} /></Field>
          </div>
        </fieldset>
      </div>
    </div>
  );
}

function Rels({ t, ctx, which }: { t: Row; ctx: Ctx; which: 'pred' | 'succ' }) {
  const [sel, setSel] = useState<string | null>(null);
  const list = which === 'pred' ? ctx.predsOf.get(t.task_id) ?? [] : ctx.succsOf.get(t.task_id) ?? [];
  const other = (r: Row) => ctx.taskById.get(which === 'pred' ? r.pred_task_id : r.task_id);
  const edit = (id: string, patch: Partial<Row>, label: string) => mutate(label, (db) => { Object.assign(db.tables.TASKPRED.rows.find((x) => x.task_pred_id === id)!, patch); });
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: '1px solid #ccc' }}>
      <div style={{ padding: '3px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <b>{which === 'pred' ? 'Predecessors' : 'Successors'}</b>
        <button className="btn" onClick={() => openDialog('assign', { which })}>Assign...</button>
        <button className="btn" disabled={!sel} onClick={() => { mutate('Remove Relationship', (db) => { db.tables.TASKPRED.rows = db.tables.TASKPRED.rows.filter((x) => x.task_pred_id !== sel); }); setSel(null); }}>Remove</button>
        <button className="btn" disabled={!sel} onClick={() => { const r = list.find((x) => x.task_pred_id === sel); const o = r && other(r); if (o) setUi({ selTask: o.task_id, selTasks: [o.task_id] }); }}>Go To</button>
      </div>
      <div className="tblwrap" style={{ flex: 1, margin: '0 6px 6px' }}>
        <table className="tbl">
          <thead><tr><th>Activity ID</th><th>Activity Name</th><th>Relationship Type</th><th>Lag</th><th>Start</th><th>Finish</th><th>Critical</th><th>Project</th></tr></thead>
          <tbody>
            {list.map((r) => {
              const o = other(r);
              return (
                <tr key={r.task_pred_id} className={sel === r.task_pred_id ? 'sel' : ''} onMouseDown={() => setSel(r.task_pred_id)}>
                  <td>{o?.task_code ?? `(external ${which === 'pred' ? r.pred_task_id : r.task_id})`}</td>
                  <td>{o?.task_name}</td>
                  <td><select value={r.pred_type} onChange={(e) => edit(r.task_pred_id, { pred_type: e.target.value }, 'Edit Relationship Type')}>{Object.entries(REL_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                  <td><input type="number" step="0.5" defaultValue={fmtDur(r.lag_hr_cnt, ctx.prefs)} key={r.lag_hr_cnt} style={{ width: 60 }} onBlur={(e) => { const h = p6num(daysToHours(Number(e.target.value || 0), ctx.prefs)); if (h !== r.lag_hr_cnt) edit(r.task_pred_id, { lag_hr_cnt: h }, 'Edit Lag'); }} /></td>
                  <td>{o ? fmtDate(o.act_start_date || o.early_start_date, ctx.prefs) + (o.act_start_date ? ' A' : '') : ''}</td>
                  <td>{o ? fmtDate(o.act_end_date || o.early_end_date, ctx.prefs) + (o.act_end_date ? ' A' : '') : ''}</td>
                  <td>{o && isCritical(o, ctx) ? 'Yes' : 'No'}</td>
                  <td>{ctx.proj.get(which === 'pred' ? r.pred_proj_id : r.proj_id)?.proj_short_name ?? (which === 'pred' ? r.pred_proj_id : r.proj_id)}</td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={8} className="muted">None</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Resources({ t, ctx }: { t: Row; ctx: Ctx }) {
  const [sel, setSel] = useState<string | null>(null);
  const list = ctx.rsrcByTask.get(t.task_id) ?? [];
  const editQty = (a: Row, field: 'target_qty' | 'act_reg_qty' | 'remain_qty', v: number) => mutate('Edit Assignment Units', (db) => {
    const r = db.tables.TASKRSRC.rows.find((x) => x.taskrsrc_id === a.taskrsrc_id)!;
    const task = db.tables.TASK.rows.find((x) => x.task_id === r.task_id)!;
    recalcAssignment(db, task, r, field, v);
  });
  return (
    <div className="tabbody flush">
      <div style={{ padding: '3px 6px', display: 'flex', gap: 6 }}>
        <button className="btn" onClick={() => openDialog('assignRsrc')}>Add Resource</button>
        <button className="btn" disabled={!sel} onClick={() => { mutate('Remove Resource Assignment', (db) => { db.tables.TASKRSRC.rows = db.tables.TASKRSRC.rows.filter((x) => x.taskrsrc_id !== sel); }); setSel(null); }}>Remove</button>
      </div>
      <div className="tblwrap" style={{ flex: 1, margin: '0 6px 6px' }}>
        <table className="tbl">
          <thead><tr><th>Resource ID</th><th>Resource Name</th><th>Type</th><th>Budgeted Units</th><th>Actual Units</th><th>Remaining Units</th><th>Units/Time</th><th>Price/Unit</th><th>Budgeted Cost</th><th>Actual Cost</th><th>Remaining Cost</th></tr></thead>
          <tbody>
            {list.map((a) => {
              const r = ctx.rsrc.get(a.rsrc_id);
              const num = (f: 'target_qty' | 'act_reg_qty' | 'remain_qty') => <input type="number" defaultValue={Number(a[f] || 0)} key={a[f]} style={{ width: 70 }} onBlur={(e) => { if (Number(e.target.value) !== Number(a[f] || 0)) editQty(a, f, Number(e.target.value)); }} />;
              return (
                <tr key={a.taskrsrc_id} className={sel === a.taskrsrc_id ? 'sel' : ''} onMouseDown={() => setSel(a.taskrsrc_id)}>
                  <td>{r?.rsrc_short_name ?? a.rsrc_id}</td><td>{r?.rsrc_name}</td><td>{RSRC_TYPES[a.rsrc_type || r?.rsrc_type || ''] ?? ''}</td>
                  <td>{num('target_qty')}</td><td>{num('act_reg_qty')}</td><td>{num('remain_qty')}</td>
                  <td>{p6num(Number(a.target_qty_per_hr || 0) * 8)}/d</td><td>{p6num(priceOf(getDb(), a))}</td>
                  <td>{p6num(Number(a.target_cost || 0))}</td><td>{p6num(Number(a.act_reg_cost || 0) + Number(a.act_ot_cost || 0))}</td><td>{p6num(Number(a.remain_cost || 0))}</td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={11} className="muted">No resources assigned</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Codes({ t, ctx }: { t: Row; ctx: Ctx }) {
  const types = rows(ctx.db, 'ACTVTYPE').filter((x) => !x.proj_id || x.proj_id === t.proj_id);
  const codes = rows(ctx.db, 'ACTVCODE');
  const assigned = rows(ctx.db, 'TASKACTV').filter((a) => a.task_id === t.task_id);
  const setCode = (typeId: string, codeId: string) => mutate('Assign Activity Code', (db) => {
    const TA = table(db, 'TASKACTV');
    for (const f of ['task_id', 'actv_code_type_id', 'actv_code_id', 'proj_id']) addField(TA, f);
    TA.rows = TA.rows.filter((a) => !(a.task_id === t.task_id && (a.actv_code_type_id === typeId || codes.find((c) => c.actv_code_id === a.actv_code_id)?.actv_code_type_id === typeId)));
    if (codeId) TA.rows.push({ task_id: t.task_id, actv_code_type_id: typeId, actv_code_id: codeId, proj_id: t.proj_id });
  });
  return (
    <div className="tabbody">
      {!types.length && <div className="muted">No activity code types defined (Enterprise &gt; Activity Codes).</div>}
      <table className="tbl" style={{ maxWidth: 700 }}>
        <thead><tr><th>Activity Code</th><th>Code Value</th><th>Description</th></tr></thead>
        <tbody>
          {types.map((ty) => {
            const cur = assigned.find((a) => a.actv_code_type_id === ty.actv_code_type_id || codes.find((c) => c.actv_code_id === a.actv_code_id)?.actv_code_type_id === ty.actv_code_type_id);
            const vals = codes.filter((c) => c.actv_code_type_id === ty.actv_code_type_id);
            const curCode = vals.find((c) => c.actv_code_id === cur?.actv_code_id);
            return (
              <tr key={ty.actv_code_type_id}>
                <td>{ty.actv_code_type}</td>
                <td><select value={cur?.actv_code_id ?? ''} onChange={(e) => setCode(ty.actv_code_type_id, e.target.value)}>
                  <option value="" />{vals.map((c) => <option key={c.actv_code_id} value={c.actv_code_id}>{c.short_name}</option>)}</select></td>
                <td>{curCode?.actv_code_name}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Notebook({ t }: { t: Row }) {
  const db = getDb();
  const types = rows(db, 'MEMOTYPE');
  const memos = rows(db, 'TASKMEMO').filter((m) => m.task_id === t.task_id);
  const [sel, setSel] = useState<string | null>(memos[0]?.memo_id ?? null);
  const cur = memos.find((m) => m.memo_id === sel);
  const strip = (h: string) => h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return (
    <div className="tabbody flush" style={{ flexDirection: 'row' }}>
      <div style={{ width: 240, display: 'flex', flexDirection: 'column', padding: 6, gap: 4 }}>
        <div className="tblwrap" style={{ flex: 1 }}>
          <table className="tbl"><thead><tr><th>Notebook Topic</th></tr></thead><tbody>
            {memos.map((m) => <tr key={m.memo_id} className={sel === m.memo_id ? 'sel' : ''} onMouseDown={() => setSel(m.memo_id)}><td>{types.find((x) => x.memo_type_id === m.memo_type_id)?.memo_type ?? 'Notes'}</td></tr>)}
          </tbody></table>
        </div>
        <button className="btn" onClick={() => mutate('Add Notebook Topic', (d) => {
          const MT = table(d, 'MEMOTYPE');
          if (!MT.rows.length) { MT.fields = ['memo_type_id', 'seq_num', 'eps_flag', 'proj_flag', 'wbs_flag', 'task_flag', 'memo_type']; MT.rows.push({ memo_type_id: '1', seq_num: '0', eps_flag: 'N', proj_flag: 'N', wbs_flag: 'N', task_flag: 'Y', memo_type: 'Notes' }); }
          const TM = table(d, 'TASKMEMO');
          for (const f of ['memo_id', 'task_id', 'memo_type_id', 'proj_id', 'task_memo']) addField(TM, f);
          const used = new Set(TM.rows.filter((m) => m.task_id === t.task_id).map((m) => m.memo_type_id));
          const type = MT.rows.find((x) => !used.has(x.memo_type_id)) ?? MT.rows[0];
          const id = String(nextId(d, 'TASKMEMO'));
          TM.rows.push({ memo_id: id, task_id: t.task_id, memo_type_id: type.memo_type_id, proj_id: t.proj_id, task_memo: '' });
          setSel(id);
        })}>Add</button>
      </div>
      <div style={{ flex: 1, padding: 6, display: 'flex' }}>
        {cur ? <textarea style={{ flex: 1, font: '11px Tahoma', border: '1px solid #7f9db9' }} key={cur.memo_id} defaultValue={strip(cur.task_memo)}
          onBlur={(e) => { const html = `<HTML><BODY>${e.target.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</BODY></HTML>`; if (html !== cur.task_memo) mutate('Edit Notebook', (d) => { d.tables.TASKMEMO.rows.find((m) => m.memo_id === cur.memo_id)!.task_memo = html; }); }} />
          : <div className="muted">No notebook topics.</div>}
      </div>
    </div>
  );
}

function Expenses({ t, ctx }: { t: Row; ctx: Ctx }) {
  const list = ctx.costByTask.get(t.task_id) ?? [];
  const accts = rows(ctx.db, 'ACCOUNT');
  const edit = (id: string, patch: Partial<Row>) => mutate('Edit Expense', (db) => {
    const r = db.tables.PROJCOST.rows.find((x) => x.cost_item_id === id)!;
    Object.assign(r, patch);
    r.remain_cost = p6num(Math.max(0, Number(r.target_cost || 0) - Number(r.act_cost || 0)));
  });
  return (
    <div className="tabbody flush">
      <div style={{ padding: '3px 6px' }}>
        <button className="btn" onClick={() => mutate('Add Expense', (db) => {
          const PC = table(db, 'PROJCOST');
          for (const f of ['cost_item_id', 'acct_id', 'pobs_id', 'cost_type_id', 'proj_id', 'task_id', 'cost_name', 'po_number', 'vendor_name', 'act_cost', 'cost_per_qty', 'remain_cost', 'target_cost', 'cost_load_type', 'auto_compute_act_flag', 'target_qty', 'qty_name', 'cost_descr', 'contract_manager_import']) addField(PC, f);
          PC.rows.push({ cost_item_id: String(nextId(db, 'PROJCOST')), acct_id: '', pobs_id: '', cost_type_id: '', proj_id: t.proj_id, task_id: t.task_id, cost_name: 'Expense', po_number: '', vendor_name: '', act_cost: '0', cost_per_qty: '0', remain_cost: '0', target_cost: '0', cost_load_type: 'CL_Uniform', auto_compute_act_flag: 'N', target_qty: '0', qty_name: '', cost_descr: '', contract_manager_import: 'N' });
        })}>Add</button>
      </div>
      <div className="tblwrap" style={{ flex: 1, margin: '0 6px 6px' }}>
        <table className="tbl">
          <thead><tr><th>Expense Item</th><th>Cost Account</th><th>Budgeted Cost</th><th>Actual Cost</th><th>Remaining Cost</th><th /></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.cost_item_id}>
                <td><input defaultValue={c.cost_name} onBlur={(e) => e.target.value !== c.cost_name && edit(c.cost_item_id, { cost_name: e.target.value })} /></td>
                <td><select value={c.acct_id} onChange={(e) => edit(c.cost_item_id, { acct_id: e.target.value })}><option value="" />{accts.map((a) => <option key={a.acct_id} value={a.acct_id}>{a.acct_short_name} {a.acct_name}</option>)}</select></td>
                <td><input type="number" defaultValue={Number(c.target_cost || 0)} onBlur={(e) => edit(c.cost_item_id, { target_cost: p6num(Number(e.target.value)) })} /></td>
                <td><input type="number" defaultValue={Number(c.act_cost || 0)} onBlur={(e) => edit(c.cost_item_id, { act_cost: p6num(Number(e.target.value)) })} /></td>
                <td>{c.remain_cost}</td>
                <td><button className="btn" style={{ minWidth: 0 }} onClick={() => mutate('Delete Expense', (db) => { db.tables.PROJCOST.rows = db.tables.PROJCOST.rows.filter((x) => x.cost_item_id !== c.cost_item_id); })}>×</button></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={6} className="muted">No expenses</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Summary({ t, ctx }: { t: Row; ctx: Ctx }) {
  const p = ctx.prefs;
  const bl = ctx.baseline.get(`${t.task_code}|${t.proj_id}`);
  const line = (l: string, a?: string, b?: string) => <tr><td>{l}</td><td>{fmtDate(a, p, true)}</td><td>{fmtDate(b, p, true)}</td></tr>;
  return (
    <div className="tabbody">
      <table className="tbl" style={{ maxWidth: 520 }}>
        <thead><tr><th>Dates</th><th>Start</th><th>Finish</th></tr></thead>
        <tbody>
          {line('Planned', t.target_start_date, t.target_end_date)}
          {line('Actual', t.act_start_date, t.act_end_date)}
          {line('Remaining (early)', t.restart_date, t.reend_date)}
          {line('Early', t.early_start_date, t.early_end_date)}
          {line('Late', t.late_start_date, t.late_end_date)}
          {line('Remaining late', t.rem_late_start_date, t.rem_late_end_date)}
          {bl && line('Project baseline', bl.act_start_date || bl.target_start_date, bl.act_end_date || bl.target_end_date)}
        </tbody>
      </table>
      <p className="muted">Internal ID {t.task_id} · WBS {wbsPath(t.wbs_id, ctx)} · Critical: {isCritical(t, ctx) ? 'Yes' : 'No'} · Longest path: {t.driving_path_flag === 'Y' ? 'Yes' : 'No'}</p>
    </div>
  );
}
