#!/usr/bin/env node
/**
 * Revit to IFC4 — runs in its OWN process (spawned by rvt.ts): rvt-rs's WebAssembly reader (rvt/, Apache-2.0, with the
 * clone's changes in rvt/p6clone.patch) opens the .rvt / .rfa and writes the model as IFC4 a piece at a time (the model
 * never comes into JavaScript, the IFC is never one string), at the best quality the file allows (element geometry,
 * else typed elements, else the spatial scaffold), with Revit's own property sets where the file saves its parameters
 * (Revit 2023 and later), and rvt-rs's diagnostics: what it read, approximated or left out.
 * Usage: node rvtWorker.mjs <revit file> <out.ifc> <out.json>
 * Writes <out.ifc> and <out.json> ({ metadata, mode, diagnostics, revit_property_sets }), each whole or not at all.
 */
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
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
const tmp = `${outIfc}.${process.pid}.tmp`;
let answer = null, mode = null;
const why = [];
for (const m of ['geometry', 'typed-no-geometry', 'scaffold']) {
  const fd = openSync(tmp, 'w');
  globalThis.__rvtIfcSink = (chunk) => { writeSync(fd, chunk); };
  try { answer = rvt.rvtToIfcStream(bytes, m, true); mode = m; } catch (e) { why.push(`${m}: ${String(e?.message ?? e)}`); } finally { closeSync(fd); }
  if (mode) break;
}
if (!mode) { rmSync(tmp, { force: true }); console.error(`not a readable Revit file (${why.join('; ')})`); process.exit(3); }
renameSync(tmp, outIfc);
const json = `${outJson}.${process.pid}.tmp`;
writeFileSync(json, JSON.stringify({ metadata, mode, diagnostics: answer.diagnostics, revit_property_sets: answer.revit_property_sets, tried: why }));
renameSync(json, outJson);
process.exit(0);
