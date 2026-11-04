// The window's way to the embedded platform agent (whiq-host.ts): chats, messages, answers to its questions and
// approvals, stop, the chat's working folder (chosen by the user), its files, and its live events forwarded to the
// window. The agent starts on first use and stops when the app quits or the AI settings change.
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { WhiqHost, type AgentEvent } from './whiq-host.ts';
import { startLiveMcp } from './live-mcp.ts';
import type { AgentModels } from './whiq-config.ts';
import type { AiStore } from './ai.ts';

/** The models the agent runs on: the providers, tiers and seats of the AI settings. */
export const modelsFrom = (ai: AiStore): AgentModels => ai.agentModels() as AgentModels;

export function registerWhiq(getWin: () => BrowserWindow | null, ai: () => AiStore): WhiqHost {
  const vendor = app.isPackaged ? join(process.resourcesPath, 'whiq-agent') : join(app.getAppPath(), 'vendor', 'whiq-agent');
  // the open schedule's MCP server: started with the agent's first start, kept for the app's life
  let live: Promise<{ url: string; token: string; close: () => void }> | null = null;
  const liveMcp = async () => { live ??= startLiveMcp(getWin); const l = await live; return [{ id: 'p6clone_live', label: 'P6 Clone: the open schedule, on screen', url: l.url, token: l.token }]; };
  const host = new WhiqHost({ vendor, data: join(app.getPath('userData'), 'whiq') }, () => modelsFrom(ai()), liveMcp);
  const watching = new Map<string, () => void>();
  const send = (chatId: string, e: AgentEvent) => getWin()?.webContents.send('whiq:event', chatId, e);

  // ---- the chat's working folder: where its files are copied to and attachments go (asked for when first needed)
  const folders = new Map<string, string>(), declined = new Set<string>();
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
  handle('whiq:send', (chatId: string, content: string) => host.api('POST', '/api/agent/send', { chatId, content }));
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
  handle('whiq:folder', (chatId: string) => folderOf(chatId));
  handle('whiq:openPath', async (p: string) => { const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
  handle('whiq:showInFolder', async (p: string) => { shell.showItemInFolder(p); return true; });
  handle('whiq:watch', async (chatId: string) => {
    if (watching.has(chatId)) return true;
    watching.set(chatId, await host.stream(chatId, (e) => { send(chatId, e); if (e.type === 'preview_update' || e.type === 'done') void syncFiles(chatId); }));
    return true;
  });
  handle('whiq:unwatch', async (chatId: string) => { watching.get(chatId)?.(); watching.delete(chatId); return true; });

  app.on('will-quit', () => { for (const s of watching.values()) s(); watching.clear(); host.stop(); void live?.then((l) => l.close()); });
  return host;
}
