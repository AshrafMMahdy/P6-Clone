// The window's way to the embedded platform agent (whiq-host.ts): chats, messages, answers to its questions and
// approvals, stop, the chat's working folder (chosen by the user), its files, and its live events forwarded to the
// window. The agent starts on first use and stops when the app quits or the AI settings change. Beside it run the
// app's own services the agent uses: the code sandbox (sandbox/codeSandbox.ts: WSL's Linux jail, else Pyodide).
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EOL } from 'node:os';
import { WhiqHost, type AgentEvent } from './whiq-host.ts';
import { startLiveMcp } from './live-mcp.ts';
import { CodeSandbox } from './sandbox/codeSandbox.ts';
import { wslSetupCommand } from './sandbox/wslSandbox.ts';
import { startPqvae, type Pqvae } from './pqvae/start.ts';
import type { AgentModels } from './whiq-config.ts';
import type { AiStore } from './ai.ts';

/** The models the agent runs on: the providers, tiers and seats of the AI settings. */
export const modelsFrom = (ai: AiStore): AgentModels => ai.agentModels() as AgentModels;

export function registerWhiq(getWin: () => BrowserWindow | null, ai: () => AiStore): WhiqHost {
  const vendor = app.isPackaged ? join(process.resourcesPath, 'whiq-agent') : join(app.getAppPath(), 'vendor', 'whiq-agent');
  // the open schedule's MCP server: started with the agent's first start, kept for the app's life
  let live: Promise<{ url: string; token: string; close: () => void }> | null = null;
  const liveMcp = async () => { live ??= startLiveMcp(getWin); const l = await live; return [{ id: 'p6clone_live', label: 'P6 Clone: the open schedule, on screen', url: l.url, token: l.token }]; };
  const data = join(app.getPath('userData'), 'whiq');
  // the code sandbox: picked at the agent's first start (WSL when its jail holds there, else Pyodide), kept while the app runs
  const stampFile = join(vendor, '.whiq-agent-commit');
  const version = existsSync(stampFile) ? readFileSync(stampFile, 'utf8').slice(0, 8) : 'dev';
  const sandboxLog = (l: string) => { try { mkdirSync(join(data, 'logs'), { recursive: true }); appendFileSync(join(data, 'logs', 'sandbox.log'), `${l}${EOL}`); } catch { /* best effort */ } };
  const sandbox = new CodeSandbox({
    wslSource: join(vendor, '09 Local Sandbox'), version,
    pyodideDir: app.isPackaged ? join(process.resourcesPath, 'pyodide') : join(app.getAppPath(), 'vendor', 'pyodide'),
    log: sandboxLog,
  });
  // the PQ-VAE engine (schedule review, outcome forecast): a fresh one with each agent start, as it asks that start's router
  let pqvae: Pqvae | null = null;
  const startEngine = async (routerUrl: string): Promise<Record<string, string>> => {
    pqvae?.stop(); pqvae = null;
    try {
      pqvae = await startPqvae({ entry: join(app.getAppPath(), 'dist', 'pqvae-sidecar.mjs'), models: join(vendor, 'pqvae-onnx'), routerUrl, log: join(data, 'logs', 'pqvae.log') });
      return { PQVAE_PORT: String(pqvae.port) };
    } catch (e) { sandboxLog(`[pqvae] not started: ${(e as Error).message}`); return {}; }   // its tools then say it is unavailable
  };
  const services = async (routerUrl: string) => { const [, pq] = await Promise.all([sandbox.ensure(), startEngine(routerUrl)]); return { ...sandbox.env(), ...pq }; };
  const host = new WhiqHost({ vendor, data }, () => modelsFrom(ai()), liveMcp, services);
  const watching = new Map<string, () => void>();
  const send = (chatId: string, e: AgentEvent) => getWin()?.webContents.send('whiq:event', chatId, e);

  // ---- the chat's working folder: where its files are copied to and attachments go (asked for when first needed)
  const folders = new Map<string, string>(), declined = new Set<string>();
  /** the chat that sent the last message: the one the agent's on-screen tools are working for */
  let lastChat = '';
  const folderOf = async (chatId: string): Promise<string> => {
    if (folders.has(chatId)) return folders.get(chatId)!;
    const c = await host.api('GET', `/api/chats/${encodeURIComponent(chatId)}`) as { workingDir?: string };
    if (c.workingDir) folders.set(chatId, c.workingDir);
    return c.workingDir ?? '';
  };
  const askFolder = async (chatId: string, why: string): Promise<string> => {
    const win = getWin();
    const r = win ? await dialog.showOpenDialog(win, { title: `Working folder for the AI agent: ${why}`, properties: ['openDirectory', 'createDirectory'] }) : null;
    if (!r || r.canceled || !r.filePaths[0]) return '';
    await host.api('POST', '/api/working-dir/set', { chatId, path: r.filePaths[0] });
    folders.set(chatId, r.filePaths[0]);
    send(chatId, { type: 'folder', path: r.filePaths[0] });
    return r.filePaths[0];
  };
  // the agent's files (its own store, as on the platform) copied into "AI Outputs" of the working folder, new or
  // changed ones only; the first one asks for a folder when the chat has none (once: a "no" is not asked again)
  const copied = new Map<string, string>();
  let syncing = Promise.resolve();
  const syncFiles = (chatId: string) => (syncing = syncing.then(async () => {
    const list = await host.api('GET', `/api/files?chatId=${encodeURIComponent(chatId)}`) as { path: string; sizeBytes: number; mtime: string }[];
    const fresh = list.filter((f) => copied.get(`${chatId}|${f.path}`) !== `${f.mtime}|${f.sizeBytes}`);
    if (!fresh.length) return;
    let wd = await folderOf(chatId);
    if (!wd && !declined.has(chatId)) { wd = await askFolder(chatId, 'where should its files go?'); if (!wd) declined.add(chatId); }
    if (!wd) return;
    for (const f of fresh) {
      // the agent's own relative path, kept inside the folder (no "..", no drive or root)
      const parts = f.path.split(/[\\/]/).filter((x) => x && x !== '.' && x !== '..' && !/^[a-z]:$/i.test(x));
      if (!parts.length) continue;
      const to = join(wd, 'AI Outputs', ...parts);
      mkdirSync(join(to, '..'), { recursive: true });
      writeFileSync(to, await host.raw(`/api/files/raw/${f.path.split('/').map(encodeURIComponent).join('/')}?chatId=${encodeURIComponent(chatId)}&dl=1`));
      copied.set(`${chatId}|${f.path}`, `${f.mtime}|${f.sizeBytes}`);
      send(chatId, { type: 'file_saved', path: to, name: basename(to) });
    }
  }).catch((e) => send(chatId, { type: 'error', message: `A file of the agent could not be copied to the working folder: ${(e as Error).message}` })));
  // every handler answers {ok, ...} or {ok: false, error}: a failure reaches the panel as words, never a crash
  const handle = (ch: string, fn: (...a: any[]) => Promise<unknown>) =>
    ipcMain.handle(ch, async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (err) { return { ok: false, error: (err as Error).message }; } });

  // P6CLONE_WHIQ=off: the panel keeps its own loop (tests of that fallback; a build without the agent behaves the same)
  // the panel opened: start the agent now, so its engines have listed their tools by the first message
  handle('whiq:warm', async () => { void host.start().catch(() => { /* reported on use */ }); return true; });
  handle('whiq:status', async () => ({ ...host.status, missing: process.env.P6CLONE_WHIQ === 'off' ? 'Turned off (P6CLONE_WHIQ=off).' : host.available() }));
  handle('whiq:createChat', (title?: string) => host.api('POST', '/api/chats', { title: title || 'Scheduler', module: 'scheduler' }));
  handle('whiq:chat', (chatId: string) => host.api('GET', `/api/chats/${encodeURIComponent(chatId)}`));
  handle('whiq:send', (chatId: string, content: string) => { lastChat = chatId; return host.api('POST', '/api/agent/send', { chatId, content }); });
  handle('whiq:askReply', (chatId: string, toolCallId: string, reply: unknown) => host.api('POST', '/api/agent/ask-reply', { chatId, toolCallId, reply }));
  handle('whiq:approval', (toolCallId: string, kind: 'approve' | 'skip', note?: string) => host.api('POST', '/api/agent/approval', { toolCallId, kind, note }));
  handle('whiq:abort', (chatId: string) => host.api('POST', '/api/agent/abort', { chatId }));
  handle('whiq:resume', (chatId: string) => host.api('POST', '/api/agent/resume', { chatId }));
  handle('whiq:mcpStatus', () => host.api('GET', '/api/mcp/servers'));
  handle('whiq:files', (chatId: string) => host.api('GET', `/api/files?chatId=${encodeURIComponent(chatId)}`));
  /** The user picks the chat's working folder (where its files go and what it may read). Null when cancelled. */
  handle('whiq:chooseFolder', async (chatId: string) => { const p = await askFolder(chatId, 'its files go here, and it may read what is in it'); return p || null; });
  /** Files the user attaches: copied into the working folder's 00_INPUTS (a folder is asked for first when there is none). */
  handle('whiq:attach', async (chatId: string) => {
    let wd = await folderOf(chatId);
    if (!wd) wd = await askFolder(chatId, 'attached files are copied into it');
    if (!wd) return null;
    const win = getWin();
    const r = win ? await dialog.showOpenDialog(win, { title: 'Attach files for the AI agent', properties: ['openFile', 'multiSelections'] }) : null;
    if (!r || r.canceled || !r.filePaths.length) return null;
    const inputs = join(wd, '00_INPUTS');
    mkdirSync(inputs, { recursive: true });
    for (const p of r.filePaths) copyFileSync(p, join(inputs, basename(p)));
    return { folder: wd, files: r.filePaths.map((p) => `00_INPUTS/${basename(p)}`) };
  });
  /** A file the agent's on-screen tools save for its own tools (the open project as XER for import_schedule_file): into
   *  00_INPUTS of the working folder of the chat that is talking (asked for when it has none). Its path in that folder. */
  handle('whiq:saveInput', async (name: string, data: Uint8Array) => {
    if (!lastChat) throw new Error('No chat with the agent is open.');
    const file = basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'project.xer';
    let wd = await folderOf(lastChat);
    if (!wd) wd = await askFolder(lastChat, 'the open project is saved into it for the agent');
    if (!wd) throw new Error('No working folder was chosen, so the project could not be saved for the agent.');
    mkdirSync(join(wd, '00_INPUTS'), { recursive: true });
    writeFileSync(join(wd, '00_INPUTS', file), data);
    return { path: `00_INPUTS/${file}`, folder: wd };
  });
  handle('whiq:folder', (chatId: string) => folderOf(chatId));
  handle('whiq:openPath', async (p: string) => { const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
  handle('whiq:showInFolder', async (p: string) => { shell.showItemInFolder(p); return true; });
  handle('whiq:watch', async (chatId: string) => {
    if (watching.has(chatId)) return true;
    watching.set(chatId, await host.stream(chatId, (e) => { send(chatId, e); if (e.type === 'preview_update' || e.type === 'done') void syncFiles(chatId); }));
    return true;
  });
  handle('whiq:unwatch', async (chatId: string) => { watching.get(chatId)?.(); watching.delete(chatId); return true; });

  // the code sandbox for Settings: which one runs the agent's code, and setting up the WSL one (in a console the user sees:
  // it asks for their Linux password), then trying again (the agent restarts on its next use)
  handle('whiq:sandbox', async () => sandbox.status);
  handle('whiq:sandboxSetupWsl', async () => {
    // detached: a console window of its own (Windows), where sudo can ask for the password
    spawn('wsl.exe', ['-e', 'bash', '-lc', wslSetupCommand(version)], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  });
  handle('whiq:sandboxRecheck', async () => { host.stop(); await sandbox.close(); return true; });
  app.on('will-quit', () => { for (const s of watching.values()) s(); watching.clear(); host.stop(); pqvae?.stop(); void sandbox.close(); void live?.then((l) => l.close()); });
  return host;
}
