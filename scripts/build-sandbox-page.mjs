// The desktop code sandbox's page (main/sandbox/page: index.html, page.js, worker.js, preload.cjs) is served and loaded as plain files,
// not bundled, so the build only copies them next to the built main process: dist/sandbox-page/ (main/sandbox/pyodideService.ts looks
// there first). Pyodide itself is not here: vendor/pyodide/ (scripts/fetch-pyodide.mjs), which packaging copies to resources/pyodide.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function buildSandboxPage() {
  const from = join(root, 'main', 'sandbox', 'page'), to = join(root, 'dist', 'sandbox-page');
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from)) cpSync(join(from, f), join(to, f));
  return to;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log('copied to', buildSandboxPage());
