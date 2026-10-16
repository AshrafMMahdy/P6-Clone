import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  win.on('closed', () => { win = null; });
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

ipcMain.handle('db:load', () => (existsSync(DB_FILE()) ? readFileSync(DB_FILE(), 'utf8') : null));

ipcMain.handle('db:save', (_e, json: string) => {
  // atomic: write temp then rename, so a crash never leaves a half-written database
  const tmp = DB_FILE() + '.tmp';
  writeFileSync(tmp, json);
  renameSync(tmp, DB_FILE());
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
