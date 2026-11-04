// The window's way to the embedded platform agent (whiq-host.ts): chats, messages, answers to its questions and
// approvals, stop, the chat's working folder (chosen by the user), its files, and its live events forwarded to the
// window. The agent starts on first use and stops when the app quits or the AI settings change.
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { WhiqHost, type AgentEvent } from './whiq-host.ts';
import type { AgentModels } from './whiq-config.ts';
import type { AiStore } from './ai.ts';

/** The models the agent runs on, from the AI settings (one provider and model until the seats page exists). */
export function modelsFrom(ai: AiStore): AgentModels {
  const c = ai.publicConfig();
  if (!c.model) throw new Error('Set a model in Tools > AI Assistant Settings first.');
  return {
    providers: [{ name: 'main', type: c.provider === 'anthropic' ? 'anthropic' : 'openai-compat', baseUrl: c.baseUrl, key: ai.key() }],
    tiers: [{ name: 'Main', provider: 'main', model: c.model }],
  };
}

export function registerWhiq(getWin: () => BrowserWindow | null, ai: () => AiStore): WhiqHost {
  const vendor = app.isPackaged ? join(process.resourcesPath, 'whiq-agent') : join(app.getAppPath(), 'vendor', 'whiq-agent');
  const host = new WhiqHost({ vendor, data: join(app.getPath('userData'), 'whiq') }, () => modelsFrom(ai()));
  const watching = new Map<string, () => void>();
  const send = (chatId: string, e: AgentEvent) => getWin()?.webContents.send('whiq:event', chatId, e);
  // every handler answers {ok, ...} or {ok: false, error}: a failure reaches the panel as words, never a crash
  const handle = (ch: string, fn: (...a: any[]) => Promise<unknown>) =>
    ipcMain.handle(ch, async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (err) { return { ok: false, error: (err as Error).message }; } });

  handle('whiq:status', async () => ({ ...host.status, missing: host.available() }));
  handle('whiq:createChat', (title?: string) => host.api('POST', '/api/chats', { title: title || 'Scheduler', module: 'scheduler' }));
  handle('whiq:chat', (chatId: string) => host.api('GET', `/api/chats/${encodeURIComponent(chatId)}`));
  handle('whiq:send', (chatId: string, content: string) => host.api('POST', '/api/agent/send', { chatId, content }));
  handle('whiq:askReply', (chatId: string, toolCallId: string, reply: unknown) => host.api('POST', '/api/agent/ask-reply', { chatId, toolCallId, reply }));
  handle('whiq:approval', (toolCallId: string, kind: 'approve' | 'skip', note?: string) => host.api('POST', '/api/agent/approval', { toolCallId, kind, note }));
  handle('whiq:abort', (chatId: string) => host.api('POST', '/api/agent/abort', { chatId }));
  handle('whiq:resume', (chatId: string) => host.api('POST', '/api/agent/resume', { chatId }));
  handle('whiq:files', (chatId: string) => host.api('GET', `/api/files?chatId=${encodeURIComponent(chatId)}`));
  /** The user picks the chat's working folder (where its files go and what it may read). Null when cancelled. */
  handle('whiq:chooseFolder', async (chatId: string) => {
    const win = getWin();
    const r = win ? await dialog.showOpenDialog(win, { title: 'Working folder for the AI agent', properties: ['openDirectory', 'createDirectory'] }) : null;
    if (!r || r.canceled || !r.filePaths[0]) return null;
    return host.api('POST', '/api/working-dir/set', { chatId, path: r.filePaths[0] });
  });
  handle('whiq:openPath', async (p: string) => { const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
  handle('whiq:showInFolder', async (p: string) => { shell.showItemInFolder(p); return true; });
  handle('whiq:watch', async (chatId: string) => {
    if (watching.has(chatId)) return true;
    watching.set(chatId, await host.stream(chatId, (e) => send(chatId, e)));
    return true;
  });
  handle('whiq:unwatch', async (chatId: string) => { watching.get(chatId)?.(); watching.delete(chatId); return true; });

  app.on('will-quit', () => { for (const s of watching.values()) s(); watching.clear(); host.stop(); });
  return host;
}
