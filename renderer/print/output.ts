// The laid-out pages (layout.ts) drawn as SVG pages in one HTML document (the app prints / previews / PDFs it through
// Chromium, so every script and font works) or written straight to a PDF file (CLI and MCP; no browser needed).
import { textWidth, type Page, type Prim } from './layout.ts';

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

export async function pagesToPdf(pages: Page[], title = 'Schedule'): Promise<Uint8Array> {
  const K = 72 / 25.4; // mm -> pt
  const objs: (string | Uint8Array[])[] = [];
  const add = (s: string | Uint8Array[]) => { objs.push(s); return objs.length; };
  const catalog = add(''), pagesId = add(''), f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const pg of pages) {
    const H = pg.h;
    const X = (x: number) => n(x * K), Y = (y: number) => n((H - y) * K);
    const ops: string[] = [];
    for (const p of pg.prims) {
      if (p.t === 'text') {
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
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(pg.w * K)} ${n(pg.h * K)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${pdfText(title)}) /Producer (P6 Clone) >>`);
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
  const bytes = new Uint8Array(size);
  let at = 0; for (const b of parts) { bytes.set(b, at); at += b.length; }
  return bytes;
}
