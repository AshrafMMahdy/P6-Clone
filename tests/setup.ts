// Preloaded by `npm test` (node --import ./tests/setup.ts --test ...): the whole run works in ONE private temp folder, so no test fills the
// machine's /tmp. TMPDIR/TMP/TEMP point at it, which also moves the server's recovery folder (<temp>/.p6clone-recovery, runtime.ts) into it.
// The process that starts the run (the test runner) makes the folder and removes it at its end; every test file's process, and the servers they
// start, inherit it through P6CLONE_TEST_TMP and leave it to the runner.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir = process.env.P6CLONE_TEST_TMP;
if (!dir) {
  const own = mkdtempSync(join(tmpdir(), 'p6-test-'));
  dir = process.env.P6CLONE_TEST_TMP = own;
  const clean = () => { try { rmSync(own, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the next run's /tmp cleaner */ } };
  process.once('exit', clean);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => { clean(); process.exit(1); });
}
process.env.TMPDIR = process.env.TMP = process.env.TEMP = dir;
