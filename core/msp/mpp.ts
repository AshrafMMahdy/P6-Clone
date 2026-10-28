// Microsoft Project .mpp files read without Microsoft Project: MPXJ (LGPL-2.1+, mpxj/ beside the program; the
// repository's .cache/mpxj, filled by scripts/mpxj-files.mjs) turns the file into Microsoft Project XML in a Java process
// of its own, and the clone reads that XML as it reads any (mspdi.ts): every element of every task, resource,
// assignment and calendar, as the file has it. Java: P6CLONE_JAVA, else the runtime shipped in mpxj/jre/<os>-<arch>/,
// else the machine's own. MPXJ reads .mpp; it does not write it (save as Microsoft Project XML, which Project opens).
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedMs } from '../bim/heartbeat.mjs';
import { externalWatch, StuckError, treeCpuMs, workerFloorMs, type StuckInfo } from '../bim/liveness.ts';
import { Chunked } from '../xml/p6xml.ts';

const here = () => { try { return typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url)); } catch { return null; } };
/** The MPXJ folder (lib/ with the jars, jre/ with the runtimes): beside a bundle, else the repository's cache. */
export function mpxjHome(): string | null {
  const explicit = process.env.P6CLONE_MPXJ;
  if (explicit) return existsSync(join(explicit, 'lib')) ? explicit : null;
  const h = here();
  if (!h) return null;
  for (const d of [h, join(h, '..'), join(h, '..', '..'), join(h, '..', '..', '..')]) {
    if (existsSync(join(d, 'mpxj', 'lib'))) return join(d, 'mpxj');
    if (existsSync(join(d, '.cache', 'mpxj', 'mpxj-16.10.0.jar'))) return join(d, '.cache', 'mpxj');
  }
  return null;
}
const platformDir = () => `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch}`;
/** The Java that runs MPXJ: P6CLONE_JAVA, the shipped runtime for this machine, else "java" (the machine's own). */
export function javaPath(home = mpxjHome()): string {
  if (process.env.P6CLONE_JAVA) return process.env.P6CLONE_JAVA;
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const shipped = home ? join(home, 'jre', platformDir(), 'bin', exe) : null;
  return shipped && existsSync(shipped) ? shipped : 'java';
}
const classPath = (home: string) => (existsSync(join(home, 'lib')) ? join(home, 'lib', '*') : join(home, '*'));

/** The .mpp reader is not here (no MPXJ, or no Java): refused in words, with what to do. */
export class MppReaderMissing extends Error {}

/** A text file read in pieces of about `pieceBytes` (never one string: a document can be larger than the longest string, about 512 MB). A BOM is dropped. */
export function readChunked(path: string, pieceBytes = Number(process.env.P6CLONE_XML_CHUNK_BYTES) || 32 * 1048576): Chunked {
  const out = new Chunked(), fd = openSync(path, 'r'), dec = new StringDecoder('utf8'), buf = Buffer.alloc(Math.max(1024, pieceBytes));
  try {
    let first = true;
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      let piece = dec.write(buf.subarray(0, n));
      if (first && piece) { piece = piece.replace(/^\uFEFF/, ''); first = false; }
      out.push(piece);
    }
    out.push(dec.end());
  } finally { closeSync(fd); }
  return out;
}

/** What the conversion was doing when it was ended, in words: the step, the silence or the bound with its value, what was tried, the alternatives. */
export const mppStuck = (stuck: StuckInfo): StuckError => new StuckError({ ...stuck, step: 'reading the .mpp (MPXJ, in a Java process of its own)' }, {
  what: 'The .mpp reader (MPXJ)', tried: 'one conversion of the file to Microsoft Project XML in a Java process of its own; the file was read the one way this installation reads an .mpp without Microsoft Project',
  next: 'open the .mpp in Microsoft Project and save it as Microsoft Project XML (File > Save As > XML), then open that; or export the schedule from the source tool as XER or XML; or split a very large project',
});

/** The Microsoft Project XML of a .mpp file (MPXJ in its own process; no time limit: watched for life). Read in pieces, never as one string. */
export async function mppToMspdi(path: string): Promise<Chunked> {
  const home = mpxjHome();
  if (!home) throw new MppReaderMissing('The .mpp reader (MPXJ, in mpxj/ beside the program) is missing from this installation.');
  const dir = mkdtempSync(join(tmpdir(), 'p6clone-mpp-'));
  // a plain name: Java on Windows reads its arguments in the system code page, which mangles an Arabic or Chinese name
  const input = join(dir, 'in.mpp'), out = join(dir, 'out.xml');
  try {
    copyFileSync(path, input);
    const java = javaPath(home), size = statSync(input).size;
    let stuck: StuckInfo | null = null, text = '';
    const code = await new Promise<number | string>((done) => {
      const child = spawn(java, ['-Dlog4j2.loggerContextFactory=org.apache.logging.log4j.simple.SimpleLoggerContextFactory', '-Djava.awt.headless=true', '-cp', classPath(home), 'org.mpxj.sample.MpxjConvert', input, out], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', (d) => { text = (text + d).slice(-4000); });
      child.stderr.on('data', (d) => { text = (text + d).slice(-4000); });
      // no time limit: alive while the XML grows or Java uses the processor; ended past ten times the work its size takes
      const stop = externalWatch({ step: 'reading the .mpp (MPXJ)', floorMs: workerFloorMs(), expectMs: expectedMs(size, 'mpxj'), output: () => (existsSync(out) ? statSync(out).size : 0), cpu: () => treeCpuMs(child.pid ?? 0), onStuck: (i) => { stuck = i; child.kill(); } });
      child.on('error', (e) => { stop(); done((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no-java' : e.message); });
      child.on('close', (c) => { stop(); done(c ?? -1); });
    });
    if (code === 'no-java') throw new MppReaderMissing(`Reading .mpp needs Java, and there is none here (${java}): this installation ships one in mpxj/jre/ for Windows and Linux on x64; elsewhere install a Java runtime (the jars are Java 8 class files), or set P6CLONE_JAVA.`);
    if (stuck) throw mppStuck(stuck);
    if (code !== 0 || !existsSync(out)) {
      const why = /MPXJException: ([^\n\r]*)|Exception: ([^\n\r]*)/.exec(text);
      throw new Error(`MPXJ could not read this .mpp: ${(why?.[1] ?? why?.[2] ?? text.trim().split(/\r?\n/).pop() ?? `exit ${code}`).trim()}.`);
    }
    return readChunked(out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** Whether this installation can read .mpp (MPXJ and a Java). */
export const mppReadable = () => !!mpxjHome();
