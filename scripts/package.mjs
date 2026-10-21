// Package the app as a normal Windows program folder (no installer, no extra tools):
// release/P6 Clone/P6 Clone.exe plus a shortcut with the app icon. Uses Electron's own prebuilt runtime.
// Usage: node scripts/package.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconIco } from './icon.mjs';
import { copyIfc, copyReasoner } from './ort-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });

const out = join(root, 'release', 'P6 Clone');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'node_modules/electron/dist'), out, { recursive: true });
renameSync(join(out, 'electron.exe'), join(out, 'P6 Clone.exe'));
rmSync(join(out, 'resources', 'default_app.asar'), { force: true });

const app = join(out, 'resources', 'app');
mkdirSync(app, { recursive: true });
cpSync(join(root, 'dist'), join(app, 'dist'), { recursive: true, filter: (p) => !p.endsWith('.map') });
await copyReasoner(root, app); // the schedule reasoner and its WebAssembly runtime (the main process runs it)
copyIfc(root, app); // 4D: the IFC engine (the main process reads models)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// same name as the development build, so both use the same saved database
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, main: 'dist/main.cjs' }, null, 2));
writeFileSync(join(out, 'P6 Clone.ico'), iconIco());

// a shortcut with the icon, next to the exe (copy it to the Desktop or Start menu if wanted)
const lnk = join(root, 'release', 'P6 Clone.lnk');
const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');$s.TargetPath='${join(out, 'P6 Clone.exe').replace(/'/g, "''")}';$s.WorkingDirectory='${out.replace(/'/g, "''")}';$s.IconLocation='${join(out, 'P6 Clone.ico').replace(/'/g, "''")},0';$s.Description='Primavera P6 Professional (Clone)';$s.Save()`;
if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
console.log(`packaged: ${out}${existsSync(lnk) ? `\nshortcut: ${lnk}` : ''}`);
