#!/usr/bin/env node
/**
 * Revit to IFC4 — runs in its OWN process (spawned by rvt.ts): rvt-rs's WebAssembly reader (rvt/, Apache-2.0, with the
 * clone's changes in rvt/p6clone.patch) opens the .rvt / .rfa and writes the model as IFC4 a piece at a time (the model
 * never comes into JavaScript, the IFC is never one string), at the best quality the file allows (element geometry,
 * else typed elements, else the spatial scaffold), with Revit's own property sets where the file saves its parameters
 * (Revit 2023 and later), and rvt-rs's diagnostics: what it read, approximated or left out.
 * Usage: node rvtWorker.mjs <revit file> <out.ifc> <out.json>
 * Writes <out.ifc> and <out.json> ({ metadata, mode, diagnostics, revit_property_sets }), each whole or not at all.
 * Exit codes: 0 done; 2 usage; 3 not a readable Revit file (after trying the three modes); 4 the disk could not take the
 * IFC (ENOSPC and other write errors); 5 the reader ran out of working memory (WebAssembly's 4 GB, or the machine's).
 * A disk or memory failure ends the run at once: it is not a property of the file, so the lesser modes (typed elements,
 * the spatial scaffold) are not tried, and nothing is written that would be taken for the file's conversion.
 */
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [src, outIfc, outJson] = process.argv.slice(2);
if (!src || !outIfc || !outJson) { console.error('usage: rvtWorker.mjs <revit file> <out.ifc> <out.json>'); process.exit(2); }
const dir = join(dirname(fileURLToPath(import.meta.url)), 'rvt');
const rvt = await import(pathToFileURL(join(dir, 'rvt.js')).href);
const memory = rvt.initSync({ module: readFileSync(join(dir, 'rvt_bg.wasm')) })?.memory; // the WebAssembly memory, to tell a full one from another trap

const bytes = new Uint8Array(readFileSync(src));
let metadata = null;
try { metadata = rvt.fileMetadata(bytes); } catch { /* not every file carries it; the open below says why it fails */ }
const tmp = `${outIfc}.${process.pid}.tmp`;
let answer = null, mode = null;
const why = [];
let sinkError = null;
/** Did the reader run out of working memory? Its WebAssembly memory cannot pass 4 GB, and a failed allocation ends in a trap. */
const outOfMemory = (e) => {
  const msg = String(e?.message ?? e);
  return /out of memory|memory allocation|cannot allocate|allocation failed|maximum memory size|invalid array length|array buffer allocation|memory\.grow|WebAssembly\.\w+\(\).*memory/i.test(msg)
    || (/unreachable|memory access out of bounds/i.test(msg) && (memory?.buffer.byteLength ?? 0) > 3.5 * 2 ** 30);
};
const stop = (code, kind, e) => { try { rmSync(tmp, { force: true }); } catch { /* gone */ } console.error(`${kind}: ${String(e?.message ?? e).slice(0, 300)}`); process.exit(code); };
for (const m of ['geometry', 'typed-no-geometry', 'scaffold']) {
  const fd = openSync(tmp, 'w');
  // a write error unwinds through the WebAssembly and arrives below as "geometry failed": kept, so it is told apart
  globalThis.__rvtIfcSink = (chunk) => { try { writeSync(fd, chunk); } catch (e) { sinkError ??= e; throw e; } };
  try { answer = rvt.rvtToIfcStream(bytes, m, true); mode = m; } catch (e) {
    if (sinkError) { closeSync(fd); stop(4, 'disk_full', sinkError); }
    if (outOfMemory(e)) { closeSync(fd); stop(5, 'out_of_memory', e); }
    why.push(`${m}: ${String(e?.message ?? e)}`);
  } finally { try { closeSync(fd); } catch { /* closed above */ } }
  if (mode) break;
}
if (!mode) { rmSync(tmp, { force: true }); console.error(`not a readable Revit file (${why.join('; ')})`); process.exit(3); }
renameSync(tmp, outIfc);
const json = `${outJson}.${process.pid}.tmp`;
writeFileSync(json, JSON.stringify({ metadata, mode, diagnostics: answer.diagnostics, revit_property_sets: answer.revit_property_sets, tried: why }));
renameSync(json, outJson);
process.exit(0);
