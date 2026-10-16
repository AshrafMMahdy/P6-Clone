// Portfolios window: portfolio list + definition (selected projects or filter rule) on the left,
// portfolio dashboard (one row per project with schedule/cost/earned-value metrics) and a project span chart on the right.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Split } from '../components/Layout.tsx';
import { getDb, mutate, toast, useStore, type Prefs } from '../store.ts';
import { fmtDate, fmtDur } from '../model.ts';
import { openProjects } from './ProjectsView.tsx';
import { rows, type Db, type Row } from '../../core/db.ts';
import { MIN_PER_DAY } from '../../core/dates.ts';
import {
  createPortfolio, deletePortfolio, listPortfolios, portfolioSummary, projectsIn, projectStatus, projectTitle, realProjects, updatePortfolio,
  PROJECT_STATUS, type Portfolio, type PortfolioRule, type ProjectSummary,
} from '../../core/portfolio.ts';

const ALL = '*';
const USD = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }); // one formatter (creating one per cell is slow)
const money = (n: number) => USD.format(n);
const ratio = (n: number) => (n ? n.toFixed(2) : '');

function edit(label: string, fn: (db: Db) => void): boolean {
  try {
    // validate on a copy so a refused change leaves no undo entry
    fn(structuredClone({ tables: { _PORTFOLIO: getDb().tables._PORTFOLIO ?? { name: '_PORTFOLIO', fields: [], rows: [] } } }));
  } catch (e) {
    toast((e as Error).message);
    return false;
  }
  mutate(label, fn);
  return true;
}

export function PortfoliosView() {
  const db = useStore((s) => s.db);
  const v = useStore((s) => s.dbVersion);
  const prefs = useStore((s) => s.ui.prefs);
  const [selId, setSelId] = useState(ALL);
  const list = useMemo(() => listPortfolios(db), [db, v]);
  const sel = list.find((p) => p.id === selId);
  const projIds = useMemo(() => (sel ? projectsIn(db, sel.id) : realProjects(db).map((p) => p.proj_id)), [db, v, sel]);
  const summary = useMemo(() => portfolioSummary(db, projIds), [db, v, projIds]);
  const [selProj, setSelProj] = useState<string | null>(null);

  const add = () => {
    const names = new Set(list.map((p) => p.name.toLowerCase()));
    let n = list.length + 1;
    while (names.has(`portfolio ${n}`)) n++;
    let id = '';
    if (edit('Add Portfolio', (d) => { id = createPortfolio(d, `Portfolio ${n}`, { projIds: [] }).id; })) setSelId(id);
  };
  const remove = async () => {
    if (!sel) return;
    const ok = window.p6?.confirm ? await window.p6.confirm(`Delete portfolio ${sel.name}?`, 'The projects are not deleted.') : true;
    if (ok && edit('Delete Portfolio', (d) => deletePortfolio(d, sel.id))) setSelId(ALL);
  };
  const openThese = () => {
    if (!projIds.length) return toast('The portfolio has no projects.');
    openProjects(projIds);
  };

  return (
    <>
      <div className="layoutbar">
        <button className="btn" onClick={add}>Add Portfolio</button>
        <button className="btn" disabled={!sel} onClick={() => void remove()}>Delete</button>
        <button className="btn primary" disabled={!projIds.length} onClick={openThese}>Open these projects</button>
        <span>Portfolio: <b>{sel?.name ?? 'All Projects'}</b></span>
        <span>Projects: <b>{projIds.length}</b></span>
        <span className="muted">Portfolios are stored in the clone database (not in XER files), like P6.</span>
      </div>
      <div className="winbody">
        <Split dir="h" initial={330} storeKey="portfolios">
          <div className="details" style={{ overflow: 'auto' }}>
            <div className="tblwrap" style={{ margin: 6, maxHeight: 200, flex: 'none' }}>
              <table className="tbl">
                <thead><tr><th>Portfolio Name</th><th style={{ width: 70 }}>Type</th><th style={{ width: 54 }}>Projects</th></tr></thead>
                <tbody>
                  <tr className={selId === ALL ? 'sel' : ''} onMouseDown={() => setSelId(ALL)}><td>All Projects</td><td>Global</td><td style={{ textAlign: 'right' }}>{realProjects(db).length}</td></tr>
                  {list.map((p) => (
                    <tr key={p.id} className={selId === p.id ? 'sel' : ''} onMouseDown={() => setSelId(p.id)}>
                      <td>{p.name}</td><td>{p.rule ? 'Filter' : 'Selected'}</td><td style={{ textAlign: 'right' }}>{projectsIn(db, p.id).length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sel ? <Definition key={sel.id} p={sel} db={db} /> : <div className="tabbody muted">All Projects is the built-in portfolio of every project in the database. Click <b>Add Portfolio</b> to define your own.</div>}
          </div>
          <Split dir="v" initial={330} storeKey="portfolios-chart">
            <Dashboard s={summary.projects} totals={summary.totals} prefs={prefs} selProj={selProj} setSelProj={setSelProj} />
            <SpanChart s={summary.projects} totals={summary.totals} prefs={prefs} />
          </Split>
        </Split>
      </div>
    </>
  );
}

function Definition({ p, db }: { p: Portfolio; db: Db }) {
  const v = useStore((st) => st.dbVersion);
  const projects = useMemo(() => realProjects(db).sort((a, b) => (a.proj_short_name || '').localeCompare(b.proj_short_name || '', undefined, { numeric: true })), [db, v]);
  const eps = rows(db, 'EPS');
  const epsDepth = (e: Row) => { let n = 0; for (let x = e; x?.parent_eps_id && n < 20; x = eps.find((y) => y.eps_id === x.parent_eps_id)!) n++; return n; };
  const epsOrdered: Row[] = [];
  const visit = (e: Row) => { epsOrdered.push(e); for (const c of eps.filter((x) => x.parent_eps_id === e.eps_id && x !== e)) if (!epsOrdered.includes(c)) visit(c); };
  for (const r of eps.filter((e) => !e.parent_eps_id || !eps.some((x) => x.eps_id === e.parent_eps_id))) visit(r);
  const members = new Set(projectsIn(db, p.id));
  const setRule = (patch: Partial<PortfolioRule>) => {
    const rule = { ...(p.rule ?? {}), ...patch };
    for (const k of Object.keys(rule) as (keyof PortfolioRule)[]) if (!rule[k]) delete rule[k];
    edit('Edit Portfolio Filter', (d) => { updatePortfolio(d, p.id, { rule }); });
  };
  return (
    <div className="tabbody" style={{ flex: 1 }}>
      <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
        <label>Portfolio Name</label>
        <input defaultValue={p.name} key={`n${p.name}`} onBlur={(e) => { if (e.target.value !== p.name && !edit('Rename Portfolio', (d) => { updatePortfolio(d, p.id, { name: e.target.value }); })) e.target.value = p.name; }} />
        <label>Description</label>
        <input defaultValue={p.descr} key={`d${p.descr}`} onBlur={(e) => { if (e.target.value !== p.descr) edit('Edit Portfolio Description', (d) => { updatePortfolio(d, p.id, { descr: e.target.value }); }); }} />
      </div>
      <fieldset style={{ marginTop: 8 }}>
        <legend>Projects in the portfolio</legend>
        <label style={{ marginRight: 12 }}><input type="radio" checked={!p.rule} onChange={() => edit('Portfolio: Select Projects', (d) => { updatePortfolio(d, p.id, { projIds: [...members] }); })} /> Selected projects</label>
        <label><input type="radio" checked={!!p.rule} onChange={() => edit('Portfolio: Use Filter', (d) => { updatePortfolio(d, p.id, { rule: {} }); })} /> Projects matching a filter</label>
        {p.rule ? (
          <div className="form" style={{ gridTemplateColumns: 'auto 1fr', marginTop: 6 }}>
            <label>Project Status</label>
            <select value={p.rule.status ?? ''} onChange={(e) => setRule({ status: e.target.value })}>
              <option value="">(any)</option>
              {Object.entries(PROJECT_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <label>EPS (and below)</label>
            <select value={p.rule.epsId ?? ''} onChange={(e) => setRule({ epsId: e.target.value })}>
              <option value="">(any)</option>
              {epsOrdered.map((e) => <option key={e.eps_id} value={e.eps_id}>{'  '.repeat(epsDepth(e))}{e.eps_short_name ? `${e.eps_short_name} - ` : ''}{e.eps_name}</option>)}
            </select>
            <label>Name contains</label>
            <input defaultValue={p.rule.nameContains ?? ''} key={`q${p.rule.nameContains ?? ''}`} placeholder="Project ID or name"
              onBlur={(e) => { if (e.target.value !== (p.rule?.nameContains ?? '')) setRule({ nameContains: e.target.value }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            <span /><span className="muted">{members.size} matching project{members.size === 1 ? '' : 's'}; the list follows the database as projects change.</span>
          </div>
        ) : (
          <div className="tblwrap" style={{ marginTop: 6, maxHeight: 320 }}>
            <table className="tbl">
              <thead><tr><th style={{ width: 24 }} /><th>Project ID</th><th>Project Name</th><th>Status</th></tr></thead>
              <tbody>
                {projects.map((x) => (
                  <tr key={x.proj_id}>
                    <td><input type="checkbox" checked={members.has(x.proj_id)} onChange={(e) => {
                      const on = e.target.checked;
                      const next = on ? [...members, x.proj_id] : [...members].filter((id) => id !== x.proj_id);
                      edit(on ? 'Add Project to Portfolio' : 'Remove Project from Portfolio', (d) => { updatePortfolio(d, p.id, { projIds: next }); });
                    }} /></td>
                    <td>{x.proj_short_name}</td><td>{projectTitle(db, x)}</td><td>{PROJECT_STATUS[projectStatus(db, x.proj_id)] ?? ''}</td>
                  </tr>
                ))}
                {!projects.length && <tr><td colSpan={4} className="muted">No projects in the database.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>
    </div>
  );
}

const COLS: { id: string; title: string; w: number; num?: boolean; get: (s: ProjectSummary, prefs: Prefs) => string }[] = [
  { id: 'code', title: 'Project ID', w: 90, get: (s) => s.code },
  { id: 'name', title: 'Project Name', w: 180, get: (s) => s.name },
  { id: 'status', title: 'Status', w: 64, get: (s) => s.status },
  { id: 'acts', title: 'Activities', w: 58, num: true, get: (s) => String(s.activities) },
  { id: 'ns', title: 'Not Started', w: 58, num: true, get: (s) => String(s.notStarted) },
  { id: 'ip', title: 'In Progress', w: 58, num: true, get: (s) => String(s.inProgress) },
  { id: 'cp', title: 'Completed', w: 58, num: true, get: (s) => String(s.completed) },
  { id: 'start', title: 'Start', w: 76, get: (s, p) => fmtDate(s.start, p, false) },
  { id: 'finish', title: 'Finish', w: 76, get: (s, p) => fmtDate(s.finish, p, false) },
  { id: 'dd', title: 'Data Date', w: 76, get: (s, p) => fmtDate(s.dataDate, p, false) },
  { id: 'tf', title: 'Total Float (min)', w: 62, num: true, get: (s, p) => (s.minTotalFloatHr == null ? '' : fmtDur(s.minTotalFloatHr, p)) },
  { id: 'crit', title: 'Critical', w: 52, num: true, get: (s) => String(s.critical) },
  { id: 'bud', title: 'Budgeted Total Cost', w: 100, num: true, get: (s) => money(s.budgetedCost) },
  { id: 'act', title: 'Actual Total Cost', w: 100, num: true, get: (s) => money(s.actualCost) },
  { id: 'rem', title: 'Remaining Total Cost', w: 100, num: true, get: (s) => money(s.remainingCost) },
  { id: 'atc', title: 'At Completion Total Cost', w: 100, num: true, get: (s) => money(s.atCompletionCost) },
  { id: 'pv', title: 'Planned Value (BCWS)', w: 100, num: true, get: (s) => money(s.bcws) },
  { id: 'ev', title: 'Earned Value (BCWP)', w: 100, num: true, get: (s) => money(s.bcwp) },
  { id: 'ac', title: 'Actual Cost (ACWP)', w: 100, num: true, get: (s) => money(s.acwp) },
  { id: 'spi', title: 'SPI', w: 46, num: true, get: (s) => ratio(s.spi) },
  { id: 'cpi', title: 'CPI', w: 46, num: true, get: (s) => ratio(s.cpi) },
];

function Dashboard({ s, totals, prefs, selProj, setSelProj }: { s: ProjectSummary[]; totals: ProjectSummary; prefs: Prefs; selProj: string | null; setSelProj: (id: string) => void }) {
  const warn = (x: ProjectSummary, id: string) => (id === 'spi' && x.spi && x.spi < 1) || (id === 'cpi' && x.cpi && x.cpi < 1) || (id === 'tf' && (x.minTotalFloatHr ?? 0) < 0);
  return (
    // absolute inner box: a wide table must not widen the splitter panes
    <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
    <div className="tblwrap" style={{ position: 'absolute', inset: 0, border: 'none' }}>
      <table className="tbl" style={{ width: COLS.reduce((a, c) => a + c.w, 0), tableLayout: 'fixed' }}>
        <colgroup>{COLS.map((c) => <col key={c.id} style={{ width: c.w }} />)}</colgroup>
        <thead><tr>{COLS.map((c) => <th key={c.id} style={{ whiteSpace: 'normal', textAlign: 'center', lineHeight: '12px' }}>{c.title}</th>)}</tr></thead>
        <tbody>
          {s.map((x) => (
            <tr key={x.projId} className={selProj === x.projId ? 'sel' : ''} onMouseDown={() => setSelProj(x.projId)} onDoubleClick={() => openProjects([x.projId])} title="Double-click to open this project">
              {COLS.map((c) => <td key={c.id} style={{ textAlign: c.num ? 'right' : 'left', overflow: 'hidden', textOverflow: 'ellipsis', color: selProj !== x.projId && warn(x, c.id) ? '#c00000' : undefined }}>{c.get(x, prefs)}</td>)}
            </tr>
          ))}
          {s.length > 0 && (
            <tr style={{ fontWeight: 'bold', background: 'var(--wbs3)' }}>
              {COLS.map((c) => <td key={c.id} style={{ textAlign: c.num ? 'right' : 'left', background: 'var(--wbs3)' }}>{c.id === 'status' ? '' : c.get(totals, prefs)}</td>)}
            </tr>
          )}
          {!s.length && <tr><td colSpan={COLS.length} className="muted">The portfolio has no projects.</td></tr>}
        </tbody>
      </table>
    </div>
    </div>
  );
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Project spans start -> finish (started projects blue up to the data date, remaining green), data dates in red, red underline = has critical activities. */
function SpanChart({ s, totals, prefs }: { s: ProjectSummary[]; totals: ProjectSummary; prefs: Prefs }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth - 1)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const LABEL = 150, HEAD = 22, RH = 20;
  const h = HEAD + Math.max(1, s.length) * RH + 8;
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.font = '11px Tahoma, "Segoe UI", sans-serif';
    const spans = s.filter((x) => x.start != null && x.finish != null);
    if (!spans.length) { g.fillStyle = '#777'; g.fillText('No scheduled dates to chart.', 10, HEAD + 14); return; }
    let t0 = Math.min(...spans.map((x) => x.start!)), t1 = Math.max(...spans.map((x) => x.finish!));
    for (const x of s) if (x.dataDate != null) { t0 = Math.min(t0, x.dataDate); t1 = Math.max(t1, x.dataDate); }
    const pad = Math.max(MIN_PER_DAY * 3, (t1 - t0) * 0.03);
    t0 -= pad; t1 += pad;
    const plotW = w - LABEL - 8;
    const X = (t: number) => LABEL + ((t - t0) / (t1 - t0)) * plotW;
    // timescale: months (or years when long)
    g.fillStyle = '#ececec'; g.fillRect(0, 0, w, HEAD);
    g.strokeStyle = '#a0a0a0'; g.beginPath(); g.moveTo(0, HEAD - 0.5); g.lineTo(w, HEAD - 0.5); g.stroke();
    const years = (t1 - t0) / MIN_PER_DAY > 900;
    const d = new Date(t0 * 60000);
    let y = d.getUTCFullYear(), m = years ? 0 : d.getUTCMonth();
    const stepMonths = years ? 12 : (t1 - t0) / MIN_PER_DAY > 400 ? 3 : 1;
    for (let guard = 0; guard < 400; guard++) {
      const t = Date.UTC(y, m, 1) / 60000;
      if (t > t1) break;
      if (t >= t0) {
        const x = Math.round(X(t)) + 0.5;
        g.strokeStyle = '#e4e4e4'; g.beginPath(); g.moveTo(x, HEAD); g.lineTo(x, h); g.stroke();
        g.strokeStyle = '#a0a0a0'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, HEAD); g.stroke();
        g.fillStyle = '#000'; g.fillText(years ? String(y) : `${MON[m]}-${String(y).slice(2)}`, x + 3, 15);
      }
      m += stepMonths;
      while (m >= 12) { m -= 12; y++; }
    }
    g.fillStyle = '#000'; g.fillText('Project', 6, 15);
    s.forEach((x, i) => {
      const top = HEAD + i * RH;
      if (i % 2) { g.fillStyle = '#f7f7f7'; g.fillRect(0, top, w, RH); }
      g.fillStyle = '#000';
      g.save(); g.beginPath(); g.rect(0, top, LABEL - 6, RH); g.clip(); g.fillText(`${x.code}`, 6, top + 14); g.restore();
      if (x.start == null || x.finish == null) return;
      const a = X(x.start), b = Math.max(X(x.finish), a + 2);
      const progressed = x.inProgress + x.completed > 0;
      const dd = progressed && x.dataDate != null ? Math.min(Math.max(X(x.dataDate), a), b) : a;
      g.fillStyle = '#00a000'; g.fillRect(dd, top + 6, b - dd, 8);
      if (dd > a) { g.fillStyle = '#2050c8'; g.fillRect(a, top + 6, dd - a, 8); }
      g.strokeStyle = '#333'; g.strokeRect(Math.round(a) + 0.5, top + 5.5, Math.round(b - a), 9);
      if (x.critical) { g.fillStyle = '#c00000'; g.fillRect(a, top + 15, b - a, 2); }
      if (x.dataDate != null) {
        const xd = Math.round(X(x.dataDate)) + 0.5;
        g.strokeStyle = '#d00000'; g.lineWidth = 2; g.beginPath(); g.moveTo(xd, top + 2); g.lineTo(xd, top + RH - 2); g.stroke(); g.lineWidth = 1;
      }
      g.fillStyle = '#555';
      const lbl = `${fmtDate(x.start, prefs, false)} - ${fmtDate(x.finish, prefs, false)}`;
      if (b + 6 + g.measureText(lbl).width < w) g.fillText(lbl, b + 6, top + 14);
    });
    if (totals.dataDate != null) {
      const xd = Math.round(X(totals.dataDate)) + 0.5;
      g.strokeStyle = '#d00000'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(xd, HEAD); g.lineTo(xd, h); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#d00000'; g.fillText(`Data Date ${fmtDate(totals.dataDate, prefs, false)}`, Math.min(xd + 4, w - 130), h - 2);
    }
  }, [s, totals, prefs, w, h]);
  return (
    <div className="gantt">
      <div ref={box} style={{ position: 'absolute', inset: 0, overflow: 'auto' }}>
        <canvas ref={cv} />
      </div>
    </div>
  );
}
