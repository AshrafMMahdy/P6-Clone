// File > Print / Print Preview / Save as PDF. The Activities window prints the whole layout (every row, the chosen
// columns and/or Gantt chart, page by page) from print/layout.ts; other windows print what is on screen. Page Setup
// is kept per computer and can also be changed by the AI assistant.
import { getDb, getUi, toast } from './store.ts';
import { projectName } from './model.ts';
import { rows } from '../core/db.ts';
import { formatP6Date } from '../core/dates.ts';
import { normalizePageSetup, PAGES_KEY, type PageSetup } from './print/layout.ts';
import { printPages } from './print/schedule.ts';
import { pagesToHtml } from './print/output.ts';

export function pageSetup(): PageSetup {
  try { return normalizePageSetup(JSON.parse(localStorage.getItem(PAGES_KEY) ?? '{}')); } catch { return normalizePageSetup({}); }
}
/** Merge changes into the saved Page Setup; returns the result. */
export function savePageSetup(change: unknown): PageSetup {
  const next = normalizePageSetup(change, pageSetup());
  try { localStorage.setItem(PAGES_KEY, JSON.stringify(next)); } catch { /* private window: kept for this print only */ }
  return next;
}

/** The current Activities layout as printed pages (for print, preview, PDF and the AI assistant). */
export function currentPrint(setup: PageSetup = pageSetup()) {
  const ui = getUi();
  return printPages(getDb(), {
    projIds: ui.openProjects, setup, base: setup, columns: ui.columns, colWidths: ui.colWidths, filter: ui.filter, groupBy: ui.groupBy,
    sortBy: ui.sortBy, collapsed: ui.collapsed, layoutName: ui.layoutName, prefs: ui.prefs,
  });
}

export async function printView(mode: 'print' | 'pdf' | 'preview'): Promise<void> {
  const ui = getUi();
  const p = rows(getDb(), 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  if (ui.view === 'activities' && ui.openProjects.length) {
    const r = currentPrint();
    const res = await window.p6.printHtml(pagesToHtml(r.pages, r.title), mode, `${p?.proj_short_name ?? 'schedule'}.pdf`);
    if (mode === 'pdf' && res) toast(`Saved ${res} (${r.pages.length} page${r.pages.length > 1 ? 's' : ''})`);
    return;
  }
  // other windows: what is on screen, with the Page Setup header and footer
  const ps = pageSetup();
  const band = (b: PageSetup['header']) => !b.show ? '' : [b.left, b.center, b.right].filter(Boolean).join('   |   ')
    .replace(/\[Project ID\]/g, p?.proj_short_name ?? '').replace(/\[Project Name\]/g, p ? projectName(getDb(), p) : '').replace(/\[Data Date\]/g, p?.last_recalc_date?.slice(0, 10) ?? '')
    .replace(/\[Print Date\]/g, formatP6Date(Date.now() / 60000 - new Date().getTimezoneOffset()).slice(0, 16)).replace(/\[Page\] of \[Pages\]|\[Page\]|\[Pages\]/g, '').replace(/\[[A-Za-z ]+\]/g, '');
  const mk = (cls: string, text: string) => { const d = document.createElement('div'); d.className = cls; d.style.cssText = 'display:none'; d.textContent = text; return d; };
  const head = mk('print-band', band(ps.header)), foot = mk('print-band', band(ps.footer));
  const style = document.createElement('style');
  style.textContent = `@media print { .print-band { display:block !important; font: 11px Tahoma; padding: 4px 0; } .app { height: auto; } }`;
  const ws = document.querySelector('.workspace');
  ws?.prepend(head); ws?.append(foot);
  document.head.appendChild(style);
  try {
    if (mode === 'pdf') {
      const path = await window.p6.pdf(`${p?.proj_short_name ?? 'report'}.pdf`, ps.landscape);
      if (path) toast(`Saved ${path}`);
    } else if (mode === 'preview') await window.p6.printPreview(ps.landscape);
    else await window.p6.print(ps.landscape);
  } finally { head.remove(); foot.remove(); style.remove(); }
}
