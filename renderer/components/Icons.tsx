// Small inline SVG icons in the spirit of P6's toolbar.
import type { JSX } from 'react';

const S = (p: { children: JSX.Element | JSX.Element[]; v?: string }) => <svg viewBox={p.v ?? '0 0 16 16'}>{p.children}</svg>;

export const Icon: Record<string, () => JSX.Element> = {
  open: () => <S><path d="M1 4h5l1 1h7v8H1z" fill="#f5d36b" stroke="#a07a10" /><path d="M2 7h13l-2 6H1z" fill="#fbe7a1" stroke="#a07a10" /></S>,
  import: () => <S><rect x="2" y="2" width="9" height="12" fill="#fff" stroke="#555" /><path d="M8 8h7M12 5l3 3-3 3" stroke="#1a7f1a" strokeWidth="2" fill="none" /></S>,
  export: () => <S><rect x="5" y="2" width="9" height="12" fill="#fff" stroke="#555" /><path d="M1 8h8M5 5L1 8l4 3" stroke="#1f5fbf" strokeWidth="2" fill="none" /></S>,
  print: () => <S><rect x="3" y="1" width="10" height="5" fill="#fff" stroke="#555" /><rect x="1" y="6" width="14" height="6" fill="#bbb" stroke="#555" /><rect x="4" y="10" width="8" height="5" fill="#fff" stroke="#555" /></S>,
  undo: () => <S><path d="M4 6h6a4 4 0 010 8H6" stroke="#1f5fbf" strokeWidth="2" fill="none" /><path d="M1 6l4-4v8z" fill="#1f5fbf" /></S>,
  redo: () => <S><path d="M12 6H6a4 4 0 000 8h4" stroke="#1f5fbf" strokeWidth="2" fill="none" /><path d="M15 6l-4-4v8z" fill="#1f5fbf" /></S>,
  add: () => <S><rect x="1" y="4" width="11" height="7" fill="#7ac943" stroke="#3a7a1a" /><path d="M13 2v6M10 5h6" stroke="#c00" strokeWidth="2" /></S>,
  del: () => <S><path d="M3 3l10 10M13 3L3 13" stroke="#c00" strokeWidth="2.5" /></S>,
  link: () => <S><rect x="1" y="2" width="6" height="4" fill="#7ac943" stroke="#3a7a1a" /><rect x="9" y="10" width="6" height="4" fill="#7ac943" stroke="#3a7a1a" /><path d="M7 4h3v6" stroke="#000" fill="none" /><path d="M8 9l2 2 2-2" stroke="#000" fill="none" /></S>,
  schedule: () => <S><rect x="1" y="2" width="14" height="13" fill="#fff" stroke="#555" /><rect x="1" y="2" width="14" height="3" fill="#c33" /><path d="M4 8h5M6 11h7" stroke="#2c7" strokeWidth="2" /></S>,
  level: () => <S><path d="M1 14h14" stroke="#555" /><rect x="2" y="8" width="3" height="6" fill="#4a7fd0" /><rect x="6" y="6" width="3" height="8" fill="#4a7fd0" /><rect x="10" y="8" width="3" height="6" fill="#4a7fd0" /><path d="M1 6h14" stroke="#c00" strokeDasharray="2 1" /></S>,
  progress: () => <S><rect x="1" y="5" width="14" height="6" fill="#fff" stroke="#555" /><rect x="1" y="5" width="8" height="6" fill="#2a56c6" /><path d="M9 2v12" stroke="#1f5fbf" strokeDasharray="2 1" /></S>,
  columns: () => <S><rect x="1" y="2" width="14" height="12" fill="#fff" stroke="#555" /><path d="M5 2v12M9 2v12M1 5h14" stroke="#555" /></S>,
  filter: () => <S><path d="M1 2h14l-5 6v6l-4-2V8z" fill="#f5d36b" stroke="#a07a10" /></S>,
  group: () => <S><rect x="1" y="2" width="14" height="3" fill="#8faadc" /><rect x="3" y="6" width="12" height="3" fill="#b4c7e7" /><rect x="3" y="10" width="12" height="3" fill="#dae3f3" /></S>,
  zoomIn: () => <S><circle cx="6.5" cy="6.5" r="5" fill="#fff" stroke="#555" /><path d="M10 10l5 5M4 6.5h5M6.5 4v5" stroke="#333" strokeWidth="1.5" /></S>,
  zoomOut: () => <S><circle cx="6.5" cy="6.5" r="5" fill="#fff" stroke="#555" /><path d="M10 10l5 5M4 6.5h5" stroke="#333" strokeWidth="1.5" /></S>,
  baseline: () => <S><rect x="1" y="4" width="12" height="4" fill="#2c7" /><rect x="3" y="9" width="12" height="2" fill="#e8c91f" /></S>,
  lines: () => <S><rect x="1" y="2" width="5" height="3" fill="#7ac943" /><rect x="10" y="11" width="5" height="3" fill="#7ac943" /><path d="M6 3.5h2v9h2" stroke="#c00" fill="none" /></S>,
  expand: () => <S><rect x="2" y="2" width="12" height="12" fill="#fff" stroke="#555" /><path d="M5 8h6M8 5v6" stroke="#000" /></S>,
  collapse: () => <S><rect x="2" y="2" width="12" height="12" fill="#fff" stroke="#555" /><path d="M5 8h6" stroke="#000" /></S>,
  projects: () => <S v="0 0 26 26"><path d="M2 6h9l2 2h11v15H2z" fill="#f5d36b" stroke="#a07a10" /><rect x="6" y="12" width="14" height="2" fill="#a07a10" /><rect x="6" y="16" width="10" height="2" fill="#a07a10" /></S>,
  wbs: () => <S v="0 0 26 26"><rect x="9" y="2" width="8" height="5" fill="#4a7fd0" /><rect x="2" y="15" width="7" height="5" fill="#8faadc" /><rect x="17" y="15" width="7" height="5" fill="#8faadc" /><path d="M13 7v4H5v4M13 11h8v4" stroke="#333" fill="none" /></S>,
  activities: () => <S v="0 0 26 26"><rect x="2" y="4" width="10" height="4" fill="#2a56c6" /><rect x="8" y="11" width="14" height="4" fill="#2c7" /><rect x="14" y="18" width="10" height="4" fill="#c33" /><path d="M12 6h2v5M22 15h1v3" stroke="#000" fill="none" /></S>,
  resources: () => <S v="0 0 26 26"><circle cx="9" cy="8" r="4" fill="#e9b58a" stroke="#8a5a2a" /><path d="M2 22c0-6 3-9 7-9s7 3 7 9z" fill="#4a7fd0" /><circle cx="18" cy="9" r="3.5" fill="#e9b58a" stroke="#8a5a2a" /><path d="M13 22c0-5 2-8 5-8s6 3 6 8z" fill="#2c7" /></S>,
  assignments: () => <S v="0 0 26 26"><circle cx="7" cy="7" r="3.5" fill="#e9b58a" stroke="#8a5a2a" /><path d="M2 17c0-4 2-6 5-6s5 2 5 6z" fill="#4a7fd0" /><rect x="14" y="8" width="10" height="4" fill="#2c7" /><rect x="14" y="15" width="10" height="4" fill="#2a56c6" /><path d="M12 10h2M12 17h2" stroke="#000" /></S>,
  reports: () => <S v="0 0 26 26"><rect x="5" y="2" width="16" height="22" fill="#fff" stroke="#555" /><path d="M8 7h10M8 11h10M8 15h7" stroke="#555" /><rect x="8" y="18" width="3" height="3" fill="#4a7fd0" /><rect x="12" y="17" width="3" height="4" fill="#2c7" /><rect x="16" y="15" width="3" height="6" fill="#c33" /></S>,
  tracking: () => <S v="0 0 26 26"><rect x="2" y="2" width="22" height="22" fill="#fff" stroke="#555" /><path d="M5 19l5-6 4 3 7-9" stroke="#c33" strokeWidth="2" fill="none" /></S>,
  timesheets: () => <S v="0 0 26 26"><rect x="3" y="3" width="20" height="20" fill="#fff" stroke="#555" /><path d="M3 9h20M9 9v14M15 9v14" stroke="#999" /><circle cx="18" cy="18" r="5" fill="#fff" stroke="#1f5fbf" /><path d="M18 15v3l2 1" stroke="#1f5fbf" fill="none" /></S>,
  risk: () => <S v="0 0 26 26"><path d="M13 3l11 20H2z" fill="#f5d36b" stroke="#a07a10" /><path d="M13 10v7" stroke="#000" strokeWidth="2" /><circle cx="13" cy="20" r="1.2" /></S>,
  portfolios: () => <S v="0 0 26 26"><rect x="3" y="8" width="20" height="14" fill="#c9a36b" stroke="#6b4e1f" /><path d="M9 8V5h8v3" stroke="#6b4e1f" fill="none" /><rect x="6" y="12" width="6" height="2" fill="#2a56c6" /><rect x="10" y="16" width="9" height="2" fill="#2c7" /></S>,
  validate: () => <S><path d="M2 8l4 4 8-9" stroke="#1a7f1a" strokeWidth="2.5" fill="none" /></S>,
};
