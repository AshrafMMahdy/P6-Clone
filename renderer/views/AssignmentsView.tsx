import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RME } from 'react';
import { Grid, type EditorSpec, type GridItem } from '../components/Grid.tsx';
import { Split, showContextMenu } from '../components/Layout.tsx';
import { mutate, setUi, toast, useStore, type Prefs } from '../store.ts';
import { useCtx } from '../hooks.ts';
import { fmtDate, RSRC_TYPES } from '../model.ts';
import { rows, type Row } from '../../core/db.ts';
import { MIN_PER_DAY, parseP6Date } from '../../core/dates.ts';
import { recalcAssignment } from '../../core/resource/assign.ts';
import { spreadUsage, type UsageBucket, type UsageRow } from '../../core/resource/usage.ts';

const COLS = [
  { id: 'rid', title: 'Resource ID', width: 110 },
  { id: 'rname', title: 'Resource Name', width: 150 },
  { id: 'code', title: 'Activity ID', width: 90 },
  { id: 'tname', title: 'Activity Name', width: 220 },
  { id: 'bud', title: 'Budgeted Units', width: 70, align: 'right' as const },
  { id: 'act', title: 'Actual Units', width: 70, align: 'right' as const },
  { id: 'rem', title: 'Remaining Units', width: 70, align: 'right' as const },
  { id: 'atc', title: 'At Completion Units', width: 74, align: 'right' as const },
  { id: 'upt', title: 'Units / Time', width: 60, align: 'right' as const },
  { id: 'start', title: 'Start', width: 82 },
  { id: 'finish', title: 'Finish', width: 82 },
  { id: 'bcost', title: 'Budgeted Cost', width: 90, align: 'right' as const },
  { id: 'acost', title: 'Actual Cost', width: 90, align: 'right' as const },
  { id: 'rcost', title: 'Remaining Cost', width: 90, align: 'right' as const },
];

const FIELD: Record<string, 'target_qty' | 'act_reg_qty' | 'remain_qty'> = { bud: 'target_qty', act: 'act_reg_qty', rem: 'remain_qty' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const num = (s: string | undefined) => Number(s || 0) || 0;
const fmtN = (n: number) => String(Math.round(n * 100) / 100);
const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const actQty = (a: Row) => num(a.act_reg_qty) + num(a.act_ot_qty);
const actCost = (a: Row) => num(a.act_reg_cost) + num(a.act_ot_cost);

function asgStart(a: Row, t: Row | undefined): { t: number | null; actual: boolean } {
  const as = parseP6Date(a.act_start_date || t?.act_start_date);
  if (as != null) return { t: as, actual: true };
  return { t: parseP6Date(a.restart_date || t?.restart_date || t?.early_start_date || a.target_start_date || t?.target_start_date), actual: false };
}
function asgFinish(a: Row, t: Row | undefined): { t: number | null; actual: boolean } {
  const af = parseP6Date(a.act_end_date || t?.act_end_date);
  if (af != null) return { t: af, actual: true };
  return { t: parseP6Date(a.reend_date || t?.reend_date || t?.early_end_date || a.target_end_date || t?.target_end_date), actual: false };
}

function bucketLabel(t: number, bucket: UsageBucket): string {
  const d = new Date(t * 60000);
  const dd = String(d.getUTCDate()).padStart(2, '0'), mon = MON[d.getUTCMonth()], yy = String(d.getUTCFullYear()).slice(2);
  return bucket === 'month' ? `${mon}-${yy}` : `${dd}-${mon}-${yy}`;
}

export function AssignmentsView() {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const db = ctx.db;
  const hpd = ui.prefs.hoursPerDay;
  const [selKey, setSelKey] = useState<string | null>(null);
  const [bucket, setBucket] = useState<UsageBucket>('week');
  const [sheet, setSheet] = useState(false);

  const open = useMemo(() => new Set(ui.openProjects), [ui.openProjects]);
  const asgs = useMemo(() => rows(db, 'TASKRSRC').filter((a) => open.has(a.proj_id) || open.has(ctx.taskById.get(a.task_id)?.proj_id ?? '')), [ctx, db, open]);

  const items = useMemo(() => {
    const byRsrc = new Map<string, Row[]>();
    for (const a of asgs) {
      if (!byRsrc.has(a.rsrc_id)) byRsrc.set(a.rsrc_id, []);
      byRsrc.get(a.rsrc_id)!.push(a);
    }
    const label = (id: string) => ctx.rsrc.get(id)?.rsrc_short_name ?? `[${id || 'none'}]`;
    const out: GridItem[] = [];
    for (const rid of [...byRsrc.keys()].sort((x, y) => label(x).localeCompare(label(y), undefined, { numeric: true }))) {
      const list = byRsrc.get(rid)!;
      const r = ctx.rsrc.get(rid);
      const collapsed = !!ui.collapsed[`as:${rid}`];
      const sum = (f: (a: Row) => number) => list.reduce((s, a) => s + f(a), 0);
      let s = Infinity, f = -Infinity;
      for (const a of list) {
        const t = ctx.taskById.get(a.task_id);
        const st = asgStart(a, t).t, fi = asgFinish(a, t).t;
        if (st != null) s = Math.min(s, st);
        if (fi != null) f = Math.max(f, fi);
      }
      out.push({
        key: `g:${rid}`, kind: 'group', level: 0, hasChildren: true, collapsed, style: { background: 'var(--wbs2)' },
        label: `${label(rid)}  ${r?.rsrc_name ?? '(resource not in dictionary)'}${r ? `  (${RSRC_TYPES[r.rsrc_type] ?? r.rsrc_type})` : ''}`,
        cells: {
          bud: fmtN(sum((a) => num(a.target_qty))), act: fmtN(sum(actQty)), rem: fmtN(sum((a) => num(a.remain_qty))), atc: fmtN(sum((a) => actQty(a) + num(a.remain_qty))),
          start: Number.isFinite(s) ? fmtDate(s, ctx.prefs) : '', finish: Number.isFinite(f) ? fmtDate(f, ctx.prefs) : '',
          bcost: money(sum((a) => num(a.target_cost))), acost: money(sum(actCost)), rcost: money(sum((a) => num(a.remain_cost))),
        },
      });
      if (collapsed) continue;
      const sorted = [...list].sort((x, y) => (asgStart(x, ctx.taskById.get(x.task_id)).t ?? 0) - (asgStart(y, ctx.taskById.get(y.task_id)).t ?? 0)
        || (ctx.taskById.get(x.task_id)?.task_code ?? '').localeCompare(ctx.taskById.get(y.task_id)?.task_code ?? '', undefined, { numeric: true }));
      for (const a of sorted) {
        const t = ctx.taskById.get(a.task_id);
        const st = asgStart(a, t), fi = asgFinish(a, t);
        out.push({
          key: `a:${a.taskrsrc_id}`, kind: 'row', level: 1,
          cells: {
            rid: label(rid), rname: r?.rsrc_name ?? '', code: t?.task_code ?? `[${a.task_id}]`, tname: t?.task_name ?? '',
            bud: fmtN(num(a.target_qty)), act: fmtN(actQty(a)), rem: fmtN(num(a.remain_qty)), atc: fmtN(actQty(a) + num(a.remain_qty)),
            upt: `${fmtN(num(a.target_qty_per_hr) * hpd)}${(a.rsrc_type || r?.rsrc_type) === 'RT_Mat' ? '/d' : 'h/d'}`,
            start: st.t != null ? fmtDate(st.t, ctx.prefs) + (st.actual ? ' A' : '') : '',
            finish: fi.t != null ? fmtDate(fi.t, ctx.prefs) + (fi.actual ? ' A' : '') : '',
            bcost: money(num(a.target_cost)), acost: money(actCost(a)), rcost: money(num(a.remain_cost)),
          },
        });
      }
    }
    return out;
  }, [asgs, ctx, ui.collapsed, hpd]);

  // selected resource for the profile
  const selAsg = selKey?.startsWith('a:') ? asgs.find((a) => a.taskrsrc_id === selKey.slice(2)) : undefined;
  const rsrcIds = useMemo(() => new Set(asgs.map((a) => a.rsrc_id)), [asgs]);
  const profRsrc = selKey?.startsWith('g:') ? selKey.slice(2) : selAsg ? selAsg.rsrc_id : ui.selRsrc && rsrcIds.has(ui.selRsrc) ? ui.selRsrc : asgs[0]?.rsrc_id;

  const range = useMemo(() => {
    let s = Infinity, f = -Infinity;
    for (const a of asgs) {
      const t = ctx.taskById.get(a.task_id);
      for (const v of [asgStart(a, t).t, parseP6Date(a.target_start_date)]) if (v != null) s = Math.min(s, v);
      for (const v of [asgFinish(a, t).t, parseP6Date(a.target_end_date)]) if (v != null) f = Math.max(f, v);
    }
    if (!Number.isFinite(s) || !Number.isFinite(f)) {
      for (const pid of ui.openProjects) {
        const p = ctx.proj.get(pid);
        for (const v of [parseP6Date(p?.plan_start_date), parseP6Date(p?.last_recalc_date)]) if (v != null) s = Math.min(s, v);
        for (const v of [parseP6Date(p?.scd_end_date), parseP6Date(p?.plan_end_date), parseP6Date(p?.last_recalc_date)]) if (v != null) f = Math.max(f, v);
      }
    }
    if (!Number.isFinite(s)) return null;
    if (!Number.isFinite(f) || f <= s) f = s + 7 * MIN_PER_DAY;
    return { start: s, end: f + 1 };
  }, [asgs, ctx, ui.openProjects]);

  const usage = useMemo(() => {
    if (!range || !profRsrc) return null;
    const u = spreadUsage(db, ui.openProjects, { start: range.start, end: range.end, bucket, rsrcId: profRsrc });
    return { buckets: u.buckets, row: u.rows.find((r) => r.rsrcId === profRsrc) };
  }, [ctx, db, ui.openProjects, range, bucket, profRsrc]);

  if (!ui.openProjects.length) return <div className="empty">No project is open. Open a project in the Projects window to see its resource assignments.</div>;

  const getEditor = (key: string, col: string): EditorSpec | null => {
    if (!key.startsWith('a:') || !FIELD[col]) return null;
    const a = asgs.find((x) => x.taskrsrc_id === key.slice(2));
    if (!a) return null;
    return { type: 'number', value: fmtN(col === 'act' ? num(a.act_reg_qty) : num(a[FIELD[col]])) };
  };
  const onCommit = (key: string, col: string, v: string) => {
    const field = FIELD[col];
    const id = key.slice(2);
    const value = Number(v);
    if (!field) return;
    if (!(value >= 0)) return toast('Units must be zero or greater.');
    const a0 = asgs.find((x) => x.taskrsrc_id === id);
    if (!a0) return;
    if (num(a0[field]) === value) return;
    const t0 = ctx.taskById.get(a0.task_id);
    if (!t0) return toast('The activity of this assignment is missing.');
    if (field === 'act_reg_qty' && value > 0 && !t0.act_start_date) return toast('The activity has not started. Set an actual start before entering actual units.');
    mutate(`Edit ${COLS.find((c) => c.id === col)?.title ?? 'Units'}`, (d) => {
      const a = d.tables.TASKRSRC.rows.find((x) => x.taskrsrc_id === id);
      const t = d.tables.TASK?.rows.find((x) => x.task_id === a?.task_id);
      if (a && t) recalcAssignment(d, t, a, field, value);
    });
  };

  const onSelect = (k: string) => {
    setSelKey(k);
    const rid = k.startsWith('g:') ? k.slice(2) : asgs.find((a) => a.taskrsrc_id === k.slice(2))?.rsrc_id;
    if (rid) setUi({ selRsrc: rid });
  };

  const prof = profRsrc ? ctx.rsrc.get(profRsrc) : undefined;
  return (
    <>
      <div className="layoutbar">
        <span>Assignments: <b>{asgs.length}</b></span>
        <span>Resources: <b>{rsrcIds.size}</b></span>
        <span className="muted">Double-click Budgeted, Actual or Remaining Units to edit.</span>
      </div>
      <div className="winbody">
        <Split dir="v" initial={320} storeKey="assignments">
          <Grid cols={COLS} items={items} selected={new Set(selKey ? [selKey] : [])} labelSpan={4}
            onSelect={onSelect}
            onToggle={(k) => setUi((u) => ({ collapsed: { ...u.collapsed, [`as:${k.slice(2)}`]: !u.collapsed[`as:${k.slice(2)}`] } }))}
            getEditor={getEditor} onCommit={onCommit}
            onActivate={(k) => { const a = asgs.find((x) => x.taskrsrc_id === k.slice(2)); if (a) setUi({ selTask: a.task_id, selTasks: [a.task_id], view: 'activities', detailTab: 'resources' }); }}
            onContextMenu={(k, e) => {
              if (k) onSelect(k);
              const a = k?.startsWith('a:') ? asgs.find((x) => x.taskrsrc_id === k.slice(2)) : undefined;
              const rid = k?.startsWith('g:') ? k.slice(2) : a?.rsrc_id;
              showContextMenu(e, [
                ...(a ? [{ label: 'Go To Activity', onClick: () => setUi({ selTask: a.task_id, selTasks: [a.task_id], view: 'activities', detailTab: 'resources' }) }] : []),
                ...(rid ? [{ label: 'Open Resource in Dictionary', onClick: () => setUi({ selRsrc: rid, view: 'resources' }) }] : []),
                { label: 'Expand All', onClick: () => setUi((u) => ({ collapsed: Object.fromEntries(Object.entries(u.collapsed).filter(([x]) => !x.startsWith('as:'))) })) },
                { label: 'Collapse All', onClick: () => setUi((u) => ({ collapsed: { ...u.collapsed, ...Object.fromEntries([...rsrcIds].map((x) => [`as:${x}`, true])) } })) },
              ]);
            }}
            emptyText="The open projects have no resource assignments. Assign resources on the Resources tab of the Activities window." />
          <div className="details">
            <div className="layoutbar" style={{ color: '#000' }}>
              <b>{sheet ? 'Resource Usage Spreadsheet' : 'Resource Usage Profile'}</b>
              <span>{prof ? `${prof.rsrc_short_name} - ${prof.rsrc_name}` : profRsrc ? `[${profRsrc}]` : ''}</span>
              <span style={{ flex: 1 }} />
              <label>Timescale <select value={bucket} onChange={(e) => setBucket(e.target.value as UsageBucket)}>
                <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
              </select></label>
              <button className={`tbtn ${!sheet ? 'on' : ''}`} onClick={() => setSheet(false)}><span className="lbl">Profile</span></button>
              <button className={`tbtn ${sheet ? 'on' : ''}`} onClick={() => setSheet(true)}><span className="lbl">Spreadsheet</span></button>
            </div>
            {!usage?.row || !usage.buckets.length ? <div className="empty">{asgs.length ? 'Select a resource assignment to see its usage.' : 'No resource assignments to show.'}</div>
              : sheet ? <UsageSheet buckets={usage.buckets} row={usage.row} bucket={bucket} />
                : <UsageProfile buckets={usage.buckets} row={usage.row} bucket={bucket} prefs={ui.prefs} dataDate={parseP6Date(ctx.proj.get(ui.openProjects[0])?.last_recalc_date)} />}
          </div>
        </Split>
      </div>
    </>
  );
}

function UsageSheet({ buckets, row, bucket }: { buckets: number[]; row: UsageRow; bucket: UsageBucket }) {
  let cum = 0;
  const cumul = buckets.map((_b, i) => (cum += row.actual[i] + row.remaining[i]));
  const lines: [string, (i: number) => number, string?][] = [
    ['Actual Units', (i) => row.actual[i]],
    ['Remaining Units', (i) => row.remaining[i]],
    ['Total Units', (i) => row.actual[i] + row.remaining[i]],
    ['Available Units', (i) => row.capacity[i]],
    ['Overallocated Units', (i) => Math.max(0, row.actual[i] + row.remaining[i] - row.capacity[i]), '#c00000'],
    ['Cumulative Units', (i) => cumul[i]],
  ];
  return (
    <div className="tblwrap" style={{ flex: 1, margin: 4 }}>
      <table className="tbl" style={{ width: 'auto' }}>
        <thead><tr><th style={{ left: 0, zIndex: 2, minWidth: 130 }}>Units (h)</th>{buckets.map((b) => <th key={b} style={{ textAlign: 'right', minWidth: 62 }}>{bucketLabel(b, bucket)}</th>)}<th style={{ textAlign: 'right' }}>Total</th></tr></thead>
        <tbody>
          {lines.map(([label, f, color]) => (
            <tr key={label}>
              <td style={{ position: 'sticky', left: 0, background: '#f4f4f4' }}>{label}</td>
              {buckets.map((b, i) => { const v = f(i); return <td key={b} style={{ textAlign: 'right', color: v > 0.005 ? color : undefined }}>{v > 0.005 || v < -0.005 ? fmtN(v) : ''}</td>; })}
              <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{label === 'Cumulative Units' ? fmtN(cumul.at(-1) ?? 0) : fmtN(buckets.reduce((s, _b, i) => s + f(i), 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function niceStep(max: number, ticks: number): number {
  const raw = max / Math.max(1, ticks);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

function UsageProfile({ buckets, row, bucket, prefs, dataDate }: { buckets: number[]; row: UsageRow; bucket: UsageBucket; prefs: Prefs; dataDate: number | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const axis = useRef<HTMLCanvasElement>(null);
  const plot = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const AXIS_W = 52, TOP = 10, BOTTOM = 32;
  const minBw = bucket === 'day' ? 16 : bucket === 'week' ? 34 : 56;
  const avail = Math.max(50, size.w - AXIS_W);
  const bw = Math.max(minBw, avail / buckets.length);
  const plotW = Math.ceil(bw * buckets.length);
  const H = Math.max(80, size.h - 18); // leave room for a horizontal scrollbar
  const ph = H - TOP - BOTTOM;
  let maxY = 0;
  for (let i = 0; i < buckets.length; i++) maxY = Math.max(maxY, row.actual[i] + row.remaining[i], row.capacity[i]);
  const step = niceStep(maxY * 1.1 || 1, Math.max(2, Math.floor(ph / 28)));
  const top = Math.max(step, Math.ceil((maxY * 1.05) / step) * step);
  const y = (v: number) => TOP + ph - (v / top) * ph;

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const setup = (c: HTMLCanvasElement | null, w: number) => {
      if (!c) return null;
      c.width = Math.round(w * dpr); c.height = Math.round(H * dpr);
      c.style.width = `${w}px`; c.style.height = `${H}px`;
      const g = c.getContext('2d');
      if (!g) return null;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.font = '11px Tahoma, "Segoe UI", sans-serif';
      return g;
    };
    // y axis
    const ga = setup(axis.current, AXIS_W);
    if (ga) {
      ga.fillStyle = '#f0f0f0'; ga.fillRect(0, 0, AXIS_W, H);
      ga.strokeStyle = '#808080'; ga.beginPath(); ga.moveTo(AXIS_W - 0.5, TOP); ga.lineTo(AXIS_W - 0.5, TOP + ph); ga.stroke();
      ga.fillStyle = '#000'; ga.textAlign = 'right'; ga.textBaseline = 'middle';
      for (let v = 0; v <= top + 1e-9; v += step) {
        const yy = Math.round(y(v)) + 0.5;
        ga.beginPath(); ga.moveTo(AXIS_W - 4, yy); ga.lineTo(AXIS_W, yy); ga.stroke();
        ga.fillText(`${fmtN(v)}h`, AXIS_W - 6, yy);
      }
    }
    const g = setup(plot.current, plotW);
    if (!g) return;
    g.fillStyle = '#fff'; g.fillRect(0, 0, plotW, H);
    // grid lines
    g.strokeStyle = '#e4e4e4'; g.lineWidth = 1;
    for (let v = step; v <= top + 1e-9; v += step) { const yy = Math.round(y(v)) + 0.5; g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke(); }
    // bars
    const pad = Math.min(3, bw * 0.15);
    for (let i = 0; i < buckets.length; i++) {
      const x0 = i * bw + pad, w = Math.max(1, bw - 2 * pad);
      const a = row.actual[i], r = row.remaining[i], cap = row.capacity[i];
      if (a > 0) { g.fillStyle = '#2050d0'; g.fillRect(x0, y(a), w, y(0) - y(a)); }
      if (r > 0) {
        g.fillStyle = '#00b000'; g.fillRect(x0, y(a + r), w, y(a) - y(a + r));
        if (a + r > cap + 1e-6) {
          const from = Math.max(cap, a);
          g.fillStyle = '#e00000'; g.fillRect(x0, y(a + r), w, y(from) - y(a + r));
        }
      }
    }
    // availability (capacity) line
    g.strokeStyle = '#000'; g.lineWidth = 1.5; g.beginPath();
    for (let i = 0; i < buckets.length; i++) {
      const yy = Math.round(y(row.capacity[i])) + 0.5;
      if (i === 0) g.moveTo(0, yy); else g.lineTo(i * bw, yy);
      g.lineTo((i + 1) * bw, yy);
    }
    g.stroke(); g.lineWidth = 1;
    // data date
    if (dataDate != null && buckets.length) {
      const i = buckets.findIndex((b, k) => dataDate >= b && (k === buckets.length - 1 || dataDate < buckets[k + 1]));
      if (i >= 0) {
        const next = i < buckets.length - 1 ? buckets[i + 1] : buckets[i] + (bucket === 'day' ? MIN_PER_DAY : bucket === 'week' ? 7 * MIN_PER_DAY : 30 * MIN_PER_DAY);
        const xx = Math.round(i * bw + ((dataDate - buckets[i]) / (next - buckets[i])) * bw) + 0.5;
        g.strokeStyle = '#d00000'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(xx, TOP); g.lineTo(xx, TOP + ph); g.stroke(); g.setLineDash([]);
      }
    }
    // time axis
    const ay = TOP + ph;
    g.fillStyle = '#f0f0f0'; g.fillRect(0, ay, plotW, BOTTOM);
    g.strokeStyle = '#808080'; g.beginPath(); g.moveTo(0, ay + 0.5); g.lineTo(plotW, ay + 0.5); g.moveTo(0, ay + 16.5); g.lineTo(plotW, ay + 16.5); g.stroke();
    g.fillStyle = '#000'; g.textBaseline = 'middle'; g.textAlign = 'left';
    // upper band: month (day/week) or year (month)
    let bandStart = 0, bandKey = '';
    const flushBand = (endX: number) => {
      if (!bandKey) return;
      g.strokeStyle = '#a0a0a0'; g.beginPath(); g.moveTo(Math.round(endX) + 0.5, ay); g.lineTo(Math.round(endX) + 0.5, ay + 16); g.stroke();
      g.save(); g.beginPath(); g.rect(bandStart, ay, endX - bandStart, 16); g.clip(); g.fillText(bandKey, bandStart + 3, ay + 8.5); g.restore();
    };
    for (let i = 0; i < buckets.length; i++) {
      const d = new Date(buckets[i] * 60000);
      const key = bucket === 'month' ? String(d.getUTCFullYear()) : `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      if (key !== bandKey) { flushBand(i * bw); bandKey = key; bandStart = i * bw; }
    }
    flushBand(plotW);
    // lower band: one label per bucket (thinned when narrow)
    const lbl = (t: number) => { const d = new Date(t * 60000); return bucket === 'month' ? MON[d.getUTCMonth()] : String(d.getUTCDate()).padStart(2, '0'); };
    const every = Math.max(1, Math.ceil(22 / bw));
    g.textAlign = 'center';
    for (let i = 0; i < buckets.length; i++) {
      g.strokeStyle = '#c8c8c8'; g.beginPath(); g.moveTo(Math.round(i * bw) + 0.5, ay + 16); g.lineTo(Math.round(i * bw) + 0.5, ay + BOTTOM); g.stroke();
      if (i % every === 0) g.fillText(lbl(buckets[i]), i * bw + bw / 2, ay + 24.5);
    }
  }, [buckets, row, bucket, bw, plotW, H, ph, top, step, dataDate]);

  const onMove = (e: RME<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left) / bw);
    if (i < 0 || i >= buckets.length || e.clientY - rect.top > TOP + ph) { setTip(null); return; }
    const a = row.actual[i], r = row.remaining[i], c = row.capacity[i];
    const over = a + r - c;
    setTip({ x: e.clientX + 12, y: e.clientY + 12, text: `${bucket === 'month' ? bucketLabel(buckets[i], 'month') : `${bucket === 'week' ? 'Week of ' : ''}${fmtDate(buckets[i], prefs, false)}`}\nActual: ${fmtN(a)}h\nRemaining: ${fmtN(r)}h\nAvailable: ${fmtN(c)}h${over > 0.005 ? `\nOverallocated: ${fmtN(over)}h` : ''}` });
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#fff' }}>
      <div ref={wrap} style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        <canvas ref={axis} style={{ flex: 'none' }} />
        <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', minWidth: 0 }}>
          <canvas ref={plot} style={{ display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
        </div>
      </div>
      <div style={{ flex: 'none', display: 'flex', gap: 14, padding: '2px 8px', borderTop: '1px solid #ddd', background: '#f7f7f7' }}>
        <Legend color="#2050d0" label="Actual Units" />
        <Legend color="#00b000" label="Remaining Units" />
        <Legend color="#e00000" label="Overallocation" />
        <span><span style={{ display: 'inline-block', width: 16, borderTop: '2px solid #000', verticalAlign: 'middle', marginRight: 4 }} />Limit (Max Units)</span>
        <span><span style={{ display: 'inline-block', width: 16, borderTop: '1px dashed #d00000', verticalAlign: 'middle', marginRight: 4 }} />Data Date</span>
      </div>
      {tip && <div className="gantt-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span><span style={{ display: 'inline-block', width: 10, height: 10, background: color, verticalAlign: -1, marginRight: 4 }} />{label}</span>;
}

/** View > Show on Bottom > Resource Usage Profile / Spreadsheet in the Activities window: the selected activity's resource. */
export function ActivityUsagePane({ sheet }: { sheet: boolean }) {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const db = ctx.db;
  const [bucket, setBucket] = useState<UsageBucket>('week');
  const mine = useMemo(() => (ui.selTask ? rows(db, 'TASKRSRC').filter((a) => a.task_id === ui.selTask) : []), [db, ctx, ui.selTask]);
  const [pick, setPick] = useState<string | null>(null);
  const rsrcId = pick && mine.some((a) => a.rsrc_id === pick) ? pick : mine[0]?.rsrc_id ?? ui.selRsrc;
  const range = useMemo(() => {
    let s = Infinity, f = -Infinity;
    for (const pid of ui.openProjects) {
      const p = ctx.proj.get(pid);
      for (const v of [parseP6Date(p?.plan_start_date), parseP6Date(p?.last_recalc_date)]) if (v != null) s = Math.min(s, v);
      for (const v of [parseP6Date(p?.scd_end_date), parseP6Date(p?.plan_end_date)]) if (v != null) f = Math.max(f, v);
    }
    for (const a of mine) { const t = ctx.taskById.get(a.task_id); for (const v of [asgStart(a, t).t]) if (v != null) s = Math.min(s, v); for (const v of [asgFinish(a, t).t]) if (v != null) f = Math.max(f, v); }
    if (!Number.isFinite(s)) return null;
    if (!Number.isFinite(f) || f <= s) f = s + 30 * MIN_PER_DAY;
    return { start: s, end: f + 1 };
  }, [ctx, ui.openProjects, mine]);
  const usage = useMemo(() => {
    if (!range || !rsrcId) return null;
    const u = spreadUsage(db, ui.openProjects, { start: range.start, end: range.end, bucket, rsrcId });
    return { buckets: u.buckets, row: u.rows.find((r) => r.rsrcId === rsrcId) };
  }, [ctx, db, ui.openProjects, range, bucket, rsrcId]);
  const r = rsrcId ? ctx.rsrc.get(rsrcId) : undefined;
  return (
    <div className="details">
      <div className="layoutbar" style={{ color: '#000' }}>
        <b>{sheet ? 'Resource Usage Spreadsheet' : 'Resource Usage Profile'}</b>
        {mine.length > 1 ? <select value={rsrcId ?? ''} onChange={(e) => setPick(e.target.value)}>{mine.map((a) => <option key={a.taskrsrc_id} value={a.rsrc_id}>{ctx.rsrc.get(a.rsrc_id)?.rsrc_short_name ?? a.rsrc_id}</option>)}</select>
          : <span>{r ? `${r.rsrc_short_name} - ${r.rsrc_name}` : ''}</span>}
        <span style={{ flex: 1 }} />
        <label>Timescale <select value={bucket} onChange={(e) => setBucket(e.target.value as UsageBucket)}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label>
        <button className={`tbtn ${!sheet ? 'on' : ''}`} onClick={() => setUi({ bottom: 'profile' })}><span className="lbl">Profile</span></button>
        <button className={`tbtn ${sheet ? 'on' : ''}`} onClick={() => setUi({ bottom: 'spreadsheet' })}><span className="lbl">Spreadsheet</span></button>
        <button className="tbtn" onClick={() => setUi({ bottom: 'details' })}><span className="lbl">Activity Details</span></button>
      </div>
      {!usage?.row || !usage.buckets.length ? <div className="empty">{ui.selTask ? 'The selected activity has no resource assignments.' : 'Select an activity to see its resource usage.'}</div>
        : sheet ? <UsageSheet buckets={usage.buckets} row={usage.row} bucket={bucket} />
          : <UsageProfile buckets={usage.buckets} row={usage.row} bucket={bucket} prefs={ui.prefs} dataDate={parseP6Date(ctx.proj.get(ui.openProjects[0])?.last_recalc_date)} />}
    </div>
  );
}
