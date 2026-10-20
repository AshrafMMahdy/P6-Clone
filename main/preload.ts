import { contextBridge, ipcRenderer } from 'electron';
import type { AiConfig, AiPublicConfig, ChatReply, ChatRequest } from './ai.ts';

export interface OpenedFile { path: string; name: string; bytes: Uint8Array }
export interface Filter { name: string; extensions: string[] }

// The database crosses between the processes in batches of lines (one message has a size cap, and everything passed
// to or from the window is copied: a batch at a time, never the whole database). Saves are queued so two never
// interleave.
let saving: Promise<boolean> = Promise.resolve(true);
/** Hands the database file to onLines batch by batch. False when there is no database file. */
async function loadDb(onLines: (lines: string[]) => void): Promise<boolean> {
  if (!(await ipcRenderer.invoke('db:loadBegin'))) return false;
  for (let b: string[] | null; (b = await ipcRenderer.invoke('db:loadBatch')) !== null;) onLines(b);
  return true;
}
/** Writes the batches next() gives until it gives null; false from next() abandons the save (the old file stays). */
async function writeDb(next: () => string[] | null | false): Promise<boolean> {
  await ipcRenderer.invoke('db:saveBegin');
  for (;;) {
    const b = next();
    if (b === false) { await ipcRenderer.invoke('db:saveAbort'); return false; }
    if (b === null) return ipcRenderer.invoke('db:saveEnd');
    await ipcRenderer.invoke('db:saveLines', b);
  }
}

const api = {
  onMenu: (cb: (id: string) => void) => { ipcRenderer.on('menu', (_e, id: string) => cb(id)); },
  openFile: (filters: Filter[], title?: string): Promise<OpenedFile | null> => ipcRenderer.invoke('file:open', filters, title),
  saveFile: (name: string, bytes: Uint8Array, filters: Filter[]): Promise<string | null> => ipcRenderer.invoke('file:save', name, bytes, filters),
  loadDb,
  saveDb: (next: () => string[] | null | false): Promise<boolean> => (saving = saving.then(() => writeDb(next), () => writeDb(next))),
  print: (landscape: boolean): Promise<boolean> => ipcRenderer.invoke('print', landscape),
  printPreview: (landscape: boolean): Promise<boolean> => ipcRenderer.invoke('print:preview', landscape),
  pdf: (name: string, landscape: boolean): Promise<string | null> => ipcRenderer.invoke('pdf', name, landscape),
  printHtml: (html: string, mode: 'print' | 'pdf' | 'preview', defaultName: string): Promise<boolean | string | null> => ipcRenderer.invoke('print:html', html, mode, defaultName),
  startupImport: (): Promise<OpenedFile | null> => ipcRenderer.invoke('startup:import'),
  confirm: (message: string, detail?: string): Promise<boolean> => ipcRenderer.invoke('confirm', message, detail),
  /** the schedule reasoner (models/reasoner.onnx), run in the main process */
  hrmInfer: (x: { n: number; feats: Float32Array; bias: Float32Array; modeMask: Uint8Array }): Promise<{ ok: true; out: { priority: Float32Array; modeLogits: Float32Array } } | { ok: false; error: string; unavailable: boolean }> => ipcRenderer.invoke('hrm:infer', x),
  /** AI assistant (the API key stays in the main process) */
  aiGetConfig: (): Promise<AiPublicConfig> => ipcRenderer.invoke('ai:getConfig'),
  menuTree: (): Promise<{ label: string; id?: string; accelerator?: string; submenu?: unknown[] }[]> => ipcRenderer.invoke('menu:tree'),
  aiSetConfig: (c: AiConfig, apiKey?: string): Promise<AiPublicConfig> => ipcRenderer.invoke('ai:setConfig', c, apiKey),
  aiChat: (id: string, req: ChatRequest): Promise<{ ok: true; reply: ChatReply } | { ok: false; error: string }> => ipcRenderer.invoke('ai:chat', id, req),
  aiCancel: (id: string): Promise<boolean> => ipcRenderer.invoke('ai:cancel', id),
  aiChatLoad: (key: string): Promise<unknown[]> => ipcRenderer.invoke('ai:chatLoad', key),
  aiChatAppend: (key: string, entries: unknown[]): Promise<void> => ipcRenderer.invoke('ai:chatAppend', key, entries),
  aiChatClear: (key: string): Promise<void> => ipcRenderer.invoke('ai:chatClear', key),
  aiChatMove: (from: string, to: string): Promise<void> => ipcRenderer.invoke('ai:chatMove', from, to),
  onAiConfig: (cb: (c: AiPublicConfig) => void) => { ipcRenderer.on('ai:config', (_e, c: AiPublicConfig) => cb(c)); },
  /** .mpp bytes -> Microsoft Project XML bytes, converted by the installed Microsoft Project. Rejects with the bridge error. */
  mppToXml: (bytes: Uint8Array): Promise<Uint8Array> => ipcRenderer.invoke('msp:mppToXml', bytes),
  /** Ask for an .mpp path and save Microsoft Project XML bytes there through Microsoft Project. Null when cancelled. */
  xmlToMpp: (defaultName: string, xmlBytes: Uint8Array): Promise<string | null> => ipcRenderer.invoke('msp:xmlToMpp', defaultName, xmlBytes),
};

export type P6Api = typeof api;
contextBridge.exposeInMainWorld('p6', api);
