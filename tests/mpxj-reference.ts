// MPXJ as the reference for Microsoft Project values: the same Java process and jars the clone reads .mpp files with (core/msp/mpp.ts), asked
// for its own reading of a file as JSON (org.mpxj.sample.MpxjConvert writes .json by the output's extension: every task, resource and
// assignment with the values MPXJ holds, durations in seconds). No Java class of ours: nothing to compile.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { classPath, javaPath, mpxjHome } from '../core/msp/mpp.ts';

/** Why the reference is not available here (no MPXJ jars, no Java), or null when it is. */
export function referenceMissing(): string | null {
  const home = mpxjHome();
  if (!home) return 'MPXJ is not here (node scripts/build-cli.mjs, or fetchMpxj from scripts/mpxj-files.mjs, fetches the pinned jars into .cache/mpxj)';
  if (!existsSync(join(home, 'jackson-databind-2.22.3.jar')) && !existsSync(join(home, 'lib', 'jackson-databind-2.22.3.jar'))) return 'the pinned jackson jars (the JSON writer of MPXJ) are not in the MPXJ folder';
  const v = spawnSync(javaPath(home), ['-version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) return `no Java here (${javaPath(home)})`;
  return null;
}

export interface MpxjProject { property_values: Record<string, unknown>; tasks: Record<string, any>[]; resources: Record<string, any>[]; assignments: Record<string, any>[] }
/** What MPXJ itself reads from a .mpp or Microsoft Project XML file (never through the clone). */
export function mpxjRead(path: string): MpxjProject {
  const home = mpxjHome()!, dir = mkdtempSync(join(tmpdir(), 'p6ref-'));
  try {
    const input = join(dir, `in${extname(path).toLowerCase()}`), out = join(dir, 'out.json');
    copyFileSync(path, input);
    const r = spawnSync(javaPath(home), ['-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory', '-Djava.awt.headless=true', '-cp', classPath(home), 'org.mpxj.sample.MpxjConvert', input, out], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0 || !existsSync(out)) throw new Error(`MPXJ could not read ${path}: ${(r.stderr || r.stdout).slice(-400)}`);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
