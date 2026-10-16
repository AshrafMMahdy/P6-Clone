import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent as RME } from 'react';

export interface GridCol { id: string; title: string; width: number; align?: 'left' | 'right' | 'center' }
export interface GridItem {
  key: string;
  kind: 'row' | 'group';
  level: number;
  cells: Record<string, ReactNode>;
  /** for groups: label shown across the first columns */
  label?: ReactNode;
  icon?: ReactNode;
  collapsed?: boolean;
  hasChildren?: boolean;
  className?: string;
  style?: React.CSSProperties;
}
export interface EditorSpec { type: 'text' | 'number' | 'date' | 'select'; value: string; options?: Record<string, string> }

export interface GridProps {
  cols: GridCol[];
  items: GridItem[];
  selected?: Set<string>;
  onSelect?: (key: string, e: { ctrlKey: boolean; shiftKey: boolean }) => void;
  onToggle?: (key: string) => void;
  onActivate?: (key: string) => void;
  getEditor?: (key: string, colId: string) => EditorSpec | null;
  onCommit?: (key: string, colId: string, value: string) => void;
  onContextMenu?: (key: string | null, e: RME) => void;
  onScroll?: (top: number) => void;
  scrollTop?: number;
  /** click a column header to sort by it (P6: ascending, then descending) */
  onHeaderClick?: (colId: string) => void;
  sortCol?: { id: string; desc: boolean };
  onResize?: (colId: string, width: number) => void;
  rowHeight?: number;
  /** column whose cells get the tree indent */
  treeCol?: string;
  /** columns the group label spans */
  labelSpan?: number;
  emptyText?: string;
}

const RH = 19;

export function Grid(p: GridProps) {
  const rh = p.rowHeight ?? RH;
  const scroll = useRef<HTMLDivElement>(null);
  const echo = useRef<number | null>(null); // position we scrolled to on request (its scroll event is not reported back)
  const head = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 400 });
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<{ key: string; col: string; spec: EditorSpec } | null>(null);
  const cols = p.cols.map((c) => ({ ...c, width: widths[c.id] ?? c.width }));
  const total = cols.reduce((a, c) => a + c.width, 0);
  const treeCol = p.treeCol ?? cols[0]?.id;

  useLayoutEffect(() => {
    const el = scroll.current!;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (p.scrollTop != null && scroll.current && Math.abs(scroll.current.scrollTop - p.scrollTop) > 1) { echo.current = p.scrollTop; scroll.current.scrollTop = p.scrollTop; }
  }, [p.scrollTop]);

  const first = Math.max(0, Math.floor(view.top / rh) - 5);
  const last = Math.min(p.items.length, Math.ceil((view.top + view.height) / rh) + 5);

  const startResize = (e: RME, id: string, w: number) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX;
    let nw = w;
    const move = (ev: MouseEvent) => { nw = Math.max(24, w + ev.clientX - x0); setWidths((s) => ({ ...s, [id]: nw })); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); p.onResize?.(id, nw); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const beginEdit = (key: string, col: string) => {
    const spec = p.getEditor?.(key, col);
    if (spec) setEditing({ key, col, spec });
  };
  const commit = (value: string) => {
    if (editing) p.onCommit?.(editing.key, editing.col, value);
    setEditing(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || !p.items.length) return;
    const sel = p.selected ? [...p.selected] : [];
    const idx = Math.max(0, p.items.findIndex((it) => it.key === sel[sel.length - 1]));
    let n = -1;
    if (e.key === 'ArrowDown') n = Math.min(p.items.length - 1, idx + 1);
    else if (e.key === 'ArrowUp') n = Math.max(0, idx - 1);
    else if (e.key === 'PageDown') n = Math.min(p.items.length - 1, idx + Math.floor(view.height / rh));
    else if (e.key === 'PageUp') n = Math.max(0, idx - Math.floor(view.height / rh));
    else if (e.key === 'Home' && e.ctrlKey) n = 0;
    else if (e.key === 'End' && e.ctrlKey) n = p.items.length - 1;
    else if (e.key === 'F2') { const c = cols.find((c) => p.getEditor?.(p.items[idx].key, c.id)); if (c) beginEdit(p.items[idx].key, c.id); e.preventDefault(); return; }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && p.items[idx].kind === 'group' && p.items[idx].hasChildren) {
      if ((e.key === 'ArrowLeft') !== !!p.items[idx].collapsed) p.onToggle?.(p.items[idx].key);
      e.preventDefault(); return;
    }
    if (n >= 0) {
      e.preventDefault();
      p.onSelect?.(p.items[n].key, { ctrlKey: false, shiftKey: e.shiftKey });
      const el = scroll.current!;
      if (n * rh < el.scrollTop) el.scrollTop = n * rh;
      else if ((n + 1) * rh > el.scrollTop + el.clientHeight) el.scrollTop = (n + 1) * rh - el.clientHeight;
    }
  };

  const renderCell = (it: GridItem, c: GridCol & { width: number }, ci: number, spanW?: number) => {
    const isEdit = editing && editing.key === it.key && editing.col === c.id;
    const indent = c.id === treeCol ? it.level * 12 : 0;
    let content: ReactNode = it.kind === 'group' && ci === 0 ? it.label : it.cells[c.id];
    if (c.id === treeCol) {
      content = <>
        {it.hasChildren ? <span className="twisty" onMouseDown={(e) => { e.stopPropagation(); p.onToggle?.(it.key); }}>{it.collapsed ? '+' : '−'}</span> : it.kind === 'group' ? <span className="twisty" style={{ visibility: 'hidden' }} /> : null}
        {it.icon}{content}
      </>;
    }
    return (
      <div key={c.id} className={`grid-cell c-${c.id} ${c.align === 'right' ? 'num' : ''}`}
        style={{ width: spanW ?? c.width, paddingLeft: 4 + indent, textAlign: c.align ?? 'left' }}
        onDoubleClick={(e) => { e.stopPropagation(); if (p.getEditor?.(it.key, c.id)) beginEdit(it.key, c.id); else p.onActivate?.(it.key); }}>
        {isEdit ? <Editor spec={editing.spec} onDone={commit} onCancel={() => setEditing(null)} /> : content}
      </div>
    );
  };

  return (
    <div className="grid" tabIndex={0} onKeyDown={onKey} onContextMenu={(e) => p.onContextMenu?.(null, e)}>
      <div className="grid-header" ref={head}>
        <div style={{ display: 'flex', width: total, minHeight: 32 }}>
          {cols.map((c) => (
            <div key={c.id} className="grid-hcell" style={{ width: c.width, cursor: p.onHeaderClick ? 'pointer' : undefined }}
              onClick={(e) => { if (!(e.target as HTMLElement).classList.contains('rz')) p.onHeaderClick?.(c.id); }}>
              {c.title}{p.sortCol?.id === c.id ? (p.sortCol.desc ? ' ▼' : ' ▲') : ''}
              <div className="rz" onMouseDown={(e) => startResize(e, c.id, c.width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="grid-scroll" ref={scroll} onScroll={(e) => {
        const t = e.currentTarget;
        head.current!.scrollLeft = t.scrollLeft;
        setView({ top: t.scrollTop, height: t.clientHeight });
        // a scroll we were told to make (to follow the Gantt) is not reported back: that echo arrives late and would pull the Gantt back
        if (echo.current != null && Math.abs(t.scrollTop - echo.current) <= 1) echo.current = null; else { echo.current = null; p.onScroll?.(t.scrollTop); }
      }}>
        <div style={{ height: Math.max(p.items.length * rh, 1), width: total, position: 'relative' }}>
          {p.items.slice(first, last).map((it, i) => {
            const idx = first + i;
            const sel = p.selected?.has(it.key);
            const span = it.kind === 'group' ? Math.max(1, p.labelSpan ?? 2) : 1;
            const spanW = cols.slice(0, span).reduce((a, c) => a + c.width, 0);
            return (
              <div key={it.key} className={`grid-row ${it.kind === 'group' ? 'group' : ''} ${sel ? 'sel' : ''} ${it.className ?? ''}`}
                style={{ top: idx * rh, height: rh, width: total, ...it.style }}
                onMouseDown={(e) => { if (e.button === 0 || !sel) p.onSelect?.(it.key, e); }}
                onContextMenu={(e) => { e.stopPropagation(); p.onContextMenu?.(it.key, e); }}>
                {it.kind === 'group'
                  ? [renderCell(it, cols[0], 0, spanW), ...cols.slice(span).map((c, j) => renderCell(it, c, j + span))]
                  : cols.map((c, ci) => renderCell(it, c, ci))}
              </div>
            );
          })}
        </div>
        {!p.items.length && <div className="empty">{p.emptyText ?? 'No items'}</div>}
      </div>
    </div>
  );
}

function Editor({ spec, onDone, onCancel }: { spec: EditorSpec; onDone: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(spec.type === 'date' ? spec.value.replace(' ', 'T').slice(0, 16) : spec.value);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => { ref.current?.focus(); if (spec.type === 'text' || spec.type === 'number') ref.current?.select(); }, [spec.type]);
  const key = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') onDone(v);
    if (e.key === 'Escape') onCancel();
  };
  if (spec.type === 'select') {
    return <select ref={ref} value={v} onChange={(e) => { setV(e.target.value); onDone(e.target.value); }} onBlur={() => onCancel()} onKeyDown={key}>
      {Object.entries(spec.options ?? {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>;
  }
  return <input ref={ref} type={spec.type === 'date' ? 'datetime-local' : spec.type === 'number' ? 'number' : 'text'} value={v}
    onChange={(e) => setV(e.target.value)} onBlur={() => onDone(v)} onKeyDown={key} onMouseDown={(e) => e.stopPropagation()} />;
}
