// Revit files (.rvt, .rfa) for 4D: turned into IFC4 by rvt-rs (rvtWorker.mjs, its own process) when opened, cached by
// the file's content hash beside the IFC cache, then read like any IFC. What rvt-rs read, approximated or left out goes
// with it (<hash>-rvt.json), so the answer that opens the model can say so.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeCpuMs, watchLiveness } from './liveness.ts';
import { fileHash } from './model.ts';
import { rvtWorkerPath } from './runtime.ts';

const RVT_FORMAT = 2; // the conversion: a new rvt-rs build or a change here bumps it, so old conversions are not reused (2: rvt-rs 0.10.0, base quantities and Revit's own property sets)
/** The memory rvt-rs's reader takes per byte of Revit file: about 8x, the ONE number every limit and message here comes
 *  from. Measured with p6clone.patch, rvt-rs 0.10.0, Node 24.14.0: the whole process peaked at 173, 225 and 264 MB for
 *  7, 12 and 19 MB projects (a slope of 7.6 MB per MB of file over a program of about 120 MB; WebAssembly's own memory
 *  was 147 MB for the 19 MB one). It is the file, its element partition unpacked and what is built from it. Rounded up
 *  to 8; the README, the docs and the error texts say "about 8 times" and point here. */
export const REVIT_MEMORY_PER_BYTE = 8;
/** The memory rvt-rs's process takes to read a Revit file of `bytes` (REVIT_MEMORY_PER_BYTE, and the program: 128 MB). */
export const revitNeed = (bytes: number) => Math.round(128 * 1048576 + bytes * REVIT_MEMORY_PER_BYTE);
/** The largest Revit file rvt-rs can read: its WebAssembly memory stops at 4 GB, so 4096 / REVIT_MEMORY_PER_BYTE = 512 MB,
 *  with a margin down to 450 (P6CLONE_REVIT_MAX_MB). The margin matters: the slope was measured on 7 to 19 MB projects. */
export const revitMaxBytes = () => (Number(process.env.P6CLONE_REVIT_MAX_MB) || 450) * 1048576;
/** A Revit file the reader cannot open: past revitMaxBytes (refused before it is read), or one that ran the reader out
 *  of working memory under that size (ranOut: what it said). */
export class RevitTooLarge extends Error {
  readonly bytes: number; readonly max: number; readonly ranOut?: string;
  constructor(bytes: number, max: number, ranOut?: string) {
    super(ranOut
      ? `This Revit file (${Math.round(bytes / 1048576)} MB) ran the Revit reader out of working memory (${ranOut}); the reader's WebAssembly memory stops at 4 GB. Export it from Revit as NWC (Navisworks) or IFC: both open at any size, with the same GlobalIds, so links carry over.`
      : `This Revit file (${Math.round(bytes / 1048576)} MB) is past what the Revit reader can open (about ${Math.round(max / 1048576)} MB: its WebAssembly memory stops at 4 GB). Export it from Revit as NWC (Navisworks) or IFC: both open at any size, with the same GlobalIds, so links carry over.`);
    this.bytes = bytes; this.max = max; if (ranOut) this.ranOut = ranOut;
  }
}
/** The disk could not take the converted IFC (the cache folder is full or not writable): not a property of the file. */
export class RevitDiskFull extends Error {
  readonly dir: string;
  constructor(dir: string, cause: string) { super(`The Revit reader could not write the converted IFC into ${dir}: ${cause} (the disk is full, or the folder cannot be written).`); this.dir = dir; }
}
/** Throws RevitTooLarge for a Revit file the reader cannot open. */
export function checkRevitSize(path: string): void {
  const size = statSync(path).size;
  if (size > revitMaxBytes()) throw new RevitTooLarge(size, revitMaxBytes());
}
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** A Revit file: an OLE compound file named .rvt / .rfa / .rte / .rft (other OLE files, an old .xls, are not). */
export function isRevit(path: string): boolean {
  if (!/\.(rvt|rfa|rte|rft)$/i.test(path) || !existsSync(path)) return false;
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(8); return readSync(fd, b, 0, 8, 0) === 8 && CFB.every((x, i) => b[i] === x); } finally { closeSync(fd); }
}

export interface RevitSource {
  format: 'Revit'; revit_version: number | null; build: string | null; title: string | null;
  /** rvt-rs's export quality: geometry, typed-no-geometry or scaffold (what it could read from this file) */
  read_as: string;
  confidence: unknown; exported: unknown; skipped: unknown; unsupported: unknown; warnings: string[];
  /** Revit's own property sets added from the parameters the file saves (Revit 2023 and later): elements and types given
   *  them, the properties written, the named parameters left out; error when they could not be read (the model opens
   *  without them) */
  revit_property_sets?: { elements?: number; types?: number; properties?: number; left_out?: number; error?: string } | null;
  /** set by loadModel: elements drawn from the file vs placed as a bounding box only */
  geometry?: { from_the_file: number; bounding_box_only: number; note: string };
}

const cacheDir = () => process.env.P6CLONE_MODEL_CACHE || join(tmpdir(), 'p6clone-ifc-cache');
/** Is the conversion of this file already in the cache (so no size limit applies: it is not read again)? */
export async function rvtCached(path: string): Promise<boolean> {
  const base = join(cacheDir(), `${await fileHash(path)}-rvt${RVT_FORMAT}`);
  return existsSync(`${base}.ifc`) && existsSync(`${base}.json`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === 'EPERM'; } };
/** Half-written conversions of reader processes that are gone (killed, out of memory, power): `<hash>-rvtN.ifc.<pid>.tmp`
 *  and `.json.<pid>.tmp` whose pid is not running any more, removed (a partial IFC can be hundreds of MB). A running
 *  reader's files are left alone. */
export function sweepStaleTemps(dir: string): string[] {
  const gone: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return gone; }
  for (const f of names) {
    const m = /-rvt\d+\.(?:ifc|json)\.(\d+)\.tmp$/.exec(f);
    if (m && !alive(Number(m[1]))) { try { rmSync(join(dir, f), { force: true }); gone.push(f); } catch { /* in use */ } }
  }
  return gone;
}
/** Conversions of this file in an older RVT_FORMAT: removed once the current one is written (they are only caches). */
function dropOldFormats(dir: string, hash: string): void {
  for (let k = 1; k < RVT_FORMAT; k++) for (const ext of ['ifc', 'json']) rmSync(join(dir, `${hash}-rvt${k}.${ext}`), { force: true });
}

/** The IFC4 for a Revit file (made once per file content) and what rvt-rs said about it. */
export async function rvtToIfc(path: string): Promise<{ ifc: string; source: RevitSource }> {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const hash = await fileHash(path), base = join(dir, `${hash}-rvt${RVT_FORMAT}`);
  if (!existsSync(`${base}.ifc`) || !existsSync(`${base}.json`)) {
    checkRevitSize(path);
    const worker = rvtWorkerPath();
    if (!worker) throw new Error('The Revit reader (rvtWorker.mjs with rvt/ beside it) is missing from this installation.');
    sweepStaleTemps(dir);
    const out = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; text: string; pid?: number; stuck?: number }>((done) => {
      const child = spawn(process.execPath, [worker, path, `${base}.ifc`, `${base}.json`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
      let text = '', stuck: number | undefined;
      child.stderr.on('data', (c) => { text += c; });
      // No time limit (owner rule 2026-10-27): the reader is alive while the IFC it writes grows or its process uses the
      // processor (its first phase, unpacking the file, writes nothing but works). Stuck = two windows of 2 minutes
      // (the least a quiet start or a garbage collection can take) with neither. Where the processor cannot be read
      // (off Linux) there is no watch: it is left to finish or to fail by itself.
      const tmpSize = () => { try { return statSync(`${base}.ifc.${child.pid}.tmp`).size; } catch { return 0; } };
      const stop = treeCpuMs(process.pid) === null ? () => {} : watchLiveness({ floorMs: 120_000, progress: tmpSize, pid: () => child.pid, onStuck: (ms) => { stuck = ms; child.kill(); } });
      child.on('error', (e) => { stop(); done({ code: -1, signal: null, text: e.message }); });
      child.on('close', (code, signal) => { stop(); done({ code, signal, text: text.trim(), pid: child.pid, stuck }); });
    });
    if (out.code !== 0) {
      // nothing half-written stays behind (the reader's own temp files carry its pid), and no half result is the conversion
      rmSync(`${base}.ifc`, { force: true });
      for (const ext of ['ifc', 'json']) rmSync(`${base}.${ext}.${out.pid}.tmp`, { force: true });
      const last = out.text.split('\n').pop() ?? '';
      const size = statSync(path).size;
      // the reader said why (rvtWorker.mjs exit codes 4 and 5), or the system ended it: SIGKILL, SIGABRT or a heap
      // message is most often the machine's memory, and either way the file was not read
      if (out.code === 4) throw new RevitDiskFull(dir, last.replace(/^disk_full: /, ''));
      if (out.code === 5) throw new RevitTooLarge(size, revitMaxBytes(), last.replace(/^out_of_memory: /, ''));
      if (!out.stuck && (out.signal === 'SIGKILL' || out.signal === 'SIGABRT' || /heap out of memory|Allocation failed/i.test(out.text))) throw new RevitTooLarge(size, revitMaxBytes(), `the reader's process was ended by the system${out.signal ? ` (${out.signal})` : ''}, most often for lack of memory`);
      if (out.stuck) throw new Error(`${path}: the Revit reader stopped making progress (its IFC did not grow and it used no processor time for ${Math.round(out.stuck / 60_000)} minutes) and was ended.`);
      throw new Error(`${path}: ${last || `the Revit reader stopped (${out.signal ?? out.code})`}`);
    }
    dropOldFormats(dir, hash);
  }
  const j = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
  const d = j.diagnostics ?? {}, md = j.metadata ?? {};
  return {
    ifc: `${base}.ifc`,
    source: {
      format: 'Revit', revit_version: md.revit_version ?? d.input?.revit_version ?? null, build: md.build ?? d.input?.build ?? null, title: md.title ?? d.input?.project_name ?? null,
      read_as: j.mode, confidence: d.confidence ?? null, exported: d.exported ? { building_elements: d.exported.building_elements, with_geometry: d.exported.building_elements_with_geometry, by_ifc_type: d.exported.by_ifc_type, storeys: d.exported.storey_count } : null,
      skipped: d.skipped ?? [], unsupported: d.unsupported_features ?? [], warnings: (d.warnings ?? []).map(String),
      revit_property_sets: j.revit_property_sets ? (j.revit_property_sets.error ? { error: j.revit_property_sets.error } : { elements: j.revit_property_sets.counts.elements, types: j.revit_property_sets.counts.types, properties: j.revit_property_sets.counts.properties, left_out: j.revit_property_sets.counts.left_out }) : null,
    },
  };
}
