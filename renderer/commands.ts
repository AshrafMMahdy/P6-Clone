// Actions triggered from menus, toolbars and context menus.
import { getDb, getUi, mutate, setUi, toast, openDialog, doUndo, doRedo, saveNow } from './store.ts';
import { addActivity, addRelationship, addWbs, deleteActivities, dissolveActivities, makeCtx, nextTaskCode } from './model.ts';
import { buildActivityRows, toolbarSearch } from './views/activityRows.ts';
import { nextId, rows, table, type Db, type Row } from '../core/db.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';

// Activity clipboard (Edit > Copy / Paste): activities, the relationships among them, and their assignments.
let clipboard: { tasks: Row[]; preds: Row[]; asg: Row[]; cut?: boolean } | null = null;

export function copyActivities(): void {
  const ui = getUi(), db = getDb();
  const ids = new Set(ui.selTasks);
  if (!ids.size) return toast('Select activities to copy.');
  clipboard = {
    tasks: rows(db, 'TASK').filter((t) => ids.has(t.task_id)).map((t) => ({ ...t })),
    preds: rows(db, 'TASKPRED').filter((p) => ids.has(p.task_id) && ids.has(p.pred_task_id)).map((p) => ({ ...p })),
    asg: rows(db, 'TASKRSRC').filter((a) => ids.has(a.task_id)).map((a) => ({ ...a })),
  };
  toast(`Copied ${ids.size} activit${ids.size > 1 ? 'ies' : 'y'}`);
}

/** Edit > Cut: like P6, Paste then MOVES the activities (same IDs, all their relationships, assignments, codes,
 *  steps, notes) to the WBS or project pasted into. Nothing is removed until the paste. */
export function cutActivities(): void {
  copyActivities();
  if (clipboard) { clipboard.cut = true; toast(`Cut ${clipboard.tasks.length} activit${clipboard.tasks.length > 1 ? 'ies' : 'y'}: select a WBS or activity and Paste to move them`); }
}

/** Move activities to a WBS (another project too). Activity IDs are kept unless they clash in the target project. */
export function moveActivities(d: Db, taskIds: string[], wbsRow: Row): number {
  const ids = new Set(taskIds);
  const target = wbsRow.proj_id;
  let n = 0;
  for (const t of rows(d, 'TASK')) {
    if (!ids.has(t.task_id)) continue;
    const from = t.proj_id;
    t.wbs_id = wbsRow.wbs_id;
    if (from !== target) {
      if (rows(d, 'TASK').some((x) => x !== t && x.proj_id === target && x.task_code === t.task_code)) t.task_code = nextTaskCode(d, target);
      t.proj_id = target;
    }
    n++;
  }
  // rows that belong to the moved activities follow them into the project
  for (const tb of Object.values(d.tables)) {
    if (tb.name === 'TASK' || tb.name === 'TASKPRED' || !tb.fields.includes('task_id') || !tb.fields.includes('proj_id')) continue;
    for (const r of tb.rows) if (ids.has(r.task_id)) r.proj_id = target;
  }
  for (const p of rows(d, 'TASKPRED')) { if (ids.has(p.task_id)) p.proj_id = target; if (ids.has(p.pred_task_id)) p.pred_proj_id = target; }
  const typeOf = new Map(rows(d, 'UDFTYPE').map((u) => [u.udf_type_id, u.table_name]));
  for (const u of rows(d, 'UDFVALUE')) if (typeOf.get(u.udf_type_id) === 'TASK' && ids.has(u.fk_id)) u.proj_id = target;
  return n;
}

export function pasteActivities(): void {
  const ui = getUi(), db = getDb();
  if (!clipboard) return toast('Nothing to paste.');
  const projId = ui.openProjects[0];
  const sel = ui.selTask ? rows(db, 'TASK').find((t) => t.task_id === ui.selTask) : undefined;
  const wbs = sel?.wbs_id ?? ui.selWbs ?? rows(db, 'PROJWBS').find((w) => w.proj_id === projId && w.proj_node_flag === 'Y')?.wbs_id;
  const wbsRow = rows(db, 'PROJWBS').find((w) => w.wbs_id === wbs);
  if (!wbsRow) return toast('Select a WBS or activity to paste into.');
  const clip = clipboard;
  if (clip.cut) {
    const live = clip.tasks.map((t) => t.task_id).filter((id) => rows(db, 'TASK').some((x) => x.task_id === id));
    if (!live.length) { clipboard = null; return toast('The cut activities no longer exist.'); }
    let n = 0;
    mutate('Move Activities', (d) => { n = moveActivities(d, live, rows(d, 'PROJWBS').find((w) => w.wbs_id === wbsRow.wbs_id)!); });
    clipboard = null;
    setUi({ selTasks: live, selTask: live[0] });
    return toast(`Moved ${n} activit${n > 1 ? 'ies' : 'y'} to ${wbsRow.wbs_name} (relationships kept; F9 reschedules)`);
  }
  const newIds: string[] = [];
  mutate('Paste Activities', (d) => {
    const map = new Map<string, string>();
    for (const t of clip.tasks) {
      const id = String(nextId(d, 'TASK'));
      map.set(t.task_id, id);
      newIds.push(id);
      table(d, 'TASK').rows.push({ ...t, task_id: id, proj_id: wbsRow.proj_id, wbs_id: wbsRow.wbs_id, task_code: nextTaskCode(d, wbsRow.proj_id), act_start_date: '', act_end_date: '', status_code: 'TK_NotStart', remain_drtn_hr_cnt: t.target_drtn_hr_cnt, phys_complete_pct: '0' });
    }
    for (const p of clip.preds) table(d, 'TASKPRED').rows.push({ ...p, task_pred_id: String(nextId(d, 'TASKPRED')), task_id: map.get(p.task_id)!, pred_task_id: map.get(p.pred_task_id)!, proj_id: wbsRow.proj_id, pred_proj_id: wbsRow.proj_id });
    for (const a of clip.asg) table(d, 'TASKRSRC').rows.push({ ...a, taskrsrc_id: String(nextId(d, 'TASKRSRC')), task_id: map.get(a.task_id)!, proj_id: wbsRow.proj_id, act_reg_qty: '0', act_ot_qty: '0', act_reg_cost: '0', act_ot_cost: '0', remain_qty: a.target_qty, remain_cost: a.target_cost, act_start_date: '', act_end_date: '' });
  });
  setUi({ selTasks: newIds, selTask: newIds[0] });
  toast(`Pasted ${newIds.length} activit${newIds.length > 1 ? 'ies' : 'y'} (reschedule with F9)`);
}

/** Edit > Link Activities: finish-to-start links between the selected activities, in the order they were selected. */
export function linkSelected(): void {
  const ids = getUi().selTasks;
  if (ids.length < 2) return toast('Select two or more activities to link.');
  let n = 0;
  const skipped: string[] = [];
  mutate('Link Activities', (d) => {
    for (let i = 1; i < ids.length; i++) {
      const err = addRelationship(d, ids[i - 1], ids[i]);
      if (err) skipped.push(err); else n++;
    }
  });
  toast(`${n} relationship${n === 1 ? '' : 's'} (FS) added${skipped.length ? `; ${skipped.length} skipped: ${skipped[0]}` : ''}`);
}

/** Insert / Delete handlers registered by windows other than Activities (Resources, ...). */
export const viewCommands: Record<string, { add?: () => void; del?: () => void }> = {};

/** Edit > Dissolve on the selected activities. */
export async function dissolveSelected(): Promise<void> {
  const ui = getUi();
  if (ui.view !== 'activities' || !ui.selTasks.length) return toast('Select the activities to dissolve.');
  if (!(await window.p6.confirm(`Dissolve ${ui.selTasks.length} activit${ui.selTasks.length > 1 ? 'ies' : 'y'}?`, 'The activities are deleted and their predecessors are linked directly to their successors.'))) return;
  let n = 0;
  const ids = ui.selTasks;
  mutate('Dissolve', (d) => { n = dissolveActivities(d, ids); });
  setUi({ selTasks: [], selTask: undefined });
  toast(`Dissolved ${ids.length} activit${ids.length > 1 ? 'ies' : 'y'}; ${n} relationship(s) added`);
}

export function activityCommands() {
  return {
    add: () => {
      const ui = getUi();
      // Ins / Edit > Add act on the window you are in, like P6
      if (ui.view === 'wbs') return activityCommands().addWbs();
      if (ui.view === 'projects') return openDialog('newProject');
      if (viewCommands[ui.view]?.add) return viewCommands[ui.view].add!();
      if (ui.view !== 'activities') return toast('Nothing to add here.');
      const db = getDb();
      const projId = ui.openProjects[0];
      if (!projId) return toast('Open a project first.');
      const selTask = ui.selTask ? rows(db, 'TASK').find((t) => t.task_id === ui.selTask) : undefined;
      const wbs = selTask?.wbs_id ?? ui.selWbs ?? rows(db, 'PROJWBS').find((w) => w.proj_id === projId && w.proj_node_flag === 'Y')?.wbs_id;
      if (!wbs) return toast('The project has no WBS root.');
      const wbsRow = rows(db, 'PROJWBS').find((w) => w.wbs_id === wbs)!;
      let id = '';
      mutate('Add Activity', (d) => { id = addActivity(d, wbsRow.proj_id, wbs, ui.prefs.hoursPerDay).task_id; });
      setUi({ selTasks: [id], selTask: id, detailTab: 'general' });
    },
    del: async () => {
      const ui = getUi();
      if (ui.view === 'activities' && ui.selTasks.length) {
        if (!(await window.p6.confirm(`Delete ${ui.selTasks.length} selected activit${ui.selTasks.length > 1 ? 'ies' : 'y'}?`))) return;
        const ids = ui.selTasks;
        mutate('Delete Activities', (d) => deleteActivities(d, ids));
        setUi({ selTasks: [], selTask: undefined });
      } else if (ui.view === 'activities' && ui.selWbs) {
        deleteWbs(ui.selWbs);
      } else if ((ui.view === 'projects') && ui.selProject) {
        openDialog('deleteProject', { projId: ui.selProject });
      } else if (ui.view === 'wbs' && ui.selWbs) {
        deleteWbs(ui.selWbs);
      } else if (viewCommands[ui.view]?.del) viewCommands[ui.view].del!();
      else toast('Select something to delete.');
    },
    addWbs: () => {
      const ui = getUi();
      const db = getDb();
      const projId = ui.openProjects[0];
      if (!projId) return toast('Open a project first.');
      const parent = ui.selWbs ?? rows(db, 'PROJWBS').find((w) => w.proj_id === projId && w.proj_node_flag === 'Y')?.wbs_id;
      const p = rows(db, 'PROJWBS').find((w) => w.wbs_id === parent);
      if (!p) return;
      let id = '';
      mutate('Add WBS', (d) => { id = addWbs(d, p.proj_id, p.wbs_id).wbs_id; });
      setUi({ selWbs: id });
    },
  };
}

async function deleteWbs(wbsId: string) {
  const db = getDb();
  const w = rows(db, 'PROJWBS').find((x) => x.wbs_id === wbsId);
  if (!w) return;
  if (w.proj_node_flag === 'Y') return toast('The project WBS node cannot be deleted. Delete the project from the Projects window.');
  const sub = new Set<string>([wbsId]);
  for (let grew = true; grew; ) { grew = false; for (const x of rows(db, 'PROJWBS')) if (sub.has(x.parent_wbs_id) && !sub.has(x.wbs_id)) { sub.add(x.wbs_id); grew = true; } }
  const tasks = rows(db, 'TASK').filter((t) => sub.has(t.wbs_id)).map((t) => t.task_id);
  if (!(await window.p6.confirm(`Delete WBS ${w.wbs_short_name} - ${w.wbs_name}?`, `${sub.size - 1} child WBS elements and ${tasks.length} activities will also be deleted.`))) return;
  mutate('Delete WBS', (d) => {
    deleteActivities(d, tasks);
    d.tables.PROJWBS.rows = d.tables.PROJWBS.rows.filter((x) => !sub.has(x.wbs_id));
  });
  setUi({ selWbs: undefined });
}

/** F9 with current options; returns the result for the dialog. */
export function runSchedule(over: Parameters<typeof scheduleProjects>[2] = {}) {
  const ui = getUi();
  if (!ui.openProjects.length) { toast('Open a project first.'); return null; }
  let res: ReturnType<typeof scheduleProjects> | null = null;
  mutate('Schedule', (db) => { res = scheduleProjects(db, ui.openProjects, over); if (res.ok) syncAssignmentDates(db); });
  const r = res as ReturnType<typeof scheduleProjects> | null;
  if (r) {
    setUi({ scheduleLog: r.log });
    if (!r.ok) { doUndo(); openDialog('log', { title: 'Schedule Log', text: r.log || r.findings.map((f) => f.message).join('\n') }); }
  }
  return r;
}

export function handleEditKey(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  if (getUi().dialogs.length) return false;
  const c = activityCommands();
  if (e.key === 'Insert') { c.add(); return true; }
  if (e.key === 'Delete') { c.del(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'c' && getUi().view === 'activities') { copyActivities(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'x' && getUi().view === 'activities') { cutActivities(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'v' && getUi().view === 'activities') { pasteActivities(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { doUndo(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'y') { doRedo(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 's') { saveNow().then(() => toast('Changes committed')); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'a' && getUi().view === 'activities') {
    // only the activities the table shows (current filter and filter box), as in P6; rows in collapsed bands count
    const ui = getUi();
    const ids = buildActivityRows(makeCtx(getDb(), ui.prefs), ui.openProjects, {}, ui.filter, ui.groupBy, ui.sortBy, toolbarSearch.text).filter((r) => r.kind === 'task').map((r) => r.task!.task_id);
    setUi({ selTasks: ids }); return true;
  }
  return false;
}

/** Edit > Renumber Activity IDs: selected (or all open) activities, in start order, using the project's prefix/suffix/increment. */
export async function renumberActivities(): Promise<void> {
  const ui = getUi(), db = getDb();
  const ids = ui.selTasks.length ? new Set(ui.selTasks) : new Set(rows(db, 'TASK').filter((t) => ui.openProjects.includes(t.proj_id)).map((t) => t.task_id));
  if (!ids.size) return toast('No activities to renumber.');
  if (!(await window.p6.confirm(`Renumber ${ids.size} activity IDs?`, 'Activities are numbered in start-date order using the project ID prefix, suffix and increment.'))) return;
  mutate('Renumber Activity IDs', (d) => {
    for (const p of rows(d, 'PROJECT').filter((x) => ui.openProjects.includes(x.proj_id))) {
      const list = rows(d, 'TASK').filter((t) => t.proj_id === p.proj_id && ids.has(t.task_id))
        .sort((a, b) => (a.act_start_date || a.early_start_date || '').localeCompare(b.act_start_date || b.early_start_date || '') || a.task_code.localeCompare(b.task_code));
      const others = new Set(rows(d, 'TASK').filter((t) => t.proj_id === p.proj_id && !ids.has(t.task_id)).map((t) => t.task_code));
      const prefix = p.task_code_prefix ?? 'A', step = Number(p.task_code_step || 10);
      let n = Number(p.task_code_base || 1000);
      for (const t of list) { while (others.has(prefix + n)) n += step; t.task_code = prefix + n; n += step; }
    }
  });
}
