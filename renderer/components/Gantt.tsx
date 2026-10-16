import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseP6Date, formatP6Date, MIN_PER_DAY, weekday } from '../../core/dates.ts';
import type { WorkCalendar } from '../../core/calendar/calendar.ts';

export interface GanttEntry {
  key: string;
  kind: 'group' | 'task';
  level: number;
  /** minutes */
  es?: number | null; ef?: number | null; as?: number | null; af?: number | null;
  bls?: number | null; blf?: number | null;
  critical?: boolean;
  milestone?: 'start' | 'finish' | null;
  label?: string;
  tip?: string;
}
export interface GanttLink { from: string; to: string; type: string; driving: boolean; critical: boolean }

/** View > Bars: how the bar chart looks (saved with the layout). */
export interface BarStyles {
  actual: string; remaining: string; critical: string; baseline: string; milestone: string; summary: string;
  link: string; criticalLink: string; dataDate: string;
  height: 'thin' | 'normal' | 'thick';
  label: 'none' | 'name' | 'id' | 'id-name';
  showBaseline: boolean; showDataDate: boolean; shadeNonWork: boolean; gridLines: boolean; showSummary: boolean;
}
export const DEFAULT_BARS: BarStyles = {
  actual: '#0000ff', remaining: '#00c000', critical: '#ff0000', baseline: '#ffe500', milestone: '#00c000', summary: '#000000',
  link: '#000000', criticalLink: '#d00000', dataDate: '#0000c0',
  height: 'normal', label: 'none', showBaseline: true, showDataDate: true, shadeNonWork: true, gridLines: true, showSummary: true,
};
/** Things the bar chart can do for its right-click menu (it knows its own scale and size). */
export interface GanttActions { zoomToFit(): void; goToDataDate(): void; goToKey(key: string): void }

const RH = 19;

export function Gantt(p: {
  entries: GanttEntry[]; links: GanttLink[]; dataDate: number | null; pxPerDay: number; showLinks: boolean;
  scrollTop?: number; onScroll?: (top: number) => void; selected?: Set<string>; onSelect?: (key: string, mods?: { ctrlKey: boolean; shiftKey: boolean }) => void;
  onLink?: (from: string, to: string) => void; calendar?: WorkCalendar; showBaseline?: boolean;
  styles?: BarStyles; onContextMenu?: (key: string | null, e: React.MouseEvent, actions: GanttActions) => void; onZoom?: (pxPerDay: number) => void;
}) {
  const st = p.styles ?? DEFAULT_BARS;
  const bh = st.height === 'thin' ? 4 : st.height === 'thick' ? 11 : 7; // bar thickness
  const wrap = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const echo = useRef<number | null>(null); // position we scrolled to on request (its scroll event is not reported back)
  const canvas = useRef<HTMLCanvasElement>(null);
  const headCanvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 300 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const drag = useRef<{ from: string; x: number; y: number; cx: number; cy: number } | null>(null);
  const [, force] = useState(0);

  // time range
  let t0 = Infinity, t1 = -Infinity;
  for (const e of p.entries) for (const t of [e.es, e.ef, e.as, e.af, e.bls, e.blf]) if (t != null) { if (t < t0) t0 = t; if (t > t1) t1 = t; }
  if (p.dataDate != null) { t0 = Math.min(t0, p.dataDate); t1 = Math.max(t1, p.dataDate); }
  if (!Number.isFinite(t0)) { t0 = Math.floor(Date.now() / 60000 / MIN_PER_DAY) * MIN_PER_DAY; t1 = t0 + 90 * MIN_PER_DAY; }
  t0 = Math.floor(t0 / MIN_PER_DAY - 14) * MIN_PER_DAY;
  t1 = Math.ceil(t1 / MIN_PER_DAY + 45) * MIN_PER_DAY;
  const ppm = p.pxPerDay / MIN_PER_DAY;
  const X = (t: number) => (t - t0) * ppm;
  const width = Math.max(size.w, (t1 - t0) * ppm);
  const height = p.entries.length * RH;

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: body.current!.clientWidth, h: body.current!.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (p.scrollTop != null && body.current && Math.abs(body.current.scrollTop - p.scrollTop) > 1) { echo.current = p.scrollTop; body.current.scrollTop = p.scrollTop; }
  }, [p.scrollTop]);
  // keep data date in view when data changes the first time
  const centered = useRef(false);
  useEffect(() => {
    if (centered.current || !body.current || p.dataDate == null || !p.entries.length) return;
    body.current.scrollLeft = Math.max(0, X(p.dataDate) - 120);
    centered.current = true;
  });

  // draw
  useEffect(() => {
    const c = canvas.current!, h = headCanvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr; c.height = size.h * dpr; c.style.width = size.w + 'px'; c.style.height = size.h + 'px';
    h.width = size.w * dpr; h.height = 34 * dpr; h.style.width = size.w + 'px'; h.style.height = '34px';
    const g = c.getContext('2d')!, hg = h.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); hg.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    const sx = scroll.x, sy = scroll.y;
    const vt0 = t0 + sx / ppm, vt1 = t0 + (sx + size.w) / ppm;

    // non-work shading
    if (p.pxPerDay >= 3 && st.shadeNonWork) {
      g.fillStyle = '#f0f0f0';
      for (let d = Math.floor(vt0 / MIN_PER_DAY) * MIN_PER_DAY; d < vt1; d += MIN_PER_DAY) {
        const off = p.calendar ? p.calendar.shiftsOn(d / MIN_PER_DAY).length === 0 : weekday(d) === 0 || weekday(d) === 6;
        if (off) g.fillRect(X(d) - sx, 0, p.pxPerDay, size.h);
      }
    }
    // timescale header
    hg.fillStyle = '#f2f2f2'; hg.fillRect(0, 0, size.w, 34);
    hg.strokeStyle = '#a0a0a0'; hg.fillStyle = '#000'; hg.font = '11px Tahoma, Segoe UI, sans-serif'; hg.textBaseline = 'middle';
    const tiers = p.pxPerDay >= 14 ? ['month', 'day'] : p.pxPerDay >= 2.5 ? ['month', 'week'] : p.pxPerDay >= 0.6 ? ['year', 'month'] : ['year', 'quarter'];
    tiers.forEach((tier, ti) => {
      const y0 = ti * 17;
      let d = startOfUnit(vt0, tier);
      while (d < vt1) {
        const n = nextUnit(d, tier);
        const x0 = X(d) - sx, x1 = X(n) - sx;
        hg.beginPath(); hg.moveTo(Math.round(x0) + .5, y0); hg.lineTo(Math.round(x0) + .5, y0 + 17); hg.stroke();
        const label = unitLabel(d, tier, x1 - x0);
        if (label) { hg.save(); hg.beginPath(); hg.rect(x0, y0, x1 - x0, 17); hg.clip(); hg.fillText(label, Math.max(x0, 0) + 3, y0 + 9); hg.restore(); }
        d = n;
      }
      hg.beginPath(); hg.moveTo(0, y0 + 17.5); hg.lineTo(size.w, y0 + 17.5); hg.stroke();
    });

    const first = Math.max(0, Math.floor(sy / RH) - 1), last = Math.min(p.entries.length, Math.ceil((sy + size.h) / RH) + 1);
    const rowOf = new Map<string, number>();
    p.entries.forEach((e, i) => rowOf.set(e.key, i));

    // rows
    for (let i = first; i < last; i++) {
      const e = p.entries[i];
      const y = i * RH - sy;
      if (p.selected?.has(e.key)) { g.fillStyle = '#dbe6f7'; g.fillRect(0, y, size.w, RH); }
      if (st.gridLines) { g.strokeStyle = '#eeeeee'; g.beginPath(); g.moveTo(0, y + RH - .5); g.lineTo(size.w, y + RH - .5); g.stroke(); }
      const mid = y + RH / 2;
      if (e.kind === 'group') {
        if (e.es == null || e.ef == null || !st.showSummary) continue;
        const x0 = X(e.es) - sx, x1 = X(e.ef) - sx;
        g.fillStyle = st.summary;
        g.fillRect(x0, mid - 3, Math.max(1, x1 - x0), 4);
        tri(g, x0, mid + 1, 4); tri(g, x1, mid + 1, 4);
        continue;
      }
      // baseline (thin yellow bar under)
      if (p.showBaseline && st.showBaseline && e.bls != null && e.blf != null) {
        const x0 = X(e.bls) - sx, x1 = X(e.blf) - sx;
        g.fillStyle = st.baseline; g.strokeStyle = '#806f00';
        g.fillRect(x0, mid + 3, Math.max(2, x1 - x0), 4); g.strokeRect(x0 + .5, mid + 3.5, Math.max(2, x1 - x0) - 1, 3);
      }
      const remColor = e.critical ? st.critical : st.remaining;
      if (e.milestone) {
        const t = e.af ?? e.as ?? e.es;
        if (t == null) continue;
        diamond(g, X(t) - sx, mid - 1, 5, e.af != null || e.as != null ? st.actual : e.critical ? st.critical : st.milestone);
        if (e.label && st.label !== 'none' && p.pxPerDay >= 1) { g.fillStyle = '#000'; g.font = '11px Tahoma, Segoe UI, sans-serif'; g.textBaseline = 'middle'; g.fillText(e.label, X(t) - sx + 8, mid - 1); }
        continue;
      }
      // actual
      if (e.as != null) {
        const aEnd = e.af ?? p.dataDate ?? e.as;
        const x0 = X(e.as) - sx, x1 = X(Math.max(aEnd, e.as)) - sx;
        g.fillStyle = st.actual; g.fillRect(x0, mid - 1 - Math.ceil(bh / 2), Math.max(1, x1 - x0), bh);
      }
      // remaining
      if (e.af == null && e.es != null && e.ef != null) {
        const x0 = X(e.es) - sx, x1 = X(e.ef) - sx;
        g.fillStyle = remColor; g.fillRect(x0, mid - 1 - Math.ceil(bh / 2), Math.max(2, x1 - x0), bh);
      }
      if (e.label && st.label !== 'none' && p.pxPerDay >= 1) {
        const end = e.af ?? e.ef ?? e.es;
        if (end != null) { g.fillStyle = '#000'; g.font = '11px Tahoma, Segoe UI, sans-serif'; g.textBaseline = 'middle'; g.fillText(e.label, X(end) - sx + 6, mid - 1); }
      }
    }

    // relationship lines
    if (p.showLinks) {
      const lo = first - 60, hi = last + 60;
      for (const l of p.links) {
        const a = rowOf.get(l.from), b = rowOf.get(l.to);
        if (a == null || b == null || (a < lo && b < lo) || (a > hi && b > hi)) continue;
        const ea = p.entries[a], eb = p.entries[b];
        const fromStart = l.type === 'PR_SS' || l.type === 'PR_SF';
        const toFinish = l.type === 'PR_FF' || l.type === 'PR_SF';
        const ta = fromStart ? (ea.as ?? ea.es) : (ea.af ?? ea.ef);
        const tb = toFinish ? (eb.af ?? eb.ef) : (eb.as ?? eb.es);
        if (ta == null || tb == null) continue;
        const x1 = X(ta) - sx, y1 = a * RH - sy + RH / 2 - 1, x2 = X(tb) - sx, y2 = b * RH - sy + RH / 2 - 1;
        g.strokeStyle = l.critical && l.driving ? st.criticalLink : st.link;
        g.setLineDash(l.driving ? [] : [2, 2]);
        g.lineWidth = 1;
        g.beginPath();
        const ex = fromStart ? x1 - 4 : x1 + 4;
        g.moveTo(x1, y1); g.lineTo(ex, y1);
        const yMid = b > a ? y2 - 6 : y2 + 6;
        if ((!toFinish && x2 - 4 >= ex) || (toFinish && x2 + 4 <= ex && false)) { g.lineTo(ex, y2); g.lineTo(x2, y2); }
        else { g.lineTo(ex, yMid); const ix = toFinish ? x2 + 6 : x2 - 6; g.lineTo(ix, yMid); g.lineTo(ix, y2); g.lineTo(x2, y2); }
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = g.strokeStyle;
        g.beginPath(); if (toFinish) { g.moveTo(x2, y2); g.lineTo(x2 + 4, y2 - 3); g.lineTo(x2 + 4, y2 + 3); } else { g.moveTo(x2, y2); g.lineTo(x2 - 4, y2 - 3); g.lineTo(x2 - 4, y2 + 3); }
        g.fill();
      }
    }

    // data date
    if (p.dataDate != null && st.showDataDate) {
      const x = Math.round(X(p.dataDate) - sx) + .5;
      g.strokeStyle = st.dataDate; g.setLineDash([4, 2]); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, size.h); g.stroke(); g.setLineDash([]); g.lineWidth = 1;
      hg.fillStyle = st.dataDate; hg.beginPath(); hg.moveTo(x - 4, 28); hg.lineTo(x + 4, 28); hg.lineTo(x, 34); hg.fill();
    }
    // drag-to-link rubber band
    if (drag.current) {
      const d = drag.current;
      g.strokeStyle = '#000'; g.setLineDash([3, 2]); g.beginPath(); g.moveTo(d.x - sx, d.y - sy); g.lineTo(d.cx, d.cy); g.stroke(); g.setLineDash([]);
    }
  });

  const hit = (cx: number, cy: number) => {
    const i = Math.floor((cy + scroll.y) / RH);
    const e = p.entries[i];
    if (!e || e.kind !== 'task') return null;
    const s = e.as ?? e.es, f = e.af ?? e.ef ?? s;
    if (s == null || f == null) return { e, onBar: false };
    const x = cx + scroll.x;
    return { e, onBar: x >= X(s) - 6 && x <= X(f) + 6, endX: X(f), y: i * RH + RH / 2 };
  };
  const local = (ev: React.MouseEvent) => { const r = body.current!.getBoundingClientRect(); return { cx: ev.clientX - r.left, cy: ev.clientY - r.top }; };
  const actions: GanttActions = {
    zoomToFit: () => { if (Number.isFinite(t0) && t1 > t0) p.onZoom?.(Math.max(0.15, Math.min(60, size.w / ((t1 - t0) / MIN_PER_DAY)))); if (body.current) body.current.scrollLeft = 0; },
    goToDataDate: () => { if (body.current && p.dataDate != null) body.current.scrollLeft = Math.max(0, X(p.dataDate) - 120); },
    goToKey: (key) => {
      const i = p.entries.findIndex((e) => e.key === key), e = p.entries[i];
      const t = e && (e.as ?? e.es ?? e.bls);
      if (!body.current || !e) return;
      if (t != null) body.current.scrollLeft = Math.max(0, X(t) - 120);
      if (i * RH < body.current.scrollTop || (i + 1) * RH > body.current.scrollTop + body.current.clientHeight) body.current.scrollTop = Math.max(0, i * RH - body.current.clientHeight / 2);
    },
  };
  // Ctrl + mouse wheel zooms around the pointer (native listener: React's wheel handler cannot prevent page zoom)
  const zoomRef = useRef({ ppm, t0, onZoom: p.onZoom, pxPerDay: p.pxPerDay });
  zoomRef.current = { ppm, t0, onZoom: p.onZoom, pxPerDay: p.pxPerDay };
  useEffect(() => {
    const el = body.current!;
    const wheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const z = zoomRef.current;
      const nx = Math.max(0.15, Math.min(60, z.pxPerDay * (ev.deltaY < 0 ? 1.25 : 0.8)));
      const r = el.getBoundingClientRect(), px = ev.clientX - r.left;
      const tAt = z.t0 + (el.scrollLeft + px) / z.ppm; // keep the date under the pointer in place
      z.onZoom?.(nx);
      requestAnimationFrame(() => { el.scrollLeft = Math.max(0, (tAt - z.t0) * (nx / MIN_PER_DAY) - px); });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  return (
    <div className="gantt" ref={wrap}>
      <div className="gantt-head" style={{ height: 34 }}><canvas ref={headCanvas} /></div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <canvas ref={canvas} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} />
        <div className="gantt-body" ref={body} style={{ position: 'absolute', inset: 0 }}
          onScroll={(e) => { const t = e.currentTarget; setScroll({ x: t.scrollLeft, y: t.scrollTop }); if (echo.current != null && Math.abs(t.scrollTop - echo.current) <= 1) echo.current = null; else { echo.current = null; p.onScroll?.(t.scrollTop); } }}
          onMouseDown={(ev) => {
            const { cx, cy } = local(ev);
            const h = hit(cx, cy);
            if (!h) return;
            p.onSelect?.(h.e.key, { ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey });
            if (h.onBar && !ev.ctrlKey && !ev.shiftKey && p.onLink && h.endX != null) drag.current = { from: h.e.key, x: h.endX, y: h.y!, cx, cy };
          }}
          onMouseMove={(ev) => {
            const { cx, cy } = local(ev);
            if (drag.current) { drag.current.cx = cx; drag.current.cy = cy; force((n) => n + 1); return; }
            const h = hit(cx, cy);
            setTip(h?.onBar && h.e.tip ? { x: ev.clientX + 12, y: ev.clientY + 14, text: h.e.tip } : null);
          }}
          onMouseUp={(ev) => {
            const d = drag.current;
            drag.current = null;
            if (!d) return;
            const { cx, cy } = local(ev);
            const h = hit(cx, cy);
            if (h && h.e.key !== d.from && Math.abs(cx + scroll.x - d.x) + Math.abs(cy + scroll.y - d.y) > 8) p.onLink?.(d.from, h.e.key);
            force((n) => n + 1);
          }}
          onContextMenu={(ev) => { const { cx, cy } = local(ev); const i = Math.floor((cy + scroll.y) / RH); const e = p.entries[i]; if (e && e.kind === 'task' && !p.selected?.has(e.key)) p.onSelect?.(e.key); p.onContextMenu?.(e?.kind === 'task' ? e.key : null, ev, actions); }}
          onMouseLeave={() => setTip(null)}>
          <div style={{ width, height: Math.max(height, 1) }} />
        </div>
      </div>
      {tip && <div className="gantt-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

function tri(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.beginPath(); g.moveTo(x - s, y); g.lineTo(x + s, y); g.lineTo(x, y + s); g.fill();
}
function diamond(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  g.fillStyle = color; g.strokeStyle = '#000';
  g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath(); g.fill(); g.stroke();
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ymd(t: number) { const d = new Date(t * 60000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; }
function startOfUnit(t: number, unit: string): number {
  const { y, m } = ymd(t);
  if (unit === 'day') return Math.floor(t / MIN_PER_DAY) * MIN_PER_DAY;
  if (unit === 'week') { const d = Math.floor(t / MIN_PER_DAY) * MIN_PER_DAY; return d - ((weekday(d) + 6) % 7) * MIN_PER_DAY; }
  if (unit === 'month') return Date.UTC(y, m, 1) / 60000;
  if (unit === 'quarter') return Date.UTC(y, m - (m % 3), 1) / 60000;
  return Date.UTC(y, 0, 1) / 60000;
}
function nextUnit(t: number, unit: string): number {
  const { y, m } = ymd(t);
  if (unit === 'day') return t + MIN_PER_DAY;
  if (unit === 'week') return t + 7 * MIN_PER_DAY;
  if (unit === 'month') return Date.UTC(y, m + 1, 1) / 60000;
  if (unit === 'quarter') return Date.UTC(y, m + 3, 1) / 60000;
  return Date.UTC(y + 1, 0, 1) / 60000;
}
function unitLabel(t: number, unit: string, w: number): string {
  const { y, m, d } = ymd(t);
  if (unit === 'day') return w > 14 ? String(d) : '';
  if (unit === 'week') return w > 18 ? String(d).padStart(2, '0') : '';
  if (unit === 'month') return w > 60 ? `${MON[m]} ${y}` : w > 24 ? MON[m] : MON[m][0];
  if (unit === 'quarter') return w > 20 ? `Q${Math.floor(m / 3) + 1}` : '';
  return String(y);
}

export const toMin = (s: string | undefined) => parseP6Date(s);
export const fmtTip = (t: number | null | undefined) => (t == null ? '' : formatP6Date(t));
