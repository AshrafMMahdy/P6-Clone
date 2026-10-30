import { useSyncExternalStore } from 'react';
import type { BarStyles } from './components/Gantt.tsx';
import { record, rollback, type Journal } from '../core/journal.ts';
import { dbLines, DbReader } from '../core/db-file.ts';
import type { P6Api } from '../main/preload.ts';
import { emptyDb, type Db } from '../core/db.ts';
import { setColumnDb } from './model.ts';
import type { Finding } from '../core/findings.ts';

declare global { interface Window { p6: P6Api } }

export type ViewName = 'projects' | 'wbs' | 'activities' | 'resources' | 'assignments' | 'reports' | 'risk' | 'timesheets' | 'portfolios' | 'extensions';
export type BottomPane = 'details' | 'profile' | 'spreadsheet' | 'actProfile' | 'actSheet' | 'trace' | '4d' | 'none';

/** calendarDays: days on each activity's own calendar (core/project/units.ts) — set by the MCP server and the CLI;
 *  the desktop app leaves it off and shows every day at hoursPerDay (P6's default, "use assigned calendar" off). */
export interface Prefs { hoursPerDay: number; dateFormat: 'dd-MMM-yy' | 'yyyy-mm-dd' | 'mm/dd/yy' | 'dd/mm/yy'; showTime: boolean; durationDecimals: number; /** the financial periods whose columns the activity table offers (P6: User Preferences > Application), start days YYYY-MM-DD */ finPeriodFrom?: string; finPeriodTo?: string; calendarDays?: boolean }
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
  /** View > Show on Top: hide the activity table or the Gantt chart */
  hideTable?: boolean; hideGantt?: boolean;
  /** AI assistant panel expanded / widened */
  aiOpen?: boolean; aiWide?: boolean;
  /** scroll this activity into view once (Find, Go To) */
  revealTask?: string;
  /** the open panel of the Extensions window */
  extension?: string;
  /** Activity table column widths you dragged */
  colWidths?: Record<string, number>;
  /** View > Progress Spotlight: highlight the next update period after the data date */
  spotlight?: boolean;
  /** View > Bars (undefined = defaults) */
  bars?: BarStyles;
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
setColumnDb(getDb, () => state.ui.prefs);

export function setUi(patch: Partial<UiState> | ((u: UiState) => Partial<UiState>)): void {
  state.ui = { ...state.ui, ...(typeof patch === 'function' ? patch(state.ui) : patch) };
  const p0 = typeof patch === 'function' ? {} : patch;
  if ('prefs' in p0 || 'columns' in p0 || 'bars' in p0 || 'colWidths' in p0 || 'openProjects' in p0) scheduleSave();
  emit();
}

// ---- undo/redo + persistence
// Each step keeps only the values its change overwrote (core/journal.ts), not a copy of the database.
const undo: { label: string; j: Journal }[] = [];
const redo: { label: string; j: Journal }[] = [];

/** Change the database as one undoable action. */
export function mutate(label: string, fn: (db: Db) => void): void {
  const raw = state.db;
  let j: Journal;
  try { j = record(raw, (view) => { state.db = view; fn(view); }); } finally { state.db = raw; } // getDb() inside fn sees the recording view
  undo.push({ label, j });
  if (undo.length > 30) undo.shift();
  redo.length = 0;
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
  redo.push({ label: u.label, j: rollback(u.j) });
  state.dbVersion++; scheduleSave(); emit(); toast(`Undo: ${u.label}`);
}
export function doRedo(): void {
  const r = redo.pop();
  if (!r) return toast('Nothing to redo');
  undo.push({ label: r.label, j: rollback(r.j) });
  state.dbVersion++; scheduleSave(); emit(); toast(`Redo: ${r.label}`);
}
export const undoLabel = () => undo[undo.length - 1]?.label;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
export async function saveNow(): Promise<void> {
  clearTimeout(saveTimer);
  const { prefs, columns, layoutName, pxPerDay, bottom, bars, relLines, colWidths, hideTable, hideGantt, openProjects, view, groupBy, sortBy, filter } = state.ui;
  const db = state.db, version = state.dbVersion;
  const lines = dbLines(db, { prefs, columns, layoutName, pxPerDay, bottom, bars, relLines, colWidths, hideTable, hideGantt, openProjects, view, groupBy, sortBy, filter });
  // lines are made as they are sent (never all at once); a change in between would mix two states, so this save
  // stops and the save that change scheduled writes the file
  await window.p6?.saveDb(() => {
    if (state.db !== db || state.dbVersion !== version) return false;
    const batch: string[] = [];
    let size = 0;
    for (let r = lines.next(); !r.done; r = lines.next()) { batch.push(r.value); size += r.value.length; if (size >= SAVE_BATCH) break; }
    return batch.length ? batch : null;
  });
}
const SAVE_BATCH = 32 * 1024 * 1024; // characters per batch to the main process
export async function loadFromDisk(): Promise<void> {
  const reader = new DbReader();
  let error: unknown;
  // parsed batch by batch as it arrives: the file's text is never in memory whole
  const found = await window.p6?.loadDb((lines) => { if (!error) try { for (const l of lines) reader.add(l); } catch (e) { error = e; } });
  if (!found) return;
  try {
    if (error) throw error;
    const data = reader.finish();
    if (!data.db) return;
    state.db = data.db ?? emptyDb();
    if (data.ui) state.ui = { ...state.ui, ...(data.ui as object) };
    // reopen the projects that were open last time (those that still exist)
    const have = new Set((state.db.tables.PROJECT?.rows ?? []).map((p) => p.proj_id));
    state.ui.openProjects = (state.ui.openProjects ?? []).filter((id) => have.has(id));
    if (!state.ui.openProjects.length && state.ui.view !== 'resources') state.ui.view = 'projects';
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
