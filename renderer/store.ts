import { useSyncExternalStore } from 'react';
import type { P6Api } from '../main/preload.ts';
import { emptyDb, type Db } from '../core/db.ts';
import type { Finding } from '../core/findings.ts';

declare global { interface Window { p6: P6Api } }

export type ViewName = 'projects' | 'wbs' | 'activities' | 'resources' | 'assignments' | 'reports' | 'risk' | 'timesheets' | 'portfolios';
export type BottomPane = 'details' | 'profile' | 'spreadsheet' | 'none';

export interface Prefs { hoursPerDay: number; dateFormat: 'dd-MMM-yy' | 'yyyy-mm-dd' | 'mm/dd/yy' | 'dd/mm/yy'; showTime: boolean; durationDecimals: number }
export interface DialogState { kind: string; props?: Record<string, unknown> }

export interface UiState {
  view: ViewName;
  openProjects: string[];
  selProject?: string;
  selTask?: string;
  selTasks: string[];
  selWbs?: string;
  selRsrc?: string;
  collapsed: Record<string, boolean>;
  dialogs: DialogState[];
  bottom: BottomPane;
  detailTab: string;
  columns: string[];
  filter: string;
  groupBy: string;
  sortBy: string;
  pxPerDay: number;
  relLines: boolean;
  importLog?: { file: string; findings: Finding[] };
  scheduleLog?: string;
  levelLog?: string;
  prefs: Prefs;
  toast?: string;
  layoutName: string;
}

export const DEFAULT_COLUMNS = ['task_code', 'task_name', 'orig_dur', 'rem_dur', 'pct', 'start', 'finish', 'total_float'];

const state = {
  db: emptyDb() as Db,
  dbVersion: 0,
  ui: {
    view: 'projects', openProjects: [], selTasks: [], collapsed: {}, dialogs: [], bottom: 'details', detailTab: 'general',
    columns: DEFAULT_COLUMNS, filter: 'all', groupBy: 'wbs', sortBy: '', pxPerDay: 6, relLines: true,
    prefs: { hoursPerDay: 8, dateFormat: 'dd-MMM-yy', showTime: false, durationDecimals: 0 }, layoutName: 'Classic Schedule Layout',
  } as UiState,
};

const listeners = new Set<() => void>();
let snapshot = { ...state };
function emit() { snapshot = { ...state }; for (const l of listeners) l(); }

export function useStore<T>(sel: (s: typeof state) => T): T {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(snapshot));
}
export const getDb = () => state.db;
export const getUi = () => state.ui;

export function setUi(patch: Partial<UiState> | ((u: UiState) => Partial<UiState>)): void {
  state.ui = { ...state.ui, ...(typeof patch === 'function' ? patch(state.ui) : patch) };
  if ('prefs' in (typeof patch === 'function' ? {} : patch) || 'columns' in (typeof patch === 'function' ? {} : patch)) scheduleSave();
  emit();
}

// ---- undo/redo + persistence
const undo: { label: string; db: Db }[] = [];
const redo: { label: string; db: Db }[] = [];

/** Change the database as one undoable action. */
export function mutate(label: string, fn: (db: Db) => void): void {
  undo.push({ label, db: structuredClone(state.db) });
  if (undo.length > 30) undo.shift();
  redo.length = 0;
  fn(state.db);
  state.dbVersion++;
  scheduleSave();
  emit();
}
/** Replace the whole database (load/reset); not undoable. */
export function replaceDb(db: Db): void {
  state.db = db;
  undo.length = 0; redo.length = 0;
  state.dbVersion++;
  scheduleSave();
  emit();
}
export function doUndo(): void {
  const u = undo.pop();
  if (!u) return toast('Nothing to undo');
  redo.push({ label: u.label, db: state.db });
  state.db = u.db; state.dbVersion++; scheduleSave(); emit(); toast(`Undo: ${u.label}`);
}
export function doRedo(): void {
  const r = redo.pop();
  if (!r) return toast('Nothing to redo');
  undo.push({ label: r.label, db: state.db });
  state.db = r.db; state.dbVersion++; scheduleSave(); emit(); toast(`Redo: ${r.label}`);
}
export const undoLabel = () => undo[undo.length - 1]?.label;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
export async function saveNow(): Promise<void> {
  clearTimeout(saveTimer);
  const { prefs, columns, layoutName, pxPerDay, bottom } = state.ui;
  await window.p6?.saveDb(JSON.stringify({ version: 1, db: state.db, ui: { prefs, columns, layoutName, pxPerDay, bottom } }));
}
export async function loadFromDisk(): Promise<void> {
  const json = await window.p6?.loadDb();
  if (!json) return;
  try {
    const data = JSON.parse(json);
    state.db = data.db ?? emptyDb();
    if (data.ui) state.ui = { ...state.ui, ...data.ui };
    state.dbVersion++;
    emit();
  } catch (e) {
    toast(`Database file could not be read: ${(e as Error).message}`);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string): void {
  clearTimeout(toastTimer);
  setUi({ toast: msg });
  toastTimer = setTimeout(() => setUi({ toast: undefined }), 3500);
}

export function openDialog(kind: string, props?: Record<string, unknown>): void {
  setUi((u) => ({ dialogs: [...u.dialogs, { kind, props }] }));
}
export function closeDialog(): void {
  setUi((u) => ({ dialogs: u.dialogs.slice(0, -1) }));
}
