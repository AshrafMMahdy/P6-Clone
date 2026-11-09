import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage } from 'electron';
import { AiStore, chat, chatWith, type AiConfig, type ChatRequest, type PublicModels } from './ai.ts';
import { initModelsDev } from './modelsDev.ts';
import { appendChat, clearChat, loadChat, moveChat } from './ai-chats.ts';
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, writeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildMenu } from './menu.ts';
import { mppToXml, xmlToMpp } from './msproject.ts';
import { nodeInfer, ReasonerUnavailable } from '../core/analysis/hrmRuntime.ts';
import { registerBim, BIM_SCHEME } from './bim.ts';
import { registerSandboxScheme } from './sandbox/pyodideService.ts';
import { registerLob } from './lob.ts';
import { registerAnalysisExport } from './analysis-export-ipc.ts';
import { registerWhiq } from './whiq-ipc.ts';
import { dataDir, dataFile, dataNote, dataRoot, moveLegacyData } from './dataPaths.ts';

registerSandboxScheme([BIM_SCHEME]); // before ready, in one call: the code sandbox's scheme and the 4D viewer's p6c4d://

const DB_FILE = () => dataFile('Database', 'p6clone-db.json');
let win: BrowserWindow | null = null;

// Optional automation: --import <file> opens the import wizard on that file; --user-data <dir> isolates the database.
const argv = process.argv;
const argVal = (name: string) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
const userData = argVal('--user-data');
if (userData) app.setPath('userData', userData);
// the app's data beside the program (main/dataPaths.ts); the first start of that layout moves the AppData layout's data there
for (const m of moveLegacyData()) console.log(`[data] moved ${m} into ${dataRoot()}`);
if (dataNote) console.log(`[data] ${dataNote}`);
// Large programmes (100 MB XERs, 100k+ activities) are held in the window's memory: allow it more than V8's default.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=12288');
// Background mode: started by a test or another program (a remote-debugging port, which Playwright always passes and a
// person never does), with --background, or P6CLONE_BACKGROUND=1. The windows open minimized and never take the front
// of the screen from what the user is doing; they keep rendering and running timers as if shown (owner, 2026-11-04).
const background = argv.includes('--background') || app.commandLine.hasSwitch('remote-debugging-port') || process.env.P6CLONE_BACKGROUND === '1';
if (background) {
  for (const s of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(s);
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
/** A new window of the app: shown, or in background mode opened minimized (never in front, never focused). */
const shown = (w: BrowserWindow): BrowserWindow => { if (background) w.minimize(); return w; };

function createWindow(): void {
  win = new BrowserWindow({
    show: !background,
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'Primavera P6 Professional (Clone)',
    backgroundColor: '#f0f0f0',
    icon: join(__dirname, 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: !background },
  });
  shown(win);
  Menu.setApplicationMenu(buildMenu(win));
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  // --menu <command id> runs a menu command once the window is ready (e.g. --menu edit.aiSettings)
  const startMenu = argVal('--menu');
  if (startMenu) win.webContents.once('did-finish-load', () => setTimeout(() => win?.webContents.send('menu', startMenu), 1200));
  win.on('closed', () => { win = null; });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error(`window process ended: ${d.reason} (exit ${d.exitCode})`);
    if (d.reason !== 'clean-exit') dialog.showErrorBox('P6 Clone', `The window stopped (${d.reason}). Your database file was not changed; reopen the app to continue.`);
  });
}

// the schedule reasoner runs here (WebAssembly in Node); the renderer sends the model inputs only
ipcMain.handle('hrm:infer', async (_e, x: Parameters<typeof nodeInfer>[0]) => { try { return { ok: true, out: await nodeInfer(x) }; } catch (e) { return { ok: false, error: (e as Error).message, unavailable: e instanceof ReasonerUnavailable }; } });
ipcMain.handle('file:open', async (_e, filters: Electron.FileFilter[], title?: string) => {
  const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths[0]) return null;
  const path = r.filePaths[0];
  return { path, name: basename(path), bytes: new Uint8Array(readFileSync(path)) };
});

ipcMain.handle('file:save', async (_e, defaultName: string, bytes: Uint8Array, filters: Electron.FileFilter[]) => {
  const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  writeFileSync(r.filePath, bytes);
  return r.filePath;
});

// The database file is JSON Lines (core/db-file.ts), read and written line by line so its size is not limited
// by the largest possible single string.
// Lines cross to the window in batches of about BATCH bytes (one message between processes has a size cap), read
// from the file as the window asks for them: neither the file nor all of its lines are ever in memory at once.
const BATCH = 32 * 1024 * 1024;
let loadFd: number | null = null;
let loadRest = Buffer.alloc(0); // the start of a line that continues in the next batch
ipcMain.handle('db:loadBegin', () => {
  if (loadFd != null) closeSync(loadFd);
  loadFd = null; loadRest = Buffer.alloc(0);
  if (!existsSync(DB_FILE())) return false;
  loadFd = openSync(DB_FILE(), 'r');
  return true;
});
/** The next lines of the file, null at its end. */
ipcMain.handle('db:loadBatch', () => {
  if (loadFd == null) return null;
  const buf = Buffer.allocUnsafe(BATCH);
  const n = readSync(loadFd, buf, 0, BATCH, null);
  const data = loadRest.length ? Buffer.concat([loadRest, buf.subarray(0, n)]) : buf.subarray(0, n);
  if (n === 0) { closeSync(loadFd); loadFd = null; loadRest = Buffer.alloc(0); return data.length ? [data.toString('utf8')] : null; }
  const end = data.lastIndexOf(10);
  loadRest = Buffer.from(data.subarray(end + 1)); // a copy: the batch buffer is not kept
  const out: string[] = [];
  for (let i = 0; i <= end;) { const j = data.indexOf(10, i); out.push(data.toString('utf8', i, j)); i = j + 1; }
  return out;
});

// atomic: write a temp file then rename, so a crash never leaves a half-written database
let saveFd: number | null = null;
const TMP = () => DB_FILE() + '.tmp';
ipcMain.handle('db:saveBegin', () => { if (saveFd != null) closeSync(saveFd); saveFd = openSync(TMP(), 'w'); return true; });
ipcMain.handle('db:saveLines', (_e, lines: string[]) => { if (saveFd == null) return false; for (const l of lines) writeSync(saveFd, l + '\n'); return true; });
ipcMain.handle('db:saveAbort', () => { if (saveFd != null) { closeSync(saveFd); saveFd = null; rmSync(TMP(), { force: true }); } return true; });
ipcMain.handle('db:saveEnd', () => {
  if (saveFd == null) return false;
  closeSync(saveFd); saveFd = null;
  renameSync(TMP(), DB_FILE());
  return true;
});

ipcMain.handle('print', async (_e, landscape: boolean) => {
  return new Promise<boolean>((resolve) => win!.webContents.print({ landscape, printBackground: true }, (ok) => resolve(ok)));
});

ipcMain.handle('pdf', async (_e, defaultName: string, landscape: boolean) => {
  const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return null;
  const data = await win!.webContents.printToPDF({ landscape, printBackground: true, pageSize: 'A3' });
  writeFileSync(r.filePath, data);
  return r.filePath;
});

// The Activities printout (renderer/print): a document of page-sized SVGs, printed / previewed / saved from a hidden
// window so the app window is untouched. Page size and margins come from the document itself.
ipcMain.handle('print:html', async (_e, html: string, mode: 'print' | 'pdf' | 'preview', defaultName: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'p6clone-print-'));
  const file = join(dir, 'schedule.html');
  writeFileSync(file, html);
  const doc = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true } });
  try {
    await doc.loadFile(file);
    if (mode === 'print') return await new Promise<boolean>((resolve) => doc.webContents.print({ printBackground: true }, (ok) => resolve(ok)));
    const data = await doc.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    if (mode === 'pdf') {
      const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (r.canceled || !r.filePath) return null;
      writeFileSync(r.filePath, data);
      return r.filePath;
    }
    const pdf = join(dir, 'Print Preview.pdf');
    writeFileSync(pdf, data);
    const pv = shown(new BrowserWindow({ show: !background, width: 1100, height: 850, title: 'Print Preview', parent: win!, icon: join(__dirname, 'icon.png'), webPreferences: { plugins: true } }));
    pv.setMenu(null);
    await pv.loadFile(pdf);
    return true;
  } finally { doc.destroy(); }
});

ipcMain.handle('print:preview', async (_e, landscape: boolean) => {
  const data = await win!.webContents.printToPDF({ landscape, printBackground: true, pageSize: 'A3' });
  const file = join(mkdtempSync(join(tmpdir(), 'p6clone-preview-')), 'Print Preview.pdf');
  writeFileSync(file, data);
  const pv = shown(new BrowserWindow({ show: !background, width: 1100, height: 850, title: 'Print Preview', parent: win!, icon: join(__dirname, 'icon.png'), webPreferences: { plugins: true } }));
  pv.setMenu(null);
  await pv.loadFile(file);
  return true;
});

// AI assistant: settings (key encrypted, never sent to the window) and chat calls
let aiStore: AiStore | null = null;
const ai = () => (aiStore ??= new AiStore(dataFile('Settings', 'ai-assistant.json'), {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
}));
const aiCalls = new Map<string, AbortController>();
ipcMain.handle('ai:getConfig', () => ai().publicConfig());
// the embedded platform agent; new AI settings take effect on its next start
const whiq = registerWhiq(() => win, ai);
const SETTINGS_CHANGED = 'The AI settings changed, so the agent stopped; it starts again with them on your next message.';
ipcMain.handle('ai:setConfig', (_e, c: AiConfig, apiKey?: string) => { const r = ai().save(c, apiKey); whiq.stopIfChanged(SETTINGS_CHANGED); win?.webContents.send('ai:config', r); return r; });
// providers, tiers and seats (the platform's AI Providers page): saved as one; the agent restarts on its next use
ipcMain.handle('ai:getModels', () => ai().publicModels());
ipcMain.handle('ai:saveModels', (_e, m: PublicModels, keys: Record<string, string | undefined>) => {
  try { const r = ai().saveModels(m, keys); whiq.stopIfChanged(SETTINGS_CHANGED); win?.webContents.send('ai:config', ai().publicConfig()); return { ok: true, models: r }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
});
ipcMain.handle('ai:testTier', async (_e, name: string) => {
  try {
    const { cfg, key } = ai().tierRequest(name);
    const r = await chatWith(cfg, key, { system: 'Answer in one short sentence.', messages: [{ role: 'user', content: 'Say: ready.' }], tools: [] }, AbortSignal.timeout(60_000));
    return { ok: true, reply: r.content.slice(0, 200) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
});
ipcMain.handle('ai:chat', async (_e, id: string, req: ChatRequest) => {
  const ctl = new AbortController();
  aiCalls.set(id, ctl);
  try { return { ok: true, reply: await chat(ai(), req, ctl.signal) }; }
  catch (e) { return { ok: false, error: (e as Error).name === 'AbortError' ? 'Stopped.' : (e as Error).message }; }
  finally { aiCalls.delete(id); }
});
ipcMain.handle('ai:cancel', (_e, id: string) => { aiCalls.get(id)?.abort(); return true; });
const chatDir = () => dataDir('Agent', 'panel-chats');
ipcMain.handle('ai:chatLoad', (_e, key: string) => loadChat(chatDir(), key));
ipcMain.handle('ai:chatAppend', (_e, key: string, entries: unknown[]) => appendChat(chatDir(), key, entries));
ipcMain.handle('ai:chatClear', (_e, key: string) => clearChat(chatDir(), key));
ipcMain.handle('ai:chatMove', (_e, from: string, to: string) => moveChat(chatDir(), from, to));

// the menu bar as data (labels, command ids, shortcuts): the AI assistant uses it to explain and to operate menus
export interface MenuNode { label: string; id?: string; accelerator?: string; submenu?: MenuNode[] }
ipcMain.handle('menu:tree', () => {
  const walk = (items: Electron.MenuItem[]): MenuNode[] => items.filter((i) => i.type !== 'separator' && i.label).map((i) => ({
    label: i.label.replace(/&/g, ''), id: i.id || undefined, accelerator: (i.accelerator as string | undefined) || undefined,
    submenu: i.submenu ? walk(i.submenu.items) : undefined,
  }));
  return walk(Menu.getApplicationMenu()?.items ?? []);
});

ipcMain.handle('startup:import', () => {
  const p = argVal('--import');
  return p && existsSync(p) ? { path: p, name: basename(p), bytes: new Uint8Array(readFileSync(p)) } : null;
});

// Microsoft Project .mpp bridge (needs an installed Microsoft Project, like P6). Temp files live in their own folder.
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'p6clone-msp-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

ipcMain.handle('msp:mppToXml', (_e, bytes: Uint8Array) => withTempDir(async (dir) => {
  const mpp = join(dir, 'import.mpp'), xml = join(dir, 'import.xml');
  writeFileSync(mpp, bytes);
  await mppToXml(mpp, xml);
  return new Uint8Array(readFileSync(xml));
}));

ipcMain.handle('msp:xmlToMpp', async (_e, defaultName: string, xmlBytes: Uint8Array) => {
  const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters: [{ name: 'Microsoft Project (MPP)', extensions: ['mpp'] }] });
  if (r.canceled || !r.filePath) return null;
  const target = r.filePath;
  await withTempDir(async (dir) => {
    const xml = join(dir, 'export.xml'), mpp = join(dir, 'export.mpp');
    writeFileSync(xml, xmlBytes);
    await xmlToMpp(xml, mpp);
    copyFileSync(mpp, target);
  });
  return target;
});

ipcMain.handle('confirm',async (_e, message: string, detail?: string) => {
  const r = await dialog.showMessageBox(win!, { type: 'question', buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1, title: 'Primavera P6 Professional', message, detail });
  return r.response === 0;
});

app.whenReady().then(() => { initModelsDev(dataFile('Cache', 'models-dev.json')); registerBim(() => win); registerLob(() => win); registerAnalysisExport(() => win, DB_FILE); createWindow(); });
app.on('window-all-closed', () => app.quit());
