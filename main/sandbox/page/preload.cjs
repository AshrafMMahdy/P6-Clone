// The only thing the sandbox page gets from the app: a way to take requests in and send answers out. Nothing else of
// Electron or Node is exposed to the page (contextIsolation is on, so this file's own scope is not the page's), and the
// main process accepts these messages only from this window's own page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sbx', {
  send: (message) => { ipcRenderer.send('p6sandbox:up', message); },
  onMessage: (callback) => { ipcRenderer.on('p6sandbox:down', (_event, message) => callback(message)); },
  /** what the page can tell the main process about its own process (the self-test compares it with what the main process sees) */
  facts: { sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true },
});
