// 4D in the desktop app's main process: IFC models are read here (the IFC engine needs Node), the 4D viewer is served
// from a p6c4d:// scheme (so the page can fetch its separate model file), packages are written to a folder the user
// picks, other tools' 4D files are read, and videos are rendered offscreen on the user's GPU.
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cachedModel, loadModel, type Model } from '../core/bim/model.ts';
import { modelFolder, viewerHtml, viewerScriptPath } from '../core/bim/render4d.ts';
import { placeTiles } from '../core/bim/tiles.ts';
import { plainElement } from '../core/bim/element.ts';
import type { Imported4d } from '../core/bim/exchange4d.ts';
import { readImport4d } from '../core/bim/read4d.ts';

const root = () => join(app.getPath('userData'), '4d');
const EMPTY = { project: '', name: '', dataDate: null, start: null, finish: null, sources: [{ name: 'best', label: 'best' }], activities: [], elements: { count: 0, linked: 0, groups: [], of: '' }, status: [] };

/** Before app ready: the scheme must be standard and allowed to fetch, so the viewer can load its tiles. */
export function registerBimScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'p6c4d', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}

/** The viewer folder of a model: index.html (waiting for its timeline from the app), render.html, viewer4d.js, and the
 *  model's display tiles in model-<hash>/ (hard links to the cache). */
function viewerFolder(m: Model): string {
  const dir = join(root(), m.hash);
  mkdirSync(dir, { recursive: true });
  const script = viewerScriptPath();
  if (!script) throw new Error('The 4D viewer (viewer4d.js) is missing from the app.');
  copyFileSync(script, join(dir, 'viewer4d.js'));
  if (!m.tiles) return dir;
  placeTiles(m.tiles, dir, modelFolder(m.hash));
  const model = { tiles: `${modelFolder(m.hash)}/manifest.json` };
  const timeline = { ...EMPTY, elements: { count: m.index.elements.length, linked: 0, groups: [], of: '' } };
  writeFileSync(join(dir, 'index.html'), viewerHtml({ title: '4D', model, timeline, options: { interactive: true, overlays: ['date', 'legend', 'activity_list'] }, script: { src: 'viewer4d.js' } }));
  writeFileSync(join(dir, 'render.html'), viewerHtml({ title: '4D', model, timeline, options: { interactive: false }, script: { src: 'viewer4d.js' } }));
  return dir;
}

// the renderer gets plain elements (a structured clone carries no getters)
const answer = (m: Model) => ({ hash: m.hash, path: m.index.sourcePath, index: { ...m.index, elements: m.index.elements.map(plainElement) }, geometry: !!m.tiles, url: m.tiles ? `p6c4d://model/${m.hash}/index.html` : null });

export function registerBim(getWin: () => BrowserWindow | null): void {
  protocol.handle('p6c4d', (req) => {
    const u = new URL(req.url);
    const file = normalize(join(root(), decodeURIComponent(u.pathname)));
    if (!file.startsWith(normalize(root()))) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });

  ipcMain.handle('bim:open', async (_e, path?: string) => {
    let p = path;
    if (!p) { const r = await dialog.showOpenDialog(getWin()!, { title: 'Open model', filters: [{ name: 'Models (IFC, Revit, Navisworks)', extensions: ['ifc', 'rvt', 'rfa', 'nwd', 'nwc', 'nwf'] }], properties: ['openFile'] }); if (r.canceled || !r.filePaths[0]) return null; p = r.filePaths[0]; }
    try { const m = await loadModel(p); viewerFolder(m); return { ok: true, ...answer(m) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  ipcMain.handle('bim:load', async (_e, o: { hash: string; path: string }) => {
    try { const c = cachedModel(o.hash), m = c && c.index.geometryStatus !== 'skipped' ? c : existsSync(o.path) ? await loadModel(o.path) : c; /* an index cached without geometry (an agent reopened it for links) is meshed for the view */ if (!m) return { ok: false, error: `The model ${o.path} is not cached and the file is gone; open it again.` }; viewerFolder(m); return { ok: true, ...answer(m) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  ipcMain.handle('bim:text', (_e, path: string) => readFileSync(path, 'latin1'));
  ipcMain.handle('bim:writeFiles', async (_e, o: { title: string; files: { name: string; data: string | Uint8Array }[] }) => {
    const r = await dialog.showOpenDialog(getWin()!, { title: o.title, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const out = o.files.map((f) => { const p = join(r.filePaths[0], basename(f.name)); writeFileSync(p, typeof f.data === 'string' ? f.data : Buffer.from(f.data)); return p; });
    return out;
  });
  ipcMain.handle('bim:readImport', async (): Promise<(Imported4d & { path: string }) | null> => {
    const r = await dialog.showOpenDialog(getWin()!, { title: 'Import 4D', filters: [{ name: '4D files', extensions: ['ifc', 'xml', 'csv', 'xlsx', 'nwf', 'nwd', 'sp'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], ...(await readImport4d(r.filePaths[0], new Uint8Array(readFileSync(r.filePaths[0])))) };
  });
  // a video on this computer's GPU: the viewer page offscreen, encoded in the page (WebCodecs), saved where the user says
  ipcMain.handle('bim:video', async (_e, o: { hash: string; timeline: unknown; options: Record<string, unknown>; from?: string; to?: string; step?: number; fps?: number; width?: number; height?: number; name: string }) => {
    const w = new BrowserWindow({ show: false, width: o.width ?? 1280, height: o.height ?? 720, webPreferences: { offscreen: false, backgroundThrottling: false } });
    try {
      await w.loadURL(`p6c4d://model/${o.hash}/render.html`);
      for (const t0 = Date.now(); !(await w.webContents.executeJavaScript('!!(window.P6C4D_API && window.P6C4D_API.ready())')); ) { if (Date.now() - t0 > 60_000) throw new Error('The model did not load.'); await new Promise((r) => setTimeout(r, 200)); }
      await w.webContents.executeJavaScript(`window.postMessage(${JSON.stringify({ type: 'p6c4d:timeline', timeline: o.timeline })}, '*'); window.postMessage(${JSON.stringify({ type: 'p6c4d:options', options: o.options })}, '*'); new Promise((r) => setTimeout(r, 200))`);
      const v = await w.webContents.executeJavaScript(`window.P6C4D_API.encode(${JSON.stringify({ from: o.from, to: o.to, step: o.step, fps: o.fps, width: o.width, height: o.height })}).then((r) => ({ mime: r.mime, frames: r.frames, bytes: r.bytes }))`, true) as { mime: string; frames: number; bytes: Uint8Array };
      const ext = v.mime.includes('mp4') ? 'mp4' : 'webm';
      const s = await dialog.showSaveDialog(getWin()!, { title: 'Save 4D video', defaultPath: `${o.name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (s.canceled || !s.filePath) return { ok: true, saved: null, frames: v.frames };
      writeFileSync(s.filePath, Buffer.from(v.bytes));
      return { ok: true, saved: s.filePath, frames: v.frames, mime: v.mime };
    } catch (e) { return { ok: false, error: (e as Error).message }; } finally { w.destroy(); }
  });
}
