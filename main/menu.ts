import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

type Item = MenuItemConstructorOptions;

/** P6 Professional-style menu bar. Each command is forwarded to the renderer as a 'menu' event. */
export function buildMenu(win: BrowserWindow): Menu {
  const cmd = (label: string, id: string, accelerator?: string, extra: Partial<Item> = {}): Item =>
    ({ label, id, accelerator, click: () => win.webContents.send('menu', id), ...extra });
  const sep: Item = { type: 'separator' };

  const template: Item[] = [
    {
      label: '&File', submenu: [
        cmd('&New...', 'file.new', 'Ctrl+N'),
        cmd('&Open...', 'file.open', 'Ctrl+O'),
        cmd('&Close All', 'file.closeAll'),
        sep,
        cmd('&Import...', 'file.import'),
        cmd('&Export...', 'file.export'),
        sep,
        cmd('Page Set&up...', 'file.pageSetup'),
        cmd('Print Pre&view', 'file.printPreview'),
        cmd('&Print...', 'file.print', 'Ctrl+P'),
        cmd('Save as P&DF...', 'file.pdf'),
        sep,
        cmd('Commit Changes', 'file.commit', 'F10'),
        sep,
        { label: 'E&xit', role: 'quit' },
      ],
    },
    {
      label: '&Edit', submenu: [
        // These shortcuts must keep working inside text fields, so the renderer handles the keys itself.
        cmd('&Undo', 'edit.undo', 'Ctrl+Z', { registerAccelerator: false }),
        cmd('&Redo', 'edit.redo', 'Ctrl+Y', { registerAccelerator: false }),
        sep,
        cmd('Cu&t', 'edit.cut', 'Ctrl+X', { registerAccelerator: false }),
        cmd('&Copy', 'edit.copy', 'Ctrl+C', { registerAccelerator: false }),
        cmd('&Paste', 'edit.paste', 'Ctrl+V', { registerAccelerator: false }),
        sep,
        cmd('&Add', 'edit.add', 'Insert', { registerAccelerator: false }),
        cmd('&Delete', 'edit.delete', 'Delete', { registerAccelerator: false }),
        cmd('Dissol&ve', 'edit.dissolve'),
        cmd('Re&number Activity IDs...', 'edit.renumber'),
        cmd('&Link Activities', 'edit.link'),
        cmd('F&ill Down', 'edit.fillDown', 'Ctrl+E', { registerAccelerator: false }),
        sep,
        cmd('Assign', 'edit.assign', undefined, { submenu: [cmd('Predecessors...', 'edit.assignPred'), cmd('Successors...', 'edit.assignSucc'), cmd('Resources...', 'edit.assignRsrc'), cmd('Activity Codes...', 'edit.assignCodes')] }),
        sep,
        cmd('Select &All', 'edit.selectAll', 'Ctrl+A', { registerAccelerator: false }),
        cmd('&Find...', 'edit.find', 'Ctrl+F'),
        cmd('Find &Next', 'edit.findNext', 'F3', { registerAccelerator: false }),
        cmd('User &Preferences...', 'edit.preferences'),
        cmd('AI Assistant Se&ttings...', 'edit.aiSettings'),
      ],
    },
    {
      label: '&View', submenu: [
        cmd('&Layout', 'view.layout', undefined, { submenu: [cmd('&Open...', 'view.layout.open'), cmd('&Save', 'view.layout.save'), cmd('Save &As...', 'view.layout.saveAs')] }),
        sep,
        cmd('Show on &Top', 'view.top', undefined, { submenu: [cmd('Activity Table', 'view.top.table'), cmd('Gantt Chart', 'view.top.gantt'), cmd('Activity Usage Profile', 'view.top.profile')] }),
        cmd('Show on &Bottom', 'view.bottom', undefined, { submenu: [cmd('Activity Details', 'view.bottom.details'), cmd('Resource Usage Profile', 'view.bottom.profile'), cmd('Resource Usage Spreadsheet', 'view.bottom.spreadsheet'), cmd('No Bottom Layout', 'view.bottom.none')] }),
        sep,
        cmd('&Columns...', 'view.columns'),
        cmd('&Bars...', 'view.bars'),
        cmd('&Filters...', 'view.filters'),
        cmd('&Group and Sort...', 'view.groupSort'),
        cmd('&Timescale...', 'view.timescale'),
        sep,
        cmd('&Zoom', 'view.zoom', undefined, { submenu: [cmd('Zoom &In', 'view.zoomIn', 'Ctrl+=', { registerAccelerator: false }), cmd('Zoom &Out', 'view.zoomOut', 'Ctrl+-', { registerAccelerator: false })] }),
        cmd('E&xpand All', 'view.expandAll', 'Ctrl+Shift+=', { registerAccelerator: false }),
        cmd('C&ollapse All', 'view.collapseAll', 'Ctrl+Shift+-', { registerAccelerator: false }),
        sep,
        cmd('Relationship &Lines', 'view.relLines'),
        cmd('&Progress Spotlight', 'view.spotlight'),
        cmd('AI &Assistant', 'view.ai', 'Ctrl+Shift+A', { registerAccelerator: false }),
        sep,
        { label: 'Reload', role: 'reload', accelerator: 'Ctrl+R' },
        { label: 'Developer Tools', role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' },
      ],
    },
    {
      label: '&Project', submenu: [
        cmd('&Projects', 'project.projects'),
        cmd('&WBS', 'project.wbs'),
        cmd('&Activities', 'project.activities'),
        cmd('&Resource Assignments', 'project.assignments'),
        cmd('&Expenses', 'project.expenses'),
        sep,
        cmd('&Details...', 'project.details'),
        sep,
        cmd('Maintain &Baselines...', 'project.baselines'),
        cmd('Assig&n Baselines...', 'project.assignBaselines'),
        sep,
        cmd('Ris&ks...', 'project.risks'),
      ],
    },
    {
      label: 'E&nterprise', submenu: [
        cmd('&Projects', 'project.projects'),
        cmd('&Enterprise Project Structure...', 'ent.eps'),
        sep,
        cmd('&Resources', 'ent.resources'),
        cmd('R&oles...', 'ent.roles'),
        cmd('&OBS...', 'ent.obs'),
        sep,
        cmd('&Activity Codes...', 'ent.codes'),
        cmd('&User Defined Fields...', 'ent.udfs'),
        cmd('&Calendars...', 'ent.calendars'),
        cmd('Cost Acco&unts...', 'ent.accounts'),
        cmd('Curre&ncies...', 'ent.currencies'),
        sep,
        cmd('Project Por&tfolios...', 'ent.portfolios'),
      ],
    },
    {
      label: '&Tools', submenu: [
        cmd('&Schedule...', 'tools.schedule', 'F9'),
        cmd('&Level Resources...', 'tools.level', 'Shift+F9'),
        cmd('&Update Progress...', 'tools.progress'),
        cmd('Apply &Actuals', 'tools.applyActuals'),
        cmd('&Timesheet Approval', 'tools.timesheets'),
        cmd('Schedule &Risk Analysis...', 'tools.riskAnalysis'),
        sep,
        cmd('Schedule &Log', 'tools.schedLog'),
        cmd('&Import Log', 'tools.importLog'),
        sep,
        cmd('&Reports', 'tools.reports', undefined, { submenu: [cmd('&Reports...', 'tools.reports'), cmd('Schedule Report', 'report.schedule'), cmd('Critical Activities', 'report.critical'), cmd('Resource Assignments', 'report.assignments'), cmd('Cost by WBS', 'report.costWbs'), cmd('Cost by Cost Account', 'report.costAccount')] }),
        sep,
        cmd('Validate XER File...', 'tools.validate'),
      ],
    },
    {
      label: '&Admin', submenu: [
        cmd('&Admin Preferences...', 'admin.preferences'),
        cmd('&Timesheet Dates...', 'tools.timesheets'),
        cmd('Reset &Database...', 'admin.reset'),
      ],
    },
    {
      label: '&Help', submenu: [
        cmd('&About P6 Clone', 'help.about'),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
