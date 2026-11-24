// The 4D packages that carry the model (navisworks and synchro: the IFC tagged; ifc4d: the IFC with the schedule
// inside), streamed from the model file to the package file: a model of any size (a 1.7 GB IFC is more than one string
// can hold) goes through a few MB at a time. Node only; the desktop's renderer uses the text versions (exchange4d.ts).
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Db } from '../db.ts';
import { ifc4dLines, linksCsvLines, tagLines, type Item4d, type StepAppend } from './exchange4d.ts';
import type { IfcIndex, LengthUnit } from './parse.ts';
import { scanEntities } from './stepIndex.ts';

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

/** One statement of the file written again in place (by its id: at, end its bytes) and statements appended (lengthUnitEdit). */
export interface StepEdit { at: number; end: number; text: string; lines: string[] }

const SI_PREFIX: Record<LengthUnit, string | null> = { mm: '.MILLI.', cm: '.CENTI.', m: '$', in: null, ft: null };
const CONVERSION: Record<LengthUnit, [string, number] | null> = { mm: null, cm: null, m: null, in: ['INCH', 0.0254], ft: ['FOOT', 0.3048] };

/** The copy's length unit made the caller's (open_model length_unit: the unit the caller says the file's numbers are in), so the program
 *  the package goes to draws it at that size: the length unit the project assigns is written again as the caller's (by its id: whatever
 *  names it now names the caller's), else the caller's is added to the project's unit assignment, else the project is given one. */
export async function lengthUnitEdit(src: string, unit: LengthUnit, t: StepAppend & { end: number }): Promise<StepEdit> {
  let project: { id: number; args: string } | null = null;
  const assignments = new Map<number, string>(), lengthUnits = new Set<number>();
  await scanEntities(src, (id, type, args) => {
    if (type === 'IFCPROJECT' && !project) project = { id, args };
    else if (type === 'IFCUNITASSIGNMENT') assignments.set(id, args);
    else if ((type === 'IFCSIUNIT' || type === 'IFCCONVERSIONBASEDUNIT') && /^\s*[^,]*,\s*\.LENGTHUNIT\./.test(args)) lengthUnits.add(id);
  });
  const p = project as { id: number; args: string } | null;
  if (!p) throw new Error('The model has no IfcProject, so the length unit it was opened with cannot be stated in the copy.');
  const lines: string[] = [];
  const add = (body: string) => { const id = t.nextId(); lines.push(`#${id}=${body};`); return id; };
  const conv = CONVERSION[unit];
  const unitBody = () => conv
    ? `IFCCONVERSIONBASEDUNIT(#${add('IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0)')},.LENGTHUNIT.,'${conv[0]}',#${add(`IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(${conv[1]}),#${add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')})`)})`
    : `IFCSIUNIT(*,.LENGTHUNIT.,${SI_PREFIX[unit]},.METRE.)`;
  // the project's last attribute is its unit assignment (IfcProject.UnitsInContext); one it does not name is the first in the file, as the
  // reader takes it (stepIndex.ts): then the project is given one of those units, the caller's length unit in place of its own
  const cut = lastTopLevelComma(p.args), named = Number(/^\s*#(\d+)\s*$/.exec(p.args.slice(cut + 1))?.[1]);
  const ua = assignments.has(named) ? named : assignments.keys().next().value;
  const members = ua != null ? [...assignments.get(ua)!.matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : [];
  const length = members.find((id) => lengthUnits.has(id));
  const list = (ids: number[]) => `IFCUNITASSIGNMENT((${ids.map((x) => `#${x}`).join(',')}))`;
  const [id, text] = ua === named && length != null ? [length, unitBody()]
    : ua === named ? [named, list([...members, add(unitBody())])]
      : [p.id, `IFCPROJECT(${p.args.slice(0, cut)},#${add(list([...members.filter((x) => x !== length), add(unitBody())]))})`];
  const at = statementAt(src, id, t.end);
  if (!at) throw new Error(`Statement #${id} (the model's units) was not found where a statement starts, so the length unit it was opened with cannot be stated in the copy.`);
  return { ...at, text: `#${id}=${text};`, lines };
}

/** Where the last top-level comma of an argument list is (strings and nested lists skipped). */
function lastTopLevelComma(args: string): number {
  let depth = 0, str = false, at = -1;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (str) { if (c === "'") str = false; continue; }
    if (c === "'") str = true; else if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 0) at = i;
  }
  return at;
}

/** The bytes of statement #id (from its "#" to after its ";"), found where a statement starts (a line's start, or after a ";"), in the
 *  DATA section (before `end`). */
function statementAt(path: string, id: number, end: number): { at: number; end: number } | null {
  const fd = openSync(path, 'r'), re = new RegExp(`(?:^|[\\n;])[ \\t\\r]*(#${id}[ \\t]*=)`, 'g'), buf = Buffer.alloc(BLOCK + 256);
  try {
    for (let pos = 0; pos < end;) {
      const n = readSync(fd, buf, 0, Math.min(BLOCK + 256, end - pos), pos);
      if (n <= 0) return null;
      const text = buf.toString('latin1', 0, n);
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m) {
        // (#id followed by "=": a reference to it is followed by "," or ")")
        const at = pos + m.index + m[0].length - m[1].length;
        // its end: the first ";" outside a string (read on from the file: a statement may run past the block)
        let str = false;
        for (let q = at, b = Buffer.alloc(65536); q < end;) {
          const k = readSync(fd, b, 0, Math.min(65536, end - q), q);
          if (k <= 0) return null;
          for (let i = 0; i < k; i++) { const c = b[i]; if (str) { if (c === 39) str = false; } else if (c === 39) str = true; else if (c === 59) return { at, end: q + i + 1 }; }
          q += k;
        }
        return null;
      }
      if (n < BLOCK + 256) break;
      pos += BLOCK; // (the 256 bytes over the block are read again: a "#id=" cut by its edge is found whole)
    }
    return null;
  } finally { closeSync(fd); }
}

/** src up to `end`, the lines `write` puts, then the rest of src: into dst (written beside, renamed into place). edit: a statement of src
 *  written again in place, and its lines put first. */
function appendStreamed(src: string, dst: string, t: StepAppend & { end: number }, write: (put: (line: string) => void) => void, edit?: StepEdit): void {
  // beside, under the name the MCP server's own atomic writes use (a host mirroring the folder skips it)
  const tmp = join(dirname(dst), `.${basename(dst)}.${randomBytes(4).toString('hex')}.p6clone-tmp`);
  const ifd = openSync(src, 'r'), ofd = openSync(tmp, 'w');
  try {
    const buf = Buffer.alloc(BLOCK), size = statSync(src).size;
    const copy = (from: number, to: number) => { for (let pos = from; pos < to;) { const n = readSync(ifd, buf, 0, Math.min(BLOCK, to - pos), pos); if (n <= 0) break; writeSync(ofd, buf, 0, n); pos += n; } };
    if (edit) { copy(0, edit.at); writeSync(ofd, edit.text, null, 'latin1'); copy(edit.end, t.end); } else copy(0, t.end);
    let out = '';
    const put = (line: string) => { out += line + t.nl; if (out.length > 1 << 22) { writeSync(ofd, out, null, 'latin1'); out = ''; } };
    for (const l of edit?.lines ?? []) put(l);
    write(put);
    if (out) writeSync(ofd, out, null, 'latin1');
    copy(t.end, size);
  } catch (e) { closeSync(ofd); closeSync(ifd); rmSync(tmp, { force: true }); throw e; }
  closeSync(ofd); closeSync(ifd);
  renameSync(tmp, dst);
}

/** tagIfc on files: the model with a WHIQ_4D property set on every linked element. unit: the length unit the model was opened with by
 *  its caller, stated in the copy (lengthUnitEdit). */
export async function tagIfcFile(src: string, dst: string, items: Item4d[], unit?: LengthUnit): Promise<{ tasks: number; elements: number }> {
  const t = stepAppendOf(src), edit = unit ? await lengthUnitEdit(src, unit, t) : undefined;
  let r = { tasks: 0, elements: 0 };
  appendStreamed(src, dst, t, (put) => { r = tagLines(t, items, put); }, edit);
  return r;
}

/** ifc4dText on files: the model with the schedule inside (IFC4 only). unit: as tagIfcFile's. */
export async function ifc4dFile(db: Db, projId: string, src: string, dst: string, items: Item4d[], baselines: string[] = [], unit?: LengthUnit): Promise<{ tasks: number; links: number }> {
  const t = stepAppendOf(src);
  if (!/^IFC4/i.test(t.schema)) throw new Error(`The model is ${t.schema}: IFC4 4D needs an IFC4 model. Use the navisworks or synchro package, or convert the model to IFC4.`);
  const edit = unit ? await lengthUnitEdit(src, unit, t) : undefined;
  let r = { tasks: 0, links: 0 };
  appendStreamed(src, dst, t, (put) => { r = ifc4dLines(db, projId, t, items, baselines, put); }, edit);
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
