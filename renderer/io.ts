// File-format plumbing shared by wizards and the CLI-like Validate tool.
import { parseXer } from '../core/xer/parse.ts';
import { validateXer } from '../core/xer/validate.ts';
import { writeXer } from '../core/xer/write.ts';
import { parseP6Xml, writeP6Xml } from '../core/xml/p6xml.ts';
import { parseMspdi, writeMspdi } from '../core/msp/mspdi.ts';
import { parseMpx, writeMpx } from '../core/msp/mpx.ts';
import { decodeText, encodeCp1252 } from '../core/encoding.ts';
import type { Db } from '../core/db.ts';
import type { Finding } from '../core/findings.ts';

/** xml = P6 XML (APIBusinessObjects); mspdi = Microsoft Project XML; mpp goes through Microsoft Project. */
export type Format = 'xer' | 'xml' | 'mspdi' | 'mpx' | 'mpp';

export const MSP_FORMATS: Format[] = ['mspdi', 'mpx', 'mpp'];
export const isMspFormat = (f: Format) => MSP_FORMATS.includes(f);

export const FORMAT_INFO: Record<Format, { label: string; ext: string; filter: { name: string; extensions: string[] } }> = {
  xer: { label: 'Primavera PM - (XER)', ext: 'xer', filter: { name: 'Primavera PM (XER)', extensions: ['xer'] } },
  xml: { label: 'Primavera PM/EPPM - (XML)', ext: 'xml', filter: { name: 'Primavera PM/EPPM XML', extensions: ['xml'] } },
  mspdi: { label: 'Microsoft Project XML (*.xml)', ext: 'xml', filter: { name: 'Microsoft Project XML', extensions: ['xml'] } },
  mpx: { label: 'Microsoft Project MPX (*.mpx)', ext: 'mpx', filter: { name: 'Microsoft Project MPX', extensions: ['mpx'] } },
  mpp: { label: 'Microsoft Project (*.mpp) - requires Microsoft Project', ext: 'mpp', filter: { name: 'Microsoft Project (MPP)', extensions: ['mpp'] } },
};

export interface ParsedFile { format: Format; db: Db; findings: Finding[] }

/** Text of an XML file: UTF-16 when it has a UTF-16 byte order mark, else UTF-8. */
function xmlText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

export function detectFormat(name: string, bytes: Uint8Array): Format {
  if (/\.mpp$/i.test(name) || (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)) return 'mpp';
  if (/\.mpx$/i.test(name)) return 'mpx';
  const head = xmlText(bytes.subarray(0, 4000)).replace(/^﻿/, '').trimStart();
  if (/^MPX[^\w\s]/.test(head)) return 'mpx';
  if (/\.xml$/i.test(name) || head.startsWith('<')) {
    if (head.includes('APIBusinessObjects')) return 'xml';
    if (head.includes('schemas.microsoft.com/project') || /<Project[\s>]/.test(head)) return 'mspdi';
    return 'xml';
  }
  return 'xer';
}

/** Parse and validate the way P6's import would. .mpp needs Microsoft Project: use parseFileAsync. */
export function parseFile(name: string, bytes: Uint8Array, format = detectFormat(name, bytes)): ParsedFile {
  if (format === 'xml') {
    const r = parseP6Xml(xmlText(bytes));
    return { format, db: r.db, findings: validateXer(r.db, r.findings) };
  }
  if (format === 'mspdi') {
    const r = parseMspdi(xmlText(bytes));
    return { format, db: r.db, findings: validateXer(r.db, r.findings) };
  }
  if (format === 'mpx') {
    const r = parseMpx(decodeText(bytes).text);
    return { format, db: r.db, findings: validateXer(r.db, r.findings) };
  }
  if (format === 'mpp') {
    return { format, db: { tables: {} }, findings: [{ severity: 'fatal', code: 'MPP_NEEDS_PROJECT', message: '.mpp files are converted by Microsoft Project; open it with File > Import > Microsoft Project.', p6: 'P6 imports .mpp only through an installed Microsoft Project.' }] };
  }
  const r = parseXer(bytes);
  return { format, db: r.db, findings: validateXer(r.db, r.findings) };
}

export interface MppBridge { mppToXml(bytes: Uint8Array): Promise<Uint8Array> }

/** Like parseFile, but .mpp is first converted to Microsoft Project XML by Microsoft Project (rejects with the bridge error). */
export async function parseFileAsync(name: string, bytes: Uint8Array, format = detectFormat(name, bytes), bridge?: MppBridge): Promise<ParsedFile> {
  if (format !== 'mpp') return parseFile(name, bytes, format);
  const b = bridge ?? (globalThis as { p6?: MppBridge }).p6;
  if (!b?.mppToXml) throw new Error('Microsoft Project must be installed to import/export .mpp files (Primavera P6 has the same requirement).');
  const xml = await b.mppToXml(bytes);
  return { ...parseFile(name, xml, 'mspdi'), format: 'mpp' };
}

/** File bytes for an export. For 'mpp' this is the Microsoft Project XML that Microsoft Project converts to .mpp. */
export function exportFile(db: Db, format: Format, opts: { version: string; projIds: string[] }): Uint8Array {
  if (format === 'xml') return new TextEncoder().encode(writeP6Xml(db, { projIds: opts.projIds }));
  if (format === 'mspdi' || format === 'mpp') return new TextEncoder().encode(writeMspdi(db, { projIds: opts.projIds }));
  if (format === 'mpx') return encodeCp1252(writeMpx(db, { projIds: opts.projIds }));
  return writeXer(db, { version: opts.version, projIds: opts.projIds });
}

/** Strip Electron's "Error invoking remote method 'x': Error: " prefix from IPC errors. */
export function bridgeMessage(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
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
