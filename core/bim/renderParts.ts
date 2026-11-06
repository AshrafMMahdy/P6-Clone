// A 4D render made in parts, so a failure part-way is continued, not lost. A video is made in segments (each a file of its own,
// every one starting on a key frame, written the moment it is done); the images are written one by one. Beside them, in
// <folder>/<name>.parts/, render.json says what the render is (its arguments and a fingerprint of everything that changes
// the pixels), how many frames it has and which are done. A later render_4d with resume: <that file> checks the fingerprint
// and makes only the missing frames. The segments are joined into the one video without encoding again (Mediabunny, in
// Node: the packets are copied into a new file with their timestamps moved), the join is checked, and only then are the
// parts removed.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ALL_FORMATS, EncodedPacketSink, EncodedVideoPacketSource, FilePathSource, FilePathTarget, Input, Mp4OutputFormat, Output, WebMOutputFormat } from 'mediabunny';
import { tileBytesOf } from './tiles.ts';

export const PARTS_MANIFEST = 'render.json';
export interface Segment { file: string; first: number; frames: number; bytes: number }
export interface PartsManifest {
  format: 'p6c-4d-render'; version: 1;
  kind: 'images' | 'video';
  /** the render's arguments, as the call gave them */
  arguments: Record<string, unknown>;
  /** everything that changes what is drawn or how it is cut into frames */
  fingerprint: Record<string, unknown>;
  frames_total: number;
  /** video: the container the segments are in (video/mp4 or video/webm) and the frame rate */
  mime?: string; fps?: number;
  /** video: the segments done (the files are in this folder) */
  segments: Segment[];
  /** images: the frames done, by index, with the file each was written to (its final place) */
  images: { index: number; file: string }[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** What differs between two fingerprints, in words ("step was 7, now 14"). */
export function fingerprintDiff(was: Record<string, unknown>, now: Record<string, unknown>): string[] {
  const one = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? 'not set');
  const out: string[] = [];
  for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) if (!same(was[k], now[k])) out.push(k === 'timeline' || k === 'model' ? `${k} changed (the schedule, its links or the model are not the ones that were drawn)` : `${k} was ${one(was[k])}, now ${one(now[k])}`);
  return out;
}
/** A fingerprint made of a hash of a big value (the timeline: activities, links, sources). The value is walked and fed to the hash
 *  piece by piece (a typed array by its bytes), never made into one string: a big model's timeline is megabytes. */
export function hashOf(v: unknown): string {
  const h = createHash('sha256');
  const walk = (x: unknown): void => {
    if (x === null || x === undefined) { h.update(x === null ? 'n;' : 'u;'); return; }
    if (typeof x === 'string') { h.update(`s${x.length}:`); h.update(x); return; }
    if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'bigint') { h.update(`${typeof x}${String(x)};`); return; }
    if (ArrayBuffer.isView(x)) { h.update(`b${x.byteLength}:`); h.update(new Uint8Array(x.buffer, x.byteOffset, x.byteLength)); return; }
    if (Array.isArray(x)) { h.update(`[${x.length}:`); for (const y of x) walk(y); h.update(']'); return; }
    if (typeof x === 'object') { const k = Object.keys(x as object); h.update(`{${k.length}:`); for (const key of k) { h.update(`${key.length}:${key}=`); walk((x as Record<string, unknown>)[key]); } h.update('}'); return; }
    h.update(`?${typeof x};`);
  };
  walk(v);
  return h.digest('hex').slice(0, 16);
}

/** The parts of one render: the manifest in memory, kept in step with render.json on disk. `put` writes a file the way the
 *  server writes its outputs (inside the write root, atomically). */
export class Parts {
  readonly dir: string; readonly m: PartsManifest; private put: (path: string, data: string | Uint8Array) => void;
  constructor(dir: string, m: PartsManifest, put: (path: string, data: string | Uint8Array) => void) { this.dir = dir; this.m = m; this.put = put; }
  get manifestPath() { return join(this.dir, PARTS_MANIFEST); }
  static create(dir: string, o: Pick<PartsManifest, 'kind' | 'arguments' | 'fingerprint' | 'frames_total'> & { mime?: string; fps?: number }, put: Parts['put']): Parts {
    rmSync(dir, { recursive: true, force: true }); // an earlier render of this name that was not continued
    mkdirSync(dir, { recursive: true });
    const p = new Parts(dir, { format: 'p6c-4d-render', version: 1, ...o, segments: [], images: [] }, put);
    p.save();
    return p;
  }
  /** What load dropped from the manifest and will be made again: the words for the answer. */
  redrawn: string[] = [];
  /** The manifest at `file` (or the folder holding it), checked before it is trusted: its shape, that every segment is a plain
   *  file name of this folder with a sensible frame range that does not overlap another, that every image is a frame of this
   *  render, and (a video) that each kept segment reads back as the frames it says. What fails is dropped (the file removed)
   *  and listed in `redrawn`: those frames are made again. null when there is no usable manifest. */
  static async load(file: string, put: Parts['put']): Promise<Parts | null> {
    let m: PartsManifest, dir: string;
    try {
      const path = existsSync(file) && statSync(file).isDirectory() ? join(file, PARTS_MANIFEST) : file;
      m = JSON.parse(readFileSync(path, 'utf8')); dir = dirname(path);
    } catch { return null; }
    const obj = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);
    const int = (x: unknown, min: number) => Number.isInteger(x) && (x as number) >= min;
    if (!obj(m) || m.format !== 'p6c-4d-render' || (m.kind !== 'video' && m.kind !== 'images') || !obj(m.fingerprint) || !obj(m.arguments) || !int(m.frames_total, 1) || !Array.isArray(m.segments) || !Array.isArray(m.images)) return null;
    if ((m.mime != null && typeof m.mime !== 'string') || (m.fps != null && typeof m.fps !== 'number')) return null;
    const p = new Parts(dir, m, put), total = m.frames_total, taken = new Uint8Array(total);
    const segs = m.segments, imgs = m.images;
    m.segments = []; m.images = [];
    for (const s of segs) {
      const ok = obj(s) && typeof s.file === 'string' && /^seg-\d+\.(mp4|webm)$/.test(s.file) && int(s.first, 0) && int(s.frames, 1) && int(s.bytes, 0) && s.first + s.frames <= total && !taken.subarray(s.first, s.first + s.frames).some((x) => x);
      if (!ok) { if (obj(s)) p.redrawn.push(`a segment entry of the manifest (${JSON.stringify(s).slice(0, 80)}) is not a segment of this render`); continue; }
      const f = join(dir, s.file);
      let why = '';
      try {
        if (statSync(f).size !== s.bytes) why = 'its size is not the size written';
        else { const v = await probeVideo(f); if (v.frames !== s.frames || !v.firstKey) why = `it reads back as ${v.frames} frames, not ${s.frames}`; else if (m.mime && !m.mime.includes(v.codec === 'avc' ? 'mp4' : 'webm')) why = `it is ${v.codec}, not ${m.mime}`; }
      } catch (e) { why = existsSync(f) ? `it cannot be read (${(e as Error).message})` : 'the file is gone'; }
      if (why) { p.redrawn.push(`${s.file} (frames ${s.first + 1} to ${s.first + s.frames}): ${why}`); rmSync(f, { force: true }); continue; }
      taken.fill(1, s.first, s.first + s.frames);
      m.segments.push({ file: s.file, first: s.first, frames: s.frames, bytes: s.bytes });
    }
    for (const i of imgs) {
      if (!obj(i) || !int(i.index, 0) || i.index >= total || typeof i.file !== 'string' || taken[i.index]) continue;
      let png = false;
      try { const fd = openSync(i.file, 'r'); try { const b = Buffer.alloc(8); readSync(fd, b, 0, 8, 0); png = b.subarray(1, 4).toString() === 'PNG'; } finally { closeSync(fd); } } catch { /* gone */ }
      if (!png) { p.redrawn.push(`frame ${i.index + 1} (${basename(i.file)}) is not a PNG any more`); continue; }
      taken[i.index] = 1;
      m.images.push({ index: i.index, file: i.file });
    }
    return p;
  }
  save() { this.put(this.manifestPath, JSON.stringify(this.m, null, 1)); }

  get framesDone() { return this.m.kind === 'video' ? this.m.segments.reduce((n, s) => n + s.frames, 0) : this.m.images.length; }
  /** The runs of frames still to make, in order: [first, count]. */
  missing(): [number, number][] {
    const have = new Uint8Array(this.m.frames_total);
    if (this.m.kind === 'video') for (const s of this.m.segments) have.fill(1, s.first, s.first + s.frames); else for (const i of this.m.images) have[i.index] = 1;
    const out: [number, number][] = [];
    for (let i = 0; i < have.length; i++) if (!have[i]) { let j = i; while (j < have.length && !have[j]) j++; out.push([i, j - i]); i = j; }
    return out;
  }
  addSegment(first: number, bytes: Uint8Array, frames: number, mime: string) {
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const n = this.m.segments.reduce((k, s) => Math.max(k, Number(/^seg-(\d+)/.exec(s.file)?.[1] ?? 0)), 0) + 1;
    const file = `seg-${String(n).padStart(4, '0')}.${ext}`;
    this.put(join(this.dir, file), bytes); // the file first, then the manifest that names it
    this.m.segments.push({ file, first, frames, bytes: bytes.length });
    this.save();
  }
  addImage(index: number, file: string) { this.m.images.push({ index, file }); this.save(); }
  sortedSegments() { return [...this.m.segments].sort((a, b) => a.first - b.first); }
  /** What a failure tells the caller: how far it got, what is kept and how to continue. */
  report() {
    const kept = this.m.kind === 'video' ? { kept_segments: this.sortedSegments().map((s) => join(this.dir, s.file)) } : { kept: [...this.m.images].sort((a, b) => a.index - b.index).map((i) => i.file) };
    return { frames_done: this.framesDone, frames_total: this.m.frames_total, ...kept, ...(this.framesDone ? { resume: this.manifestPath } : {}) };
  }
  discard() { rmSync(this.dir, { recursive: true, force: true }); }
}

/** Frames in a segment: the tile memory budget (P6CLONE_TILE_MB, tiles.ts) divided by the bytes one frame takes. That is
 *  measured from the segments done (done), and for the first segment worked out from the encoder's bitrate and the frame rate. */
export function segmentFrames(done: { bytes: number; frames: number }[], bitrate: number, fps: number, budget = tileBytesOf()): number {
  const frames = done.reduce((n, s) => n + s.frames, 0);
  const perFrame = frames ? done.reduce((n, s) => n + s.bytes, 0) / frames : bitrate / 8 / fps;
  return Math.max(1, Math.floor(budget / Math.max(1, perFrame)));
}

/** What a video file holds, read packet by packet (nothing is decoded). */
export interface VideoFacts { frames: number; duration: number; codec: string; keyFrames: number; firstKey: boolean; ordered: boolean }
export async function probeVideo(file: string): Promise<VideoFacts> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('the file has no video track');
    const sink = new EncodedPacketSink(track);
    let frames = 0, keyFrames = 0, firstKey = false;
    const at: number[] = [];
    for await (const p of sink.packets()) { if (frames === 0) firstKey = p.type === 'key'; if (p.type === 'key') keyFrames++; at.push(p.timestamp); frames++; }
    // (packets come in decode order, which differs from presentation order when the encoder reorders frames: so the times are sorted)
    at.sort((x, y) => x - y);
    const ordered = at.every((t, i) => i === 0 || t > at[i - 1]);
    return { frames, duration: await track.computeDuration(), codec: String(track.codec), keyFrames, firstKey, ordered };
  } finally { input.dispose(); }
}

/** The segments (in order of their first frame) as one video at `out`, without encoding again: each packet is copied, its
 *  timestamp moved to where its frame belongs (first / fps). The decoder configuration is the first segment's: the segments
 *  are encoded by the same encoder with the same settings. */
export async function joinSegments(segments: { file: string; first: number }[], out: string, o: { mime: string; fps: number }): Promise<void> {
  mkdirSync(dirname(out), { recursive: true });
  const webm = !o.mime.includes('mp4');
  let output: Output | null = null, src: EncodedVideoPacketSource | null = null, sequence = 0, started = false;
  try {
    for (const seg of segments) {
      const input = new Input({ source: new FilePathSource(seg.file), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error(`${basename(seg.file)} has no video track`);
        if (!src) {
          output = new Output({ format: webm ? new WebMOutputFormat() : new Mp4OutputFormat(), target: new FilePathTarget(out) });
          src = new EncodedVideoPacketSource(track.codec as 'avc' | 'vp9');
          output.addVideoTrack(src, { frameRate: o.fps });
          await output.start();
        }
        const config = await track.getDecoderConfig();
        const shift = seg.first / o.fps - (await track.getFirstTimestamp());
        for await (const p of new EncodedPacketSink(track).packets()) {
          await src.add(p.clone({ timestamp: p.timestamp + shift, sequenceNumber: sequence++ }), started ? undefined : { decoderConfig: config! });
          started = true;
        }
      } finally { input.dispose(); }
    }
    await output!.finalize();
  } catch (e) { await output?.cancel().catch(() => undefined); rmSync(out, { force: true }); throw e; }
}

/** The joined file is what was asked for or the problem in words: every frame there (frames_total), each at its own time, from a key
 *  frame, as long as the frames at this rate (to within one frame), and a key frame where each segment began. */
export async function verifyVideo(file: string, o: { frames: number; fps: number; segments: number }): Promise<string | null> {
  let f: VideoFacts;
  try { f = await probeVideo(file); } catch (e) { return `it cannot be read back (${(e as Error).message})`; }
  if (f.frames !== o.frames) return `it has ${f.frames} frames, not ${o.frames}`;
  if (!f.ordered) return 'two frames share a time';
  if (!f.firstKey) return 'it does not start on a key frame';
  if (f.keyFrames < o.segments) return `it has ${f.keyFrames} key frames for ${o.segments} segments`;
  if (Math.abs(f.duration - o.frames / o.fps) > 1 / o.fps) return `it lasts ${f.duration.toFixed(2)} s, not ${(o.frames / o.fps).toFixed(2)} s`;
  return null;
}

/** Move a finished file into place (replacing one that is there). */
export const moveInto = (from: string, to: string) => { rmSync(to, { force: true }); renameSync(from, to); };

/** The picture a kept render was drawn with (its fingerprint's quality, size and boxes), read without checking the rest: a resume
 *  adopts it for what the caller left to auto, so auto is never decided again on a resume. null when there is none to read. */
export function keptPicture(file: string): { quality: string; boxes: boolean; width: number; height: number } | null {
  try {
    const path = existsSync(file) && statSync(file).isDirectory() ? join(file, PARTS_MANIFEST) : file;
    const f = (JSON.parse(readFileSync(path, 'utf8')) as PartsManifest).fingerprint;
    return typeof f.quality === 'string' && typeof f.boxes === 'boolean' && Number.isInteger(f.width) && Number.isInteger(f.height) ? { quality: f.quality, boxes: f.boxes, width: f.width as number, height: f.height as number } : null;
  } catch { return null; }
}
