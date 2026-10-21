// The 4D packages that carry the model (navisworks and synchro: the IFC tagged; ifc4d: the IFC with the schedule
// inside), streamed from the model file to the package file: a model of any size (a 1.7 GB IFC is more than one string
// can hold) goes through a few MB at a time. Node only; the desktop's renderer uses the text versions (exchange4d.ts).
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Db } from '../db.ts';
import { ifc4dLines, linksCsvLines, tagLines, type Item4d, type StepAppend } from './exchange4d.ts';
import type { IfcIndex } from './parse.ts';

const BLOCK = 16 << 20;
/** Where the DATA section ends (the last ENDSEC;), and what appending needs, read from the file in blocks. */
export function stepAppendOf(path: string): StepAppend & { end: number } {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    // the tail: the last ENDSEC; followed by END-ISO-10303-21;
    const tailLen = Math.min(size, 1 << 16), tb = Buffer.alloc(tailLen);
    readSync(fd, tb, 0, tailLen, size - tailLen);
    const tail = tb.toString('latin1'), at = tail.lastIndexOf('ENDSEC;');
    if (at < 0 || !/END-ISO-10303-21;/.test(tail.slice(at))) throw new Error('Not an IFC (STEP) file: no DATA section tail.');
    const end = size - tailLen + at;
    // one pass: the largest express id at a line start, the first owner history and project, the line ending, the schema
    let max = 0, owner = '$', project: string | null = null, crlf = false, schema = 'IFC?';
    const buf = Buffer.alloc(BLOCK + 256);
    let lineStart = true, pending = '';
    for (let pos = 0; pos < end;) {
      const n = readSync(fd, buf, 0, Math.min(BLOCK, end - pos), pos);
      if (n <= 0) break;
      if (pos === 0) { const head = buf.toString('latin1', 0, Math.min(n, 1 << 16)); schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(head)?.[1] ?? schema; crlf = head.includes('\r\n'); }
      for (let i = 0; i < n; i++) {
        const c = buf[i];
        if (c === 10) { lineStart = true; continue; }
        if (!lineStart) continue;
        lineStart = false;
        if (c !== 35) continue; // '#'
        // #<digits> = <TYPE>( at a line start (a statement split over two blocks: its first bytes are kept)
        let j = i + 1, id = 0;
        while (j < n && buf[j] >= 48 && buf[j] <= 57) id = id * 10 + (buf[j++] - 48);
        if (j >= n) { pending = buf.toString('latin1', i, n); break; }
        if (id > max) max = id;
        if (owner === '$' || project === null) { const s = buf.toString('latin1', j, Math.min(n, j + 40)); if (owner === '$' && /^\s*=\s*IFCOWNERHISTORY\(/.test(s)) owner = `#${id}`; if (project === null && /^\s*=\s*IFCPROJECT\(/.test(s)) project = `#${id}`; }
      }
      pos += n;
      if (pending) {
        // re-read the cut statement's start from the file
        const b = Buffer.alloc(64); const k = readSync(fd, b, 0, 64, pos - pending.length);
        const m = /^#(\d+)\s*=\s*([A-Z0-9_]*)/.exec(b.toString('latin1', 0, k));
        if (m) { const id = Number(m[1]); if (id > max) max = id; if (owner === '$' && m[2] === 'IFCOWNERHISTORY') owner = `#${id}`; if (project === null && m[2] === 'IFCPROJECT') project = `#${id}`; }
        pending = '';
      }
    }
    return { end, nextId: () => ++max, owner, project, nl: crlf ? '\r\n' : '\n', schema };
  } finally { closeSync(fd); }
}

/** src up to `end`, the lines `write` puts, then the rest of src: into dst (written beside, renamed into place). */
function appendStreamed(src: string, dst: string, t: StepAppend & { end: number }, write: (put: (line: string) => void) => void): void {
  // beside, under the name the MCP server's own atomic writes use (a host mirroring the folder skips it)
  const tmp = join(dirname(dst), `.${basename(dst)}.${randomBytes(4).toString('hex')}.p6clone-tmp`);
  const ifd = openSync(src, 'r'), ofd = openSync(tmp, 'w');
  try {
    const buf = Buffer.alloc(BLOCK), size = statSync(src).size;
    const copy = (from: number, to: number) => { for (let pos = from; pos < to;) { const n = readSync(ifd, buf, 0, Math.min(BLOCK, to - pos), pos); if (n <= 0) break; writeSync(ofd, buf, 0, n); pos += n; } };
    copy(0, t.end);
    let out = '';
    write((line) => { out += line + t.nl; if (out.length > 1 << 22) { writeSync(ofd, out, null, 'latin1'); out = ''; } });
    if (out) writeSync(ofd, out, null, 'latin1');
    copy(t.end, size);
  } catch (e) { closeSync(ofd); closeSync(ifd); rmSync(tmp, { force: true }); throw e; }
  closeSync(ofd); closeSync(ifd);
  renameSync(tmp, dst);
}

/** tagIfc on files: the model with a WHIQ_4D property set on every linked element. */
export function tagIfcFile(src: string, dst: string, items: Item4d[]): { tasks: number; elements: number } {
  const t = stepAppendOf(src);
  let r = { tasks: 0, elements: 0 };
  appendStreamed(src, dst, t, (put) => { r = tagLines(t, items, put); });
  return r;
}

/** ifc4dText on files: the model with the schedule inside (IFC4 only). */
export function ifc4dFile(db: Db, projId: string, src: string, dst: string, items: Item4d[], baselines: string[] = []): { tasks: number; links: number } {
  const t = stepAppendOf(src);
  if (!/^IFC4/i.test(t.schema)) throw new Error(`The model is ${t.schema}: IFC4 4D needs an IFC4 model. Use the navisworks or synchro package, or convert the model to IFC4.`);
  let r = { tasks: 0, links: 0 };
  appendStreamed(src, dst, t, (put) => { r = ifc4dLines(db, projId, t, items, baselines, put); });
  return r;
}

/** The link table (linksCsv) written as it is made: UTF-8, CRLF, beside and renamed into place. */
export function linksCsvFile(db: Db, projId: string, ix: IfcIndex | null, dst: string): void {
  const tmp = join(dirname(dst), `.${basename(dst)}.${randomBytes(4).toString('hex')}.p6clone-tmp`);
  const fd = openSync(tmp, 'w');
  try { let buf = ''; linksCsvLines(db, projId, ix, (l) => { buf += l + '\r\n'; if (buf.length > 1 << 22) { writeSync(fd, buf); buf = ''; } }); if (buf) writeSync(fd, buf); }
  catch (e) { closeSync(fd); rmSync(tmp, { force: true }); throw e; }
  closeSync(fd);
  renameSync(tmp, dst);
}
