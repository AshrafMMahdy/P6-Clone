// The assistant operating the app in front of the user, like remote control: a cursor glides to what it clicks,
// menus open on screen with the chosen item highlighted, typing appears character by character. Every change goes
// through the normal undoable edit path (Ctrl+Z), and deletions ask first.
import type { ToolDef } from '../../core/query/tools.ts';
import { applyOps, OP_GUIDE, OP_NAMES } from '../../core/project/ops.ts';
import { rows } from '../../core/db.ts';
import { doUndo, getDb, getUi, mutate, setUi } from '../store.ts';
import { currentPrint, savePageSetup } from '../print.ts';
import { printableColumns } from '../print/schedule.ts';
import { PRINT_GUIDE } from '../print/layout.ts';
import { listReports, parseSpec, runReport, SUBJECTS, subjectColumns, reportFilters } from '../reports/engine.ts';
import { openDialog } from '../store.ts';

export interface MenuNode { label: string; id?: string; accelerator?: string; submenu?: MenuNode[] }
let menuTree: MenuNode[] = [];
/** Projects the assistant created this session (lower-case IDs): its own work, edited without delete prompts. */
const aiCreated = new Set<string>();
let run: (id: string) => void = () => {};
/** App wiring: the menu tree (from the main process) and the command runner. */
export async function initLive(runMenu: (id: string) => void): Promise<void> {
  run = runMenu;
  try { menuTree = (await window.p6.menuTree()) as MenuNode[]; } catch { menuTree = []; }
}
/** The menu bar as text, for the assistant's instructions ("Tools > Schedule... (F9)"). */
export function menuGuide(): string {
  const out: string[] = [];
  const walk = (ns: MenuNode[], path: string[]) => { for (const n of ns) { const p = [...path, n.label]; if (n.submenu?.length) walk(n.submenu, p); else out.push(`${p.join(' > ')}${n.accelerator ? ` (${n.accelerator})` : ''}`); } };
  walk(menuTree, []);
  return out.join('\n');
}

export const LIVE_TOOLS: ToolDef[] = [
  { name: 'ui_menu', description: 'Choose a menu command on screen, exactly as the user would (the menu opens visibly and the item is clicked). path like "Tools > Schedule..." or "View > Zoom > Zoom In". Use the menu list in your instructions.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'ui_click', description: 'Click a visible button or tab by its text or tooltip (dialog buttons such as "Schedule" or "OK", toolbar buttons such as "Zoom In", window buttons on the left such as "Activities", detail tabs such as "Relationships"). The cursor moves there on screen.', parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'ui_type', description: 'Type text into a field of the open dialog, found by its label (e.g. "Current Data Date"). The text appears as if typed.', parameters: { type: 'object', properties: { field: { type: 'string' }, text: { type: 'string' } }, required: ['field', 'text'] } },
  { name: 'ui_screen', description: 'What is on screen now: the window, the open dialog with its fields and buttons, the selected activity. Use it to decide the next click.', parameters: { type: 'object', properties: {} } },
  { name: 'select_activity', description: 'Select an activity in the Activities window and scroll it into view.', parameters: { type: 'object', properties: { activity_id: { type: 'string' } }, required: ['activity_id'] } },
  { name: 'edit_project', description: 'Change the open project, or create a new one, with JSON operations. Each call is one undoable step (all or nothing: if one operation fails nothing changes and the error names it); changed activities are selected so the user sees them; deleting asks the user first. A batch that starts with add_project (or copy_project) creates that project and opens it on screen; later operations in the batch and later calls go to it. Build big schedules in several calls (about one WBS area, 30-60 operations, per call).\n' + OP_GUIDE, parameters: { type: 'object', properties: { operations: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: OP_NAMES } }, required: ['op'] } } }, required: ['operations'] } },
  { name: 'set_print_options', description: 'Change File > Page Setup for printing / PDF of the Activities layout (saved; the user then prints or saves). Returns the settings, the page count and the printable column ids. Afterwards open File > Print Preview, or File > Print... / File > Save as PDF... so the user can press Print or Save themselves.\n' + PRINT_GUIDE, parameters: { type: 'object', properties: { settings: { type: 'object' } }, required: ['settings'] } },
  { name: 'list_reports', description: 'The reports in Tools > Reports (P6 standard reports by group, and the user\'s own), with ids.', parameters: { type: 'object', properties: {} } },
  { name: 'open_report', description: 'Show a report in the Reports window (the user sees it selected and previewed) and return its columns and rows so you can read and explain it. report: id or name from list_reports.', parameters: { type: 'object', properties: { report: { type: 'string' }, weeks: { type: 'number', description: 'lookahead weeks (Lookahead report)' }, max_rows: { type: 'number' } }, required: ['report'] } },
  { name: 'create_report', description: 'Create a report with the Report Wizard ON SCREEN, step by step, so the user watches each page (subject area, columns, filter, group and sort, title) and you click Next and Finish. subject: activities | assignments | wbs | resources | relationships. columns: ids (activities: any activity column id such as task_code, task_name, start, finish, total_float, ev_bac, ev_pv, ev_ev, ev_spi, ev_cpi; other subjects: call with an empty columns list to see the defaults). filter: all, critical, longest, notstarted, inprogress, completed, open, milestones, negfloat, late, constrained, started30, finished30, starting30, finishing30, nopreds, or user:<id>. group_by: activities wbs|none; assignments resource|activity|none; resources none|type; relationships none|pred. sort_by: a column id; sort_desc. Saved in "My Reports".', parameters: { type: 'object', properties: { name: { type: 'string' }, subject: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } }, filter: { type: 'string' }, group_by: { type: 'string' }, sort_by: { type: 'string' }, sort_desc: { type: 'boolean' }, title: { type: 'string' }, group: { type: 'string' } }, required: ['name', 'subject'] } },
  { name: 'run_report_dialog', description: 'Open the Run Report dialog for a report with the output chosen: preview (Print Preview), printer, pdf, html, text (ASCII/CSV) or excel. For preview you may then ui_click "OK"; for printer and files the user presses OK and chooses where to save.', parameters: { type: 'object', properties: { report: { type: 'string' }, output: { type: 'string' } }, required: ['report', 'output'] } },
  { name: 'undo', description: 'Undo the last change (Edit > Undo).', parameters: { type: 'object', properties: {} } },
];

// ---- on-screen cursor
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cursor: HTMLDivElement | null = null;
function cur(): HTMLDivElement {
  if (cursor && document.body.contains(cursor)) return cursor;
  cursor = document.createElement('div');
  cursor.className = 'ai-cursor';
  cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 2 L2 18 L6.5 13.5 L10 20.5 L13 19 L9.5 12.5 L16 12.5 Z" fill="#fff" stroke="#1a3d7c" stroke-width="1.6"/></svg><span>AI</span>';
  cursor.style.left = `${window.innerWidth - 300}px`; cursor.style.top = `${window.innerHeight - 120}px`;
  document.body.appendChild(cursor);
  return cursor;
}
async function moveTo(el: Element): Promise<void> {
  const r = el.getBoundingClientRect(), c = cur();
  c.classList.add('on');
  c.style.left = `${r.left + Math.min(r.width / 2, 40)}px`; c.style.top = `${r.top + r.height / 2}px`;
  await sleep(520);
}
async function clickEl(el: HTMLElement): Promise<void> {
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  await moveTo(el);
  el.classList.add('ai-press');
  const ring = document.createElement('div'); ring.className = 'ai-ripple';
  const c = cur(); ring.style.left = c.style.left; ring.style.top = c.style.top; document.body.appendChild(ring);
  await sleep(180);
  el.click();
  setTimeout(() => { el.classList.remove('ai-press'); ring.remove(); }, 450);
  await sleep(350);
}
const hideSoon = () => setTimeout(() => cursor?.classList.remove('on'), 2500);

// ---- a menu shown on screen (native menus cannot be opened by a script, so the clone draws one)
async function showMenu(path: string[]): Promise<void> {
  const box = document.createElement('div'); box.className = 'ai-menu';
  let x0 = 0; // left of the chosen top-level title
  const layer = (items: MenuNode[], pick: string, depth: number) => {
    const col = document.createElement('div'); col.className = 'ai-menu-col'; col.style.left = `${x0 + depth * 210}px`;
    for (const n of items) { const d = document.createElement('div'); d.textContent = n.label + (n.submenu ? '  ›' : n.accelerator ? `   ${n.accelerator}` : ''); if (n.label === pick) d.className = 'pick'; col.appendChild(d); }
    box.appendChild(col);
  };
  const bar = document.createElement('div'); bar.className = 'ai-menu-bar';
  for (const m of menuTree) { const t = document.createElement('span'); t.textContent = m.label; if (m.label === path[0]) t.className = 'pick'; bar.appendChild(t); }
  box.appendChild(bar);
  document.body.appendChild(box);
  let items = menuTree;
  for (let i = 0; i < path.length; i++) {
    const n = items.find((x) => x.label === path[i]);
    if (!n) break;
    if (i === 0) { const t = [...bar.children].find((c) => c.textContent === n.label) as HTMLElement | undefined; x0 = t?.offsetLeft ?? 0; await moveTo(t ?? bar); items = n.submenu ?? []; continue; }
    layer(items, path[i], i - 1);
    await sleep(380);
    items = n.submenu ?? [];
  }
  if (path.length === 1) layer(menuTree.find((m) => m.label === path[0])?.submenu ?? [], '', 0);
  await sleep(420);
  box.remove();
}

// ---- finding things on screen
const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').replace(/[.…]+$/, '').trim().toLowerCase();
function findClickable(target: string): HTMLElement | null {
  const t = norm(target);
  const dlgs = [...document.querySelectorAll<HTMLElement>('.dialog')];
  const scope: ParentNode = dlgs.length ? dlgs[dlgs.length - 1] : document;
  const pool = [...scope.querySelectorAll<HTMLElement>('button, .tab, .dirbtn, .tbtn, .ctxmenu > div, a, label')].filter(visible);
  return pool.find((e) => norm(e.textContent) === t || norm(e.title) === t) ?? pool.find((e) => norm(e.textContent).startsWith(t) || norm(e.title).startsWith(t)) ?? null;
}
function findField(label: string): HTMLInputElement | HTMLSelectElement | null {
  const t = norm(label);
  const dlgs = [...document.querySelectorAll<HTMLElement>('.dialog')];
  const scope: ParentNode = dlgs.length ? dlgs[dlgs.length - 1] : document;
  for (const el of scope.querySelectorAll<HTMLElement>('label, td, th, span, div')) {
    if (el.children.length > 3 || !norm(el.textContent).startsWith(t)) continue;
    const input = el.querySelector<HTMLInputElement>('input, select') ?? (el.nextElementSibling?.querySelector?.('input, select') as HTMLInputElement | null) ?? (el.tagName === 'TD' ? (el.parentElement?.querySelector('td:nth-child(2) input, td:nth-child(2) select') as HTMLInputElement | null) : null);
    if (input && visible(input)) return input;
  }
  return null;
}
function screen(): unknown {
  const ui = getUi();
  const dlgs = [...document.querySelectorAll<HTMLElement>('.dialog')];
  const d = dlgs[dlgs.length - 1];
  const sel = ui.selTask ? rows(getDb(), 'TASK').find((t) => t.task_id === ui.selTask) : undefined;
  return {
    window: ui.view, open_projects: ui.openProjects.length, selected_activity: sel ? `${sel.task_code} ${sel.task_name}` : null,
    dialog: d ? {
      title: d.querySelector('.dialog-title span')?.textContent,
      buttons: [...d.querySelectorAll('button')].filter(visible).map((b) => b.textContent?.trim()).filter(Boolean),
      tabs: [...d.querySelectorAll('.tab')].map((b) => b.textContent?.trim()),
      fields: [...d.querySelectorAll('label, tr')].filter((l) => l.querySelector('input, select')).slice(0, 30).map((l) => ({ label: norm(l.textContent).slice(0, 60), value: (l.querySelector('input, select') as HTMLInputElement).type === 'checkbox' ? (l.querySelector('input') as HTMLInputElement).checked : (l.querySelector('input, select') as HTMLInputElement).value })),
    } : null,
    toolbar: [...document.querySelectorAll<HTMLElement>('.toolbar .tbtn, .tbar .tbtn')].map((b) => b.title).filter(Boolean),
  };
}

/** Run one live tool. Returns what the model should know. */
export async function runLive(name: string, args: Record<string, any>): Promise<unknown> {
  try {
    switch (name) {
      case 'ui_screen': return screen();
      case 'ui_menu': {
        const path = String(args.path ?? '').split('>').map((s) => s.trim()).filter(Boolean);
        let items = menuTree, node: MenuNode | undefined;
        for (const p of path) { node = items.find((m) => norm(m.label) === norm(p)) ?? items.find((m) => norm(m.label).startsWith(norm(p))); if (!node) return { error: `No menu item "${p}" in ${path.join(' > ')}.` }; items = node.submenu ?? []; }
        if (!node?.id) return { error: `"${path.join(' > ')}" is a submenu, not a command.` };
        await showMenu(path.map((p, i) => { let it = menuTree; for (let k = 0; k < i; k++) it = it.find((m) => norm(m.label).startsWith(norm(path[k])))?.submenu ?? []; return it.find((m) => norm(m.label) === norm(p) || norm(m.label).startsWith(norm(p)))?.label ?? p; }));
        run(node.id);
        await sleep(400);
        return { done: path.join(' > '), screen: screen() };
      }
      case 'ui_click': {
        const el = findClickable(String(args.target ?? ''));
        if (!el) return { error: `Nothing called "${args.target}" is visible.`, screen: screen() };
        if ((el as HTMLButtonElement).disabled) return { error: `"${args.target}" is disabled right now.`, screen: screen() };
        await clickEl(el);
        await sleep(300);
        return { clicked: args.target, screen: screen() };
      }
      case 'ui_type': {
        const el = findField(String(args.field ?? ''));
        if (!el) return { error: `No field labelled "${args.field}" in the open dialog.`, screen: screen() };
        await clickEl(el as HTMLElement);
        const text = String(args.text ?? '');
        const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!;
        if (el instanceof HTMLSelectElement || el.type === 'date' || el.type === 'datetime-local' || el.type === 'checkbox') {
          if (el instanceof HTMLInputElement && el.type === 'checkbox') { if (String(el.checked) !== text) el.click(); }
          else { const v = el instanceof HTMLSelectElement ? ([...el.options].find((o) => norm(o.text) === norm(text) || o.value === text)?.value ?? text) : text; setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        } else {
          setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
          for (let i = 1; i <= text.length; i++) { setter.call(el, text.slice(0, i)); el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(28); }
        }
        return { typed: text, into: args.field };
      }
      case 'select_activity': {
        const t = rows(getDb(), 'TASK').find((x) => x.task_code === String(args.activity_id) && getUi().openProjects.includes(x.proj_id)) ?? rows(getDb(), 'TASK').find((x) => x.task_code === String(args.activity_id));
        if (!t) return { error: `No activity "${args.activity_id}".` };
        const btn = [...document.querySelectorAll<HTMLElement>('.dirbtn')].find((b) => norm(b.textContent) === 'activities');
        if (getUi().view !== 'activities' && btn) await clickEl(btn);
        setUi({ view: 'activities', selTasks: [t.task_id], selTask: t.task_id, revealTask: t.task_id });
        await sleep(350);
        const row = document.querySelector<HTMLElement>('.grid-row.sel');
        if (row) await moveTo(row);
        return { selected: `${t.task_code} ${t.task_name}` };
      }
      case 'edit_project': {
        const ops = Array.isArray(args.operations) ? args.operations : [];
        const dels = ops.filter((o: { op?: string }) => o?.op === 'delete_activity' || o?.op === 'dissolve_activity' || o?.op === 'delete_wbs' || o?.op === 'delete_relationship' || o?.op === 'delete_resource' || o?.op === 'delete_code_value');
        const projId = getUi().openProjects[0];
        let proj = projId ? rows(getDb(), 'PROJECT').find((p) => p.proj_id === projId)?.proj_short_name : undefined;
        // deleting inside a project the assistant created in this session (e.g. trimming a copy) needs no confirmation
        const ownWork = !!proj && aiCreated.has(proj.toLowerCase()) && ops.every((o: Record<string, unknown>) => o?.project == null || String(o.project).toLowerCase() === proj!.toLowerCase());
        const mk = ops.findIndex((o: Record<string, unknown>) => o?.op === 'add_project' || o?.op === 'copy_project');
        const inNew = mk >= 0 && dels.every((o: Record<string, unknown>) => ops.indexOf(o) > mk && o.project == null);
        if (dels.length && !ownWork && !inNew && !(await window.p6.confirm(`The AI assistant wants to make ${ops.length} change(s), including ${dels.length} deletion(s).`, ops.map((o: Record<string, unknown>) => `${o.op} ${o.id ?? `${o.pred ?? ''} ${o.succ ?? ''}`}`).join('\n').slice(0, 800) + '\n\nAllow? (You can undo with Ctrl+Z.)'))) return { error: 'The user declined.' };
        // operations need not name the project: the open one, or the one this batch creates (from its add_project on)
        const withProj = ops.map((o: Record<string, unknown>) => {
          if ((o?.op === 'add_project' || o?.op === 'copy_project') && typeof o.id === 'string') { proj = o.id.trim(); return o; }
          return proj && o?.op !== 'add_calendar' && o?.op !== 'add_holidays' && o?.op !== 'add_resource' ? { project: proj, ...o } : o;
        });
        let r!: ReturnType<typeof applyOps>;
        const before = new Set(rows(getDb(), 'TASK').map((t) => t.task_id));
        mutate(`AI: ${ops.length} change(s)`, (d) => { r = applyOps(d, withProj, { hoursPerDay: getUi().prefs.hoursPerDay }); if (!r.ok) throw new Error(`operation ${r.error!.index + 1} (${(r.error!.op as { op?: string })?.op ?? '?'}): ${r.error!.message} Nothing in this call was applied.`); });
        // a created project is opened on screen, like File > Open
        const created = withProj.filter((o: Record<string, unknown>) => o?.op === 'add_project' || o?.op === 'copy_project').at(-1) as { id?: string } | undefined;
        const newId = created && rows(getDb(), 'PROJECT').find((p) => p.proj_short_name === String(created.id).trim() && !p._baseline_of)?.proj_id;
        if (created?.id) aiCreated.add(String(created.id).trim().toLowerCase());
        if (newId) setUi({ openProjects: [newId], view: 'activities', selTasks: [], selTask: undefined, selWbs: undefined, collapsed: {} });
        const codes = new Set(ops.flatMap((o: Record<string, unknown>) => [o.id, o.activity, o.pred, o.succ].filter(Boolean).map(String)));
        const touched = rows(getDb(), 'TASK').filter((t) => !before.has(t.task_id) || codes.has(t.task_code)).map((t) => t.task_id);
        if (touched.length) setUi({ view: 'activities', selTasks: touched, selTask: touched[0], revealTask: touched[0] });
        return { ...r, note: 'Applied as one step; the user can undo it with Ctrl+Z. Run Tools > Schedule (F9) to recalculate other activities.' };
      }
      case 'set_print_options': {
        const ps = savePageSetup(args.settings ?? {});
        const r = getUi().view === 'activities' && getUi().openProjects.length ? currentPrint(ps) : null;
        return { settings: ps, pages: r?.pages.length ?? null, activities: r?.activities ?? null, unknown_columns: r?.unknownColumns, printable_columns: printableColumns(getDb()).map((c) => c.id), note: r ? undefined : 'Open the Activities window of a project to print the schedule.' };
      }
      case 'list_reports': return listReports(getDb()).map((e) => ({ id: e.id, name: e.name, group: e.group, kind: e.kind, description: e.description }));
      case 'open_report': {
        const ui0 = getUi();
        if (!ui0.openProjects.length) return { error: 'Open a project first.' };
        const { entry, report } = runReport(getDb(), ui0.openProjects, String(args.report ?? ''), { prefs: ui0.prefs, weeks: Number(args.weeks) || undefined });
        setUi({ view: 'reports' });
        await sleep(400);
        const item = [...document.querySelectorAll<HTMLElement>('.report-item')].find((el) => el.textContent?.replace(/ \*$/, '') === entry.name);
        if (item) await clickEl(item); else setUi({ detailTab: entry.id });
        const max = Math.min(200, Number(args.max_rows) || 60);
        return { id: entry.id, name: entry.name, title: report.title, subtitle: report.subtitle, columns: report.columns, total_rows: report.rows.length, rows: report.rows.slice(0, max).map((r) => (r.bold ? { group: r.cells.find(Boolean) ?? '', level: r.level } : Object.fromEntries(report.columns.map((c, i) => [c, r.cells[i] ?? ''])))), truncated: report.rows.length > max };
      }
      case 'create_report': {
        const subj = (Object.keys(SUBJECTS) as (keyof typeof SUBJECTS)[]).find((k) => k === args.subject) ?? 'activities';
        const spec = parseSpec({ ...args, subject: subj, columns: Array.isArray(args.columns) && args.columns.length ? args.columns : SUBJECTS[subj].defaultColumns });
        if (!spec) return { error: 'Give the report a name.' };
        const known = new Set(subjectColumns(getDb(), spec.subject).map((c) => c.id));
        const unknown = spec.columns.filter((c) => !known.has(c));
        if (unknown.length) return { error: `Unknown column(s) for ${spec.subject}: ${unknown.join(', ')}`, columns: [...known].slice(0, 400) };
        if (spec.filter !== 'all' && !reportFilters(getDb()).some((f) => f.id === spec.filter)) return { error: `Unknown filter "${spec.filter}"`, filters: reportFilters(getDb()) };
        setUi({ view: 'reports' });
        openDialog('reportWizard', { preset: spec, runAfter: false });
        const top = () => [...document.querySelectorAll<HTMLElement>('.dialog')].at(-1);
        for (let step = 0; step < 6; step++) {
          await sleep(1100);
          const btn = [...(top()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => /^(Next >|Finish)$/.test(b.textContent?.trim() ?? ''));
          if (!btn) return { error: 'The Report Wizard closed before it finished.' };
          await clickEl(btn);
        }
        await sleep(300);
        const e = listReports(getDb()).find((x) => x.kind === 'custom' && x.name === spec.name);
        return e ? { saved: e.name, id: e.id, group: e.group, note: 'Saved and selected in the Reports window. Use open_report to read it, or run_report_dialog to print / export it.' } : { error: 'The report was not saved.' };
      }
      case 'run_report_dialog': {
        const e = listReports(getDb()).find((x) => x.id === args.report || x.name.toLowerCase() === String(args.report ?? '').toLowerCase());
        if (!e) return { error: `No report "${args.report}".` };
        const out = ['preview', 'printer', 'pdf', 'html', 'text', 'excel'].includes(String(args.output)) ? String(args.output) : 'preview';
        setUi({ view: 'reports', detailTab: e.id });
        openDialog('runReport', { reportId: e.id, output: out });
        return { opened: 'Run Report', report: e.name, output: out };
      }
      case 'undo': {
        const btn = document.querySelector<HTMLElement>('.tbtn[title="Undo"]');
        if (btn) await clickEl(btn); else doUndo();
        return { done: 'undo' };
      }
    }
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    return { error: (e as Error).message };
  } finally { hideSoon(); }
}
