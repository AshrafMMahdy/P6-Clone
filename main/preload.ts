import { contextBridge, ipcRenderer } from 'electron';

export interface OpenedFile { path: string; name: string; bytes: Uint8Array }
export interface Filter { name: string; extensions: string[] }

const api = {
  onMenu: (cb: (id: string) => void) => { ipcRenderer.on('menu', (_e, id: string) => cb(id)); },
  openFile: (filters: Filter[], title?: string): Promise<OpenedFile | null> => ipcRenderer.invoke('file:open', filters, title),
  saveFile: (name: string, bytes: Uint8Array, filters: Filter[]): Promise<string | null> => ipcRenderer.invoke('file:save', name, bytes, filters),
  loadDb: (): Promise<string | null> => ipcRenderer.invoke('db:load'),
  saveDb: (json: string): Promise<boolean> => ipcRenderer.invoke('db:save', json),
  print: (landscape: boolean): Promise<boolean> => ipcRenderer.invoke('print', landscape),
  pdf: (name: string, landscape: boolean): Promise<string | null> => ipcRenderer.invoke('pdf', name, landscape),
  startupImport: (): Promise<OpenedFile | null> => ipcRenderer.invoke('startup:import'),
  confirm: (message: string, detail?: string): Promise<boolean> => ipcRenderer.invoke('confirm', message, detail),
};

export type P6Api = typeof api;
contextBridge.exposeInMainWorld('p6', api);
