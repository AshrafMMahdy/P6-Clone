// Risks window: P6 risk register (PROJRISK / TASKRISK / RISKTYPE), three-point duration estimates
// and a Monte Carlo schedule risk analysis (Primavera Risk Analysis style).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as RME, type ReactNode } from 'react';
import { Grid, type EditorSpec, type GridCol, type GridItem } from '../components/Grid.tsx';
import { Split, Tabs, showContextMenu } from '../components/Layout.tsx';
import { getDb, mutate, setUi, toast, useStore, type Prefs } from '../store.ts';
import { useCtx } from '../hooks.ts';
import { fmtDate, STATUS, statusOf } from '../model.ts';
import { taskFinish, taskStart } from './activityRows.ts';
import { rows, type Row } from '../../core/db.ts';
import { MIN_PER_DAY } from '../../core/dates.ts';
import { p6num } from '../../core/schedule/cpm.ts';
import {
  addRisk, BAND_COLOR, BAND_LABEL, deleteRisks, ensureRiskTypes, heatMap, LEVEL_LABEL, LEVELS, linkActivity, linkedTasks, PROB_RANGE, RESPONSE_TYPES,
  RISK_STATUS, riskScore, risksOf, SCHED_IMPACT_RANGE, unlinkActivity, updateRisk, type RiskPhase,
} from '../../core/risk/register.ts';
import {
  clearEstimates, defaultEstimates, DISTS, getEstimates, isEstimable, remainingHours, runMonteCarlo, setEstimate, type Dist, type MonteCarloResult,
} from '../../core/risk/montecarlo.ts';

type TabId = 'register' | 'estimates' | 'analysis';
let lastTab: TabId = 'register';

const r2 = (n: number) => String(Math.round(n * 100) / 100);
const days = (h: number, hpd: number) => r2(h / hpd);
const byCode = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const levelOpts: Record<string, string> = { '': '', ...Object.fromEntries(LEVELS.map((l) => [l, LEVEL_LABEL[l]])) };

export function RiskView() {
  const ui = useStore((s) => s.ui);
  const [tab, setTabState] = useState<TabId>(lastTab);
  const setTab = (t: string) => { lastTab = t as TabId; setTabState(t as TabId); };
  if (!ui.openProjects.length) return <div className="empty">No project is open. Open a project in the Projects window to see its risks.</div>;
  return (
    <>
      <div style={{ background: 'var(--chrome)', flex: 'none' }}>
        <Tabs tabs={[['register', 'Risk Register'], ['estimates', 'Estimates'], ['analysis', 'Analysis']]} value={tab} onChange={setTab} />
      </div>
      <div className="winbody">
        {tab === 'register' ? <RegisterTab /> : tab === 'estimates' ? <EstimatesTab /> : <AnalysisTab />}
      </div>
    </>
  );
}

// ================================================================ Risk Register

const RISK_COLS: GridCol[] = [
  { id: 'code', title: 'Risk ID', width: 76 },
  { id: 'name', title: 'Risk Name', width: 200 },
  { id: 'proj', title: 'Project', width: 80 },
  { id: 'type', title: 'Category', width: 100 },
  { id: 'status', title: 'Status', width: 70 },
  { id: 'owner', title: 'Owner', width: 110 },
  { id: 'obs', title: 'Responsible Manager', width: 110 },
  { id: 'pre_prob', title: 'Pre-Response Probability', width: 76 },
  { id: 'pre_sched', title: 'Pre-Response Schedule', width: 76 },
  { id: 'pre_cost', title: 'Pre-Response Cost', width: 76 },
  { id: 'pre_score', title: 'Pre-Response Score', width: 64, align: 'center' },
  { id: 'pre_pct', title: 'Probability %', width: 64, align: 'right' },
  { id: 'pre_hr', title: 'Schedule Impact (d)', width: 64, align: 'right' },
  { id: 'resp', title: 'Response Type', width: 76 },
  { id: 'post_prob', title: 'Post-Response Probability', width: 76 },
  { id: 'post_sched', title: 'Post-Response Schedule', width: 76 },
  { id: 'post_cost', title: 'Post-Response Cost', width: 76 },
  { id: 'post_score', title: 'Post-Response Score', width: 64, align: 'center' },
  { id: 'post_pct', title: 'Post Probability %', width: 64, align: 'right' },
  { id: 'post_hr', title: 'Post Schedule Impact (d)', width: 64, align: 'right' },
  { id: 'acts', title: 'Activities', width: 58, align: 'right' },
  { id: 'ident', title: 'Identified', width: 76 },
];

/** Column -> PROJRISK field and editor type. */
const RISK_FIELD: Record<string, [string, 'text' | 'select' | 'number' | 'date' | 'days']> = {
  code: ['risk_code', 'text'], name: ['risk_name', 'text'], type: ['risk_type_id', 'select'], status: ['status_code', 'select'], owner: ['rsrc_id', 'select'], obs: ['obs_id', 'select'],
  pre_prob: ['pre_prob', 'select'], pre_sched: ['pre_sched_impact', 'select'], pre_cost: ['pre_cost_impact', 'select'], pre_pct: ['pre_prob_pct', 'number'], pre_hr: ['pre_sched_impact_hr_cnt', 'days'],
  resp: ['response_type', 'select'], post_prob: ['post_prob', 'select'], post_sched: ['post_sched_impact', 'select'], post_cost: ['post_cost_impact', 'select'],
  post_pct: ['post_prob_pct', 'number'], post_hr: ['post_sched_impact_hr_cnt', 'days'], ident: ['identified_date', 'date'],
};

function ScoreCell({ r, phase }: { r: Row; phase: RiskPhase }) {
  const s = riskScore(r, phase);
  if (!s.score) return <span className="muted">-</span>;
  return <div title={`${BAND_LABEL[s.band]}: probability ${s.prob} x impact ${s.impact}`} style={{ margin: '0 -4px', padding: '0 4px', background: BAND_COLOR[s.band], color: '#000', fontWeight: 'bold' }}>{s.score}</div>;
}

function RegisterTab() {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const db = ctx.db;
  const hpd = ctx.prefs.hoursPerDay;
  const [sel, setSel] = useState<string | null>(null);
  const [phase, setPhase] = useState<RiskPhase>('pre');
  const [cell, setCell] = useState<{ p: number; i: number } | null>(null);
  const [detail, setDetail] = useState('general');
  const [addProj, setAddProj] = useState(ui.openProjects[0]);
  const multi = ui.openProjects.length > 1;

  const risks = useMemo(() => risksOf(db, ui.openProjects).sort((a, b) => a.proj_id.localeCompare(b.proj_id) || byCode(a.risk_code ?? '', b.risk_code ?? '') || Number(a.proj_risk_id) - Number(b.proj_risk_id)), [ctx, db, ui.openProjects]);
  const hm = useMemo(() => heatMap(db, ui.openProjects, phase), [ctx, db, ui.openProjects, phase]);
  const types = useMemo(() => new Map(rows(db, 'RISKTYPE').map((t) => [t.risk_type_id, t.risk_type])), [ctx, db]);
  const obs = useMemo(() => new Map(rows(db, 'OBS').map((o) => [o.obs_id, o.obs_name])), [ctx, db]);
  const linkCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of rows(db, 'TASKRISK')) if (ctx.taskById.has(l.task_id)) m.set(l.proj_risk_id, (m.get(l.proj_risk_id) ?? 0) + 1);
    return m;
  }, [ctx, db]);
  const shown = useMemo(() => {
    if (!cell) return risks;
    const ids = new Set(hm.cells[cell.p - 1][cell.i - 1].risks);
    return risks.filter((r) => ids.has(r.proj_risk_id));
  }, [risks, cell, hm]);

  const cols = multi ? RISK_COLS : RISK_COLS.filter((c) => c.id !== 'proj');
  const hrCell = (v: string | undefined) => (v !== '' && v != null && Number.isFinite(Number(v)) ? days(Number(v), hpd) : '');
  const items: GridItem[] = shown.map((r) => ({
    key: r.proj_risk_id, kind: 'row', level: 0,
    style: r.status_code === 'RS_Rejected' || r.status_code === 'RS_Managed' ? { color: '#777' } : undefined,
    cells: {
      code: r.risk_code, name: r.risk_name, proj: ctx.proj.get(r.proj_id)?.proj_short_name ?? '', type: types.get(r.risk_type_id) ?? '',
      status: RISK_STATUS[r.status_code as keyof typeof RISK_STATUS] ?? r.status_code,
      owner: r.rsrc_id ? ctx.rsrc.get(r.rsrc_id)?.rsrc_name ?? `[${r.rsrc_id}]` : '', obs: r.obs_id ? obs.get(r.obs_id) ?? `[${r.obs_id}]` : '',
      pre_prob: levelOpts[r.pre_prob] ?? r.pre_prob, pre_sched: levelOpts[r.pre_sched_impact] ?? r.pre_sched_impact, pre_cost: levelOpts[r.pre_cost_impact] ?? r.pre_cost_impact,
      pre_score: <ScoreCell r={r} phase="pre" />, pre_pct: r.pre_prob_pct, pre_hr: hrCell(r.pre_sched_impact_hr_cnt),
      resp: r.response_type,
      post_prob: levelOpts[r.post_prob] ?? r.post_prob, post_sched: levelOpts[r.post_sched_impact] ?? r.post_sched_impact, post_cost: levelOpts[r.post_cost_impact] ?? r.post_cost_impact,
      post_score: <ScoreCell r={r} phase="post" />, post_pct: r.post_prob_pct, post_hr: hrCell(r.post_sched_impact_hr_cnt),
      acts: String(linkCount.get(r.proj_risk_id) ?? 0), ident: fmtDate(r.identified_date, ctx.prefs, false),
    },
  }));

  const getEditor = (key: string, col: string): EditorSpec | null => {
    const spec = RISK_FIELD[col];
    const r = risks.find((x) => x.proj_risk_id === key);
    if (!spec || !r) return null;
    const [field, type] = spec;
    const v = r[field] ?? '';
    if (type === 'days') return { type: 'number', value: hrCell(v) };
    if (type !== 'select') return { type, value: v };
    let options: Record<string, string> = levelOpts;
    if (field === 'risk_type_id') options = { '': '', ...Object.fromEntries([...rows(db, 'RISKTYPE')].sort((a, b) => Number(a.risk_seq_num) - Number(b.risk_seq_num)).map((t) => [t.risk_type_id, t.risk_type])) };
    else if (field === 'status_code') options = { ...RISK_STATUS };
    else if (field === 'rsrc_id') options = { '': '', ...Object.fromEntries([...ctx.rsrc.values()].sort((a, b) => byCode(a.rsrc_short_name ?? '', b.rsrc_short_name ?? '')).map((x) => [x.rsrc_id, `${x.rsrc_short_name} - ${x.rsrc_name}`])) };
    else if (field === 'obs_id') options = { '': '', ...Object.fromEntries(rows(db, 'OBS').map((o) => [o.obs_id, o.obs_name])) };
    else if (field === 'response_type') options = { '': '', ...Object.fromEntries(RESPONSE_TYPES.map((t) => [t, t])) };
    if (v && !(v in options)) options = { ...options, [v]: v };
    return { type: 'select', value: v, options };
  };
  const onCommit = (key: string, col: string, raw: string) => {
    const spec = RISK_FIELD[col];
    const r = risks.find((x) => x.proj_risk_id === key);
    if (!spec || !r) return;
    const [field, type] = spec;
    let v = raw.trim();
    if (type === 'days' || type === 'number') {
      if (v !== '') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return toast('Enter a number zero or greater.');
        if (type === 'number' && n > 100) return toast('A probability cannot exceed 100%.');
        v = type === 'days' ? p6num(n * hpd) : p6num(n);
      }
    } else if (type === 'date') v = v ? v.replace('T', ' ').slice(0, 16) : '';
    else if (field === 'risk_name' && !v) return toast('A risk must have a name.');
    else if (field === 'risk_code') {
      if (!v) return toast('A risk must have a Risk ID.');
      if (risks.some((x) => x !== r && x.proj_id === r.proj_id && x.risk_code === v)) return toast(`Risk ID ${v} is already used in this project.`);
    }
    if ((r[field] ?? '') === v) return;
    mutate(`Edit Risk ${RISK_COLS.find((c) => c.id === col)?.title ?? ''}`, (d) => { updateRisk(d, key, { [field]: v }); });
  };

  const add = () => {
    const pid = multi ? addProj : ui.openProjects[0];
    let id = '';
    mutate('Add Risk', (d) => { id = addRisk(d, pid).proj_risk_id; });
    setSel(id);
    setCell(null);
  };
  const del = () => {
    if (!sel) return toast('Select a risk to delete.');
    mutate('Delete Risk', (d) => deleteRisks(d, [sel]));
    setSel(null);
    toast('Risk deleted (Edit > Undo restores it).');
  };
  useEffect(() => { if (!rows(db, 'RISKTYPE').length && risks.length) mutate('Create Risk Categories', (d) => { ensureRiskTypes(d); }); }, [db, risks.length]);

  const selRisk = risks.find((r) => r.proj_risk_id === sel);
  return (
    <>
      <div className="layoutbar">
        <button className="tbtn" onClick={add}><span className="lbl">Add Risk</span></button>
        {multi && <label>to <select value={addProj} onChange={(e) => setAddProj(e.target.value)}>{ui.openProjects.map((p) => <option key={p} value={p}>{ctx.proj.get(p)?.proj_short_name ?? p}</option>)}</select></label>}
        <button className="tbtn" onClick={del} disabled={!sel}><span className="lbl">Delete Risk</span></button>
        <span>Risks: <b>{risks.length}</b></span>
        {cell && <span>Filtered to probability {LEVEL_LABEL[LEVELS[cell.p - 1]]} / impact {LEVEL_LABEL[LEVELS[cell.i - 1]]} <button className="tbtn" onClick={() => setCell(null)}><span className="lbl">Show all</span></button></span>}
        <span className="muted">Double-click a cell to edit. Schedule impact (days) is added to each linked activity when the risk occurs in the Monte Carlo analysis.</span>
      </div>
      <div className="winbody">
        <Split dir="v" initial={300} storeKey="risk-register">
          <Grid cols={cols} items={items} selected={new Set(sel ? [sel] : [])} onSelect={(k) => setSel(k)} getEditor={getEditor} onCommit={onCommit}
            onActivate={() => setDetail('activities')}
            onContextMenu={(k, e) => {
              if (k) setSel(k);
              showContextMenu(e, [
                { label: 'Add Risk', onClick: add },
                ...(k ? [{ label: 'Delete Risk', onClick: () => { mutate('Delete Risk', (d) => deleteRisks(d, [k])); setSel(null); } }, { label: 'Linked Activities', onClick: () => setDetail('activities') }] : []),
              ]);
            }}
            emptyText={cell ? 'No risks in this cell of the matrix.' : 'The open projects have no risks. Click Add Risk to identify one.'} />
          <Split dir="h" initial={520} storeKey="risk-register-bottom">
            <div className="details">
              <Tabs tabs={[['general', 'General'], ['activities', 'Activities']]} value={detail} onChange={setDetail} />
              {!selRisk ? <div className="empty">Select a risk.</div>
                : detail === 'general' ? <RiskGeneral risk={selRisk} /> : <RiskActivities risk={selRisk} />}
            </div>
            <div className="details" style={{ overflow: 'auto' }}>
              <HeatMap cells={hm.cells} unrated={hm.unrated.length} phase={phase} setPhase={setPhase} sel={cell}
                onCell={(p, i) => setCell((c) => (c && c.p === p && c.i === i ? null : { p, i }))} highlight={selRisk ? riskScore(selRisk, phase) : undefined} />
            </div>
          </Split>
        </Split>
      </div>
    </>
  );
}

/** Text area committing on blur; remounts when the stored value changes (undo). */
function MemoField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  return (
    <>
      <label style={{ alignSelf: 'start', paddingTop: 2 }}>{label}</label>
      <textarea key={value} defaultValue={value} rows={3} className="wide" style={{ height: 46, resize: 'vertical', border: '1px solid #7f9db9', userSelect: 'text' }}
        onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value); }} />
    </>
  );
}

function RiskGeneral({ risk }: { risk: Row }) {
  const id = risk.proj_risk_id;
  const set = (field: string, label: string) => (v: string) => mutate(`Edit Risk ${label}`, (d) => { updateRisk(d, id, { [field]: v }); });
  const pre = riskScore(risk, 'pre'), post = riskScore(risk, 'post');
  return (
    <div className="tabbody">
      <div style={{ marginBottom: 6 }}>
        <b>{risk.risk_code}</b> {risk.risk_name}
        <span style={{ marginLeft: 12 }}>Pre-response score: <ScoreBadge s={pre.score} band={pre.band} /></span>
        <span style={{ marginLeft: 12 }}>Post-response score: <ScoreBadge s={post.score} band={post.band} /></span>
      </div>
      <div className="form" style={{ gridTemplateColumns: 'auto 1fr auto 1fr' }}>
        <MemoField label="Description" value={risk.risk_descr ?? ''} onCommit={set('risk_descr', 'Description')} />
        <MemoField label="Cause" value={risk.cause ?? ''} onCommit={set('cause', 'Cause')} />
        <MemoField label="Effect" value={risk.effect ?? ''} onCommit={set('effect', 'Effect')} />
        <MemoField label="Response" value={risk.response_descr ?? ''} onCommit={set('response_descr', 'Response')} />
      </div>
    </div>
  );
}

function ScoreBadge({ s, band }: { s: number; band: keyof typeof BAND_COLOR }) {
  return s ? <span style={{ background: BAND_COLOR[band], padding: '0 6px', fontWeight: 'bold', border: '1px solid #999' }}>{s} {BAND_LABEL[band]}</span> : <span className="muted">not rated</span>;
}

function RiskActivities({ risk }: { risk: Row }) {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const db = ctx.db;
  const [find, setFind] = useState('');
  const [pick, setPick] = useState('');
  const linked = useMemo(() => linkedTasks(db, risk.proj_risk_id).map((id) => ctx.taskById.get(id)!).sort((a, b) => byCode(a.task_code, b.task_code)), [ctx, db, risk]);
  const linkedSet = new Set(linked.map((t) => t.task_id));
  const candidates = useMemo(() => {
    const q = find.trim().toLowerCase();
    return rows(db, 'TASK').filter((t) => t.proj_id === risk.proj_id && t.task_type !== 'TT_WBS' && !linkedSet.has(t.task_id)
      && (!q || (t.task_code ?? '').toLowerCase().includes(q) || (t.task_name ?? '').toLowerCase().includes(q)))
      .sort((a, b) => byCode(a.task_code, b.task_code)).slice(0, 500);
  }, [ctx, db, risk, find, linked]);
  const link = (ids: string[]) => {
    const ok = ids.filter((id) => ctx.taskById.get(id)?.proj_id === risk.proj_id && !linkedSet.has(id));
    if (!ok.length) return toast(ids.length ? 'The selected activities are already linked or belong to another project.' : 'Choose an activity to link.');
    mutate(ok.length > 1 ? 'Link Activities to Risk' : 'Link Activity to Risk', (d) => { for (const id of ok) linkActivity(d, risk.proj_risk_id, id); });
    setPick('');
  };
  const selTasks = ui.selTasks.filter((id) => ctx.taskById.get(id)?.proj_id === risk.proj_id && !linkedSet.has(id));
  return (
    <div className="tabbody" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="row" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <input placeholder="Find activity" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 120, border: '1px solid #7f9db9', height: 19 }} />
        <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: 280, height: 19 }}>
          <option value="">{candidates.length ? `Choose an activity (${candidates.length})` : 'No matching activities'}</option>
          {candidates.map((t) => <option key={t.task_id} value={t.task_id}>{t.task_code} - {t.task_name}</option>)}
        </select>
        <button className="btn" onClick={() => link(pick ? [pick] : [])}>Link</button>
        <button className="btn" disabled={!selTasks.length} title="Activities selected in the Activities window" onClick={() => link(selTasks)}>Link Selected ({selTasks.length})</button>
      </div>
      <div className="tblwrap" style={{ flex: 1, minHeight: 60 }}>
        <table className="tbl">
          <thead><tr><th>Activity ID</th><th>Activity Name</th><th>Status</th><th>Start</th><th>Finish</th><th>Total Float</th><th /></tr></thead>
          <tbody>
            {linked.map((t) => (
              <tr key={t.task_id} onDoubleClick={() => setUi({ view: 'activities', selTask: t.task_id, selTasks: [t.task_id] })}>
                <td>{t.task_code}</td><td>{t.task_name}</td><td>{STATUS[statusOf(t)]}</td>
                <td>{fmtDate(taskStart(t), ctx.prefs)}</td><td>{fmtDate(taskFinish(t), ctx.prefs)}</td>
                <td style={{ textAlign: 'right' }}>{t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null ? days(Number(t.total_float_hr_cnt), ctx.prefs.hoursPerDay) : ''}</td>
                <td><button className="tbtn" onClick={() => mutate('Unlink Activity from Risk', (d) => unlinkActivity(d, risk.proj_risk_id, t.task_id))}><span className="lbl">Unlink</span></button></td>
              </tr>
            ))}
            {!linked.length && <tr><td colSpan={7} className="muted">No activities linked. A risk event delays its linked activities in the Monte Carlo analysis.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HeatMap(p: { cells: ReturnType<typeof heatMap>['cells']; unrated: number; phase: RiskPhase; setPhase: (x: RiskPhase) => void; sel: { p: number; i: number } | null; onCell: (p: number, i: number) => void; highlight?: { prob: number; impact: number } }) {
  const CW = 58, CH = 30;
  const head: CSSProperties = { fontSize: 10, color: '#333', textAlign: 'center', lineHeight: '12px' };
  return (
    <div style={{ padding: 8 }}>
      <div className="row" style={{ alignItems: 'center', marginBottom: 6, gap: 6 }}>
        <b>Probability and Impact Matrix</b>
        <button className={`tbtn ${p.phase === 'pre' ? 'on' : ''}`} onClick={() => p.setPhase('pre')}><span className="lbl">Pre-Response</span></button>
        <button className={`tbtn ${p.phase === 'post' ? 'on' : ''}`} onClick={() => p.setPhase('post')}><span className="lbl">Post-Response</span></button>
      </div>
      <div style={{ display: 'flex' }}>
        <div style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', textAlign: 'center', fontWeight: 'bold', paddingLeft: 2 }}>Probability</div>
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: `70px repeat(5, ${CW}px)`, gap: 2 }}>
            {[5, 4, 3, 2, 1].map((pr) => (
              <Row5 key={pr}>
                <div style={{ ...head, textAlign: 'right', paddingRight: 4, alignSelf: 'center' }} title={PROB_RANGE[LEVELS[pr - 1]]}>{LEVEL_LABEL[LEVELS[pr - 1]]}<br /><span className="muted">{PROB_RANGE[LEVELS[pr - 1]]}</span></div>
                {[1, 2, 3, 4, 5].map((im) => {
                  const c = p.cells[pr - 1][im - 1];
                  const on = p.sel?.p === pr && p.sel?.i === im;
                  const mine = p.highlight?.prob === pr && p.highlight?.impact === im;
                  return (
                    <div key={im} onClick={() => p.onCell(pr, im)} title={`Score ${c.score} (${BAND_LABEL[c.band]}): ${c.risks.length} risk(s). Click to filter.`}
                      style={{ height: CH, background: BAND_COLOR[c.band], opacity: c.risks.length ? 1 : 0.45, border: on ? '2px solid #000' : mine ? '2px dashed #1f3d6b' : '1px solid #888', position: 'relative', cursor: 'default', textAlign: 'center' }}>
                      <span style={{ position: 'absolute', left: 3, top: 1, fontSize: 9, color: '#333' }}>{c.score}</span>
                      <span style={{ fontWeight: 'bold', fontSize: 13, lineHeight: `${CH - 2}px` }}>{c.risks.length || ''}</span>
                    </div>
                  );
                })}
              </Row5>
            ))}
            <div />
            {LEVELS.map((l) => <div key={l} style={head} title={SCHED_IMPACT_RANGE[l]}>{LEVEL_LABEL[l]}<br /><span className="muted">{SCHED_IMPACT_RANGE[l]}</span></div>)}
          </div>
          <div style={{ textAlign: 'center', fontWeight: 'bold', marginTop: 2 }}>Impact (worse of schedule and cost)</div>
        </div>
      </div>
      <div className="row" style={{ marginTop: 8, gap: 10, alignItems: 'center' }}>
        {(['low', 'medium', 'high'] as const).map((b) => <span key={b}><span style={{ display: 'inline-block', width: 10, height: 10, background: BAND_COLOR[b], border: '1px solid #888', verticalAlign: -1, marginRight: 3 }} />{BAND_LABEL[b]} ({b === 'low' ? '1-4' : b === 'medium' ? '5-11' : '12-25'})</span>)}
      </div>
      <div className="muted" style={{ marginTop: 4 }}>Score = probability (1-5) x impact (1-5). Rejected risks are not shown.{p.unrated ? ` ${p.unrated} risk(s) not rated.` : ''}</div>
    </div>
  );
}
const Row5 = ({ children }: { children: ReactNode }) => <>{children}</>;

// ================================================================ Estimates

const EST_COLS: GridCol[] = [
  { id: 'code', title: 'Activity ID', width: 90 },
  { id: 'name', title: 'Activity Name', width: 240 },
  { id: 'status', title: 'Activity Status', width: 76 },
  { id: 'rem', title: 'Remaining Duration (d)', width: 70, align: 'right' },
  { id: 'min', title: 'Minimum (d)', width: 64, align: 'right' },
  { id: 'ml', title: 'Most Likely (d)', width: 64, align: 'right' },
  { id: 'max', title: 'Maximum (d)', width: 64, align: 'right' },
  { id: 'dist', title: 'Distribution', width: 86 },
  { id: 'range', title: 'Range (% of ML)', width: 80, align: 'right' },
  { id: 'risks', title: 'Risks', width: 46, align: 'right' },
  { id: 'tf', title: 'Total Float (d)', width: 62, align: 'right' },
];

function EstimatesTab() {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const db = ctx.db;
  const hpd = ctx.prefs.hoursPerDay;
  const [find, setFind] = useState('');
  const [minPct, setMinPct] = useState(90);
  const [maxPct, setMaxPct] = useState(125);
  const [sel, setSel] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(true);

  const ests = useMemo(() => getEstimates(db), [ctx, db]);
  const riskCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of rows(db, 'TASKRISK')) m.set(l.task_id, (m.get(l.task_id) ?? 0) + 1);
    return m;
  }, [ctx, db]);
  const tasks = useMemo(() => {
    const open = new Set(ui.openProjects);
    const q = find.trim().toLowerCase();
    return rows(db, 'TASK').filter((t) => open.has(t.proj_id) && t.task_type !== 'TT_WBS' && (!onlyOpen || isEstimable(t))
      && (!q || (t.task_code ?? '').toLowerCase().includes(q) || (t.task_name ?? '').toLowerCase().includes(q)))
      .sort((a, b) => (taskStart(a) ?? 0) - (taskStart(b) ?? 0) || byCode(a.task_code, b.task_code));
  }, [ctx, db, ui.openProjects, find, onlyOpen]);
  const estimated = tasks.filter((t) => ests.has(t.task_id)).length;

  const items: GridItem[] = tasks.map((t) => {
    const e = ests.get(t.task_id);
    const can = isEstimable(t);
    return {
      key: t.task_id, kind: 'row', level: 0, style: can ? undefined : { color: '#888' },
      cells: {
        code: t.task_code, name: t.task_name, status: STATUS[statusOf(t)], rem: can ? days(remainingHours(t), hpd) : '',
        min: e ? days(e.min, hpd) : '', ml: e ? days(e.ml, hpd) : '', max: e ? days(e.max, hpd) : '',
        dist: e ? DISTS[e.dist] : can ? <span className="muted">No estimate</span> : '',
        range: e && e.ml > 0 ? `${Math.round((100 * e.min) / e.ml)}% - ${Math.round((100 * e.max) / e.ml)}%` : '',
        risks: riskCount.get(t.task_id) ? String(riskCount.get(t.task_id)) : '',
        tf: t.total_float_hr_cnt !== '' && t.total_float_hr_cnt != null ? days(Number(t.total_float_hr_cnt), hpd) : '',
      },
    };
  });

  const getEditor = (key: string, col: string): EditorSpec | null => {
    const t = ctx.taskById.get(key);
    if (!t || !isEstimable(t)) return null;
    const e = ests.get(key);
    if (col === 'dist') return { type: 'select', value: e?.dist ?? '', options: { '': 'No estimate', ...DISTS } };
    if (col === 'min' || col === 'ml' || col === 'max') return { type: 'number', value: e ? days(e[col], hpd) : days(remainingHours(t), hpd) };
    return null;
  };
  const onCommit = (key: string, col: string, raw: string) => {
    const e = ests.get(key);
    if (col === 'dist') {
      if (raw === (e?.dist ?? '')) return;
      return mutate(raw ? 'Edit Distribution' : 'Remove Estimate', (d) => setEstimate(d, key, raw ? { dist: raw as Dist } : null));
    }
    if (col !== 'min' && col !== 'ml' && col !== 'max') return;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0) return toast('Enter a duration zero or greater.');
    const h = n * hpd;
    if (e && Math.abs(e[col] - h) < 1e-9) return;
    const t = ctx.taskById.get(key)!;
    const cur = e ?? { min: remainingHours(t), ml: remainingHours(t), max: remainingHours(t) };
    const next = { ...cur, [col]: h };
    if (next.min > next.ml || next.ml > next.max) toast('Note: Minimum <= Most Likely <= Maximum is expected; the values are sorted when sampled.');
    mutate(`Edit ${EST_COLS.find((c) => c.id === col)?.title ?? 'Estimate'}`, (d) => setEstimate(d, key, { [col]: h }));
  };

  return (
    <>
      <div className="layoutbar">
        <label>Min <input type="number" value={minPct} min={0} max={100} onChange={(e) => setMinPct(Number(e.target.value))} style={{ width: 44 }} />%</label>
        <label>Max <input type="number" value={maxPct} min={100} onChange={(e) => setMaxPct(Number(e.target.value))} style={{ width: 50 }} />%</label>
        <button className="tbtn" onClick={() => {
          if (!(minPct >= 0 && minPct <= 100 && maxPct >= 100)) return toast('Minimum must be 0-100% and maximum 100% or more of the remaining duration.');
          let n = 0;
          mutate(`Set Default Estimates (${minPct}%/${maxPct}%)`, (d) => { n = defaultEstimates(d, ui.openProjects, minPct, maxPct); });
          toast(`Estimates set for ${n} activities: min ${minPct}%, most likely = remaining duration, max ${maxPct}%, triangle.`);
        }}><span className="lbl">Set defaults ({minPct}%/{maxPct}%)</span></button>
        <button className="tbtn" disabled={!estimated} onClick={() => mutate('Clear Estimates', (d) => clearEstimates(d, tasks.map((t) => t.task_id)))}><span className="lbl">Clear Estimates</span></button>
        <input placeholder="Find activity" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 130 }} />
        <label><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Only activities with remaining work</label>
        <span>Estimated: <b>{estimated}</b> of {tasks.length}</span>
        <span className="muted">Durations are remaining durations in days of {hpd} h. Double-click to edit.</span>
      </div>
      <div className="winbody">
        <Grid cols={EST_COLS} items={items} selected={new Set(sel ? [sel] : [])} onSelect={(k) => setSel(k)} getEditor={getEditor} onCommit={onCommit}
          onContextMenu={(k, e) => {
            if (k) setSel(k);
            showContextMenu(e, k ? [
              { label: 'Remove Estimate', onClick: () => mutate('Remove Estimate', (d) => setEstimate(d, k, null)) },
              { label: 'Go To Activity', onClick: () => setUi({ view: 'activities', selTask: k, selTasks: [k] }) },
            ] : []);
          }}
          emptyText="No activities with remaining work in the open projects." />
      </div>
    </>
  );
}

// ================================================================ Analysis

interface RunState { running: boolean; done: number; total: number; error?: string; result?: MonteCarloResult; key?: string; dbVersion?: number; controller?: AbortController }
let runState: RunState = { running: false, done: 0, total: 0 };
const runListeners = new Set<() => void>();
function setRun(patch: Partial<RunState>) { runState = { ...runState, ...patch }; for (const l of runListeners) l(); }
function useRun(): RunState {
  return useSyncExternalStore((cb) => { runListeners.add(cb); return () => runListeners.delete(cb); }, () => runState);
}
let lastSettings = { iterations: 500, seed: '', events: 'pre' as RiskPhase | 'off' };

async function startRun(projIds: string[], iterations: number, seed: number | undefined, events: RiskPhase | 'off', dbVersion: number) {
  const controller = new AbortController();
  setRun({ running: true, done: 0, total: iterations, error: undefined, controller });
  let last = 0;
  try {
    const result = await runMonteCarlo(getDb(), projIds, {
      iterations, seed, riskEvents: events, signal: controller.signal,
      onProgress: (i) => { const now = Date.now(); if (now - last > 80 || i === iterations) { last = now; setRun({ done: i }); } },
    });
    setRun({ running: false, result, key: projIds.join(','), dbVersion, controller: undefined });
    toast(`Risk analysis complete: ${iterations} iterations in ${(result.elapsedMs / 1000).toFixed(1)} s.`);
  } catch (e) {
    setRun({ running: false, error: (e as Error).message, controller: undefined });
  }
}

function AnalysisTab() {
  const ui = useStore((s) => s.ui);
  const dbVersion = useStore((s) => s.dbVersion);
  const ctx = useCtx();
  const run = useRun();
  const [iterations, setIterations] = useState(lastSettings.iterations);
  const [seed, setSeed] = useState(lastSettings.seed);
  const [events, setEvents] = useState(lastSettings.events);
  useEffect(() => { lastSettings = { iterations, seed, events }; }, [iterations, seed, events]);
  const key = ui.openProjects.join(',');
  const res = run.result && run.key === key ? run.result : undefined;
  const ests = useMemo(() => getEstimates(ctx.db), [ctx]);
  const openSet = new Set(ui.openProjects);
  const nEst = rows(ctx.db, 'TASK').filter((t) => openSet.has(t.proj_id) && ests.has(t.task_id) && isEstimable(t)).length;
  const nRisk = risksOf(ctx.db, ui.openProjects).filter((r) => r.status_code !== 'RS_Rejected' && linkedTasks(ctx.db, r.proj_risk_id).length).length;

  const go = () => {
    if (run.running) return;
    const n = Math.floor(iterations);
    if (!(n >= 10 && n <= 20000)) return toast('Iterations must be between 10 and 20,000.');
    const s = seed.trim() === '' ? undefined : Number(seed);
    if (s != null && !Number.isInteger(s)) return toast('Seed must be a whole number (or blank for a random seed).');
    if (!nEst && !(nRisk && events !== 'off')) toast('No duration estimates or linked risks: every iteration will give the deterministic finish. Use Estimates > Set defaults.');
    void startRun(ui.openProjects, n, s, events, dbVersion);
  };

  return (
    <>
      <div className="layoutbar">
        <label>Iterations <input type="number" value={iterations} min={10} max={20000} step={100} onChange={(e) => setIterations(Number(e.target.value))} style={{ width: 64 }} disabled={run.running} /></label>
        <label>Seed <input value={seed} placeholder="random" onChange={(e) => setSeed(e.target.value)} style={{ width: 70 }} disabled={run.running} /></label>
        <label>Risk events <select value={events} onChange={(e) => setEvents(e.target.value as RiskPhase | 'off')} disabled={run.running}>
          <option value="pre">Pre-response</option><option value="post">Post-response</option><option value="off">Ignore</option>
        </select></label>
        {!run.running ? <button className="tbtn" onClick={go}><span className="lbl"><b>Run Risk Analysis</b></span></button>
          : <button className="tbtn" onClick={() => run.controller?.abort()}><span className="lbl">Cancel</span></button>}
        {run.running && <span><progress value={run.done} max={run.total} style={{ width: 160, verticalAlign: 'middle' }} /> {run.done} / {run.total}</span>}
        <span className="muted">{nEst} activities with estimates, {nRisk} risks with linked activities.</span>
        {res && <span>Last run: {res.iterations} iterations, seed {res.seed}, {(res.elapsedMs / 1000).toFixed(1)} s{run.dbVersion !== dbVersion ? ' (schedule changed since)' : ''}</span>}
      </div>
      {run.error && <div className="layoutbar" style={{ color: '#c00000' }}>{run.error}</div>}
      <div className="winbody">
        {!res ? <div className="empty">{run.running ? 'Running the risk analysis…' : 'Set duration estimates (Estimates tab) and link risks to activities (Risk Register), then click Run Risk Analysis. Each iteration samples remaining durations and risk events and reschedules the projects with the CPM scheduler; the database is not changed.'}</div>
          : <Results res={res} prefs={ctx.prefs} />}
      </div>
    </>
  );
}

const CRIT_COLS: GridCol[] = [
  { id: 'code', title: 'Activity ID', width: 86 },
  { id: 'name', title: 'Activity Name', width: 210 },
  { id: 'crit', title: 'Criticality Index', width: 110 },
  { id: 'sens', title: 'Duration Sensitivity', width: 72, align: 'right' },
  { id: 'det', title: 'Deterministic Finish', width: 82 },
  { id: 'p50', title: 'P50 Finish', width: 82 },
  { id: 'p80', title: 'P80 Finish', width: 82 },
  { id: 'dur', title: 'Duration min / mean / max (d)', width: 120, align: 'right' },
];

function Results({ res, prefs }: { res: MonteCarloResult; prefs: Prefs }) {
  const hpd = prefs.hoursPerDay;
  const [sel, setSel] = useState<string | null>(null);
  const critItems: GridItem[] = useMemo(() => res.activities.filter((a) => !a.milestone || a.criticality > 0).map((a) => ({
    key: a.taskId, kind: 'row', level: 0, className: a.criticality >= 50 ? 'crit' : '',
    cells: {
      code: a.code, name: a.name,
      crit: <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ flex: 1, height: 9, background: '#eee', border: '1px solid #ccc' }}><div style={{ width: `${a.criticality}%`, height: '100%', background: a.criticality >= 50 ? '#d03030' : '#e89a3c' }} /></div>
        <span style={{ width: 34, textAlign: 'right' }}>{Math.round(a.criticality)}%</span></div>,
      sens: a.sensitivity == null ? '' : a.sensitivity.toFixed(2),
      det: fmtDate(a.deterministicFinish, prefs), p50: fmtDate(a.p50Finish, prefs), p80: fmtDate(a.p80Finish, prefs),
      dur: a.maxDur > 0 ? `${days(a.minDur, hpd)} / ${days(a.meanDur, hpd)} / ${days(a.maxDur, hpd)}` : '',
    },
  })), [res, prefs]);
  const diff = (t: number): string => {
    const d = Math.round((t - res.deterministicFinish) / MIN_PER_DAY);
    return d === 0 ? '' : (d > 0 ? '+' : '') + d + ' cd';
  };
  const prow = (label: string, t: number, color?: string) => {
    const swatch = color ? <span style={{ display: 'inline-block', width: 10, borderTop: '2px solid ' + color, marginRight: 4, verticalAlign: 'middle' }} /> : null;
    return <tr key={label}><td>{swatch}{label}</td><td>{fmtDate(t, prefs)}</td><td style={{ textAlign: 'right' }} className="muted">{diff(t)}</td></tr>;
  };
  return (
    <Split dir="v" initial={330} storeKey="risk-analysis">
      <Split dir="h" initial={540} storeKey="risk-analysis-top">
        <FinishChart res={res} prefs={prefs} />
        <div className="details" style={{ overflow: 'auto', padding: 6, background: '#fff' }}>
          <table className="tbl" style={{ marginBottom: 8 }}>
            <thead><tr><th>Project Finish</th><th>Date</th><th style={{ textAlign: 'right' }}>vs. Deterministic</th></tr></thead>
            <tbody>
              {prow('Deterministic', res.deterministicFinish, '#000')}
              {prow('P10', res.percentiles.P10)}
              {prow('P50', res.percentiles.P50, '#2e8b2e')}
              {prow('P80', res.percentiles.P80, '#e07000')}
              {prow('P90', res.percentiles.P90)}
              {prow('Mean', res.mean)}
              {prow('Minimum', res.min)}
              {prow('Maximum', res.max)}
              <tr><td>Standard deviation</td><td colSpan={2}>{r2(res.stdDevDays)} calendar days</td></tr>
              <tr><td>Probability of meeting deterministic</td><td colSpan={2}><b>{Math.round(res.probDeterministic * 100)}%</b></td></tr>
            </tbody>
          </table>
          {res.milestones.length > 0 && <table className="tbl" style={{ marginBottom: 8 }}>
            <thead><tr><th>Milestone</th><th>Deterministic</th><th>P50</th><th>P80</th><th>P90</th></tr></thead>
            <tbody>{res.milestones.map((m) => <tr key={m.taskId} title={m.name}><td>{m.code} {m.name}</td><td>{fmtDate(m.deterministic, prefs)}</td><td>{fmtDate(m.P50, prefs)}</td><td>{fmtDate(m.P80, prefs)}</td><td>{fmtDate(m.P90, prefs)}</td></tr>)}</tbody>
          </table>}
          {res.risks.length > 0 && <table className="tbl">
            <thead><tr><th>Risk</th><th>Probability</th><th>Impact (d)</th><th>Activities</th><th>Occurred</th></tr></thead>
            <tbody>{res.risks.map((r) => <tr key={r.projRiskId}><td>{r.code} {r.name}</td><td style={{ textAlign: 'right' }}>{Math.round(r.probability * 100)}%</td><td style={{ textAlign: 'right' }}>{days(r.hours, hpd)}</td><td style={{ textAlign: 'right' }}>{r.activities}</td><td style={{ textAlign: 'right' }}>{Math.round(r.triggeredPct)}%</td></tr>)}</tbody>
          </table>}
        </div>
      </Split>
      <Split dir="h" initial={540} storeKey="risk-analysis-bottom">
        <div className="details">
          <div className="layoutbar" style={{ color: '#000' }}><b>Criticality Index</b><span className="muted">% of iterations in which the activity was critical (total float &lt;= 0). Double-click to go to the activity.</span></div>
          <Grid cols={CRIT_COLS} items={critItems} selected={new Set(sel ? [sel] : [])} onSelect={(k) => setSel(k)}
            onActivate={(k) => setUi({ view: 'activities', selTask: k, selTasks: [k] })} emptyText="No activities." />
        </div>
        <Tornado res={res} />
      </Split>
    </Split>
  );
}

function Tornado({ res }: { res: MonteCarloResult }) {
  const top = res.sensitivity.slice(0, 10);
  return (
    <div className="details" style={{ background: '#fff', overflow: 'auto' }}>
      <div className="layoutbar" style={{ color: '#000' }}><b>Duration Sensitivity (top 10)</b><span className="muted">Spearman rank correlation of activity duration with project finish.</span></div>
      {!top.length ? <div className="empty">No activity duration varied. Set estimates with a range on the Estimates tab.</div> : (
        <div style={{ padding: '8px 10px' }}>
          {top.map((s) => {
            const w = Math.min(1, Math.abs(s.rho)) * 50;
            return (
              <div key={s.taskId} style={{ display: 'flex', alignItems: 'center', height: 22 }} title={`${s.code} ${s.name}: ${s.rho.toFixed(3)}`}>
                <div style={{ width: 190, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 6 }}><b>{s.code}</b> {s.name}</div>
                <div style={{ flex: 1, position: 'relative', height: 16, minWidth: 120 }}>
                  <div style={{ position: 'absolute', left: '50%', top: -3, bottom: -3, borderLeft: '1px solid #666' }} />
                  <div style={{ position: 'absolute', top: 1, height: 14, background: s.rho >= 0 ? '#c0504d' : '#4f81bd', border: '1px solid rgba(0,0,0,.35)', left: s.rho >= 0 ? '50%' : `${50 - w}%`, width: `${w}%` }} />
                </div>
                <div style={{ width: 44, flex: 'none', textAlign: 'right' }}>{s.rho.toFixed(2)}</div>
              </div>
            );
          })}
          <div style={{ display: 'flex', marginTop: 2 }}>
            <div style={{ width: 190, flex: 'none' }} />
            <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', color: '#555', fontSize: 10 }}><span>-1</span><span>0</span><span>+1</span></div>
            <div style={{ width: 44, flex: 'none' }} />
          </div>
        </div>
      )}
    </div>
  );
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function FinishChart({ res, prefs }: { res: MonteCarloResult; prefs: Prefs }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 300 });
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const L = 46, R = 46, T = 44, B = 36;
  const W = Math.max(200, size.w), H = Math.max(160, size.h);
  const pw = W - L - R, ph = H - T - B;
  const bins = res.histogram;
  const x0 = Math.min(bins[0].start, res.deterministicFinish), x1 = Math.max(bins[bins.length - 1].end, res.deterministicFinish + MIN_PER_DAY);
  const pad = (x1 - x0) * 0.03;
  const lo = x0 - pad, hi = x1 + pad;
  const x = (t: number) => L + ((t - lo) / (hi - lo)) * pw;
  const maxC = Math.max(1, ...bins.map((b) => b.count));
  const yC = (c: number) => T + ph - (c / (maxC * 1.1)) * ph;
  const yP = (p: number) => T + ph - (p / 100) * ph;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    c.style.width = `${W}px`; c.style.height = `${H}px`;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = '11px Tahoma, "Segoe UI", sans-serif';
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    // grid + right axis (%)
    g.strokeStyle = '#e4e4e4'; g.fillStyle = '#000'; g.textBaseline = 'middle';
    for (let p = 0; p <= 100; p += 20) {
      const yy = Math.round(yP(p)) + 0.5;
      g.beginPath(); g.moveTo(L, yy); g.lineTo(L + pw, yy); g.stroke();
      g.textAlign = 'left'; g.fillText(`${p}%`, L + pw + 5, yy);
    }
    // left axis (hits)
    const step = Math.max(1, Math.ceil(maxC / 5));
    g.textAlign = 'right';
    for (let v = 0; v <= maxC * 1.1; v += step) g.fillText(String(v), L - 5, yC(v));
    g.save(); g.translate(11, T + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('Hits', 0, 0); g.restore();
    g.save(); g.translate(W - 8, T + ph / 2); g.rotate(Math.PI / 2); g.textAlign = 'center'; g.fillText('Cumulative frequency', 0, 0); g.restore();
    // bars
    for (const b of bins) {
      if (!b.count) continue;
      const xa = x(b.start), xb = x(b.end);
      g.fillStyle = '#7ea6d8'; g.fillRect(xa + 0.5, yC(b.count), Math.max(1, xb - xa - 1), yC(0) - yC(b.count));
      g.strokeStyle = '#3c6aa6'; g.strokeRect(Math.round(xa) + 0.5, Math.round(yC(b.count)) + 0.5, Math.max(1, Math.round(xb - xa) - 1), Math.round(yC(0) - yC(b.count)));
    }
    // cumulative S-curve
    g.strokeStyle = '#1f3d6b'; g.lineWidth = 2; g.beginPath();
    g.moveTo(x(res.cumulative[0].t), yP(0));
    for (const p of res.cumulative) g.lineTo(x(p.t), yP(p.pct));
    g.lineTo(L + pw, yP(100));
    g.stroke(); g.lineWidth = 1;
    // frame
    g.strokeStyle = '#808080'; g.strokeRect(L + 0.5, T + 0.5, pw, ph);
    // time axis: nice day step
    const spanD = (hi - lo) / MIN_PER_DAY;
    const stepD = [1, 2, 7, 14, 30, 61, 91, 182, 365].find((s) => (spanD / s) * 64 <= pw) ?? 730;
    g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'top';
    const first = Math.ceil(lo / (MIN_PER_DAY * stepD)) * MIN_PER_DAY * stepD;
    for (let t = first; t <= hi; t += MIN_PER_DAY * stepD) {
      const xx = Math.round(x(t)) + 0.5;
      g.strokeStyle = '#808080'; g.beginPath(); g.moveTo(xx, T + ph); g.lineTo(xx, T + ph + 4); g.stroke();
      const d = new Date(t * 60000);
      g.fillText(stepD >= 30 ? `${MON[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}` : fmtDate(t, prefs, false), xx, T + ph + 6);
    }
    g.fillText('Project finish date', L + pw / 2, T + ph + 21);
    // markers
    const marks: [string, number, string, number[]][] = [
      ['Deterministic', res.deterministicFinish, '#000', [5, 3]], ['P50', res.percentiles.P50, '#2e8b2e', []], ['P80', res.percentiles.P80, '#e07000', []],
    ];
    const placed: number[] = [];
    marks.sort((a, b) => a[1] - b[1]);
    for (const [label, t, color, dash] of marks) {
      const xx = Math.round(x(t)) + 0.5;
      g.strokeStyle = color; g.lineWidth = 1.5; g.setLineDash(dash);
      g.beginPath(); g.moveTo(xx, T - 4); g.lineTo(xx, T + ph); g.stroke();
      g.setLineDash([]); g.lineWidth = 1;
      const text = `${label} ${fmtDate(t, prefs, false)}`;
      const tw = g.measureText(text).width;
      let row = 0;
      while (placed[row] != null && placed[row] > xx - tw / 2 - 4) row++;
      const tx = Math.min(W - tw / 2 - 2, Math.max(tw / 2 + 2, xx));
      placed[row] = tx + tw / 2;
      g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, tx, 8 + row * 13);
    }
  }, [res, prefs, W, H, pw, ph]);

  const onMove = (e: RME<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const b = bins.find((k) => mx >= x(k.start) && mx < x(k.end));
    if (!b || e.clientY - rect.top < T || e.clientY - rect.top > T + ph) { setTip(null); return; }
    setTip({ x: e.clientX + 12, y: e.clientY + 12, text: `${fmtDate(b.start, prefs, false)}${b.end - b.start > MIN_PER_DAY ? ` - ${fmtDate(b.end - 1, prefs, false)}` : ''}\nHits: ${b.count} (${r2((100 * b.count) / res.iterations)}%)\nCumulative: ${r2(b.cumPct)}%` });
  };

  return (
    <div className="details" style={{ background: '#fff' }}>
      <div className="layoutbar" style={{ color: '#000' }}><b>Project Finish Date Distribution</b><span className="muted">Histogram of finish dates with cumulative S-curve, {res.iterations} iterations.</span></div>
      <div ref={wrap} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <canvas ref={canvas} style={{ display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      </div>
      {tip && <div className="gantt-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}
