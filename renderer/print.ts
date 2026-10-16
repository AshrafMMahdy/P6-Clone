// File > Print / Save as PDF of the current window, using Page Setup from localStorage.
import { getDb, getUi, toast } from './store.ts';
import { projectName } from './model.ts';
import { rows } from '../core/db.ts';
import { formatP6Date } from '../core/dates.ts';

export interface PageSetup { landscape: boolean; pagesWide: number; header: string; footer: string }

export function pageSetup(): PageSetup {
  try {
    return { landscape: true, pagesWide: 1, header: '', footer: '', ...JSON.parse(localStorage.getItem('p6clone.pageSetup') ?? '{}') };
  } catch {
    return { landscape: true, pagesWide: 1, header: '', footer: '' };
  }
}

export async function printView(mode: 'print' | 'pdf' | 'preview'): Promise<void> {
  const ps = pageSetup();
  const ui = getUi();
  const p = rows(getDb(), 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  const head = document.createElement('div');
  head.className = 'print-header';
  head.style.cssText = 'display:none';
  head.textContent = `${ps.header || (p ? `${p.proj_short_name} - ${projectName(getDb(), p)}` : 'P6 Clone')}   |   Data date ${p?.last_recalc_date ?? ''}   |   Printed ${formatP6Date(Date.now() / 60000)}${ps.footer ? '   |   ' + ps.footer : ''}`;
  const style = document.createElement('style');
  style.textContent = `@media print { .print-header { display:block !important; font: bold 12px Tahoma; padding: 4px 0 6px; } .app { height: auto; } body { zoom: ${1 / Math.max(1, ps.pagesWide)}; } }`;
  document.querySelector('.workspace')?.prepend(head);
  document.head.appendChild(style);
  try {
    if (mode === 'pdf') {
      const path = await window.p6.pdf(`${p?.proj_short_name ?? 'report'}.pdf`, ps.landscape);
      if (path) toast(`Saved ${path}`);
    } else if (mode === 'preview') await window.p6.printPreview(ps.landscape);
    else await window.p6.print(ps.landscape);
  } finally {
    head.remove();
    style.remove();
  }
}
