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

/** Recognise the code page of a non-UTF-8 file. */
export function detectCodepage(b: Uint8Array): TextEncodingName {
  let high = 0;
  for (const x of b) if (x >= 0x80) high++;
  if (high < 8 || doubleEncodedShare(b) > 0.5) return 'windows-1252';
  // East Asian double-byte code pages: the whole file decodes cleanly and is mostly ideographs / kana
  for (const enc of ['gbk', 'big5', 'shift_jis'] as const) {
    try {
      const t = new TextDecoder(enc, { fatal: true }).decode(b);
      const cjk = (t.match(/[぀-ヿ一-鿿]/g) ?? []).length;
      if (cjk * 2 >= high * 0.8) return enc;
    } catch { /* not this one */ }
  }
  let best: TextEncodingName = 'windows-1252', bestScore = 0;
  for (const s of SCRIPTS) {
    const t = new TextDecoder(s.enc).decode(b);
    const letters = (t.match(s.range) ?? []).length;
    if (letters < 8 || letters < high * 0.6) continue;
    const share = (t.match(s.common) ?? []).length / letters;
    if (share >= s.min && share > bestScore) { best = s.enc; bestScore = share; }
  }
  if (best !== 'windows-1252') return best;
  // Central European / Turkish: letters 1252 does not have (ł, ś, ž ... / ğ, ş, ı)
  const t1250 = new TextDecoder('windows-1250').decode(b), t1254 = new TextDecoder('windows-1254').decode(b);
  const n1250 = (t1250.match(/[łśźżąęčřšžňť]/g) ?? []).length, n1254 = (t1254.match(/[ğşı]/g) ?? []).length; // lower case: currency signs map to capitals
  if (n1250 >= 8 && n1250 > high * 0.3) return 'windows-1250';
  if (n1254 >= 8 && n1254 > high * 0.2) return 'windows-1254';
  return 'windows-1252';
}

export function decodeText(b: Uint8Array, force?: TextEncodingName | 'auto'): { text: string; encoding: TextEncodingName } {
  if (force && force !== 'auto') {
    const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    return { text: new TextDecoder(force === 'utf-8-bom' ? 'utf-8' : force).decode(bom ? b.subarray(3) : b), encoding: force };
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8-bom' };
  }
  let high = false;
  for (const x of b) if (x >= 0x80) { high = true; break; }
  if (!high) return { text: new TextDecoder('windows-1252').decode(b), encoding: 'utf-8' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' };
  } catch { /* not UTF-8 */ }
  const enc = detectCodepage(b);
  return { text: new TextDecoder(enc).decode(b), encoding: enc };
}

// ---------------------------------------------------------------- encoding (export)
const reverse = new Map<string, Map<number, number[]>>();
/** Character -> bytes for a code page, built from the platform's decoder. */
function table(enc: string): Map<number, number[]> {
  let m = reverse.get(enc);
  if (m) return m;
  m = new Map();
  const dec = new TextDecoder(enc);
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
  return out.subarray(0, n);
}

export const encodeCp1252 = (s: string): Uint8Array => encodeText(s, 'windows-1252');
