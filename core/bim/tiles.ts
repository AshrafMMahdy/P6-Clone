// The display model as tiles: a folder per model (manifest.json, tile-NNNNN.glb of at most P6CLONE_TILE_MB each,
// elements.txt), written by the geometry runs (geomTiles.mjs) into the model cache and placed beside a viewer page as
// model-<hash>/ (hard links where the file system allows, copies otherwise). The contract the White Hat IQ platform
// serves it by is docs/4d-tiles-contract.md.
import { copyFileSync, existsSync, linkSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { IfcIndex } from './parse.ts';

export interface TileRecord { file: string; bytes: number; elements: number; vertices: number; triangles: number; instances: number; bbox: number[] }
export interface TilesManifest {
  format: 'p6c-4d-tiles'; version: 1;
  /** elements in the index (ordinals 0..elements-1), and how many have geometry */
  elements: number; meshed: number;
  /** model units to metres (tile positions are in model units; the viewer scales the scene) */
  scale: number;
  /** the whole model's box in metres: min x, y, z, max x, y, z */
  bbox: number[];
  /** bytes of every tile together */
  bytes: number; vertices: number; triangles: number; instances: number;
  tiles: TileRecord[];
  /** GlobalIds by ordinal, one a line (for picking and highlighting in the interactive viewer) */
  guids: 'elements.txt';
}

export const MANIFEST = 'manifest.json';
/** Bytes per display tile: P6CLONE_TILE_MB (32). A browser fetches, parses and uploads one tile at a time. */
export const tileBytesOf = () => Math.max(1, Math.min(512, Number(process.env.P6CLONE_TILE_MB) || 32)) * 1048576;

/** The manifest and the GlobalId list of a tile folder the geometry runs filled. */
export function writeTilesManifest(dir: string, index: IfcIndex, tiles: TileRecord[], scale: number): TilesManifest {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tiles) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], t.bbox[k] * scale); hi[k] = Math.max(hi[k], t.bbox[k + 3] * scale); }
  const sum = (k: 'bytes' | 'vertices' | 'triangles' | 'instances') => tiles.reduce((n, t) => n + t[k], 0);
  const m: TilesManifest = { format: 'p6c-4d-tiles', version: 1, elements: index.elements.length, meshed: index.meshedElements ?? 0, scale, bbox: tiles.length ? [...lo, ...hi] : [0, 0, 0, 0, 0, 0], bytes: sum('bytes'), vertices: sum('vertices'), triangles: sum('triangles'), instances: sum('instances'), tiles, guids: 'elements.txt' };
  // GlobalIds a line, written in blocks (millions of them)
  const fd = openSync(join(dir, 'elements.txt'), 'w');
  try { let buf = ''; for (const e of index.elements) { buf += e.guid + '\n'; if (buf.length > 1 << 20) { writeSync(fd, buf); buf = ''; } } if (buf) writeSync(fd, buf); } finally { closeSync(fd); }
  writeFileSync(join(dir, MANIFEST), JSON.stringify(m));
  return m;
}

export function readManifest(dir: string): TilesManifest | null {
  try { const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as TilesManifest; return m.format === 'p6c-4d-tiles' && Array.isArray(m.tiles) ? m : null; } catch { return null; }
}

/** The tile folder's files, beside a page: <into>/<name>/ (hard links, or copies across file systems). Answers the
 *  files placed. A folder already there with the same manifest is kept. */
export function placeTiles(src: string, into: string, name: string): string[] {
  const dst = join(into, name);
  const files = [MANIFEST, 'elements.txt', ...(readManifest(src)?.tiles ?? []).map((t) => t.file)];
  const same = existsSync(join(dst, MANIFEST)) && readFileSync(join(dst, MANIFEST), 'utf8') === readFileSync(join(src, MANIFEST), 'utf8') && files.every((f) => existsSync(join(dst, f)) && statSync(join(dst, f)).size === statSync(join(src, f)).size);
  if (!same) {
    const tmp = `${dst}.${process.pid}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const f of files) { try { linkSync(join(src, f), join(tmp, f)); } catch { copyFileSync(join(src, f), join(tmp, f)); } }
    if (existsSync(dst)) { const old = `${dst}.old-${Date.now()}`; renameSync(dst, old); rmSync(old, { recursive: true, force: true }); }
    renameSync(tmp, dst);
  }
  return files.map((f) => join(dst, f));
}

/** Every tile's bytes, base64 (a self-contained page; only for a model small enough: P6CLONE_EMBED_MAX_MB, 64). */
export function inlineTiles(src: string): { manifest: TilesManifest; tiles: string[] } {
  const manifest = readManifest(src);
  if (!manifest) throw new Error('The model has no display tiles.');
  return { manifest, tiles: manifest.tiles.map((t) => readFileSync(join(src, t.file)).toString('base64')) };
}
export const embedMaxBytes = () => (Number(process.env.P6CLONE_EMBED_MAX_MB) || 64) * 1048576;

/** Bytes of a tile folder (0 when it is not there). */
export function tilesBytes(dir: string | null): number {
  if (!dir || !existsSync(dir)) return 0;
  let n = 0; for (const f of readdirSync(dir)) try { n += statSync(join(dir, f)).size; } catch { /* gone */ }
  return n;
}
