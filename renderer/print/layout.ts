// Printed schedule pages, laid out once in millimetres and drawn two ways: as SVG pages for the app (printer, preview,
// PDF through Chromium, any script) and as a PDF written directly by the CLI and MCP server (no browser needed).
// Like P6's printout of the Activities layout: every row of the layout on as many pages as it takes, chosen columns
// and/or the Gantt chart, column titles and timescale on every page, header and footer bands, legend, page numbers.
import { formatP6Date, parseP6Date } from '../../core/dates.ts';
import type { Row } from '../../core/db.ts';
import type { ActRow } from '../views/activityRows.ts';
import type { Column, Ctx } from '../model.ts';

// ---------------------------------------------------------------- settings (Page Setup)
export type Paper = 'Letter' | 'Legal' | 'Tabloid' | 'A4' | 'A3' | 'A2' | 'A1';
export const PAPERS: Record<Paper, [number, number]> = { Letter: [216, 279], Legal: [216, 356], Tabloid: [279, 432], A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841] };
export interface Band { show: boolean; left: string; center: string; right: string }
export interface PageSetup {
  paper: Paper; landscape: boolean;
  margins: { top: number; bottom: number; left: number; right: number }; // mm
  fontPt: number;
  header: Band; footer: Band;
  /** what is printed: the columns, the Gantt chart, or both side by side */
  content: 'both' | 'table' | 'gantt';
  tableShare: number; // % of the width for the columns when both are printed
  /** column ids to print; empty = the layout's columns */
  columns: string[];
  showLinks: boolean; showLegend: boolean; showBaseline: boolean; showGrid: boolean;
  range: 'project' | 'custom'; from: string; to: string; // timescale
}
export const PAGE_DEFAULT: PageSetup = {
  paper: 'A3', landscape: true, margins: { top: 10, bottom: 10, left: 10, right: 10 }, fontPt: 8,
  header: { show: true, left: '[Project ID] - [Project Name]', center: '[Layout]', right: 'Data Date: [Data Date]' },
  footer: { show: true, left: 'Printed: [Print Date]', center: '[Filter]', right: 'Page [Page] of [Pages]' },
  content: 'both', tableShare: 50, columns: [], showLinks: false, showLegend: true, showBaseline: false, showGrid: true,
  range: 'project', from: '', to: '',
};
export const PAGES_KEY = 'p6clone.pageSetup';
/** The settings as an AI model or MCP client needs to know them. */
export const PRINT_GUIDE = 'Print settings (all optional; snake_case or camelCase): paper (Letter, Legal, Tabloid, A4, A3, A2, A1), landscape (true/false), margins {top,bottom,left,right} in mm, font_pt (5-14), content ("both" = columns and Gantt side by side, "table" = columns only, "gantt" = Gantt only), table_share (% of width for the columns, 10-90), columns (list of column ids such as task_code, task_name, orig_dur, rem_dur, pct, start, finish, total_float; empty = the layout columns), show_links (relationship lines), show_baseline, show_legend, show_grid, range ("project" or "custom" with from/to dates), header and footer {show, left, center, right} with variables [Project ID] [Project Name] [Data Date] [Finish Date] [Print Date] [Layout] [Filter] [Page] [Pages].';
export const VARIABLES = ['[Project ID]', '[Project Name]', '[Data Date]', '[Finish Date]', '[Print Date]', '[Layout]', '[Filter]', '[Page]', '[Pages]'];

/** Settings from anywhere (saved, older versions, an AI tool call, MCP arguments in snake_case) made whole and valid. */
export function normalizePageSetup(o: unknown, base: PageSetup = PAGE_DEFAULT): PageSetup {
  const raw = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const s: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) s[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v; // font_pt -> fontPt
  const num = (v: unknown, d: number, lo: number, hi: number) => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return typeof n === 'number' && n >= lo && n <= hi ? n : d; };
  const bool = (v: unknown, d: boolean) => typeof v === 'boolean' ? v : d;
  const band = (b: unknown, d: Band): Band => typeof b === 'string' ? { ...d, show: true, center: b } // older saves kept one text
    : b === false ? { ...d, show: false } : b && typeof b === 'object' ? { show: bool((b as Band).show, d.show), left: str((b as Band).left, d.left), center: str((b as Band).center, d.center), right: str((b as Band).right, d.right) } : { ...d };
  const str = (v: unknown, d: string) => typeof v === 'string' ? v : d;
  const m = (s.margins && typeof s.margins === 'object' ? s.margins : {}) as Record<string, unknown>;
  const paper = Object.keys(PAPERS).find((p) => p.toLowerCase() === String(s.paper ?? '').toLowerCase()) as Paper | undefined;
  // older saves: pagesWide only; "orientation": "portrait"
  const landscape = typeof s.orientation === 'string' ? s.orientation.toLowerCase() !== 'portrait' : bool(s.landscape, base.landscape);
  const content = s.content === 'table' || s.content === 'gantt' || s.content === 'both' ? s.content
    : s.showGantt === false ? 'table' : s.showTable === false ? 'gantt' : base.content;
  return {
    paper: paper ?? base.paper, landscape,
    margins: { top: num(m.top, base.margins.top, 0, 60), bottom: num(m.bottom, base.margins.bottom, 0, 60), left: num(m.left, base.margins.left, 0, 60), right: num(m.right, base.margins.right, 0, 60) },
    fontPt: num(s.fontPt, base.fontPt, 5, 14),
    header: band(s.header, base.header), footer: band(s.footer, base.footer),
    content, tableShare: num(s.tableShare, base.tableShare, 10, 90),
    columns: Array.isArray(s.columns) ? s.columns.filter((c): c is string => typeof c === 'string') : base.columns,
    showLinks: bool(s.showLinks, base.showLinks), showLegend: bool(s.showLegend, base.showLegend), showBaseline: bool(s.showBaseline, base.showBaseline), showGrid: bool(s.showGrid, base.showGrid),
    range: s.range === 'custom' ? 'custom' : s.range === 'project' ? 'project' : base.range, from: str(s.from, base.from), to: str(s.to, base.to),
  };
}

// ---------------------------------------------------------------- drawing primitives (mm, origin top-left)
export type Prim =
  | { t: 'text'; x: number; y: number; s: string; pt: number; bold?: boolean; color?: string; align?: 'l' | 'c' | 'r' }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; lw?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; lw: number; dash?: boolean }
  | { t: 'path'; pts: [number, number][]; color: string; lw: number; close?: boolean; fill?: string; arrow?: boolean };
export interface Page { w: number; h: number; prims: Prim[] }

// Helvetica widths (1/1000 em) for codes 32..126; Arial matches closely. Anything else counts as 0.6 em.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const PT = 25.4 / 72; // mm per point
export function textWidth(s: string, pt: number, bold = false): number {
  let w = 0;
  for (const ch of s) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? HELV[c - 32] : 600; }
  return (w / 1000) * pt * PT * (bold ? 1.07 : 1);
}
/** s shortened with "..." to fit in w mm. */
export function fit(s: string, w: number, pt: number, bold = false): string {
  if (textWidth(s, pt, bold) <= w) return s;
  const chars = [...s];
  let lo = 0, hi = chars.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (textWidth(chars.slice(0, mid).join('') + '...', pt, bold) <= w) lo = mid; else hi = mid - 1; }
  return lo ? chars.slice(0, lo).join('') + '...' : '';
}

const GROUP_FILL = ['#fdf3c4', '#e3eefb', '#e5f4e1', '#f6e6f2', '#eeeeee'];
const C = { head: '#dde4ee', line: '#8a9ab0', grid: '#d4d4d4', act: '#2050d0', rem: '#30b030', crit: '#e00000', base: '#e8c800', dd: '#0050c8', text: '#000000', link: '#404040', linkCrit: '#c00000' };

export interface LayoutInput {
  rows: ActRow[]; cols: Column[]; ctx: Ctx; ps: PageSetup;
  vars: Record<string, string>; dataDate: number | null;
  fmtDate: (v: number | null | undefined) => string;
  taskStart: (t: Row) => number | null; taskFinish: (t: Row) => number | null;
  isCritical: (t: Row) => boolean;
}

export function layoutSchedule(p: LayoutInput): Page[] {
  const { ps, rows } = p;
  const [w0, h0] = PAPERS[ps.paper];
  const [pw, ph] = ps.landscape ? [h0, w0] : [w0, h0];
  const m = ps.margins;
  const x0 = m.left, cw = pw - m.left - m.right;
  const pt = ps.fontPt, rh = pt * PT * 1.9, small = Math.max(5, pt - 1);
  const showTable = ps.content !== 'gantt' && p.cols.length > 0, gantt = ps.content !== 'table';
  const cols = showTable ? p.cols : [];
  const tableW = !showTable ? 0 : gantt ? (cw * ps.tableShare) / 100 : cw;
  const gx = x0 + tableW, gw = cw - tableW;
  const bandH = rh * 1.1;
  const top = m.top + (ps.header.show ? bandH + 1 : 0);
  const legendH = ps.showLegend && gantt ? rh : 0;
  const bottom = ph - m.bottom - (ps.footer.show ? bandH + 1 : 0) - (legendH ? legendH + 1 : 0);
  const headH = gantt ? rh * 1.6 : rh;
  const perPage = Math.max(1, Math.floor((bottom - top - headH) / rh));
  const pages = Math.max(1, Math.ceil(rows.length / perPage));

  // timescale: the rows' span rounded out to whole months, or the chosen dates
  let lo = Infinity, hi = -Infinity;
  const span = (r: ActRow): [number | null, number | null] => r.kind === 'group' ? [r.es ?? null, r.ef ?? null] : [p.taskStart(r.task!), p.taskFinish(r.task!)];
  for (const r of rows) { const [s, f] = span(r); if (s != null && s < lo) lo = s; if (f != null && f > hi) hi = f; }
  if (ps.range === 'custom') { lo = parseP6Date(ps.from) ?? lo; hi = parseP6Date(ps.to) ?? hi; }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) { lo = p.dataDate ?? Date.UTC(2026, 0, 1) / 60000; hi = lo + 30 * 1440; }
  const d0 = new Date(lo * 60000), d1 = new Date(hi * 60000);
  const t0 = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1) / 60000, t1 = Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth() + 1, 1) / 60000;
  const X = (t: number) => gx + Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) * gw;
  const months: { a: number; b: number; d: Date }[] = [];
  for (let y = d0.getUTCFullYear(), mo = d0.getUTCMonth(); Date.UTC(y, mo, 1) / 60000 < t1; mo++) months.push({ a: Date.UTC(y, mo, 1) / 60000, b: Date.UTC(y, mo + 1, 1) / 60000, d: new Date(Date.UTC(y, mo, 1)) });
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // column widths scaled into the table area
  const sumW = cols.reduce((s, c) => s + c.width, 0) || 1;
  const colX: number[] = []; let cx = x0;
  for (const c of cols) { colX.push(cx); cx += (c.width / sumW) * tableW; }
  const colW = (i: number) => (cols[i].width / sumW) * tableW;

  const rowOf = new Map<string, number>(); rows.forEach((r, i) => { if (r.task) rowOf.set(r.task.task_id, i); });
  const out: Page[] = [];
  for (let pg = 0; pg < pages; pg++) {
    const P: Prim[] = [];
    const vars: Record<string, string> = { ...p.vars, '[Page]': String(pg + 1), '[Pages]': String(pages) };
    const fill = (s: string) => s.replace(/\[[A-Za-z ]+\]/g, (v) => vars[v] ?? v);
    const bandText = (b: Band, y: number) => {
      if (!b.show) return;
      const third = cw / 3;
      if (b.left) P.push({ t: 'text', x: x0, y, s: fit(fill(b.left), third * 1.4, pt, true), pt, bold: true, align: 'l' });
      if (b.center) P.push({ t: 'text', x: x0 + cw / 2, y, s: fit(fill(b.center), third, pt), pt, align: 'c' });
      if (b.right) P.push({ t: 'text', x: x0 + cw, y, s: fit(fill(b.right), third, pt), pt, align: 'r' });
    };
    if (ps.header.show) { bandText(ps.header, m.top + bandH * 0.7); P.push({ t: 'line', x1: x0, y1: m.top + bandH, x2: x0 + cw, y2: m.top + bandH, color: C.line, lw: 0.3 }); }

    // column titles and timescale
    P.push({ t: 'rect', x: x0, y: top, w: cw, h: headH, fill: C.head, stroke: C.line, lw: 0.25 });
    cols.forEach((c, i) => {
      if (i) P.push({ t: 'line', x1: colX[i], y1: top, x2: colX[i], y2: top + headH, color: C.line, lw: 0.25 });
      P.push({ t: 'text', x: colX[i] + colW(i) / 2, y: top + headH / 2 + pt * PT * 0.35, s: fit(c.title, colW(i) - 1, pt, true), pt, bold: true, align: 'c' });
    });
    if (gantt) {
      if (showTable) P.push({ t: 'line', x1: gx, y1: top, x2: gx, y2: top + headH, color: C.line, lw: 0.35 });
      const mid = top + headH / 2;
      P.push({ t: 'line', x1: gx, y1: mid, x2: gx + gw, y2: mid, color: C.line, lw: 0.2 });
      let yStart = 0;
      months.forEach((mo, i) => {
        const a = X(mo.a), b = X(mo.b);
        P.push({ t: 'line', x1: a, y1: mid, x2: a, y2: top + headH, color: C.line, lw: 0.15 });
        const label = b - a > textWidth('Mmm 00', small) + 1 ? `${MON[mo.d.getUTCMonth()]} ${String(mo.d.getUTCFullYear()).slice(2)}` : b - a > textWidth('Mmm', small) + 0.6 ? MON[mo.d.getUTCMonth()] : MON[mo.d.getUTCMonth()][0];
        if (b - a > textWidth(label.slice(0, 1), small)) P.push({ t: 'text', x: (a + b) / 2, y: top + headH * 0.82, s: label, pt: small, align: 'c' });
        const yearEnds = i === months.length - 1 || months[i + 1].d.getUTCFullYear() !== mo.d.getUTCFullYear();
        if (yearEnds) {
          const ya = X(months[yStart].a);
          if (yStart) P.push({ t: 'line', x1: ya, y1: top, x2: ya, y2: mid, color: C.line, lw: 0.2 });
          P.push({ t: 'text', x: (ya + b) / 2, y: top + headH * 0.36, s: fit(String(mo.d.getUTCFullYear()), b - ya, small, true), pt: small, bold: true, align: 'c' });
          yStart = i + 1;
        }
      });
    }

    // rows
    const first = pg * perPage, last = Math.min(rows.length, first + perPage);
    const y0 = top + headH;
    const yEnd = y0 + (last - first) * rh;
    if (gantt) {
      if (ps.showGrid) for (const mo of months) P.push({ t: 'line', x1: X(mo.a), y1: y0, x2: X(mo.a), y2: yEnd, color: C.grid, lw: 0.12, dash: true });
    }
    for (let i = first; i < last; i++) {
      const r = rows[i], y = y0 + (i - first) * rh, base = y + rh / 2 + pt * PT * 0.35;
      if (r.kind === 'group') {
        P.push({ t: 'rect', x: x0, y, w: cw, h: rh, fill: GROUP_FILL[Math.min(r.level, 4)] });
        if (showTable) {
          const startIdx = cols.findIndex((c) => c.id === 'start' || c.id === 'finish');
          const labelW = (startIdx > 0 ? colX[startIdx] : x0 + tableW) - x0 - 1.5 - r.level * 2.5;
          P.push({ t: 'text', x: x0 + 1 + r.level * 2.5, y: base, s: fit(r.label ?? '', labelW, pt, true), pt, bold: true });
          cols.forEach((c, j) => { if (c.id === 'start' || c.id === 'finish') P.push({ t: 'text', x: colX[j] + colW(j) - 0.8, y: base, s: fit(p.fmtDate(c.id === 'start' ? r.es : r.ef), colW(j) - 1, pt), pt, align: 'r' }); });
        }
        if (gantt && r.es != null && r.ef != null) P.push({ t: 'rect', x: X(r.es), y: y + rh * 0.38, w: Math.max(0.3, X(r.ef) - X(r.es)), h: rh * 0.24, fill: '#000000' });
      } else {
        const t = r.task!, crit = p.isCritical(t);
        cols.forEach((c, j) => {
          const v = c.get(t, p.ctx), indent = j === 0 ? r.level * 2.5 : 0;
          const right = c.align === 'right';
          P.push({ t: 'text', x: right ? colX[j] + colW(j) - 0.8 : colX[j] + 0.8 + indent, y: base, s: fit(v, colW(j) - 1.6 - indent, pt), pt, align: right ? 'r' : c.align === 'center' ? 'c' : 'l', ...(c.align === 'center' ? { x: colX[j] + colW(j) / 2 } : {}) });
        });
        if (gantt) {
          const as = parseP6Date(t.act_start_date), af = parseP6Date(t.act_end_date);
          const es = parseP6Date(t.early_start_date || t.restart_date) ?? p.taskStart(t), ef = parseP6Date(t.early_end_date || t.reend_date) ?? p.taskFinish(t);
          if (ps.showBaseline) {
            const bl = p.ctx.baseline.get(`${t.task_code}|${t.proj_id}`);
            const bs = bl ? parseP6Date(bl.act_start_date || bl.target_start_date) : null, bf = bl ? parseP6Date(bl.act_end_date || bl.target_end_date) : null;
            if (bs != null && bf != null) P.push({ t: 'rect', x: X(bs), y: y + rh * 0.72, w: Math.max(0.3, X(bf) - X(bs)), h: rh * 0.18, fill: C.base });
          }
          if (t.task_type === 'TT_Mile' || t.task_type === 'TT_FinMile') {
            const at = af ?? as ?? (t.task_type === 'TT_Mile' ? es : ef);
            if (at != null) { const cxm = X(at), cy = y + rh / 2, d = rh * 0.3; P.push({ t: 'path', pts: [[cxm, cy - d], [cxm + d, cy], [cxm, cy + d], [cxm - d, cy]], close: true, fill: as || af ? C.act : crit ? C.crit : '#000000', color: '#000000', lw: 0.1 }); }
          } else {
            const by = y + rh * 0.25, bh = rh * (ps.showBaseline ? 0.42 : 0.5);
            if (as != null) { const a = X(as), b = X(af ?? p.dataDate ?? as); P.push({ t: 'rect', x: a, y: by, w: Math.max(0.3, b - a), h: bh, fill: C.act, stroke: '#00000060', lw: 0.1 }); }
            if (!af && es != null && ef != null) { const a = X(as != null && p.dataDate != null ? Math.max(es, p.dataDate) : es), b = X(ef); P.push({ t: 'rect', x: a, y: by, w: Math.max(0.3, b - a), h: bh, fill: crit ? C.crit : C.rem, stroke: '#00000060', lw: 0.1 }); }
          }
        }
      }
      if (ps.showGrid) P.push({ t: 'line', x1: x0, y1: y + rh, x2: x0 + cw, y2: y + rh, color: C.grid, lw: 0.1 });
    }
    // column separators, frame, data date
    if (showTable) cols.forEach((_, j) => { if (j) P.push({ t: 'line', x1: colX[j], y1: y0, x2: colX[j], y2: yEnd, color: C.grid, lw: 0.12 }); });
    if (gantt && showTable) P.push({ t: 'line', x1: gx, y1: y0, x2: gx, y2: yEnd, color: C.line, lw: 0.3 });
    P.push({ t: 'rect', x: x0, y: top, w: cw, h: yEnd - top, stroke: C.line, lw: 0.3 });
    if (gantt && p.dataDate != null && p.dataDate >= t0 && p.dataDate <= t1) P.push({ t: 'line', x1: X(p.dataDate), y1: y0, x2: X(p.dataDate), y2: yEnd, color: C.dd, lw: 0.35, dash: true });

    // relationship lines between activities printed on this page
    if (gantt && ps.showLinks) {
      for (const rel of p.ctx.db.tables.TASKPRED?.rows ?? []) {
        const ia = rowOf.get(rel.pred_task_id), ib = rowOf.get(rel.task_id);
        if (ia == null || ib == null || ia < first || ia >= last || ib < first || ib >= last) continue;
        const a = rows[ia].task!, b = rows[ib].task!;
        const ty = rel.pred_type || 'PR_FS';
        const ax = X((ty === 'PR_SS' || ty === 'PR_SF' ? p.taskStart(a) : p.taskFinish(a)) ?? t0);
        const bx = X((ty === 'PR_FS' || ty === 'PR_SS' ? p.taskStart(b) : p.taskFinish(b)) ?? t0);
        const ay = y0 + (ia - first) * rh + rh / 2, by = y0 + (ib - first) * rh + rh / 2;
        const into = ty === 'PR_FS' || ty === 'PR_SS' ? -1 : 1; // arrive at a start from the left, at a finish from the right
        const ex = bx + into * 1.2, kx = (ty === 'PR_FS' || ty === 'PR_FF') ? Math.max(ax + 1, ty === 'PR_FF' ? ex : ax + 1) : Math.min(ax - 1, ex);
        P.push({ t: 'path', pts: [[ax, ay], [kx, ay], [kx, by], [bx, by]], color: p.isCritical(a) && p.isCritical(b) ? C.linkCrit : C.link, lw: 0.18, arrow: true });
      }
    }

    // legend and footer
    if (legendH) {
      const ly = bottom + 1 + legendH * 0.55;
      let lx = x0;
      const item = (draw: (x: number) => void, label: string) => { draw(lx); lx += 7; P.push({ t: 'text', x: lx, y: ly + pt * PT * 0.35, s: label, pt: small }); lx += textWidth(label, small) + 5; };
      const bar = (fillc: string) => (x: number) => P.push({ t: 'rect', x, y: ly - 1.2, w: 6, h: 2.4, fill: fillc, stroke: '#00000060', lw: 0.1 });
      item(bar(C.act), 'Actual Work'); item(bar(C.rem), 'Remaining Work'); item(bar(C.crit), 'Critical Remaining Work');
      item((x) => P.push({ t: 'path', pts: [[x + 3, ly - 1.4], [x + 4.4, ly], [x + 3, ly + 1.4], [x + 1.6, ly]], close: true, fill: '#000000', color: '#000000', lw: 0.1 }), 'Milestone');
      item((x) => P.push({ t: 'rect', x, y: ly - 0.6, w: 6, h: 1.2, fill: '#000000' }), 'Summary');
      if (ps.showBaseline) item(bar(C.base), 'Baseline');
      item((x) => P.push({ t: 'line', x1: x + 3, y1: ly - 1.6, x2: x + 3, y2: ly + 1.6, color: C.dd, lw: 0.35, dash: true }), 'Data Date');
    }
    if (ps.footer.show) { const fy = ph - m.bottom - bandH; P.push({ t: 'line', x1: x0, y1: fy, x2: x0 + cw, y2: fy, color: C.line, lw: 0.3 }); bandText(ps.footer, fy + bandH * 0.75); }
    out.push({ w: pw, h: ph, prims: P });
  }
  return out;
}

/** Values for the header/footer variables ([Page] and [Pages] are filled per page). */
export function printVars(o: { projId?: string; projName?: string; dataDate?: string; finish?: string; layout?: string; filter?: string; now?: Date }): Record<string, string> {
  const d = o.now ?? new Date();
  return {
    '[Project ID]': o.projId ?? '', '[Project Name]': o.projName ?? '', '[Data Date]': o.dataDate ?? '', '[Finish Date]': o.finish ?? '',
    '[Print Date]': formatP6Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 60000).slice(0, 16),
    '[Layout]': o.layout ?? '', '[Filter]': o.filter ?? '',
  };
}
