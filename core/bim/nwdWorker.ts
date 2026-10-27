// Navisworks reader — runs in its OWN process (spawned by nwd.ts; shipped bundled as ifc/nwdWorker.mjs): the job in
// <job.json> (nwd/job.ts), progress as lines "progress <done> <total> <note>" on stdout, and what was read, with this
// process's peak memory, in <job.json>.out.json, written last (whole or absent).
// Usage: node nwdWorker.ts <job.json>
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { runJob, type NwJob } from './nwd/job.ts';

const file = process.argv[2];
if (!file) { console.error('usage: nwdWorker <job.json>'); process.exit(2); }
try {
  const job = JSON.parse(readFileSync(file, 'utf8')) as NwJob;
  const source = await runJob(job, (d, t, note) => { process.stdout.write(`progress ${d} ${t} ${note.replace(/\n/g, ' ')}\n`); });
  const peak = Math.round(process.resourceUsage().maxRSS / 1024);
  writeFileSync(`${file}.out.tmp`, JSON.stringify({ ...source, peak_memory_mb: peak }));
  renameSync(`${file}.out.tmp`, `${file}.out.json`);
  process.exit(0);
} catch (e) {
  console.error((e as Error).message);
  process.exit(3);
}
