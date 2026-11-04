// The Electron main process of tests/e2e/pyodide-sandbox.ts: starts the desktop code sandbox (main/sandbox/pyodideService.ts) and writes
// its address and self-test to the file named by P6_SBX_OUT. Nothing else of the app is loaded. The process ends when the test closes it.
import { app, dialog } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });
dialog.showErrorBox = () => {};   // a failure prints; it never opens a dialog on the user's screen
const root = join(import.meta.dirname, '..', '..');
const out = process.env.P6_SBX_OUT;
app.on('window-all-closed', () => {});   // the sandbox opens and closes hidden windows; the process lives until the test ends it
app.setPath('userData', mkdtempSync(join(tmpdir(), 'p6sbx-harness-')));
const svc = await import(pathToFileURL(join(root, 'main', 'sandbox', 'pyodideService.ts')).href);
svc.registerSandboxScheme();
app.whenReady().then(async () => {
  try {
    const t0 = Date.now();
    const sb = await svc.startPyodideSandbox({ dir: join(root, 'vendor', 'pyodide'), pageDir: join(root, 'main', 'sandbox', 'page') });
    writeFileSync(out, JSON.stringify({ url: sb.url, selftest: sb.selftest, startedMs: Date.now() - t0 }));
  } catch (e) {
    writeFileSync(out, JSON.stringify({ error: String((e && e.stack) || e) }));
  }
});
