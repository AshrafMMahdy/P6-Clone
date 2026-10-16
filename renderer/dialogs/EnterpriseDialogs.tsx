// Enterprise dictionaries (calendars, codes, UDFs, OBS, cost accounts, roles, currencies) and
// view/tools dialogs (leveling, filters, timescale, layouts, page setup).
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog, Tabs } from '../components/Layout.tsx';
import { closeDialog, doUndo, getUi, mutate, openDialog, setUi, toast, useStore, DEFAULT_COLUMNS, type UiState } from '../store.ts';
import { addField, nextId, rows, table, type Db, type Row, type Table } from '../../core/db.ts';
import { hoursPerWeek, parseClndrData, serializeClndrData, standardCalendar, type CalendarDef, type Shift } from '../../core/calendar/clndr-data.ts';
import { formatP6Date, minutesToSerial, parseP6Date, serialToMinutes } from '../../core/dates.ts';
import { levelResources, type LevelOptions, type LevelResult } from '../../core/level/level.ts';
import { FILTERS } from '../views/activityRows.ts';

// ---------------------------------------------------------------- shared helpers

const num = (x: number) => String(Math.round(x * 100) / 100);
const NUM2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (x: number) => NUM2.format(x);
const nowStr = () => formatP6Date(Math.floor(Date.now() / 60000));

function ensureFields(d: Db, name: string, fields: string[]): Table {
  const t = table(d, name);
  for (const f of fields) addField(t, f);
  return t;
}

/** Edit one field of one row as an undoable action. */
function setField(label: string, tbl: string, key: string, id: string, field: string, value: string): void {
  mutate(label, (d) => {
    const t = table(d, tbl);
    addField(t, field);
    const r = t.rows.find((x) => x[key] === id);
    if (r) r[field] = value;
  });
}

function uniqueName(base: string, existing: string[]): string {
  const set = new Set(existing.map((s) => s.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Text cell that commits on blur / Enter; remounts when the stored value changes (undo). */
function Cell(p: { value: string; onCommit: (v: string) => void; type?: string; maxLength?: number; placeholder?: string; style?: CSSProperties; disabled?: boolean }) {
  return (
    <input key={p.value} defaultValue={p.value} type={p.type} maxLength={p.maxLength} placeholder={p.placeholder} style={p.style} disabled={p.disabled}
      onBlur={(e) => { if (e.target.value !== p.value) p.onCommit(e.target.value); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

interface TreeItem { row: Row; depth: number; hasKids: boolean }

/** Depth-first order of a parent/child table. Orphans become roots; cycles are broken. */
function treeOrder(rs: Row[], idF: string, parentF: string, seqF: string, nameF: string, collapsed: Record<string, boolean> = {}): TreeItem[] {
  const ids = new Set(rs.map((r) => r[idF]));
  const kids = new Map<string, Row[]>();
  for (const r of rs) {
    const p = r[parentF] && ids.has(r[parentF]) && r[parentF] !== r[idF] ? r[parentF] : '';
    let a = kids.get(p);
    if (!a) kids.set(p, (a = []));
    a.push(r);
  }
  for (const a of kids.values()) a.sort((x, y) => (Number(x[seqF]) || 0) - (Number(y[seqF]) || 0) || (x[nameF] ?? '').localeCompare(y[nameF] ?? ''));
  const full: TreeItem[] = [];
  const seen = new Set<string>();
  const visit = (p: string, depth: number) => {
    for (const r of kids.get(p) ?? []) {
      if (seen.has(r[idF])) continue;
      seen.add(r[idF]);
      full.push({ row: r, depth, hasKids: (kids.get(r[idF])?.length ?? 0) > 0 });
      visit(r[idF], depth + 1);
    }
  };
  visit('', 0);
  for (const r of rs) if (!seen.has(r[idF])) { seen.add(r[idF]); full.push({ row: r, depth: 0, hasKids: (kids.get(r[idF])?.length ?? 0) > 0 }); visit(r[idF], 1); }
  const out: TreeItem[] = [];
  let hide = Infinity;
  for (const it of full) {
    if (it.depth > hide) continue;
    hide = Infinity;
    out.push(it);
    if (it.hasKids && collapsed[it.row[idF]]) hide = it.depth;
  }
  return out;
}

function subtree(rs: Row[], idF: string, parentF: string, root: string): Set<string> {
  const s = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rs) if (s.has(r[parentF]) && !s.has(r[idF])) { s.add(r[idF]); grew = true; }
  }
  return s;
}

function addTreeRow(d: Db, tbl: string, idF: string, parentF: string, seqF: string, fields: string[], parent: string, init: Row): string {
  const t = ensureFields(d, tbl, fields);
  const id = String(nextId(d, tbl));
  const seq = Math.max(0, ...t.rows.filter((r) => (r[parentF] || '') === parent).map((r) => Number(r[seqF]) || 0)) + 1;
  t.rows.push({ ...Object.fromEntries(t.fields.map((f) => [f, ''])), ...init, [idF]: id, [parentF]: parent, [seqF]: String(seq) });
  return id;
}

function TreeTable(p: {
  items: TreeItem[]; idField: string; sel: string | null; onSel: (id: string) => void;
  collapsed: Record<string, boolean>; onToggle: (id: string) => void;
  headers: [string, number?][]; cells: (r: Row) => ReactNode[]; height: number | string; empty: string;
}) {
  return (
    <div className="tblwrap" style={{ height: p.height }}>
      <table className="tbl">
        <thead><tr>{p.headers.map(([h, w]) => <th key={h} style={{ width: w }}>{h}</th>)}</tr></thead>
        <tbody>
          {p.items.map((it) => {
            const id = it.row[p.idField];
            const c = p.cells(it.row);
            return (
              <tr key={id} className={p.sel === id ? 'sel' : ''} onMouseDown={() => p.onSel(id)}>
                <td style={{ paddingLeft: 4 + it.depth * 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    {it.hasKids
                      ? <span className="twisty" onMouseDown={(e) => { e.stopPropagation(); p.onToggle(id); }}>{p.collapsed[id] ? '+' : '-'}</span>
                      : <span style={{ display: 'inline-block', width: 15, flex: 'none' }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>{c[0]}</div>
                  </div>
                </td>
                {c.slice(1).map((x, i) => <td key={i}>{x}</td>)}
              </tr>
            );
          })}
          {!p.items.length && <tr><td colSpan={p.headers.length} className="muted">{p.empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const toolbarRow: CSSProperties = { display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center', flexWrap: 'wrap' };
const smallBtn: CSSProperties = { minWidth: 0 };

// ---------------------------------------------------------------- 1. Calendars

const CAL_FIELDS = ['clndr_id', 'default_flag', 'clndr_name', 'proj_id', 'base_clndr_id', 'last_chng_date', 'clndr_type', 'day_hr_cnt', 'week_hr_cnt', 'month_hr_cnt', 'year_hr_cnt', 'rsrc_private', 'clndr_data'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DEFAULT_DAY: Shift[] = [{ start: 480, end: 720 }, { start: 780, end: 1020 }];
const DAY_MS = 86400000;

type CalKind = 'global' | 'project' | 'resource';
function calKind(r: Row): CalKind {
  if (r.clndr_type === 'CA_Rsrc') return 'resource';
  if (r.clndr_type === 'CA_Project' || r.proj_id) return 'project';
  return 'global';
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const shiftsText = (ss: Shift[]) => ss.map((s) => `${hhmm(s.start)}-${hhmm(s.end)}`).join(', ');
const shiftHours = (ss: Shift[]) => ss.reduce((a, s) => a + s.end - s.start, 0) / 60;

/** "08:00-12:00, 13:00-17:00" -> shifts; empty = nonwork; returns an error message when invalid. */
function parseShifts(text: string): Shift[] | string {
  const out: Shift[] = [];
  for (const part of text.split(/[,;]+/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/.exec(p);
    if (!m) return `"${p}" is not a time range like 08:00-12:00`;
    const sm = Number(m[2] ?? 0), em = Number(m[4] ?? 0);
    if (sm >= 60 || em >= 60) return `"${p}": minutes must be 00-59`;
    const start = Number(m[1]) * 60 + sm, end = Number(m[3]) * 60 + em;
    if (start >= 1440 || end > 1440) return `"${p}": times must be between 00:00 and 24:00`;
    if (end <= start) return `"${p}": the finish must be after the start`;
    out.push({ start, end });
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) return `shifts ${shiftsText([out[i - 1]])} and ${shiftsText([out[i]])} overlap`;
  return out;
}

function tryParseCal(s: string | undefined): CalendarDef | string {
  try { return parseClndrData(s ?? ''); } catch (e) { return (e as Error).message; }
}

const cloneCal = (c: CalendarDef): CalendarDef => ({ week: c.week.map((ss) => ss.map((x) => ({ ...x }))), exceptions: new Map([...c.exceptions].map(([k, v]) => [k, v.map((x) => ({ ...x }))])) });

function writeCal(label: string, clndrId: string, def: CalendarDef): void {
  mutate(label, (d) => {
    const t = ensureFields(d, 'CALENDAR', CAL_FIELDS);
    const r = t.rows.find((x) => x.clndr_id === clndrId);
    if (!r) return;
    r.clndr_data = serializeClndrData(def);
    const wk = hoursPerWeek(def);
    const days = def.week.filter((s) => s.length).length;
    r.week_hr_cnt = num(wk);
    r.day_hr_cnt = num(days ? wk / days : 0);
    r.last_chng_date = nowStr();
  });
}

export function CalendarsDialog() {
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const ui = useStore((s) => s.ui);
  const cals = rows(db, 'CALENDAR');
  const [sel, setSel] = useState<string | null>(() => (cals.find((c) => c.default_flag === 'Y') ?? cals[0])?.clndr_id ?? null);
  const [month, setMonth] = useState(() => {
    const p = rows(db, 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
    const t = parseP6Date(p?.last_recalc_date || p?.plan_start_date) ?? Date.now() / 60000;
    const d = new Date(t * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  });
  const cur = cals.find((c) => c.clndr_id === sel);
  const projName = (id: string) => rows(db, 'PROJECT').find((p) => p.proj_id === id)?.proj_short_name ?? id;

  const add = () => {
    let id = '';
    mutate('Add Calendar', (d) => {
      const t = ensureFields(d, 'CALENDAR', CAL_FIELDS);
      const def = t.rows.find((c) => c.default_flag === 'Y' && calKind(c) === 'global') ?? t.rows.find((c) => c.default_flag === 'Y');
      id = String(nextId(d, 'CALENDAR'));
      const data = def?.clndr_data || serializeClndrData(standardCalendar());
      const parsed = tryParseCal(data);
      const wk = typeof parsed === 'string' ? 40 : hoursPerWeek(parsed);
      const days = typeof parsed === 'string' ? 5 : parsed.week.filter((s) => s.length).length;
      t.rows.push({
        ...Object.fromEntries(t.fields.map((f) => [f, ''])),
        clndr_id: id, default_flag: t.rows.length ? 'N' : 'Y', clndr_name: uniqueName('New Calendar', t.rows.map((c) => c.clndr_name)), proj_id: '', base_clndr_id: '',
        last_chng_date: nowStr(), clndr_type: 'CA_Base', day_hr_cnt: num(days ? wk / days : 0), week_hr_cnt: num(wk),
        month_hr_cnt: def?.month_hr_cnt || num(wk * 52 / 12), year_hr_cnt: def?.year_hr_cnt || num(wk * 52), rsrc_private: 'N', clndr_data: data,
      });
    });
    setSel(id);
  };

  const del = () => {
    if (!cur) return;
    const id = cur.clndr_id;
    const nt = rows(db, 'TASK').filter((t) => t.clndr_id === id).length;
    const np = rows(db, 'PROJECT').filter((p) => p.clndr_id === id).length;
    const nr = rows(db, 'RSRC').filter((r) => r.clndr_id === id).length;
    if (nt || np || nr) return toast(`Calendar "${cur.clndr_name}" cannot be deleted: it is assigned to ${[nt && `${nt} activit${nt > 1 ? 'ies' : 'y'}`, np && `${np} project(s)`, nr && `${nr} resource(s)`].filter(Boolean).join(', ')}.`);
    const nb = cals.filter((c) => c.base_clndr_id === id && c.clndr_id !== id).length;
    if (nb) return toast(`Calendar "${cur.clndr_name}" cannot be deleted: it is the base calendar of ${nb} other calendar(s).`);
    if (cur.default_flag === 'Y') return toast('The default calendar cannot be deleted. Set another calendar as default first.');
    mutate('Delete Calendar', (d) => { table(d, 'CALENDAR').rows = rows(d, 'CALENDAR').filter((c) => c.clndr_id !== id); });
    setSel(null);
  };

  const setDefault = () => {
    if (!cur) return;
    if (calKind(cur) !== 'global') return toast('Only a global calendar can be the default calendar.');
    const id = cur.clndr_id;
    mutate('Set Default Calendar', (d) => { for (const c of ensureFields(d, 'CALENDAR', CAL_FIELDS).rows) c.default_flag = c.clndr_id === id ? 'Y' : 'N'; });
  };

  const groups: [CalKind, string][] = [['global', 'Global'], ['project', 'Project'], ['resource', 'Resource']];
  return (
    <Dialog title="Calendars" width={1080} height={640} buttons={<>
      <button className="btn" onClick={add}>Add</button>
      <button className="btn" disabled={!cur} onClick={del}>Delete</button>
      <button className="btn" disabled={!cur || cur.default_flag === 'Y'} onClick={setDefault}>Set As Default</button>
      <button className="btn primary" onClick={closeDialog}>Close</button>
    </>}>
      <div style={{ display: 'flex', gap: 10, height: '100%', minHeight: 0 }}>
        <div className="tblwrap" style={{ width: 270, flex: 'none', height: '100%' }}>
          <table className="tbl">
            <thead><tr><th>Calendar Name</th><th style={{ width: 50 }}>Default</th><th style={{ width: 60 }}>Project</th></tr></thead>
            <tbody>
              {groups.map(([k, label]) => {
                const list = cals.filter((c) => calKind(c) === k).sort((a, b) => a.clndr_name.localeCompare(b.clndr_name));
                if (!list.length && k !== 'global') return null;
                return [
                  <tr key={`g-${k}`}><td colSpan={3} style={{ fontWeight: 'bold', background: '#e3e3e3' }}>{label} ({list.length})</td></tr>,
                  ...list.map((c) => (
                    <tr key={c.clndr_id} className={sel === c.clndr_id ? 'sel' : ''} onMouseDown={() => setSel(c.clndr_id)}>
                      <td style={{ paddingLeft: 14 }}>{c.clndr_name || '(unnamed)'}</td>
                      <td style={{ textAlign: 'center' }}>{c.default_flag === 'Y' ? '✓' : ''}</td>
                      <td>{c.proj_id ? projName(c.proj_id) : ''}</td>
                    </tr>
                  )),
                ];
              })}
              {!cals.length && <tr><td colSpan={3} className="muted">No calendars. Click Add.</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {cur ? <CalendarEditor key={cur.clndr_id} cal={cur} cals={cals} db={db} month={month} setMonth={setMonth} /> : <div className="empty">Select a calendar.</div>}
        </div>
      </div>
    </Dialog>
  );
}

function CalendarEditor(p: { cal: Row; cals: Row[]; db: Db; month: { y: number; m: number }; setMonth: (m: { y: number; m: number }) => void }) {
  const { cal, cals, db, month } = p;
  const [selDay, setSelDay] = useState<number | null>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => tryParseCal(cal.clndr_data), [cal.clndr_data]);
  const base = cal.base_clndr_id && cal.base_clndr_id !== cal.clndr_id ? cals.find((c) => c.clndr_id === cal.base_clndr_id) : undefined;
  const baseParsed = useMemo(() => (base ? tryParseCal(base.clndr_data) : null), [base?.clndr_data]); // eslint-disable-line react-hooks/exhaustive-deps
  const baseDef = baseParsed && typeof baseParsed !== 'string' ? baseParsed : null;
  const kind = calKind(cal);
  const id = cal.clndr_id;

  const header = (
    <fieldset><legend>General</legend>
      <div className="form" style={{ gridTemplateColumns: 'auto 1fr auto 1fr' }}>
        <label>Calendar Name</label>
        <Cell value={cal.clndr_name} onCommit={(v) => { if (!v.trim()) return toast('Calendar name is required.'); setField('Rename Calendar', 'CALENDAR', 'clndr_id', id, 'clndr_name', v.trim()); }} />
        <label>Type</label>
        <input readOnly value={{ global: 'Global', project: 'Project', resource: 'Resource' }[kind] + (cal.default_flag === 'Y' ? ' (Default)' : '')} />
        <label>Base Calendar</label>
        <select value={cal.base_clndr_id} disabled={kind === 'global'} onChange={(e) => setField('Change Base Calendar', 'CALENDAR', 'clndr_id', id, 'base_clndr_id', e.target.value)}>
          <option value="">(none)</option>
          {cals.filter((c) => calKind(c) === 'global' && c.clndr_id !== id).map((c) => <option key={c.clndr_id} value={c.clndr_id}>{c.clndr_name}</option>)}
          {cal.base_clndr_id && !cals.some((c) => c.clndr_id === cal.base_clndr_id) && <option value={cal.base_clndr_id}>(missing #{cal.base_clndr_id})</option>}
        </select>
        <label>Project</label>
        <input readOnly value={cal.proj_id ? (rows(db, 'PROJECT').find((x) => x.proj_id === cal.proj_id)?.proj_short_name ?? cal.proj_id) : ''} />
        <label>Hours per Day</label><input readOnly value={cal.day_hr_cnt} />
        <label>Hours per Week</label><input readOnly value={cal.week_hr_cnt} />
      </div>
      <div className="muted" style={{ marginTop: 4 }}>
        Used by {rows(db, 'TASK').filter((t) => t.clndr_id === id).length} activities, {rows(db, 'PROJECT').filter((x) => x.clndr_id === id).length} projects, {rows(db, 'RSRC').filter((r) => r.clndr_id === id).length} resources. Internal ID {id}.
      </div>
    </fieldset>
  );

  if (typeof parsed === 'string') {
    return (
      <div>
        {header}
        <p className="sev-error">The calendar data (clndr_data) cannot be read: {parsed}</p>
        <button className="btn" onClick={() => writeCal('Reset Calendar', id, standardCalendar())}>Reset to Standard 5-Day Workweek</button>
      </div>
    );
  }
  const def = parsed;
  const write = (label: string, nd: CalendarDef) => writeCal(label, id, nd);

  const dayInfo = (serial: number, wd: number) => {
    const own = def.exceptions.get(serial);
    const inh = own === undefined ? baseDef?.exceptions.get(serial) : undefined;
    return { own, inh, shifts: own ?? inh ?? def.week[wd] };
  };
  const workTemplate = (wd: number) => (def.week[wd].length ? def.week[wd] : def.week.find((s) => s.length) ?? DEFAULT_DAY).map((x) => ({ ...x }));
  const wdOf = (serial: number) => new Date(serialToMinutes(serial) * 60000).getUTCDay();
  const setDay = (serial: number, shifts: Shift[] | null, label: string) => {
    const nd = cloneCal(def);
    if (shifts == null) nd.exceptions.delete(serial); else nd.exceptions.set(serial, shifts);
    write(label, nd);
  };
  const toggle = (serial: number) => {
    const wd = wdOf(serial);
    const { own, shifts } = dayInfo(serial, wd);
    setSelDay(serial);
    if (own !== undefined) setDay(serial, null, 'Calendar: Standard Day');
    else if (shifts.length) setDay(serial, [], 'Calendar: Nonwork Day');
    else setDay(serial, workTemplate(wd), 'Calendar: Workday');
  };

  // month grid
  const first = Date.UTC(month.y, month.m, 1);
  const wd0 = new Date(first).getUTCDay();
  const daysIn = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate();
  const weeks = Math.ceil((wd0 + daysIn) / 7);
  const start = first - wd0 * DAY_MS;
  const cells = Array.from({ length: weeks * 7 }, (_, k) => {
    const ms = start + k * DAY_MS;
    const dt = new Date(ms);
    return { serial: minutesToSerial(ms / 60000), date: dt.getUTCDate(), inMonth: dt.getUTCMonth() === month.m, wd: dt.getUTCDay() };
  });
  const color = (info: ReturnType<typeof dayInfo>) => {
    if (info.own !== undefined) return info.own.length ? '#bcd9ff' : '#f2a8a8';
    if (info.inh !== undefined) return info.inh.length ? '#d6ecc9' : '#f7d29a';
    return info.shifts.length ? '#ffffff' : '#cfcfcf';
  };
  const go = (dm: number) => { const d = new Date(Date.UTC(month.y, month.m + dm, 1)); p.setMonth({ y: d.getUTCFullYear(), m: d.getUTCMonth() }); };
  const inheritedCount = baseDef ? [...baseDef.exceptions.keys()].filter((k) => !def.exceptions.has(k)).length : 0;
  const sd = selDay != null ? dayInfo(selDay, wdOf(selDay)) : null;
  const legend = (c: string, l: string) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginRight: 8 }}><span style={{ width: 12, height: 10, background: c, border: '1px solid #999', display: 'inline-block' }} />{l}</span>;

  return (
    <div>
      {header}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <fieldset style={{ width: 330 }}><legend>Standard Work Week</legend>
          <table className="tbl">
            <thead><tr><th style={{ width: 70 }}>Day</th><th>Work Hours (e.g. 08:00-12:00, 13:00-17:00)</th><th style={{ width: 40 }}>Hours</th></tr></thead>
            <tbody>
              {def.week.map((ss, i) => (
                <tr key={i}>
                  <td>{DAY_NAMES[i]}</td>
                  <td>
                    <input key={`${id}-${i}-${shiftsText(ss)}`} defaultValue={shiftsText(ss)} placeholder="Nonwork"
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      onBlur={(e) => {
                        const v = parseShifts(e.target.value);
                        if (typeof v === 'string') { toast(`${DAY_NAMES[i]}: ${v}`); e.target.value = shiftsText(ss); return; }
                        if (shiftsText(v) === shiftsText(ss)) { e.target.value = shiftsText(ss); return; }
                        const nd = cloneCal(def);
                        nd.week[i] = v;
                        write('Edit Work Week', nd);
                      }} />
                  </td>
                  <td style={{ textAlign: 'right' }}>{num(shiftHours(ss))}</td>
                </tr>
              ))}
              <tr><td colSpan={2} style={{ textAlign: 'right', fontWeight: 'bold' }}>Total per week</td><td style={{ textAlign: 'right', fontWeight: 'bold' }}>{num(hoursPerWeek(def))}</td></tr>
            </tbody>
          </table>
          <div className="muted" style={{ marginTop: 4, whiteSpace: 'normal' }}>Leave a day empty to make it a nonwork day. Hours/day = weekly hours / workdays.</div>
        </fieldset>

        <fieldset style={{ width: 310 }}><legend>Exceptions</legend>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <button className="btn" style={smallBtn} title="Previous year" onClick={() => go(-12)}>«</button>
            <button className="btn" style={smallBtn} title="Previous month" onClick={() => go(-1)}>‹</button>
            <b style={{ flex: 1, textAlign: 'center' }}>{MONTHS[month.m]} {month.y}</b>
            <button className="btn" style={smallBtn} title="Next month" onClick={() => go(1)}>›</button>
            <button className="btn" style={smallBtn} title="Next year" onClick={() => go(12)}>»</button>
          </div>
          <table style={{ borderCollapse: 'collapse', background: '#fff', width: '100%', tableLayout: 'fixed' }}>
            <thead><tr>{DAY_NAMES.map((d) => <th key={d} style={{ fontWeight: 'normal', background: '#e8e8e8', border: '1px solid #c8c8c8', padding: 1 }}>{d.slice(0, 3)}</th>)}</tr></thead>
            <tbody>
              {Array.from({ length: weeks }, (_, w) => (
                <tr key={w}>
                  {cells.slice(w * 7, w * 7 + 7).map((c) => {
                    const info = dayInfo(c.serial, c.wd);
                    const tip = `${formatP6Date(serialToMinutes(c.serial)).slice(0, 10)}: ${info.shifts.length ? shiftsText(info.shifts) : 'Nonwork'}${info.own !== undefined ? ' (exception)' : info.inh !== undefined ? ' (inherited from base calendar)' : ''}`;
                    return (
                      <td key={c.serial} title={tip} onClick={() => toggle(c.serial)}
                        style={{ height: 26, textAlign: 'center', cursor: 'default', border: selDay === c.serial ? '2px solid #316ac5' : '1px solid #c8c8c8', background: color(info), color: c.inMonth ? '#000' : '#999', fontWeight: info.own !== undefined ? 'bold' : 'normal' }}>
                        {c.date}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 4, lineHeight: '16px' }}>
            {legend('#ffffff', 'Workday')}{legend('#cfcfcf', 'Nonwork')}{legend('#f2a8a8', 'Holiday')}{legend('#bcd9ff', 'Custom hours')}
            {base && <>{legend('#f7d29a', 'Inherited holiday')}{legend('#d6ecc9', 'Inherited workday')}</>}
          </div>
          <div className="muted" style={{ whiteSpace: 'normal' }}>
            Click a day to toggle: workday → holiday, exception → standard, nonwork → workday. {def.exceptions.size} exception(s){base ? `, ${inheritedCount} inherited from "${base.clndr_name}"` : ''}.
          </div>
          {selDay != null && sd && (
            <div style={{ marginTop: 6, borderTop: '1px solid #c8c8c8', paddingTop: 4 }}>
              <div><b>{DAY_NAMES[wdOf(selDay)]} {formatP6Date(serialToMinutes(selDay)).slice(0, 10)}</b>: {sd.shifts.length ? `${shiftsText(sd.shifts)} (${num(shiftHours(sd.shifts))} h)` : 'Nonwork'}
                {sd.own !== undefined ? ' · exception' : sd.inh !== undefined ? ' · inherited' : ' · standard'}</div>
              <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
                <input ref={customRef} key={`${selDay}-${shiftsText(sd.shifts)}`} defaultValue={shiftsText(sd.shifts)} placeholder="08:00-12:00, 13:00-17:00" style={{ flex: 1, border: '1px solid #7f9db9', height: 19 }} />
                <button className="btn" style={smallBtn} onClick={() => {
                  const v = parseShifts(customRef.current?.value ?? '');
                  if (typeof v === 'string') return toast(v);
                  setDay(selDay, v, 'Calendar: Exception Hours');
                }}>Apply Hours</button>
              </div>
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <button className="btn" style={smallBtn} onClick={() => setDay(selDay, [], 'Calendar: Nonwork Day')}>Nonwork</button>
                <button className="btn" style={smallBtn} disabled={sd.own === undefined} onClick={() => setDay(selDay, null, 'Calendar: Standard Day')}>Standard</button>
                <button className="btn" style={smallBtn} onClick={() => setDay(selDay, workTemplate(wdOf(selDay)), 'Calendar: Workday')}>Workday</button>
              </div>
            </div>
          )}
        </fieldset>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 2. Activity Codes

const ACTVTYPE_FIELDS = ['actv_code_type_id', 'actv_short_len', 'seq_num', 'actv_code_type', 'proj_id', 'actv_code_type_scope'];
const ACTVCODE_FIELDS = ['actv_code_id', 'parent_actv_code_id', 'actv_code_type_id', 'actv_code_name', 'short_name', 'seq_num'];

export function CodesDialog() {
  const db = useStore((s) => s.db);
  const ver = useStore((s) => s.dbVersion);
  const ui = useStore((s) => s.ui);
  const types = [...rows(db, 'ACTVTYPE')].sort((a, b) => (Number(a.seq_num) || 0) - (Number(b.seq_num) || 0) || a.actv_code_type.localeCompare(b.actv_code_type));
  const [selType, setSelType] = useState<string | null>(types[0]?.actv_code_type_id ?? null);
  const [selCode, setSelCode] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const type = types.find((t) => t.actv_code_type_id === selType);
  const projects = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
  const projName = (id: string) => projects.find((p) => p.proj_id === id)?.proj_short_name ?? id;
  const codes = type ? rows(db, 'ACTVCODE').filter((c) => c.actv_code_type_id === type.actv_code_type_id) : [];
  const items = treeOrder(codes, 'actv_code_id', 'parent_actv_code_id', 'seq_num', 'short_name', collapsed);
  const assigned = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of rows(db, 'TASKACTV')) m.set(a.actv_code_id, (m.get(a.actv_code_id) ?? 0) + 1);
    return m;
  }, [db, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const code = codes.find((c) => c.actv_code_id === selCode);

  const addType = () => {
    let id = '';
    mutate('Add Activity Code', (d) => {
      const t = ensureFields(d, 'ACTVTYPE', ACTVTYPE_FIELDS);
      id = String(nextId(d, 'ACTVTYPE'));
      t.rows.push({
        ...Object.fromEntries(t.fields.map((f) => [f, ''])),
        actv_code_type_id: id, actv_short_len: '10', seq_num: String(Math.max(0, ...t.rows.map((r) => Number(r.seq_num) || 0)) + 1),
        actv_code_type: uniqueName('New Activity Code', t.rows.map((r) => r.actv_code_type)), proj_id: '', actv_code_type_scope: 'AS_Global',
      });
    });
    setSelType(id); setSelCode(null);
  };
  const delType = () => {
    if (!type) return;
    const tid = type.actv_code_type_id;
    mutate(`Delete Activity Code ${type.actv_code_type}`, (d) => {
      table(d, 'ACTVTYPE').rows = rows(d, 'ACTVTYPE').filter((r) => r.actv_code_type_id !== tid);
      if (d.tables.ACTVCODE) d.tables.ACTVCODE.rows = rows(d, 'ACTVCODE').filter((r) => r.actv_code_type_id !== tid);
      if (d.tables.TASKACTV) d.tables.TASKACTV.rows = rows(d, 'TASKACTV').filter((r) => r.actv_code_type_id !== tid);
    });
    if (getUi().groupBy === `code:${tid}`) setUi({ groupBy: 'wbs' });
    setSelType(null); setSelCode(null);
  };
  const setScope = (scope: string) => {
    if (!type) return;
    const tid = type.actv_code_type_id;
    const pid = scope === 'AS_Project' ? (type.proj_id || ui.openProjects[0] || projects[0]?.proj_id || '') : '';
    if (scope === 'AS_Project' && !pid) return toast('There is no project to assign a project code type to.');
    mutate('Activity Code Scope', (d) => {
      const r = ensureFields(d, 'ACTVTYPE', ACTVTYPE_FIELDS).rows.find((x) => x.actv_code_type_id === tid);
      if (r) { r.actv_code_type_scope = scope; r.proj_id = pid; }
    });
  };
  const addCode = (parent: string) => {
    if (!type) return;
    const tid = type.actv_code_type_id;
    let id = '';
    mutate('Add Activity Code Value', (d) => {
      const existing = rows(d, 'ACTVCODE').filter((c) => c.actv_code_type_id === tid).map((c) => c.short_name);
      let n = existing.length + 1;
      while (existing.includes(`V${n}`)) n++;
      id = addTreeRow(d, 'ACTVCODE', 'actv_code_id', 'parent_actv_code_id', 'seq_num', ACTVCODE_FIELDS, parent, { actv_code_type_id: tid, short_name: `V${n}`.slice(0, Number(type.actv_short_len) || 60), actv_code_name: 'New Value' });
    });
    if (parent) setCollapsed((c) => ({ ...c, [parent]: false }));
    setSelCode(id);
  };
  const delCode = () => {
    if (!code) return;
    const sub = subtree(codes, 'actv_code_id', 'parent_actv_code_id', code.actv_code_id);
    const n = rows(db, 'TASKACTV').filter((a) => sub.has(a.actv_code_id)).length;
    mutate('Delete Activity Code Value', (d) => {
      table(d, 'ACTVCODE').rows = rows(d, 'ACTVCODE').filter((c) => !sub.has(c.actv_code_id));
      if (d.tables.TASKACTV) d.tables.TASKACTV.rows = rows(d, 'TASKACTV').filter((a) => !sub.has(a.actv_code_id));
    });
    setSelCode(null);
    toast(`Deleted ${sub.size} code value(s)${n ? ` and removed ${n} activity assignment(s)` : ''}.`);
  };
  const renameShort = (c: Row, v: string) => {
    const s = v.trim();
    if (!s) return toast('Code value is required.');
    if (codes.some((x) => x.actv_code_id !== c.actv_code_id && x.short_name === s)) return toast(`Code value "${s}" already exists in this code.`);
    setField('Edit Activity Code Value', 'ACTVCODE', 'actv_code_id', c.actv_code_id, 'short_name', s);
  };

  return (
    <Dialog title="Activity Codes" width={980} height={560} buttons={<button className="btn primary" onClick={closeDialog}>Close</button>}>
      <div style={{ display: 'flex', gap: 10, height: '100%' }}>
        <div style={{ width: 440, flex: 'none', display: 'flex', flexDirection: 'column' }}>
          <div style={toolbarRow}>
            <b style={{ marginRight: 'auto' }}>Activity Code Types</b>
            <button className="btn" onClick={addType}>Add</button>
            <button className="btn" disabled={!type} onClick={delType}>Delete</button>
          </div>
          <div className="tblwrap" style={{ flex: 1 }}>
            <table className="tbl">
              <thead><tr><th>Activity Code</th><th style={{ width: 50 }}>Max Len</th><th style={{ width: 80 }}>Scope</th><th style={{ width: 80 }}>Project</th><th style={{ width: 40 }}>Values</th></tr></thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.actv_code_type_id} className={selType === t.actv_code_type_id ? 'sel' : ''} onMouseDown={() => { if (selType !== t.actv_code_type_id) { setSelType(t.actv_code_type_id); setSelCode(null); } }}>
                    <td><Cell value={t.actv_code_type} onCommit={(v) => {
                      if (!v.trim()) return toast('Activity code name is required.');
                      if (types.some((x) => x !== t && x.actv_code_type.toLowerCase() === v.trim().toLowerCase() && x.proj_id === t.proj_id)) return toast(`Activity code "${v.trim()}" already exists.`);
                      setField('Rename Activity Code', 'ACTVTYPE', 'actv_code_type_id', t.actv_code_type_id, 'actv_code_type', v.trim());
                    }} /></td>
                    <td><Cell type="number" value={t.actv_short_len} onCommit={(v) => {
                      const n = Math.round(Number(v));
                      if (!(n >= 1 && n <= 60)) return toast('Max code length must be 1 to 60.');
                      setField('Edit Activity Code', 'ACTVTYPE', 'actv_code_type_id', t.actv_code_type_id, 'actv_short_len', String(n));
                    }} /></td>
                    <td>{t.actv_code_type_scope === 'AS_Project' || t.proj_id ? 'Project' : t.actv_code_type_scope === 'AS_EPS' ? 'EPS' : 'Global'}</td>
                    <td>{t.proj_id ? projName(t.proj_id) : ''}</td>
                    <td style={{ textAlign: 'right' }}>{rows(db, 'ACTVCODE').filter((c) => c.actv_code_type_id === t.actv_code_type_id).length}</td>
                  </tr>
                ))}
                {!types.length && <tr><td colSpan={5} className="muted">No activity codes. Click Add.</td></tr>}
              </tbody>
            </table>
          </div>
          {type && (
            <div className="form" style={{ gridTemplateColumns: 'auto 1fr auto 1fr', marginTop: 6 }}>
              <label>Scope</label>
              <select value={type.actv_code_type_scope === 'AS_Project' || type.proj_id ? 'AS_Project' : 'AS_Global'} onChange={(e) => setScope(e.target.value)}>
                <option value="AS_Global">Global</option><option value="AS_Project">Project</option>
              </select>
              <label>Project</label>
              <select value={type.proj_id} disabled={!type.proj_id} onChange={(e) => setField('Activity Code Project', 'ACTVTYPE', 'actv_code_type_id', type.actv_code_type_id, 'proj_id', e.target.value)}>
                {!type.proj_id && <option value="">(all projects)</option>}
                {projects.map((p) => <option key={p.proj_id} value={p.proj_id}>{p.proj_short_name}</option>)}
                {type.proj_id && !projects.some((p) => p.proj_id === type.proj_id) && <option value={type.proj_id}>#{type.proj_id}</option>}
              </select>
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={toolbarRow}>
            <b style={{ marginRight: 'auto' }}>Values{type ? ` - ${type.actv_code_type}` : ''}</b>
            <button className="btn" disabled={!type} onClick={() => addCode('')}>Add</button>
            <button className="btn" disabled={!code} onClick={() => code && addCode(code.actv_code_id)}>Add Child</button>
            <button className="btn" disabled={!code} onClick={delCode}>Delete</button>
          </div>
          <TreeTable items={items} idField="actv_code_id" sel={selCode} onSel={setSelCode} collapsed={collapsed} onToggle={(id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }))}
            headers={[['Code Value', 170], ['Description'], ['Activities', 60]]} height="100%" empty={type ? 'No values. Click Add.' : 'Select an activity code type.'}
            cells={(c) => [
              <Cell value={c.short_name} maxLength={Number(type?.actv_short_len) || undefined} onCommit={(v) => renameShort(c, v)} />,
              <Cell value={c.actv_code_name} onCommit={(v) => setField('Edit Activity Code Value', 'ACTVCODE', 'actv_code_id', c.actv_code_id, 'actv_code_name', v)} />,
              <span style={{ display: 'block', textAlign: 'right' }}>{assigned.get(c.actv_code_id) ?? 0}</span>,
            ]} />
          <div className="muted" style={{ marginTop: 4 }}>Deleting a value also deletes its child values and removes it from all activities.</div>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 3. User Defined Fields

const UDF_FIELDS = ['udf_type_id', 'table_name', 'udf_type_name', 'udf_type_label', 'logical_data_type'];
const UDF_AREAS: [string, string][] = [['TASK', 'Activities'], ['PROJWBS', 'WBS'], ['PROJECT', 'Projects'], ['RSRC', 'Resources']];
const UDF_TYPES: Record<string, string> = { FT_TEXT: 'Text', FT_START_DATE: 'Start Date', FT_END_DATE: 'Finish Date', FT_FLOAT_2_DECIMALS: 'Number', FT_INT: 'Integer', FT_MONEY: 'Cost' };

export function UdfDialog() {
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const [area, setArea] = useState('TASK');
  const [sel, setSel] = useState<string | null>(null);
  const list = rows(db, 'UDFTYPE').filter((u) => u.table_name === area);
  const counts = new Map<string, number>();
  for (const v of rows(db, 'UDFVALUE')) counts.set(v.udf_type_id, (counts.get(v.udf_type_id) ?? 0) + 1);
  const cur = list.find((u) => u.udf_type_id === sel);

  const add = () => {
    let id = '';
    mutate('Add User Defined Field', (d) => {
      const t = ensureFields(d, 'UDFTYPE', UDF_FIELDS);
      id = String(nextId(d, 'UDFTYPE'));
      let n = Number(id);
      while (t.rows.some((r) => r.udf_type_name === `user_field_${n}`)) n++;
      t.rows.push({
        ...Object.fromEntries(t.fields.map((f) => [f, ''])),
        udf_type_id: id, table_name: area, udf_type_name: `user_field_${n}`,
        udf_type_label: uniqueName('New UDF', t.rows.filter((r) => r.table_name === area).map((r) => r.udf_type_label)), logical_data_type: 'FT_TEXT',
      });
    });
    setSel(id);
  };
  const del = () => {
    if (!cur) return;
    const id = cur.udf_type_id;
    const n = counts.get(id) ?? 0;
    mutate(`Delete UDF ${cur.udf_type_label}`, (d) => {
      table(d, 'UDFTYPE').rows = rows(d, 'UDFTYPE').filter((u) => u.udf_type_id !== id);
      if (d.tables.UDFVALUE) d.tables.UDFVALUE.rows = rows(d, 'UDFVALUE').filter((v) => v.udf_type_id !== id);
    });
    setSel(null);
    if (n) toast(`Deleted the UDF and ${n} value(s).`);
  };

  return (
    <Dialog title="User Defined Fields" width={720} height={480} buttons={<>
      <button className="btn" onClick={add}>Add</button>
      <button className="btn" disabled={!cur} onClick={del}>Delete</button>
      <button className="btn primary" onClick={closeDialog}>Close</button>
    </>}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Tabs tabs={UDF_AREAS} value={area} onChange={(a) => { setArea(a); setSel(null); }} />
        <div className="tblwrap" style={{ flex: 1, borderTop: 'none' }}>
          <table className="tbl">
            <thead><tr><th>Title</th><th style={{ width: 130 }}>Data Type</th><th style={{ width: 110 }}>Internal Name</th><th style={{ width: 60 }}>Values</th></tr></thead>
            <tbody>
              {list.map((u) => {
                const n = counts.get(u.udf_type_id) ?? 0;
                return (
                  <tr key={u.udf_type_id} className={sel === u.udf_type_id ? 'sel' : ''} onMouseDown={() => setSel(u.udf_type_id)}>
                    <td><Cell value={u.udf_type_label} onCommit={(v) => {
                      if (!v.trim()) return toast('Title is required.');
                      if (list.some((x) => x !== u && x.udf_type_label.toLowerCase() === v.trim().toLowerCase())) return toast(`A UDF titled "${v.trim()}" already exists for ${area}.`);
                      setField('Rename UDF', 'UDFTYPE', 'udf_type_id', u.udf_type_id, 'udf_type_label', v.trim());
                    }} /></td>
                    <td>
                      <select value={u.logical_data_type} disabled={n > 0} title={n ? 'The data type cannot be changed while values exist.' : ''}
                        onChange={(e) => setField('Change UDF Data Type', 'UDFTYPE', 'udf_type_id', u.udf_type_id, 'logical_data_type', e.target.value)}>
                        {Object.entries(UDF_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        {!UDF_TYPES[u.logical_data_type] && <option value={u.logical_data_type}>{u.logical_data_type || '(blank)'}</option>}
                      </select>
                    </td>
                    <td className="muted">{u.udf_type_name}</td>
                    <td style={{ textAlign: 'right' }}>{n}</td>
                  </tr>
                );
              })}
              {!list.length && <tr><td colSpan={4} className="muted">No user defined fields for {UDF_AREAS.find(([k]) => k === area)?.[1]}. Click Add.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ marginTop: 4 }}>Deleting a UDF also deletes all of its values (UDFVALUE).</div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 4. OBS

const OBS_FIELDS = ['obs_id', 'parent_obs_id', 'seq_num', 'obs_name', 'obs_descr'];

export function ObsDialog() {
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const [sel, setSel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const obs = rows(db, 'OBS');
  const items = treeOrder(obs, 'obs_id', 'parent_obs_id', 'seq_num', 'obs_name', collapsed);
  const cur = obs.find((o) => o.obs_id === sel);
  const usage = new Map<string, number>();
  for (const w of rows(db, 'PROJWBS')) if (w.obs_id) usage.set(w.obs_id, (usage.get(w.obs_id) ?? 0) + 1);

  const add = (parent: string) => {
    let id = '';
    mutate('Add OBS', (d) => { id = addTreeRow(d, 'OBS', 'obs_id', 'parent_obs_id', 'seq_num', OBS_FIELDS, parent, { obs_name: uniqueName('New OBS', rows(d, 'OBS').map((o) => o.obs_name)) }); });
    if (parent) setCollapsed((c) => ({ ...c, [parent]: false }));
    setSel(id);
  };
  const del = () => {
    if (!cur) return;
    const sub = subtree(obs, 'obs_id', 'parent_obs_id', cur.obs_id);
    const n = [...sub].reduce((a, id) => a + (usage.get(id) ?? 0), 0);
    if (n) return toast(`"${cur.obs_name}" cannot be deleted: it (or a child) is the responsible manager of ${n} WBS element(s).`);
    mutate('Delete OBS', (d) => { table(d, 'OBS').rows = rows(d, 'OBS').filter((o) => !sub.has(o.obs_id)); });
    setSel(null);
  };

  return (
    <Dialog title="Organizational Breakdown Structure" width={720} height={480} buttons={<>
      <button className="btn" onClick={() => add(cur?.obs_id ?? '')}>Add Child</button>
      <button className="btn" disabled={!cur} onClick={() => cur && add(obs.some((o) => o.obs_id === cur.parent_obs_id) ? cur.parent_obs_id : '')}>Add Sibling</button>
      <button className="btn" disabled={!cur} onClick={del}>Delete</button>
      <button className="btn primary" onClick={closeDialog}>Close</button>
    </>}>
      <TreeTable items={items} idField="obs_id" sel={sel} onSel={setSel} collapsed={collapsed} onToggle={(id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }))}
        headers={[['OBS Name', 260], ['Description'], ['WBS', 40]]} height="calc(100% - 20px)" empty="No OBS elements. Click Add Child."
        cells={(o) => [
          <Cell value={o.obs_name} onCommit={(v) => { if (!v.trim()) return toast('OBS name is required.'); setField('Rename OBS', 'OBS', 'obs_id', o.obs_id, 'obs_name', v.trim()); }} />,
          <Cell value={o.obs_descr ?? ''} onCommit={(v) => setField('Edit OBS', 'OBS', 'obs_id', o.obs_id, 'obs_descr', v)} />,
          <span style={{ display: 'block', textAlign: 'right' }}>{usage.get(o.obs_id) ?? 0}</span>,
        ]} />
      <div className="muted" style={{ marginTop: 4 }}>Add Child adds under the selected element (or a new root when nothing is selected). Deleting removes the element and its children.</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 5. Cost Accounts

const ACCT_FIELDS = ['acct_id', 'parent_acct_id', 'acct_seq_num', 'acct_name', 'acct_short_name', 'acct_descr'];

export function AccountsDialog() {
  const db = useStore((s) => s.db);
  const ver = useStore((s) => s.dbVersion);
  const [sel, setSel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const accts = rows(db, 'ACCOUNT');
  const items = treeOrder(accts, 'acct_id', 'parent_acct_id', 'acct_seq_num', 'acct_short_name', collapsed);
  const cur = accts.find((a) => a.acct_id === sel);
  const sym = rows(db, 'CURRTYPE')[0]?.curr_symbol ?? '$';

  const { own, total, usage } = useMemo(() => {
    const own = new Map<string, number>();
    const usage = new Map<string, number>();
    for (const t of ['PROJCOST', 'TASKRSRC']) for (const r of rows(db, t)) {
      if (!r.acct_id) continue;
      own.set(r.acct_id, (own.get(r.acct_id) ?? 0) + (Number(r.target_cost) || 0));
      usage.set(r.acct_id, (usage.get(r.acct_id) ?? 0) + 1);
    }
    const total = new Map<string, number>();
    for (const a of accts) {
      let s = 0;
      for (const id of subtree(accts, 'acct_id', 'parent_acct_id', a.acct_id)) s += own.get(id) ?? 0;
      total.set(a.acct_id, s);
    }
    return { own, total, usage };
  }, [db, ver]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (parent: string) => {
    let id = '';
    mutate('Add Cost Account', (d) => {
      const existing = rows(d, 'ACCOUNT').map((a) => a.acct_short_name);
      let n = existing.length + 1;
      while (existing.includes(`CA${n}`)) n++;
      id = addTreeRow(d, 'ACCOUNT', 'acct_id', 'parent_acct_id', 'acct_seq_num', ACCT_FIELDS, parent, { acct_short_name: `CA${n}`, acct_name: 'New Cost Account' });
    });
    if (parent) setCollapsed((c) => ({ ...c, [parent]: false }));
    setSel(id);
  };
  const del = () => {
    if (!cur) return;
    const sub = subtree(accts, 'acct_id', 'parent_acct_id', cur.acct_id);
    const n = [...sub].reduce((a, id) => a + (usage.get(id) ?? 0), 0);
    if (n) return toast(`Cost account "${cur.acct_short_name}" cannot be deleted: it (or a child) is used by ${n} resource assignment(s) / expense(s).`);
    mutate('Delete Cost Account', (d) => { table(d, 'ACCOUNT').rows = rows(d, 'ACCOUNT').filter((a) => !sub.has(a.acct_id)); });
    setSel(null);
  };

  return (
    <Dialog title="Cost Accounts" width={860} height={500} buttons={<>
      <button className="btn" onClick={() => add('')}>Add Root</button>
      <button className="btn" disabled={!cur} onClick={() => cur && add(cur.acct_id)}>Add Child</button>
      <button className="btn" disabled={!cur} onClick={del}>Delete</button>
      <button className="btn primary" onClick={closeDialog}>Close</button>
    </>}>
      <TreeTable items={items} idField="acct_id" sel={sel} onSel={setSel} collapsed={collapsed} onToggle={(id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }))}
        headers={[['Cost Account ID', 180], ['Cost Account Name', 200], ['Description'], ['Budget (own)', 100], ['Total Budgeted Cost', 120]]}
        height="calc(100% - 20px)" empty="No cost accounts. Click Add Root."
        cells={(a) => [
          <Cell value={a.acct_short_name} onCommit={(v) => {
            if (!v.trim()) return toast('Cost account ID is required.');
            if (accts.some((x) => x.acct_id !== a.acct_id && x.acct_short_name === v.trim() && x.parent_acct_id === a.parent_acct_id)) return toast(`Cost account "${v.trim()}" already exists at this level.`);
            setField('Rename Cost Account', 'ACCOUNT', 'acct_id', a.acct_id, 'acct_short_name', v.trim());
          }} />,
          <Cell value={a.acct_name} onCommit={(v) => setField('Rename Cost Account', 'ACCOUNT', 'acct_id', a.acct_id, 'acct_name', v)} />,
          <Cell value={a.acct_descr ?? ''} onCommit={(v) => setField('Edit Cost Account', 'ACCOUNT', 'acct_id', a.acct_id, 'acct_descr', v)} />,
          <span style={{ display: 'block', textAlign: 'right' }}>{sym}{money(own.get(a.acct_id) ?? 0)}</span>,
          <span style={{ display: 'block', textAlign: 'right', fontWeight: 'bold' }}>{sym}{money(total.get(a.acct_id) ?? 0)}</span>,
        ]} />
      <div className="muted" style={{ marginTop: 4 }}>Budget = sum of budgeted cost of expenses (PROJCOST) and resource assignments (TASKRSRC) charged to the account; total includes child accounts.</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 6. Roles

const ROLE_FIELDS = ['role_id', 'parent_role_id', 'seq_num', 'role_name', 'role_short_name'];
const ROLERATE_FIELDS = ['role_rate_id', 'role_id', 'cost_per_qty'];

export function RolesDialog() {
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const [sel, setSel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const roles = rows(db, 'ROLES');
  const items = treeOrder(roles, 'role_id', 'parent_role_id', 'seq_num', 'role_short_name', collapsed);
  const cur = roles.find((r) => r.role_id === sel);
  const sym = rows(db, 'CURRTYPE')[0]?.curr_symbol ?? '$';
  const priceOf = (id: string) => rows(db, 'ROLERATE').find((r) => r.role_id === id)?.cost_per_qty ?? '';

  const add = (parent: string) => {
    let id = '';
    mutate('Add Role', (d) => {
      const existing = rows(d, 'ROLES').map((r) => r.role_short_name);
      let n = existing.length + 1;
      while (existing.includes(`ROLE${n}`)) n++;
      id = addTreeRow(d, 'ROLES', 'role_id', 'parent_role_id', 'seq_num', ROLE_FIELDS, parent, { role_short_name: `ROLE${n}`, role_name: 'New Role' });
    });
    if (parent) setCollapsed((c) => ({ ...c, [parent]: false }));
    setSel(id);
  };
  const del = () => {
    if (!cur) return;
    const sub = subtree(roles, 'role_id', 'parent_role_id', cur.role_id);
    const n = rows(db, 'TASKRSRC').filter((a) => sub.has(a.role_id)).length;
    if (n) return toast(`Role "${cur.role_short_name}" cannot be deleted: it (or a child) is used by ${n} resource assignment(s).`);
    mutate('Delete Role', (d) => {
      table(d, 'ROLES').rows = rows(d, 'ROLES').filter((r) => !sub.has(r.role_id));
      for (const t of ['ROLERATE', 'RSRCROLE', 'ROLELIMIT']) if (d.tables[t]) d.tables[t].rows = rows(d, t).filter((r) => !sub.has(r.role_id));
    });
    setSel(null);
  };
  const setPrice = (roleId: string, v: string) => {
    const s = v.trim();
    if (s && !(Number.isFinite(Number(s)) && Number(s) >= 0)) return toast('Price / unit must be a number of 0 or more.');
    mutate('Set Role Price', (d) => {
      const t = ensureFields(d, 'ROLERATE', ROLERATE_FIELDS);
      const r = t.rows.find((x) => x.role_id === roleId);
      if (r) r.cost_per_qty = s;
      else if (s) t.rows.push({ ...Object.fromEntries(t.fields.map((f) => [f, ''])), role_rate_id: String(nextId(d, 'ROLERATE')), role_id: roleId, cost_per_qty: s });
    });
  };

  return (
    <Dialog title="Roles" width={760} height={480} buttons={<>
      <button className="btn" onClick={() => add('')}>Add Root</button>
      <button className="btn" disabled={!cur} onClick={() => cur && add(cur.role_id)}>Add Child</button>
      <button className="btn" disabled={!cur} onClick={del}>Delete</button>
      <button className="btn primary" onClick={closeDialog}>Close</button>
    </>}>
      <TreeTable items={items} idField="role_id" sel={sel} onSel={setSel} collapsed={collapsed} onToggle={(id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }))}
        headers={[['Role ID', 200], ['Role Name'], [`Price / Unit (${sym})`, 110], ['Resources', 70]]} height="calc(100% - 20px)" empty="No roles. Click Add Root."
        cells={(r) => [
          <Cell value={r.role_short_name} onCommit={(v) => {
            if (!v.trim()) return toast('Role ID is required.');
            if (roles.some((x) => x.role_id !== r.role_id && x.role_short_name === v.trim())) return toast(`Role ID "${v.trim()}" already exists.`);
            setField('Rename Role', 'ROLES', 'role_id', r.role_id, 'role_short_name', v.trim());
          }} />,
          <Cell value={r.role_name} onCommit={(v) => setField('Rename Role', 'ROLES', 'role_id', r.role_id, 'role_name', v)} />,
          <Cell value={priceOf(r.role_id)} style={{ textAlign: 'right' }} onCommit={(v) => setPrice(r.role_id, v)} />,
          <span style={{ display: 'block', textAlign: 'right' }}>{rows(db, 'RSRCROLE').filter((x) => x.role_id === r.role_id).length}</span>,
        ]} />
      <div className="muted" style={{ marginTop: 4 }}>Price / Unit is stored in ROLERATE.cost_per_qty. Deleting a role also deletes its child roles and rates.</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 7. Currencies

const CURR_FIELDS = ['curr_id', 'decimal_digit_cnt', 'curr_symbol', 'decimal_symbol', 'digit_group_symbol', 'pos_curr_fmt_type', 'neg_curr_fmt_type', 'curr_type', 'curr_short_name', 'group_digit_cnt', 'base_exch_rate'];

export function CurrenciesDialog() {
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const [sel, setSel] = useState<string | null>(null);
  const list = [...rows(db, 'CURRTYPE')].sort((a, b) => Number(a.curr_id) - Number(b.curr_id));
  const cur = list.find((c) => c.curr_id === sel);
  const edit = (c: Row, f: string, v: string) => setField('Edit Currency', 'CURRTYPE', 'curr_id', c.curr_id, f, v);

  const add = () => {
    let id = '';
    mutate('Add Currency', (d) => {
      const t = ensureFields(d, 'CURRTYPE', CURR_FIELDS);
      id = String(nextId(d, 'CURRTYPE'));
      const existing = t.rows.map((r) => r.curr_short_name);
      let n = 1;
      while (existing.includes(`CUR${n}`)) n++;
      t.rows.push({
        ...Object.fromEntries(t.fields.map((f) => [f, ''])),
        curr_id: id, decimal_digit_cnt: '2', curr_symbol: '¤', decimal_symbol: '.', digit_group_symbol: ',', pos_curr_fmt_type: '#1.1', neg_curr_fmt_type: '(#1.1)',
        curr_type: 'New Currency', curr_short_name: `CUR${n}`, group_digit_cnt: '3', base_exch_rate: '1',
      });
    });
    setSel(id);
  };
  const del = () => {
    if (!cur) return;
    if (list.length <= 1) return toast('At least one currency must remain.');
    const id = cur.curr_id;
    const used = rows(db, 'PROJECT').filter((p) => p.curr_id === id).length;
    if (used) return toast(`Currency "${cur.curr_short_name}" is used by ${used} project(s).`);
    mutate('Delete Currency', (d) => { table(d, 'CURRTYPE').rows = rows(d, 'CURRTYPE').filter((c) => c.curr_id !== id); });
    setSel(null);
  };
  const numCommit = (c: Row, f: string, label: string, ok: (n: number) => boolean) => (v: string) => {
    const n = Number(v);
    if (!v.trim() || !Number.isFinite(n) || !ok(n)) return toast(`${label} is not valid.`);
    edit(c, f, String(n));
  };

  return (
    <Dialog title="Currencies" width={780} height={400} buttons={<>
      <button className="btn" onClick={add}>Add</button>
      <button className="btn" disabled={!cur || list.length <= 1} onClick={del}>Delete</button>
      <button className="btn primary" onClick={closeDialog}>Close</button>
    </>}>
      <div className="tblwrap" style={{ height: 'calc(100% - 20px)' }}>
        <table className="tbl">
          <thead><tr><th style={{ width: 90 }}>Currency ID</th><th>Currency Name</th><th style={{ width: 60 }}>Symbol</th><th style={{ width: 110 }}>Exchange Rate</th><th style={{ width: 80 }}>Decimals</th><th style={{ width: 40 }}>Base</th></tr></thead>
          <tbody>
            {list.map((c, i) => (
              <tr key={c.curr_id} className={sel === c.curr_id ? 'sel' : ''} onMouseDown={() => setSel(c.curr_id)}>
                <td><Cell value={c.curr_short_name} onCommit={(v) => {
                  if (!v.trim()) return toast('Currency ID is required.');
                  if (list.some((x) => x !== c && x.curr_short_name === v.trim())) return toast(`Currency ID "${v.trim()}" already exists.`);
                  edit(c, 'curr_short_name', v.trim());
                }} /></td>
                <td><Cell value={c.curr_type} onCommit={(v) => edit(c, 'curr_type', v)} /></td>
                <td><Cell value={c.curr_symbol} onCommit={(v) => edit(c, 'curr_symbol', v)} /></td>
                <td><Cell value={c.base_exch_rate} onCommit={numCommit(c, 'base_exch_rate', 'Exchange rate', (n) => n > 0)} /></td>
                <td><Cell type="number" value={c.decimal_digit_cnt} onCommit={numCommit(c, 'decimal_digit_cnt', 'Decimal places', (n) => Number.isInteger(n) && n >= 0 && n <= 6)} /></td>
                <td style={{ textAlign: 'center' }}>{i === 0 ? '✓' : ''}</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={6} className="muted">No currencies. Click Add.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ marginTop: 4 }}>Exchange rate is relative to the base currency (first currency). At least one currency must remain.</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 8. Level Resources

export function LevelDialog() {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  const [withinFloat, setWithinFloat] = useState(false);
  const [overAlloc, setOverAlloc] = useState('0');
  const [priority, setPriority] = useState<'es' | 'tf' | 'priority'>('es');
  const [all, setAll] = useState(true);
  const selRsrc = ui.selRsrc ? rows(db, 'RSRC').find((r) => r.rsrc_id === ui.selRsrc) : undefined;

  const level = () => {
    if (!ui.openProjects.length) return toast('Open a project first.');
    const pct = Number(overAlloc);
    if (!Number.isFinite(pct) || pct < 0) return toast('Overallocation % must be 0 or more.');
    if (!all && !selRsrc) return toast('Select a resource in the Resources window, or check "Level all resources".');
    const opts: LevelOptions = { withinFloat, overAllocPct: pct, priority };
    if (!all && selRsrc) opts.rsrcIds = [selRsrc.rsrc_id];
    let res: LevelResult | null = null;
    let err = '';
    mutate('Level Resources', (d) => {
      try { res = levelResources(d, ui.openProjects, opts); } catch (e) { err = (e as Error).message; }
    });
    if (err) { doUndo(); return toast(`Leveling failed: ${err}`); }
    const r = res as LevelResult | null;
    if (!r) return;
    const text = r.log || r.findings.map((f) => `${f.severity}: ${f.message}`).join('\n');
    setUi({ levelLog: text });
    closeDialog();
    toast(`Leveling complete: ${r.delayed} activit${r.delayed === 1 ? 'y' : 'ies'} delayed.`);
    openDialog('log', { title: 'Leveling Log', text });
  };

  return (
    <Dialog title="Level Resources" width={500} buttons={<>
      <button className="btn primary" onClick={level}>Level</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
      <button className="btn" disabled={!ui.levelLog} onClick={() => openDialog('log', { title: 'Leveling Log', text: ui.levelLog ?? '' })}>View Last Log</button>
    </>}>
      <fieldset><legend>Resources</legend>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Level all resources</label>
        <div className="muted" style={{ whiteSpace: 'normal', marginTop: 3 }}>
          {all
            ? 'All resources marked for leveling are leveled. Resources with "Level" set to No and material resources are skipped.'
            : selRsrc ? `Only the selected resource is leveled: ${selRsrc.rsrc_short_name} - ${selRsrc.rsrc_name}.` : 'No resource is selected in the Resources window.'}
        </div>
      </fieldset>
      <fieldset><legend>Options</legend>
        <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Level within float</label>
          <input type="checkbox" checked={withinFloat} onChange={(e) => setWithinFloat(e.target.checked)} style={{ justifySelf: 'start' }} />
          <label>Max percent to overallocate</label>
          <input type="number" min={0} value={overAlloc} onChange={(e) => setOverAlloc(e.target.value)} />
          <label>Leveling priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value as 'es' | 'tf' | 'priority')}>
            <option value="es">Early Start</option><option value="tf">Total Float</option><option value="priority">Activity Priority</option>
          </select>
        </div>
      </fieldset>
      <div className="muted">Projects to level: {ui.openProjects.map((id) => rows(db, 'PROJECT').find((p) => p.proj_id === id)?.proj_short_name ?? id).join(', ') || '(none open)'}. Edit &gt; Undo reverts leveling.</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 9. Filters / Group and Sort

const SORTS: [string, string][] = [['', 'Start (default)'], ['task_code', 'Activity ID'], ['task_name', 'Activity Name'], ['total_float', 'Total Float'], ['finish', 'Finish']];

export function FiltersDialog(props: { tab?: 'filter' | 'group' }) {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  const [tab, setTab] = useState<string>(props.tab ?? 'filter');
  const [filter, setFilter] = useState(ui.filter);
  const [groupBy, setGroupBy] = useState(ui.groupBy);
  const [sortBy, setSortBy] = useState(ui.sortBy);
  const codeTypes = rows(db, 'ACTVTYPE');
  const apply = () => setUi({ filter, groupBy, sortBy });

  return (
    <Dialog title={tab === 'filter' ? 'Filters' : 'Group and Sort'} width={560} height={430} buttons={<>
      <button className="btn primary" onClick={() => { apply(); closeDialog(); }}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
      <button className="btn" onClick={apply}>Apply</button>
      <button className="btn" onClick={() => { setFilter('all'); setGroupBy('wbs'); setSortBy(''); }}>Default</button>
    </>}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Tabs tabs={[['filter', 'Filters'], ['group', 'Group and Sort']]} value={tab} onChange={setTab} />
        <div style={{ flex: 1, border: '1px solid #a0a0a0', borderTop: 'none', padding: 8, minHeight: 0, overflow: 'auto' }}>
          {tab === 'filter' && (
            <div className="tblwrap" style={{ height: '100%' }}>
              <table className="tbl">
                <thead><tr><th style={{ width: 30 }}>Select</th><th>Filter Name</th></tr></thead>
                <tbody>
                  {Object.entries(FILTERS).map(([k, [label]]) => (
                    <tr key={k} className={filter === k ? 'sel' : ''} onMouseDown={() => setFilter(k)} onDoubleClick={() => { setUi({ filter: k }); closeDialog(); }}>
                      <td style={{ textAlign: 'center' }}><input type="radio" name="flt" checked={filter === k} onChange={() => setFilter(k)} /></td>
                      <td>{label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === 'group' && (
            <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
              <label>Group by</label>
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                <option value="wbs">WBS</option>
                <option value="none">No grouping</option>
                {codeTypes.map((t) => <option key={t.actv_code_type_id} value={`code:${t.actv_code_type_id}`}>Activity Code: {t.actv_code_type}</option>)}
                {groupBy.startsWith('code:') && !codeTypes.some((t) => `code:${t.actv_code_type_id}` === groupBy) && <option value={groupBy}>(deleted code)</option>}
              </select>
              <label>Sort by</label>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                {sortBy.startsWith('col:') && <option value={sortBy}>Column: {sortBy.split(':')[1]}{sortBy.endsWith(':desc') ? ' (descending)' : ''}</option>}
              </select>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 10. Timescale

const ZOOMS: [string, number][] = [['Day', 20], ['Week', 6], ['Month', 1.5], ['Quarter', 0.5], ['Year', 0.2]];

export function TimescaleDialog() {
  const ui = useStore((s) => s.ui);
  const [px, setPx] = useState(ui.pxPerDay);
  const [rel, setRel] = useState(ui.relLines);
  const apply = () => setUi({ pxPerDay: px, relLines: rel });
  return (
    <Dialog title="Timescale" width={420} buttons={<>
      <button className="btn primary" onClick={() => { apply(); closeDialog(); }}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
      <button className="btn" onClick={apply}>Apply</button>
    </>}>
      <fieldset><legend>Timescale Format</legend>
        {ZOOMS.map(([l, v]) => (
          <label key={l} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
            <input type="radio" name="zoom" checked={Math.abs(px - v) < 1e-9} onChange={() => setPx(v)} />{l} <span className="muted">({v} px per day)</span>
          </label>
        ))}
        <div className="form" style={{ gridTemplateColumns: 'auto 1fr', marginTop: 4 }}>
          <label>Custom (px per day)</label>
          <input type="number" step={0.1} min={0.15} max={60} value={px} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) setPx(Math.min(60, Math.max(0.15, n))); }} />
        </div>
      </fieldset>
      <fieldset><legend>Bars</legend>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={rel} onChange={(e) => setRel(e.target.checked)} />Show relationship lines</label>
      </fieldset>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 11. Layouts

interface LayoutData { columns: string[]; filter: string; groupBy: string; sortBy: string; pxPerDay: number; relLines: boolean; colWidths?: Record<string, number>; bars?: UiState['bars'] }
export const BUILTIN_LAYOUT = 'Classic Schedule Layout';
const builtinLayout = (): LayoutData => ({ columns: [...DEFAULT_COLUMNS], filter: 'all', groupBy: 'wbs', sortBy: '', pxPerDay: 6, relLines: true, colWidths: {}, bars: undefined });
export const layoutFromUi = (u: UiState): LayoutData => ({ columns: [...u.columns], filter: u.filter, groupBy: u.groupBy, sortBy: u.sortBy, pxPerDay: u.pxPerDay, relLines: u.relLines, colWidths: { ...u.colWidths }, bars: u.bars });

function parseLayout(json: string): LayoutData | null {
  try {
    const o = JSON.parse(json) as Partial<LayoutData>;
    const b = builtinLayout();
    return {
      columns: Array.isArray(o.columns) && o.columns.length ? o.columns.filter((c): c is string => typeof c === 'string') : b.columns,
      filter: typeof o.filter === 'string' ? o.filter : b.filter,
      groupBy: typeof o.groupBy === 'string' ? o.groupBy : b.groupBy,
      sortBy: typeof o.sortBy === 'string' ? o.sortBy : b.sortBy,
      pxPerDay: typeof o.pxPerDay === 'number' && o.pxPerDay > 0 ? o.pxPerDay : b.pxPerDay,
      relLines: typeof o.relLines === 'boolean' ? o.relLines : b.relLines,
      colWidths: o.colWidths && typeof o.colWidths === 'object' ? o.colWidths : {},
      bars: o.bars && typeof o.bars === 'object' ? o.bars : undefined,
    };
  } catch { return null; }
}

export function saveLayout(name: string, data: LayoutData): void {
  mutate(`Save Layout ${name}`, (d) => {
    const t = ensureFields(d, '_LAYOUT', ['layout_id', 'name', 'json']);
    const json = JSON.stringify(data);
    const ex = t.rows.find((r) => r.name === name);
    if (ex) ex.json = json;
    else t.rows.push({ layout_id: String(Math.max(0, ...t.rows.map((r) => Number(r.layout_id) || 0)) + 1), name, json });
  });
  setUi({ layoutName: name });
}

export function LayoutDialog(props: { mode: 'open' | 'save' | 'saveAs' }) {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);
  const isBuiltin = !ui.layoutName || ui.layoutName === BUILTIN_LAYOUT;
  const [mode] = useState<'open' | 'save' | 'saveAs'>(props.mode === 'save' && isBuiltin ? 'saveAs' : props.mode);
  const saved = [...rows(db, '_LAYOUT')].sort((a, b) => a.name.localeCompare(b.name));
  const [sel, setSel] = useState<string>(ui.layoutName || BUILTIN_LAYOUT);
  const [name, setName] = useState(isBuiltin ? uniqueName('My Layout', saved.map((r) => r.name)) : ui.layoutName);
  const all = [BUILTIN_LAYOUT, ...saved.map((r) => r.name).filter((n) => n !== BUILTIN_LAYOUT)];

  const open = (n: string) => {
    const data = n === BUILTIN_LAYOUT ? builtinLayout() : parseLayout(saved.find((r) => r.name === n)?.json ?? '');
    if (!data) return toast(`Layout "${n}" is damaged and cannot be opened.`);
    setUi({ ...data, layoutName: n });
    closeDialog();
    toast(`Layout "${n}" applied`);
  };
  const del = () => {
    if (sel === BUILTIN_LAYOUT) return toast('The built-in layout cannot be deleted.');
    mutate(`Delete Layout ${sel}`, (d) => { table(d, '_LAYOUT').rows = rows(d, '_LAYOUT').filter((r) => r.name !== sel); });
    if (ui.layoutName === sel) setUi({ layoutName: BUILTIN_LAYOUT });
    setSel(BUILTIN_LAYOUT);
  };
  const saveAs = () => {
    const n = name.trim();
    if (!n) return toast('Enter a layout name.');
    if (n.toLowerCase() === BUILTIN_LAYOUT.toLowerCase()) return toast('The built-in layout cannot be overwritten. Choose another name.');
    const replaced = saved.some((r) => r.name === n);
    saveLayout(n, layoutFromUi(getUi()));
    closeDialog();
    toast(replaced ? `Layout "${n}" replaced` : `Layout "${n}" saved`);
  };

  if (mode === 'save') {
    return (
      <Dialog title="Save Layout" width={420} buttons={<>
        <button className="btn primary" onClick={() => { saveLayout(ui.layoutName, layoutFromUi(getUi())); closeDialog(); toast(`Layout "${ui.layoutName}" saved`); }}>Save</button>
        <button className="btn" onClick={closeDialog}>Cancel</button>
      </>}>
        <p>Save the current columns, filter, grouping, sorting and timescale to layout <b>{ui.layoutName}</b>?</p>
      </Dialog>
    );
  }

  if (mode === 'saveAs') {
    return (
      <Dialog title="Save Layout As" width={460} height={360} buttons={<>
        <button className="btn primary" onClick={saveAs}>Save</button>
        <button className="btn" onClick={closeDialog}>Cancel</button>
      </>}>
        {props.mode === 'save' && <p className="muted" style={{ marginTop: 0 }}>The built-in layout cannot be overwritten; save the current layout under a new name.</p>}
        <div className="form" style={{ gridTemplateColumns: 'auto 1fr', marginBottom: 6 }}>
          <label>Layout Name</label>
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveAs(); }} />
        </div>
        <div className="tblwrap" style={{ height: 200 }}>
          <table className="tbl"><thead><tr><th>Existing Layouts</th></tr></thead><tbody>
            {saved.map((r) => <tr key={r.layout_id || r.name} className={name === r.name ? 'sel' : ''} onMouseDown={() => setName(r.name)}><td>{r.name}</td></tr>)}
            {!saved.length && <tr><td className="muted">No saved layouts yet.</td></tr>}
          </tbody></table>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Open Layout" width={480} height={380} buttons={<>
      <button className="btn primary" onClick={() => open(sel)}>Open</button>
      <button className="btn" disabled={sel === BUILTIN_LAYOUT} onClick={del}>Delete</button>
      <button className="btn" onClick={closeDialog}>Close</button>
    </>}>
      <div className="tblwrap" style={{ height: 'calc(100% - 20px)' }}>
        <table className="tbl"><thead><tr><th>Layout Name</th><th style={{ width: 80 }}>Type</th></tr></thead><tbody>
          {all.map((n) => (
            <tr key={n} className={sel === n ? 'sel' : ''} onMouseDown={() => setSel(n)} onDoubleClick={() => open(n)}>
              <td>{n}{ui.layoutName === n ? ' (current)' : ''}</td><td>{n === BUILTIN_LAYOUT ? 'Built-in' : 'User'}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 12. Page Setup

interface PageSetup { landscape: boolean; pagesWide: number; header: string; footer: string }
const PAGE_KEY = 'p6clone.pageSetup';
const PAGE_DEFAULT: PageSetup = { landscape: true, pagesWide: 1, header: '', footer: '' };

function loadPageSetup(): PageSetup {
  try {
    const o = JSON.parse(localStorage.getItem(PAGE_KEY) ?? 'null') as Partial<PageSetup> | null;
    if (!o || typeof o !== 'object') return { ...PAGE_DEFAULT };
    return {
      landscape: typeof o.landscape === 'boolean' ? o.landscape : PAGE_DEFAULT.landscape,
      pagesWide: typeof o.pagesWide === 'number' && o.pagesWide >= 1 ? Math.round(o.pagesWide) : PAGE_DEFAULT.pagesWide,
      header: typeof o.header === 'string' ? o.header : '',
      footer: typeof o.footer === 'string' ? o.footer : '',
    };
  } catch { return { ...PAGE_DEFAULT }; }
}

export function PageSetupDialog() {
  const [ps, setPs] = useState<PageSetup>(loadPageSetup);
  const [tab, setTab] = useState('page');
  const ok = () => {
    try { localStorage.setItem(PAGE_KEY, JSON.stringify(ps)); } catch { toast('Page setup could not be saved.'); return; }
    closeDialog();
  };
  return (
    <Dialog title="Page Setup" width={480} height={330} buttons={<>
      <button className="btn primary" onClick={ok}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
    </>}>
      <Tabs tabs={[['page', 'Page'], ['header', 'Header'], ['footer', 'Footer']]} value={tab} onChange={setTab} />
      <div style={{ border: '1px solid #a0a0a0', borderTop: 'none', padding: 10, minHeight: 180 }}>
        {tab === 'page' && <>
          <fieldset><legend>Orientation</legend>
            <label style={{ marginRight: 16 }}><input type="radio" name="orient" checked={!ps.landscape} onChange={() => setPs({ ...ps, landscape: false })} /> Portrait</label>
            <label><input type="radio" name="orient" checked={ps.landscape} onChange={() => setPs({ ...ps, landscape: true })} /> Landscape</label>
          </fieldset>
          <fieldset><legend>Scaling</legend>
            <div className="form" style={{ gridTemplateColumns: 'auto 80px auto' }}>
              <label>Fit to</label>
              <input type="number" min={1} max={20} value={ps.pagesWide} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 20) setPs({ ...ps, pagesWide: n }); }} />
              <span>page(s) wide</span>
            </div>
          </fieldset>
        </>}
        {tab === 'header' && <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Header text</label><input value={ps.header} onChange={(e) => setPs({ ...ps, header: e.target.value })} placeholder="e.g. Project schedule" />
        </div>}
        {tab === 'footer' && <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <label>Footer text</label><input value={ps.footer} onChange={(e) => setPs({ ...ps, footer: e.target.value })} placeholder="e.g. Printed from P6 Clone" />
        </div>}
      </div>
    </Dialog>
  );
}
