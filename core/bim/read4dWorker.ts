// Another tool's 4D file (Navisworks TimeLiner, SYNCHRO .sp, IFC 4D, search-set XML, TimeLiner CSV/xlsx) read in a process of its own
// (jobWorker.ts). The reader is parsers over the whole file: one opaque call, bounded by the file's size x the reader rate x 10. The
// result is the import format (plain JSON). Usage: node read4dWorker.ts <job.json> ({ path, dir }). With ifc (a SYNCHRO .sp opened as
// a model, synchroModel.ts): the IFC4 of its 3D objects is written there, and the result is what was read (SynchroSource).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectedMs, opaqueAsync, startHeartbeat } from './heartbeat.mjs';
import { readImport4d } from './read4d.ts';
import { writeSynchroIfc } from './synchroModel.ts';

startHeartbeat();
const file = process.argv[2];
if (!file) { console.error('usage: read4dWorker <job.json>'); process.exit(2); }
try {
  const job = JSON.parse(readFileSync(file, 'utf8')) as { path: string; dir: string; ifc?: string; file?: string };
  const bytes = new Uint8Array(readFileSync(job.path));
  const out = job.ifc
    ? writeSynchroIfc(bytes, job.ifc, job.file ?? job.path) // ticks per object written
    : await opaqueAsync('reading the 4D file', expectedMs(bytes.length, 'navisworks'), () => readImport4d(job.path, bytes));
  writeFileSync(join(job.dir, 'result.json'), JSON.stringify(out));
  writeFileSync(join(job.dir, 'done'), '');
  process.exit(0);
} catch (e) {
  console.error((e as Error).message);
  process.exit(3);
}
