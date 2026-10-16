import { useMemo } from 'react';
import { Grid, type GridItem } from '../components/Grid.tsx';
import { showContextMenu } from '../components/Layout.tsx';
import { mutate, openDialog, setUi, useStore } from '../store.ts';
import { useCtx } from '../hooks.ts';
import { ensureEps, fmtDate, projectName } from '../model.ts';
import { rows, type Row } from '../../core/db.ts';
import { taskStart, taskFinish } from './activityRows.ts';

const COLS = [
  { id: 'id', title: 'Project ID', width: 170 },
  { id: 'name', title: 'Project Name', width: 300 },
  { id: 'status', title: 'Status', width: 70 },
  { id: 'start', title: 'Start', width: 80 },
  { id: 'finish', title: 'Finish', width: 80 },
  { id: 'dd', title: 'Data Date', width: 80 },
  { id: 'mfb', title: 'Must Finish By', width: 80 },
  { id: 'acts', title: 'Activities', width: 64, align: 'right' as const },
  { id: 'bl', title: 'Project Baseline', width: 140 },
];

export function openProjects(ids: string[]) {
  setUi({ openProjects: ids, view: 'activities', selTasks: [], selTask: undefined, selWbs: undefined, collapsed: {} });
}

export function ProjectsView() {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const db = ctx.db;
  const items = useMemo(() => {
    const eps = db.tables.EPS?.rows ?? [];
    const projects = rows(db, 'PROJECT').filter((p) => !p._baseline_of);
    const count = new Map<string, number>(); const start = new Map<string, number>(); const fin = new Map<string, number>();
    for (const t of ctx.taskById.values()) {
      count.set(t.proj_id, (count.get(t.proj_id) ?? 0) + 1);
      const s = taskStart(t), f = taskFinish(t);
      if (s != null && s < (start.get(t.proj_id) ?? Infinity)) start.set(t.proj_id, s);
      if (f != null && f > (fin.get(t.proj_id) ?? -Infinity)) fin.set(t.proj_id, f);
    }
    const out: GridItem[] = [];
    const projRow = (p: Row, level: number): GridItem => ({
      key: `p:${p.proj_id}`, kind: 'row', level,
      icon: <svg className="acticon" viewBox="0 0 10 10"><path d="M0 2h4l1 1h5v6H0z" fill={ui.openProjects.includes(p.proj_id) ? '#f5b400' : '#f5d36b'} stroke="#a07a10" strokeWidth=".6" /></svg>,
      cells: {
        id: p.proj_short_name, name: projectName(db, p), status: ui.openProjects.includes(p.proj_id) ? 'Open' : 'Active',
        start: fmtDate(start.get(p.proj_id) ?? p.plan_start_date, ctx.prefs), finish: fmtDate(fin.get(p.proj_id) ?? p.scd_end_date, ctx.prefs),
        dd: fmtDate(p.last_recalc_date, ctx.prefs), mfb: fmtDate(p.plan_end_date, ctx.prefs), acts: String(count.get(p.proj_id) ?? 0),
        bl: p.sum_base_proj_id ? rows(db, 'PROJECT').find((b) => b.proj_id === p.sum_base_proj_id)?.proj_short_name ?? '' : '',
      },
    });
    const visit = (e: Row, level: number) => {
      const key = `e:${e.eps_id}`;
      const kids = eps.filter((x) => x.parent_eps_id === e.eps_id);
      const projs = projects.filter((p) => (p._eps_id || eps[0]?.eps_id) === e.eps_id);
      out.push({ key, kind: 'group', level, label: `${e.eps_short_name}  ${e.eps_name}`, cells: {}, hasChildren: kids.length + projs.length > 0, collapsed: !!ui.collapsed[key], style: { background: 'var(--wbs2)' } });
      if (ui.collapsed[key]) return;
      for (const k of kids) visit(k, level + 1);
      for (const p of projs) out.push(projRow(p, level + 1));
    };
    for (const root of eps.filter((e) => !e.parent_eps_id || !eps.some((x) => x.eps_id === e.parent_eps_id))) visit(root, 0);
    if (!eps.length) for (const p of projects) out.push(projRow(p, 0));
    return out;
  }, [ctx, db, ui.collapsed, ui.openProjects]);

  const selected = new Set(ui.selProject ? [`p:${ui.selProject}`] : []);
  return (
    <>
      <div className="layoutbar">
        <span>Projects in the database: <b>{rows(db, 'PROJECT').filter((p) => !p._baseline_of).length}</b></span>
        <span className="muted">Double-click a project to open it. Use File &gt; Import to load an XER or P6 XML file.</span>
      </div>
      <div className="winbody" style={{ flexDirection: 'row' }}>
        <Grid cols={COLS} items={items} selected={selected} labelSpan={2}
          onSelect={(k) => k.startsWith('p:') && setUi({ selProject: k.slice(2) })}
          onToggle={(k) => setUi((u) => ({ collapsed: { ...u.collapsed, [k]: !u.collapsed[k] } }))}
          onActivate={(k) => k.startsWith('p:') && openProjects([k.slice(2)])}
          emptyText="The database has no projects. Use File > Import or File > New."
          onContextMenu={(k, e) => {
            if (k?.startsWith('p:')) setUi({ selProject: k.slice(2) });
            const pid = k?.startsWith('p:') ? k.slice(2) : undefined;
            showContextMenu(e, [
              ...(pid ? [
                { label: 'Open Project', onClick: () => openProjects([pid]) },
                { label: 'Open Together With Open Projects', onClick: () => openProjects([...new Set([...ui.openProjects, pid])]) },
                { label: 'Project Details...', onClick: () => openDialog('projectDetails', { projId: pid }) },
                { label: 'Export...', onClick: () => openDialog('export', { projIds: [pid] }) },
                { label: 'Maintain Baselines...', onClick: () => openDialog('baselines', { projId: pid }) },
                { label: 'Delete Project', onClick: () => openDialog('deleteProject', { projId: pid }) },
                { sep: true, label: '' },
              ] : []),
              { label: 'New Project...', onClick: () => openDialog('newProject') },
              { label: 'Import...', onClick: () => openDialog('import') },
              { label: 'Add EPS Node', onClick: () => mutate('Add EPS', (d) => { ensureEps(d); const E = d.tables.EPS; const id = String(Math.max(...E.rows.map((r) => Number(r.eps_id))) + 1); E.rows.push({ eps_id: id, parent_eps_id: E.rows[0].eps_id, eps_short_name: `EPS${id}`, eps_name: 'New EPS Node', seq_num: id }); }) },
              { label: 'Enterprise Project Structure...', onClick: () => openDialog('eps') },
            ]);
          }} />
      </div>
    </>
  );
}
