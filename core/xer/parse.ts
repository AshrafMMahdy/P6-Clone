import type { Db, Row, Table } from '../db.ts';
import { decodeText, encodingLabel, type TextEncodingName } from '../encoding.ts';
import type { Finding } from '../findings.ts';

export interface ParseMeta { encoding: TextEncodingName; lineEnding: 'CRLF' | 'LF' | 'mixed'; hasEnd: boolean }
export interface ParseResult { db: Db; findings: Finding[]; meta: ParseMeta }

/** Parse XER bytes. Never throws; structural problems become findings. */
export function parseXer(bytes: Uint8Array, opts: { encoding?: TextEncodingName | 'auto' } = {}): ParseResult {
  const { text, encoding } = decodeText(bytes, opts.encoding);
  const findings: Finding[] = [];
  const db: Db = { tables: {} };
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const lineEnding = crlf && lf > 1 ? 'mixed' : lf > crlf ? 'LF' : 'CRLF';
  const meta: ParseMeta = { encoding, lineEnding, hasEnd: false };

  if (encoding.startsWith('utf-8') && /[^\x00-\x7f]/.test(text)) findings.push({
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

  const lines = text.split(/\r?\n/);
  let cur: Table | null = null;
  let blockFields: string[] = [];
  let sawHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    const parts = line.split('\t');
    const tag = parts[0];
    if (!sawHeader && tag === 'ERMHDR') {
      sawHeader = true;
      db.header = { version: parts[1] ?? '', exportDate: parts[2] ?? '', raw: parts, encoding };
      continue;
    }
    if (tag === '%T') {
      const name = (parts[1] ?? '').trim();
      blockFields = [];
      if (db.tables[name]) {
        findings.push({ severity: 'warning', code: 'DUP_TABLE', table: name, message: `Table ${name} appears more than once.`, p6: 'P6 processes both blocks.' });
        cur = db.tables[name];
      } else {
        cur = db.tables[name] = { name, fields: [], rows: [] };
      }
    } else if (tag === '%F') {
      if (!cur) continue;
      blockFields = parts.slice(1);
      for (const f of blockFields) if (!cur.fields.includes(f)) cur.fields.push(f);
    } else if (tag === '%R') {
      if (!cur || !blockFields.length) {
        findings.push({ severity: 'error', code: 'ROW_BEFORE_FIELDS', table: cur?.name, message: `Line ${i + 1}: %R before %F.`, p6: 'P6 import fails on malformed table blocks.' });
        continue;
      }
      const vals = parts.slice(1);
      const rowNo = cur.rows.length + 1;
      if (vals.length > blockFields.length) {
        if (vals.slice(blockFields.length).some((v) => v !== '')) findings.push({
          severity: 'error', code: 'FIELD_COUNT', table: cur.name, row: rowNo,
          message: `Line ${i + 1}: ${vals.length} values for ${blockFields.length} fields.`, p6: 'P6 import fails: column count mismatch.',
        });
      } else if (vals.length < blockFields.length) {
        findings.push({
          severity: 'warning', code: 'FIELD_COUNT_SHORT', table: cur.name, row: rowNo,
          message: `Line ${i + 1}: ${vals.length} values for ${blockFields.length} fields; missing values treated as blank.`,
          p6: 'P6 treats missing trailing values as blank.',
        });
      }
      const r: Row = {};
      for (let j = 0; j < blockFields.length; j++) r[blockFields[j]] = vals[j] ?? '';
      cur.rows.push(r);
    } else if (tag === '%E') {
      meta.hasEnd = true;
      const ignored = lines.slice(i + 1).filter((l) => l.startsWith('%T	')).map((l) => l.slice(3).trim());
      if (ignored.length) findings.push({
        severity: 'error', code: 'DATA_AFTER_END', message: `%E end marker at line ${i + 1}, but ${ignored.length} more table(s) follow and are ignored: ${ignored.slice(0, 8).join(', ')}${ignored.length > 8 ? ', …' : ''}.`,
        p6: 'P6 stops reading at the first %E; everything after it is not imported.',
      });
      break;
    } else if (line.trim() !== '') {
      findings.push({
        severity: 'error', code: 'BAD_LINE', table: cur?.name,
        message: `Line ${i + 1} does not start with %T/%F/%R/%E: "${line.slice(0, 40)}"`,
        p6: 'P6 import fails or drops the record (file looks corrupted).',
      });
    }
  }
  if (!sawHeader) findings.push({ severity: 'fatal', code: 'NO_HEADER', message: 'First line is not an ERMHDR header.', p6: 'P6 rejects the file as not a valid XER file.' });
  if (!meta.hasEnd) findings.push({ severity: 'warning', code: 'NO_END', message: 'Missing %E end marker.', p6: 'P6 imports up to end of file.' });
  return { db, findings, meta };
}
