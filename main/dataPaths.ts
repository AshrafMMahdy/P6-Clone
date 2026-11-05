// Where the app keeps its own data (owner, 2026-11-05): in the install folder, beside the program, in folders a person
// can read, rather than hidden in AppData:
//   Data\Database      the schedules (p6clone-db.json)
//   Data\Settings      AI settings (the keys still encrypted with Windows' own protection)
//   Data\Projects\<project>\   each project's agent folder: 00_INPUTS, AI Outputs, Notes (the default working folder)
//   Data\Memories      the agent's memories as Markdown, by scope and kind
//   Data\Agent         the embedded agent's own files (chats, jobs, engines' staging); Data\4D: 4D models and viewers
//   Data\Cache, Data\Logs
// The root: P6CLONE_DATA; else, for a run with --user-data <dir> (tests, automation), <dir>\Data; else beside the program
// (the packaged exe's folder; the repository in a development run). When that folder cannot be written (an install
// under Program Files), AppData keeps it and the reason is logged. Chromium's own files (caches, and "Local State",
// which unlocks the encrypted keys) stay in AppData.
// The first start of this layout moves the data of the AppData layout into it: copied, checked, and the original kept
// beside under a ".moved" name, so nothing is lost if anything goes wrong.
import { app } from 'electron';
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let root: string | null = null;
/** Why the data is not beside the program (when it is not), for the log and the About box. */
export let dataNote = '';

function writable(dir: string): boolean {
  try { mkdirSync(dir, { recursive: true }); const probe = join(dir, '.write-test'); writeFileSync(probe, ''); rmSync(probe); return true; } catch { return false; }
}

/** The data root (decided once; app.setPath('userData') must have run for a --user-data run). */
export function dataRoot(): string {
  if (root) return root;
  const argv = process.argv, i = argv.indexOf('--user-data');
  const wanted = process.env.P6CLONE_DATA
    || (i > 0 && argv[i + 1] ? join(argv[i + 1], 'Data')
    : app.isPackaged ? join(dirname(process.execPath), 'Data') : join(app.getAppPath(), 'Data'));
  if (writable(wanted)) root = wanted;
  else { root = join(app.getPath('userData'), 'Data'); dataNote = `The folder beside the program (${wanted}) cannot be written, so the data is kept in ${root}.`; mkdirSync(root, { recursive: true }); }
  return root;
}

/** A folder (made when missing) or a file path under the data root. */
export const dataDir = (...parts: string[]): string => { const d = join(dataRoot(), ...parts); mkdirSync(d, { recursive: true }); return d; };
export const dataFile = (...parts: string[]): string => { const f = join(dataRoot(), ...parts); mkdirSync(dirname(f), { recursive: true }); return f; };

/** What the AppData layout had, and where it goes. */
// (in this order: the agent's logs and caches leave its folder before the rest of it becomes Agent, and Agent exists
// before the panel's own chats go into it)
const LEGACY: [string, string[]][] = [
  ['p6clone-db.json', ['Database', 'p6clone-db.json']],
  ['ai-assistant.json', ['Settings', 'ai-assistant.json']],
  ['models-dev.json', ['Cache', 'models-dev.json']],
  ['4d', ['4D']],
  ['whiq/logs', ['Logs']],
  ['whiq/pqvae-text-cache', ['Cache', 'pqvae-text']],
  ['whiq/sandbox-snapshots', ['Cache', 'sandbox-snapshots']],
  ['whiq', ['Agent']],
  ['ai-chats', ['Agent', 'panel-chats']],
];

/** Moves the AppData layout's data into the data root, once (a target that exists is never overwritten). Returns what moved. */
export function moveLegacyData(): string[] {
  const from = app.getPath('userData'), moved: string[] = [];
  if (join(dataRoot()) === join(from)) return moved;
  for (const [old, parts] of LEGACY) {
    const src = join(from, old), dst = join(dataRoot(), ...parts);
    if (!existsSync(src) || existsSync(dst)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      if (statSync(src).isDirectory()) cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, filter: (p) => !p.endsWith('.moved') });
      else { copyFileSync(src, dst); if (statSync(dst).size !== statSync(src).size) throw new Error('the copy is not the same size'); }
      renameSync(src, `${src}.moved`);   // kept as it was, beside: the backup of the move
      moved.push(`${old} -> ${join(...parts)}`);
    } catch (e) {
      rmSync(dst, { recursive: true, force: true });   // half a copy is no copy: the original stays in use next time
      console.error(`[data] could not move ${src} to ${dst}: ${(e as Error).message}`);
    }
  }
  return moved;
}
