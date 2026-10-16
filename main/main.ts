import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage } from 'electron';
import { AiStore, chat, type AiConfig, type ChatRequest } from './ai.ts';
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, writeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildMenu } from './menu.ts';
import { mppToXml, xmlToMpp } from './msproject.ts';

const DB_FILE = () => join(app.getPath('userData'), 'p6clone-db.json');
let win: BrowserWindow | null = null;

// Optional automation: --import <file> opens the import wizard on that file; --user-data <dir> isolates the database.
const argv = process.argv;
const argVal = (name: string) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
const userData = argVal('--user-data');
if (userData) app.setPath('userData', userData);
// Large programmes (100 MB XERs, 100k+ activities) are held in the window's memory: allow it more than V8's default.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=12288');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'Primavera P6 Professional (Clone)',
    backgroundColor: '#f0f0f0',
    icon: join(__dirname, 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
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
// Lines cross to the window in batches of about BATCH characters: one message between processes has a size cap.
const BATCH = 32 * 1024 * 1024;
let loadBatches: string[][] = [];
ipcMain.handle('db:loadBegin', () => {
  loadBatches = [];
  if (!existsSync(DB_FILE())) return null;
  const buf = readFileSync(DB_FILE());
  let cur: string[] = [], size = 0;
  for (let i = 0; i < buf.length;) {
    let j = buf.indexOf(10, i); if (j < 0) j = buf.length;
    cur.push(buf.toString('utf8', i, j)); size += j - i; i = j + 1;
    if (size >= BATCH) { loadBatches.push(cur); cur = []; size = 0; }
  }
  if (cur.length) loadBatches.push(cur);
  return loadBatches.length;
});
ipcMain.handle('db:loadBatch', (_e, i: number) => { const b = loadBatches[i]; if (i === loadBatches.length - 1) loadBatches = []; return b ?? []; });

// atomic: write a temp file then rename, so a crash never leaves a half-written database
let saveFd: number | null = null;
const TMP = () => DB_FILE() + '.tmp';
ipcMain.handle('db:saveBegin', () => { if (saveFd != null) closeSync(saveFd); saveFd = openSync(TMP(), 'w'); return true; });
ipcMain.handle('db:saveLines', (_e, lines: string[]) => { if (saveFd == null) return false; for (const l of lines) writeSync(saveFd, l + '\n'); return true; });
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

ipcMain.handle('print:preview', async (_e, landscape: boolean) => {
  const data = await win!.webContents.printToPDF({ landscape, printBackground: true, pageSize: 'A3' });
  const file = join(mkdtempSync(join(tmpdir(), 'p6clone-preview-')), 'Print Preview.pdf');
  writeFileSync(file, data);
  const pv = new BrowserWindow({ width: 1100, height: 850, title: 'Print Preview', parent: win!, icon: join(__dirname, 'icon.png'), webPreferences: { plugins: true } });
  pv.setMenu(null);
  await pv.loadFile(file);
  return true;
});

// AI assistant: settings (key encrypted, never sent to the window) and chat calls
let aiStore: AiStore | null = null;
const ai = () => (aiStore ??= new AiStore(join(app.getPath('userData'), 'ai-assistant.json'), {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
}));
const aiCalls = new Map<string, AbortController>();
ipcMain.handle('ai:getConfig', () => ai().publicConfig());
ipcMain.handle('ai:setConfig', (_e, c: AiConfig, apiKey?: string) => { const r = ai().save(c, apiKey); win?.webContents.send('ai:config', r); return r; });
ipcMain.handle('ai:chat', async (_e, id: string, req: ChatRequest) => {
  const ctl = new AbortController();
  aiCalls.set(id, ctl);
  try { return { ok: true, reply: await chat(ai(), req, ctl.signal) }; }
  catch (e) { return { ok: false, error: (e as Error).name === 'AbortError' ? 'Stopped.' : (e as Error).message }; }
  finally { aiCalls.delete(id); }
});
ipcMain.handle('ai:cancel', (_e, id: string) => { aiCalls.get(id)?.abort(); return true; });

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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
