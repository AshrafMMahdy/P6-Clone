// Actions triggered from menus, toolbars and context menus.
import { getDb, getUi, mutate, setUi, toast, openDialog, doUndo, doRedo, saveNow } from './store.ts';
import { addActivity, addWbs, deleteActivities } from './model.ts';
import { rows } from '../core/db.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { syncAssignmentDates } from '../core/resource/assign.ts';

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
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { doUndo(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'y') { doRedo(); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 's') { saveNow().then(() => toast('Changes committed')); return true; }
  if (e.ctrlKey && e.key.toLowerCase() === 'a' && getUi().view === 'activities') {
    const ids = rows(getDb(), 'TASK').filter((x) => getUi().openProjects.includes(x.proj_id)).map((x) => x.task_id);
    setUi({ selTasks: ids }); return true;
  }
  return false;
}
