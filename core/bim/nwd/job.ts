// A Navisworks read, as one job: run in its own process (nwdWorker.ts) so the model tree it holds while reading is
// never the server's memory and a model too big for it stops that process, not the server; in this process when the
// worker is not there (the desktop's development build). Two kinds:
//   index  the model index and its display tiles into the model cache (<base>.ndjson, .geom, .tiles)
//   ifc    the IFC4 of the model into a file (the exports that deliver an IFC), written an element at a time
// Either way each model's elements become what is kept of them (an index record, the IFC's lines) as soon as that
// model is read, and the model goes before the next is read.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexBuilder, readNative, type EachElement, type NativePart } from './native.ts';
import { ifcWriter } from './toIfc.ts';
import { absorbRun, meshWith, newRunState } from '../parse.ts';
import { writeIndex } from '../model.ts';
import type { NavisworksSource } from '../nwd.ts';
import { step, tick } from '../heartbeat.mjs';

export interface NwJob {
  kind: 'index' | 'ifc';
  parts: NativePart[];
  /** the model's name and file name (the IFC's project, its made GlobalIds), and the path it was opened from */
  name: string; file: string; path: string;
  /** index: the cache base, and whether to read the geometry */
  base?: string; geometry?: boolean; tileBytes?: number;
  /** ifc: the file to write */
  out?: string;
  maxBytes?: number;
  /** a .nwf that lists no model */
  empty?: boolean;
}
export type Progress = (done: number, total: number, note: string) => void;

/** Run the job; what was read. */
export async function runJob(job: NwJob, progress?: Progress): Promise<NavisworksSource> {
  const dir = mkdtempSync(join(tmpdir(), 'p6clone-nw-'));
  const writer = job.kind === 'ifc' ? ifcWriter(job.out!, { name: job.name, file: job.file }) : null;
  const builder = job.kind === 'index' ? indexBuilder({ name: job.name, path: job.path }) : null;
  try {
    const geometry = job.kind === 'ifc' || job.geometry !== false;
    let ids = 0, guids = 0, boxed = 0;
    const each: EachElement = (e, k, boxes, shape) => {
      tick(); // an element handed on: the reader's progress (heartbeat.mjs)
      if (e.revitId !== null) ids++;
      if (e.guid) guids++;
      if (boxes) boxed++;
      if (writer) writer.add(e, k, boxes, shape?.() ?? null);
      else builder!.add(e, k, boxes);
    };
    const r = readNative(job.parts, { dir: geometry ? dir : undefined, maxBytes: job.maxBytes, progress, each });
    if (!r.files.some((f) => f.read)) throw new Error(r.files.map((f) => `${f.file}: ${f.note}`).join('; ') || 'nothing to read');
    const source: NavisworksSource = {
      format: 'Navisworks', files: r.files, elements: r.elements, with_revit_ids: ids, with_revit_guids: guids,
      geometry: { elements_with_meshes: 0, elements_with_boxes: boxed, note: 'each piece’s own mesh, placed (read from the file: no IFC in between); a piece whose geometry could not be read is its placed box (that element gives no derived volume)' },
      warnings: [...(job.empty ? ['the .nwf lists no model files'] : []), ...r.files.filter((f) => !f.read).map((f) => `${f.file}: ${f.note}`)],
    };
    let meshed = r.geometry?.elements ?? 0;
    if (writer) {
      progress?.(job.parts.length, job.parts.length + 1, 'writing the IFC');
      step('writing the IFC (copying and renumbering, MB)');
      writer.finish();
    } else {
      step('building the model index');
      const index = builder!.finish();
      if (r.geometry) {
        progress?.(job.parts.length, job.parts.length + 1, 'making the display tiles');
        step('making the display tiles (the tiler\u2019s own steps follow)');
        await meshWith(index, { tilesOut: `${job.base}.tiles`, ...(job.tileBytes ? { tileBytes: job.tileBytes } : {}) }, async (_out, tilesDir) => {
          const st = newRunState(), run = await absorbRun(dir, index, tilesDir, {}, st);
          return run.ok ? { ok: true, ...st } : run;
        });
        meshed = index.meshedElements ?? 0;
      } else index.geometryStatus = 'skipped';
      step('writing the model index');
      writeIndex(job.base!, index);
    }
    source.geometry.elements_with_meshes = Math.max(0, meshed - boxed);
    return source;
  } catch (e) { writer?.drop(); throw e; } finally { rmSync(dir, { recursive: true, force: true }); }
}
