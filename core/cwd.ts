// The current directory is nothing the server may depend on: a launcher can delete the folder it started the server in. Node itself reads it
// when a worker thread or a child process starts (and the main thread caches the first answer, so a deleted folder goes unnoticed there), so
// a server whose folder is gone moves to a folder that exists before it starts one; every path the program itself needs comes from the bundle's
// own location or is absolute.
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isMainThread } from 'node:worker_threads';

let lost: string | null = null;
/** The folder the process was started in once it has been found gone (the process then works from another one), else null. A relative path has nothing to
 *  be taken from then: tools refuse it (pathArg) rather than put the file somewhere nobody looks. */
export const cwdLost = (): string | null => lost;
/** A worker thread is told by the main thread (it cannot move the process itself). */
export const markCwdLost = (was: string | null): void => { if (was) lost = was; };
/** The current directory when it still exists; else (and the process moves there, on the main thread) a folder that does. Never throws. */
export function ensureCwd(): string {
  let was = lost;
  try { const c = process.cwd(); if (existsSync(c)) return c; was = c; } catch { was ??= '(deleted)'; /* gone: uv_cwd ENOENT */ }
  for (const d of [tmpdir(), homedir(), '/']) {
    try { if (isMainThread && existsSync(d)) { process.chdir(d); lost = was ?? '(deleted)'; return d; } } catch { /* try the next */ }
  }
  return tmpdir();
}
/** process.cwd() for code that only wants a base for a relative path: never throws. */
export const safeCwd = (): string => { try { return process.cwd(); } catch { return ensureCwd(); } };
