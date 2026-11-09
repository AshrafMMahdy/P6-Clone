// A 4D render made in parts, so a failure part-way is continued, not lost. A video is made in runs: each run is one encoder
// session whose output is streamed to a file of its own (run-N.mp4 / .webm) as the encoder produces it, a whole chunk at a time
// (a fragmented MP4's fragment, a WebM's cluster: each one starts on a key frame the encoder chose); the images are written one by
// one. Beside them, in <folder>/<name>.parts/, render.json says what the render is (its arguments and a fingerprint of everything
// that changes the pixels), how many frames it has and which are done, and, per run, the byte length that is whole and the frames
// those bytes hold. A later render_4d with resume: <that file> checks the fingerprint and makes only the missing frames. The runs
// are joined into the one video without encoding again (Mediabunny, in Node: the packets are copied into a new, normal MP4 or
// WebM with their timestamps moved), the join is checked, and only then are the parts removed.
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ALL_FORMATS, BufferSource, CustomSource, EncodedPacketSink, EncodedVideoPacketSource, FilePathTarget, Input, Mp4OutputFormat, Output, WebMOutputFormat, type InputVideoTrack } from 'mediabunny';

export const PARTS_MANIFEST = 'render.json';
/** A render.json that is there but could not be read now (not "nothing there"): continuing works with the same resume once it can be. */
export class ManifestUnreadable extends Error {
  readonly path: string; readonly cause: Error;
  constructor(path: string, cause: Error) { super(`${path} could not be read now (${cause.message})`); this.path = path; this.cause = cause; }
}
/** The parts of an earlier render of this name could not be replaced now: a file in them (`path`) is locked or in use by another
 *  program. `whole`: it was their render.json, so nothing was removed and the earlier render can still be continued; else the
 *  render.json was removed (that render can no longer be continued) and `path` is a file that stayed. */
export class PartsInUse extends Error {
  readonly path: string; readonly cause: Error; readonly whole: boolean;
  constructor(path: string, cause: Error, whole: boolean) { super(`${path} is locked or in use (${cause.message})`); this.path = path; this.cause = cause; this.whole = whole; }
}
/** A run of frames in a file of this folder: `bytes` is its whole length (the file may be longer: a chunk being written when the
 *  process died), `frames` what those bytes hold, `config` a hash of the decoder configuration of the encoder that drew it. A
 *  segment of an earlier version (seg-N.mp4, a whole file, no config) reads the same way. */
export interface Segment { file: string; first: number; frames: number; bytes: number; config?: string; /** drawn by another encoder than the one in use: listed, not counted, until a run drawn by the encoder in use replaces it, or (that encoder in use again, and no run in use over its frames) it is used again */ stale?: true }
export interface PartsManifest {
  format: 'p6c-4d-render'; version: 1;
  kind: 'images' | 'video';
  /** the render's arguments, as the call gave them */
  arguments: Record<string, unknown>;
  /** everything that changes what is drawn or how it is cut into frames */
  fingerprint: Record<string, unknown>;
  frames_total: number;
  /** video: the container the runs are in (video/mp4 or video/webm) and the frame rate */
  mime?: string; fps?: number;
  /** video: the runs done (the files are in this folder) */
  segments: Segment[];
  /** images: the frames done, by index, with the file each was written to (its final place), RELATIVE to the write root */
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

/** A path as one key: resolved, and on Windows (where C:\x and c:\X are one file) with its case folded. */
export const foldPath = (p: string): string => { const r = resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
/** `file` as a path inside `base` ('/'-separated, relative to it), or null when it resolves outside it. */
function insideBase(base: string, file: string): string | null {
  const r = relative(base, resolve(base, file));
  return r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r) ? r.split(sep).join('/') : null;
}
const runNumber = (file: string) => Number(/^(?:seg|run)-(\d+)/.exec(file)?.[1] ?? 0);

/** One run's file as a source that ends at `bytes`, the length that is whole: anything after it (a half-written chunk) is not read. */
function wholeSource(file: string, bytes: number): CustomSource {
  let fd: number | null = null;
  return new CustomSource({
    getSize: () => bytes,
    read: (start, end) => {
      fd ??= openSync(file, 'r');
      const b = Buffer.alloc(end - start);
      for (let at = 0; at < b.length;) { const n = readSync(fd, b, at, b.length - at, start + at); if (!n) throw new Error('the file ends before the length it should have'); at += n; }
      return b;
    },
    dispose: () => { if (fd != null) { closeSync(fd); fd = null; } },
  });
}
/** A hash of what the decoder is told about the video (the codec string and its description bytes: SPS and PPS for H.264). Two runs
 *  with the same hash can be one video; runs from encoders that differ (a graphics card's, then the processor's; Chromium before and
 *  after an update) differ in it. */
export async function configHash(track: InputVideoTrack): Promise<string> {
  const c = await track.getDecoderConfig();
  const h = createHash('sha256').update(String(c?.codec ?? track.codec)).update('\0');
  const d = c?.description as ArrayBuffer | ArrayBufferView | undefined;
  if (d) h.update(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
  return h.digest('hex').slice(0, 16);
}

/** What a video file holds, read packet by packet (nothing is decoded): up to `bytes` (the file's whole length when not given). */
export interface VideoFacts { frames: number; duration: number; codec: string; keyFrames: number; firstKey: boolean; ordered: boolean; config: string }
export async function probeVideo(file: string, bytes = statSync(file).size): Promise<VideoFacts> {
  const input = new Input({ source: wholeSource(file, bytes), formats: ALL_FORMATS });
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
    return { frames, duration: await track.computeDuration(), codec: String(track.codec), keyFrames, firstKey, ordered, config: await configHash(track) };
  } finally { input.dispose(); }
}
/** The frames in one whole chunk (a fragment, a cluster) and the decoder configuration, read with the run's header before it. */
async function readChunk(header: Uint8Array, chunk: Uint8Array): Promise<{ frames: number; config: string; start: number }> {
  const input = new Input({ source: new BufferSource(Buffer.concat([header, chunk])), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('the chunk has no video track');
    let frames = 0;
    for await (const _ of new EncodedPacketSink(track).packets()) frames++;
    return { frames, config: await configHash(track), start: await track.getFirstTimestamp() };
  } finally { input.dispose(); }
}

/** One encoder run, written to its file as its chunks arrive. The first chunk is the header (the container's start, no frames in it);
 *  each later one is whole (a fragment or cluster): it is appended to the file, then render.json says how many bytes are whole
 *  and how many frames they hold, so a process killed at any moment leaves everything up to the last whole chunk. */
export class Run {
  private header: Buffer | null = null; private entry: Segment | null = null;
  private p: Parts; readonly first: number; readonly file: string; private fps: number;
  constructor(p: Parts, first: number, file: string, fps: number) { this.p = p; this.first = first; this.file = file; this.fps = fps; }
  /** frames in the chunks written whole so far */
  get frames() { return this.entry?.frames ?? 0; }
  /** the decoder configuration of the encoder that drew it (known once the first fragment is whole) */
  get config() { return this.entry?.config; }
  async add(chunk: Buffer): Promise<void> {
    const path = join(this.p.dir, this.file);
    if (!this.header) { this.header = chunk; writeFileSync(path, chunk); return; } // (a file left by an earlier run of this name is overwritten here, not before)
    const { frames, config, start } = await readChunk(this.header, chunk); // (the frames are the packets in the chunk: counted, never worked out from times)
    // a chunk continues the run: its first packet is the frame after the last one written. A chunk that does not is refused, so render.json never records a hole
    const at = this.entry?.frames ?? 0, index = Math.round(start * this.fps);
    if (index !== at) throw new Error(`a chunk is missing from the run ${this.file}: the next one starts at frame ${index} of the run, ${at} are written`);
    appendFileSync(path, chunk);
    if (!this.entry) { this.entry = { file: this.file, first: this.first, frames, bytes: this.header.length + chunk.length, config }; this.p.m.segments.push(this.entry); }
    else { this.entry.frames += frames; this.entry.bytes += chunk.length; }
    this.p.save();
  }
}

/** The parts of one render: the manifest in memory, kept in step with render.json on disk. `put` writes a file the way the
 *  server writes its outputs (inside the write root, atomically). `base` is the write root (else the output folder): the images'
 *  paths in the manifest are relative to it, so a folder copied elsewhere is still the same render. */
export class Parts {
  readonly dir: string; readonly m: PartsManifest; readonly base: string; private put: (path: string, data: string | Uint8Array) => void;
  constructor(dir: string, m: PartsManifest, put: (path: string, data: string | Uint8Array) => void, base: string) { this.dir = dir; this.m = m; this.put = put; this.base = base; }
  get manifestPath() { return join(this.dir, PARTS_MANIFEST); }
  static create(dir: string, o: Pick<PartsManifest, 'kind' | 'arguments' | 'fingerprint' | 'frames_total'> & { mime?: string; fps?: number }, put: Parts['put'], base: string): Parts {
    // an earlier render of this name that was not continued goes, its render.json first: while that stays the earlier render can still be
    // continued, so a file another program holds there (a lock) leaves it whole, whatever order the folder's files are removed in
    const manifest = join(dir, PARTS_MANIFEST);
    try { rmSync(manifest, { recursive: true, force: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw new PartsInUse(manifest, e as Error, true); } // (ENOTDIR: dir is a file, removed below)
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { throw new PartsInUse((e as NodeJS.ErrnoException).path ?? dir, e as Error, false); }
    mkdirSync(dir, { recursive: true });
    const p = new Parts(dir, { format: 'p6c-4d-render', version: 1, ...o, segments: [], images: [] }, put, base);
    p.save();
    return p;
  }
  /** What load found wrong and will be made again, in words for the answer (and, after a stale run is taken out, why). */
  redrawn: string[] = [];
  /** Stale runs used again (the encoder in use drew them): in words for the answer. */
  reused: string[] = [];
  /** run files longer than their whole length: the bytes of a chunk that was being written; cut off by settle() */
  private cut = new Map<string, number>();
  /** what load found is not yet in render.json: settle() writes it */
  private unsaved = false;
  /** The manifest at `file` (or the folder holding it), checked before it is trusted: its shape, that every run is a plain file name
   *  of this folder with a sensible frame range that does not overlap another, that every image is a frame of this render inside
   *  `base`, and (a video) that each run reads back, up to its whole length, as the frames it says and the decoder configuration it
   *  says. What fails is left out of the manifest in memory and listed in `redrawn`: those frames are made again. Nothing is changed
   *  on disk (no file removed, cut or rewritten: a resume that is then refused leaves everything as it was); settle() does that once
   *  the resume is accepted, and a failing file is overwritten only when its frames are actually drawn again. null when there is no
   *  manifest there (or it is not one); a manifest that is there but cannot be read now (a lock, a scan, a permission) throws
   *  ManifestUnreadable: nothing is lost, the same resume works once it can be read. */
  static async load(file: string, put: Parts['put'], base: string): Promise<Parts | null> {
    let m: PartsManifest, text: string;
    const path = existsSync(file) && statSync(file).isDirectory() ? join(file, PARTS_MANIFEST) : file;
    const dir = dirname(path);
    try { text = readFileSync(path, 'utf8'); }
    catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code === 'ENOENT' || code === 'ENOTDIR') return null; throw new ManifestUnreadable(path, e as Error); }
    try { m = JSON.parse(text); } catch { return null; }
    const obj = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);
    const int = (x: unknown, min: number) => Number.isInteger(x) && (x as number) >= min;
    if (!obj(m) || m.format !== 'p6c-4d-render' || (m.kind !== 'video' && m.kind !== 'images') || !obj(m.fingerprint) || !obj(m.arguments) || !int(m.frames_total, 1) || !Array.isArray(m.segments) || !Array.isArray(m.images)) return null;
    if ((m.mime != null && typeof m.mime !== 'string') || (m.fps != null && typeof m.fps !== 'number')) return null;
    const p = new Parts(dir, m, put, base), total = m.frames_total, taken = new Uint8Array(total);
    const segs = m.segments, imgs = m.images;
    m.segments = []; m.images = [];
    // runs in use first, then the stale ones (drawn by another encoder: they may overlap the runs that replace them, not each other)
    const take = async (list: Segment[], claim: Uint8Array, stale: boolean) => {
      for (const s of list) {
        const ok = obj(s) && typeof s.file === 'string' && /^(seg|run)-\d+\.(mp4|webm)$/.test(s.file) && int(s.first, 0) && int(s.frames, 1) && int(s.bytes, 1) && s.first + s.frames <= total && !claim.subarray(s.first, s.first + s.frames).some((x) => x);
        if (!ok) { if (obj(s)) p.redrawn.push(`a run entry of the manifest (${JSON.stringify(s).slice(0, 80)}) is not a run of this render`); continue; }
        const f = join(dir, s.file);
        let why = '', config = '';
        try {
          const size = statSync(f).size;
          if (size < s.bytes) why = `it is shorter (${size} bytes) than the whole length written (${s.bytes})`;
          else {
            const v = await probeVideo(f, s.bytes);
            if (v.frames !== s.frames || !v.firstKey) why = `it reads back as ${v.frames} frames, not ${s.frames}`;
            else if (m.mime && !m.mime.includes(v.codec === 'avc' ? 'mp4' : 'webm')) why = `it is ${v.codec}, not ${m.mime}`;
            else if (s.config != null && s.config !== v.config) why = 'its decoder configuration is not the one written';
            else { config = v.config; if (size > s.bytes) { p.cut.set(s.file, s.bytes); p.redrawn.push(`${s.file}: ${size - s.bytes} bytes of a chunk that was not whole were cut off (its frames are drawn again)`); } }
          }
        } catch (e) { why = existsSync(f) ? `it cannot be read (${(e as Error).message})` : 'the file is gone'; }
        if (why) { p.redrawn.push(`${s.file} (frames ${s.first + 1} to ${s.first + s.frames}): ${why}`); continue; }
        claim.fill(1, s.first, s.first + s.frames);
        m.segments.push({ file: s.file, first: s.first, frames: s.frames, bytes: s.bytes, config, ...(stale ? { stale: true as const } : {}) });
      }
    };
    const isStale = (s: Segment) => obj(s) && s.stale === true;
    await take(segs.filter((s) => !isStale(s)), taken, false);
    await take(segs.filter(isStale), new Uint8Array(total), true);
    for (const i of imgs) {
      if (!obj(i) || !int(i.index, 0) || i.index >= total || typeof i.file !== 'string' || taken[i.index]) continue;
      const rel = insideBase(base, i.file); // an entry outside the write root is not one of this render's files: not followed, and said
      if (rel == null) { p.redrawn.push(`frame ${i.index + 1}: its file (${i.file}) is outside the write root, so it is not one of this render's files and is drawn again`); continue; }
      let png = false;
      try { const fd = openSync(resolve(base, rel), 'r'); try { const b = Buffer.alloc(8); readSync(fd, b, 0, 8, 0); png = b.subarray(1, 4).toString() === 'PNG'; } finally { closeSync(fd); } } catch { /* gone */ }
      if (!png) { p.redrawn.push(`frame ${i.index + 1} (${basename(rel)}) is not a PNG any more`); continue; }
      taken[i.index] = 1;
      m.images.push({ index: i.index, file: rel });
    }
    p.unsaved = p.redrawn.length > 0;
    return p;
  }
  /** The resume is accepted: run files are cut back to their whole length, and the manifest is written as load read it. */
  settle() {
    // (a file that cannot be cut now stays longer than its whole length: harmless, every read of it stops at `bytes`, and the next settle cuts it)
    for (const [file, bytes] of this.cut) { try { truncateSync(join(this.dir, file), bytes); } catch { /* left longer, see above */ } }
    this.cut.clear();
    if (this.unsaved) this.save();
  }
  save() { this.put(this.manifestPath, JSON.stringify(this.m, null, 1)); this.unsaved = false; }

  /** the runs in use (not stale) */
  private get live() { return this.m.segments.filter((s) => !s.stale); }
  /** whether anything is listed: runs in use or stale, images (kept work, whether or not it counts as frames done) */
  get kept() { return this.m.segments.length > 0 || this.m.images.length > 0; }
  get framesDone() { return this.m.kind === 'video' ? this.live.reduce((n, s) => n + s.frames, 0) : this.m.images.length; }
  /** The runs of frames still to make, in order: [first, count]. withStale: only those no run holds, in use or stale (a stale run of
   *  the encoder in use may come back into use, so those are drawn first: reconcile). */
  missing(withStale = false): [number, number][] {
    const have = new Uint8Array(this.m.frames_total);
    if (this.m.kind === 'video') for (const s of withStale ? this.m.segments : this.live) have.fill(1, s.first, s.first + s.frames); else for (const i of this.m.images) have[i.index] = 1;
    const out: [number, number][] = [];
    for (let i = 0; i < have.length; i++) if (!have[i]) { let j = i; while (j < have.length && !have[j]) j++; out.push([i, j - i]); i = j; }
    return out;
  }
  /** A new run, for the frames from `first`, in a file of its own (numbered after the runs kept). */
  startRun(first: number, mime: string, fps: number): Run {
    const n = this.m.segments.reduce((k, s) => Math.max(k, runNumber(s.file)), 0) + 1;
    return new Run(this, first, `run-${String(n).padStart(4, '0')}.${mime.includes('mp4') ? 'mp4' : 'webm'}`, fps);
  }
  /** The configuration of the newest run (the runs are numbered in the order they were drawn): the encoder last in use. */
  newestConfig(): string { return this.m.segments.reduce<Segment | null>((a, s) => (!a || runNumber(s.file) > runNumber(a.file) ? s : a), null)?.config ?? ''; }
  /** `ref` is the decoder configuration of the encoder in use. Every run that differs from it is marked stale (it cannot be joined to
   *  runs of this encoder): listed in render.json, not counted, its frames missing so they are drawn again, until runs in use cover
   *  them (retire). A stale run that this encoder drew (its configuration is `ref`: the encoder flipped back, A then B then A) is used
   *  again when no run in use holds any of its frames, nor `drawing` (the run being drawn: [first, count]), so no frame is counted
   *  twice; the newest first. In memory: the caller saves. */
  reconcile(ref: string, drawing?: [number, number]) {
    for (const s of this.m.segments) if (s.config !== ref && !s.stale) { s.stale = true; this.unsaved = true; this.redrawn.push(`${s.file} (frames ${s.first + 1} to ${s.first + s.frames}): drawn by another encoder than the one in use (its decoder configuration differs, so it cannot be joined to the others), drawn again`); }
    const taken = new Uint8Array(this.m.frames_total);
    for (const s of this.live) taken.fill(1, s.first, s.first + s.frames);
    if (drawing) taken.fill(1, drawing[0], drawing[0] + drawing[1]);
    for (const s of this.m.segments.filter((x) => x.stale && x.config === ref).sort((a, b) => runNumber(b.file) - runNumber(a.file))) {
      if (taken.subarray(s.first, s.first + s.frames).some((x) => x)) continue;
      delete s.stale; taken.fill(1, s.first, s.first + s.frames); this.unsaved = true;
      this.reused.push(`${s.file} (frames ${s.first + 1} to ${s.first + s.frames}): drawn by the encoder in use, so it is used again`);
    }
  }
  /** The runs in use whose configuration is not `ref`: runs the encoder in use drew that still differ from it (an encoder that is not stable). */
  odd(ref: string): Segment[] { return this.live.filter((s) => s.config !== ref); }
  /** A stale run whose frames runs in use now cover is replaced: it leaves the manifest (its file stays until the parts are removed). */
  retire() {
    const cover = new Uint8Array(this.m.frames_total);
    for (const s of this.live) cover.fill(1, s.first, s.first + s.frames);
    const keep = this.m.segments.filter((s) => !s.stale || !cover.subarray(s.first, s.first + s.frames).every((x) => x));
    if (keep.length !== this.m.segments.length) { this.m.segments = keep; this.save(); }
  }
  /** Images that are not at the place this render writes them: left out (drawn again). */
  dropImages(bad: { index: number }[], why: string) {
    this.redrawn.push(...bad.map((i) => `frame ${i.index + 1} ${why}`));
    this.m.images = this.m.images.filter((i) => !bad.includes(i)); this.unsaved = true;
  }
  /** An image file's path as the manifest keeps it (relative to the write root). */
  relOf(file: string): string { const r = insideBase(this.base, file); if (r == null) throw new Error(`${file} is outside ${this.base}`); return r; }
  addImage(index: number, file: string) { this.m.images.push({ index, file: this.relOf(file) }); this.save(); }
  /** the runs in use, in order of their first frame: what is joined */
  sortedSegments() { return [...this.live].sort((a, b) => a.first - b.first); }
  /** What a failure tells the caller: how far it got, what is kept and how to continue. */
  report() {
    const kept = this.m.kind === 'video' ? { kept_segments: this.sortedSegments().map((s) => join(this.dir, s.file)), ...(this.m.segments.some((s) => s.stale) ? { stale_segments: this.m.segments.filter((s) => s.stale).sort((a, b) => a.first - b.first).map((s) => join(this.dir, s.file)) } : {}) } : { kept: [...this.m.images].sort((a, b) => a.index - b.index).map((i) => resolve(this.base, i.file)) };
    return { frames_done: this.framesDone, frames_total: this.m.frames_total, ...kept, ...(this.kept ? { resume: this.manifestPath } : {}), ...(this.redrawn.length ? { redrawn: this.redrawn } : {}), ...(this.reused.length ? { reused: this.reused } : {}) };
  }
  discard() { rmSync(this.dir, { recursive: true, force: true }); }
}

/** The runs (in order of their first frame) as one video at `out`, without encoding again: each packet is copied, its timestamp
 *  moved to where its frame belongs (first / fps), each run read to its whole length. Every run must have the decoder configuration
 *  of the first (one file carries one): runs from different encoders are refused here, never joined into a video that does not play. */
export async function joinSegments(segments: { file: string; first: number; bytes: number }[], out: string, o: { mime: string; fps: number }): Promise<void> {
  mkdirSync(dirname(out), { recursive: true });
  const webm = !o.mime.includes('mp4');
  let output: Output | null = null, src: EncodedVideoPacketSource | null = null, sequence = 0, started = false, config0 = '';
  try {
    for (const seg of segments) {
      const input = new Input({ source: wholeSource(seg.file, seg.bytes), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error(`${basename(seg.file)} has no video track`);
        const hash = await configHash(track);
        if (!src) {
          config0 = hash;
          output = new Output({ format: webm ? new WebMOutputFormat() : new Mp4OutputFormat(), target: new FilePathTarget(out) });
          src = new EncodedVideoPacketSource(track.codec as 'avc' | 'vp9');
          output.addVideoTrack(src, { frameRate: o.fps });
          await output.start();
        } else if (hash !== config0) throw new Error(`${basename(seg.file)} was drawn by an encoder with another decoder configuration than ${basename(segments[0].file)}`);
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
 *  frame, as long as the frames at this rate (to within one frame), and a key frame where each run began. */
export async function verifyVideo(file: string, o: { frames: number; fps: number; segments: number }): Promise<string | null> {
  let f: VideoFacts;
  try { f = await probeVideo(file); } catch (e) { return `it cannot be read back (${(e as Error).message})`; }
  if (f.frames !== o.frames) return `it has ${f.frames} frames, not ${o.frames}`;
  if (!f.ordered) return 'two frames share a time';
  if (!f.firstKey) return 'it does not start on a key frame';
  if (f.keyFrames < o.segments) return `it has ${f.keyFrames} key frames for ${o.segments} runs`;
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
