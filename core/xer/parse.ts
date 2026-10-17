import { ValuePool, type Db, type PoolColumn, type Row, type Table } from '../db.ts';
import { detectEncoding, encodingLabel, type TextEncodingName } from '../encoding.ts';
import type { Finding } from '../findings.ts';

export interface ParseMeta { encoding: TextEncodingName; lineEnding: 'CRLF' | 'LF' | 'mixed'; hasEnd: boolean }
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
export function parseXer(bytes: Uint8Array, opts: { encoding?: TextEncodingName | 'auto' } = {}): ParseResult {
  const detected = detectEncoding(bytes, opts.encoding), { encoding, decoder } = detected;
  let start = detected.start;
  // a UTF-8 decoder drops a byte order mark at the start of the text (one more after the one detection skipped)
  if (decoder === 'utf-8' && bytes[start] === 0xef && bytes[start + 1] === 0xbb && bytes[start + 2] === 0xbf) start += 3;
  const dec = new TextDecoder(decoder, { ignoreBOM: true });
  const findings: Finding[] = [];
  const db: Db = { tables: {} };
  let crlf = 0, lf = 0;
  for (let i = bytes.indexOf(10, start); i >= 0; i = bytes.indexOf(10, i + 1)) if (i > start && bytes[i - 1] === 13) crlf++; else lf++;
  const lineEnding = crlf && lf > 1 ? 'mixed' : lf > crlf ? 'LF' : 'CRLF';
  const meta: ParseMeta = { encoding, lineEnding, hasEnd: false };
  let nonAscii = false;
  if (encoding.startsWith('utf-8')) for (let i = start; i < bytes.length; i++) if (bytes[i] >= 0x80) { nonAscii = true; break; }

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
  let pos = start, lineNo = 0;
  const nextLine = (): string | null => {
    while (pos <= bytes.length) {
      const s = pos, lf = bytes.indexOf(10, s);
      pos = lf < 0 ? bytes.length + 1 : lf + 1;
      lineNo++;
      if (lf === s || s === bytes.length) continue;
      let line = dec.decode(bytes.subarray(s, lf < 0 ? bytes.length : lf + 1));
      if (lf >= 0) line = line.slice(0, line.endsWith('\r\n') ? -2 : -1);
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
  for (let line = nextLine(); line !== null; line = nextLine()) {
    const parts = line.split('\t');
    const tag = parts[0];
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
    } else if (tag === '%E') {
      meta.hasEnd = true;
      const at = lineNo, ignored: string[] = [];
      for (let l = nextLine(); l !== null; l = nextLine()) if (l.startsWith('%T\t')) ignored.push(l.slice(3).trim());
      if (ignored.length) findings.push({
        severity: 'error', code: 'DATA_AFTER_END', message: `%E end marker at line ${at}, but ${ignored.length} more table(s) follow and are ignored: ${ignored.slice(0, 8).join(', ')}${ignored.length > 8 ? ', …' : ''}.`,
        p6: 'P6 stops reading at the first %E; everything after it is not imported.',
      });
      break;
    } else if (line.trim() !== '') {
      findings.push({
        severity: 'error', code: 'BAD_LINE', table: cur?.name,
        message: `Line ${lineNo} does not start with %T/%F/%R/%E: "${line.slice(0, 40)}"`,
        p6: 'P6 import fails or drops the record (file looks corrupted).',
      });
    }
  }
  if (!sawHeader) findings.push({ severity: 'fatal', code: 'NO_HEADER', message: 'First line is not an ERMHDR header.', p6: 'P6 rejects the file as not a valid XER file.' });
  if (!meta.hasEnd) findings.push({ severity: 'warning', code: 'NO_END', message: 'Missing %E end marker.', p6: 'P6 imports up to end of file.' });
  return { db, findings, meta };
}
