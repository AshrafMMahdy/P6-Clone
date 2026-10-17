// Minimal .xlsx (Office Open XML spreadsheet) writer and reader, no dependencies: ZIP containers with the platform's
// Compression Streams (Chromium and Node 18+), worksheets as inline strings / numbers / dates. Enough for P6-style
// spreadsheet export and import (sheets of rows), and for reading workbooks Excel itself saved (shared strings).

export type Cell = string | number | Date | null | undefined;
export interface Sheet { name: string; rows: Cell[][]; widths?: number[]; boldRows?: number }

// ---------------------------------------------------------------- ZIP
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(t as unknown as TransformStream<Uint8Array, Uint8Array>));
  return new Uint8Array(await out.arrayBuffer());
}

export async function zip(files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), comp = await pipe(f.data, new CompressionStream('deflate-raw')), crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 8, true);
    head.setUint32(14, crc, true); head.setUint32(18, comp.length, true); head.setUint32(22, f.data.length, true); head.setUint16(26, name.length, true);
    parts.push(new Uint8Array(head.buffer), name, comp);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 8, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, comp.length, true); cd.setUint32(24, f.data.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let at = 0; for (const b of all) { out.set(b, at); at += b.length; }
  return out;
}

export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not an .xlsx file (no ZIP directory found).');
  const n = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged .xlsx file.');
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) out.set(name, await pipe(data, new DecompressionStream('deflate-raw')));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// ---------------------------------------------------------------- workbook
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i: number) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
/** Excel serial date (days since 1899-12-30) for a UTC Date. */
const serial = (d: Date) => d.getTime() / 86400000 + 25569;

export async function writeXlsx(sheets: Sheet[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const files: { name: string; data: Uint8Array }[] = [];
  const add = (name: string, s: string) => files.push({ name, data: enc.encode(s) });
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  // styles: 0 normal, 1 bold header (shaded), 2 date and time
  add('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd-mmm-yy hh:mm"/></numFmts><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDE4EE"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`);
  sheets.forEach((s, i) => {
    const bold = s.boldRows ?? 0;
    const rowsXml = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v == null || v === '') return '';
      const ref = `${colName(ci)}${ri + 1}`, st = ri < bold ? ' s="1"' : '';
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
      if (v instanceof Date) return `<c r="${ref}" s="2"><v>${serial(v)}</v></c>`;
      return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
    }).join('')}</row>`).join('');
    const cols = s.widths?.length ? `<cols>${s.widths.map((w, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const freeze = bold ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${bold}" topLeftCell="A${bold + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
    add(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${rowsXml}</sheetData></worksheet>`);
  });
  return zip(files);
}

const unxml = (s: string) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&' : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const texts = (s: string) => [...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

/** Sheets as rows of cell values: text, numbers, or Date for cells formatted as dates. */
export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const files = await unzip(bytes);
  const dec = new TextDecoder();
  const get = (n: string) => { const f = files.get(n) ?? files.get(n.replace(/^\//, '')); return f ? dec.decode(f) : ''; };
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('Not an Excel workbook (xl/workbook.xml missing).');
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1] ?? '', /Target="([^"]+)"/.exec(m[0])?.[1] ?? '']));
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  // which cell styles are dates (built-in date formats 14-22, 45-47, or custom formats with d/m/y/h)
  const styles = get('xl/styles.xml');
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), unxml(m[2])]));
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const dateStyle = [...xfs.matchAll(/<xf\b[^>]*?(?:\/>|>)/g)].map((m) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[0])?.[1] ?? 0);
    return (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (custom.has(id) && /[dmyh]/i.test(custom.get(id)!.replace(/\[[^\]]*\]|"[^"]*"/g, '')));
  });
  const out: Sheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(/name="([^"]*)"/.exec(m[0])?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? '';
    const target = rels.get(rid) ?? '';
    const ws = get(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    const rows: Cell[][] = [];
    for (const r of ws.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const ri = Number(/r="(\d+)"/.exec(r[1] ?? r[3] ?? '')?.[1] ?? rows.length + 1) - 1;
      const row: Cell[] = [];
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] ?? '';
        const ci = colIndex(/r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? colName(row.length));
        const t = /t="(\w+)"/.exec(attrs)?.[1], s = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? 0);
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let val: Cell = null;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = texts(body);
        else if (t === 'str' || t === 'e') val = v != null ? unxml(v) : '';
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null) { const n = Number(v); val = dateStyle[s] ? new Date(Math.round((n - 25569) * 86400000)) : n; }
        row[ci] = val;
      }
      rows[ri] = row;
    }
    out.push({ name, rows: Array.from(rows, (r) => r ?? []) });
  }
  return out;
}
