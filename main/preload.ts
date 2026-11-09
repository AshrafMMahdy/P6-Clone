import { contextBridge, ipcRenderer } from 'electron';
import type { AiConfig, AiPublicConfig, ChatReply, ChatRequest, PublicModels } from './ai.ts';

export interface OpenedFile { path: string; name: string; bytes: Uint8Array }
export type WhiqResult<T> = { ok: true; data: T } | { ok: false; error: string };
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

type BimModel = { ok: true; hash: string; path: string; index: import('../core/bim/parse.ts').IfcIndex; geometry: boolean; url: string | null } | { ok: false; error: string };

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
  /** 4D: models are read in the main process; the viewer is served at p6c4d:// */
  bimOpen: (path?: string): Promise<BimModel | null> => ipcRenderer.invoke('bim:open', path),
  bimLoad: (o: { hash: string; path: string }): Promise<BimModel> => ipcRenderer.invoke('bim:load', o),
  bimText: (path: string): Promise<string> => ipcRenderer.invoke('bim:text', path),
  bimWriteFiles: (o: { title: string; files: { name: string; data: string | Uint8Array }[] }): Promise<string[] | null> => ipcRenderer.invoke('bim:writeFiles', o),
  bimReadImport: (): Promise<(import('../core/bim/exchange4d.ts').Imported4d & { path: string }) | null> => ipcRenderer.invoke('bim:readImport'),
  lobImport: (): Promise<import('./lob.ts').LobImport | { error: string } | null> => ipcRenderer.invoke('lob:import'),
  /** Export… on an analysis panel: asks for a folder, runs the tool with export (a child process on the saved database); null when cancelled. scope / others: see main/analysis-export.ts. */
  analysisExport: (tool: string, args: Record<string, unknown>, hoursPerDay: number, parts?: { scope?: string[]; others?: Record<string, string[]> }): Promise<import('./analysis-export-ipc.ts').ExportAnswer | null> => ipcRenderer.invoke('analysis:export', tool, args, hoursPerDay, parts),
  /** Ends the running Export… (its child process tree); false when none is running. */
  analysisCancel: (): Promise<boolean> => ipcRenderer.invoke('analysis:cancel'),
  bimVideo: (o: { hash: string; timeline: unknown; options: Record<string, unknown>; from?: string; to?: string; step?: number; fps?: number; width?: number; height?: number; name: string }): Promise<{ ok: true; saved: string | null; frames: number; mime?: string } | { ok: false; error: string }> => ipcRenderer.invoke('bim:video', o),
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
  /** Providers, tiers and seats: read (keys never), save (new keys by provider id), test a saved tier. */
  aiGetModels: (): Promise<PublicModels> => ipcRenderer.invoke('ai:getModels'),
  aiSaveModels: (m: PublicModels, keys: Record<string, string | undefined>): Promise<{ ok: true; models: PublicModels } | { ok: false; error: string }> => ipcRenderer.invoke('ai:saveModels', m, keys),
  aiTestTier: (name: string): Promise<{ ok: true; reply: string } | { ok: false; error: string }> => ipcRenderer.invoke('ai:testTier', name),
  /** The open schedule's MCP server for the embedded agent (main/live-mcp.ts): a request to list or run a tool, and the answer. */
  onLiveCall: (cb: (id: number, kind: 'list' | 'call', payload: unknown) => void) => { const f = (_e: unknown, id: number, kind: 'list' | 'call', payload: unknown) => cb(id, kind, payload); ipcRenderer.on('live:call', f); return () => { ipcRenderer.off('live:call', f); }; },
  liveReply: (id: number, v: { ok: boolean; result?: unknown; error?: string }) => ipcRenderer.send('live:reply', id, v),
  /** The embedded platform agent (main/whiq-ipc.ts): every call answers {ok, data} or {ok: false, error}. */
  whiq: {
    warm: () => ipcRenderer.invoke('whiq:warm') as Promise<WhiqResult<boolean>>,
    status: () => ipcRenderer.invoke('whiq:status') as Promise<WhiqResult<{ state: string; error?: string; missing: string | null }>>,
    /** project: the open project's ID: its folder in Data/Projects is the chat's working folder unless one is chosen */
    createChat: (title?: string, project?: string) => ipcRenderer.invoke('whiq:createChat', title, project) as Promise<WhiqResult<{ id: string; workingDir?: string }>>,
    chat: (chatId: string, ifRunning?: boolean) => ipcRenderer.invoke('whiq:chat', chatId, ifRunning) as Promise<WhiqResult<Record<string, unknown>>>,
    send: (chatId: string, content: string) => ipcRenderer.invoke('whiq:send', chatId, content) as Promise<WhiqResult<unknown>>,
    askReply: (chatId: string, toolCallId: string, reply: unknown) => ipcRenderer.invoke('whiq:askReply', chatId, toolCallId, reply) as Promise<WhiqResult<unknown>>,
    approval: (toolCallId: string, kind: 'approve' | 'skip', note?: string) => ipcRenderer.invoke('whiq:approval', toolCallId, kind, note) as Promise<WhiqResult<unknown>>,
    children: (chatId: string) => ipcRenderer.invoke('whiq:children', chatId) as Promise<WhiqResult<Record<string, any>[]>>,
    handoff: (chatId: string, handoffId: string, decision: 'here' | 'not_now') => ipcRenderer.invoke('whiq:handoff', chatId, handoffId, decision) as Promise<WhiqResult<unknown>>,
    abort: (chatId: string) => ipcRenderer.invoke('whiq:abort', chatId) as Promise<WhiqResult<unknown>>,
    resume: (chatId: string) => ipcRenderer.invoke('whiq:resume', chatId) as Promise<WhiqResult<unknown>>,
    files: (chatId: string) => ipcRenderer.invoke('whiq:files', chatId) as Promise<WhiqResult<unknown>>,
    mcpStatus: () => ipcRenderer.invoke('whiq:mcpStatus') as Promise<WhiqResult<unknown>>,
    /** save a file for the agent's own tools into 00_INPUTS of the talking chat's working folder; its path there */
    saveInput: (name: string, data: Uint8Array) => ipcRenderer.invoke('whiq:saveInput', name, data) as Promise<WhiqResult<{ path: string; folder: string }>>,
    /** the code sandbox (WSL's Linux jail, else Pyodide): which one, why not WSL, its set-up and a fresh pick */
    sandbox: () => ipcRenderer.invoke('whiq:sandbox') as Promise<WhiqResult<{ kind: 'wsl' | 'pyodide' | 'none'; wsl?: string; wslSetup?: boolean; error?: string }>>,
    sandboxSetupWsl: () => ipcRenderer.invoke('whiq:sandboxSetupWsl') as Promise<WhiqResult<boolean>>,
    sandboxRecheck: () => ipcRenderer.invoke('whiq:sandboxRecheck') as Promise<WhiqResult<boolean>>,
    chooseFolder: (chatId: string) => ipcRenderer.invoke('whiq:chooseFolder', chatId) as Promise<WhiqResult<string | null>>,
    folder: (chatId: string) => ipcRenderer.invoke('whiq:folder', chatId) as Promise<WhiqResult<string>>,
    attach: (chatId: string) => ipcRenderer.invoke('whiq:attach', chatId) as Promise<WhiqResult<{ folder: string; files: string[] } | null>>,
    openPath: (p: string) => ipcRenderer.invoke('whiq:openPath', p) as Promise<WhiqResult<boolean>>,
    showInFolder: (p: string) => ipcRenderer.invoke('whiq:showInFolder', p) as Promise<WhiqResult<boolean>>,
    watch: (chatId: string, project?: string) => ipcRenderer.invoke('whiq:watch', chatId, project) as Promise<WhiqResult<boolean>>,
    unwatch: (chatId: string) => ipcRenderer.invoke('whiq:unwatch', chatId) as Promise<WhiqResult<boolean>>,
    onEvent: (cb: (chatId: string, e: Record<string, unknown> & { type: string }) => void) => { const f = (_e: unknown, id: string, ev: Record<string, unknown> & { type: string }) => cb(id, ev); ipcRenderer.on('whiq:event', f); return () => { ipcRenderer.off('whiq:event', f); }; },
  },
  /** .mpp bytes -> Microsoft Project XML bytes, converted by the installed Microsoft Project. Rejects with the bridge error. */
  mppToXml: (bytes: Uint8Array): Promise<Uint8Array> => ipcRenderer.invoke('msp:mppToXml', bytes),
  /** Ask for an .mpp path and save Microsoft Project XML bytes there through Microsoft Project. Null when cancelled. */
  xmlToMpp: (defaultName: string, xmlBytes: Uint8Array): Promise<string | null> => ipcRenderer.invoke('msp:xmlToMpp', defaultName, xmlBytes),
};

export type P6Api = typeof api;
contextBridge.exposeInMainWorld('p6', api);
