// Unicode text in the built-in PDF writer (CLI / MCP printouts): a TrueType font read from a file (glyph map and
// widths), Arabic letters shaped into their joined forms (Arabic Presentation Forms, lam-alef ligatures), and
// right-to-left text put in visual order (Arabic and Hebrew runs reversed, numbers and Latin text kept left to right,
// brackets mirrored). The desktop app's PDFs go through Chromium and do not need this.

export interface TtfFont { name: string; unitsPerEm: number; ascent: number; descent: number; capHeight: number; bbox: [number, number, number, number]; widths: Uint16Array; cmap: Map<number, number>; bytes: Uint8Array }

/** Read a TrueType (.ttf, glyf outlines) font. Throws for fonts it cannot embed (CFF .otf, collections). */
export function parseTtf(bytes: Uint8Array): TtfFont {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag0 = v.getUint32(0);
  if (tag0 === 0x74746366) throw new Error('Font collections (.ttc) are not supported; use a .ttf file.');
  if (tag0 !== 0x00010000 && tag0 !== 0x74727565) throw new Error('Not a TrueType font (CFF .otf fonts are not supported; use a .ttf file).');
  const tables = new Map<string, number>();
  for (let i = 0, n = v.getUint16(4); i < n; i++) {
    const o = 12 + i * 16;
    tables.set(String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]), v.getUint32(o + 8));
  }
  const at = (t: string) => { const o = tables.get(t); if (o == null) throw new Error(`Font has no ${t} table.`); return o; };
  const head = at('head'), hhea = at('hhea'), hmtx = at('hmtx'), maxp = at('maxp'), cmapO = at('cmap');
  const unitsPerEm = v.getUint16(head + 18);
  const bbox: [number, number, number, number] = [v.getInt16(head + 36), v.getInt16(head + 38), v.getInt16(head + 40), v.getInt16(head + 42)];
  const ascent = v.getInt16(hhea + 4), descent = v.getInt16(hhea + 6), nMetrics = v.getUint16(hhea + 34), nGlyphs = v.getUint16(maxp + 4);
  const widths = new Uint16Array(nGlyphs);
  for (let g = 0; g < nGlyphs; g++) widths[g] = v.getUint16(hmtx + Math.min(g, nMetrics - 1) * 4);
  const os2 = tables.get('OS/2');
  const capHeight = os2 != null && v.getUint16(os2) >= 2 ? v.getInt16(os2 + 88) : ascent;
  // cmap: prefer a full-repertoire (format 12) Windows subtable, else the BMP (format 4) one
  const cmap = new Map<number, number>();
  let f4 = -1, f12 = -1;
  for (let i = 0, n = v.getUint16(cmapO + 2); i < n; i++) {
    const p = v.getUint16(cmapO + 4 + i * 8), e = v.getUint16(cmapO + 6 + i * 8), off = cmapO + v.getUint32(cmapO + 8 + i * 8);
    const fmt = v.getUint16(off);
    if (fmt === 12 && (p === 3 && e === 10 || p === 0)) f12 = off;
    if (fmt === 4 && (p === 3 && e === 1 || p === 0)) f4 = off;
  }
  if (f12 >= 0) {
    for (let i = 0, n = v.getUint32(f12 + 12); i < n; i++) {
      const s = v.getUint32(f12 + 16 + i * 12), e = v.getUint32(f12 + 20 + i * 12), g = v.getUint32(f12 + 24 + i * 12);
      for (let c = s; c <= e && c - s < 70000; c++) cmap.set(c, g + c - s);
    }
  } else if (f4 >= 0) {
    const segs = v.getUint16(f4 + 6) / 2, ends = f4 + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
    for (let i = 0; i < segs; i++) {
      const end = v.getUint16(ends + i * 2), start = v.getUint16(starts + i * 2), delta = v.getInt16(deltas + i * 2), ro = v.getUint16(ranges + i * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g: number;
        if (!ro) g = (c + delta) & 0xffff;
        else { g = v.getUint16(ranges + i * 2 + ro + (c - start) * 2); if (g) g = (g + delta) & 0xffff; }
        if (g) cmap.set(c, g);
      }
    }
  } else throw new Error('Font has no Unicode character map.');
  // PostScript name from the name table (id 6), for the PDF font name
  let name = 'UnicodeFont';
  const nm = tables.get('name');
  if (nm != null) {
    const count = v.getUint16(nm + 2), strings = nm + v.getUint16(nm + 4);
    for (let i = 0; i < count; i++) {
      const r = nm + 6 + i * 12;
      if (v.getUint16(r + 6) !== 6) continue;
      const len = v.getUint16(r + 8), off = strings + v.getUint16(r + 10), wide = v.getUint16(r) === 3 || v.getUint16(r) === 0;
      let s = ''; for (let k = 0; k < len; k += wide ? 2 : 1) s += String.fromCharCode(wide ? v.getUint16(off + k) : bytes[off + k]);
      if (s) { name = s.replace(/[^\w-]/g, ''); break; }
    }
  }
  return { name, unitsPerEm, ascent, descent, capHeight, bbox, widths, cmap, bytes };
}

// ---------------------------------------------------------------- Arabic shaping
// letter -> [first presentation form, kind]: D = dual-joining (isolated, final, initial, medial), R = joins to the
// letter before it only (isolated, final), U = does not join
const AR: Record<number, [number, 'D' | 'R' | 'U']> = {
  0x0621: [0xfe80, 'U'], 0x0622: [0xfe81, 'R'], 0x0623: [0xfe83, 'R'], 0x0624: [0xfe85, 'R'], 0x0625: [0xfe87, 'R'], 0x0626: [0xfe89, 'D'], 0x0627: [0xfe8d, 'R'],
  0x0628: [0xfe8f, 'D'], 0x0629: [0xfe93, 'R'], 0x062a: [0xfe95, 'D'], 0x062b: [0xfe99, 'D'], 0x062c: [0xfe9d, 'D'], 0x062d: [0xfea1, 'D'], 0x062e: [0xfea5, 'D'],
  0x062f: [0xfea9, 'R'], 0x0630: [0xfeab, 'R'], 0x0631: [0xfead, 'R'], 0x0632: [0xfeaf, 'R'], 0x0633: [0xfeb1, 'D'], 0x0634: [0xfeb5, 'D'], 0x0635: [0xfeb9, 'D'],
  0x0636: [0xfebd, 'D'], 0x0637: [0xfec1, 'D'], 0x0638: [0xfec5, 'D'], 0x0639: [0xfec9, 'D'], 0x063a: [0xfecd, 'D'], 0x0641: [0xfed1, 'D'], 0x0642: [0xfed5, 'D'],
  0x0643: [0xfed9, 'D'], 0x0644: [0xfedd, 'D'], 0x0645: [0xfee1, 'D'], 0x0646: [0xfee5, 'D'], 0x0647: [0xfee9, 'D'], 0x0648: [0xfeed, 'R'], 0x0649: [0xfeef, 'R'],
  0x064a: [0xfef1, 'D'],
  // Persian / Urdu letters (Presentation Forms-A)
  0x067e: [0xfb56, 'D'], 0x0686: [0xfb7a, 'D'], 0x0698: [0xfb8a, 'R'], 0x06a9: [0xfb8e, 'D'], 0x06af: [0xfb92, 'D'], 0x06cc: [0xfbfc, 'D'],
};
const LAM_ALEF: Record<number, number> = { 0x0622: 0xfef5, 0x0623: 0xfef7, 0x0625: 0xfef9, 0x0627: 0xfefb }; // isolated; final = +1
const isMark = (c: number) => (c >= 0x064b && c <= 0x065f) || c === 0x0670;
const TATWEEL = 0x0640;

/** Arabic letters replaced by their joined forms (the font must have them; otherwise the letter is kept). */
export function shapeArabic(s: string, has: (c: number) => boolean = () => true): string {
  const cs = [...s].map((ch) => ch.codePointAt(0)!);
  if (!cs.some((c) => AR[c])) return s;
  const joinsNext = (c: number | undefined) => c === TATWEEL || (c != null && AR[c]?.[1] === 'D');
  const joinsPrev = (c: number | undefined) => c === TATWEEL || (c != null && (AR[c]?.[1] === 'D' || AR[c]?.[1] === 'R'));
  const prevLetter = (i: number) => { for (let j = i - 1; j >= 0; j--) if (!isMark(cs[j])) return cs[j]; return undefined; };
  const nextLetter = (i: number) => { for (let j = i + 1; j < cs.length; j++) if (!isMark(cs[j])) return cs[j]; return undefined; };
  const out: number[] = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], a = AR[c];
    if (!a) { out.push(c); continue; }
    const p = prevLetter(i), n = nextLetter(i);
    const fromPrev = joinsNext(p) && a[1] !== 'U';
    // lam followed by alef: one ligature glyph
    if (c === 0x0644 && n != null && LAM_ALEF[n]) {
      const lig = LAM_ALEF[n] + (fromPrev ? 1 : 0);
      if (has(lig)) { out.push(lig); i = cs.indexOf(n, i + 1); continue; }
    }
    const toNext = a[1] === 'D' && joinsPrev(n);
    const form = a[1] === 'U' ? 0 : a[1] === 'R' ? (fromPrev ? 1 : 0) : fromPrev && toNext ? 3 : fromPrev ? 1 : toNext ? 2 : 0;
    const g = a[0] + form;
    out.push(has(g) ? g : c);
  }
  return String.fromCodePoint(...out);
}

// ---------------------------------------------------------------- right-to-left text in visual order
const isRtl = (c: number) => (c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff);
const isLtrStrong = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c < 0x590 && c !== 0xd7 && c !== 0xf7) || (c >= 0x900 && c < 0xfb1d) && !isRtl(c);
const isNum = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x660 && c <= 0x669) || (c >= 0x6f0 && c <= 0x6f9);
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

/** Text in the order it is drawn left to right (a simplified Unicode bidi: paragraph direction from the first strong letter). */
export function visualOrder(s: string): string {
  const chars = [...s];
  const cps = chars.map((ch) => ch.codePointAt(0)!);
  if (!cps.some(isRtl)) return s;
  const first = cps.find((c) => isRtl(c) || isLtrStrong(c));
  const paraRtl = first != null && isRtl(first);
  // each character's direction; numbers run left to right; neutrals take their neighbours' direction when both agree
  const dir: ('R' | 'L' | null)[] = cps.map((c) => (isRtl(c) ? 'R' : isLtrStrong(c) || isNum(c) ? 'L' : null));
  for (let i = 0; i < dir.length; i++) {
    if (dir[i]) continue;
    let j = i; while (j < dir.length && !dir[j]) j++;
    const before = i > 0 ? dir[i - 1] : paraRtl ? 'R' : 'L', after = j < dir.length ? dir[j] : paraRtl ? 'R' : 'L';
    const d = before === after ? before : paraRtl ? 'R' : 'L';
    for (let k = i; k < j; k++) dir[k] = d;
    i = j - 1;
  }
  // paired brackets take the direction of what they enclose, so "(B1)" stays together
  const open: number[] = [];
  chars.forEach((ch, i) => {
    if (ch === '(' || ch === '[' || ch === '{') open.push(i);
    else if ((ch === ')' || ch === ']' || ch === '}') && open.length) {
      const o = open.pop()!;
      const inner = dir.slice(o + 1, i).filter((d, k) => isRtl(cps[o + 1 + k]) || isLtrStrong(cps[o + 1 + k]) || isNum(cps[o + 1 + k]));
      const d = inner.includes('L') && !inner.includes('R') ? 'L' : inner.includes('R') && !inner.includes('L') ? 'R' : null;
      if (d) { dir[o] = d; dir[i] = d; }
    }
  });
  const runs: { d: 'R' | 'L'; text: string[] }[] = [];
  chars.forEach((ch, i) => { const d = dir[i]!; const last = runs[runs.length - 1]; if (last?.d === d) last.text.push(ch); else runs.push({ d, text: [ch] }); });
  const draw = (r: { d: 'R' | 'L'; text: string[] }) => (r.d === 'R' ? [...r.text].reverse().map((ch) => MIRROR[ch] ?? ch).join('') : r.text.join(''));
  return (paraRtl ? runs.reverse() : runs).map(draw).join('');
}

/** Glyph ids and advance width (in text space units of 1/1000 em) of a string, shaped and in visual order. */
export function layoutText(font: TtfFont, s: string): { gids: number[]; codes: number[]; width: number } {
  const visual = visualOrder(shapeArabic(s, (c) => font.cmap.has(c)));
  const gids: number[] = [], codes: number[] = [];
  let w = 0;
  for (const ch of visual) {
    const c = ch.codePointAt(0)!;
    const g = font.cmap.get(c) ?? font.cmap.get(0x3f) ?? 0;
    gids.push(g); codes.push(c);
    w += (font.widths[g] ?? 0) * 1000 / font.unitsPerEm;
  }
  return { gids, codes, width: w };
}
