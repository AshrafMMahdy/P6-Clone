import { useMemo, useState, type ReactNode, type MouseEvent as RME } from 'react';
import { Grid, type EditorSpec, type GridItem } from '../components/Grid.tsx';
import { Split, Tabs, showContextMenu } from '../components/Layout.tsx';
import { getDb, mutate, setUi, toast, useStore } from '../store.ts';
import { useCtx } from '../hooks.ts';
import { RSRC_TYPES, ensureDefaultCalendar, fmtDate, type Ctx } from '../model.ts';
import { addField, nextId, rows, table, type Db, type Row } from '../../core/db.ts';
import { p6num } from '../../core/schedule/cpm.ts';
import { recomputeCosts } from '../../core/resource/assign.ts';

const COLS = [
  { id: 'id', title: 'Resource ID', width: 170 },
  { id: 'name', title: 'Resource Name', width: 220 },
  { id: 'type', title: 'Resource Type', width: 80 },
  { id: 'unit', title: 'Unit of Measure', width: 70 },
  { id: 'def', title: 'Default Units / Time', width: 70, align: 'right' as const },
  { id: 'max', title: 'Max Units / Time', width: 70, align: 'right' as const },
  { id: 'price', title: 'Price / Unit', width: 80, align: 'right' as const },
  { id: 'cal', title: 'Calendar', width: 160 },
  { id: 'active', title: 'Active', width: 46, align: 'center' as const },
];

const TABS: [string, string][] = [['general', 'General'], ['units', 'Units & Prices'], ['roles', 'Roles'], ['assignments', 'Assignments']];
const SKILLS: Record<string, string> = { '1': '1 - Master', '2': '2 - Expert', '3': '3 - Skilled', '4': '4 - Proficient', '5': '5 - Inexperienced' };

export const RSRC_NEW_FIELDS = ['rsrc_id', 'parent_rsrc_id', 'clndr_id', 'rsrc_seq_num', 'rsrc_name', 'rsrc_short_name', 'def_qty_per_hr', 'cost_qty_type', 'ot_factor', 'active_flag', 'rsrc_type', 'unit_id', 'curr_id', 'max_qty_per_hr', 'level_flag'];

const num = (s: string | undefined) => Number(s || 0) || 0;
const fmtN = (n: number) => String(Math.round(n * 100) / 100);
const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parseNum = (v: string) => Number(String(v).replace(/[^\d.\-eE]/g, ''));

/** Rates of a resource, earliest effective date first. */
export function ratesOf(db: Db, rsrcId: string): Row[] {
  return rows(db, 'RSRCRATE').filter((r) => r.rsrc_id === rsrcId).sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
}
const latestRate = (db: Db, rsrcId: string): Row | undefined => ratesOf(db, rsrcId).at(-1);

function maxPerHr(db: Db, r: Row): number {
  const lr = latestRate(db, r.rsrc_id);
  if (lr && lr.max_qty_per_hr !== '' && lr.max_qty_per_hr != null) return num(lr.max_qty_per_hr);
  return r.max_qty_per_hr ? num(r.max_qty_per_hr) : 1;
}

const unitSuffix = (r: Row | undefined) => (r?.rsrc_type === 'RT_Mat' ? '/d' : 'h/d');

/** Recompute costs of a resource's assignments after a price change (cost linked to units only). */
function recostResource(db: Db, rsrcId: string): void {
  for (const a of rows(db, 'TASKRSRC')) if (a.rsrc_id === rsrcId && a.cost_qty_link_flag !== 'N') recomputeCosts(db, a);
}

/** Validate on a copy, then apply as one undoable edit. */
function editRsrc(rsrcId: string, label: string, fn: (r: Row, db: Db) => string | void, after?: (db: Db) => void): void {
  const cur = rows(getDb(), 'RSRC').find((x) => x.rsrc_id === rsrcId);
  if (!cur) return;
  const copy = { ...cur };
  const err = fn(copy, getDb());
  if (err) { toast(err); return; }
  mutate(label, (db) => {
    const T = table(db, 'RSRC');
    for (const k of Object.keys(copy)) addField(T, k);
    const r = T.rows.find((x) => x.rsrc_id === rsrcId);
    if (r) Object.assign(r, copy);
    after?.(db);
  });
}

function setLatestRate(db: Db, rsrcId: string, patch: Partial<Row>): void {
  const R = table(db, 'RSRCRATE');
  for (const f of ['rsrc_rate_id', 'rsrc_id', 'max_qty_per_hr', 'cost_per_qty', 'start_date']) addField(R, f);
  let lr = latestRate(db, rsrcId);
  if (!lr) {
    const rs = rows(db, 'RSRC').find((x) => x.rsrc_id === rsrcId);
    lr = { rsrc_rate_id: String(nextId(db, 'RSRCRATE')), rsrc_id: rsrcId, max_qty_per_hr: rs?.max_qty_per_hr || '1', cost_per_qty: '0', start_date: '' };
    R.rows.push(lr);
  }
  Object.assign(lr, patch);
}

function addResource(parentId: string): void {
  let newId = '';
  mutate(parentId ? 'Add Child Resource' : 'Add Resource', (db) => {
    const cal = ensureDefaultCalendar(db);
    const T = table(db, 'RSRC');
    for (const f of RSRC_NEW_FIELDS) addField(T, f);
    const id = String(nextId(db, 'RSRC'));
    const used = new Set(T.rows.map((r) => r.rsrc_short_name));
    let n = T.rows.length + 1;
    while (used.has(`RSRC${n}`)) n++;
    const seq = Math.max(0, ...T.rows.filter((r) => (r.parent_rsrc_id || '') === parentId).map((r) => num(r.rsrc_seq_num))) + 1;
    T.rows.push({
      rsrc_id: id, parent_rsrc_id: parentId, clndr_id: cal.clndr_id, rsrc_seq_num: String(seq), rsrc_name: 'New Resource', rsrc_short_name: `RSRC${n}`,
      def_qty_per_hr: '1', cost_qty_type: 'QT_Hour', ot_factor: '1', active_flag: 'Y', rsrc_type: 'RT_Labor',
      unit_id: rows(db, 'UMEASURE')[0]?.unit_id ?? '', curr_id: rows(db, 'CURRTYPE')[0]?.curr_id ?? '', max_qty_per_hr: '1', level_flag: 'Y',
    });
    const R = table(db, 'RSRCRATE');
    for (const f of ['rsrc_rate_id', 'rsrc_id', 'max_qty_per_hr', 'cost_per_qty', 'start_date']) addField(R, f);
    R.rows.push({ rsrc_rate_id: String(nextId(db, 'RSRCRATE')), rsrc_id: id, max_qty_per_hr: '1', cost_per_qty: '0', start_date: '' });
    newId = id;
  });
  setUi((u) => ({ selRsrc: newId, collapsed: parentId ? { ...u.collapsed, [`rs:${parentId}`]: false } : u.collapsed }));
}

function deleteResource(rsrcId: string): void {
  const db0 = getDb();
  const all = new Set<string>([rsrcId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows(db0, 'RSRC')) if (r.parent_rsrc_id && all.has(r.parent_rsrc_id) && !all.has(r.rsrc_id)) { all.add(r.rsrc_id); grew = true; }
  }
  const used = rows(db0, 'TASKRSRC').filter((a) => all.has(a.rsrc_id));
  if (used.length) {
    const names = [...new Set(used.map((a) => rows(db0, 'RSRC').find((r) => r.rsrc_id === a.rsrc_id)?.rsrc_short_name ?? a.rsrc_id))].join(', ');
    toast(`Cannot delete: ${names} ${used.length === 1 ? 'has an assignment' : `has ${used.length} assignments`}. Remove the assignments first.`);
    return;
  }
  mutate(all.size > 1 ? 'Delete Resource and Children' : 'Delete Resource', (db) => {
    for (const t of ['RSRC', 'RSRCRATE', 'RSRCROLE', 'RSRCRCAT']) if (db.tables[t]) db.tables[t].rows = db.tables[t].rows.filter((r) => !all.has(r.rsrc_id));
    for (const t of rows(db, 'TASK')) if (t.rsrc_id && all.has(t.rsrc_id)) t.rsrc_id = '';
  });
  setUi({ selRsrc: undefined });
}

export function ResourcesView() {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const db = ctx.db;
  const hpd = ui.prefs.hoursPerDay;
  const [detailTab, setDetailTab] = useState('general');

  const items = useMemo(() => {
    const all = rows(db, 'RSRC');
    const ids = new Set(all.map((r) => r.rsrc_id));
    const kids = new Map<string, Row[]>();
    for (const r of all) {
      const p = r.parent_rsrc_id && ids.has(r.parent_rsrc_id) && r.parent_rsrc_id !== r.rsrc_id ? r.parent_rsrc_id : '';
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(r);
    }
    for (const l of kids.values()) l.sort((a, b) => num(a.rsrc_seq_num) - num(b.rsrc_seq_num) || (a.rsrc_short_name || '').localeCompare(b.rsrc_short_name || '', undefined, { numeric: true }));
    const units = new Map(rows(db, 'UMEASURE').map((u) => [u.unit_id, u.unit_abbrev || u.unit_name]));
    const out: GridItem[] = [];
    const seen = new Set<string>();
    const visit = (r: Row, level: number) => {
      if (seen.has(r.rsrc_id)) return;
      seen.add(r.rsrc_id);
      const ch = kids.get(r.rsrc_id) ?? [];
      const collapsed = !!ui.collapsed[`rs:${r.rsrc_id}`];
      const lr = latestRate(db, r.rsrc_id);
      const sfx = unitSuffix(r);
      out.push({
        key: `r:${r.rsrc_id}`, kind: 'row', level, hasChildren: ch.length > 0, collapsed,
        icon: <svg className="acticon" viewBox="0 0 10 10">{r.rsrc_type === 'RT_Mat' ? <rect x="1" y="2" width="8" height="6" fill="#c9a26b" stroke="#7a5a20" strokeWidth=".6" /> : r.rsrc_type === 'RT_Equip' ? <path d="M1 7h8v2H1zM2 3h5l1 4H2z" fill="#9aa8b8" stroke="#4a5868" strokeWidth=".6" /> : <><circle cx="5" cy="3" r="2" fill="#5b8bd0" /><path d="M1.5 10c0-3 1.5-4.5 3.5-4.5S8.5 7 8.5 10z" fill="#5b8bd0" /></>}</svg>,
        className: r.active_flag === 'N' ? 'inactive' : undefined,
        style: r.active_flag === 'N' ? { color: '#888' } : undefined,
        cells: {
          id: r.rsrc_short_name, name: r.rsrc_name, type: RSRC_TYPES[r.rsrc_type] ?? r.rsrc_type, unit: units.get(r.unit_id) ?? '',
          def: `${fmtN(num(r.def_qty_per_hr) * hpd)}${sfx}`, max: `${fmtN(maxPerHr(db, r) * hpd)}${sfx}`,
          price: lr ? `${money(num(lr.cost_per_qty))}/${r.rsrc_type === 'RT_Mat' ? (units.get(r.unit_id) || 'u') : 'h'}` : '',
          cal: ctx.cal.get(r.clndr_id)?.clndr_name ?? '', active: r.active_flag === 'N' ? 'No' : 'Yes',
        },
      });
      if (!collapsed) for (const c of ch) visit(c, level + 1);
      else for (const c of ch) markSeen(c);
    };
    const markSeen = (r: Row) => { if (seen.has(r.rsrc_id)) return; seen.add(r.rsrc_id); for (const c of kids.get(r.rsrc_id) ?? []) markSeen(c); };
    for (const r of kids.get('') ?? []) visit(r, 0);
    for (const r of all) if (!seen.has(r.rsrc_id)) visit(r, 0); // cycles in parent links
    return out;
  }, [ctx, db, ui.collapsed, hpd]);

  const getEditor = (key: string, col: string): EditorSpec | null => {
    const r = ctx.rsrc.get(key.slice(2));
    if (!r) return null;
    switch (col) {
      case 'id': return { type: 'text', value: r.rsrc_short_name };
      case 'name': return { type: 'text', value: r.rsrc_name };
      case 'type': return { type: 'select', value: r.rsrc_type || 'RT_Labor', options: RSRC_TYPES };
      case 'def': return { type: 'number', value: fmtN(num(r.def_qty_per_hr) * hpd) };
      case 'max': return { type: 'number', value: fmtN(maxPerHr(db, r) * hpd) };
      case 'price': return { type: 'number', value: String(num(latestRate(db, r.rsrc_id)?.cost_per_qty)) };
      case 'active': return { type: 'select', value: r.active_flag === 'N' ? 'N' : 'Y', options: { Y: 'Yes', N: 'No' } };
      default: return null;
    }
  };

  const onCommit = (key: string, col: string, v: string) => commitCell(key.slice(2), col, v, hpd);

  const selKey = ui.selRsrc ? `r:${ui.selRsrc}` : '';
  const menu = (k: string | null, e: RME) => {
    const id = k?.slice(2);
    if (id) setUi({ selRsrc: id });
    const parent = id ? ctx.rsrc.get(id)?.parent_rsrc_id ?? '' : '';
    showContextMenu(e, [
      { label: 'Add Resource', onClick: () => addResource(id && ctx.rsrc.has(parent) ? parent : '') },
      ...(id ? [
        { label: 'Add Child Resource', onClick: () => addResource(id) },
        { label: 'Delete Resource', onClick: () => deleteResource(id) },
        { sep: true, label: '' },
        { label: 'Assignments...', onClick: () => setDetailTab('assignments') },
      ] : []),
      { sep: true, label: '' },
      { label: 'Expand All', onClick: () => setUi((u) => ({ collapsed: Object.fromEntries(Object.entries(u.collapsed).filter(([k2]) => !k2.startsWith('rs:'))) })) },
      { label: 'Collapse All', onClick: () => setUi((u) => ({ collapsed: { ...u.collapsed, ...Object.fromEntries(rows(db, 'RSRC').map((r) => [`rs:${r.rsrc_id}`, true])) } })) },
    ]);
  };
  const sel = ui.selRsrc ? ctx.rsrc.get(ui.selRsrc) : undefined;
  const selParent = sel?.parent_rsrc_id && ctx.rsrc.has(sel.parent_rsrc_id) ? sel.parent_rsrc_id : '';

  return (
    <>
      <div className="layoutbar">
        <button className="btn" onClick={() => addResource(selParent)}>Add Resource</button>
        <button className="btn" disabled={!sel} onClick={() => sel && addResource(sel.rsrc_id)}>Add Child</button>
        <button className="btn" disabled={!sel} onClick={() => sel && deleteResource(sel.rsrc_id)}>Delete</button>
        <span>Resources in the dictionary: <b>{rows(db, 'RSRC').length}</b></span>
        <span className="muted">Double-click a cell (or F2) to edit. Units/time shown per day ({hpd}h).</span>
      </div>
      <div className="winbody">
        <Split dir="v" initial={300} storeKey="resources">
          <Grid cols={COLS} items={items} selected={new Set(selKey ? [selKey] : [])}
            onSelect={(k) => setUi({ selRsrc: k.slice(2) })}
            onToggle={(k) => setUi((u) => ({ collapsed: { ...u.collapsed, [`rs:${k.slice(2)}`]: !u.collapsed[`rs:${k.slice(2)}`] } }))}
            getEditor={getEditor} onCommit={onCommit} onContextMenu={menu}
            emptyText="The resource dictionary is empty. Use Add Resource or import an XER file with resources." />
          <div className="details">
            <Tabs tabs={TABS} value={detailTab} onChange={setDetailTab} />
            {!sel ? <div className="tabbody muted">Select a resource to see its details.</div> : (
              <>
                <div style={{ padding: '3px 10px', background: '#e8e8e8', borderBottom: '1px solid #ccc' }}>
                  <b>Resource</b> {sel.rsrc_short_name} &nbsp; {sel.rsrc_name}
                </div>
                <DetailBody tab={detailTab} r={sel} ctx={ctx} />
              </>
            )}
          </div>
        </Split>
      </div>
    </>
  );
}

function commitCell(id: string, col: string, v: string, hpd: number): void {
  switch (col) {
    case 'id': return editRsrc(id, 'Edit Resource ID', (r, db) => {
      const s = v.trim();
      if (!s) return 'Resource ID cannot be blank.';
      if (rows(db, 'RSRC').some((x) => x.rsrc_id !== id && x.rsrc_short_name === s)) return `Resource ID ${s} already exists.`;
      if (s === r.rsrc_short_name) return;
      r.rsrc_short_name = s;
    });
    case 'name': return editRsrc(id, 'Edit Resource Name', (r) => { r.rsrc_name = v; });
    case 'type': return setType(id, v);
    case 'def': return editRsrc(id, 'Edit Default Units/Time', (r) => {
      const n = parseNum(v);
      if (!(n >= 0)) return 'Units/time must be zero or greater.';
      r.def_qty_per_hr = p6num(n / hpd);
    });
    case 'max': return setMax(id, parseNum(v) / hpd);
    case 'price': return setPrice(id, parseNum(v));
    case 'active': return editRsrc(id, 'Edit Resource Active', (r) => { r.active_flag = v === 'N' ? 'N' : 'Y'; });
  }
}

function setType(id: string, v: string): void {
  editRsrc(id, 'Change Resource Type', (r) => { r.rsrc_type = v; }, (db) => {
    for (const a of rows(db, 'TASKRSRC')) if (a.rsrc_id === id) a.rsrc_type = v;
  });
}

function setMax(id: string, perHr: number): void {
  if (!(perHr >= 0)) return toast('Max units/time must be zero or greater.');
  editRsrc(id, 'Edit Max Units/Time', (r) => { r.max_qty_per_hr = p6num(perHr); }, (db) => setLatestRate(db, id, { max_qty_per_hr: p6num(perHr) }));
}

function setPrice(id: string, price: number): void {
  if (!(price >= 0)) return toast('Price/unit must be zero or greater.');
  mutate('Edit Resource Price', (db) => {
    setLatestRate(db, id, { cost_per_qty: p6num(price) });
    recostResource(db, id);
  });
}

function DetailBody({ tab, r, ctx }: { tab: string; r: Row; ctx: Ctx }) {
  switch (tab) {
    case 'units': return <UnitsPrices r={r} ctx={ctx} />;
    case 'roles': return <Roles r={r} ctx={ctx} />;
    case 'assignments': return <Assignments r={r} ctx={ctx} />;
    default: return <General r={r} ctx={ctx} />;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <><label>{label}</label>{children}</>;
}

function General({ r, ctx }: { r: Row; ctx: Ctx }) {
  const cals = [...ctx.cal.values()].filter((c) => c.clndr_type !== 'CA_Project' || c.clndr_id === r.clndr_id);
  const units = rows(ctx.db, 'UMEASURE');
  const text = (field: string, label: string, title: string) => (
    <Field label={title}><input defaultValue={r[field] ?? ''} key={r.rsrc_id + field + (r[field] ?? '')}
      onBlur={(e) => { if (e.target.value !== (r[field] ?? '')) editRsrc(r.rsrc_id, label, (x) => { x[field] = e.target.value; }); }} /></Field>
  );
  return (
    <div className="tabbody">
      <div className="form">
        <Field label="Resource ID"><input defaultValue={r.rsrc_short_name} key={r.rsrc_id + r.rsrc_short_name}
          onBlur={(e) => { if (e.target.value !== r.rsrc_short_name) commitCell(r.rsrc_id, 'id', e.target.value, ctx.prefs.hoursPerDay); }} /></Field>
        {text('rsrc_name', 'Edit Resource Name', 'Resource Name')}
        <Field label="Resource Type"><select value={r.rsrc_type || 'RT_Labor'} onChange={(e) => setType(r.rsrc_id, e.target.value)}>
          {Object.entries(RSRC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Calendar"><select value={r.clndr_id || ''} onChange={(e) => editRsrc(r.rsrc_id, 'Change Resource Calendar', (x) => { x.clndr_id = e.target.value; })}>
          {!ctx.cal.has(r.clndr_id) && <option value={r.clndr_id || ''}>{r.clndr_id ? `(missing calendar ${r.clndr_id})` : '<None>'}</option>}
          {cals.map((c) => <option key={c.clndr_id} value={c.clndr_id}>{c.clndr_name}{c.clndr_type === 'CA_Rsrc' ? ' (resource)' : ''}</option>)}</select></Field>
        {text('email_addr', 'Edit Resource E-mail', 'E-mail Address')}
        {text('rsrc_title_name', 'Edit Resource Title', 'Title')}
        {text('employee_code', 'Edit Employee ID', 'Employee ID')}
        <Field label="Unit of Measure"><select value={r.unit_id || ''} onChange={(e) => editRsrc(r.rsrc_id, 'Change Unit of Measure', (x) => { x.unit_id = e.target.value; })}>
          <option value="">&lt;None&gt;</option>
          {units.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.unit_abbrev} {u.unit_name ? `- ${u.unit_name}` : ''}</option>)}</select></Field>
        <Field label="Default Units/Time"><input type="number" step="0.5" defaultValue={fmtN(num(r.def_qty_per_hr) * ctx.prefs.hoursPerDay)} key={r.rsrc_id + 'def' + r.def_qty_per_hr}
          onBlur={(e) => { if (fmtN(num(r.def_qty_per_hr) * ctx.prefs.hoursPerDay) !== e.target.value) commitCell(r.rsrc_id, 'def', e.target.value, ctx.prefs.hoursPerDay); }} /></Field>
        <Field label="Overtime Factor"><input type="number" step="0.1" defaultValue={r.ot_factor || ''} key={r.rsrc_id + 'ot' + r.ot_factor}
          onBlur={(e) => { if (e.target.value !== (r.ot_factor || '')) editRsrc(r.rsrc_id, 'Edit Overtime Factor', (x) => { const n = Number(e.target.value); if (!(n >= 0)) return 'Overtime factor must be zero or greater.'; x.ot_factor = p6num(n); }); }} /></Field>
        <label><input type="checkbox" checked={r.active_flag !== 'N'} onChange={(e) => editRsrc(r.rsrc_id, 'Edit Resource Active', (x) => { x.active_flag = e.target.checked ? 'Y' : 'N'; })} /> Active</label>
        <span />
        <label><input type="checkbox" checked={r.level_flag !== 'N'} onChange={(e) => editRsrc(r.rsrc_id, 'Edit Level During Resource Leveling', (x) => { x.level_flag = e.target.checked ? 'Y' : 'N'; })} /> Level During Resource Leveling</label>
        <span />
      </div>
    </div>
  );
}

function UnitsPrices({ r, ctx }: { r: Row; ctx: Ctx }) {
  const [sel, setSel] = useState<string | null>(null);
  const hpd = ctx.prefs.hoursPerDay;
  const list = ratesOf(ctx.db, r.rsrc_id);
  const editRate = (rateId: string, label: string, fn: (x: Row) => string | void, recost: boolean) => {
    const cur = list.find((x) => x.rsrc_rate_id === rateId);
    if (!cur) return;
    const copy = { ...cur };
    const err = fn(copy);
    if (err) return toast(err);
    mutate(label, (db) => {
      const x = rows(db, 'RSRCRATE').find((y) => y.rsrc_rate_id === rateId);
      if (x) Object.assign(x, copy);
      if (recost) recostResource(db, r.rsrc_id);
    });
  };
  const add = () => mutate('Add Resource Price', (db) => {
    const R = table(db, 'RSRCRATE');
    for (const f of ['rsrc_rate_id', 'rsrc_id', 'max_qty_per_hr', 'cost_per_qty', 'start_date']) addField(R, f);
    const last = ratesOf(db, r.rsrc_id).at(-1);
    const today = new Date();
    let start = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')} 00:00`;
    if (last?.start_date && last.start_date >= start) {
      const d = new Date(Date.parse(last.start_date.slice(0, 10) + 'T00:00:00Z') + 86400000);
      start = `${d.toISOString().slice(0, 10)} 00:00`;
    }
    R.rows.push({ rsrc_rate_id: String(nextId(db, 'RSRCRATE')), rsrc_id: r.rsrc_id, max_qty_per_hr: last?.max_qty_per_hr || r.max_qty_per_hr || '1', cost_per_qty: last?.cost_per_qty || '0', start_date: last ? start : '' });
  });
  const remove = () => {
    if (!sel) return;
    mutate('Remove Resource Price', (db) => {
      db.tables.RSRCRATE.rows = db.tables.RSRCRATE.rows.filter((x) => x.rsrc_rate_id !== sel);
      recostResource(db, r.rsrc_id);
    });
    setSel(null);
  };
  return (
    <div className="tabbody flush">
      <div style={{ padding: '3px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <button className="btn" onClick={add}>Add</button>
        <button className="btn" disabled={!sel || !list.some((x) => x.rsrc_rate_id === sel)} onClick={remove}>Remove</button>
        <span className="muted">Prices change assignment costs (except assignments whose cost is not linked to units).</span>
      </div>
      <div className="tblwrap" style={{ flex: 1, margin: '0 6px 6px' }}>
        <table className="tbl">
          <thead><tr><th style={{ width: 140 }}>Effective Date</th><th style={{ width: 120 }}>Price / Unit</th><th style={{ width: 120 }}>Max Units / Time ({unitSuffix(r)})</th><th /></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.rsrc_rate_id} className={sel === x.rsrc_rate_id ? 'sel' : ''} onMouseDown={() => setSel(x.rsrc_rate_id)}>
                <td><input type="date" value={(x.start_date || '').slice(0, 10)} style={{ width: 120 }}
                  onChange={(e) => editRate(x.rsrc_rate_id, 'Edit Price Effective Date', (y) => { y.start_date = e.target.value ? `${e.target.value} 00:00` : ''; }, true)} /></td>
                <td><input type="number" step="0.01" defaultValue={num(x.cost_per_qty)} key={x.rsrc_rate_id + 'c' + x.cost_per_qty} style={{ width: 100 }}
                  onBlur={(e) => { if (Number(e.target.value) !== num(x.cost_per_qty)) editRate(x.rsrc_rate_id, 'Edit Resource Price', (y) => { const n = Number(e.target.value); if (!(n >= 0)) return 'Price/unit must be zero or greater.'; y.cost_per_qty = p6num(n); }, true); }} /></td>
                <td><input type="number" step="0.5" defaultValue={fmtN(num(x.max_qty_per_hr) * hpd)} key={x.rsrc_rate_id + 'm' + x.max_qty_per_hr} style={{ width: 100 }}
                  onBlur={(e) => { if (e.target.value !== fmtN(num(x.max_qty_per_hr) * hpd)) editRate(x.rsrc_rate_id, 'Edit Max Units/Time', (y) => { const n = Number(e.target.value); if (!(n >= 0)) return 'Max units/time must be zero or greater.'; y.max_qty_per_hr = p6num(n / hpd); }, false); }} /></td>
                <td />
              </tr>
            ))}
            {!list.length && <tr><td colSpan={4} className="muted">No prices. Click Add.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Roles({ r, ctx }: { r: Row; ctx: Ctx }) {
  const [sel, setSel] = useState<number | null>(null);
  const roles = rows(ctx.db, 'ROLES');
  const roleById = new Map(roles.map((x) => [x.role_id, x]));
  const all = rows(ctx.db, 'RSRCROLE');
  const list = all.map((x, i) => ({ x, i })).filter(({ x }) => x.rsrc_id === r.rsrc_id);
  const fill = (x: Row, roleId: string) => {
    const role = roleById.get(roleId);
    x.role_id = roleId;
    x.role_short_name = role?.role_short_name ?? '';
    x.role_name = role?.role_name ?? '';
  };
  const add = () => {
    const taken = new Set(list.map(({ x }) => x.role_id));
    const role = roles.find((x) => !taken.has(x.role_id));
    if (!roles.length) return toast('No roles are defined. Use Enterprise > Roles to add roles.');
    if (!role) return toast('All roles are already assigned to this resource.');
    mutate('Assign Role', (db) => {
      const T = table(db, 'RSRCROLE');
      for (const f of ['rsrc_id', 'role_id', 'skill_level', 'role_short_name', 'role_name', 'rsrc_short_name', 'rsrc_name', 'rsrc_type']) addField(T, f);
      const row: Row = { rsrc_id: r.rsrc_id, role_id: '', skill_level: '3', role_short_name: '', role_name: '', rsrc_short_name: r.rsrc_short_name, rsrc_name: r.rsrc_name, rsrc_type: r.rsrc_type };
      if (T.fields.includes('rsrc_role_id')) row.rsrc_role_id = String(Math.max(0, ...T.rows.map((y) => num(y.rsrc_role_id))) + 1);
      fill(row, role.role_id);
      T.rows.push(row);
    });
  };
  const edit = (idx: number, label: string, fn: (x: Row) => string | void) => {
    const err = fn({ ...all[idx] });
    if (err) return toast(err);
    mutate(label, (db) => { const x = db.tables.RSRCROLE.rows[idx]; if (x) fn(x); });
  };
  return (
    <div className="tabbody flush">
      <div style={{ padding: '3px 6px', display: 'flex', gap: 6 }}>
        <button className="btn" onClick={add}>Assign</button>
        <button className="btn" disabled={sel == null || !list.some(({ i }) => i === sel)} onClick={() => { mutate('Remove Role', (db) => { db.tables.RSRCROLE.rows = db.tables.RSRCROLE.rows.filter((_x, i) => i !== sel); }); setSel(null); }}>Remove</button>
      </div>
      <div className="tblwrap" style={{ flex: 1, margin: '0 6px 6px' }}>
        <table className="tbl">
          <thead><tr><th style={{ width: 120 }}>Role ID</th><th style={{ width: 260 }}>Role Name</th><th style={{ width: 140 }}>Proficiency</th><th /></tr></thead>
          <tbody>
            {list.map(({ x, i }) => (
              <tr key={i} className={sel === i ? 'sel' : ''} onMouseDown={() => setSel(i)}>
                <td><select value={x.role_id} onChange={(e) => {
                  const v = e.target.value;
                  edit(i, 'Change Role', (y) => { if (list.some(({ x: z, i: j }) => j !== i && z.role_id === v)) return 'This role is already assigned to the resource.'; fill(y, v); });
                }}>
                  {!roleById.has(x.role_id) && <option value={x.role_id}>{x.role_short_name || `(missing role ${x.role_id})`}</option>}
                  {roles.map((ro) => <option key={ro.role_id} value={ro.role_id}>{ro.role_short_name}</option>)}
                </select></td>
                <td>{roleById.get(x.role_id)?.role_name ?? x.role_name}</td>
                <td><select value={x.skill_level || '3'} onChange={(e) => { const v = e.target.value; edit(i, 'Change Proficiency', (y) => { y.skill_level = v; }); }}>
                  {Object.entries(SKILLS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></td>
                <td />
              </tr>
            ))}
            {!list.length && <tr><td colSpan={4} className="muted">No roles assigned</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Assignments({ r, ctx }: { r: Row; ctx: Ctx }) {
  const list = rows(ctx.db, 'TASKRSRC').filter((a) => a.rsrc_id === r.rsrc_id);
  const p = ctx.prefs;
  const rowsOut = list.map((a) => {
    const t = ctx.taskById.get(a.task_id);
    const proj = ctx.proj.get(a.proj_id || t?.proj_id || '');
    const act = num(a.act_reg_qty) + num(a.act_ot_qty);
    const start = a.act_start_date || t?.act_start_date;
    const fin = a.act_end_date || t?.act_end_date;
    return {
      a, t, proj, act,
      start: start ? `${fmtDate(start, p)} A` : fmtDate(a.restart_date || t?.early_start_date || a.target_start_date || t?.target_start_date, p),
      finish: fin ? `${fmtDate(fin, p)} A` : fmtDate(a.reend_date || t?.early_end_date || a.target_end_date || t?.target_end_date, p),
      sortKey: `${proj?.proj_short_name ?? ''}|${t?.task_code ?? ''}`,
    };
  }).sort((x, y) => x.sortKey.localeCompare(y.sortKey, undefined, { numeric: true }));
  const tot = (f: (x: (typeof rowsOut)[number]) => number) => fmtN(rowsOut.reduce((s, x) => s + f(x), 0));
  return (
    <div className="tabbody flush">
      <div className="tblwrap" style={{ flex: 1, margin: 6 }}>
        <table className="tbl">
          <thead><tr><th>Project</th><th>Activity ID</th><th>Activity Name</th><th>Budgeted Units</th><th>Actual Units</th><th>Remaining Units</th><th>Start</th><th>Finish</th></tr></thead>
          <tbody>
            {rowsOut.map(({ a, t, proj, act, start, finish }) => (
              <tr key={a.taskrsrc_id}>
                <td>{proj?.proj_short_name ?? ''}</td><td>{t?.task_code ?? `[${a.task_id}]`}</td><td>{t?.task_name ?? ''}</td>
                <td style={{ textAlign: 'right' }}>{fmtN(num(a.target_qty))}</td><td style={{ textAlign: 'right' }}>{fmtN(act)}</td><td style={{ textAlign: 'right' }}>{fmtN(num(a.remain_qty))}</td>
                <td>{start}</td><td>{finish}</td>
              </tr>
            ))}
            {rowsOut.length > 0 && <tr style={{ fontWeight: 'bold' }}><td colSpan={3}>Total ({rowsOut.length})</td>
              <td style={{ textAlign: 'right' }}>{tot((x) => num(x.a.target_qty))}</td><td style={{ textAlign: 'right' }}>{tot((x) => x.act)}</td><td style={{ textAlign: 'right' }}>{tot((x) => num(x.a.remain_qty))}</td><td /><td /></tr>}
            {!rowsOut.length && <tr><td colSpan={8} className="muted">This resource has no assignments.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
