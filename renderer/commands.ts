// Actions triggered from menus, toolbars and context menus.
import { getDb, getUi, mutate, setUi, toast, openDialog, doUndo, doRedo, saveNow } from './store.ts';
import { addActivity, addWbs, deleteActivities, nextTaskCode } from './model.ts';
import { nextId, rows, table, type Row } from '../core/db.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';

// Activity clipboard (Edit > Copy / Paste): activities, the relationships among them, and their assignments.
let clipboard: { tasks: Row[]; preds: Row[]; asg: Row[] } | null = null;

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

export function pasteActivities(): void {
  const ui = getUi(), db = getDb();
  if (!clipboard) return toast('Nothing to paste.');
  const projId = ui.openProjects[0];
  const sel = ui.selTask ? rows(db, 'TASK').find((t) => t.task_id === ui.selTask) : undefined;
  const wbs = sel?.wbs_id ?? ui.selWbs ?? rows(db, 'PROJWBS').find((w) => w.proj_id === projId && w.proj_node_flag === 'Y')?.wbs_id;
  const wbsRow = rows(db, 'PROJWBS').find((w) => w.wbs_id === wbs);
  if (!wbsRow) return toast('Select a WBS or activity to paste into.');
  const clip = clipboard;
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

export function activityCommands() {
  return {
    add: () => {
      const ui = getUi();
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
      } else toast('Select something to delete.');
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
  if (e.ctrlKey && e.key.toLowerCase() === 'x' && getUi().view === 'activities') { copyActivities(); c.del(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'v' && getUi().view === 'activities') { pasteActivities(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { doUndo(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'y') { doRedo(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 's') { saveNow().then(() => toast('Changes committed')); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'a' && getUi().view === 'activities') {
    const ids = rows(getDb(), 'TASK').filter((x) => getUi().openProjects.includes(x.proj_id)).map((x) => x.task_id);
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
