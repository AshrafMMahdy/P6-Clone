// Extensions > LOB: a location-based plan of the open file, drawn as a flowline and edited by hand. Drag a line's end
// to change its duration (the task's driver decides what follows, and a toast lists every value that moved), drag its
// middle to move it (a manual start), Alt+click a floor on it to split there, Shift+drag from one task's floor to
// another's to link them. The task panel edits crews, drivers, quantities and logic; the takt grid shows zones by
// periods. Every action is one undoable change; the plan travels in the file as the MCP tools keep it.
import { useMemo, useRef, useState } from 'react';
import { getDb, getUi, mutate, setUi, toast, useStore } from '../store.ts';
import { rows, type Db } from '../../core/db.ts';
import { applyOps } from '../../core/project/ops.ts';
import { calendarResolver } from '../../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../../core/resource/assign.ts';
import { formatP6Date, parseP6Date } from '../../core/dates.ts';
import { applyLobOps, buildLocations, type LobOp } from '../../core/lob/input.ts';
import { expandLob } from '../../core/lob/expand.ts';
import { scheduleLob } from '../../core/lob/pace.ts';
import { loadLobModels, saveLobOps } from '../../core/lob/store.ts';
import { lobView } from '../../core/lob/view.ts';
import { flowFrame, flowGeometry } from '../../core/lob/svg.ts';
import { taktCheck, taktApply, taktZones } from '../../core/lob/takt.ts';
import { locationDurations } from '../../core/lob/edit.ts';
import { writeTactplan } from '../../core/lob/tactplan.ts';
import type { LobChange, LobModel } from '../../core/lob/model.ts';

const W = 1200;
const bar = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } as const;
const say = (c: LobChange[]) => c.slice(0, 6).map((x) => `${x.task}${x.segment ? ` ${x.segment}` : ''}${x.location ? ` ${x.location}` : ''} ${x.field} ${x.old ?? '–'} → ${x.new ?? '–'}`).join('; ') + (c.length > 6 ? `; and ${c.length - 6} more` : '');

/** Expand, save and schedule a plan inside one undoable change. */
export function commitLob(label: string, projId: string, prev: LobModel | null, next: LobModel): boolean {
  const hpd = getUi().prefs.hoursPerDay;
  let err = '';
  try {
    mutate(label, (d) => {
      const ex = expandLob(d, projId, next, { hoursPerDay: hpd, previous: prev });
      if (!ex.ok) { err = ex.error!; throw new Error(err); }
      const sv = applyOps(d, saveLobOps(d, projId, next), { hoursPerDay: hpd });
      if (!sv.ok) { err = sv.error!.message; throw new Error(err); }
      const models = new Map([...loadLobModels(d)].map(([pid, x]) => [pid, x.model]));
      const ids = rows(d, 'PROJECT').filter((p) => !p._baseline_of).map((p) => p.proj_id);
      const r = scheduleLob(d, ids, models, { hoursPerDay: hpd });
      if (!r.ok) { err = r.error ?? 'the plan cannot be scheduled'; throw new Error(err); }
      syncAssignmentDates(d);
    });
  } catch { /* reported below */ }
  if (err) { toast(`Not applied: ${err}`); return false; }
  return true;
}

export function LobPanel() {
  const ui = useStore((s) => s.ui);
  const ver = useStore((s) => s.dbVersion);
  const db = getDb();
  const plans = useMemo(() => [...loadLobModels(db)].map(([projId, x]) => ({ projId, code: rows(db, 'PROJECT').find((p) => p.proj_id === projId)!.proj_short_name, ...x })), [ver]);
  const [pick, setPick] = useState<string | null>(null);
  const plan = plans.find((p) => p.projId === pick) ?? plans[0];
  const [tab, setTab] = useState<'flow' | 'takt'>('flow');
  const [sel, setSel] = useState<{ task: string; segment: number } | null>(null);
  const act = (label: string, ops: LobOp[]) => {
    if (!plan) return;
    let next;
    try { next = applyLobOps(plan.model, ops); } catch (e) { toast((e as Error).message); return; }
    // one toast: every value that moved, then any note (a crew rounded to whole people...)
    if (commitLob(label, plan.projId, plan.model, next.model)) toast([next.changes.length ? say(next.changes) : 'Nothing changed.', ...next.notes].join(' · '));
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', minHeight: 0 }}>
      <div style={bar}>
        {plans.length > 0 && <select value={plan?.projId} onChange={(e) => setPick(e.target.value)}>{plans.map((p) => <option key={p.projId} value={p.projId}>{p.code}</option>)}</select>}
        <NewPlan />
        <button onClick={() => void importPlan()}>Import Vico / Tactplan…</button>
        {plan && <button onClick={() => void window.p6.bimWriteFiles({ title: 'Folder for the Tactplan files', files: writeTactplan(plan.model, { decimal: 'dot', date: 'dd/MM/yyyy' }).map((f) => ({ name: f.name, data: f.text })) }).then((w) => w && toast(`Wrote ${w.length} files for Tactplan.`))}>Export to Tactplan…</button>}
        {plan && <span className="seg"><button className={tab === 'flow' ? 'on' : ''} onClick={() => setTab('flow')}>Flowline</button><button className={tab === 'takt' ? 'on' : ''} onClick={() => setTab('takt')}>Takt grid</button></span>}
        {plan && plan.from !== 'notebook' && <span style={{ color: '#b00' }}>{plan.problems.join(' ')}</span>}
      </div>
      {!plan ? <div className="muted">No LOB plan in this file yet: New LOB plan, or import one from Vico or Tactplan.</div> : (
        <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
          <div style={{ flex: 3, minWidth: 0, overflow: 'auto', border: '1px solid #c4cfe0', background: '#fff' }}>
            {tab === 'flow' ? <Flowline db={db} projId={plan.projId} model={plan.model} sel={sel} onSelect={setSel} act={act} /> : <TaktGrid db={db} projId={plan.projId} model={plan.model} act={act} />}
          </div>
          <div style={{ flex: 1, minWidth: 260, overflow: 'auto' }}><TaskPanel model={plan.model} sel={sel} onSelect={setSel} act={act} /></div>
        </div>
      )}
    </div>
  );
}

function NewPlan() {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ id: 'LOB', start: new Date().toISOString().slice(0, 10), levels: 'Part, Floor', counts: '2, 9' });
  if (!open) return <button onClick={() => setOpen(true)}>New LOB plan…</button>;
  const create = () => {
    const levels = f.levels.split(',').map((x) => x.trim()).filter(Boolean), grid = f.counts.split(',').map((x) => Number(x.trim()));
    let model: LobModel;
    try { model = { version: 1, project: f.id, levels, locations: buildLocations({ levels, grid }), tasks: [], links: [] }; } catch (e) { toast((e as Error).message); return; }
    if (rows(getDb(), 'PROJECT').some((p) => p.proj_short_name.toLowerCase() === f.id.toLowerCase())) { toast(`A project ${f.id} is already open.`); return; }
    newProject(f.id, f.start, model, []);
    setOpen(false);
  };
  return <span style={bar}>ID <input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} style={{ width: 80 }} /> start <input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /> levels <input value={f.levels} onChange={(e) => setF({ ...f, levels: e.target.value })} style={{ width: 110 }} /> counts <input value={f.counts} onChange={(e) => setF({ ...f, counts: e.target.value })} style={{ width: 60 }} /><button onClick={create}>Create</button><button onClick={() => setOpen(false)}>Cancel</button></span>;
}

function newProject(id: string, start: string, model: LobModel, before: unknown[]): void {
  const hpd = getUi().prefs.hoursPerDay;
  let projId = '';
  try { mutate(`New LOB plan ${id}`, (d) => { const r = applyOps(d, [...before, { op: 'add_project', id, name: id, start, ...(before.length ? { calendar: (before[0] as { name: string }).name } : {}) }], { hoursPerDay: hpd }); if (!r.ok) throw new Error(r.error!.message); projId = rows(d, 'PROJECT').find((p) => p.proj_short_name === id)!.proj_id; }); }
  catch (e) { toast(`Not created: ${(e as Error).message}`); return; }
  // the new project is opened alongside, then the plan goes into it (a second undoable step)
  setUi((u) => ({ openProjects: [...new Set([...u.openProjects, projId])] }));
  commitLob(`LOB plan ${id}`, projId, null, { ...model, project: id });
}

async function importPlan(): Promise<void> {
  const r = await window.p6.lobImport();
  if (!r) return;
  if ('error' in r) { toast(`Not imported: ${r.error}`); return; }
  const id = (r.name.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'LOB').toUpperCase();
  let code = id;
  for (let k = 2; rows(getDb(), 'PROJECT').some((p) => p.proj_short_name === code); k++) code = `${id.slice(0, 17)}-${k}`;
  const cal = r.calendarOp ? [r.calendarOp] : [];
  if (cal.length) for (const t of r.model.tasks) t.calendar = (r.calendarOp as { name: string }).name;
  newProject(code, r.start, r.model, cal);
  for (const n of r.notes) toast(n);
}

function Flowline({ db, projId, model, sel, onSelect, act }: { db: Db; projId: string; model: LobModel; sel: { task: string; segment: number } | null; onSelect: (s: { task: string; segment: number } | null) => void; act: (label: string, ops: LobOp[]) => void }) {
  const ui = useStore((s) => s.ui);
  const view = useMemo(() => lobView(db, projId, model, { hoursPerDay: ui.prefs.hoursPerDay }), [db, projId, model]);
  const g = useMemo(() => flowGeometry(db, projId, model, view.critical), [db, projId, model, view]);
  const H = Math.max(360, 70 + g.rows.length * 22);
  const F = flowFrame(g, model.levels.length, W, H);
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<null | { mode: 'end' | 'move' | 'link'; task: string; segment: number; x0: number; x: number; y: number; location?: string }>(null);
  const cal = calendarResolver(db, []).fallback(rows(db, 'PROJECT').find((p) => p.proj_id === projId)!.clndr_id);
  const at = (e: React.MouseEvent) => { const p = svg.current!.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.current!.getScreenCTM()!.inverse()); };
  const nearVertex = (l: (typeof g.lines)[number], x: number, y: number) => { for (let k = 0; k < l.points.length; k += 2) { const [t, lo] = l.points[k]; if (Math.hypot(F.X(t) - x, F.Y(lo) - y) < 8) return l.locations[k / 2]; } return undefined; };
  const down = (e: React.MouseEvent, l: (typeof g.lines)[number]) => {
    e.stopPropagation();
    const p = at(e), loc = nearVertex(l, p.x, p.y);
    onSelect({ task: l.task, segment: l.segment });
    if (e.altKey && loc) { act(`Split ${l.task} at ${loc}`, [{ op: 'split', task: l.task, at: loc }]); return; }
    if (e.shiftKey && loc) { setDrag({ mode: 'link', task: l.task, segment: l.segment, x0: p.x, x: p.x, y: p.y, location: loc }); return; }
    const [tEnd, , hi] = l.points.at(-1)!;
    const end = Math.hypot(F.X(tEnd) - p.x, F.Y(hi) - p.y) < 12;
    setDrag({ mode: end ? 'end' : 'move', task: l.task, segment: l.segment, x0: p.x, x: p.x, y: p.y });
  };
  const up = (e: React.MouseEvent) => {
    if (!drag) return;
    const p = at(e), l = g.lines.find((x) => x.task === drag.task && x.segment === drag.segment)!;
    setDrag(null);
    if (Math.abs(p.x - drag.x0) < 3 && drag.mode !== 'link') return;
    if (drag.mode === 'end') {
      const start = l.points[0][0], fin = F.T(p.x);
      const days = Math.max(0.1, cal.workBetween(start, fin) / 60 / ui.prefs.hoursPerDay);
      act(`Duration of ${l.task}`, [{ op: 'set_duration', task: l.task, segment: l.segment, days: Math.round(days * 10) / 10 }]);
    } else if (drag.mode === 'move') {
      const start = l.points[0][0] + (F.T(p.x) - F.T(drag.x0));
      act(`Move ${l.task}`, [{ op: 'set_start', task: l.task, segment: l.segment, date: formatP6Date(cal.nextWorkStart(start)).slice(0, 10) }]);
    } else {
      const target = g.lines.find((x) => x.task !== drag.task && nearVertex(x, p.x, p.y));
      if (target) act(`Link ${drag.task} → ${target.task}`, [{ op: 'add_link', pred: drag.task, succ: target.task, pred_location: drag.location, succ_location: nearVertex(target, p.x, p.y) }]);
    }
  };
  return (
    <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 700, userSelect: 'none', fontFamily: 'Segoe UI, sans-serif', fontSize: 11 }} onMouseMove={(e) => drag && setDrag({ ...drag, ...(() => { const p = at(e); return { x: p.x, y: p.y }; })() })} onMouseUp={up} onMouseLeave={() => setDrag(null)} onMouseDown={() => onSelect(null)}>
      <rect width={W} height={H} fill="#fff" />
      {model.levels.map((_, lv) => { const seen = new Map<string, number[]>(); g.rows.forEach((r, k) => { const c = r.path[lv]; if (c) (seen.get(c) ?? seen.set(c, []).get(c)!).push(k); }); return [...seen].map(([c, ks]) => { const lo = Math.min(...ks), hi = Math.max(...ks) + 1; return <g key={`${lv}-${c}`}><line x1={10 + lv * 70} x2={W - F.right} y1={F.Y(lo)} y2={F.Y(lo)} stroke="#e3e8ef" /><text x={14 + lv * 70} y={(F.Y(lo) + F.Y(hi)) / 2 + 4} fill="#4a5568">{model.locations.find((l) => l.code === c)?.name ?? c}</text></g>; }); })}
      {months(g.t0, g.t1).map((m) => <g key={m}><line x1={F.X(Date.parse(`${m}-01T00:00:00Z`) / 60000)} x2={F.X(Date.parse(`${m}-01T00:00:00Z`) / 60000)} y1={F.top} y2={H - F.bottom} stroke="#f0f2f6" /><text x={F.X(Date.parse(`${m}-01T00:00:00Z`) / 60000) + 2} y={H - 10} fill="#6b7686">{m}</text></g>)}
      {g.dataDate != null && <line x1={F.X(g.dataDate)} x2={F.X(g.dataDate)} y1={F.top} y2={H - F.bottom} stroke="#d62728" strokeDasharray="4 3" />}
      {g.lines.filter((l) => l.points.length).map((l) => {
        const on = sel?.task === l.task && sel.segment === l.segment;
        const pts = l.points.map(([t, lo, hi], k) => `${F.X(t)},${k % 2 ? F.Y(hi) : F.Y(lo)}`).join(' ');
        return <g key={`${l.task}-${l.segment}`} onMouseDown={(e) => down(e, l)} style={{ cursor: 'pointer' }}>
          <polyline points={pts} fill="none" stroke="transparent" strokeWidth={10} />
          <polyline points={pts} fill="none" stroke={l.colour} strokeWidth={on ? 3.5 : l.critical ? 2.6 : 1.6} />
          <text x={F.X(l.points[0][0]) + 3} y={F.Y(l.points[0][1]) - 3} fill={l.colour}>{l.task}</text>
          {on && l.points.filter((_, k) => k % 2 === 0).map(([t, lo], k) => <circle key={k} cx={F.X(t)} cy={F.Y(lo)} r={3} fill={l.colour} />)}
        </g>;
      })}
      {drag && drag.mode === 'link' && <line x1={drag.x0} y1={drag.y} x2={drag.x} y2={drag.y} stroke="#555" strokeDasharray="3 2" />}
      {view.gaps.length > 0 && <text x={F.left} y={18} fill="#b26b00">{view.gaps.length} wait(s) between locations</text>}
      {view.collisions.length > 0 && <text x={F.left + 200} y={18} fill="#d62728">{view.collisions.length} collision(s)</text>}
    </svg>
  );
}
const months = (t0: number, t1: number) => { const out: string[] = []; const d = new Date(t0 * 60000); for (let x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); x.getTime() / 60000 <= t1; x.setUTCMonth(x.getUTCMonth() + 1)) out.push(x.toISOString().slice(0, 7)); return out; };

function TaktGrid({ db, projId, model, act }: { db: Db; projId: string; model: LobModel; act: (label: string, ops: LobOp[]) => void }) {
  const [takt, setTakt] = useState(String(model.takt?.taktDays ?? 5));
  const ui = useStore((s) => s.ui);
  if (!model.takt) return <div style={{ padding: 8 }}>No takt set. Takt time (working days) <input value={takt} onChange={(e) => setTakt(e.target.value)} style={{ width: 50 }} /> <button onClick={() => act('Set takt', [{ op: 'set_takt', takt_days: Number(takt) || 5, train: model.tasks.map((t) => t.code) }])}>Set takt</button></div>;
  const check = taktCheck(model), zones = taktZones(model);
  const cal = calendarResolver(db, []).fallback(rows(db, 'PROJECT').find((p) => p.proj_id === projId)!.clndr_id);
  const acts = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_code, t]));
  const t0 = Math.min(...[...acts.values()].map((a) => parseP6Date(a.early_start_date) ?? Infinity));
  const period = (t: number) => Math.floor(cal.workBetween(t0, t) / 60 / ui.prefs.hoursPerDay / model.takt!.taktDays);
  const cells = new Map<string, string>();
  model.tasks.forEach((t, ti) => { const d = locationDurations(model, t); for (const z of zones) for (const c of z.locations) { const a = acts.get(`${t.code}-${c}`); if (!a || !d.has(c)) continue; const p0 = period(parseP6Date(a.early_start_date)!), p1 = period(parseP6Date(a.early_end_date)! - 1); for (let p = p0; p <= p1; p++) cells.set(`${z.code}|${p}`, `${cells.has(`${z.code}|${p}`) ? '!' : ''}${ti}`); } });
  const last = Math.max(0, ...[...cells.keys()].map((k) => Number(k.split('|')[1])));
  const colour = (v: string) => (v.startsWith('!') ? '#d62728' : ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'][Number(v) % 8]);
  return <div style={{ padding: 8 }}>
    <div style={bar}>Takt {model.takt.taktDays} days · {check.fits ? 'every trade fits' : `${check.misfits.length} trade × zone do not fit`} {!check.fits && <button onClick={() => { const r = taktApply(model); if (commitLob('Onto the takt', projId, model, r.model)) toast(say(r.changes)); }}>Fit to the takt</button>}</div>
    {check.misfits.slice(0, 8).map((x) => <div key={`${x.task}${x.zone}`} className="muted">{x.task} in {x.zone}: {x.days} days ({x.fix})</div>)}
    <table style={{ borderCollapse: 'collapse', marginTop: 6 }}><tbody>{[...zones].reverse().map((z) => <tr key={z.code}><td style={{ paddingRight: 6 }}>{model.locations.find((l) => l.code === z.code)?.name ?? z.code}</td>{Array.from({ length: last + 1 }, (_, p) => { const v = cells.get(`${z.code}|${p}`); return <td key={p} title={v ? (v.startsWith('!') ? 'two trades' : model.tasks[Number(v)].code) : ''} style={{ width: 22, height: 18, border: '1px solid #eef1f5', background: v ? colour(v) : '#fff' }} />; })}</tr>)}</tbody></table>
  </div>;
}

function TaskPanel({ model, sel, onSelect, act }: { model: LobModel; sel: { task: string; segment: number } | null; onSelect: (s: { task: string; segment: number } | null) => void; act: (label: string, ops: LobOp[]) => void }) {
  const [nt, setNt] = useState({ code: '', name: '', consumption: '1', quantity: '100', crew_size: '5' });
  const t = model.tasks.find((x) => x.code === sel?.task);
  const k = sel?.segment ?? 1, s = t?.segments[k - 1];
  const num = (label: string, v: number | undefined, op: (n: number) => LobOp) => <label style={{ display: 'block' }}>{label} <input key={`${t?.code}${k}${label}${v}`} defaultValue={v ?? ''} style={{ width: 70 }} onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n !== v) act(`${t!.code} ${label}`, [op(n)]); }} /></label>;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    {t && s ? <>
      <fieldset><legend>{t.code} {t.name}</legend>
        <div className="muted" style={{ fontSize: 11 }}>{t.trade} · {t.order.length} locations · segment {k} of {t.segments.length} ({s.from}..{s.to})</div>
        <label>Driver <select value={s.driver} onChange={(e) => act(`${t.code} driver`, [{ op: 'set_driver', task: t.code, segment: k, driver: e.target.value as typeof s.driver }])}><option value="crew">crew held</option><option value="rate">rate held</option><option value="duration">duration held</option></select></label>
        <label style={{ display: 'block' }}>Timing <select value={s.timing} onChange={(e) => act(`${t.code} timing`, [{ op: 'set_timing', task: t.code, segment: k, timing: e.target.value as typeof s.timing }])}><option value="asap_paced">ASAP + paced</option><option value="paced">paced</option><option value="asap">as soon as possible</option></select></label>
        {num('Crews', s.crews, (n) => ({ op: 'set_crew', task: t.code, segment: k, crews: n }))}
        {num('Crew size', s.crewSize, (n) => ({ op: 'set_crew', task: t.code, segment: k, crew_size: n }))}
        {num('Productivity', s.productivity, (n) => ({ op: 'set_crew', task: t.code, segment: k, productivity: n }))}
        {num(`Rate (${t.items[0]?.unit || 'units'}/day)`, s.rate, (n) => ({ op: 'set_rate', task: t.code, segment: k, rate: n }))}
        {num('Consumption (h/unit)', t.items[0]?.consumption, (n) => ({ op: 'set_consumption', task: t.code, consumption: n }))}
        <div className="muted" style={{ fontSize: 11 }}>Held: {s.driver}; the other values are derived (greyed in P6 terms) and every change is listed.</div>
      </fieldset>
      <fieldset><legend>Locations</legend>
        <table style={{ fontSize: 11 }}><tbody>{t.order.map((c) => { const q = t.items[0]?.quantities.find((x) => x.location === c)?.quantity ?? 0, d = locationDurations(model, t).get(c); return <tr key={c}><td>{model.locations.find((l) => l.code === c)?.name ?? c}</td><td><input key={`${c}${q}`} defaultValue={q} style={{ width: 60 }} onBlur={(e) => Number(e.target.value) !== q && act(`${t.code} quantity ${c}`, [{ op: 'set_quantity', task: t.code, location: c, quantity: Number(e.target.value) || 0 }])} /></td><td>{d != null ? `${Math.round(d * 10) / 10} d` : '–'}</td><td>{t.segments.some((g) => g.from === c) && c !== t.order[0] ? <button onClick={() => act(`Merge ${t.code}`, [{ op: 'merge', task: t.code, at: c }])}>merge</button> : c !== t.order[0] ? <button onClick={() => act(`Split ${t.code}`, [{ op: 'split', task: t.code, at: c }])}>split</button> : null}</td></tr>; })}</tbody></table>
      </fieldset>
      <fieldset><legend>Logic</legend>
        {model.links.filter((l) => l.pred === t.code || l.succ === t.code).map((l, i) => <div key={i} style={bar}>{l.pred}{l.predLocation ? `@${l.predLocation}` : ''} → {l.succ}{l.succLocation ? `@${l.succLocation}` : ''} {l.type}{l.lagDays ? ` +${l.lagDays}d` : ''}{l.locationLag ? ` lag ${l.locationLag} loc` : ''}<button onClick={() => act('Remove link', [{ op: 'remove_link', pred: l.pred, succ: l.succ }])}>×</button></div>)}
        <AddLink model={model} task={t.code} act={act} />
      </fieldset>
      <button onClick={() => { if (confirm(`Remove ${t.code} and its activities?`)) { act(`Remove ${t.code}`, [{ op: 'remove_task', task: t.code }]); onSelect(null); } }}>Remove task</button>
    </> : <div className="muted">Click a line to edit its task. Drag a line's end to change its duration, its middle to move it; Alt+click a location on it to split there; Shift+drag from one task's location to another's to link them.</div>}
    <fieldset><legend>Add task</legend>
      {(['code', 'name', 'consumption', 'quantity', 'crew_size'] as const).map((f) => <label key={f} style={{ display: 'block' }}>{f.replace('_', ' ')} <input value={nt[f]} onChange={(e) => setNt({ ...nt, [f]: e.target.value })} style={{ width: 110 }} /></label>)}
      <button disabled={!nt.code || !nt.name} onClick={() => act(`Add ${nt.code}`, [{ op: 'add_task', code: nt.code, name: nt.name, consumption: Number(nt.consumption) || 1, quantity: Number(nt.quantity) || 0, crew_size: Number(nt.crew_size) || 1 }])}>Add</button>
    </fieldset>
  </div>;
}

function AddLink({ model, task, act }: { model: LobModel; task: string; act: (label: string, ops: LobOp[]) => void }) {
  const [f, setF] = useState({ pred: '', lag: '0', loc: '0' });
  return <div style={bar}>after <select value={f.pred} onChange={(e) => setF({ ...f, pred: e.target.value })}><option value="">…</option>{model.tasks.filter((x) => x.code !== task).map((x) => <option key={x.code}>{x.code}</option>)}</select> lag <input value={f.lag} onChange={(e) => setF({ ...f, lag: e.target.value })} style={{ width: 34 }} /> d, location lag <input value={f.loc} onChange={(e) => setF({ ...f, loc: e.target.value })} style={{ width: 28 }} /><button disabled={!f.pred} onClick={() => act(`Link ${f.pred} → ${task}`, [{ op: 'add_link', pred: f.pred, succ: task, lag_days: Number(f.lag) || 0, location_lag: Number(f.loc) || 0 }])}>Link</button></div>;
}
