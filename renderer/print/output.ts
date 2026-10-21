// The laid-out pages (layout.ts) drawn as SVG pages in one HTML document (the app prints / previews / PDFs it through
// Chromium, so every script and font works) or written straight to a PDF file (CLI and MCP; no browser needed).
import { textWidth, type Page, type Prim } from './layout.ts';
import { layoutText, type TtfFont } from './unicode-font.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => Math.round(v * 100) / 100;
const PT = 25.4 / 72;

function svgPrim(p: Prim): string {
  switch (p.t) {
    case 'text': return `<text x="${n(p.x)}" y="${n(p.y)}" font-size="${n(p.pt * PT)}"${p.bold ? ' font-weight="bold"' : ''}${p.align === 'c' ? ' text-anchor="middle"' : p.align === 'r' ? ' text-anchor="end"' : ''}${p.color ? ` fill="${p.color}"` : ''}>${esc(p.s)}</text>`;
    case 'rect': return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" fill="${p.fill ?? 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.lw ?? 0.2}"` : ''}/>`;
    case 'line': return `<line x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}" stroke="${p.color}" stroke-width="${p.lw}"${p.dash ? ' stroke-dasharray="0.8 0.6"' : ''}/>`;
    case 'path': {
      const d = p.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ') + (p.close ? ' Z' : '');
      return `<path d="${d}" fill="${p.fill ?? 'none'}" stroke="${p.color}" stroke-width="${p.lw}"${p.arrow ? ' marker-end="url(#arr)"' : ''}/>`;
    }
  }
}

/** One HTML document with a page-sized SVG per page (no browser margins: the layout has its own). */
export function pagesToHtml(pages: Page[], title: string): string {
  const w = pages[0]?.w ?? 420, h = pages[0]?.h ?? 297;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: ${w}mm ${h}mm; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
svg { display: block; width: ${w}mm; height: ${h}mm; break-after: page; font-family: Arial, Helvetica, sans-serif; }
svg:last-of-type { break-after: auto; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style></head><body>
${pages.map((pg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(pg.w)} ${n(pg.h)}"><defs><marker id="arr" viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#404040"/></marker></defs>${pg.prims.map(svgPrim).join('')}</svg>`).join('\n')}
</body></html>`;
}

// ---------------------------------------------------------------- PDF (Helvetica, WinAnsi text; no fonts embedded)
const rgb = (c: string | undefined): string | null => {
  if (!c || c === 'none') return null;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c);
  return m ? [m[1], m[2], m[3]].map((h) => n(parseInt(h, 16) / 255)).join(' ') : '0 0 0';
};
/** Text as a PDF string in WinAnsi; characters it cannot show become "?" (the app's own PDF uses real fonts). */
/** Characters Helvetica (WinAnsi) can show; anything else needs the embedded Unicode font. */
const winAnsi = (c: number) => (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || [0x2013, 0x2014, 0x2019, 0x2018, 0x201c, 0x201d, 0x2026, 0x20ac].includes(c);
export const needsUnicodeFont = (pages: Page[]) => pages.some((pg) => pg.prims.some((p) => p.t === 'text' && [...p.s].some((ch) => !winAnsi(ch.codePointAt(0)!))));
function pdfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const b = c >= 32 && c <= 126 ? c : c >= 160 && c <= 255 ? c : c === 0x2013 ? 150 : c === 0x2014 ? 151 : c === 0x2019 ? 146 : c === 0x2018 ? 145 : c === 0x201c ? 147 : c === 0x201d ? 148 : c === 0x2026 ? 133 : c === 0x20ac ? 128 : 63;
    out += b === 40 || b === 41 || b === 92 ? '\\' + String.fromCharCode(b) : b > 126 ? '\\' + b.toString(8).padStart(3, '0') : String.fromCharCode(b);
  }
  return out;
}

const latin1 = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
const deflate = async (b: Uint8Array) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>)).arrayBuffer());

export interface PdfOptions {
  /** A TrueType font for text Helvetica cannot show (Arabic, Hebrew, Cyrillic, Greek, CJK ...). Asked for only when
   *  the pages contain such text; without one those characters print as "?". */
  font?: (chars: Set<number>) => TtfFont | null;
}

export async function pagesToPdf(pages: Page[], title = 'Schedule', opts: PdfOptions = {}): Promise<Uint8Array> {
  const parts = await pagesToPdfParts(pages, title, opts);
  const bytes = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0; for (const b of parts) { bytes.set(b, at); at += b.length; }
  return bytes;
}

/** The PDF as its pieces, in order (to write to a file one after another: a long schedule's PDF is never one buffer).
 *  release: each page's drawing is let go once it is compressed (the caller does not use the pages again). */
export async function pagesToPdfParts(pages: Page[], title = 'Schedule', opts: PdfOptions & { release?: boolean } = {}): Promise<Uint8Array[]> {
  const K = 72 / 25.4; // mm -> pt
  const objs: (string | Uint8Array[])[] = [];
  const add = (s: string | Uint8Array[]) => { objs.push(s); return objs.length; };
  const catalog = add(''), pagesId = add(''), f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const needed = new Set<number>();
  for (const pg of pages) for (const p of pg.prims) if (p.t === 'text') for (const ch of p.s) { const c = ch.codePointAt(0)!; if (!winAnsi(c)) needed.add(c); }
  const font = needed.size ? opts.font?.(needed) ?? null : null;
  const f3 = font ? add('') : 0; // Type0 font, filled in once the glyphs used are known
  const used = new Map<number, number>(); // glyph id -> character (for ToUnicode)
  const kids: number[] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    if (opts.release) (pages as (Page | null)[])[pi] = null;
    const H = pg.h;
    const X = (x: number) => n(x * K), Y = (y: number) => n((H - y) * K);
    const ops: string[] = [];
    for (const p of pg.prims) {
      if (p.t === 'text') {
        if (font && [...p.s].some((ch) => !winAnsi(ch.codePointAt(0)!))) {
          // shaped, in visual order, as glyph ids of the embedded font; bold drawn as fill + thin outline
          const t = layoutText(font, p.s);
          t.gids.forEach((g, i) => used.set(g, t.codes[i]));
          const w = (t.width / 1000) * p.pt / K;
          const x = p.align === 'c' ? p.x - w / 2 : p.align === 'r' ? p.x - w : p.x;
          const col = rgb(p.color ?? '#000000');
          ops.push(`BT /F3 ${n(p.pt)} Tf ${col} rg${p.bold ? ` ${col} RG 2 Tr ${n(p.pt * 0.03)} w` : ''} ${X(x)} ${Y(p.y)} Td <${t.gids.map((g) => g.toString(16).padStart(4, '0')).join('')}> Tj${p.bold ? ' 0 Tr' : ''} ET`);
          continue;
        }
        const w = textWidth(p.s, p.pt, p.bold);
        const x = p.align === 'c' ? p.x - w / 2 : p.align === 'r' ? p.x - w : p.x;
        ops.push(`BT /${p.bold ? 'F2' : 'F1'} ${n(p.pt)} Tf ${rgb(p.color ?? '#000000')} rg ${X(x)} ${Y(p.y)} Td (${pdfText(p.s)}) Tj ET`);
      } else if (p.t === 'rect') {
        const f = rgb(p.fill), s = rgb(p.stroke);
        if (!f && !s) continue;
        ops.push(`${f ? `${f} rg ` : ''}${s ? `${s} RG ${n((p.lw ?? 0.2) * K)} w ` : ''}${X(p.x)} ${Y(p.y + p.h)} ${n(p.w * K)} ${n(p.h * K)} re ${f && s ? 'B' : f ? 'f' : 'S'}`);
      } else if (p.t === 'line') {
        ops.push(`${rgb(p.color)} RG ${n(p.lw * K)} w ${p.dash ? `[${n(0.8 * K)} ${n(0.6 * K)}] 0 d ` : ''}${X(p.x1)} ${Y(p.y1)} m ${X(p.x2)} ${Y(p.y2)} l S${p.dash ? ' [] 0 d' : ''}`);
      } else {
        const d = p.pts.map(([x, y], i) => `${X(x)} ${Y(y)} ${i ? 'l' : 'm'}`).join(' ') + (p.close ? ' h' : '');
        const f = rgb(p.fill);
        ops.push(`${rgb(p.color)} RG ${f ? `${f} rg ` : ''}${n(p.lw * K)} w ${d} ${f ? 'B' : 'S'}`);
        if (p.arrow && p.pts.length > 1) { // arrow head at the last point
          const [[ax, ay], [bx, by]] = p.pts.slice(-2);
          const len = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / len, uy = (by - ay) / len, s = 1.1;
          ops.push(`${rgb(p.color)} rg ${X(bx)} ${Y(by)} m ${X(bx - ux * s - uy * s * 0.5)} ${Y(by - uy * s + ux * s * 0.5)} l ${X(bx - ux * s + uy * s * 0.5)} ${Y(by - uy * s - ux * s * 0.5)} l h f`);
        }
      }
    }
    // page drawing compressed (FlateDecode): a 400-page schedule stays a few MB
    const z = await deflate(latin1(ops.join('\n')));
    const content = add([latin1(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, latin1('\nendstream')]);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(pg.w * K)} ${n(pg.h * K)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R${f3 ? ` /F3 ${f3} 0 R` : ''} >> >> /Contents ${content} 0 R >>`));
  }
  if (font && f3) {
    // the font file (whole TrueType, compressed), its descriptor, glyph widths and a ToUnicode map
    const z = await deflate(font.bytes);
    const file = add([latin1(`<< /Length ${z.length} /Length1 ${font.bytes.length} /Filter /FlateDecode >>\nstream\n`), z, latin1('\nendstream')]);
    const sc = (v: number) => Math.round((v * 1000) / font.unitsPerEm);
    const desc = add(`<< /Type /FontDescriptor /FontName /${font.name} /Flags 32 /FontBBox [${font.bbox.map(sc).join(' ')}] /ItalicAngle 0 /Ascent ${sc(font.ascent)} /Descent ${sc(font.descent)} /CapHeight ${sc(font.capHeight)} /StemV 80 /FontFile2 ${file} 0 R >>`);
    const gids = [...used.keys()].sort((a, b) => a - b);
    const w = gids.map((g) => `${g} [${sc(font.widths[g] ?? 0)}]`).join(' ');
    const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /W [${w}] /CIDToGIDMap /Identity >>`);
    const hex = (c: number) => (c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c]).map((u) => u.toString(16).padStart(4, '0')).join('');
    const chunks: string[] = [];
    for (let i = 0; i < gids.length; i += 100) { const part = gids.slice(i, i + 100); chunks.push(`${part.length} beginbfchar\n${part.map((g) => `<${g.toString(16).padStart(4, '0')}> <${hex(used.get(g)!)}>`).join('\n')}\nendbfchar`); }
    const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
    const tu = add(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
    objs[f3 - 1] = `<< /Type /Font /Subtype /Type0 /BaseFont /${font.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`;
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  // the title as UTF-16 (any language), as PDF text strings allow
  const utf16 = 'FEFF' + [...title].map((ch) => { const c = ch.codePointAt(0)!; return (c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c]).map((u) => u.toString(16).padStart(4, '0')).join(''); }).join('');
  const info = add(`<< /Title <${utf16}> /Producer (P6 Clone) >>`);
  const parts: Uint8Array[] = [];
  let size = 0;
  const push = (b: Uint8Array) => { parts.push(b); size += b.length; };
  push(latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(size); push(latin1(`${i + 1} 0 obj\n`)); for (const b of typeof o === 'string' ? [latin1(o)] : o) push(b); push(latin1('\nendobj\n')); });
  const xref = size;
  let out = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(latin1(out));
  return parts;
}
