import { useRef, useState, type ReactNode, type MouseEvent as RME, useEffect, createContext, useContext } from 'react';
import { closeDialog } from '../store.ts';

/** Two panes with a draggable splitter. dir 'v' stacks vertically. */
export function Split(p: { dir: 'h' | 'v'; initial: number; min?: number; children: [ReactNode, ReactNode]; storeKey?: string }) {
  const key = p.storeKey ? `split:${p.storeKey}` : '';
  const [size, setSize] = useState<number>(() => (key && Number(localStorage.getItem(key))) || p.initial);
  const ref = useRef<HTMLDivElement>(null);
  const start = (e: RME) => {
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const v = p.dir === 'h' ? ev.clientX - box.left : ev.clientY - box.top;
      const max = (p.dir === 'h' ? box.width : box.height) - (p.min ?? 60);
      const s = Math.max(p.min ?? 60, Math.min(max, v));
      setSize(s);
      if (key) localStorage.setItem(key, String(s));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div ref={ref} className={p.dir === 'h' ? 'split-h' : 'split-v'}>
      <div style={{ [p.dir === 'h' ? 'width' : 'height']: size, flex: 'none', display: 'flex', minWidth: 0, minHeight: 0 }}>{p.children[0]}</div>
      <div className={p.dir === 'h' ? 'splitter-v' : 'splitter-h'} onMouseDown={start} />
      <div style={{ flex: 1, display: 'flex', minWidth: 0, minHeight: 0 }}>{p.children[1]}</div>
    </div>
  );
}

/** P6-style modal dialog. Buttons default to a right-hand vertical column. */
/** False for dialogs lower in the stack: they stay mounted but ignore keys. */
export const DialogTop = createContext(true);

export function Dialog(p: { title: string; children: ReactNode; buttons?: ReactNode; width?: number; height?: number; bottomButtons?: boolean; className?: string; onClose?: () => void }) {
  const close = p.onClose ?? closeDialog;
  const top = useContext(DialogTop);
  useEffect(() => {
    if (!top) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [close, top]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.stopPropagation()}>
      <div className={`dialog ${p.className ?? ''}`} style={{ width: p.width, height: p.height }} role="dialog" aria-label={p.title}>
        <div className="dialog-title"><span>{p.title}</span><span className="x" onClick={close}>×</span></div>
        <div className="dialog-main" style={{ flexDirection: p.bottomButtons ? 'column' : 'row' }}>
          <div className="dialog-content">{p.children}</div>
          {p.buttons && <div className={`dialog-buttons ${p.bottomButtons ? 'bottom' : ''}`}>{p.buttons}</div>}
        </div>
      </div>
    </div>
  );
}

export function Tabs(p: { tabs: [string, string][]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs">
      {p.tabs.map(([id, label]) => <div key={id} className={`tab ${p.value === id ? 'on' : ''}`} onClick={() => p.onChange(id)}>{label}</div>)}
    </div>
  );
}

export interface MenuItem { label: string; onClick?: () => void; sep?: boolean; checked?: boolean; disabled?: boolean }
let ctxSet: ((m: { x: number; y: number; items: MenuItem[] } | null) => void) | null = null;
export function showContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]): void {
  e.preventDefault();
  ctxSet?.({ x: e.clientX, y: e.clientY, items });
}
export function ContextMenuHost() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  ctxSet = setM;
  useEffect(() => {
    if (!m) return;
    const off = () => setM(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setM(null); } };
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', off);
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', off); };
  }, [m]);
  if (!m) return null;
  return (
    <div className="ctxmenu" style={{ left: Math.min(m.x, window.innerWidth - 240), top: Math.min(m.y, window.innerHeight - 24 * m.items.length - 10) }} onMouseDown={(e) => e.stopPropagation()}>
      {m.items.map((it, i) => (it.sep ? <hr key={i} /> : <div key={i} className={it.disabled ? 'disabled' : ''} onClick={() => { if (it.disabled) return; setM(null); it.onClick?.(); }}><span className="chk">{it.checked ? '✓' : ''}</span>{it.label}</div>))}
    </div>
  );
}
