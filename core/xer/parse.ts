import { ValuePool, type Db, type PoolColumn, type Row, type Table } from '../db.ts';
import { detectCodepage, encodingLabel, SAMPLE, textDecoder, type TextEncodingName } from '../encoding.ts';
import type { Finding } from '../findings.ts';

export interface ParseMeta { encoding: TextEncodingName; lineEnding: 'CRLF' | 'LF' | 'mixed'; hasEnd: boolean; /** a byte over 0x7F after the byte order mark */ nonAscii?: boolean; /** the file's line of each TASK row, in order (a damaged row is named by its line) */ taskLines?: number[] }

/** Where the bytes come from: a file is read a chunk at a time (never whole), an array is read in place. */
export interface ByteSource { size: number; read(pos: number, len: number): Uint8Array }
export const bytesSource = (b: Uint8Array): ByteSource => ({ size: b.length, read: (pos, len) => b.subarray(pos, Math.min(b.length, pos + len)) });
const CHUNK = 16 * 1048576;
/** The lines of src from start, each with its LF (the last one without, when the file does not end in one). A line
 *  cut by a chunk boundary is joined; the others are views of their chunk, used before the next chunk is read. */
function* lineSpans(src: ByteSource, start: number): Generator<Uint8Array> {
  let carry: Uint8Array | null = null;
  for (let pos = start; pos < src.size;) {
    const c = src.read(pos, CHUNK);
    if (!c.length) break;
    pos += c.length;
    let s = 0;
    for (let i = c.indexOf(10); i >= 0; i = c.indexOf(10, i + 1)) {
      const piece = c.subarray(s, i + 1);
      if (carry) { const j: Uint8Array = new Uint8Array(carry.length + piece.length); j.set(carry); j.set(piece, carry.length); carry = null; yield j; } else yield piece;
      s = i + 1;
    }
    if (s < c.length) { const rest = c.subarray(s); if (carry) { const j: Uint8Array = new Uint8Array(carry.length + rest.length); j.set(carry); j.set(rest, carry.length); carry = j; } else carry = rest.slice(); }
  }
  if (carry) yield carry;
}

export interface ParseResult { db: Db; findings: Finding[]; meta: ParseMeta }

// Memory: a parsed file takes a few times its size. The file is read line by line from its bytes (never one string
// of the whole file, which a 512 MB file would not fit in); the rows of a table block are copies of one template
// object, so they share one hidden class with in-object fields (built field by field, a 60-field row falls back to a
// dictionary of 6x the size); values repeated in a column (dates, flags, codes, ids) share one string; and no value
// is a slice of its line, which would keep the line alive.
const SLICED = 13; // V8 makes substrings this long slices of their parent; shorter ones are copies
/** A copy of s that does not keep the string it was cut from alive. */
const flat = (s: string): string => JSON.parse(JSON.stringify(s));
const unsliced = (s: string): string => (s.length >= SLICED ? flat(s) : s);

/** Parse XER bytes. Never throws; structural problems become findings. */
export function parseXer(bytes: Uint8Array, opts: { encoding?: TextEncodingName | 'auto' } = {}): ParseResult { return parseXerSource(bytesSource(bytes), opts); }

/** parseXer from any source of bytes (parseFile.ts: a file, a chunk at a time). */
export function parseXerSource(src: ByteSource, opts: { encoding?: TextEncodingName | 'auto' } = {}): ParseResult {
  // first pass, line by line: the encoding (as detectEncoding does it on the whole bytes), the line endings, any
  // non-ASCII byte; the second pass reads the rows
  const h = new Uint8Array(Math.min(6, src.size));
  for (let at = 0; at < h.length;) { const c = src.read(at, h.length - at); if (!c.length) break; h.set(c, at); at += c.length; }
  const bom = h[0] === 0xef && h[1] === 0xbb && h[2] === 0xbf;
  const force = opts.encoding && opts.encoding !== 'auto' ? opts.encoding : null;
  let crlf = 0, lf = 0, hi = false, utf8 = true;
  const fatal = new TextDecoder('utf-8', { fatal: true }), sample: Uint8Array[] = [];
  let sampled = 0;
  const from = bom ? 3 : 0;
  // a second byte order mark after the first (read by a UTF-8 decoder) is skipped, not counted as non-ASCII text
  const utf8First = force ? force === 'utf-8' || force === 'utf-8-bom' : bom;
  let skip = utf8First && h[from] === 0xef && h[from + 1] === 0xbb && h[from + 2] === 0xbf ? 3 : 0;
  for (const l of lineSpans(src, from)) {
    const n = l.length;
    if (l[n - 1] === 10) { if (n > 1 && l[n - 2] === 13) crlf++; else lf++; }
    let high = false;
    for (let i = skip; i < n; i++) if (l[i] >= 0x80) { high = true; break; }
    skip = 0;
    if (!high) continue;
    hi = true;
    if (force || bom) continue;
    if (utf8) { try { fatal.decode(l, { stream: true }); } catch { utf8 = false; } }
    if (sampled < SAMPLE) { sample.push(l.slice()); sampled += n; }
  }
  if (utf8 && hi && !force && !bom) { try { fatal.decode(); } catch { utf8 = false; } }
  const of = (encoding: TextEncodingName, start = 0) => ({ encoding, start, decoder: encoding === 'utf-8-bom' ? 'utf-8' : encoding });
  const detected = force ? of(force, bom ? 3 : 0) : bom ? of('utf-8-bom', 3) : !hi || utf8 ? of('utf-8') : of(detectCodepage((() => { const b = new Uint8Array(sampled); let at = 0; for (const p of sample) { b.set(p, at); at += p.length; } return b; })()));
  sample.length = 0;
  const { encoding, decoder } = detected;
  let start = detected.start;
  // a UTF-8 decoder drops a byte order mark at the start of the text (one more after the one detection skipped)
  if (decoder === 'utf-8' && h[start] === 0xef && h[start + 1] === 0xbb && h[start + 2] === 0xbf) start += 3;
  const dec = textDecoder(decoder, { ignoreBOM: true });   // windows-1252 read right on Node 20/22 too (encoding.ts)
  const findings: Finding[] = [];
  const db: Db = { tables: {} };
  const lineEnding = crlf && lf > 1 ? 'mixed' : lf > crlf ? 'LF' : 'CRLF';
  const nonAscii = encoding.startsWith('utf-8') && hi;
  const meta: ParseMeta = { encoding, lineEnding, hasEnd: false, nonAscii: hi, taskLines: [] };

  if (nonAscii) findings.push({
    severity: 'info', code: 'ENCODING_UTF8', message: `File is ${encoding}; P6 writes XER in the Windows code page of the exporting computer.`,
    p6: 'P6 reads XER text in the Windows code page for non-Unicode programs; non-ASCII characters may appear garbled. P6 XML is Unicode and keeps every language.',
  });
  else if (encoding !== 'windows-1252' && encoding !== 'utf-8') findings.push({
    severity: 'info', code: 'ENCODING_CODEPAGE', message: `File is ${encodingLabel(encoding)} (read as such; the code page was recognised from the text).`,
    p6: `P6 imports it correctly on a computer whose Windows language for non-Unicode programs uses ${encodingLabel(encoding)}; elsewhere the text appears garbled. P6 XML is Unicode and keeps every language.`,
  });
  if (lineEnding !== 'CRLF') findings.push({
    severity: 'warning', code: 'LF_ENDINGS', message: `Line endings are ${lineEnding}; P6 writes CRLF.`,
    p6: 'P6 import accepts LF-only files.',
  });

  /** Lines from pos on (split at LF, a CR before it dropped), with their 1-based numbers; empty lines skipped. Each
   *  is decoded with its LF, so a broken multi-byte character at the end of a line reads as in the whole text. */
  let lineNo = 0;
  const spans = lineSpans(src, start);
  const nextLine = (): string | null => {
    for (let r = spans.next(); !r.done; r = spans.next()) {
      const l = r.value, ends = l[l.length - 1] === 10;
      lineNo++;
      if (ends && l.length === 1) continue;
      let line = dec.decode(l);
      if (ends) line = line.slice(0, line.endsWith('\r\n') ? -2 : -1);
      if (line) return line;
    }
    return null;
  };

  const pool = new ValuePool(unsliced);
  let cur: Table | null = null;
  let blockFields: string[] = [];
  let template: Row = {};
  let cols: PoolColumn[] = [];
  let sawHeader = false;
  // %E markers with data after them (a file some tool wrote with %E after each table, or after each row): the data is
  // read on as if the markers were not there, so nothing in the file is lost and the file can be repaired (the clone
  // writes one %E, at the end); the marker is reported
  let endAt = 0, strayEnds = 0;
  const after = { lines: 0, tables: new Set<string>(), first: 0 };
  for (let line = nextLine(); line !== null; line = nextLine()) {
    const parts = line.split('\t');
    const tag = parts[0];
    if (endAt && (tag === '%T' || tag === '%F' || tag === '%R')) {
      if (!after.lines) after.first = endAt;
      after.lines++;
      const t = tag === '%T' ? flat((parts[1] ?? '').trim()) : cur?.name;
      if (t) after.tables.add(t);
      if (endAt > 0) { strayEnds++; endAt = -1; } // (-1: this %E counted; data seen after it)
    }
    if (!sawHeader && tag === 'ERMHDR') {
      sawHeader = true;
      db.header = { version: parts[1] ?? '', exportDate: parts[2] ?? '', raw: parts.map(flat), encoding };
      continue;
    }
    if (tag === '%T') {
      const name = flat((parts[1] ?? '').trim());
      blockFields = [];
      if (db.tables[name]) {
        findings.push({ severity: 'warning', code: 'DUP_TABLE', table: name, message: `Table ${name} appears more than once.`, p6: 'P6 processes both blocks.' });
        cur = db.tables[name];
      } else {
        cur = db.tables[name] = { name, fields: [], rows: [] };
      }
    } else if (tag === '%F') {
      if (!cur) continue;
      blockFields = parts.slice(1).map(flat);
      for (const f of blockFields) if (!cur.fields.includes(f)) cur.fields.push(f);
      template = JSON.parse(JSON.stringify(Object.fromEntries(blockFields.map((f) => [f, '']))));
      cols = blockFields.map(() => pool.column());
    } else if (tag === '%R') {
      if (!cur || !blockFields.length) {
        findings.push({ severity: 'error', code: 'ROW_BEFORE_FIELDS', table: cur?.name, message: `Line ${lineNo}: %R before %F.`, p6: 'P6 import fails on malformed table blocks.' });
        continue;
      }
      const nv = parts.length - 1, nf = blockFields.length;
      const rowNo = cur.rows.length + 1;
      if (nv > nf) {
        if (parts.slice(nf + 1).some((v) => v !== '')) findings.push({
          severity: 'error', code: 'FIELD_COUNT', table: cur.name, row: rowNo,
          message: `Line ${lineNo}: ${nv} values for ${nf} fields.`, p6: 'P6 import fails: column count mismatch.',
        });
      } else if (nv < nf) {
        findings.push({
          severity: 'warning', code: 'FIELD_COUNT_SHORT', table: cur.name, row: rowNo,
          message: `Line ${lineNo}: ${nv} values for ${nf} fields; missing values treated as blank.`,
          p6: 'P6 treats missing trailing values as blank.',
        });
      }
      const r: Row = { ...template };
      for (let j = 0; j < nf; j++) {
        const v = parts[j + 1];
        r[blockFields[j]] = v ? pool.get(cols[j], v) : '';
      }
      cur.rows.push(r);
      if (cur.name === 'TASK') meta.taskLines!.push(lineNo);
    } else if (tag === '%E') {
      meta.hasEnd = true;
      endAt = lineNo;
    } else if (line.trim() !== '') {
      findings.push({
        severity: 'error', code: 'BAD_LINE', table: cur?.name,
        message: `Line ${lineNo} does not start with %T/%F/%R/%E: "${line.slice(0, 40)}"`,
        p6: 'P6 import fails or drops the record (file looks corrupted).',
      });
    }
  }
  if (after.lines) {
    const ts = [...after.tables];
    findings.push({
      severity: 'error', code: 'DATA_AFTER_END',
      message: `%E end marker at line ${after.first}${strayEnds > 1 ? ` (and ${strayEnds - 1} more)` : ''}, but ${after.lines} more line(s) of data follow (${ts.slice(0, 8).join(', ')}${ts.length > 8 ? ', …' : ''}); they were read as if the marker${strayEnds > 1 ? 's were' : ' was'} not there.`,
      p6: 'An XER has one %E, at its end. A file with %E between its tables or rows was not written by P6, and P6 may stop reading at the first one; saved by the clone it has one %E, at the end.',
    });
  }
  if (!sawHeader) findings.push({ severity: 'fatal', code: 'NO_HEADER', message: 'First line is not an ERMHDR header.', p6: 'P6 rejects the file as not a valid XER file.' });
  if (!meta.hasEnd) findings.push({ severity: 'warning', code: 'NO_END', message: 'Missing %E end marker.', p6: 'P6 imports up to end of file.' });
  return { db, findings, meta };
}
