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

/** web-ifc as a module object (its CommonJS build arrives as the default export when imported). */
export async function loadWebIfc(): Promise<any> { const m: any = await import(webIfcEntry()); return m.IfcAPI ? m : m.default; }
