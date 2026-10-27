// Revit files (.rvt, .rfa) for 4D: turned into IFC4 by rvt-rs (rvtWorker.mjs, its own process) when opened, cached by
// the file's content hash beside the IFC cache, then read like any IFC. What rvt-rs read, approximated or left out goes
// with it (<hash>-rvt.json), so the answer that opens the model can say so.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileHash } from './model.ts';
import { rvtWorkerPath } from './runtime.ts';

const RVT_FORMAT = 1; // the conversion: a new rvt-rs build or a change here bumps it, so old conversions are not reused (p6clone.patch writes the same IFC: not bumped)
/** The memory rvt-rs's process takes to read a Revit file of `bytes` (measured with p6clone.patch, Node 24.14.0: 183,
 *  214 and 281 MB for 7, 12 and 19 MB projects: the file, its element partition unpacked, about 5x, and the program). */
export const revitNeed = (bytes: number) => Math.round(128 * 1048576 + bytes * 9);
/** The largest Revit file rvt-rs can read: its WebAssembly memory stops at 4 GB, and reading takes about 8x the file
 *  (P6CLONE_REVIT_MAX_MB, 450). */
export const revitMaxBytes = () => (Number(process.env.P6CLONE_REVIT_MAX_MB) || 450) * 1048576;
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
  /** set by loadModel: elements drawn from the file vs placed as a bounding box only */
  geometry?: { from_the_file: number; bounding_box_only: number; note: string };
}

/** The IFC4 for a Revit file (made once per file content) and what rvt-rs said about it. */
export async function rvtToIfc(path: string): Promise<{ ifc: string; source: RevitSource }> {
  const dir = process.env.P6CLONE_MODEL_CACHE || join(tmpdir(), 'p6clone-ifc-cache');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${await fileHash(path)}-rvt${RVT_FORMAT}`);
  if (!existsSync(`${base}.ifc`) || !existsSync(`${base}.json`)) {
    const size = statSync(path).size;
    if (size > revitMaxBytes()) throw new Error(`This Revit file (${Math.round(size / 1048576)} MB) is past what the Revit reader can open (about ${Math.round(revitMaxBytes() / 1048576)} MB: its WebAssembly memory stops at 4 GB). Export it from Revit as NWC (Navisworks) or IFC: both open at any size, with the same GlobalIds, so links carry over.`);
    const worker = rvtWorkerPath();
    if (!worker) throw new Error('The Revit reader (rvtWorker.mjs with rvt/ beside it) is missing from this installation.');
    const err = await new Promise<string | null>((done) => {
      const child = spawn(process.execPath, [worker, path, `${base}.ifc`, `${base}.json`], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
      let text = '';
      child.stderr.on('data', (c) => { text += c; });
      const timer = setTimeout(() => child.kill(), 30 * 60_000);
      child.on('error', (e) => { clearTimeout(timer); done(e.message); });
      child.on('close', (code, signal) => { clearTimeout(timer); done(code === 0 ? null : (text.trim().split('\n').pop() || `the Revit reader stopped (${signal ?? code})`)); });
    });
    if (err) { rmSync(`${base}.ifc`, { force: true }); throw new Error(`${path}: ${err}`); }
  }
  const j = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
  const d = j.diagnostics ?? {}, md = j.metadata ?? {};
  return {
    ifc: `${base}.ifc`,
    source: {
      format: 'Revit', revit_version: md.revit_version ?? d.input?.revit_version ?? null, build: md.build ?? d.input?.build ?? null, title: md.title ?? d.input?.project_name ?? null,
      read_as: j.mode, confidence: d.confidence ?? null, exported: d.exported ? { building_elements: d.exported.building_elements, with_geometry: d.exported.building_elements_with_geometry, by_ifc_type: d.exported.by_ifc_type, storeys: d.exported.storey_count } : null,
      skipped: d.skipped ?? [], unsupported: d.unsupported_features ?? [], warnings: (d.warnings ?? []).map(String),
    },
  };
}
