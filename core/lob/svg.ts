// The flowline as SVG, from the scheduled activities: Y the locations (each level a narrow column of names on the
// left, the finest level as rows), X time; one line per trade, rising location by location, labelled along its start;
// the data date in red; the critical trades drawn thicker. Used by lob_view (a picture for the agent and the user) and
// the desktop's LOB view draws the same geometry.
import { maxOf, minOf } from '../arrays.ts';
import { rows, type Db } from '../db.ts';
import { parseP6Date } from '../dates.ts';
import { activityId } from './expand.ts';
import { locationDurations } from './edit.ts';
import { locationsAt, pathOf, type LobModel } from './model.ts';

export const TRADE_COLOURS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2', '#bcbd22', '#7f7f7f', '#393b79', '#637939', '#8c6d31', '#843c39', '#7b4173', '#3182bd'];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface FlowGeometry { rows: { code: string; label: string; path: string[] }[]; t0: number; t1: number; lines: { task: string; segment: number; trade: string; colour: string; critical: boolean; points: [number, number, number][]; locations: string[] }[]; dataDate: number | null }

/** Where everything goes: rows (finest level, tree order), the time span, and per trade the points (time, row bottom,
 *  row top) of each location's start and finish. */
export function flowGeometry(db: Db, projId: string, m: LobModel, critical: string[] = []): FlowGeometry {
  const finest = Math.max(maxOf(m.tasks.map((t) => t.precision)), 1);
  const leaves = locationsAt(m, finest);
  const rowsOut = leaves.map((l) => ({ code: l.code, label: l.name, path: pathOf(m, l.code) }));
  const rowOf = new Map(rowsOut.map((r, k) => [r.code, k]));
  // a coarser location spans the rows of the finest locations under it
  const span = (c: string): [number, number] => { const ks = rowsOut.flatMap((r, k) => (r.path.includes(c) ? [k] : [])); return ks.length ? [minOf(ks), maxOf(ks) + 1] : [rowOf.get(c) ?? 0, (rowOf.get(c) ?? 0) + 1]; };
  const acts = new Map(rows(db, 'TASK').filter((t) => t.proj_id === projId).map((t) => [t.task_code, t]));
  let t0 = Infinity, t1 = -Infinity;
  // a line per segment (a split, or a Vico line, is drawn on its own), coloured by task as Vico does
  const lines = m.tasks.flatMap((t, ti) => t.segments.map((g, k) => {
    const d = locationDurations(m, t);
    const points: [number, number, number][] = [], locations: string[] = [];
    for (const c of t.order.slice(t.order.indexOf(g.from), t.order.indexOf(g.to) + 1).filter((x) => d.has(x))) {
      const a = acts.get(activityId(t.code, c));
      if (!a) continue;
      const s = parseP6Date(a.act_start_date || a.early_start_date), f = parseP6Date(a.act_end_date || a.early_end_date);
      if (s == null || f == null) continue;
      const [lo, hi] = span(c);
      points.push([s, lo, hi], [f, lo, hi]); locations.push(c);
      t0 = Math.min(t0, s); t1 = Math.max(t1, f);
    }
    return { task: t.code, segment: k + 1, trade: t.trade, colour: TRADE_COLOURS[ti % TRADE_COLOURS.length], critical: critical.includes(t.code), points, locations };
  }));
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  return { rows: rowsOut, t0: Number.isFinite(t0) ? t0 : 0, t1: Number.isFinite(t1) ? t1 : 1, lines, dataDate: parseP6Date(proj.last_recalc_date) };
}

/** The chart's frame: where time and rows go, shared by the SVG and the desktop's interactive chart. */
export function flowFrame(g: FlowGeometry, levels: number, W: number, H: number) {
  const left = 70 * levels + 10, top = 40, right = 20, bottom = 30, n = Math.max(1, g.rows.length), rowH = (H - top - bottom) / n;
  return { left, top, right, bottom, rowH, X: (t: number) => left + ((t - g.t0) / Math.max(1, g.t1 - g.t0)) * (W - left - right), T: (x: number) => g.t0 + ((x - left) / (W - left - right)) * Math.max(1, g.t1 - g.t0), Y: (row: number) => H - bottom - row * rowH };
}

export function flowlineSvg(db: Db, projId: string, m: LobModel, o: { width?: number; height?: number; critical?: string[]; title?: string } = {}): string {
  const g = flowGeometry(db, projId, m, o.critical);
  const W = o.width ?? 1400, H = o.height ?? Math.max(400, 60 + g.rows.length * 22), levels = m.levels.length;
  const left = 70 * levels + 10, top = 40, right = 20, bottom = 30;
  const X = (t: number) => left + ((t - g.t0) / Math.max(1, g.t1 - g.t0)) * (W - left - right);
  const n = Math.max(1, g.rows.length), rowH = (H - top - bottom) / n;
  const Y = (row: number) => H - bottom - row * rowH; // row 0 at the bottom (the ground floor)
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, Arial, sans-serif" font-size="11">`, `<rect width="${W}" height="${H}" fill="#ffffff"/>`];
  if (o.title) out.push(`<text x="${left}" y="22" font-size="14" font-weight="600" fill="#1f2a3a">${esc(o.title)}</text>`);
  // the location columns: one per level, each name centred on the rows it covers
  for (let lv = 0; lv < levels; lv++) {
    const x = 10 + lv * 70;
    const seen = new Map<string, number[]>();
    g.rows.forEach((r, k) => { const c = r.path[lv]; if (c) (seen.get(c) ?? seen.set(c, []).get(c)!).push(k); });
    for (const [c, ks] of seen) {
      const lo = minOf(ks), hi = maxOf(ks) + 1, name = m.locations.find((l) => l.code === c)?.name ?? c;
      out.push(`<line x1="${x}" x2="${W - right}" y1="${Y(lo)}" y2="${Y(lo)}" stroke="#e3e8ef"/>`, `<text x="${x + 4}" y="${(Y(lo) + Y(hi)) / 2 + 4}" fill="#4a5568">${esc(name)}</text>`);
    }
  }
  // months along the bottom
  const d0 = new Date(g.t0 * 60000);
  for (let d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1)); d.getTime() / 60000 <= g.t1; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const x = X(d.getTime() / 60000);
    if (x < left) continue;
    out.push(`<line x1="${x}" x2="${x}" y1="${top}" y2="${H - bottom}" stroke="#f0f2f6"/>`, `<text x="${x + 2}" y="${H - 10}" fill="#6b7686">${d.toISOString().slice(0, 7)}</text>`);
  }
  for (const l of g.lines) {
    if (!l.points.length) continue;
    const pts = l.points.map(([t, lo, hi], k) => `${X(t).toFixed(1)},${(k % 2 ? Y(hi) : Y(lo)).toFixed(1)}`).join(' ');
    out.push(`<polyline points="${pts}" fill="none" stroke="${l.colour}" stroke-width="${l.critical ? 3 : 1.6}"/>`);
    const [t, lo] = l.points[0];
    out.push(`<text x="${X(t) + 3}" y="${Y(lo) - 3}" fill="${l.colour}">${esc(l.task)}</text>`);
  }
  if (g.dataDate != null && g.dataDate >= g.t0 && g.dataDate <= g.t1) out.push(`<line x1="${X(g.dataDate)}" x2="${X(g.dataDate)}" y1="${top}" y2="${H - bottom}" stroke="#d62728" stroke-dasharray="4 3"/>`);
  out.push('</svg>');
  return out.join('\n');
}
