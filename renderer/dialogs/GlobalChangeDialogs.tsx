// Tools > Global Change (P6): saved change definitions. "If" conditions (as in filters) pick activities; "Then"
// statements set a column to a value or change a number by + - * /. Apply Change shows the Global Change Report
// (every activity, column, old and new value) and Commit Changes applies it as one undoable step.
// Also Enterprise > Project Codes / Resource Codes (code types and values) and the resources' Codes tab.
import { useMemo, useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, getUi, mutate, openDialog, toast, useStore } from '../store.ts';
import { addField, rows, table, type Db, type Row } from '../../core/db.ts';
import { formatP6Date } from '../../core/dates.ts';
import { COLUMNS, makeCtx, type Column } from '../model.ts';
import { FILTER_OPS, userFilterTest } from '../views/activityRows.ts';

export interface GcRow { col: string; op: string; value: string }
export interface GlobalChange { name: string; any: boolean; ifs: GcRow[]; thens: { col: string; op: '=' | '+' | '-' | '*' | '/'; value: string }[] }
export interface GcResult { taskId: string; code: string; name: string; col: string; title: string; old: string; next: string; error?: string }

export const editableColumns = (): Column[] => COLUMNS.filter((c) => !!c.edit);
const parseGc = (json: string): GlobalChange | null => { try { const o = JSON.parse(json) as GlobalChange; return o && typeof o.name === 'string' ? { name: o.name, any: !!o.any, ifs: Array.isArray(o.ifs) ? o.ifs : [], thens: Array.isArray(o.thens) ? o.thens : [] } : null; } catch { return null; } };
export const globalChanges = (db: Db) => rows(db, '_GCHANGE').map((r) => ({ id: r.gc_id, def: parseGc(r.json) })).filter((x): x is { id: string; def: GlobalChange } => !!x.def);

/** The Global Change Report: what applying the change would do to the open projects (nothing is changed). */
export function previewGlobalChange(db: Db, projIds: string[], gc: GlobalChange, prefs = getUi().prefs): GcResult[] {
  const ctx = makeCtx(db, prefs);
  const test = gc.ifs.length ? userFilterTest({ any: gc.any, rows: gc.ifs }, ctx) : () => true;
  const cols = new Map(editableColumns().map((c) => [c.id, c]));
  const out: GcResult[] = [];
  const num = (s: string) => { const t = s.replace(/[$,%\s]/g, '').replace(/ A$/, ''); return t !== '' && Number.isFinite(Number(t)) ? Number(t) : null; };
  for (const t of rows(db, 'TASK')) {
    if (!projIds.includes(t.proj_id) || !test(t)) continue;
    const copy = { ...t };
    for (const s of gc.thens) {
      const c = cols.get(s.col);
      if (!c?.edit) continue;
      const old = c.get(copy, ctx);
      let next = s.value;
      if (s.op !== '=') {
        const a = num(old), b = num(s.value);
        if (a == null || b == null) { out.push({ taskId: t.task_id, code: t.task_code, name: t.task_name, col: s.col, title: c.title, old, next: '', error: `${c.title} is not a number here` }); continue; }
        if (s.op === '/' && b === 0) { out.push({ taskId: t.task_id, code: t.task_code, name: t.task_name, col: s.col, title: c.title, old, next: '', error: 'division by zero' }); continue; }
        next = String(Math.round((s.op === '+' ? a + b : s.op === '-' ? a - b : s.op === '*' ? a * b : a / b) * 100) / 100);
      }
      const err = c.edit.set(db, copy, next, ctx);
      out.push({ taskId: t.task_id, code: t.task_code, name: t.task_name, col: s.col, title: c.title, old, next: err ? next : c.get(copy, ctx), ...(err ? { error: err } : {}) });
    }
  }
  return out;
}

/** Commit: the same statements applied to the real rows, one undo step. Rows with errors are skipped. */
export function commitGlobalChange(projIds: string[], gc: GlobalChange): number {
  const res = previewGlobalChange(getDb(), projIds, gc).filter((r) => !r.error && r.old !== r.next);
  if (!res.length) return 0;
  const byTask = new Map<string, GcResult[]>(); for (const r of res) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  mutate(`Global Change ${gc.name}`, (d) => {
    const ctx = makeCtx(d, getUi().prefs), cols = new Map(editableColumns().map((c) => [c.id, c]));
    for (const [id, list] of byTask) {
      const t = rows(d, 'TASK').find((x) => x.task_id === id);
      if (!t) continue;
      for (const r of list) cols.get(r.col)!.edit!.set(d, t, gc.thens.find((s) => s.col === r.col)?.op === '=' ? gc.thens.find((s) => s.col === r.col)!.value : r.next.replace(/[$,%]/g, ''), ctx);
      t.update_date = formatP6Date(Date.now() / 60000);
    }
  });
  return res.length;
}

export function GlobalChangeDialog() {
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const list = globalChanges(db);
  const [sel, setSel] = useState<string | null>(list[0]?.id ?? null);
  // the one clicked, else the newest (a change just made with New is ready to apply)
  const cur = list.find((x) => x.id === sel) ?? list.at(-1);
  return (
    <Dialog title="Global Change" width={480} height={380} buttons={<>
      <button className="btn primary" disabled={!cur} onClick={() => openDialog('globalChangeReport', { id: cur!.id })}>Apply Change</button>
      <button className="btn" onClick={() => openDialog('globalChangeEdit', {})}>New...</button>
      <button className="btn" disabled={!cur} onClick={() => openDialog('globalChangeEdit', { id: cur!.id })}>Modify...</button>
      <button className="btn" disabled={!cur} onClick={() => { mutate('Delete Global Change', (d) => { table(d, '_GCHANGE').rows = rows(d, '_GCHANGE').filter((r) => r.gc_id !== cur!.id); }); setSel(null); }}>Delete</button>
      <button className="btn" onClick={closeDialog}>Close</button>
    </>}>
      <p style={{ marginTop: 0 }}>Change many activities at once: "If" picks the activities, "Then" says what to change. Apply Change shows every change for you to review before committing.</p>
      <div className="tblwrap" style={{ height: 220 }}>
        <table className="tbl"><thead><tr><th>Global Change</th><th>If</th><th>Then</th></tr></thead><tbody>
          {list.map((g) => <tr key={g.id} className={cur?.id === g.id ? 'sel' : ''} onMouseDown={() => setSel(g.id)} onDoubleClick={() => openDialog('globalChangeEdit', { id: g.id })}><td>{g.def.name}</td><td>{g.def.ifs.length} condition(s)</td><td>{g.def.thens.length} change(s)</td></tr>)}
          {!list.length && <tr><td colSpan={3} className="muted">No global changes yet. Click New.</td></tr>}
        </tbody></table>
      </div>
    </Dialog>
  );
}

export function GlobalChangeEditDialog(props: { id?: string; preset?: GlobalChange }) {
  const db = getDb();
  const existing = props.id ? globalChanges(db).find((x) => x.id === props.id)?.def : undefined;
  const [g, setG] = useState<GlobalChange>(props.preset ?? existing ?? { name: 'New Global Change', any: false, ifs: [{ col: 'task_code', op: 'nempty', value: '' }], thens: [{ col: 'task_name', op: '=', value: '' }] });
  const cols = [...COLUMNS].sort((a, b) => a.title.localeCompare(b.title));
  const edits = editableColumns().sort((a, b) => a.title.localeCompare(b.title));
  const save = () => {
    if (!g.name.trim()) return toast('Give the global change a name.');
    if (!g.thens.length) return toast('Add at least one "Then" statement.');
    mutate(`${props.id ? 'Modify' : 'Add'} Global Change`, (d) => {
      const T = table(d, '_GCHANGE'); for (const f of ['gc_id', 'name', 'json']) addField(T, f);
      const json = JSON.stringify({ ...g, name: g.name.trim() });
      const ex = props.id ? T.rows.find((r) => r.gc_id === props.id) : undefined;
      if (ex) { ex.name = g.name.trim(); ex.json = json; }
      else T.rows.push({ gc_id: String(Math.max(0, ...T.rows.map((r) => Number(r.gc_id) || 0)) + 1), name: g.name.trim(), json });
    });
    closeDialog();
  };
  return (
    <Dialog title="Modify Global Change" width={720} height={480} buttons={<><button className="btn primary" onClick={save}>OK</button><button className="btn" onClick={closeDialog}>Cancel</button></>}>
      <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}><label>Name</label><input value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} /></div>
      <fieldset><legend>If <select value={g.any ? 'any' : 'all'} onChange={(e) => setG({ ...g, any: e.target.value === 'any' })}><option value="all">all of the following</option><option value="any">any of the following</option></select></legend>
        {g.ifs.map((r, i) => <div key={i} style={{ display: 'flex', gap: 4, margin: '2px 0' }}>
          <select value={r.col} onChange={(e) => setG({ ...g, ifs: g.ifs.map((x, j) => (j === i ? { ...x, col: e.target.value } : x)) })}>{cols.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
          <select value={r.op} onChange={(e) => setG({ ...g, ifs: g.ifs.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })}>{Object.entries(FILTER_OPS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input style={{ flex: 1 }} value={r.value} disabled={r.op === 'empty' || r.op === 'nempty'} onChange={(e) => setG({ ...g, ifs: g.ifs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
          <button className="btn" onClick={() => setG({ ...g, ifs: g.ifs.filter((_, j) => j !== i) })}>Remove</button>
        </div>)}
        <button className="btn" onClick={() => setG({ ...g, ifs: [...g.ifs, { col: 'task_code', op: 'eq', value: '' }] })}>Add condition</button>
        <span className="muted" style={{ marginLeft: 8 }}>No conditions = every activity of the open projects.</span>
      </fieldset>
      <fieldset><legend>Then</legend>
        {g.thens.map((r, i) => <div key={i} style={{ display: 'flex', gap: 4, margin: '2px 0' }}>
          <select value={r.col} onChange={(e) => setG({ ...g, thens: g.thens.map((x, j) => (j === i ? { ...x, col: e.target.value } : x)) })}>{edits.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
          <select value={r.op} onChange={(e) => setG({ ...g, thens: g.thens.map((x, j) => (j === i ? { ...x, op: e.target.value as GlobalChange['thens'][number]['op'] } : x)) })}>
            <option value="=">= (set to)</option><option value="+">+ (add)</option><option value="-">- (subtract)</option><option value="*">x (multiply by)</option><option value="/">/ (divide by)</option></select>
          <input style={{ flex: 1 }} value={r.value} placeholder={r.op === '=' ? 'new value, as typed in the table' : 'number'} onChange={(e) => setG({ ...g, thens: g.thens.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
          <button className="btn" onClick={() => setG({ ...g, thens: g.thens.filter((_, j) => j !== i) })}>Remove</button>
        </div>)}
        <button className="btn" onClick={() => setG({ ...g, thens: [...g.thens, { col: 'orig_dur', op: '*', value: '1.1' }] })}>Add statement</button>
      </fieldset>
    </Dialog>
  );
}

export function GlobalChangeReportDialog(props: { id: string }) {
  const db = getDb();
  const gc = globalChanges(db).find((x) => x.id === props.id)?.def;
  const projIds = getUi().openProjects;
  const res = useMemo(() => (gc ? previewGlobalChange(db, projIds, gc) : []), [gc, db, projIds]);
  const changes = res.filter((r) => !r.error && r.old !== r.next);
  return (
    <Dialog title={`Global Change Report - ${gc?.name ?? ''}`} width={760} height={500} buttons={<>
      <button className="btn primary" disabled={!changes.length} onClick={() => { const n = commitGlobalChange(projIds, gc!); closeDialog(); closeDialog(); toast(`Global change committed: ${n} change(s). Ctrl+Z undoes it; F9 reschedules.`); }}>Commit Changes</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
    </>}>
      <p style={{ marginTop: 0 }}>{changes.length} change(s) to {new Set(changes.map((r) => r.taskId)).size} activities{res.length - changes.length ? `; ${res.filter((r) => r.error).length} refused, ${res.filter((r) => !r.error && r.old === r.next).length} already as asked` : ''}. Nothing changes until you commit.</p>
      <div className="tblwrap" style={{ height: 360 }}>
        <table className="tbl gc-report"><thead><tr><th>Activity ID</th><th>Activity Name</th><th>Column</th><th>Old Value</th><th>New Value</th><th>Note</th></tr></thead><tbody>
          {res.slice(0, 3000).map((r, i) => <tr key={i} style={r.error ? { color: '#a00' } : r.old === r.next ? { color: '#888' } : undefined}><td>{r.code}</td><td>{r.name}</td><td>{r.title}</td><td>{r.old}</td><td>{r.error ? '' : r.next}</td><td>{r.error ?? (r.old === r.next ? 'no change' : '')}</td></tr>)}
          {!res.length && <tr><td colSpan={6} className="muted">No activity matches the "If" conditions.</td></tr>}
        </tbody></table>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Project Codes / Resource Codes dictionaries
const DICT = {
  project: { title: 'Project Codes', type: 'PCATTYPE', val: 'PCATVAL', link: 'PROJPCAT', tid: 'proj_catg_type_id', tname: 'proj_catg_type', tlen: 'proj_catg_short_len', vid: 'proj_catg_id', vcode: 'proj_catg_short_name', vname: 'proj_catg_name', vparent: 'parent_proj_catg_id' },
  resource: { title: 'Resource Codes', type: 'RCATTYPE', val: 'RCATVAL', link: 'RSRCRCAT', tid: 'rsrc_catg_type_id', tname: 'rsrc_catg_type', tlen: 'rsrc_catg_short_len', vid: 'rsrc_catg_id', vcode: 'rsrc_catg_short_name', vname: 'rsrc_catg_name', vparent: 'parent_rsrc_catg_id' },
} as const;
const nextOf = (d: Db, t: string, k: string) => String(Math.max(0, ...rows(d, t).map((r) => Number(r[k]) || 0)) + 1);

export function CodeDictionaryDialog(props: { kind: 'project' | 'resource' }) {
  const k = DICT[props.kind];
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const types = [...rows(db, k.type)].sort((a, b) => Number(a.seq_num) - Number(b.seq_num));
  const [selT, setSelT] = useState<string | null>(types[0]?.[k.tid] ?? null);
  const [selV, setSelV] = useState<string | null>(null);
  const vals = rows(db, k.val).filter((v) => v[k.tid] === selT).sort((a, b) => Number(a.seq_num) - Number(b.seq_num) || a[k.vcode].localeCompare(b[k.vcode]));
  const used = (vid: string) => rows(db, k.link).filter((l) => l[k.vid] === vid).length;
  const addType = () => mutate(`Add ${k.title}`, (d) => { const T = table(d, k.type); for (const f of [k.tid, 'seq_num', k.tlen, k.tname]) addField(T, f); const id = nextOf(d, k.type, k.tid); T.rows.push({ [k.tid]: id, seq_num: String(T.rows.length + 1), [k.tlen]: '10', [k.tname]: `New ${props.kind === 'project' ? 'Project' : 'Resource'} Code` }); setSelT(id); });
  const addVal = () => selT && mutate('Add Code Value', (d) => { const T = table(d, k.val); for (const f of [k.vid, k.tid, 'seq_num', k.vcode, k.vparent, k.vname]) addField(T, f); const id = nextOf(d, k.val, k.vid); T.rows.push({ [k.vid]: id, [k.tid]: selT, seq_num: String(vals.length + 1), [k.vcode]: `V${vals.length + 1}`, [k.vparent]: '', [k.vname]: '' }); setSelV(id); });
  const setT = (patch: Row) => mutate(`Edit ${k.title}`, (d) => { const r = rows(d, k.type).find((x) => x[k.tid] === selT); if (r) Object.assign(r, patch); });
  const setV = (id: string, patch: Row) => mutate('Edit Code Value', (d) => { const r = rows(d, k.val).find((x) => x[k.vid] === id); if (r) Object.assign(r, patch); });
  const delType = () => selT && mutate(`Delete ${k.title}`, (d) => { for (const t of [k.type, k.val, k.link]) table(d, t).rows = rows(d, t).filter((x) => x[k.tid] !== selT); setSelT(null); });
  const delVal = () => selV && mutate('Delete Code Value', (d) => { table(d, k.val).rows = rows(d, k.val).filter((x) => x[k.vid] !== selV); table(d, k.link).rows = rows(d, k.link).filter((x) => x[k.vid] !== selV); setSelV(null); });
  const type = types.find((t) => t[k.tid] === selT);
  return (
    <Dialog title={k.title} width={700} height={460} buttons={<button className="btn primary" onClick={closeDialog}>Close</button>}>
      <div style={{ display: 'flex', gap: 10, height: 360 }}>
        <div style={{ width: 230, display: 'flex', flexDirection: 'column' }}>
          <b>Code types</b>
          <div className="tblwrap" style={{ flex: 1 }}><table className="tbl"><tbody>{types.map((t) => <tr key={t[k.tid]} className={selT === t[k.tid] ? 'sel' : ''} onMouseDown={() => { setSelT(t[k.tid]); setSelV(null); }}><td>{t[k.tname]}</td></tr>)}
            {!types.length && <tr><td className="muted">None yet.</td></tr>}</tbody></table></div>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}><button className="btn" onClick={addType}>Add</button><button className="btn" disabled={!selT} onClick={delType}>Delete</button></div>
          {type && <div className="form" style={{ gridTemplateColumns: 'auto 1fr', marginTop: 6 }}>
            <label>Name</label><input key={selT} defaultValue={type[k.tname]} onBlur={(e) => e.target.value.trim() && e.target.value !== type[k.tname] && setT({ [k.tname]: e.target.value.trim() })} />
            <label>Max length</label><input key={`${selT}l`} type="number" min={1} max={60} defaultValue={type[k.tlen]} onBlur={(e) => Number(e.target.value) > 0 && setT({ [k.tlen]: String(Number(e.target.value)) })} />
          </div>}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <b>Code values {type ? `of ${type[k.tname]}` : ''}</b>
          <div className="tblwrap" style={{ flex: 1 }}><table className="tbl"><thead><tr><th style={{ width: 120 }}>Code Value</th><th>Description</th><th style={{ width: 60 }}>Used</th></tr></thead><tbody>
            {vals.map((v) => <tr key={v[k.vid]} className={selV === v[k.vid] ? 'sel' : ''} onMouseDown={() => setSelV(v[k.vid])}>
              <td><input style={{ width: '100%' }} defaultValue={v[k.vcode]} maxLength={Number(type?.[k.tlen]) || 60} onBlur={(e) => e.target.value.trim() && e.target.value !== v[k.vcode] && (vals.some((x) => x !== v && x[k.vcode] === e.target.value.trim()) ? toast('That code value already exists.') : setV(v[k.vid], { [k.vcode]: e.target.value.trim() }))} /></td>
              <td><input style={{ width: '100%' }} defaultValue={v[k.vname]} onBlur={(e) => e.target.value !== v[k.vname] && setV(v[k.vid], { [k.vname]: e.target.value })} /></td>
              <td>{used(v[k.vid])}</td></tr>)}
            {selT && !vals.length && <tr><td colSpan={3} className="muted">No values yet.</td></tr>}
          </tbody></table></div>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}><button className="btn" disabled={!selT} onClick={addVal}>Add</button><button className="btn" disabled={!selV} onClick={delVal}>Delete</button>
            <span className="muted" style={{ marginLeft: 6 }}>{props.kind === 'project' ? 'Assign in Project Details > Codes.' : 'Assign in the Resources window > Codes tab.'}</span></div>
        </div>
      </div>
    </Dialog>
  );
}

/** Resources window > Codes tab: one value per resource code type (RSRCRCAT). */
export function ResourceCodesTab({ r }: { r: Row }) {
  useStore((s) => s.dbVersion);
  const db = getDb();
  const types = rows(db, 'RCATTYPE'), vals = rows(db, 'RCATVAL'), assigned = rows(db, 'RSRCRCAT').filter((a) => a.rsrc_id === r.rsrc_id);
  const setCode = (typeId: string, valId: string) => mutate('Assign Resource Code', (d) => {
    const T = table(d, 'RSRCRCAT'); for (const f of ['rsrc_id', 'rsrc_catg_type_id', 'rsrc_catg_id']) addField(T, f);
    T.rows = T.rows.filter((a) => !(a.rsrc_id === r.rsrc_id && a.rsrc_catg_type_id === typeId));
    if (valId) T.rows.push({ rsrc_id: r.rsrc_id, rsrc_catg_type_id: typeId, rsrc_catg_id: valId });
  });
  if (!types.length) return <div className="tabbody muted">No resource code types. Create them in Enterprise &gt; Resource Codes.</div>;
  return (
    <div className="tabbody"><table className="tbl"><thead><tr><th>Resource Code</th><th>Code Value</th><th>Description</th></tr></thead><tbody>
      {types.map((ty) => { const cur = assigned.find((a) => a.rsrc_catg_type_id === ty.rsrc_catg_type_id); const mine = vals.filter((v) => v.rsrc_catg_type_id === ty.rsrc_catg_type_id);
        return <tr key={ty.rsrc_catg_type_id}><td>{ty.rsrc_catg_type}</td><td><select value={cur?.rsrc_catg_id ?? ''} onChange={(e) => setCode(ty.rsrc_catg_type_id, e.target.value)}><option value="" />{mine.map((v) => <option key={v.rsrc_catg_id} value={v.rsrc_catg_id}>{v.rsrc_catg_short_name}</option>)}</select></td><td>{mine.find((v) => v.rsrc_catg_id === cur?.rsrc_catg_id)?.rsrc_catg_name ?? ''}</td></tr>; })}
    </tbody></table></div>
  );
}
