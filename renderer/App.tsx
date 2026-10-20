import { useEffect, type JSX } from 'react';
import { Icon } from './components/Icons.tsx';
import { ContextMenuHost, DialogTop } from './components/Layout.tsx';
import { closeDialog, doRedo, doUndo, getDb, getUi, loadFromDisk, mutate, openDialog, replaceDb, saveNow, setUi, toast, useStore, undoLabel, type ViewName } from './store.ts';
import { activityCommands, handleEditKey, runSchedule, copyActivities, cutActivities, pasteActivities, renumberActivities, dissolveSelected, linkSelected } from './commands.ts';
import { ActivitiesView, fillDown } from './views/ActivitiesView.tsx';
import { ProjectsView, openProjects } from './views/ProjectsView.tsx';
import { WbsView } from './views/WbsView.tsx';
import { ResourcesView } from './views/ResourcesView.tsx';
import { AssignmentsView } from './views/AssignmentsView.tsx';
import { ReportsView } from './views/ReportsView.tsx';
import { RiskView } from './views/RiskView.tsx';
import { ExtensionsView } from './views/ExtensionsView.tsx';
import { CheckScheduleDialog } from './dialogs/CheckScheduleDialog.tsx';
import { TimesheetsView } from './views/TimesheetsView.tsx';
import { PortfoliosView } from './views/PortfoliosView.tsx';
import { applyApprovedTimesheets, formatApplySummary, hasPendingActuals } from '../core/timesheet/timesheet.ts';
import { ImportWizard, ExportWizard } from './dialogs/Wizards.tsx';
import { BarsDialog } from './dialogs/BarsDialog.tsx';
import { FindDialog, findNext } from './dialogs/FindDialog.tsx';
import { AiSettingsDialog } from './dialogs/AiSettingsDialog.tsx';
import { AssistantPanel } from './ai/AssistantPanel.tsx';
import { initLive } from './ai/live.ts';
import { ScheduleDialog, ScheduleOptionsDialog, UpdateProgressDialog } from './dialogs/ScheduleDialogs.tsx';
import { NewProjectDialog, ProjectDetailsDialog, DeleteProjectDialog, BaselinesDialog, AssignBaselinesDialog, EpsDialog } from './dialogs/ProjectDialogs.tsx';
import { ColumnsDialog, LogDialog, ImportLogDialog, AssignDialog, AssignResourceDialog, PreferencesDialog, AboutDialog, validateFileTool } from './dialogs/CommonDialogs.tsx';
import { CalendarsDialog, CodesDialog, UdfDialog, ObsDialog, AccountsDialog, RolesDialog, CurrenciesDialog, LevelDialog, FiltersDialog, FilterEditDialog, TimescaleDialog, LayoutDialog, BUILTIN_LAYOUT, BUILTIN_LAYOUTS, saveLayout, layoutFromUi } from './dialogs/EnterpriseDialogs.tsx';
import { emptyDb, rows } from '../core/db.ts';
import { fmtDate, projectName } from './model.ts';
import { printView } from './print.ts';
import { exportExcel, importExcel } from './excel.ts';
import { PageSetupDialog } from './dialogs/PageSetupDialog.tsx';
import { RunReportDialog, ReportWizardDialog } from './dialogs/ReportDialogs.tsx';
import { GlobalChangeDialog, GlobalChangeEditDialog, GlobalChangeReportDialog, CodeDictionaryDialog } from './dialogs/GlobalChangeDialogs.tsx';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DIALOGS: Record<string, (p: any) => JSX.Element> = {
  import: ImportWizard, export: ExportWizard, schedule: ScheduleDialog, schedOptions: ScheduleOptionsDialog, progress: UpdateProgressDialog,
  newProject: NewProjectDialog, projectDetails: ProjectDetailsDialog, deleteProject: DeleteProjectDialog, baselines: BaselinesDialog, eps: EpsDialog,
  columns: ColumnsDialog, log: LogDialog, importLog: ImportLogDialog, assign: AssignDialog, assignRsrc: AssignResourceDialog, prefs: PreferencesDialog, about: AboutDialog,
  calendars: CalendarsDialog, codes: CodesDialog, udfs: UdfDialog, obs: ObsDialog, accounts: AccountsDialog, roles: RolesDialog, currencies: CurrenciesDialog,
  level: LevelDialog, filters: FiltersDialog, filterEdit: FilterEditDialog, timescale: TimescaleDialog, bars: BarsDialog, find: FindDialog, globalChange: GlobalChangeDialog, globalChangeEdit: GlobalChangeEditDialog, globalChangeReport: GlobalChangeReportDialog, codeDictionary: CodeDictionaryDialog, runReport: RunReportDialog, reportWizard: ReportWizardDialog, aiSettings: AiSettingsDialog, assignBaselines: AssignBaselinesDialog, layout: LayoutDialog, pageSetup: PageSetupDialog, checkSchedule: CheckScheduleDialog,
};

const VIEWS: [ViewName, string, () => JSX.Element][] = [
  ['projects', 'Projects', Icon.projects], ['wbs', 'WBS', Icon.wbs], ['activities', 'Activities', Icon.activities],
  ['assignments', 'Assignments', Icon.assignments], ['resources', 'Resources', Icon.resources], ['timesheets', 'Timesheets', Icon.timesheets],
  ['risk', 'Risks', Icon.risk], ['portfolios', 'Portfolios', Icon.portfolios], ['reports', 'Reports', Icon.reports],
  ['extensions', 'Extensions', Icon.extensions],
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
    case 'file.exportXlsx': return void exportExcel();
    case 'file.importXlsx': return void importExcel();
    case 'file.pageSetup': return openDialog('pageSetup');
    case 'file.printPreview': return void printView('preview');
    case 'file.print': return void printView('print');
    case 'file.pdf': return void printView('pdf');
    case 'file.commit': return void saveNow().then(() => toast('Changes committed to the database'));
    case 'edit.undo': return doUndo();
    case 'edit.redo': return doRedo();
    case 'edit.copy': return copyActivities();
    case 'edit.paste': return pasteActivities();
    case 'edit.cut': return void cutActivities();
    case 'edit.dissolve': return void dissolveSelected();
    case 'edit.add': return cmds.add();
    case 'edit.delete': return void cmds.del();
    case 'edit.assignPred': return openDialog('assign', { which: 'pred' });
    case 'edit.assignSucc': return openDialog('assign', { which: 'succ' });
    case 'edit.assignRsrc': return openDialog('assignRsrc');
    case 'edit.assignCodes': return setUi({ detailTab: 'codes' });
    case 'edit.renumber': return void renumberActivities();
    case 'edit.link': return linkSelected();
    case 'edit.fillDown': return fillDown();
    case 'edit.findNext': return ui.openProjects.length ? findNext() : toast('Open a project first.');
    case 'edit.preferences': return openDialog('prefs');
    case 'edit.selectAll': return void handleEditKey(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
    case 'edit.aiSettings': return openDialog('aiSettings');
    case 'view.ai': return void window.p6.aiGetConfig().then((c) => (c.enabled ? setUi((u) => ({ aiOpen: !u.aiOpen })) : openDialog('aiSettings')));
    case 'edit.find': return ui.openProjects.length ? openDialog('find') : toast('Open a project first.');
    case 'view.columns': return openDialog('columns');
    case 'view.filters': return openDialog('filters');
    case 'view.groupSort': return openDialog('filters', { tab: 'group' });
    case 'view.timescale': return openDialog('timescale');
    case 'view.bars': return openDialog('bars');
    case 'view.layout.save':
      if (ui.layoutName && !(ui.layoutName in BUILTIN_LAYOUTS)) { saveLayout(ui.layoutName, layoutFromUi(getUi())); return toast(`Layout "${ui.layoutName}" saved`); }
      return openDialog('layout', { mode: 'saveAs' });
    case 'view.layout.open': case 'view.layout.saveAs': return openDialog('layout', { mode: id.split('.')[2] });
    case 'view.zoomIn': return setUi((u) => ({ pxPerDay: Math.min(60, u.pxPerDay * 1.6) }));
    case 'view.zoomOut': return setUi((u) => ({ pxPerDay: Math.max(0.15, u.pxPerDay / 1.6) }));
    case 'view.expandAll': return setUi({ collapsed: {} });
    case 'view.collapseAll': return setUi({ collapsed: Object.fromEntries(rows(getDb(), 'PROJWBS').filter((w) => w.proj_node_flag !== 'Y').map((w) => [`w:${w.wbs_id}`, true])) });
    case 'view.relLines': return setUi((u) => ({ relLines: !u.relLines }));
    case 'view.spotlight': return setUi((u) => ({ spotlight: !u.spotlight }));
    case 'view.bottom.details': return setUi({ bottom: 'details' });
    case 'view.bottom.profile': return setUi({ bottom: 'profile', view: 'activities' });
    case 'view.bottom.spreadsheet': return setUi({ bottom: 'spreadsheet', view: 'activities' });
    case 'view.bottom.trace': return setUi({ bottom: 'trace', view: 'activities' });
    case 'view.bottom.none': return setUi({ bottom: 'none' });
    case 'project.wbs': return setUi({ view: 'wbs' });
    case 'project.activities': return setUi({ view: 'activities' });
    case 'project.assignments': return setUi({ view: 'assignments' });
    case 'project.expenses': return setUi({ view: 'activities', detailTab: 'expenses' });
    case 'project.details': return openDialog('projectDetails', {});
    case 'project.baselines': return openDialog('baselines', {});
    case 'project.assignBaselines': return openDialog('assignBaselines', {});
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
    case 'tools.applyActuals': {
      if (needProject()) return;
      if (!hasPendingActuals(getDb(), ui.openProjects)) return toast('No approved timesheet hours to apply. Use Tools > Timesheet Approval.');
      let msg = '';
      mutate('Apply Actuals', (d) => { msg = formatApplySummary(applyApprovedTimesheets(d, ui.openProjects)); });
      return toast(msg);
    }
    case 'tools.timesheets': return setUi({ view: 'timesheets' });
    case 'project.risks': case 'tools.riskAnalysis': return setUi({ view: 'risk' });
    case 'ent.portfolios': return setUi({ view: 'portfolios' });
    case 'tools.checkSchedule': return needProject() ? undefined : openDialog('checkSchedule');
    case 'tools.extensions': return setUi({ view: 'extensions' });
    case 'tools.schedLog': return openDialog('log', { title: 'Schedule Log', text: ui.scheduleLog ?? '' });
    case 'tools.importLog': return openDialog('importLog', {});
    case 'tools.reports': return setUi({ view: 'reports' });
    case 'tools.globalChange': return openDialog('globalChange');
    case 'ent.projectCodes': return openDialog('codeDictionary', { kind: 'project' });
    case 'ent.resourceCodes': return openDialog('codeDictionary', { kind: 'resource' });
    case 'tools.reportWizard': setUi({ view: 'reports' }); return openDialog('reportWizard', {});
    case 'tools.validate': return void validateFileTool().then(() => getUi().importLog && openDialog('importLog', {}));
    case 'admin.preferences': return openDialog('prefs');
    case 'admin.reset': return void window.p6.confirm('Delete ALL projects and data from the clone database?', 'This cannot be undone.').then((ok) => { if (ok) { replaceDb(emptyDb()); setUi({ openProjects: [], view: 'projects' }); } });
    case 'help.about': return openDialog('about');
    default:
      if (id.startsWith('report.')) return setUi({ view: 'reports', detailTab: id.slice(7) });
      if (id === 'view.top.table') return setUi((u) => ({ view: 'activities', hideTable: !u.hideTable, hideGantt: u.hideTable ? u.hideGantt : false }));
      if (id === 'view.top.gantt') return setUi((u) => ({ view: 'activities', hideGantt: !u.hideGantt, hideTable: u.hideGantt ? u.hideTable : false }));
      if (id === 'view.top.profile') return setUi({ view: 'activities', bottom: 'profile' });
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
    void initLive(runMenu);
    loadFromDisk().then(async () => {
      const f = await window.p6.startupImport();
      if (f) openDialog('import', { preload: f });
    });
    const k = (e: KeyboardEvent) => {
      if (e.key === 'F9' && !e.shiftKey) { e.preventDefault(); runMenu('tools.schedule'); return; }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); runMenu('view.ai'); return; }
      // Ctrl + plus/minus (main keyboard or numpad): zoom the timescale; with Shift: expand/collapse all
      if (e.ctrlKey && !e.altKey && !getUi().dialogs.length) {
        const plus = e.key === '=' || e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal';
        const minus = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' || e.code === 'Minus';
        if (plus || minus) { e.preventDefault(); runMenu(e.shiftKey && !e.code.startsWith('Numpad') ? (plus ? 'view.expandAll' : 'view.collapseAll') : (plus ? 'view.zoomIn' : 'view.zoomOut')); return; }
      }
      // Ctrl+E Fill Down and F3 Find Next act on the table (not while typing in a field or a dialog is open)
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"]');
      if (!typing && !getUi().dialogs.length && ((e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'e') || e.key === 'F3')) { e.preventDefault(); runMenu(e.key === 'F3' ? 'edit.findNext' : 'edit.fillDown'); return; }
      if (handleEditKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', k);
    const beforeUnload = () => { void saveNow(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);

  const open = ui.openProjects.map((id) => rows(db, 'PROJECT').find((p) => p.proj_id === id)).filter((p) => p != null);
  const title = { projects: 'Projects', wbs: 'WBS', activities: 'Activities', assignments: 'Resource Assignments', resources: 'Resources', reports: 'Reports', risk: 'Risks', timesheets: 'Timesheets', portfolios: 'Project Portfolios', extensions: 'Extensions' }[ui.view];
  const View = { projects: ProjectsView, wbs: WbsView, activities: ActivitiesView, assignments: AssignmentsView, resources: ResourcesView, reports: ReportsView, risk: RiskView, timesheets: TimesheetsView, portfolios: PortfoliosView, extensions: ExtensionsView }[ui.view];
  const p0 = open[0];
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
          <AssistantPanel />
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
      {/* every dialog in the stack stays mounted (a wizard keeps its state under the dialog it opened); only the top one reacts to Esc */}
      {ui.dialogs.map((d, i) => { const D = DIALOGS[d.kind]; return D ? <DialogTop.Provider key={i} value={i === ui.dialogs.length - 1}><D {...(d.props ?? {})} /></DialogTop.Provider> : null; })}
      {ui.toast && <div className="toast" onClick={() => setUi({ toast: undefined })}>{ui.toast}</div>}
      <ContextMenuHost />
    </div>
  );
}

export { openProjects, closeDialog, runSchedule };
