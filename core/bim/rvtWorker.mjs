#!/usr/bin/env node
/**
 * Revit to IFC4 — runs in its OWN process (spawned by rvt.ts): rvt-rs's WebAssembly reader (rvt/, Apache-2.0) opens the
 * .rvt / .rfa and writes the model as IFC4, at the best quality the file allows (element geometry, else typed elements,
 * else the spatial scaffold), with rvt-rs's diagnostics: what it read, approximated or left out.
 * Usage: node rvtWorker.mjs <revit file> <out.ifc> <out.json>
 * Writes <out.ifc> and <out.json> ({ metadata, mode, diagnostics }), each whole or not at all.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [src, outIfc, outJson] = process.argv.slice(2);
if (!src || !outIfc || !outJson) { console.error('usage: rvtWorker.mjs <revit file> <out.ifc> <out.json>'); process.exit(2); }
const dir = join(dirname(fileURLToPath(import.meta.url)), 'rvt');
const rvt = await import(pathToFileURL(join(dir, 'rvt.js')).href);
rvt.initSync({ module: readFileSync(join(dir, 'rvt_bg.wasm')) });

const bytes = new Uint8Array(readFileSync(src));
let metadata = null;
try { metadata = rvt.fileMetadata(bytes); } catch { /* not every file carries it; the open below says why it fails */ }
let opened = null, mode = null, why = [];
for (const m of ['geometry', 'typed-no-geometry', 'scaffold']) {
  try { opened = rvt.openRvtBytesWithDiagnosticsMode(bytes, m); mode = m; break; } catch (e) { why.push(`${m}: ${String(e?.message ?? e)}`); }
}
if (!opened) { console.error(`not a readable Revit file (${why.join('; ')})`); process.exit(3); }
const ifc = rvt.modelToIfcStep(opened.model);
const put = (file, text) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, file); };
put(outIfc, ifc);
put(outJson, JSON.stringify({ metadata, mode, diagnostics: opened.diagnostics, tried: why }));
process.exit(0);
