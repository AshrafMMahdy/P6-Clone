import { useMemo } from 'react';
import { Grid, type GridItem, type EditorSpec } from '../components/Grid.tsx';
import { showContextMenu } from '../components/Layout.tsx';
import { mutate, setUi, toast, useStore } from '../store.ts';
import { useCtx, useProjectCalendar } from '../hooks.ts';
import { fmtDate, fmtDur, projectName } from '../model.ts';
import { activityCommands } from '../commands.ts';
import type { Row } from '../../core/db.ts';
import { taskStart, taskFinish } from './activityRows.ts';

const COLS = [
  { id: 'code', title: 'WBS Code', width: 200 },
  { id: 'name', title: 'WBS Name', width: 280 },
  { id: 'acts', title: 'Activities', width: 64, align: 'right' as const },
  { id: 'start', title: 'Start', width: 80 },
  { id: 'finish', title: 'Finish', width: 80 },
  { id: 'dur', title: 'Duration', width: 60, align: 'right' as const },
  { id: 'tf', title: 'Total Float', width: 60, align: 'right' as const },
  { id: 'status', title: 'WBS Status', width: 80 },
];

export function WbsView() {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const cal = useProjectCalendar(ui.openProjects[0]);
  const items = useMemo(() => {
    const out: GridItem[] = [];
    const kids = new Map<string, Row[]>();
    for (const w of ctx.wbs.values()) { if (!kids.has(w.parent_wbs_id)) kids.set(w.parent_wbs_id, []); kids.get(w.parent_wbs_id)!.push(w); }
    const tasksBy = new Map<string, Row[]>();
    for (const t of ctx.taskById.values()) { if (!tasksBy.has(t.wbs_id)) tasksBy.set(t.wbs_id, []); tasksBy.get(t.wbs_id)!.push(t); }
    const visit = (w: Row, level: number, path: string): { s: number; f: number; n: number; tf: number } => {
      const ch = (kids.get(w.wbs_id) ?? []).filter((c) => c.proj_id === w.proj_id && c.proj_node_flag !== 'Y').sort((a, b) => Number(a.seq_num || 0) - Number(b.seq_num || 0));
      const item: GridItem = { key: `w:${w.wbs_id}`, kind: 'row', level, cells: {}, hasChildren: ch.length > 0, collapsed: !!ui.collapsed[`wb:${w.wbs_id}`], style: level === 0 ? { fontWeight: 'bold' } : undefined };
      out.push(item);
      let s = Infinity, f = -Infinity, n = 0, tf = Infinity;
      for (const t of tasksBy.get(w.wbs_id) ?? []) {
        n++;
        const a = taskStart(t), b = taskFinish(t);
        if (a != null) s = Math.min(s, a);
        if (b != null) f = Math.max(f, b);
        if (t.total_float_hr_cnt !== '' && !t.act_end_date) tf = Math.min(tf, Number(t.total_float_hr_cnt));
      }
      for (const c of ch) {
        const pos = out.length;
        const r = visit(c, level + 1, w.proj_node_flag === 'Y' ? c.wbs_short_name : `${path}.${c.wbs_short_name}`);
        if (item.collapsed) out.length = pos;
        s = Math.min(s, r.s); f = Math.max(f, r.f); n += r.n; tf = Math.min(tf, r.tf);
      }
      item.cells = {
        code: w.proj_node_flag === 'Y' ? ctx.proj.get(w.proj_id)?.proj_short_name ?? w.wbs_short_name : path,
        name: w.proj_node_flag === 'Y' ? projectName(ctx.db, ctx.proj.get(w.proj_id) ?? w) : w.wbs_name,
        acts: String(n), start: Number.isFinite(s) ? fmtDate(s, ctx.prefs) : '', finish: Number.isFinite(f) ? fmtDate(f, ctx.prefs) : '',
        dur: Number.isFinite(s) && Number.isFinite(f) && cal ? fmtDur(cal.workBetween(s, f) / 60, ctx.prefs) : '',
        tf: Number.isFinite(tf) ? fmtDur(tf, ctx.prefs) : '', status: (w.status_code || '').replace('WS_', ''),
      };
      return { s, f, n, tf };
    };
    for (const pid of ui.openProjects) {
      const root = [...ctx.wbs.values()].find((w) => w.proj_id === pid && w.proj_node_flag === 'Y');
      if (root) visit(root, 0, '');
    }
    return out;
  }, [ctx, ui.openProjects, ui.collapsed, cal]);

  const getEditor = (key: string, col: string): EditorSpec | null => {
    const w = ctx.wbs.get(key.slice(2));
    if (!w || w.proj_node_flag === 'Y') return null;
    if (col === 'code') return { type: 'text', value: w.wbs_short_name };
    if (col === 'name') return { type: 'text', value: w.wbs_name };
    if (col === 'status') return { type: 'select', value: w.status_code, options: { WS_Planned: 'Planned', WS_Open: 'Active', WS_Closed: 'Inactive', WS_Whatif: 'What-If' } };
    return null;
  };
  const cmds = activityCommands();
  if (!ui.openProjects.length) return <div className="empty">No project is open.</div>;
  return (
    <div className="winbody" style={{ flexDirection: 'row' }}>
      <Grid cols={COLS} items={items} selected={new Set(ui.selWbs ? [`w:${ui.selWbs}`] : [])}
        onSelect={(k) => setUi({ selWbs: k.slice(2) })}
        onToggle={(k) => setUi((u) => ({ collapsed: { ...u.collapsed, [`wb:${k.slice(2)}`]: !u.collapsed[`wb:${k.slice(2)}`] } }))}
        getEditor={getEditor}
        onCommit={(k, col, v) => {
          const id = k.slice(2);
          if (col === 'code' && !v.trim()) return toast('WBS code cannot be blank.');
          mutate('Edit WBS', (db) => {
            const w = db.tables.PROJWBS.rows.find((x) => x.wbs_id === id)!;
            if (col === 'code') w.wbs_short_name = v.trim(); else if (col === 'name') w.wbs_name = v; else w.status_code = v;
          });
        }}
        onContextMenu={(k, e) => { if (k) setUi({ selWbs: k.slice(2) }); showContextMenu(e, [{ label: 'Add WBS Element', onClick: cmds.addWbs }, { label: 'Delete WBS Element', onClick: cmds.del }, { label: 'Activities of this WBS', onClick: () => setUi({ view: 'activities' }) }]); }} />
    </div>
  );
}
