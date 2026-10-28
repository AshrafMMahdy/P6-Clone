// The IFC index, built in a process of its own (jobWorker.ts): stepIndex's streaming STEP pass and the index made from it, written as the
// index file the cache uses (indexFile.ts), which the server reads back. Usage: node indexWorker.ts <job.json> ({ ifc, dir }).
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectedMs, startHeartbeat, step } from './heartbeat.mjs';
import { stepIndex } from './stepIndex.ts';
import { writeIndex } from './indexFile.ts';

startHeartbeat();
const file = process.argv[2];
if (!file) { console.error('usage: indexWorker <job.json>'); process.exit(2); }
try {
  const job = JSON.parse(readFileSync(file, 'utf8')) as { ifc: string; dir: string };
  const size = statSync(job.ifc).size, work = expectedMs(size, 'index');
  // a tick per 1 MB read (stepIndex: progress(bytes)); the pass that follows the scan has no ticks of its own: it may take 10 x the size's work
  step('indexing the IFC (bytes read)', { total: size, cap: work });
  const { index } = await stepIndex(job.ifc);
  step('writing the index file', { cap: work }); // ticks per 4096 elements (writeIndex: alive)
  writeIndex(join(job.dir, 'index'), index);
  writeFileSync(join(job.dir, 'done'), '');
  process.exit(0);
} catch (e) {
  console.error((e as Error).message);
  process.exit(3);
}
