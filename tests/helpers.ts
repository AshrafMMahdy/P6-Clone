import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SAMPLES_DIR = join(import.meta.dirname, '..', 'Sample XERs');

const AGENT_USERS = ['White Hat IQ Scheduler', 'NordBuild', 'NordBuild Oy', 'NordBuild Scheduling', 'AuroraSubA', 'Polaris DC-1', 'P6 User', 'ECC-BK-CS'];

/** Files known to be corrupted (bit flips) — real P6 exports damaged in transit. */
export const CORRUPT = ['CCA R03 dt 24Oct11SC.xer'];

export interface Sample { name: string; bytes: Uint8Array; realP6: boolean }

/** A copy of a sample in a folder of this test process's own, for a test that hands the file to a SERVER PROCESS. A server
 *  that leaves with unsaved changes writes `<name>.recovered-<stamp>.xer` beside the file it opened, so a server opening the
 *  shared fixture folder in place put (and removed again, after it had exited) files in it that tests running in parallel
 *  listed and then failed to read (msp.test.ts: ENOENT on a recovered file). The fixture folder is read-only to tests. */
let own: string | null = null;
export function sampleCopy(name: string): string {
  if (!own) { own = mkdtempSync(join(tmpdir(), 'p6-samples-')); const dir = own; process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the temp cleaner */ } }); }
  const to = join(own, name);
  try { copyFileSync(join(SAMPLES_DIR, name), to, 1 /* COPYFILE_EXCL: once */); } catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; }
  return to;
}

export function samples(): Sample[] {
  // (a recovery file is never a sample, whoever wrote it)
  return readdirSync(SAMPLES_DIR).filter((f) => f.toLowerCase().endsWith('.xer') && !/\.recovered-\d/.test(f)).sort().map((name) => {
    const bytes = new Uint8Array(readFileSync(join(SAMPLES_DIR, name)));
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 400)).split(/\r?\n/)[0].split('\t');
    const realP6 = head[0] === 'ERMHDR' && head[1] !== '12.0' && !AGENT_USERS.includes(head[5] ?? '') && !AGENT_USERS.includes(head[4] ?? '') && !/^20(2[5-9])/.test(head[2] ?? '');
    return { name, bytes, realP6 };
  });
}

export function realSamples(): Sample[] {
  return samples().filter((s) => s.realP6 && !CORRUPT.includes(s.name));
}

export function xer(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\n/g, '\r\n'));
}
