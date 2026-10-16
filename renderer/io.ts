// File-format plumbing shared by wizards and the CLI-like Validate tool.
import { parseXer } from '../core/xer/parse.ts';
import { validateXer } from '../core/xer/validate.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseP6Xml, writeP6Xml } from '../core/xml/p6xml.ts';
import type { Db } from '../core/db.ts';
import type { Finding } from '../core/findings.ts';

export type Format = 'xer' | 'xml';

export interface ParsedFile { format: Format; db: Db; findings: Finding[] }

export function detectFormat(name: string, bytes: Uint8Array): Format {
  if (/\.xml$/i.test(name)) return 'xml';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200)).trimStart();
  return head.startsWith('<') ? 'xml' : 'xer';
}

/** Parse and validate the way P6's import would. */
export function parseFile(name: string, bytes: Uint8Array, format = detectFormat(name, bytes)): ParsedFile {
  if (format === 'xml') {
    const r = parseP6Xml(new TextDecoder('utf-8').decode(bytes));
    return { format, db: r.db, findings: validateXer(r.db, r.findings) };
  }
  const r = parseXer(bytes);
  return { format, db: r.db, findings: validateXer(r.db, r.findings) };
}

export function exportFile(db: Db, format: Format, opts: { version: string; projIds: string[] }): Uint8Array {
  if (format === 'xml') return new TextEncoder().encode(writeP6Xml(db, { projIds: opts.projIds }));
  return writeXer(db, { version: opts.version, projIds: opts.projIds });
}

export function findingsText(file: string, f: Finding[]): string {
  const lines = [`Import log for ${file}`, `${new Date().toLocaleString()}`, ''];
  for (const x of f) {
    const where = [x.table, x.row != null ? `row ${x.row}` : '', x.field, x.key ? `key ${x.key}` : ''].filter(Boolean).join(' ');
    lines.push(`[${x.severity.toUpperCase()}] ${x.code}${where ? ` (${where})` : ''}: ${x.message}`, `    P6: ${x.p6}`);
  }
  if (!f.length) lines.push('No problems found.');
  return lines.join('\r\n');
}
