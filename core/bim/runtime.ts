// Where the IFC engine's parts are: in the repository, web-ifc from node_modules and the worker beside this file; beside
// a bundle (MCP/CLI dist-cli, the desktop app), an ifc/ folder with web-ifc and geomWorker.mjs (not a node_modules
// folder: the White Hat IQ platform's signed manifest and patch builder skip those). Loaded by absolute path.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = () => { try { return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url)); } catch { return null; } };
const homes = () => { const h = here(); return h ? [h, join(h, '..'), join(h, '..', '..')] : []; };
const shipped = (rel: string) => { for (const p of homes()) { const f = join(p, 'ifc', rel); if (existsSync(f)) return f; } return null; };

/** web-ifc's Node entry: a file URL beside a bundle, else the package name. */
export function webIfcEntry(): string { const f = shipped(join('web-ifc', 'web-ifc-api-node.js')); return f ? pathToFileURL(f).href : 'web-ifc'; }

/** The geometry worker script (run in its own process). */
export function geomWorkerPath(): string | null {
  const explicit = process.env.P6CLONE_IFC_GEOM_WORKER;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const h = here(), own = h ? join(h, 'geomWorker.mjs') : null;
  return own && existsSync(own) ? own : shipped('geomWorker.mjs');
}

/** The Revit reader's worker script (rvt-rs's WebAssembly in rvt/ beside it), run in its own process. */
export function rvtWorkerPath(): string | null {
  const explicit = process.env.P6CLONE_RVT_WORKER; // the environment only (a test's stand-in worker; a tool argument never chooses a program)
  if (explicit) return existsSync(explicit) ? explicit : null;
  const h = here(), own = h ? join(h, 'rvtWorker.mjs') : null;
  return own && existsSync(own) ? own : shipped('rvtWorker.mjs');
}

/** The Navisworks reader's worker (run in its own process): the TypeScript beside this file under Node (the
 *  repository), else nwdWorker.mjs, the bundle made of it, in ifc/. Null in Electron without the bundle: then the
 *  reader runs in the app's own process. */
export function nwdWorkerPath(): string | null {
  const explicit = process.env.P6CLONE_NWD_WORKER;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const h = here(), own = h ? join(h, 'nwdWorker.ts') : null;
  if (own && !process.versions.electron && existsSync(own)) return own;
  return shipped('nwdWorker.mjs');
}

/** A worker bundled like the Navisworks reader's: the TypeScript beside this file under Node (the repository), else the bundle in ifc/.
 *  Null in Electron without the bundle (then the work runs in the app's own process). `env` names the variable a test's stand-in uses. */
function bundledWorker(ts: string, mjs: string, env: string): string | null {
  const explicit = process.env[env];
  if (explicit) return existsSync(explicit) ? explicit : null;
  const h = here(), own = h ? join(h, ts) : null;
  if (own && !process.versions.electron && existsSync(own)) return own;
  return shipped(mjs);
}
/** The IFC index worker (indexWorker.ts, run in its own process). */
export const indexWorkerPath = (): string | null => bundledWorker('indexWorker.ts', 'indexWorker.mjs', 'P6CLONE_INDEX_WORKER');
/** The 4D file reader's worker (read4dWorker.ts, run in its own process). */
export const read4dWorkerPath = (): string | null => bundledWorker('read4dWorker.ts', 'read4dWorker.mjs', 'P6CLONE_READ4D_WORKER');

/** web-ifc as a module object (its CommonJS build arrives as the default export when imported). */
export async function loadWebIfc(): Promise<any> { const m: any = await import(webIfcEntry()); return m.IfcAPI ? m : m.default; }
