import { useEffect, type JSX } from 'react';
import { Icon } from './components/Icons.tsx';
import { ContextMenuHost } from './components/Layout.tsx';
import { closeDialog, doRedo, doUndo, getDb, getUi, loadFromDisk, openDialog, replaceDb, saveNow, setUi, toast, useStore, undoLabel, type ViewName } from './store.ts';
import { activityCommands, handleEditKey, runSchedule } from './commands.ts';
import { ActivitiesView } from './views/ActivitiesView.tsx';
import { ProjectsView, openProjects } from './views/ProjectsView.tsx';
import { WbsView } from './views/WbsView.tsx';
import { ResourcesView } from './views/ResourcesView.tsx';
import { AssignmentsView } from './views/AssignmentsView.tsx';
import { ReportsView } from './views/ReportsView.tsx';
import { ImportWizard, ExportWizard } from './dialogs/Wizards.tsx';
import { ScheduleDialog, ScheduleOptionsDialog, UpdateProgressDialog } from './dialogs/ScheduleDialogs.tsx';
import { NewProjectDialog, ProjectDetailsDialog, DeleteProjectDialog, BaselinesDialog, EpsDialog } from './dialogs/ProjectDialogs.tsx';
import { ColumnsDialog, LogDialog, ImportLogDialog, AssignDialog, AssignResourceDialog, PreferencesDialog, AboutDialog, validateFileTool } from './dialogs/CommonDialogs.tsx';
import { CalendarsDialog, CodesDialog, UdfDialog, ObsDialog, AccountsDialog, RolesDialog, CurrenciesDialog, LevelDialog, FiltersDialog, TimescaleDialog, LayoutDialog, PageSetupDialog } from './dialogs/EnterpriseDialogs.tsx';
import { emptyDb, rows } from '../core/db.ts';
import { fmtDate, projectName } from './model.ts';
import { printView } from './print.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DIALOGS: Record<string, (p: any) => JSX.Element> = {
  import: ImportWizard, export: ExportWizard, schedule: ScheduleDialog, schedOptions: ScheduleOptionsDialog, progress: UpdateProgressDialog,
  newProject: NewProjectDialog, projectDetails: ProjectDetailsDialog, deleteProject: DeleteProjectDialog, baselines: BaselinesDialog, eps: EpsDialog,
  columns: ColumnsDialog, log: LogDialog, importLog: ImportLogDialog, assign: AssignDialog, assignRsrc: AssignResourceDialog, prefs: PreferencesDialog, about: AboutDialog,
  calendars: CalendarsDialog, codes: CodesDialog, udfs: UdfDialog, obs: ObsDialog, accounts: AccountsDialog, roles: RolesDialog, currencies: CurrenciesDialog,
  level: LevelDialog, filters: FiltersDialog, timescale: TimescaleDialog, layout: LayoutDialog, pageSetup: PageSetupDialog,
};

const VIEWS: [ViewName, string, () => JSX.Element][] = [
  ['projects', 'Projects', Icon.projects], ['wbs', 'WBS', Icon.wbs], ['activities', 'Activities', Icon.activities],
  ['assignments', 'Assignments', Icon.assignments], ['resources', 'Resources', Icon.resources], ['reports', 'Reports', Icon.reports],
];

export function runMenu(id: string): void {
  const ui = getUi();
  const cmds = activityCommands();
  const needProject = () => { if (!ui.openProjects.length) { toast('Open a project first (Projects window, double-click).'); return true; } return false; };
  switch (id) {
    case 'file.new': return openDialog('newProject');
    case 'file.open': case 'project.projects': return setUi({ view: 'projects' });
    case 'file.closeAll': return setUi({ openProjects: [], selTasks: [], selTask: undefined, view: 'projects' });
    case 'file.import': return openDialog('import');
    case 'file.export': return openDialog('export');
    case 'file.pageSetup': return openDialog('pageSetup');
    case 'file.printPreview': case 'file.print': return void printView('print');
    case 'file.pdf': return void printView('pdf');
    case 'file.commit': return void saveNow().then(() => toast('Changes committed to the database'));
    case 'edit.undo': return doUndo();
    case 'edit.redo': return doRedo();
    case 'edit.add': return ui.view === 'wbs' ? cmds.addWbs() : cmds.add();
    case 'edit.delete': return void cmds.del();
    case 'edit.assignPred': return openDialog('assign', { which: 'pred' });
    case 'edit.assignSucc': return openDialog('assign', { which: 'succ' });
    case 'edit.assignRsrc': return openDialog('assignRsrc');
    case 'edit.assignCodes': return setUi({ detailTab: 'codes' });
    case 'edit.renumber': return toast('Renumber: edit Activity IDs in the table (F2).');
    case 'edit.preferences': return openDialog('prefs');
    case 'edit.selectAll': return void handleEditKey(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
    case 'edit.find': return document.querySelector<HTMLInputElement>('input[placeholder^="Find"]')?.focus();
    case 'view.columns': return openDialog('columns');
    case 'view.filters': return openDialog('filters');
    case 'view.groupSort': return openDialog('filters', { tab: 'group' });
    case 'view.timescale': return openDialog('timescale');
    case 'view.bars': return openDialog('timescale');
    case 'view.layout.open': case 'view.layout.save': case 'view.layout.saveAs': return openDialog('layout', { mode: id.split('.')[2] });
    case 'view.zoomIn': return setUi((u) => ({ pxPerDay: Math.min(60, u.pxPerDay * 1.6) }));
    case 'view.zoomOut': return setUi((u) => ({ pxPerDay: Math.max(0.15, u.pxPerDay / 1.6) }));
    case 'view.expandAll': return setUi({ collapsed: {} });
    case 'view.collapseAll': return setUi({ collapsed: Object.fromEntries(rows(getDb(), 'PROJWBS').filter((w) => w.proj_node_flag !== 'Y').map((w) => [`w:${w.wbs_id}`, true])) });
    case 'view.relLines': return setUi((u) => ({ relLines: !u.relLines }));
    case 'view.spotlight': return setUi({ filter: 'open' });
    case 'view.bottom.details': return setUi({ bottom: 'details' });
    case 'view.bottom.profile': case 'view.bottom.spreadsheet': return setUi({ view: 'assignments' });
    case 'view.bottom.none': return setUi({ bottom: 'none' });
    case 'project.wbs': return setUi({ view: 'wbs' });
    case 'project.activities': return setUi({ view: 'activities' });
    case 'project.assignments': return setUi({ view: 'assignments' });
    case 'project.expenses': return setUi({ view: 'activities', detailTab: 'expenses' });
    case 'project.details': return openDialog('projectDetails', {});
    case 'project.baselines': case 'project.assignBaselines': return openDialog('baselines', {});
    case 'ent.eps': return openDialog('eps');
    case 'ent.resources': return setUi({ view: 'resources' });
    case 'ent.roles': return openDialog('roles');
    case 'ent.obs': return openDialog('obs');
    case 'ent.codes': return openDialog('codes');
    case 'ent.udfs': return openDialog('udfs');
    case 'ent.calendars': return openDialog('calendars');
    case 'ent.accounts': return openDialog('accounts');
    case 'ent.currencies': return openDialog('currencies');
    case 'tools.schedule': return needProject() ? undefined : openDialog('schedule');
    case 'tools.level': return needProject() ? undefined : openDialog('level');
    case 'tools.progress': return needProject() ? undefined : openDialog('progress');
    case 'tools.applyActuals': return needProject() ? undefined : openDialog('progress');
    case 'tools.schedLog': return openDialog('log', { title: 'Schedule Log', text: ui.scheduleLog ?? '' });
    case 'tools.importLog': return openDialog('importLog', {});
    case 'tools.reports': return setUi({ view: 'reports' });
    case 'tools.validate': return void validateFileTool().then(() => getUi().importLog && openDialog('importLog', {}));
    case 'admin.preferences': return openDialog('prefs');
    case 'admin.reset': return void window.p6.confirm('Delete ALL projects and data from the clone database?', 'This cannot be undone.').then((ok) => { if (ok) { replaceDb(emptyDb()); setUi({ openProjects: [], view: 'projects' }); } });
    case 'help.about': return openDialog('about');
    default:
      if (id.startsWith('report.')) return setUi({ view: 'reports', detailTab: id.slice(7) });
      if (id.startsWith('view.top.')) return setUi({ view: 'activities' });
  }
}

function Toolbar() {
  const ui = useStore((s) => s.ui);
  useStore((s) => s.dbVersion);
  const b = (title: string, icon: () => JSX.Element, onClick: () => void, opts: { on?: boolean; disabled?: boolean; label?: string } = {}) => (
    <button className={`tbtn ${opts.on ? 'on' : ''}`} title={title} disabled={opts.disabled} onClick={onClick}>{icon()}{opts.label && <span className="lbl">{opts.label}</span>}</button>
  );
  const noProj = !ui.openProjects.length;
  return (
    <div className="toolbars">
      <div className="toolbar">
        {b('Open Project (Projects window)', Icon.open, () => runMenu('file.open'))}
        {b('Import', Icon.import, () => runMenu('file.import'))}
        {b('Export', Icon.export, () => runMenu('file.export'))}
        {b('Print', Icon.print, () => runMenu('file.print'))}
      </div>
      <div className="toolbar">
        {b(`Undo${undoLabel() ? ': ' + undoLabel() : ''}`, Icon.undo, doUndo)}
        {b('Redo', Icon.redo, doRedo)}
      </div>
      <div className="toolbar">
        {b('Add Activity (Insert)', Icon.add, () => runMenu('edit.add'), { disabled: noProj })}
        {b('Delete (Del)', Icon.del, () => runMenu('edit.delete'))}
        {b('Assign Predecessors', Icon.link, () => runMenu('edit.assignPred'), { disabled: !ui.selTask })}
      </div>
      <div className="toolbar">
        {b('Schedule (F9)', Icon.schedule, () => runMenu('tools.schedule'), { disabled: noProj, label: 'Schedule' })}
        {b('Level Resources', Icon.level, () => runMenu('tools.level'), { disabled: noProj })}
        {b('Update Progress', Icon.progress, () => runMenu('tools.progress'), { disabled: noProj })}
        {b('Maintain Baselines', Icon.baseline, () => runMenu('project.baselines'), { disabled: noProj })}
      </div>
      <div className="toolbar">
        {b('Columns', Icon.columns, () => runMenu('view.columns'))}
        {b('Filters', Icon.filter, () => runMenu('view.filters'))}
        {b('Group and Sort', Icon.group, () => runMenu('view.groupSort'))}
        {b('Relationship Lines', Icon.lines, () => runMenu('view.relLines'), { on: ui.relLines })}
        {b('Zoom In', Icon.zoomIn, () => runMenu('view.zoomIn'))}
        {b('Zoom Out', Icon.zoomOut, () => runMenu('view.zoomOut'))}
        {b('Expand All', Icon.expand, () => runMenu('view.expandAll'))}
        {b('Collapse All', Icon.collapse, () => runMenu('view.collapseAll'))}
      </div>
      <div className="toolbar" style={{ borderRight: 'none' }}>
        {b('Validate an XER/XML file without importing', Icon.validate, () => runMenu('tools.validate'), { label: 'Validate File' })}
      </div>
    </div>
  );
}

export function App() {
  const ui = useStore((s) => s.ui);
  const db = useStore((s) => s.db);
  useStore((s) => s.dbVersion);

  useEffect(() => {
    window.p6.onMenu(runMenu);
    loadFromDisk().then(async () => {
      const f = await window.p6.startupImport();
      if (f) openDialog('import', { preload: f });
    });
    const k = (e: KeyboardEvent) => {
      if (e.key === 'F9' && !e.shiftKey) { e.preventDefault(); runMenu('tools.schedule'); return; }
      if (handleEditKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', k);
    const beforeUnload = () => { void saveNow(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);

  const open = ui.openProjects.map((id) => rows(db, 'PROJECT').find((p) => p.proj_id === id)).filter((p) => p != null);
  const title = { projects: 'Projects', wbs: 'WBS', activities: 'Activities', assignments: 'Resource Assignments', resources: 'Resources', reports: 'Reports' }[ui.view];
  const View = { projects: ProjectsView, wbs: WbsView, activities: ActivitiesView, assignments: AssignmentsView, resources: ResourcesView, reports: ReportsView }[ui.view];
  const p0 = open[0];
  const dlg = ui.dialogs[ui.dialogs.length - 1];
  const Dlg = dlg ? DIALOGS[dlg.kind] : null;
  return (
    <div className="app">
      <Toolbar />
      <div className="body">
        <div className="dirbar">
          {VIEWS.map(([v, l, ic]) => <div key={v} className={`dirbtn ${ui.view === v ? 'on' : ''}`} onClick={() => setUi({ view: v })}>{ic()}<span>{l}</span></div>)}
        </div>
        <div className="workspace">
          <div className="wintitle">
            <span>{title}</span>
            {p0 && ui.view !== 'projects' && ui.view !== 'resources' && <span className="sub">{open.map((p) => `${p.proj_short_name} - ${projectName(db, p)}`).join('; ')}</span>}
          </div>
          <div className="winbody"><View /></div>
        </div>
      </div>
      <div className="statusbar">
        <div>Portfolio: All Projects</div>
        <div>Access Mode: Shared</div>
        <div>Data Date: {p0 ? fmtDate(p0.last_recalc_date, ui.prefs, true) : ''}</div>
        <div>Baseline: {p0?.sum_base_proj_id ? 'Project Baseline' : 'Current Project'}</div>
        <div>User: admin</div>
        <div>DB: P6CLONE (local)</div>
        <div style={{ flex: 1, borderRight: 'none' }}>{rows(db, 'PROJECT').filter((p) => !p._baseline_of).length} projects in database</div>
      </div>
      {Dlg && <Dlg {...(dlg.props ?? {})} />}
      {ui.toast && <div className="toast" onClick={() => setUi({ toast: undefined })}>{ui.toast}</div>}
      <ContextMenuHost />
    </div>
  );
}

export { openProjects, closeDialog, runSchedule };
