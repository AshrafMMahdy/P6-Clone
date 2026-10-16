import { useMemo, useState } from 'react';
import { Grid, type GridItem, type EditorSpec } from '../components/Grid.tsx';
import { Gantt, DEFAULT_BARS, type GanttEntry, type GanttLink, type GanttActions } from '../components/Gantt.tsx';
import { Split, showContextMenu } from '../components/Layout.tsx';
import { getDb, mutate, setUi, toast, useStore, openDialog } from '../store.ts';
import { useCtx, useProjectCalendar } from '../hooks.ts';
import { COLUMN_BY_ID, fmtDate, fmtDur, isCritical, isMilestone, addRelationship, checkRelationship, TASK_TYPES } from '../model.ts';
import { buildActivityRows, FILTERS, taskStart, taskFinish } from './activityRows.ts';
import { ActivityDetails } from './ActivityDetails.tsx';
import { parseP6Date, formatP6Date } from '../../core/dates.ts';
import type { Row } from '../../core/db.ts';
import { activityCommands } from '../commands.ts';

const WBS_COLORS = ['var(--wbs0)', 'var(--wbs1)', 'var(--wbs2)', 'var(--wbs3)', 'var(--wbs4)'];

export function ActivitiesView() {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const [scrollTop, setScrollTop] = useState(0);
  const [search, setSearch] = useState('');
  const projIds = ui.openProjects;
  const rows = useMemo(() => buildActivityRows(ctx, projIds, ui.collapsed, ui.filter, ui.groupBy, ui.sortBy, search), [ctx, projIds, ui.collapsed, ui.filter, ui.groupBy, ui.sortBy, search]);
  const cols = useMemo(() => ui.columns.map((id) => COLUMN_BY_ID.get(id)).filter((c) => c != null), [ui.columns]); // stable, or every scroll would rebuild every row
  const selected = useMemo(() => new Set([...ui.selTasks.map((t) => `t:${t}`), ...(ui.selWbs && !ui.selTasks.length ? [`w:${ui.selWbs}`] : [])]), [ui.selTasks, ui.selWbs]);
  const firstProj = ctx.proj.get(projIds[0]);
  const dataDate = parseP6Date(firstProj?.last_recalc_date);
  const cal = useProjectCalendar(projIds[0]);

  const items: GridItem[] = useMemo(() => rows.map((r) => {
    if (r.kind === 'group') {
      const cells: Record<string, string> = {};
      for (const c of cols) {
        if (c.id === 'start') cells[c.id] = fmtDate(r.es, ctx.prefs);
        else if (c.id === 'finish') cells[c.id] = fmtDate(r.ef, ctx.prefs);
        else if (c.id === 'total_float') cells[c.id] = r.minTf == null ? '' : fmtDur(r.minTf, ctx.prefs);
        else if (c.id === 'orig_dur' && r.es != null && r.ef != null && cal) cells[c.id] = fmtDur(cal.workBetween(r.es, r.ef) / 60, ctx.prefs);
        else cells[c.id] = '';
      }
      return { key: r.key, kind: 'group', level: r.level, label: r.label, cells, hasChildren: r.hasChildren, collapsed: r.collapsed, style: { background: WBS_COLORS[Math.min(r.level, 4)] } } satisfies GridItem;
    }
    const t = r.task!;
    const cells: Record<string, string> = {};
    for (const c of cols) cells[c.id] = c.get(t, ctx);
    const crit = isCritical(t, ctx);
    return { key: r.key, kind: 'row', level: r.level, cells, icon: <ActIcon t={t} crit={crit} />, className: crit ? 'crit' : '' } satisfies GridItem;
  }), [rows, cols, ctx, cal]);

  const barLabel = ui.bars?.label ?? 'none';
  const entries: GanttEntry[] = useMemo(() => rows.map((r) => {
    if (r.kind === 'group') return { key: r.key, kind: 'group', level: r.level, es: r.es, ef: r.ef };
    const t = r.task!;
    const bl = ctx.baseline.get(`${t.task_code}|${t.proj_id}`);
    const s = taskStart(t), f = taskFinish(t);
    return {
      key: r.key, kind: 'task', level: r.level,
      es: t.act_end_date ? null : parseP6Date(t.early_start_date || t.restart_date) ?? s, ef: t.act_end_date ? null : parseP6Date(t.early_end_date || t.reend_date) ?? f,
      as: parseP6Date(t.act_start_date), af: parseP6Date(t.act_end_date),
      bls: bl ? parseP6Date(bl.act_start_date || bl.target_start_date) : null, blf: bl ? parseP6Date(bl.act_end_date || bl.target_end_date) : null,
      critical: isCritical(t, ctx), milestone: t.task_type === 'TT_Mile' ? 'start' : t.task_type === 'TT_FinMile' ? 'finish' : null,
      label: barLabel === 'name' ? t.task_name : barLabel === 'id' ? t.task_code : barLabel === 'id-name' ? `${t.task_code} - ${t.task_name}` : undefined,
      tip: `${t.task_code} - ${t.task_name}\n${TASK_TYPES[t.task_type] ?? ''}\nStart: ${s != null ? formatP6Date(s) : ''}${t.act_start_date ? ' A' : ''}\nFinish: ${f != null ? formatP6Date(f) : ''}${t.act_end_date ? ' A' : ''}\nTotal Float: ${fmtDur(t.total_float_hr_cnt, ctx.prefs)}d`,
    } satisfies GanttEntry;
  }), [rows, ctx, barLabel]);

  const links: GanttLink[] = useMemo(() => {
    if (!ui.relLines) return [];
    const vis = new Set(rows.filter((r) => r.kind === 'task').map((r) => r.task!.task_id));
    const out: GanttLink[] = [];
    for (const p of ctx.db.tables.TASKPRED?.rows ?? []) {
      if (!vis.has(p.task_id) || !vis.has(p.pred_task_id)) continue;
      const a = ctx.taskById.get(p.pred_task_id)!, b = ctx.taskById.get(p.task_id)!;
      out.push({ from: `t:${p.pred_task_id}`, to: `t:${p.task_id}`, type: p.pred_type, critical: isCritical(a, ctx) && isCritical(b, ctx), driving: isDriving(p, a, b) });
    }
    return out;
  }, [rows, ctx, ui.relLines]);

  const onSelect = (key: string, e: { ctrlKey: boolean; shiftKey: boolean }) => {
    if (key.startsWith('t:')) {
      const id = key.slice(2);
      if (e.ctrlKey) setUi((u) => ({ selTasks: u.selTasks.includes(id) ? u.selTasks.filter((x) => x !== id) : [...u.selTasks, id], selTask: id }));
      else if (e.shiftKey && ui.selTask) {
        const keys = rows.filter((r) => r.kind === 'task').map((r) => r.task!.task_id);
        const a = keys.indexOf(ui.selTask), b = keys.indexOf(id);
        setUi({ selTasks: keys.slice(Math.min(a, b), Math.max(a, b) + 1), selTask: id });
      } else setUi({ selTasks: [id], selTask: id, selWbs: ctx.taskById.get(id)?.wbs_id });
    } else if (key.startsWith('w:')) setUi({ selTasks: [], selTask: undefined, selWbs: key.slice(2) });
    else setUi({ selTasks: [], selTask: undefined });
  };

  const getEditor = (key: string, colId: string): EditorSpec | null => {
    if (!key.startsWith('t:')) {
      if (key.startsWith('w:') && colId === ui.columns[0]) return null;
      return null;
    }
    const c = COLUMN_BY_ID.get(colId);
    const t = ctx.taskById.get(key.slice(2));
    if (!c?.edit || !t) return null;
    const raw: Record<string, string> = {
      task_type: t.task_type, duration_type: t.duration_type, pct_type: t.complete_pct_type, cstr_type: t.cstr_type,
      start: t.act_start_date || t.early_start_date, finish: t.act_end_date || t.early_end_date, act_start: t.act_start_date, act_finish: t.act_end_date, cstr_date: t.cstr_date,
      orig_dur: fmtDur(t.target_drtn_hr_cnt, ctx.prefs), rem_dur: fmtDur(t.remain_drtn_hr_cnt, ctx.prefs), pct: c.get(t, ctx).replace('%', ''), phys_pct: t.phys_complete_pct || '0',
    };
    return { type: c.edit.type, value: raw[colId] ?? c.get(t, ctx), options: c.edit.options };
  };
  const onCommit = (key: string, colId: string, value: string) => {
    const c = COLUMN_BY_ID.get(colId)!;
    const t = ctx.taskById.get(key.slice(2));
    if (!t || !c.edit) return;
    const copy = { ...t };
    const err = c.edit.set(getDb(), copy, value, ctx);
    if (err) { toast(err); return; }
    if (Object.keys(copy).every((k) => copy[k] === t[k])) return;
    mutate(`Edit ${c.title}`, (db) => {
      const row = db.tables.TASK.rows.find((x) => x.task_id === t.task_id)!;
      Object.assign(row, copy, { update_date: formatP6Date(Date.now() / 60000) });
    });
  };

  const onLink = (from: string, to: string) => {
    const err = checkRelationship(getDb(), from.slice(2), to.slice(2));
    if (err) return toast(err);
    mutate('Add Relationship', (db) => { addRelationship(db, from.slice(2), to.slice(2)); });
    toast('Relationship (FS) added');
  };

  const cmds = activityCommands();
  const onContext = (key: string | null, e: React.MouseEvent) => {
    if (key) onSelect(key, { ctrlKey: false, shiftKey: false });
    showContextMenu(e, [
      { label: 'Add Activity', onClick: cmds.add },
      { label: 'Delete', onClick: cmds.del },
      { sep: true, label: '' },
      { label: 'Assign Predecessors...', onClick: () => openDialog('assign', { which: 'pred' }) },
      { label: 'Assign Successors...', onClick: () => openDialog('assign', { which: 'succ' }) },
      { label: 'Assign Resources...', onClick: () => openDialog('assignRsrc') },
      { sep: true, label: '' },
      { label: 'Add WBS Element', onClick: cmds.addWbs },
      { label: 'Columns...', onClick: () => openDialog('columns') },
      { label: 'Expand All', onClick: () => setUi({ collapsed: {} }) },
      { label: 'Collapse All', onClick: () => setUi({ collapsed: Object.fromEntries(rows.filter((r) => r.kind === 'group' && r.level > 0).map((r) => [r.key, true])) }) },
    ]);
  };

  // right-click in the bar chart (P6: bar chart menu; Microsoft Project: bar styles and layout)
  const onGanttContext = (key: string | null, e: React.MouseEvent, g: GanttActions) => {
    const act = key ? [
      { label: 'Activity Details', onClick: () => setUi({ bottom: 'details', detailTab: 'general' }) },
      { label: 'Assign Predecessors...', onClick: () => openDialog('assign', { which: 'pred' }) },
      { label: 'Assign Successors...', onClick: () => openDialog('assign', { which: 'succ' }) },
      { label: 'Assign Resources...', onClick: () => openDialog('assignRsrc') },
      { label: 'Delete Activity', onClick: cmds.del },
      { sep: true, label: '' },
    ] : [{ label: 'Add Activity', onClick: cmds.add }, { sep: true, label: '' }];
    const b = { ...DEFAULT_BARS, ...ui.bars };
    showContextMenu(e, [
      ...act,
      { label: 'Bars...', onClick: () => openDialog('bars') },
      { label: 'Bar Chart Options...', onClick: () => openDialog('bars', { tab: 'options' }) },
      { label: 'Timescale...', onClick: () => openDialog('timescale') },
      { sep: true, label: '' },
      { label: 'Relationship Lines', checked: ui.relLines, onClick: () => setUi({ relLines: !ui.relLines }) },
      { label: 'Baseline Bars', checked: b.showBaseline, onClick: () => setUi({ bars: { ...b, showBaseline: !b.showBaseline } }) },
      { label: 'Activity Labels on Bars', checked: b.label !== 'none', onClick: () => setUi({ bars: { ...b, label: b.label === 'none' ? 'name' : 'none' } }) },
      { sep: true, label: '' },
      { label: 'Zoom In', onClick: () => setUi((u) => ({ pxPerDay: Math.min(60, u.pxPerDay * 1.6) })) },
      { label: 'Zoom Out', onClick: () => setUi((u) => ({ pxPerDay: Math.max(0.15, u.pxPerDay / 1.6) })) },
      { label: 'Zoom to Fit Project', onClick: g.zoomToFit },
      { label: 'Go To Data Date', onClick: g.goToDataDate },
      { label: 'Go To Selected Activity', disabled: !ui.selTask, onClick: () => ui.selTask && g.goToKey(`t:${ui.selTask}`) },
    ]);
  };

  if (!projIds.length) return <div className="empty">No project is open. Open a project from the Projects window (double-click) or use File &gt; Import.</div>;

  return (
    <>
      <div className="layoutbar">
        <span>Layout: <b>{ui.layoutName}</b></span>
        <span>Filter:</span>
        <select className="opt" value={ui.filter} onChange={(e) => setUi({ filter: e.target.value })}>
          {Object.entries(FILTERS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span>Group:</span>
        <select className="opt" value={ui.groupBy} onChange={(e) => setUi({ groupBy: e.target.value })}>
          <option value="wbs">WBS</option>
          <option value="none">No grouping</option>
          {(ctx.db.tables.ACTVTYPE?.rows ?? []).map((t) => <option key={t.actv_code_type_id} value={`code:${t.actv_code_type_id}`}>Code: {t.actv_code_type}</option>)}
        </select>
        <span>Sort:</span>
        <select className="opt" value={ui.sortBy} onChange={(e) => setUi({ sortBy: e.target.value })}>
          <option value="">Start</option><option value="task_code">Activity ID</option><option value="task_name">Activity Name</option><option value="total_float">Total Float</option><option value="finish">Finish</option>
        </select>
        <input className="opt" placeholder="Find activity..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 150 }} />
        <span style={{ marginLeft: 'auto' }}>{rows.filter((r) => r.kind === 'task').length} activities · Data Date {fmtDate(dataDate, ctx.prefs, true)}</span>
      </div>
      <Split dir="v" initial={Math.round(window.innerHeight * 0.52)} storeKey="act-v">
        <Split dir="h" initial={Math.min(760, Math.round(window.innerWidth * 0.48))} storeKey="act-h">
          <Grid cols={cols} items={items} selected={selected} onSelect={onSelect} treeCol={ui.columns.includes('task_code') ? 'task_code' : ui.columns[0]}
            onToggle={(k) => setUi((u) => ({ collapsed: { ...u.collapsed, [k]: !u.collapsed[k] } }))}
            getEditor={getEditor} onCommit={onCommit} onScroll={setScrollTop} scrollTop={scrollTop}
            onContextMenu={onContext} labelSpan={ui.columns[1] === 'task_name' ? 2 : 1}
            onActivate={(k) => k.startsWith('t:') && setUi({ detailTab: 'general' })} />
          <Gantt entries={entries} links={links} dataDate={dataDate} pxPerDay={ui.pxPerDay} showLinks={ui.relLines} scrollTop={scrollTop} onScroll={setScrollTop}
            selected={selected} onSelect={(k) => onSelect(k, { ctrlKey: false, shiftKey: false })} onLink={onLink} calendar={cal} showBaseline
            styles={ui.bars} onContextMenu={onGanttContext} onZoom={(px) => setUi({ pxPerDay: px })} />
        </Split>
        <ActivityDetails />
      </Split>
    </>
  );
}

function isDriving(p: Row, a: Row, b: Row): boolean {
  // driving = relationship free float zero, judged from stored early dates
  const ty = p.pred_type;
  const from = parseP6Date(ty === 'PR_SS' || ty === 'PR_SF' ? (a.act_start_date || a.early_start_date) : (a.act_end_date || a.early_end_date));
  const to = parseP6Date(ty === 'PR_FF' || ty === 'PR_SF' ? b.early_end_date : (b.early_start_date || b.restart_date));
  if (from == null || to == null || b.act_end_date) return false;
  const lag = Number(p.lag_hr_cnt || 0) * 60;
  return to - from - lag <= 16 * 60 && to >= from; // within one non-work gap
}

function ActIcon({ t, crit }: { t: Row; crit: boolean }) {
  const color = t.act_end_date ? '#0000ff' : t.act_start_date ? '#0000ff' : crit ? '#ff0000' : '#00b000';
  if (isMilestone(t)) return <svg className="acticon" viewBox="0 0 10 10"><path d="M5 0l5 5-5 5-5-5z" fill={color} /></svg>;
  if (t.task_type === 'TT_LOE') return <svg className="acticon" viewBox="0 0 10 10"><rect x="0" y="3" width="10" height="4" fill={color} /></svg>;
  if (t.task_type === 'TT_WBS') return <svg className="acticon" viewBox="0 0 10 10"><rect x="0" y="2" width="10" height="4" fill="#000" /></svg>;
  return <svg className="acticon" viewBox="0 0 10 10"><rect x="0" y="1" width="10" height="8" fill={t.act_start_date && !t.act_end_date ? 'url(#half)' : color} stroke="#555" strokeWidth=".6" />
    {t.act_start_date && !t.act_end_date && <><rect x="0" y="1" width="5" height="8" fill="#0000ff" /><rect x="5" y="1" width="5" height="8" fill={crit ? '#ff0000' : '#00b000'} /></>}</svg>;
}
