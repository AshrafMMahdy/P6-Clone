import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildMenu } from './menu.ts';

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

ipcMain.handle('confirm', async (_e, message: string, detail?: string) => {
  const r = await dialog.showMessageBox(win!, { type: 'question', buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1, title: 'Primavera P6 Professional', message, detail });
  return r.response === 0;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
