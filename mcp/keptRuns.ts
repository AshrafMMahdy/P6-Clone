// Kept work of the analysis tools made of units (4L-13): monte_carlo's iterations and evaluate_batch's scenarios are kept in a file in
// the write root as each one finishes, so a run that stops (cancelled, failed, its worker or process ended, a redeploy: the file is on
// disk, beside the outputs, where the platform mirrors it) is continued by a later call that passes the path back as resume. That call
// does only what is missing and answers what an uninterrupted run answers. The tool never looks for kept work: the stop answers its
// path, the agent passes exactly that path back, and a call without resume starts over. A run that finishes removes its file.
//
// A file: one line of JSON (what the work is: its format, a fingerprint of everything its result is made from, and what the units look
// like), then the units, each as it finishes, appended. A unit cut short by a kill is not whole and is made again (the file is cut back
// to the last whole one when the run goes on).
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hashOf } from '../core/bim/renderParts.ts';
import type { IterationLayout, IterationStore } from '../core/risk/montecarlo.ts';
import type { KeptScenario, RowStore } from '../core/analysis/batch.ts';
import { pathArg, ToolError } from './runtime.ts';

interface Head { format: string; version: 1; fingerprint: string; [k: string]: unknown }

/** What a call to continue says about a kept file, and the next step, as a ToolError (nothing kept is touched). */
function refused(code: string, message: string, hint: string, resume: string): never {
  throw new ToolError(code, message, hint, { data: { resume } });
}

/** A kept file: its head line, the offset where its units start, and its descriptor. */
class KeptFile {
  fd: number | null = null; start = 0; end = 0;
  readonly tool: string; readonly path: string; readonly format: string;
  /** `path`: the file, or (a resume given as the folder) the .parts folder holding `file`. */
  constructor(tool: string, path: string, format: string, file: string) {
    this.tool = tool; this.format = format;
    let dir = false;
    try { dir = statSync(path).isDirectory(); } catch { /* not there (yet) */ }
    this.path = dir ? join(path, file) : path;
  }
  /** Read the head of the file at `path` given as resume (nothing is changed). ENOENT: nothing to continue; any other error: the file
   *  could not be read now (a lock, a scan): call again with the same resume (never "start over": that would replace it). */
  readHead(asGiven: string): Head {
    let fd: number;
    try { fd = openSync(this.path, 'r+'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') refused('resume_unreadable', `There is nothing to continue at "${asGiven}" (no kept ${this.tool} run there; a run that finished removes its kept file).`, `Call ${this.tool} again without resume to start over.`, asGiven);
      refused('resume_not_readable_now', `The kept ${this.tool} run at "${asGiven}" could not be read now (${(e as Error).message}). Nothing was removed.`, `Call ${this.tool} again with the same resume.`, asGiven);
    }
    this.fd = fd;
    const chunks: Buffer[] = [];
    let at = 0, line: string | null = null;
    for (;;) {
      const b = Buffer.alloc(65536), got = readSync(fd, b, 0, b.length, at);
      if (!got) break;
      const nl = b.subarray(0, got).indexOf(10);
      if (nl >= 0) { chunks.push(b.subarray(0, nl)); line = Buffer.concat(chunks).toString('utf8'); at += nl + 1; break; }
      chunks.push(b.subarray(0, got)); at += got;
    }
    let head: Head | null = null;
    try { head = line == null ? null : JSON.parse(line); } catch { head = null; }
    if (!head || head.format !== this.format || head.version !== 1 || typeof head.fingerprint !== 'string') { this.close(); refused('resume_mismatch', `"${asGiven}" is not kept work of ${this.tool}.`, `Pass the resume path a stopped ${this.tool} answered, or call ${this.tool} without resume to start over.`, asGiven); }
    this.start = at; this.end = statSync(this.path).size;
    return head;
  }
  /** A file for a run starting afresh: an earlier run of this name that was not continued is replaced. Written when its first unit is. */
  create(head: Head): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.fd = openSync(this.path, 'w');
    const line = Buffer.from(`${JSON.stringify(head)}\n`, 'utf8');
    this.put(line, 0);
    this.start = this.end = line.length;
  }
  /** The units from the start, each as its length (u32) and bytes: those whole, in order, and where each ends. */
  *units(): Generator<{ bytes: Uint8Array; end: number }> {
    const len = Buffer.alloc(4);
    for (let at = this.start; at + 4 <= this.end;) {
      if (readSync(this.fd!, len, 0, 4, at) < 4) return;
      const n = len.readUInt32LE(0);
      if (!n || at + 4 + n > this.end) return; // a unit cut short (or nothing written after the length)
      const b = Buffer.alloc(n);
      for (let got = 0; got < n;) { const k = readSync(this.fd!, b, got, n - got, at + 4 + got); if (!k) return; got += k; }
      at += 4 + n;
      yield { bytes: b, end: at };
    }
  }
  /** Go on after the units up to `at` (what follows is cut off). */
  cutAt(at: number): void { ftruncateSync(this.fd!, at); this.end = at; }
  append(bytes: Uint8Array): void {
    const len = Buffer.alloc(4); len.writeUInt32LE(bytes.length, 0);
    this.put(len, this.end); this.put(bytes, this.end + 4);
    this.end += 4 + bytes.length;
  }
  private put(b: Uint8Array, at: number): void { for (let w = 0; w < b.length;) w += writeSync(this.fd!, b, w, b.length - w, at + w); }
  close(): void { if (this.fd != null) { try { closeSync(this.fd); } catch { /* closed */ } this.fd = null; } }
  /** Remove the file, and its .parts folder when that is then empty. A message when the file could not be removed. */
  remove(): string | undefined {
    this.close();
    try { rmSync(this.path, { force: true }); }
    catch (e) { return `The run is finished, but its kept file could not be removed: ${this.path} (${(e as Error).message}). It can be deleted by hand.`; }
    if (/\.parts$/.test(basename(dirname(this.path)))) { try { rmdirSync(dirname(this.path)); } catch { /* not empty: something else is in it */ } }
    return undefined;
  }
}

/** Where a call's kept work is, as a whole: its .parts folder (never the folder above it: a resume given as a file elsewhere is that file). */
export const keptPlace = (file: string): string => (/\.parts$/.test(basename(dirname(file))) ? dirname(file) : file);

/** What every answer with kept work says about continuing (the tool reads exactly this path, never searches for one). */
export const keepWords = (tool: string, resume: string, units: string) => `to continue, call ${tool} again with the same arguments and resume: "${resume}" (only the ${units} still missing are done, and the answer is the one an uninterrupted run gives); a call without resume starts over (it replaces the kept file of that name).`;

/** The units of one call: kept in `resume` (the path a stopped call answered, read exactly as given) or, starting afresh, in the file
 *  named from the fingerprint, `<tool>-<name>.parts/<file>` in the write root (a relative path: the server's own rule). The file of a
 *  fresh run is written when its first unit is. `onKept(path)` is told the file once it holds units (a compute worker sends it out:
 *  the answer of a worker that was ended names it). */
class UnitFile {
  private f: KeptFile | null = null; private fresh = true; private head: Head | null = null;
  /** where each kept unit read ends */
  private ends: number[] = [];
  readonly tool: string; private format: string; private file: string; private resume: unknown; private onKept?: (path: string) => void;
  constructor(tool: string, format: string, file: string, resume: unknown, onKept?: (path: string) => void) { this.tool = tool; this.format = format; this.file = file; this.resume = resume; this.onKept = onKept; }
  get resuming() { return this.resume != null; }
  /** The file this call keeps its units in (null before it is known). */
  get path(): string | null { return this.f?.path ?? null; }
  /** A run afresh: its head (written with its first unit) and its file's name. */
  start(head: { fingerprint: string; [k: string]: unknown }, name: string): void {
    this.head = { format: this.format, version: 1, ...head };
    this.f = new KeptFile(this.tool, pathArg(`${this.tool}-${name}.parts/${this.file}`, 'resume', 'write'), this.format, this.file);
  }
  /** The kept run named by resume: its head, checked by `check` (a message of what differs, or null); refused, changing nothing, when
   *  it is not there, cannot be read now, or is not this run. */
  load(check: (head: Head) => string | null): Head {
    const given = String(this.resume);
    const f = new KeptFile(this.tool, pathArg(this.resume, 'resume', 'write'), this.format, this.file);
    const head = f.readHead(given);
    const changed = check(head);
    if (changed) { f.close(); refused('resume_mismatch', `The kept ${this.tool} run is not this one: ${changed}.`, `Give the arguments the stopped call had (and resume: "${given}"), or call ${this.tool} without resume to start over. Nothing was removed.`, given); }
    this.f = f; this.fresh = false;
    this.onKept?.(f.path);
    return head;
  }
  /** The kept units, in order (whole ones only). */
  units(): Iterable<Uint8Array> {
    if (this.fresh || !this.f) return [];
    const units = this.f.units(), ends = this.ends;
    return { *[Symbol.iterator]() { for (const u of units) { ends.push(u.end); yield u.bytes; } } };
  }
  /** The run goes on after the first `count` units read (one not taken, cut short or damaged, is cut off and made again). */
  resumeAt(count: number): void { if (!this.fresh && this.f) this.f.cutAt(count ? this.ends[count - 1] : this.f.start); }
  add(unit: Uint8Array): void {
    if (!this.f) return;
    if (this.f.fd == null) { this.f.create(this.head!); this.onKept?.(this.f.path); }
    this.f.append(unit);
  }
  /** The run finished: its file goes (a message when it could not be removed). */
  finish(): string | undefined { return this.f && (this.f.fd != null || existsSync(this.f.path)) ? this.f.remove() : undefined; }
  /** The run stopped after `done` units: where they are kept, or null (a file this run made with none goes; one loaded for a resume stays). */
  stop(done: number): string | null {
    if (!this.f) return null;
    if (done > 0) { this.f.close(); return this.f.path; }
    if (this.fresh && this.f.fd != null) this.f.remove(); else this.f.close();
    return null;
  }
}

/** monte_carlo's iterations, kept as they finish (core/risk/montecarlo.ts makes and reads the records). */
export class IterationFile implements IterationStore {
  private u: UnitFile;
  constructor(resume: unknown, onKept?: (path: string) => void) { this.u = new UnitFile('monte_carlo', 'p6clone-monte-carlo', 'iterations.p6mc', resume, onKept); }
  open(inputs: unknown, layout: IterationLayout, asked: number | undefined, freshSeed: number): { seed: number; kept: Iterable<Uint8Array> } {
    const fingerprint = hashOf({ inputs, layout });
    if (!this.u.resuming) { const seed = asked ?? freshSeed; this.u.start({ fingerprint, seed, layout }, `${fingerprint.slice(0, 12)}-s${seed}`); return { seed, kept: [] }; }
    const head = this.u.load((h) => (h.fingerprint !== fingerprint ? 'the schedule, its estimates or risks, or an argument (iterations, sampler, events, risk_events, default_estimates, re_anchor, deadline) is not what the kept run was made from'
      : asked != null && asked !== Number(h.seed) >>> 0 ? `seed was ${Number(h.seed) >>> 0}, now ${asked}` : null));
    return { seed: Number(head.seed) >>> 0, kept: this.u.units() };
  }
  resumeAt(count: number): void { this.u.resumeAt(count); }
  get path(): string | null { return this.u.path; }
  add(record: Uint8Array): void { this.u.add(record); }
  finish(): string | undefined { return this.u.finish(); }
  stop(done: number): string | null { return this.u.stop(done); }
}

/** evaluate_batch's scenarios, kept as they finish: each its row and the activities whose dates it moved (core/analysis/batch.ts). */
export class ScenarioFile implements RowStore {
  private u: UnitFile;
  constructor(resume: unknown, onKept?: (path: string) => void) { this.u = new UnitFile('evaluate_batch', 'p6clone-evaluate-batch', 'scenarios.ndjson', resume, onKept); }
  open(inputs: unknown): Iterable<KeptScenario> {
    const fingerprint = hashOf(inputs);
    if (!this.u.resuming) { this.u.start({ fingerprint }, fingerprint.slice(0, 12)); return []; }
    this.u.load((h) => (h.fingerprint !== fingerprint ? 'the project, the scenarios or an argument (project, top) is not what the kept run was made from' : null));
    const units = this.u.units();
    return { *[Symbol.iterator]() { for (const b of units) { let k: KeptScenario; try { k = JSON.parse(Buffer.from(b).toString('utf8')); } catch { return; } yield k; } } };
  }
  resumeAt(count: number): void { this.u.resumeAt(count); }
  get path(): string | null { return this.u.path; }
  add(kept: KeptScenario): void { this.u.add(Buffer.from(JSON.stringify(kept), 'utf8')); }
  finish(): string | undefined { return this.u.finish(); }
  stop(done: number): string | null { return this.u.stop(done); }
}
