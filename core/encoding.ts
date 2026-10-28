// Text encodings of XER / MPX files. P6 writes XER in the Windows "language for non-Unicode programs" code page of
// the computer that exported it: Windows-1252 in Western Europe and the Americas, Windows-1256 on Arabic Windows,
// 1251 Cyrillic, 1253 Greek, 1255 Hebrew, 1250 Central European, GBK / Big5 / Shift_JIS in East Asia. The file does
// not say which, so the code page is recognised from the text (each script has very frequent letters), and can
// always be chosen by hand. UTF-8 (with or without BOM) is recognised first.

export type TextEncodingName = 'utf-8-bom' | 'utf-8' | 'windows-1252' | 'windows-1250' | 'windows-1251' | 'windows-1253' | 'windows-1254' | 'windows-1255' | 'windows-1256' | 'gbk' | 'big5' | 'shift_jis';
export const ENCODINGS: [TextEncodingName, string][] = [
  ['windows-1252', 'Western (Windows-1252)'], ['windows-1256', 'Arabic (Windows-1256)'], ['windows-1251', 'Cyrillic (Windows-1251)'],
  ['windows-1253', 'Greek (Windows-1253)'], ['windows-1255', 'Hebrew (Windows-1255)'], ['windows-1250', 'Central European (Windows-1250)'],
  ['windows-1254', 'Turkish (Windows-1254)'], ['gbk', 'Chinese Simplified (GBK)'], ['big5', 'Chinese Traditional (Big5)'], ['shift_jis', 'Japanese (Shift_JIS)'], ['utf-8', 'Unicode (UTF-8)'],
];
export const encodingLabel = (e: string) => ENCODINGS.find(([k]) => k === e || (e === 'utf-8-bom' && k === 'utf-8'))?.[1] ?? e;

/** Single-byte code pages recognised by their most frequent letters (share of all letters of that script). */
const SCRIPTS: { enc: TextEncodingName; range: RegExp; common: RegExp; min: number }[] = [
  { enc: 'windows-1256', range: /[؀-ۿ]/g, common: /[اليمونةربت]/g, min: 0.35 }, // ا ل ي م و ن ة ر ب ت
  { enc: 'windows-1251', range: /[Ѐ-ӿ]/g, common: /[оеаинтсрвл]/gi, min: 0.35 },
  { enc: 'windows-1253', range: /[Ͱ-Ͽ]/g, common: /[αοιετσνηρ]/gi, min: 0.3 },
  { enc: 'windows-1255', range: /[֐-׿]/g, common: /[יוהמלאתרבש]/g, min: 0.35 }, // י ו ה מ ל א ת ר ב ש
];

/** UTF-8 text that went through Windows-1252 once (P6 stores and re-exports it as these pairs): not a code page signal. */
function doubleEncodedShare(b: Uint8Array): number {
  let high = 0, pairs = 0;
  for (let i = 0; i < b.length; i++) if (b[i] >= 0x80) { high++; if ((b[i] === 0xc2 || b[i] === 0xc3) && b[i + 1] >= 0x80 && b[i + 1] <= 0xbf) { pairs++; high++; i++; } }
  return high ? (pairs * 2) / high : 0;
}

/** Recognise the code page of a non-UTF-8 file, from how its non-ASCII bytes sit and what they spell. A Western,
 *  Central European or Turkish text has them inside words of ASCII letters (Väliseinät, Łączniki); an Arabic, Hebrew,
 *  Greek, Cyrillic or East Asian text has them as whole words. A short file is told apart as well as a long one: no
 *  script needs a minimum count of letters. */
export function detectCodepage(b: Uint8Array): TextEncodingName {
  const letter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  let high = 0, inLatinWords = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] < 0x80) continue;
    high++;
    if ((i > 0 && letter(b[i - 1])) || (i + 1 < b.length && letter(b[i + 1]))) inLatinWords++;
  }
  if (!high || doubleEncodedShare(b) > 0.5) return 'windows-1252';
  if (inLatinWords >= high * 0.5) return latin(b, high);
  // East Asian double-byte code pages: the file decodes cleanly, mostly to ideographs or kana, and its characters are
  // mostly the common ones (GBK's level 1, Big5's frequent block, Shift_JIS's kana and level-1 kanji): Arabic or Greek
  // bytes paired up decode as rare characters
  for (const [enc, common] of [['gbk', (l: number) => l >= 0xb0 && l <= 0xd7], ['big5', (l: number) => l >= 0xa4 && l <= 0xc6], ['shift_jis', (l: number) => l >= 0x81 && l <= 0x9f]] as const) {
    try {
      const t = new TextDecoder(enc, { fatal: true }).decode(b);
      const cjk = (t.match(/[぀-ヿ一-鿿]/g) ?? []).length;
      if (cjk * 2 < high * 0.8) continue;
      let leads = 0, usual = 0;
      for (let i = 0; i < b.length; i++) if (b[i] >= 0x81) { leads++; if (common(b[i])) usual++; i++; }
      if (usual >= leads * 0.7) return enc;
    } catch { /* not this one */ }
  }
  // whole words in a single-byte script: the one whose letters they spell best (its most frequent letters' share)
  let best: TextEncodingName | null = null, bestScore = 0;
  for (const s of SCRIPTS) {
    const t = new TextDecoder(s.enc).decode(b);
    const letters = (t.match(s.range) ?? []).length;
    if (letters < 2 || letters < high * 0.6) continue;
    const share = (t.match(s.common) ?? []).length / letters;
    if (share >= s.min && share > bestScore) { best = s.enc; bestScore = share; }
  }
  return best ?? latin(b, high);
}
/** A Latin code page: Central European or Turkish when their own letters show (ł, ś, ž ... / ğ, ş, ı), else Western. */
function latin(b: Uint8Array, high: number): TextEncodingName {
  const t1250 = new TextDecoder('windows-1250').decode(b), t1254 = new TextDecoder('windows-1254').decode(b);
  const n1250 = (t1250.match(/[łśźżąęčřšžňť]/g) ?? []).length, n1254 = (t1254.match(/[ğşı]/g) ?? []).length; // lower case: currency signs map to capitals
  if (n1250 >= 2 && n1250 > high * 0.3) return 'windows-1250';
  if (n1254 >= 2 && n1254 > high * 0.2) return 'windows-1254';
  return 'windows-1252';
}

export const SAMPLE = 4 * 1048576; // bytes of non-ASCII lines the code page is recognised from
const CHUNK = 1048576;

/** Encoding of a file without decoding it whole (a file can be larger than the longest possible string): BOM, else
 *  ASCII, else valid UTF-8, else the code page recognised from its lines with non-ASCII bytes. `start` skips the BOM;
 *  `decoder` is the TextDecoder label to read it with. */
export function detectEncoding(b: Uint8Array, force?: TextEncodingName | 'auto'): { encoding: TextEncodingName; start: number; decoder: string } {
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const of = (encoding: TextEncodingName, start = 0) => ({ encoding, start, decoder: encoding === 'utf-8-bom' ? 'utf-8' : encoding });
  if (force && force !== 'auto') return of(force, bom ? 3 : 0);
  if (bom) return of('utf-8-bom', 3);
  let first = -1;
  for (let i = 0; i < b.length; i++) if (b[i] >= 0x80) { first = i; break; }
  if (first < 0) return of('utf-8'); // ASCII
  try {
    const d = new TextDecoder('utf-8', { fatal: true });
    for (let i = first; i < b.length; i += CHUNK) d.decode(b.subarray(i, i + CHUNK), { stream: true });
    d.decode();
    return of('utf-8');
  } catch { /* not UTF-8 */ }
  // the code page only shows in non-ASCII text: recognise it from those lines (all of them in all but huge files)
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let s = b.lastIndexOf(10, first) + 1; s < b.length && size < SAMPLE;) {
    let e = b.indexOf(10, s);
    if (e < 0) e = b.length;
    for (let i = s; i < e; i++) if (b[i] >= 0x80) { const p = b.subarray(s, e + 1); parts.push(p); size += p.length; break; }
    s = e + 1;
  }
  const sample = new Uint8Array(size);
  size = 0;
  for (const p of parts) { sample.set(p, size); size += p.length; }
  return of(detectCodepage(sample));
}

// Node 20.x and 22.x (the platform's hosted runtime among them) read the label "windows-1252" as ISO-8859-1: bytes 0x80-0x9F
// come out as C1 controls instead of € ‚ „ … ‘ ’ “ ” • – — ™ (the WHATWG mapping). Activity names carry exactly those (curly
// quotes, dashes), so on such a runtime the 1252 decoder is the latin-1 one plus this table.
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
const LATIN1_LABELS = new Set(['windows-1252', 'cp1252', 'x-cp1252', 'latin1', 'iso-8859-1', 'iso8859-1', 'l1', 'ascii', 'us-ascii']);
const BROKEN_1252 = new TextDecoder('windows-1252').decode(Uint8Array.of(0x80)) !== '€';
/** TextDecoder, except windows-1252 on a runtime that reads it as latin-1. */
export function textDecoder(label: string, opts?: TextDecoderOptions): { decode(b: Uint8Array): string } {
  if (!BROKEN_1252 || !LATIN1_LABELS.has(label.toLowerCase())) return new TextDecoder(label, opts);
  const latin1 = new TextDecoder('windows-1252');   // = ISO-8859-1 on these runtimes
  return { decode: (b: Uint8Array) => latin1.decode(b).replace(/[\u0080-\u009f]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]) };
}

export function decodeText(b: Uint8Array, force?: TextEncodingName | 'auto'): { text: string; encoding: TextEncodingName } {
  const { encoding, start, decoder } = detectEncoding(b, force);
  return { text: textDecoder(decoder).decode(b.subarray(start)), encoding };
}

// ---------------------------------------------------------------- encoding (export)
const reverse = new Map<string, Map<number, number[]>>();
/** Character -> bytes for a code page, built from the platform's decoder. */
function table(enc: string): Map<number, number[]> {
  let m = reverse.get(enc);
  if (m) return m;
  m = new Map();
  const dec = textDecoder(enc);
  const put = (bytes: number[]) => { const s = dec.decode(new Uint8Array(bytes)); if ([...s].length === 1 && s !== '�') { const c = s.codePointAt(0)!; if (!m!.has(c)) m!.set(c, bytes); } };
  if (enc === 'gbk' || enc === 'big5' || enc === 'shift_jis') {
    for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x40; b <= 0xfe; b++) put([a, b]);
    if (enc === 'shift_jis') for (let a = 0xa1; a <= 0xdf; a++) put([a]);
  } else for (let i = 0x80; i < 0x100; i++) put([i]);
  reverse.set(enc, m);
  return m;
}

/** Can the code page represent every character of the text? */
export function fits(s: string, enc: TextEncodingName): boolean {
  if (enc.startsWith('utf-8')) return true;
  const t = table(enc);
  for (const ch of s) { const c = ch.codePointAt(0)!; if (c >= 0x80 && !t.has(c)) return false; }
  return true;
}

/** The code page P6 would write this text in: Windows-1252 when it fits, else the code page of the script used, else UTF-8. */
export function chooseEncoding(s: string): TextEncodingName {
  if (!/[^\x00-\x7f]/.test(s) || fits(s, 'windows-1252')) return 'windows-1252';
  const order: [RegExp, TextEncodingName][] = [[/[؀-ۿ]/, 'windows-1256'], [/[Ѐ-ӿ]/, 'windows-1251'], [/[Ͱ-Ͽ]/, 'windows-1253'], [/[֐-׿]/, 'windows-1255'],
    [/[぀-ヿ]/, 'shift_jis'], [/[一-鿿]/, 'gbk'], [/[łśźżąęčřšžňť]/i, 'windows-1250'], [/[ğşı]/i, 'windows-1254']];
  for (const [re, enc] of order) if (re.test(s) && fits(s, enc)) return enc;
  return 'utf-8';
}

/** The encoding a file is written in when none is asked for: the one it was read in (BOM kept as read) while the
 *  text still fits it, else the code page P6 would use (chooseEncoding). */
export const keepOrChoose = (s: string, readAs?: TextEncodingName): TextEncodingName => (readAs && fits(s, readAs) ? readAs : chooseEncoding(s));

export function encodeText(s: string, enc: TextEncodingName): Uint8Array {
  if (enc === 'utf-8') return new TextEncoder().encode(s);
  if (enc === 'utf-8-bom') { const b = new TextEncoder().encode(s); const o = new Uint8Array(b.length + 3); o.set([0xef, 0xbb, 0xbf]); o.set(b, 3); return o; }
  const t = table(enc);
  const out = new Uint8Array(s.length * 2);
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) { out[n++] = c; continue; }
    for (const x of t.get(c) ?? [0x3f]) out[n++] = x;
  }
  return out.slice(0, n); // a copy, so the working buffer (twice the size) is not kept
}

export const encodeCp1252 = (s: string): Uint8Array => encodeText(s, 'windows-1252');
