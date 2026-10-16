import { contextBridge, ipcRenderer } from 'electron';
import type { AiConfig, AiPublicConfig, ChatReply, ChatRequest } from './ai.ts';

export interface OpenedFile { path: string; name: string; bytes: Uint8Array }
export interface Filter { name: string; extensions: string[] }

// The database crosses from the main process in batches (one message between processes has a size cap); saves are
// queued so two never interleave.
const SAVE_BATCH = 32 * 1024 * 1024;
let saving: Promise<boolean> = Promise.resolve(true);
async function loadDb(): Promise<string[] | null> {
  const n: number | null = await ipcRenderer.invoke('db:loadBegin');
  if (n == null) return null;
  const out: string[] = [];
  for (let i = 0; i < n; i++) for (const l of (await ipcRenderer.invoke('db:loadBatch', i)) as string[]) out.push(l);
  return out;
}
async function writeDb(lines: string[]): Promise<boolean> {
  await ipcRenderer.invoke('db:saveBegin');
  let batch: string[] = [], size = 0;
  for (const l of lines) {
    batch.push(l); size += l.length;
    if (size >= SAVE_BATCH) { await ipcRenderer.invoke('db:saveLines', batch); batch = []; size = 0; }
  }
  if (batch.length) await ipcRenderer.invoke('db:saveLines', batch);
  return ipcRenderer.invoke('db:saveEnd');
}

const api = {
  onMenu: (cb: (id: string) => void) => { ipcRenderer.on('menu', (_e, id: string) => cb(id)); },
  openFile: (filters: Filter[], title?: string): Promise<OpenedFile | null> => ipcRenderer.invoke('file:open', filters, title),
  saveFile: (name: string, bytes: Uint8Array, filters: Filter[]): Promise<string | null> => ipcRenderer.invoke('file:save', name, bytes, filters),
  loadDb,
  saveDb: (lines: string[]): Promise<boolean> => (saving = saving.then(() => writeDb(lines), () => writeDb(lines))),
  print: (landscape: boolean): Promise<boolean> => ipcRenderer.invoke('print', landscape),
  printPreview: (landscape: boolean): Promise<boolean> => ipcRenderer.invoke('print:preview', landscape),
  pdf: (name: string, landscape: boolean): Promise<string | null> => ipcRenderer.invoke('pdf', name, landscape),
  startupImport: (): Promise<OpenedFile | null> => ipcRenderer.invoke('startup:import'),
  confirm: (message: string, detail?: string): Promise<boolean> => ipcRenderer.invoke('confirm', message, detail),
  /** AI assistant (the API key stays in the main process) */
  aiGetConfig: (): Promise<AiPublicConfig> => ipcRenderer.invoke('ai:getConfig'),
  menuTree: (): Promise<{ label: string; id?: string; accelerator?: string; submenu?: unknown[] }[]> => ipcRenderer.invoke('menu:tree'),
  aiSetConfig: (c: AiConfig, apiKey?: string): Promise<AiPublicConfig> => ipcRenderer.invoke('ai:setConfig', c, apiKey),
  aiChat: (id: string, req: ChatRequest): Promise<{ ok: true; reply: ChatReply } | { ok: false; error: string }> => ipcRenderer.invoke('ai:chat', id, req),
  aiCancel: (id: string): Promise<boolean> => ipcRenderer.invoke('ai:cancel', id),
  onAiConfig: (cb: (c: AiPublicConfig) => void) => { ipcRenderer.on('ai:config', (_e, c: AiPublicConfig) => cb(c)); },
  /** .mpp bytes -> Microsoft Project XML bytes, converted by the installed Microsoft Project. Rejects with the bridge error. */
  mppToXml: (bytes: Uint8Array): Promise<Uint8Array> => ipcRenderer.invoke('msp:mppToXml', bytes),
  /** Ask for an .mpp path and save Microsoft Project XML bytes there through Microsoft Project. Null when cancelled. */
  xmlToMpp: (defaultName: string, xmlBytes: Uint8Array): Promise<string | null> => ipcRenderer.invoke('msp:xmlToMpp', defaultName, xmlBytes),
};

export type P6Api = typeof api;
contextBridge.exposeInMainWorld('p6', api);
